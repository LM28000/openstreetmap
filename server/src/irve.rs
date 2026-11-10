//! Bornes de recharge pour véhicules électriques : la base nationale consolidée des IRVE
//! (infrastructures de recharge), publiée par le Point d'Accès National
//! (transport.data.gouv.fr) sous Licence Ouverte 2.0.
//!
//! Le fichier fait environ 130 Mo (un CSV, une ligne par point de charge, 180 000 lignes)
//! et change une fois par nuit. Le serveur le télécharge au plus une fois par jour, le
//! lit en continu, regroupe les points de charge par station et ne garde que ce que la
//! carte affiche : le résultat tient en quelques Mo et est rangé dans `DATA_DIR/irve/`,
//! ce qui évite de retélécharger à chaque redémarrage. Le CSV lui-même est effacé.
//!
//! La « base nationale » de data.gouv.fr, qu'on aurait pu prendre, est remplacée par
//! celle-ci (elle disparaît le 31/12/2026) : celle du PAN est déjà dédoublonnée et validée.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

use crate::state::AppState;

const SOURCE_URL: &str = "https://proxy.transport.data.gouv.fr/resource/consolidation-transport-irve-statique";
/// La source est régénérée chaque nuit : une fois par jour suffit.
const REFRESH_EVERY: Duration = Duration::from_secs(24 * 3600);
/// Après un échec, on réessaie assez tôt pour ne pas rester une journée sans données.
const RETRY_AFTER: Duration = Duration::from_secs(30 * 60);
/// Le fichier fait 130 Mo : au-delà de 400 Mo, la source a changé de nature, on s'arrête.
const MAX_DOWNLOAD_BYTES: u64 = 400 * 1024 * 1024;

/// Types de prise, en bits (somme dans `Station::plugs`).
const PLUG_DOMESTIC: u8 = 1;
const PLUG_TYPE_2: u8 = 2;
const PLUG_CCS: u8 = 4;
const PLUG_CHADEMO: u8 = 8;
const PLUG_OTHER: u8 = 16;

/// Une station : un lieu de recharge, qui regroupe un ou plusieurs points de charge.
#[derive(Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Station {
    id: String,
    lon: f64,
    lat: f64,
    name: String,
    operator: String,
    address: String,
    /// Nombre de points de charge.
    pdc: u32,
    /// Puissance maximale d'un point de charge, en kW.
    kw: f32,
    /// Types de prise présents (bits `PLUG_*`).
    plugs: u8,
    /// Gratuit (`true`), payant (`false`), ou non renseigné (absent).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    free: Option<bool>,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    hours: String,
    #[serde(skip_serializing_if = "String::is_empty", default)]
    tariff: String,
    /// Accès réservé (clientèle, résidents) : la borne n'est pas ouverte à tous.
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    restricted: bool,
    /// Puissances des points de charge : (kW, nombre), de la plus forte à la plus faible.
    powers: Vec<(f32, u32)>,
    /// Dernière mise à jour des données par l'opérateur (« AAAA-MM-JJ »).
    #[serde(skip_serializing_if = "String::is_empty", default)]
    updated: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    /// Instant de la collecte (secondes UTC).
    updated_at: i64,
    stations: Vec<Station>,
}

/// Fait vivre la couche : relit le cache s'il est récent, sinon télécharge, puis recommence demain.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf, state: AppState) {
    let dir = data_dir.join("irve");
    let cache = dir.join("bornes.json");
    loop {
        let age = cache_age(&cache).await;
        // Un cache de moins d'un jour sert tel quel (redémarrage du serveur) ; un plus vieux
        // sert quand même en attendant le nouveau téléchargement.
        if state.irve().is_none()
            && let Ok(body) = tokio::fs::read(&cache).await
            && serde_json::from_slice::<Out>(&body).is_ok()
        {
            info!(age_h = age.map_or(-1, |a| (a.as_secs() / 3600) as i64), "bornes : cache chargé");
            state.set_irve(body);
        }
        if age.is_some_and(|a| a < REFRESH_EVERY) {
            tokio::time::sleep(REFRESH_EVERY - age.unwrap_or_default()).await;
            continue;
        }
        match refresh(&http, &dir, &cache).await {
            Ok((body, count)) => {
                info!(stations = count, octets = body.len(), "bornes : base nationale mise à jour");
                state.set_irve(body);
            }
            Err(error) => {
                warn!("bornes : base nationale indisponible : {error:#}");
                tokio::time::sleep(RETRY_AFTER).await;
            }
        }
    }
}

