//! Monuments historiques : la base Mérimée du ministère de la Culture, « Immeubles protégés au titre
//! des monuments historiques » (data.gouv.fr, Licence Ouverte 2.0), environ 46 000 notices.
//!
//! Le fichier (un CSV de 100 Mo, séparateur « | », mis à jour chaque semaine) est téléchargé sur le
//! disque, lu en continu et réduit à ce que la carte affiche : référence, position, catégorie,
//! protection, nom, commune, époque, courte description. Le résultat (7 Mo de JSON, 2 Mo une fois
//! compressé) est rangé dans `DATA_DIR/monuments/monuments.json.gz` et gardé **compressé** en
//! mémoire : il est servi tel quel, avec `Content-Encoding: gzip`. Le CSV est effacé après lecture.
//!
//! Format de la réponse : `{ "updatedAt", "monuments": [[ref, lon, lat, cat, prot, nom, commune,
//! département, dénomination, époque, date de protection, description], …], "sansPosition" }`.
//! Les codes `cat` et `prot` sont expliqués sur `Category` et `protection` ci-dessous.

use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
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

const SOURCE_URL: &str = "https://ministere-culture.s3.sbg.io.cloud.ovh.net/POP/merimee.csv";
/// La base change une fois par semaine.
const REFRESH_EVERY: Duration = Duration::from_secs(7 * 24 * 3600);
const RETRY_AFTER: Duration = Duration::from_secs(30 * 60);
/// Le fichier fait 100 Mo : au-delà de 400 Mo, la source a changé de nature, on s'arrête.
const MAX_DOWNLOAD_BYTES: u64 = 400 * 1024 * 1024;

/// Réponse prête à servir (JSON compressé en gzip).
static BODY: RwLock<Option<Bytes>> = RwLock::new(None);

/// La réponse de `/api/monuments`.
pub fn response() -> Response {
    let body = BODY.read().expect("verrou des monuments").clone();
    match body {
        Some(body) => ([(header::CONTENT_TYPE, "application/json"), (header::CONTENT_ENCODING, "gzip")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, "monuments : première collecte en cours").into_response(),
    }
}

fn publish(body: Vec<u8>) {
    // L'analyse de zone (`analyse.rs`) compte les monuments d'un contour : on garde leurs positions, relues de la réponse.
    match build_index(&body) {
        Ok(index) => *INDEX.write().expect("verrou de l'index des monuments") = Some(Arc::new(index)),
        Err(error) => warn!("monuments : index pour l'analyse de zone impossible : {error:#}"),
    }
    *BODY.write().expect("verrou des monuments") = Some(Bytes::from(body));
}

/// Position (degrés), catégorie (`category`) et protection (`protection`) de chaque monument : 12 octets (45 000 : 0,5 Mo).
pub struct Index {
    pub points: Vec<(f32, f32, u8, u8)>,
}

static INDEX: RwLock<Option<Arc<Index>>> = RwLock::new(None);

/// L'index des monuments, une fois la base chargée.
pub fn index() -> Option<Arc<Index>> {
    INDEX.read().expect("verrou de l'index des monuments").clone()
}

fn build_index(gzipped: &[u8]) -> Result<Index> {
    use serde::de::IgnoredAny as X;
    #[derive(serde::Deserialize)]
    struct Body {
        monuments: Vec<(X, f64, f64, u8, u8, X, X, X, X, X, X, X)>,
    }
    let body: Body = serde_json::from_reader(flate2::read::GzDecoder::new(gzipped)).context("réponse des monuments illisible")?;
    Ok(Index { points: body.monuments.iter().map(|m| (m.1 as f32, m.2 as f32, m.3, m.4)).collect() })
}

/// Fait vivre la couche : relit le cache s'il est récent, sinon télécharge, puis recommence la semaine suivante.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf) {
    let dir = data_dir.join("monuments");
    let cache = dir.join("monuments.json.gz");
    loop {
        let age = cache_age(&cache).await;
        if BODY.read().expect("verrou des monuments").is_none()
            && let Ok(body) = tokio::fs::read(&cache).await
        {
            info!(age_h = age.map_or(-1, |a| (a.as_secs() / 3600) as i64), "monuments : cache chargé");
            publish(body);
        }
        if age.is_some_and(|a| a < REFRESH_EVERY) {
            tokio::time::sleep(REFRESH_EVERY - age.unwrap_or_default()).await;
            continue;
        }
        match refresh(&http, &dir, &cache).await {
            Ok((body, count)) => {
                info!(monuments = count, octets = body.len(), "monuments : base Mérimée mise à jour");
                publish(body);
            }
            Err(error) => {
                warn!("monuments : base Mérimée indisponible : {error:#}");
                tokio::time::sleep(RETRY_AFTER).await;
            }
        }
    }
}

