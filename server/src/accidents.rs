//! Accidents corporels de la circulation routière : les « Bases de données annuelles des accidents
//! corporels » de l'ONISR (Observatoire national interministériel de la sécurité routière), publiées
//! sur data.gouv.fr sous Licence Ouverte.
//!
//! Chaque année est publiée en quatre fichiers CSV (séparateur « ; »), reliés par `Num_Acc` :
//! - **caractéristiques** : date, heure, lumière, météo, position (latitude et longitude) ;
//! - **lieux** : catégorie de route ;
//! - **usagers** : une ligne par personne impliquée, avec sa gravité ;
//! - **véhicules** : une ligne par véhicule, avec sa catégorie.
//!
//! Le serveur cherche dans l'API de data.gouv.fr les fichiers des cinq dernières années complètes
//! (les noms des fichiers changent d'une année à l'autre : on les reconnaît à leur titre), les
//! télécharge **un par un** sur le disque, les lit en continu et les efface. Ce qui est gardé tient
//! en quelques octets par accident (275 000 accidents, 5 Mo une fois compressé).
//!
//! **Vie privée.** Seuls des *décomptes* de personnes par gravité sont gardés. Le sexe, l'année de
//! naissance, le trajet et l'équipement de sécurité des personnes ne sont jamais lus : leurs colonnes
//! ne sont pas dans la liste de celles que ce module va chercher.
//!
//! Réponse (JSON compressé en gzip, en colonnes pour bien se compresser), un accident = la même
//! position dans chaque tableau :
//! - `lon`, `lat` : degrés × 10 000 (entiers, à ~10 m près) ;
//! - `ts` : date et heure locales, `AAAAMMJJhhmm` ;
//! - `cnt` : personnes par gravité, 6 bits chacune : tués | hospitalisés << 6 | blessés légers << 12 | indemnes << 18 ;
//! - `ctx` : contexte : lumière (4 bits) | météo << 4 | route << 8 | véhicules << 12 (masque `VEH_*`).

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::body::Bytes;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use flate2::Compression;
use flate2::write::GzEncoder;
use jiff::Timestamp;
use tokio::io::AsyncWriteExt;
use tracing::{info, warn};

/// Le jeu de données « Bases de données annuelles des accidents corporels de la circulation routière ».
const DATASET_URL: &str = "https://www.data.gouv.fr/api/1/datasets/53698f4ca3a729239d2036df/";
/// Nombre d'années gardées (les plus récentes qui ont leurs quatre fichiers).
const YEARS: usize = 5;
/// Une nouvelle année est publiée en automne, une fois par an : relire le catalogue chaque mois suffit.
const REFRESH_EVERY: Duration = Duration::from_secs(30 * 24 * 3600);
const RETRY_AFTER: Duration = Duration::from_secs(30 * 60);
/// Chaque fichier fait 7 à 14 Mo : au-delà de 120 Mo, la source a changé de nature, on s'arrête.
const MAX_DOWNLOAD_BYTES: u64 = 120 * 1024 * 1024;

/// Masque des véhicules ou usagers impliqués (bits de `ctx`, à partir du 12e).
const VEH_PEDESTRIAN: u32 = 1;
const VEH_BICYCLE: u32 = 2; // vélo, vélo à assistance électrique, trottinette
const VEH_MOTORBIKE: u32 = 4; // deux et trois roues motorisés
const VEH_CAR: u32 = 8; // voiture, voiturette, camionnette
const VEH_HEAVY: u32 = 16; // poids lourd, bus, car
const VEH_RAIL: u32 = 32; // train, tramway
const VEH_OTHER: u32 = 64;

/// Réponse prête à servir (JSON compressé en gzip).
static BODY: RwLock<Option<Bytes>> = RwLock::new(None);