async fn cache_age(cache: &Path) -> Option<Duration> {
    let modified = tokio::fs::metadata(cache).await.ok()?.modified().ok()?;
    modified.elapsed().ok()
}

/// Télécharge le CSV sur le disque (130 Mo : pas question de le garder en mémoire), le réduit, l'efface.
async fn refresh(http: &reqwest::Client, dir: &Path, cache: &Path) -> Result<(Vec<u8>, usize)> {
    tokio::fs::create_dir_all(dir).await?;
    let csv_path = dir.join("consolidation.csv.part");
    let download = download(http, &csv_path).await;
    let result = match download {
        Ok(()) => {
            let path = csv_path.clone();
            tokio::task::spawn_blocking(move || {
                let reader = csv::ReaderBuilder::new().flexible(true).from_path(&path)?;
                reduce(reader)
            })
            .await?
        }
        Err(error) => Err(error),
    };
    let _ = tokio::fs::remove_file(&csv_path).await;
    let stations = result?;
    let count = stations.len();
    let body = serde_json::to_vec(&Out { updated_at: Timestamp::now().as_second(), stations })?;
    // Écriture en deux temps : un arrêt en plein milieu ne laisse jamais un cache tronqué.
    let tmp = cache.with_extension("json.part");
    tokio::fs::write(&tmp, &body).await?;
    tokio::fs::rename(&tmp, cache).await?;
    Ok((body, count))
}

async fn download(http: &reqwest::Client, path: &Path) -> Result<()> {
    let mut response = http.get(SOURCE_URL).timeout(Duration::from_secs(900)).send().await?.error_for_status()?;
    let mut file = tokio::fs::File::create(path).await?;
    let mut total = 0u64;
    while let Some(chunk) = response.chunk().await? {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            bail!("le fichier dépasse {} Mo", MAX_DOWNLOAD_BYTES / 1024 / 1024);
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    info!(octets = total, "bornes : fichier téléchargé");
    Ok(())
}

/// Ce qu'on retient d'une station pendant qu'on lit ses lignes.
#[derive(Default)]
struct Accumulator {
    id: String,
    lon: f64,
    lat: f64,
    name: String,
    operator: String,
    address: String,
    pdc_ids: HashSet<String>,
    rows: u32,
    declared_pdc: u32,
    plugs: u8,
    free_yes: u32,
    free_no: u32,
    hours: String,
    tariff: String,
    open_rows: u32,
    powers: Vec<f32>,
    updated: String,
}

/// Index des colonnes utiles, trouvées par leur nom : l'ordre des colonnes n'est pas garanti.
struct Columns {
    names: HashMap<String, usize>,
}

impl Columns {
    fn new(headers: &csv::StringRecord) -> Self {
        Self { names: headers.iter().enumerate().map(|(i, h)| (h.trim_start_matches('\u{feff}').to_string(), i)).collect() }
    }

    fn get<'a>(&self, record: &'a csv::ByteRecord, name: &str) -> Cow<'a, str> {
        match self.names.get(name).and_then(|&i| record.get(i)) {
            Some(bytes) => String::from_utf8_lossy(bytes),
            None => Cow::Borrowed(""),
        }
    }
}

/// Un nombre de kW plausible : certains producteurs saisissent des watts (22 000 pour 22 kW).
fn parse_power(text: &str) -> Option<f32> {
    let value: f32 = text.trim().replace(',', ".").parse().ok()?;
    let kw = if value >= 1000.0 { value / 1000.0 } else { value };
    (kw > 0.0 && kw <= 1000.0).then_some(kw)
}

/// Longitude et latitude : les colonnes calculées par la consolidation, sinon `coordonneesXY` (« [lon, lat] »).
fn coordinates(columns: &Columns, record: &csv::ByteRecord) -> Option<(f64, f64)> {
    let parse = |text: &str| text.trim().parse::<f64>().ok();
    let from_columns = parse(&columns.get(record, "consolidated_longitude")).zip(parse(&columns.get(record, "consolidated_latitude")));
    let from_xy = || {
        let text = columns.get(record, "coordonneesXY");
        let (lon, lat) = text.trim().trim_start_matches('[').trim_end_matches(']').split_once(',')?;
        parse(lon).zip(parse(lat))
    };
    let (lon, lat) = from_columns.or_else(from_xy)?;
    // France, Corse et outre-mer, avec une marge ; (0, 0) est le point par défaut des tableurs.
    let plausible = (-23.0..=52.0).contains(&lat) && (-63.0..=56.0).contains(&lon) && (lon != 0.0 || lat != 0.0);
    plausible.then_some((lon, lat))
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max { text.to_string() } else { format!("{}…", text.chars().take(max).collect::<String>().trim_end()) }
}