async fn cache_age(cache: &Path) -> Option<Duration> {
    tokio::fs::metadata(cache).await.ok()?.modified().ok()?.elapsed().ok()
}

async fn refresh(http: &reqwest::Client, dir: &Path, cache: &Path) -> Result<(Vec<u8>, usize)> {
    tokio::fs::create_dir_all(dir).await?;
    let csv_path = dir.join("merimee.csv.part");
    let result = match download(http, &csv_path).await {
        Ok(()) => {
            let path = csv_path.clone();
            tokio::task::spawn_blocking(move || {
                let reader = csv::ReaderBuilder::new().delimiter(b'|').flexible(true).from_path(&path)?;
                let mut gzip = GzEncoder::new(Vec::new(), Compression::new(6));
                let count = convert(reader, &mut gzip, Timestamp::now().as_second())?;
                Ok::<_, anyhow::Error>((gzip.finish()?, count))
            })
            .await?
        }
        Err(error) => Err(error),
    };
    let _ = tokio::fs::remove_file(&csv_path).await;
    let (body, count) = result?;
    let tmp = cache.with_extension("gz.part");
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
    info!(octets = total, "monuments : fichier téléchargé");
    Ok(())
}

/// Catégories d'affichage (code envoyé à la carte). Elles regroupent le « domaine » de la notice.
/// 0 religieux · 1 château et demeure · 2 militaire · 3 civil et urbain · 4 archéologique ·
/// 5 industriel, agricole et ouvrage d'art · 6 funéraire et commémoratif · 7 autre.
fn category(domain: &str, denomination: &str) -> u8 {
    // Le premier domaine cité est le principal.
    let first = domain.split(';').next().unwrap_or("").trim().to_lowercase();
    let by_domain = match first.as_str() {
        "architecture religieuse" => Some(0),
        "architecture domestique" => Some(1),
        "architecture militaire" => Some(2),
        "architecture de l'administration ou de la vie publique"
        | "architecture scolaire"
        | "architecture judiciaire, pénitentiaire ou de police"
        | "architecture fiscale ou financière"
        | "architecture de culture, recherche, sport ou loisir"
        | "architecture commerciale"
        | "architecture de commerce"
        | "urbanisme"
        | "escalier"
        | "architecture de jardin" => Some(3),
        s if s.starts_with("architecture hospitalière") => Some(3),
        "site archéologique" => Some(4),
        "architecture industrielle" | "architecture artisanale" | "architecture agricole" | "génie civil" => Some(5),
        s if s.starts_with("architecture funéraire") => Some(6),
        _ => None,
    };
    if let Some(code) = by_domain {
        return code;
    }
    // Domaine absent : on devine d'après la dénomination (« dolmen », « église »…).
    let name = denomination.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| name.contains(w));
    if has(&["dolmen", "menhir", "tumulus", "archéolog", "oppidum", "allée couverte", "grotte", "polissoir", "camp"]) {
        4
    } else if has(&["église", "chapelle", "abbaye", "cathédrale", "couvent", "prieuré", "temple", "synagogue", "calvaire"]) {
        0
    } else if has(&["château fort", "fort", "enceinte", "fortification", "porte de ville", "édifice fortifié", "tour"]) {
        2
    } else if has(&["château", "manoir", "maison", "hôtel", "demeure", "villa"]) {
        1
    } else if has(&["cimetière", "monument aux morts", "croix", "tombeau", "mausolée"]) {
        6
    } else if has(&["pont", "usine", "moulin", "canal", "mine", "phare", "ferme", "aqueduc", "viaduc"]) {
        5
    } else {
        7
    }
}