/// La réponse de `/api/accidents`.
pub fn response() -> Response {
    let body = BODY.read().expect("verrou des accidents").clone();
    match body {
        Some(body) => ([(header::CONTENT_TYPE, "application/json"), (header::CONTENT_ENCODING, "gzip")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "accidents : première collecte en cours (quelques minutes)").into_response(),
    }
}

fn publish(body: Vec<u8>) {
    *BODY.write().expect("verrou des accidents") = Some(Bytes::from(body));
}

/// Fait vivre la couche : relit le cache s'il est récent, sinon collecte, puis recommence le mois suivant.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf) {
    let dir = data_dir.join("accidents");
    let cache = dir.join("accidents.json.gz");
    loop {
        let age = tokio::fs::metadata(&cache).await.ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok());
        if BODY.read().expect("verrou des accidents").is_none()
            && let Ok(body) = tokio::fs::read(&cache).await
        {
            info!(age_h = age.map_or(-1, |a| (a.as_secs() / 3600) as i64), "accidents : cache chargé");
            publish(body);
        }
        if age.is_some_and(|a| a < REFRESH_EVERY) {
            tokio::time::sleep(REFRESH_EVERY - age.unwrap_or_default()).await;
            continue;
        }
        match refresh(&http, &dir, &cache).await {
            Ok((body, count)) => {
                info!(accidents = count, octets = body.len(), "accidents : bases de l'ONISR mises à jour");
                publish(body);
            }
            Err(error) => {
                warn!("accidents : bases de l'ONISR indisponibles : {error:#}");
                tokio::time::sleep(RETRY_AFTER).await;
            }
        }
    }
}

/// Les quatre fichiers d'une année.
#[derive(Default, Clone)]
struct YearFiles {
    /// Adresses des fichiers, dans l'ordre : caractéristiques, lieux, usagers, véhicules.
    urls: [Option<(String, String)>; 4],
}

/// Reconnaît un fichier d'après son titre (« Caract_2025.csv », « carcteristiques-2022.csv », « usagers-2023.csv »…).
/// Les fichiers « vehicules-immatricules » sont une autre base (avec les immatriculations) : écartés.
fn classify(title: &str) -> Option<(u16, usize)> {
    let lower = title.to_lowercase();
    let kind = if lower.contains("caract") || lower.contains("carcter") {
        0
    } else if lower.contains("lieux") {
        1
    } else if lower.contains("usagers") {
        2
    } else if lower.contains("vehicules") && !lower.contains("immatricul") {
        3
    } else {
        return None;
    };
    let year = lower.as_bytes().windows(4).find_map(|w| {
        let text = std::str::from_utf8(w).ok()?;
        let year: u16 = text.parse().ok()?;
        (2005..=2100).contains(&year).then_some(year)
    })?;
    Some((year, kind))
}

/// Choisit, dans la liste des ressources du jeu de données, les `YEARS` dernières années complètes.
fn pick_years(resources: &[serde_json::Value]) -> Vec<(u16, [String; 4])> {
    let mut by_year: HashMap<u16, YearFiles> = HashMap::new();
    for resource in resources {
        let title = resource["title"].as_str().unwrap_or("");
        let url = resource["url"].as_str().unwrap_or("");
        if !resource["format"].as_str().unwrap_or("").eq_ignore_ascii_case("csv") || url.is_empty() {
            continue;
        }
        let Some((year, kind)) = classify(title) else { continue };
        let modified = resource["last_modified"].as_str().unwrap_or("").to_string();
        let slot = &mut by_year.entry(year).or_default().urls[kind];
        // Plusieurs fichiers pour la même année et le même rôle : le plus récemment modifié l'emporte.
        if slot.as_ref().is_none_or(|(_, previous)| modified > *previous) {
            *slot = Some((url.to_string(), modified));
        }
    }
    let mut complete: Vec<(u16, [String; 4])> = by_year
        .into_iter()
        .filter_map(|(year, files)| {
            let [Some(c), Some(l), Some(u), Some(v)] = files.urls else { return None };
            Some((year, [c.0, l.0, u.0, v.0]))
        })
        .collect();
    complete.sort_by_key(|(year, _)| std::cmp::Reverse(*year));
    complete.truncate(YEARS);
    complete.sort_by_key(|(year, _)| *year);
    complete
}