/// Regroupe les lignes (un point de charge chacune) en stations.
fn reduce<R: std::io::Read>(mut reader: csv::Reader<R>) -> Result<Vec<Station>> {
    let columns = Columns::new(reader.headers().context("en-têtes illisibles")?);
    for required in ["id_station_itinerance", "puissance_nominale", "consolidated_longitude"] {
        if !columns.names.contains_key(required) {
            bail!("colonne {required} absente : le format de la base a changé");
        }
    }
    let mut stations: HashMap<String, Accumulator> = HashMap::new();
    let mut record = csv::ByteRecord::new();
    while reader.read_byte_record(&mut record).context("ligne illisible")? {
        let get = |name: &str| columns.get(&record, name);
        // Les identifiants commencent par le code du pays : la base contient quelques stations belges ou espagnoles.
        let station_id = get("id_station_itinerance").trim().to_string();
        if !station_id.get(..2).is_some_and(|prefix| prefix.eq_ignore_ascii_case("FR")) {
            continue;
        }
        let Some((lon, lat)) = coordinates(&columns, &record) else { continue };

        let entry = stations.entry(station_id.clone()).or_insert_with(|| Accumulator {
            id: station_id,
            lon,
            lat,
            name: truncate(&get("nom_station"), 80),
            operator: truncate(
                [get("nom_operateur"), get("nom_enseigne"), get("nom_amenageur")].iter().find(|n| !n.trim().is_empty()).map_or("", |n| n.as_ref()),
                60,
            ),
            address: truncate(&get("adresse_station"), 100),
            ..Accumulator::default()
        });
        entry.rows += 1;
        entry.declared_pdc = entry.declared_pdc.max(get("nbre_pdc").trim().parse().unwrap_or(0));
        let pdc_id = get("id_pdc_itinerance").trim().to_string();
        if !pdc_id.is_empty() {
            entry.pdc_ids.insert(pdc_id);
        }
        if let Some(kw) = parse_power(&get("puissance_nominale")) {
            entry.powers.push(kw);
        }
        for (column, bit) in [
            ("prise_type_ef", PLUG_DOMESTIC),
            ("prise_type_2", PLUG_TYPE_2),
            ("prise_type_combo_ccs", PLUG_CCS),
            ("prise_type_chademo", PLUG_CHADEMO),
            ("prise_type_autre", PLUG_OTHER),
        ] {
            if get(column).trim().eq_ignore_ascii_case("true") {
                entry.plugs |= bit;
            }
        }
        match get("gratuit").trim() {
            "true" => entry.free_yes += 1,
            "false" => entry.free_no += 1,
            _ => {}
        }
        if entry.hours.is_empty() {
            entry.hours = truncate(&get("horaires"), 120);
        }
        if entry.tariff.is_empty() {
            entry.tariff = truncate(&get("tarification"), 120);
        }
        if get("condition_acces").contains("libre") {
            entry.open_rows += 1;
        }
        let updated = get("date_maj");
        if updated.trim().len() >= 10 && updated.trim() > entry.updated.as_str() {
            entry.updated = updated.trim()[..10].to_string();
        }
    }

    let mut stations: Vec<Station> = stations.into_values().map(finish).collect();
    // Ordre stable d'un jour à l'autre : le diff des réponses reste lisible, les tests aussi.
    stations.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(stations)
}

/// « Mo-Su 00:00-23:57 » et ses variantes disent « tout le temps » : on écrit « 24/7 » comme les autres.
fn normalize_hours(hours: String) -> String {
    let all_day = ["Mo-Su 00:00-23:5", "Mo-Su 00:00-24:00", "Mo-Su 00:00-00:00"].iter().any(|p| hours.trim().starts_with(p) && hours.trim().len() <= 17);
    if all_day { "24/7".to_string() } else { hours }
}