/// Protection : (code, date). Le code vaut 0 inscrit, 1 classé, 2 inscrit en partie, 3 classé en partie.
/// Un monument à la fois classé et inscrit (parties différentes) est dit « classé » : c'est le niveau le plus fort.
/// La date est celle de la première décision de ce niveau (« AAAA-MM-JJ »), ou vide.
fn protection(kinds: &str, dated: &str) -> (u8, String) {
    let lower = kinds.to_lowercase();
    let classed = lower.contains("classé");
    let level = if classed { "classé" } else { "inscrit" };
    // Partielle quand rien ne dit « total » : « classé MH » seul est une protection totale, « classé MH partiellement » non.
    let total = lower.split(';').any(|k| {
        let k = k.trim();
        k == format!("{level} mh") || k == "protection totale"
    });
    let code = u8::from(classed) + if total { 0 } else { 2 };
    let mut date = String::new();
    for entry in dated.split(';') {
        let entry = entry.replace('\u{a0}', " ");
        // « 1930/11/30 : classé MH » ; la base écrit aussi « 1862 : classé MH » (année seule) et des variantes sans « : ».
        if !entry.to_lowercase().contains(level) {
            continue;
        }
        if let Some(iso) = parse_date(&entry)
            && (date.is_empty() || iso < date)
        {
            date = iso;
        }
    }
    (code, date)
}

/// Début d'une entrée : « 1930/11/30 », « 1862 », « 2006//09/15 »… → « 1930-11-30 », « 1862 » (année, mois ou jour, selon ce qui est connu).
fn parse_date(entry: &str) -> Option<String> {
    let entry = entry.trim_start();
    let year: String = entry.chars().take_while(char::is_ascii_digit).collect();
    if year.len() != 4 {
        return None;
    }
    let mut iso = year.clone();
    let mut rest = &entry[4..];
    for _ in 0..2 {
        let trimmed = rest.trim_start_matches([' ', '/']);
        let digits: String = trimmed.chars().take_while(char::is_ascii_digit).collect();
        // Une date mal écrite (« 2019/09/019 ») s'arrête là : on garde ce qui est sûr.
        if digits.is_empty() || digits.len() > 2 || rest.len() == trimmed.len() {
            break;
        }
        iso = format!("{iso}-{digits:0>2}");
        rest = &trimmed[digits.len()..];
    }
    Some(iso)
}

fn truncate(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max { text } else { format!("{}…", text.chars().take(max).collect::<String>().trim_end()) }
}

/// Première lettre en majuscule (« église » → « Église »).
fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |c| c.to_uppercase().collect::<String>() + chars.as_str())
}

/// Époque : le siècle de la campagne principale (« 16e siècle;17e siècle » → « 16e siècle / 17e siècle »),
/// à défaut la datation brute.
fn period(century: &str, dating: &str) -> String {
    let source = if century.trim().is_empty() { dating } else { century };
    truncate(&source.split(';').map(str::trim).filter(|s| !s.is_empty()).take(2).collect::<Vec<_>>().join(" / "), 40)
}