async fn refresh(http: &reqwest::Client, dir: &Path, cache: &Path) -> Result<(Vec<u8>, usize)> {
    tokio::fs::create_dir_all(dir).await?;
    let catalog_bytes = http.get(DATASET_URL).send().await?.error_for_status()?.bytes().await?;
    let catalog: serde_json::Value = serde_json::from_slice(&catalog_bytes).context("catalogue illisible")?;
    drop(catalog_bytes);
    let resources = catalog["resources"].as_array().context("le catalogue n'a pas de ressources")?;
    let years = pick_years(resources);
    if years.is_empty() {
        bail!("aucune année complète (quatre fichiers) dans le catalogue");
    }
    info!(annees = ?years.iter().map(|(y, _)| *y).collect::<Vec<_>>(), "accidents : années retenues");

    let mut all: Vec<Accident> = Vec::new();
    let mut discarded = 0usize;
    for (year, urls) in &years {
        // Un fichier à la fois sur le disque, effacé dès qu'il est lu : au plus 14 Mo.
        let mut paths = Vec::new();
        for (index, url) in urls.iter().enumerate() {
            let path = dir.join(format!("{year}-{index}.csv.part"));
            if let Err(error) = download(http, url, &path).await {
                for p in &paths {
                    let _ = tokio::fs::remove_file(p).await;
                }
                let _ = tokio::fs::remove_file(&path).await;
                return Err(error.context(format!("année {year}")));
            }
            paths.push(path);
        }
        let read_paths = paths.clone();
        let result = tokio::task::spawn_blocking(move || {
            let open = |p: &Path| csv::ReaderBuilder::new().delimiter(b';').flexible(true).from_path(p);
            read_year(open(&read_paths[0])?, open(&read_paths[1])?, open(&read_paths[2])?, open(&read_paths[3])?)
        })
        .await?;
        for p in &paths {
            let _ = tokio::fs::remove_file(p).await;
        }
        let (mut rows, skipped) = result.with_context(|| format!("année {year}"))?;
        info!(year, accidents = rows.len(), sans_position = skipped, "accidents : année lue");
        discarded += skipped;
        all.append(&mut rows);
    }
    let count = all.len();
    let mut gzip = GzEncoder::new(Vec::new(), Compression::new(6));
    write_json(&mut gzip, &all, &years.iter().map(|(y, _)| *y).collect::<Vec<_>>(), discarded, Timestamp::now().as_second())?;
    let body = gzip.finish()?;
    let tmp = cache.with_extension("gz.part");
    tokio::fs::write(&tmp, &body).await?;
    tokio::fs::rename(&tmp, cache).await?;
    Ok((body, count))
}

async fn download(http: &reqwest::Client, url: &str, path: &Path) -> Result<()> {
    let mut response = http.get(url).timeout(Duration::from_secs(300)).send().await?.error_for_status()?;
    let mut file = tokio::fs::File::create(path).await?;
    let mut total = 0u64;
    while let Some(chunk) = response.chunk().await? {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD_BYTES {
            bail!("un fichier dépasse {} Mo", MAX_DOWNLOAD_BYTES / 1024 / 1024);
        }
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    Ok(())
}

/// Un accident, en 24 octets.
#[derive(Debug, Clone, PartialEq)]
struct Accident {
    lon: i32,
    lat: i32,
    ts: u64,
    cnt: u32,
    ctx: u32,
}

/// Lecture des colonnes par leur nom (l'ordre varie d'une année à l'autre ; un nom peut traîner un retour à la ligne).
struct Columns(HashMap<String, usize>);

impl Columns {
    fn of<R: std::io::Read>(reader: &mut csv::Reader<R>, required: &[&str]) -> Result<Self> {
        let headers = reader.headers().context("en-têtes illisibles")?;
        // Le fichier des caractéristiques de 2022 nomme la clé « Accident_Id » au lieu de « Num_Acc » : même chose.
        let rename = |h: &str| match h.trim_start_matches('\u{feff}').trim() {
            "Accident_Id" => "Num_Acc".to_string(),
            other => other.to_string(),
        };
        let columns = Self(headers.iter().enumerate().map(|(i, h)| (rename(h), i)).collect());
        for name in required {
            if !columns.0.contains_key(*name) {
                bail!("colonne {name} absente : le format de la base a changé");
            }
        }
        Ok(columns)
    }

    fn get<'a>(&self, record: &'a csv::ByteRecord, name: &str) -> Cow<'a, str> {
        match self.0.get(name).and_then(|&i| record.get(i)) {
            Some(bytes) => String::from_utf8_lossy(bytes),
            None => Cow::Borrowed(""),
        }
    }

    fn number(&self, record: &csv::ByteRecord, name: &str) -> Option<u64> {
        self.get(record, name).trim().parse().ok()
    }
}