fn finish(acc: Accumulator) -> Station {
    let mut powers: Vec<(f32, u32)> = Vec::new();
    let mut sorted = acc.powers.clone();
    sorted.sort_by(|a, b| b.total_cmp(a));
    for kw in sorted {
        match powers.last_mut() {
            Some((last, n)) if (*last - kw).abs() < 0.05 => *n += 1,
            _ => powers.push((kw, 1)),
        }
    }
    let pdc = acc.declared_pdc.max(acc.pdc_ids.len() as u32).max(1);
    Station {
        id: acc.id,
        lon: (acc.lon * 1e5).round() / 1e5,
        lat: (acc.lat * 1e5).round() / 1e5,
        name: acc.name,
        operator: acc.operator,
        address: acc.address,
        pdc,
        kw: powers.first().map_or(0.0, |p| p.0),
        plugs: acc.plugs,
        free: match (acc.free_yes, acc.free_no) {
            (0, 0) => None,
            (_, 0) => Some(true),
            _ => Some(false),
        },
        hours: normalize_hours(acc.hours),
        tariff: acc.tariff,
        restricted: acc.open_rows == 0,
        powers,
        updated: acc.updated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extrait réel de la base nationale (contacts effacés) : 19 lignes, 8 stations.
    const SAMPLE: &str = include_str!("testdata/irve_extrait.csv");

    fn stations() -> Vec<Station> {
        reduce(csv::ReaderBuilder::new().flexible(true).from_reader(SAMPLE.as_bytes())).unwrap()
    }

    fn find<'a>(stations: &'a [Station], prefix: &str) -> &'a Station {
        stations.iter().find(|s| s.id.starts_with(prefix)).unwrap_or_else(|| panic!("station {prefix} absente"))
    }

    #[test]
    fn regroupe_les_points_de_charge_par_station() {
        let stations = stations();
        let carrefour = find(&stations, "FRDRVPCRFMKT");
        assert_eq!(carrefour.kw, 150.0);
        // 4 lignes dans l'extrait, mais la station en déclare 8 : on garde le chiffre déclaré.
        assert_eq!(carrefour.pdc, 8);
        assert_eq!(carrefour.powers, vec![(150.0, 4)]);
        assert_eq!(carrefour.plugs, PLUG_CCS);
        assert_eq!(carrefour.operator, "DRIVECO");
        assert!(!carrefour.restricted);
    }

    #[test]
    fn ignore_les_stations_etrangeres() {
        let stations = stations();
        assert!(stations.iter().all(|s| s.id.starts_with("FR")), "les stations belges et espagnoles sont écartées");
        assert_eq!(stations.len(), 5);
    }

    #[test]
    fn gratuite_et_acces_reserve() {
        let stations = stations();
        // Un point gratuit sur trois : la station n'est pas gratuite.
        assert_eq!(find(&stations, "FRSSDPMAURINFORD").free, Some(false));
        let reserved = find(&stations, "FR55CP78210");
        assert!(reserved.restricted);
        assert_eq!(reserved.powers, vec![(22.08, 2)]);
    }

    #[test]
    fn horaires_et_coordonnees() {
        let stations = stations();
        let ford = find(&stations, "FRSSDPMAURINFORD");
        assert!(ford.hours.starts_with("Mo 08:00-12:00"));
        assert!((ford.lon - 4.64201).abs() < 1e-9 && (ford.lat - 43.69962).abs() < 1e-9);
    }

    #[test]
    fn ecrit_24_7_pour_les_stations_toujours_ouvertes() {
        assert_eq!(normalize_hours("Mo-Su 00:00-23:57".into()), "24/7");
        assert_eq!(normalize_hours("Mo-Su 00:00-24:00".into()), "24/7");
        assert_eq!(normalize_hours("Mo-Fr 09:00-19:00".into()), "Mo-Fr 09:00-19:00");
    }

    #[test]
    fn corrige_les_puissances_saisies_en_watts() {
        assert_eq!(parse_power("22000"), Some(22.0));
        assert_eq!(parse_power("22,08"), Some(22.08));
        assert_eq!(parse_power("0"), None);
        assert_eq!(parse_power(""), None);
    }

    #[test]
    fn refuse_un_format_inattendu() {
        let csv = "a,b\n1,2\n";
        assert!(reduce(csv::Reader::from_reader(csv.as_bytes())).is_err());
    }
}