/// « lat,lon » → (lon, lat), si les nombres sont plausibles (France, Corse et outre-mer).
fn coordinates(text: &str) -> Option<(f64, f64)> {
    let (lat, lon) = text.trim().split_once(',')?;
    let (lat, lon): (f64, f64) = (lat.trim().parse().ok()?, lon.trim().parse().ok()?);
    ((-23.0..=52.0).contains(&lat) && (-63.0..=56.0).contains(&lon) && (lat != 0.0 || lon != 0.0)).then_some((lon, lat))
}

struct Columns(HashMap<String, usize>);

impl Columns {
    fn get<'a>(&self, record: &'a csv::ByteRecord, name: &str) -> Cow<'a, str> {
        match self.0.get(name).and_then(|&i| record.get(i)) {
            Some(bytes) => String::from_utf8_lossy(bytes),
            None => Cow::Borrowed(""),
        }
    }
}

/// Lit le CSV en continu et écrit la réponse JSON dans `out`, notice par notice (rien n'est gardé
/// en mémoire hors la notice courante). Renvoie le nombre de monuments écrits.
fn convert<R: std::io::Read, W: Write>(mut reader: csv::Reader<R>, out: &mut W, updated_at: i64) -> Result<usize> {
    let headers = reader.headers().context("en-têtes illisibles")?.clone();
    let columns = Columns(headers.iter().enumerate().map(|(i, h)| (h.trim_start_matches('\u{feff}').trim().to_string(), i)).collect());
    for required in ["Reference", "Titre_editorial_de_la_notice", "coordonnees_au_format_WGS84", "Typologie_de_la_protection"] {
        if !columns.0.contains_key(required) {
            bail!("colonne {required} absente : le format de la base a changé");
        }
    }
    write!(out, "{{\"updatedAt\":{updated_at},\"monuments\":[")?;
    let (mut count, mut without_position) = (0usize, 0usize);
    let mut record = csv::ByteRecord::new();
    while reader.read_byte_record(&mut record).context("ligne illisible")? {
        let get = |name: &str| columns.get(&record, name);
        let reference = get("Reference").trim().to_string();
        if reference.is_empty() {
            continue;
        }
        let Some((lon, lat)) = coordinates(&get("coordonnees_au_format_WGS84")) else {
            without_position += 1;
            continue;
        };
        let denomination = get("Denomination_de_l_edifice");
        let denomination = denomination.split(';').next().unwrap_or("").trim().to_string();
        let (prot, date) = protection(&get("Typologie_de_la_protection"), &get("Date_et_typologie_de_la_protection"));
        let commune = {
            let editorial = get("Commune_forme_editoriale");
            if editorial.trim().is_empty() { get("Commune_forme_index").into_owned() } else { editorial.into_owned() }
        };
        let title = get("Titre_editorial_de_la_notice");
        let name = if title.trim().is_empty() { capitalize(&denomination) } else { title.trim().to_string() };
        let row = (
            reference,
            (lon * 1e5).round() / 1e5,
            (lat * 1e5).round() / 1e5,
            category(&get("Domaine"), &denomination),
            prot,
            truncate(&name, 90),
            truncate(&commune, 50),
            get("Departement_format_numerique").trim().to_string(),
            capitalize(&truncate(&denomination, 40)),
            period(&get("Siecle_de_la_campagne_principale_de_construction"), &get("Datation_de_l_edifice")),
            date,
            truncate(&get("Description_de_l_edifice"), 280),
        );
        if count > 0 {
            out.write_all(b",")?;
        }
        serde_json::to_writer(&mut *out, &row)?;
        count += 1;
    }
    write!(out, "],\"sansPosition\":{without_position}}}")?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extrait réel de la base Mérimée (colonnes utiles seulement) : 7 notices.
    const SAMPLE: &str = include_str!("testdata/merimee_extrait.csv");

    fn convert_sample() -> serde_json::Value {
        let reader = csv::ReaderBuilder::new().delimiter(b'|').flexible(true).from_reader(SAMPLE.as_bytes());
        let mut out = Vec::new();
        convert(reader, &mut out, 1).unwrap();
        serde_json::from_slice(&out).unwrap()
    }

    #[test]
    fn protection_classe_ou_inscrit_total_ou_partiel() {
        assert_eq!(protection("classé MH", "1930/11/30 : classé MH"), (1, "1930-11-30".into()));
        assert_eq!(protection("inscrit MH partiellement", "1941/05/23 : inscrit MH"), (2, "1941-05-23".into()));
        // Classé et inscrit : le niveau le plus fort l'emporte, avec la date de sa première décision.
        let (code, date) = protection(
            "classé MH partiellement;inscrit MH partiellement;protection totale",
            "1980/01/25 : classé MH ; 1980/01/25 : inscrit MH ; 2020/11/03 : inscrit MH",
        );
        assert_eq!((code, date.as_str()), (1, "1980-01-25"));
        // Dates mal formées (espace insécable, date coupée) : ignorées sans erreur.
        assert_eq!(protection("inscrit MH", "inscrit MH ; 2020/05/27 : inscrit MH").1, "2020-05-27");
        // Année seule, ou date sans « : ».
        assert_eq!(protection("classé MH", "1862 : classé MH"), (1, "1862".into()));
        assert_eq!(protection("inscrit MH", "2024/11/14 inscrit MH").1, "2024-11-14");
        assert_eq!(protection("inscrit MH", "   2020/01/03\u{a0}: inscrit MH").1, "2020-01-03");
    }

    #[test]
    fn categories_par_domaine_puis_par_denomination() {
        assert_eq!(category("architecture religieuse", "église"), 0);
        assert_eq!(category("architecture domestique", "château"), 1);
        assert_eq!(category("architecture de l'administration ou de la vie publique;architecture militaire", "mairie"), 3);
        assert_eq!(category("", "dolmen"), 4);
        assert_eq!(category("", "église"), 0);
        assert_eq!(category("génie civil", "pont"), 5);
        assert_eq!(category("architecture funéraire, commémorative ou votive", "monument aux morts"), 6);
        assert_eq!(category("", ""), 7);
    }

    #[test]
    fn convertit_lextrait_et_compte_les_notices_sans_position() {
        let json = convert_sample();
        let monuments = json["monuments"].as_array().unwrap();
        assert_eq!(monuments.len(), 6);
        assert_eq!(json["sansPosition"], 1);
        let first = &monuments[0];
        assert_eq!(first[0], "PA00078066");
        assert!((first[1].as_f64().unwrap() - 4.52479).abs() < 1e-9 && (first[2].as_f64().unwrap() - 48.39166).abs() < 1e-9);
        assert_eq!(first[5], "Halles (vieilles)");
        assert_eq!(first[6], "Brienne-le-Château");
    }

    #[test]
    fn coordonnees_hors_de_france_ecartees() {
        assert_eq!(coordinates("48.39,4.52"), Some((4.52, 48.39)));
        assert_eq!(coordinates("0,0"), None);
        assert_eq!(coordinates(""), None);
        assert_eq!(coordinates("200,4"), None);
    }

    /// Mesure de mémoire à la main : `MONUMENTS_CSV=/chemin/merimee.csv cargo test --release mesure_memoire -- --ignored`,
    /// sous `/usr/bin/time -l` (pic de mémoire résidente du processus).
    #[test]
    #[ignore = "demande le vrai fichier (100 Mo)"]
    fn mesure_memoire() {
        let path = std::env::var("MONUMENTS_CSV").expect("MONUMENTS_CSV");
        let reader = csv::ReaderBuilder::new().delimiter(b'|').flexible(true).from_path(path).unwrap();
        let mut gzip = GzEncoder::new(Vec::new(), Compression::new(6));
        let count = convert(reader, &mut gzip, 0).unwrap();
        println!("monuments : {count}, {} octets gzip", gzip.finish().unwrap().len());
    }
}