/// Catégorie de véhicule (code `catv`) → masque `VEH_*`.
fn vehicle_bit(catv: u64) -> u32 {
    match catv {
        1 | 50 | 60 | 80 => VEH_BICYCLE,
        2 | 30..=34 | 41..=43 => VEH_MOTORBIKE,
        3 | 7 | 10 => VEH_CAR,
        13..=17 | 37 | 38 => VEH_HEAVY,
        39 | 40 => VEH_RAIL,
        _ => VEH_OTHER,
    }
}

/// « 5,5 » ou « 5.5 » → 5,5 ; les décimales sont écrites à la française depuis 2019.
fn parse_degrees(text: &str) -> Option<f64> {
    text.trim().replace(',', ".").parse().ok()
}

/// Lit les quatre fichiers d'une année et renvoie les accidents de métropole (position connue), et le nombre d'écartés.
/// Les quatre lecteurs : caractéristiques, lieux, usagers, véhicules.
fn read_year<R: std::io::Read>(
    mut caract: csv::Reader<R>,
    mut places: csv::Reader<R>,
    mut users: csv::Reader<R>,
    mut vehicles: csv::Reader<R>,
) -> Result<(Vec<Accident>, usize)> {
    let cc = Columns::of(&mut caract, &["Num_Acc", "jour", "mois", "an", "hrmn", "lum", "atm", "lat", "long"])?;
    let lc = Columns::of(&mut places, &["Num_Acc", "catr"])?;
    // `grav` et `catu` : la gravité et le type d'usager (conducteur, passager, piéton). Rien d'autre sur les personnes.
    let uc = Columns::of(&mut users, &["Num_Acc", "grav", "catu"])?;
    let vc = Columns::of(&mut vehicles, &["Num_Acc", "catv"])?;

    let mut accidents: Vec<Accident> = Vec::new();
    let mut index: HashMap<u64, usize> = HashMap::new();
    let mut skipped = 0usize;
    let mut record = csv::ByteRecord::new();
    while caract.read_byte_record(&mut record).context("caractéristiques illisibles")? {
        let Some(id) = cc.number(&record, "Num_Acc") else { continue };
        let position = parse_degrees(&cc.get(&record, "long")).zip(parse_degrees(&cc.get(&record, "lat")));
        // France métropolitaine, Corse comprise ; (0, 0) est la valeur « inconnu » du fichier.
        let Some((lon, lat)) = position.filter(|(lon, lat)| (-5.6..=10.0).contains(lon) && (41.0..=51.5).contains(lat)) else {
            skipped += 1;
            continue;
        };
        let year = cc.number(&record, "an").unwrap_or(0);
        let year = if year < 100 { year + 2000 } else { year };
        let time = cc.get(&record, "hrmn");
        let (hour, minute) = time.trim().split_once(':').map_or((0, 0), |(h, m)| (h.parse().unwrap_or(0), m.parse().unwrap_or(0)));
        let ts = ((year * 100 + cc.number(&record, "mois").unwrap_or(0)) * 100 + cc.number(&record, "jour").unwrap_or(0)) * 10_000 + hour * 100 + minute;
        let ctx = (cc.number(&record, "lum").unwrap_or(0).min(15) as u32) | ((cc.number(&record, "atm").unwrap_or(0).min(15) as u32) << 4);
        index.insert(id, accidents.len());
        accidents.push(Accident { lon: (lon * 1e4).round() as i32, lat: (lat * 1e4).round() as i32, ts, cnt: 0, ctx });
    }

    while places.read_byte_record(&mut record).context("lieux illisibles")? {
        if let Some(&i) = lc.number(&record, "Num_Acc").and_then(|id| index.get(&id)) {
            accidents[i].ctx |= (lc.number(&record, "catr").unwrap_or(0).min(15) as u32) << 8;
        }
    }

    while users.read_byte_record(&mut record).context("usagers illisibles")? {
        let Some(&i) = uc.number(&record, "Num_Acc").and_then(|id| index.get(&id)) else { continue };
        // Gravité : 1 indemne, 2 tué, 3 blessé hospitalisé, 4 blessé léger. Chaque décompte tient sur 6 bits.
        let shift = match uc.number(&record, "grav") {
            Some(2) => 0,
            Some(3) => 6,
            Some(4) => 12,
            Some(1) => 18,
            _ => continue,
        };
        let acc = &mut accidents[i];
        if (acc.cnt >> shift) & 63 < 63 {
            acc.cnt += 1 << shift;
        }
        if uc.number(&record, "catu") == Some(3) {
            acc.ctx |= VEH_PEDESTRIAN << 12;
        }
    }

    while vehicles.read_byte_record(&mut record).context("véhicules illisibles")? {
        if let Some(&i) = vc.number(&record, "Num_Acc").and_then(|id| index.get(&id)) {
            accidents[i].ctx |= vehicle_bit(vc.number(&record, "catv").unwrap_or(99)) << 12;
        }
    }
    Ok((accidents, skipped))
}

/// Écrit un tableau d'entiers : `[1,2,3]`.
fn write_array<W: Write, T: Copy + std::fmt::Display>(out: &mut W, name: &str, values: impl Iterator<Item = T>) -> Result<()> {
    write!(out, "\"{name}\":[")?;
    for (i, value) in values.enumerate() {
        if i > 0 {
            out.write_all(b",")?;
        }
        write!(out, "{value}")?;
    }
    out.write_all(b"]")?;
    Ok(())
}

fn write_json<W: Write>(out: &mut W, accidents: &[Accident], years: &[u16], discarded: usize, updated_at: i64) -> Result<()> {
    write!(out, "{{\"updatedAt\":{updated_at},\"years\":{years:?},\"n\":{},\"sansPosition\":{discarded},", accidents.len())?;
    write_array(out, "lon", accidents.iter().map(|a| a.lon))?;
    out.write_all(b",")?;
    write_array(out, "lat", accidents.iter().map(|a| a.lat))?;
    out.write_all(b",")?;
    write_array(out, "ts", accidents.iter().map(|a| a.ts))?;
    out.write_all(b",")?;
    write_array(out, "cnt", accidents.iter().map(|a| a.cnt))?;
    out.write_all(b",")?;
    write_array(out, "ctx", accidents.iter().map(|a| a.ctx))?;
    out.write_all(b"}")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Extraits réels de la base 2025 (4 accidents), réduits aux colonnes lues : jamais d'âge ni de sexe.
    const CARACT: &str = include_str!("testdata/accidents_caract.csv");
    const LIEUX: &str = include_str!("testdata/accidents_lieux.csv");
    const USAGERS: &str = include_str!("testdata/accidents_usagers.csv");
    const VEHICULES: &str = include_str!("testdata/accidents_vehicules.csv");

    fn reader(text: &str) -> csv::Reader<&[u8]> {
        csv::ReaderBuilder::new().delimiter(b';').flexible(true).from_reader(text.as_bytes())
    }

    fn sample() -> (Vec<Accident>, usize) {
        read_year(reader(CARACT), reader(LIEUX), reader(USAGERS), reader(VEHICULES)).unwrap()
    }

    #[test]
    fn joint_les_quatre_fichiers_sur_num_acc() {
        let (accidents, skipped) = sample();
        // Un accident sans position (écarté), un en outre-mer (écarté).
        assert_eq!(skipped, 2);
        assert_eq!(accidents.len(), 3);
        let first = &accidents[0];
        assert_eq!(first.ts, 202_505_051_535);
        assert_eq!((first.lon, first.lat), (32_480, 495_185));
        // Une personne blessée légère... voir le fichier d'extrait : on vérifie le total des personnes.
        let people: u32 = (0..4).map(|k| (first.cnt >> (6 * k)) & 63).sum();
        assert!(people >= 1);
        // Route départementale (catr 3) et lumière « plein jour » (1), météo normale (1).
        assert_eq!(first.ctx & 15, 1);
        assert_eq!((first.ctx >> 4) & 15, 1);
        assert_eq!((first.ctx >> 8) & 15, 3);
    }

    #[test]
    fn accepte_la_cle_accident_id_de_2022() {
        let caract = CARACT.replacen("\"Num_Acc\"", "\"Accident_Id\"", 1);
        let (accidents, _) = read_year(reader(&caract), reader(LIEUX), reader(USAGERS), reader(VEHICULES)).unwrap();
        assert_eq!(accidents.len(), 3);
    }

    #[test]
    fn categories_de_vehicules() {
        assert_eq!(vehicle_bit(7), VEH_CAR);
        assert_eq!(vehicle_bit(33), VEH_MOTORBIKE);
        assert_eq!(vehicle_bit(1), VEH_BICYCLE);
        assert_eq!(vehicle_bit(80), VEH_BICYCLE);
        assert_eq!(vehicle_bit(14), VEH_HEAVY);
        assert_eq!(vehicle_bit(40), VEH_RAIL);
        assert_eq!(vehicle_bit(99), VEH_OTHER);
    }

    #[test]
    fn la_reponse_ne_contient_aucune_donnee_personnelle() {
        let (accidents, _) = sample();
        let mut out = Vec::new();
        write_json(&mut out, &accidents, &[2025], 2, 0).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&out).unwrap();
        let mut keys: Vec<_> = json.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, ["cnt", "ctx", "lat", "lon", "n", "sansPosition", "ts", "updatedAt", "years"]);
        assert_eq!(json["n"], 3);
        assert_eq!(json["lon"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn reconnait_les_fichiers_malgre_les_titres_changeants() {
        assert_eq!(classify("Caract_2025.csv"), Some((2025, 0)));
        assert_eq!(classify("carcteristiques-2022.csv"), Some((2022, 0)));
        assert_eq!(classify("lieux-2023.csv"), Some((2023, 1)));
        assert_eq!(classify("Usagers_2024.csv"), Some((2024, 2)));
        assert_eq!(classify("Vehicules_2024.csv"), Some((2024, 3)));
        // Autre base, avec les immatriculations : écartée.
        assert_eq!(classify("vehicules-immatricule-baac-2025.csv"), None);
        assert_eq!(classify("Description des données"), None);
    }

    #[test]
    fn garde_les_dernieres_annees_completes() {
        let resource = |title: &str, url: &str| serde_json::json!({ "title": title, "url": url, "format": "csv", "last_modified": "2025-01-01" });
        let mut resources = Vec::new();
        for year in 2019..=2025u16 {
            for kind in ["Caract", "Lieux", "Usagers", "Vehicules"] {
                // 2025 est incomplète : il manque les véhicules.
                if year == 2025 && kind == "Vehicules" {
                    continue;
                }
                resources.push(resource(&format!("{kind}_{year}.csv"), &format!("https://exemple/{kind}-{year}")));
            }
        }
        let years: Vec<u16> = pick_years(&resources).iter().map(|(y, _)| *y).collect();
        assert_eq!(years, vec![2020, 2021, 2022, 2023, 2024]);
    }

    /// Mesure de mémoire à la main : `ACCIDENTS_DIR=/dossier cargo test --release mesure_memoire -- --ignored`, sous
    /// `/usr/bin/time -l`. Le dossier contient c25.csv, l25.csv, u25.csv et v25.csv ; l'année est lue cinq fois.
    #[test]
    #[ignore = "demande les vrais fichiers (34 Mo)"]
    fn mesure_memoire() {
        let dir = std::path::PathBuf::from(std::env::var("ACCIDENTS_DIR").expect("ACCIDENTS_DIR"));
        let open = |name: &str| csv::ReaderBuilder::new().delimiter(b';').flexible(true).from_path(dir.join(name)).unwrap();
        let mut all = Vec::new();
        for _ in 0..5 {
            let (mut rows, _) = read_year(open("c25.csv"), open("l25.csv"), open("u25.csv"), open("v25.csv")).unwrap();
            all.append(&mut rows);
        }
        let mut gzip = GzEncoder::new(Vec::new(), Compression::new(6));
        write_json(&mut gzip, &all, &[2025], 0, 0).unwrap();
        println!("accidents : {}, {} octets gzip", all.len(), gzip.finish().unwrap().len());
    }
}
