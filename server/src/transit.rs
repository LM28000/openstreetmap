//! Bus, trams et métros en direct : les positions des véhicules des réseaux de transport
//! urbains français qui les publient (flux GTFS-RT « VehiclePositions »), rassemblées en
//! une seule liste.
//!
//! La liste des flux vient du catalogue de transport.data.gouv.fr (le point d'accès
//! national, PAN) : les ressources `gtfs-rt` dont les caractéristiques déclarent
//! `vehicle_positions`. Les données sont sous licence ouverte (Licence Ouverte 2.0 ou
//! ODbL, selon le producteur : la couche en cite la source). On écarte :
//! - la SNCF (déjà couverte par la couche des trains) et les trains étrangers ;
//! - les agrégats, qui recopient des flux déjà pris un par un (doublons) ;
//! - les ressources que le catalogue donne comme indisponibles ;
//! - les flux dont l'adresse contient une clé d'accès (il faut alors s'inscrire ou
//!   accepter des conditions propres au producteur : on ne le fait pas à la place de
//!   l'utilisateur) ; un flux qui répond 401 ou 403 est aussi mis de côté.
//!
//! Cadence : 30 secondes, ce que la documentation du PAN donne pour norme des flux
//! temps réel (son proxy relit lui-même les positions toutes les 5 secondes). Les requêtes
//! partent en parallèle borné (au plus 12 en tout, 3 par serveur), avec un délai d'attente
//! court : un réseau en panne n'attend que lui-même. Un flux en erreur est réessayé de
//! moins en moins souvent, un flux sans véhicule (la nuit) est relu moins souvent.
//!
//! Le flux de positions ne dit ni le mode de transport, ni le nom ou la couleur de la
//! ligne : ils sont dans le `routes.txt` du GTFS statique du même jeu de données. Certains
//! GTFS pèsent des centaines de Mo, mais `routes.txt` est minuscule : on lit la fin du zip
//! (annuaire des fichiers) puis seulement les octets de `routes.txt`, par requêtes
//! `Range`. Un serveur qui ignore `Range` n'est lu en entier que si le fichier est petit.
//! Le résultat est gardé dans `DATA_DIR/transit-routes/` (quelques Ko par GTFS, plafonné
//! à 300 Mo, rafraîchi au plus une fois par jour, effaçable sans risque) et n'est demandé
//! que pour les réseaux qui ont effectivement des véhicules.
//!
//! Limite connue : si un flux ne donne pas la ligne (`route_id`) de ses véhicules, la
//! ligne et le mode restent inconnus (il faudrait lire `trips.txt`, bien plus gros).

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use prost::Message;
use reqwest::StatusCode;
use reqwest::header::RANGE;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::gtfs_rt::FeedMessage;
use crate::state::AppState;

const CATALOG_URL: &str = "https://transport.data.gouv.fr/api/datasets";
const POLL_EVERY: Duration = Duration::from_secs(30);
const CATALOG_EVERY: Duration = Duration::from_secs(6 * 3600);
const FEED_TIMEOUT: Duration = Duration::from_secs(12);
const PARALLEL: usize = 12;
const PER_HOST: usize = 3;
/// Un flux de positions pèse quelques dizaines de Ko ; au-delà, ce n'en est pas un.
const MAX_FEED_BYTES: usize = 8 << 20;
/// Une position plus vieille que cela (secondes) n'est plus affichée : le véhicule a disparu du flux ou est perdu.
const MAX_POSITION_AGE_S: i64 = 300;
/// Un horodatage dans le futur de plus que cela est faux (horloge du producteur déréglée) : on le ramène à maintenant.
const MAX_CLOCK_SKEW_S: i64 = 120;
/// Après ce nombre de tours sans véhicule, on ne relit plus le flux qu'un tour sur trois.
const IDLE_AFTER_TOURS: u32 = 4;

const ROUTES_REFRESH: Duration = Duration::from_secs(24 * 3600);
const CACHE_LIMIT_BYTES: u64 = 300 << 20;
/// Au plus ce nombre de GTFS statiques lus par réseau (certains jeux en proposent un par période ou un pour le transport à la demande).
const MAX_GTFS_PER_NETWORK: usize = 4;
/// Un serveur qui ignore `Range` n'est lu en entier que si le zip ne dépasse pas cette taille.
const MAX_FULL_DOWNLOAD: u64 = 15 << 20;
/// Fin de fichier lue d'abord : l'annuaire d'un zip tient presque toujours dedans.
const TAIL_BYTES: u64 = 64 << 10;
const MAX_ROUTES_BYTES: u64 = 20 << 20;

// ───────────────────────── Catalogue ─────────────────────────

/// Un réseau : un jeu de données du catalogue.
#[derive(Clone)]
struct Net {
    slug: String,
    name: String,
    licence: String,
    /// (identifiant de ressource, adresse) des GTFS statiques du jeu de données.
    gtfs: Vec<(String, String)>,
}

/// Un flux de positions et ce qu'on en sait d'un tour à l'autre.
struct Feed {
    net: usize,
    url: String,
    gate: Arc<Semaphore>,
    fails: u32,
    idle: u32,
    next_tour: u64,
    last: Vec<RawVehicle>,
    /// Heure de production du flux (secondes) et de sa réception.
    header_ts: Option<i64>,
    received_at: i64,
}

fn url_has_key(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else { return true };
    parsed.query_pairs().any(|(name, _)| {
        let name = name.to_ascii_lowercase();
        ["key", "token", "auth", "secret", "password"].iter().any(|word| name.contains(word))
    })
}

/// « Réseau urbain Astuce » → « Astuce » : le type de réseau n'apporte rien dans une fiche.
fn network_name(title: &str) -> String {
    const PREFIXES: [&str; 9] = [
        "Réseau urbain et périurbain ",
        "Réseau urbain et scolaire ",
        "Réseau urbain et interurbain ",
        "Réseau urbain et TAD zonal ",
        "Réseau interurbain et TAD zonal ",
        "Réseau interurbain ",
        "Réseau urbain ",
        "Réseau scolaire de ",
        "Réseau ",
    ];
    for prefix in PREFIXES {
        if let Some(rest) = title.strip_prefix(prefix) {
            // « Réseau urbain de la zone Centre (CACEM) » perdrait son sens : on garde le titre.
            return if rest.starts_with("de la ") || rest.is_empty() { title.to_string() } else { rest.to_string() };
        }
    }
    title.to_string()
}

fn is_excluded(title: &str) -> bool {
    let t = title.to_lowercase();
    ["sncf", "renfe", "agrégat", "agregat", "européen"].iter().any(|word| t.contains(word))
}

/// Ce que le catalogue donne : réseaux, flux de positions (indice du réseau, adresse) et titres des réseaux dont l'adresse publiée porte une clé.
struct Catalog {
    nets: Vec<Net>,
    feeds: Vec<(usize, String)>,
    with_key: Vec<String>,
}

/// Réseaux et flux de positions du catalogue.
fn parse_catalog(catalog: &Value) -> Result<Catalog> {
    let mut nets = Vec::new();
    let mut feeds: Vec<(usize, String)> = Vec::new();
    let mut with_key = Vec::new();
    let mut seen_urls = HashSet::new();
    for dataset in catalog.as_array().context("catalogue inattendu")? {
        let title = dataset["title"].as_str().unwrap_or_default();
        if dataset["type"] != "public-transit" || is_excluded(title) {
            continue;
        }
        let resources = dataset["resources"].as_array().map(Vec::as_slice).unwrap_or_default();
        let net_index = nets.len();
        let mut found = false;
        for resource in resources {
            let positions = resource["format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("gtfs-rt"))
                && resource["features"].as_array().is_some_and(|f| f.iter().any(|v| v == "vehicle_positions"))
                && resource["is_available"].as_bool().unwrap_or(false);
            if !positions {
                continue;
            }
            let Some(url) = resource["original_url"].as_str().or(resource["url"].as_str()) else { continue };
            // Une clé écrite dans l'adresse publiée par le catalogue national est donnée par le
            // producteur lui-même pour un usage public (TBM, Azalys) : on la garde, en le signalant.
            if url_has_key(url) {
                with_key.push(title.to_string());
            }
            if seen_urls.insert(url.to_string()) {
                feeds.push((net_index, url.to_string()));
                found = true;
            }
        }
        if !found {
            continue;
        }
        let gtfs = resources
            .iter()
            .filter(|r| r["format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("gtfs")) && r["is_available"].as_bool().unwrap_or(false))
            .filter_map(|r| Some((r["datagouv_id"].as_str()?.to_string(), r["url"].as_str()?.to_string())))
            .take(MAX_GTFS_PER_NETWORK)
            .collect();
        nets.push(Net {
            slug: dataset["slug"].as_str().unwrap_or(title).to_string(),
            name: network_name(title),
            licence: dataset["licence"].as_str().unwrap_or_default().to_string(),
            gtfs,
        });
    }
    Ok(Catalog { nets, feeds, with_key })
}

// ───────────────────────── Positions ─────────────────────────

#[derive(Clone, Debug, PartialEq)]
struct RawVehicle {
    id: String,
    route_id: Option<String>,
    lon: f64,
    lat: f64,
    bearing: Option<f64>,
    /// Mètres par seconde.
    speed: Option<f64>,
    ts: Option<i64>,
}

/// Boîtes (sud, ouest, nord, est) de la France métropolitaine et de l'outre-mer, assez larges pour les abords.
const FRANCE_BOXES: [(f64, f64, f64, f64); 8] = [
    (41.0, -5.8, 51.5, 10.0),       // métropole et Corse
    (14.0, -63.5, 18.3, -60.5),     // Guadeloupe, Martinique, Saint-Martin
    (1.8, -55.0, 6.0, -51.3),       // Guyane
    (-21.6, 54.9, -20.7, 56.0),     // La Réunion
    (-13.2, 44.9, -12.5, 45.4),     // Mayotte
    (46.6, -56.6, 47.2, -56.0),     // Saint-Pierre-et-Miquelon
    (-23.2, 163.4, -19.4, 168.3),   // Nouvelle-Calédonie
    (-27.8, -151.5, -8.0, -138.0),  // Polynésie française
];

fn in_france(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && FRANCE_BOXES.iter().any(|(s, w, n, e)| (*s..=*n).contains(&lat) && (*w..=*e).contains(&lon))
}

/// Décode un flux : l'heure de production et les véhicules positionnés.
fn decode_vehicles(bytes: &[u8]) -> Result<(Option<i64>, Vec<RawVehicle>)> {
    let feed = FeedMessage::decode(bytes).context("flux GTFS-RT illisible")?;
    let mut vehicles = Vec::new();
    for entity in feed.entity {
        if entity.is_deleted == Some(true) {
            continue;
        }
        let Some(vp) = entity.vehicle else { continue };
        let Some(position) = vp.position else { continue };
        let (lat, lon) = (f64::from(position.latitude), f64::from(position.longitude));
        // Hors de France (outre-mer compris) : position fausse (coordonnées à (0, 0), inversées ou mal saisies,
        // comme un véhicule d'Île-de-France en plein Atlantique que le catalogue a présenté un jour).
        if !in_france(lat, lon) {
            continue;
        }
        let descriptor = vp.vehicle;
        let non_empty = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let id = descriptor
            .as_ref()
            .and_then(|d| non_empty(d.id.clone()))
            .or_else(|| descriptor.as_ref().and_then(|d| non_empty(d.label.clone())))
            .unwrap_or_else(|| entity.id.clone());
        vehicles.push(RawVehicle {
            id,
            route_id: vp.trip.and_then(|t| non_empty(t.route_id)),
            lon,
            lat,
            bearing: position.bearing.map(f64::from).filter(|b| (0.0..=360.0).contains(b)),
            speed: position.speed.map(f64::from).filter(|s| (0.0..=45.0).contains(s)),
            // Certains producteurs écrivent 0 pour « non renseigné ».
            ts: vp.timestamp.filter(|t| *t > 0).map(|t| t as i64),
        });
    }
    Ok((feed.header.timestamp.filter(|t| *t > 0).map(|t| t as i64), vehicles))
}

async fn fetch_feed(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let mut response = http.get(url).timeout(FEED_TIMEOUT).send().await?;
    let status = response.status();
    if !status.is_success() {
        bail!("réponse {status}");
    }
    if response.content_length().is_some_and(|n| n as usize > MAX_FEED_BYTES) {
        bail!("flux trop gros");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_FEED_BYTES {
            bail!("flux trop gros");
        }
    }
    // Certains serveurs compressent sans que le client l'ait demandé.
    if body.starts_with(&[0x1f, 0x8b]) {
        let mut plain = Vec::new();
        flate2::read::GzDecoder::new(body.as_slice()).take(MAX_FEED_BYTES as u64).read_to_end(&mut plain)?;
        return Ok(plain);
    }
    Ok(body)
}

fn auth_required(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}");
    text.contains("401") || text.contains("403")
}

// ───────────────────────── Lignes (GTFS statique) ─────────────────────────

#[derive(Clone, Debug, PartialEq)]
struct RouteInfo {
    short: Option<String>,
    long: Option<String>,
    color: Option<String>,
    mode: Option<&'static str>,
}

/// Mode d'après le `route_type` du GTFS, y compris les types étendus (centaines) de Google.
fn route_mode(route_type: u32) -> Option<&'static str> {
    match route_type {
        0 | 5 | 900..=999 => Some("tram"),
        1 | 12 | 400..=499 => Some("metro"),
        2 | 100..=199 => Some("train"),
        3 | 11 | 200..=299 | 700..=899 => Some("bus"),
        4 | 1000..=1299 => Some("ferry"),
        6 | 7 | 1300..=1499 => Some("cable"),
        _ => None,
    }
}

/// Découpe une ligne CSV (guillemets et guillemets doublés compris).
fn csv_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                current.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut current)),
            _ => current.push(c),
        }
    }
    fields.push(current);
    fields
}

/// Lit un `routes.txt` : seules les colonnes utiles sont gardées.
fn parse_routes(text: &str) -> HashMap<String, RouteInfo> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    let Some(header) = lines.next() else { return HashMap::new() };
    let columns: Vec<String> = csv_fields(header).into_iter().map(|c| c.trim().to_string()).collect();
    let column = |name: &str| columns.iter().position(|c| c == name);
    let (Some(id_col), short_col, long_col, type_col, color_col) =
        (column("route_id"), column("route_short_name"), column("route_long_name"), column("route_type"), column("route_color"))
    else {
        return HashMap::new();
    };
    let mut routes = HashMap::new();
    for line in lines.filter(|l| !l.trim().is_empty()) {
        let fields = csv_fields(line);
        let get = |col: Option<usize>| col.and_then(|i| fields.get(i)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        let Some(id) = get(Some(id_col)) else { continue };
        // Une couleur GTFS est six chiffres hexadécimaux, sans dièse : le reste est une erreur de saisie.
        let color = get(color_col).map(|c| c.trim_start_matches('#').to_ascii_lowercase()).filter(|c| c.len() == 6 && c.chars().all(|ch| ch.is_ascii_hexdigit()));
        routes.insert(
            id,
            RouteInfo {
                short: get(short_col),
                long: get(long_col),
                color,
                mode: get(type_col).and_then(|t| t.parse().ok()).and_then(route_mode),
            },
        );
    }
    routes
}

// Lecture d'un seul fichier dans un zip, sans le télécharger en entier.

#[derive(Debug)]
struct ZipEntry {
    method: u16,
    compressed_size: u64,
    local_offset: u64,
}

fn le16(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?)))
}

fn le32(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?)))
}

/// Où est l'annuaire central du zip : (position, taille), d'après la fin du fichier.
fn central_directory(tail: &[u8]) -> Result<(u64, u64)> {
    let at = tail.windows(4).rposition(|w| w == b"PK\x05\x06").context("fin de zip introuvable")?;
    let size = le32(tail, at + 12).context("zip tronqué")?;
    let offset = le32(tail, at + 16).context("zip tronqué")?;
    if offset == 0xFFFF_FFFF || size == 0xFFFF_FFFF {
        bail!("zip64 non géré");
    }
    Ok((offset, size))
}

/// Cherche `routes.txt` (à la racine ou dans un dossier) dans l'annuaire central.
fn find_routes_entry(directory: &[u8]) -> Result<ZipEntry> {
    let mut at = 0;
    while directory.get(at..at + 4) == Some(b"PK\x01\x02") {
        let name_len = le16(directory, at + 28).context("annuaire tronqué")? as usize;
        let extra_len = le16(directory, at + 30).context("annuaire tronqué")? as usize;
        let comment_len = le16(directory, at + 32).context("annuaire tronqué")? as usize;
        let name = directory.get(at + 46..at + 46 + name_len).context("annuaire tronqué")?;
        if name.rsplit(|b| *b == b'/').next() == Some(b"routes.txt") {
            let uncompressed = le32(directory, at + 24).context("annuaire tronqué")?;
            let mut compressed_size = le32(directory, at + 20).context("annuaire tronqué")?;
            let mut local_offset = le32(directory, at + 42).context("annuaire tronqué")?;
            // Zip64 : une valeur à 0xFFFFFFFF est donnée en 64 bits dans le champ annexe 0x0001, dans l'ordre
            // taille d'origine, taille compressée, position (seules les valeurs saturées y figurent).
            let extra = directory.get(at + 46 + name_len..at + 46 + name_len + extra_len).context("annuaire tronqué")?;
            let mut field = 0;
            while field + 4 <= extra.len() {
                let (id, size) = (le16(extra, field).unwrap_or(0), le16(extra, field + 2).unwrap_or(0) as usize);
                if id == 1 {
                    let mut next = field + 4;
                    let mut take = |saturated: bool, value: &mut u64| -> Result<()> {
                        if saturated {
                            let bytes: [u8; 8] = extra.get(next..next + 8).context("champ zip64 tronqué")?.try_into()?;
                            *value = u64::from_le_bytes(bytes);
                            next += 8;
                        }
                        Ok(())
                    };
                    take(uncompressed == 0xFFFF_FFFF, &mut 0)?;
                    take(compressed_size == 0xFFFF_FFFF, &mut compressed_size)?;
                    take(local_offset == 0xFFFF_FFFF, &mut local_offset)?;
                }
                field += 4 + size;
            }
            return Ok(ZipEntry { method: le16(directory, at + 10).context("annuaire tronqué")? as u16, compressed_size, local_offset });
        }
        at += 46 + name_len + extra_len + comment_len;
    }
    bail!("pas de routes.txt dans le zip")
}

/// Contenu d'un fichier à partir de l'en-tête local et de ses données (`local` commence à l'en-tête).
fn extract_entry(local: &[u8], entry: &ZipEntry) -> Result<Vec<u8>> {
    if local.get(..4) != Some(b"PK\x03\x04") {
        bail!("en-tête de fichier invalide");
    }
    let start = 30 + le16(local, 26).context("en-tête tronqué")? as usize + le16(local, 28).context("en-tête tronqué")? as usize;
    let data = local.get(start..start + entry.compressed_size as usize).context("données tronquées")?;
    let mut out = Vec::new();
    match entry.method {
        0 => out.extend_from_slice(data),
        8 => {
            flate2::read::DeflateDecoder::new(data).take(MAX_ROUTES_BYTES).read_to_end(&mut out).context("routes.txt illisible")?;
        }
        other => bail!("compression {other} non gérée"),
    }
    Ok(out)
}

/// Extrait `routes.txt` d'un zip entièrement en mémoire.
fn routes_from_whole_zip(zip: &[u8]) -> Result<Vec<u8>> {
    let (offset, size) = central_directory(zip)?;
    let directory = zip.get(offset as usize..(offset + size) as usize).context("annuaire hors du fichier")?;
    let entry = find_routes_entry(directory)?;
    extract_entry(zip.get(entry.local_offset as usize..).context("fichier hors du zip")?, &entry)
}

async fn get_range(http: &reqwest::Client, url: &str, range: String) -> Result<Vec<u8>> {
    let response = http.get(url).header(RANGE, range).timeout(Duration::from_secs(30)).send().await?;
    if response.status() != StatusCode::PARTIAL_CONTENT {
        bail!("le serveur ignore Range ({})", response.status());
    }
    Ok(response.bytes().await?.to_vec())
}

/// `routes.txt` d'un GTFS en ligne : par `Range` si le serveur le permet, sinon en entier si le fichier est petit.
async fn fetch_routes_txt(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let mut response = http.get(url).header(RANGE, format!("bytes=-{TAIL_BYTES}")).timeout(Duration::from_secs(30)).send().await?;
    let status = response.status();
    if status == StatusCode::PARTIAL_CONTENT {
        // « Content-Range: bytes 1000-1999/2000 » : la taille totale est après la barre.
        let total: u64 = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit('/').next())
            .and_then(|n| n.parse().ok())
            .context("Content-Range illisible")?;
        let tail = response.bytes().await?;
        let tail_start = total.saturating_sub(tail.len() as u64);
        let (offset, size) = central_directory(&tail)?;
        let directory = if offset >= tail_start {
            tail.get((offset - tail_start) as usize..(offset - tail_start + size) as usize).context("annuaire tronqué")?.to_vec()
        } else {
            get_range(http, url, format!("bytes={offset}-{}", offset + size - 1)).await?
        };
        let entry = find_routes_entry(&directory)?;
        // L'en-tête local ajoute au plus quelques centaines d'octets (nom et champs annexes) avant les données.
        let end = (entry.local_offset + 30 + 2048 + entry.compressed_size).min(total) - 1;
        let local = get_range(http, url, format!("bytes={}-{end}", entry.local_offset)).await?;
        return extract_entry(&local, &entry);
    }
    if !status.is_success() {
        bail!("réponse {status}");
    }
    // Le serveur a ignoré Range et envoie le fichier entier : on ne le lit que s'il est petit.
    if response.content_length().is_none_or(|n| n > MAX_FULL_DOWNLOAD) {
        bail!("zip trop gros pour un serveur sans Range");
    }
    let mut zip = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        zip.extend_from_slice(&chunk);
        if zip.len() as u64 > MAX_FULL_DOWNLOAD {
            bail!("zip trop gros");
        }
    }
    routes_from_whole_zip(&zip)
}

// Cache disque de `routes.txt`.

fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("transit-routes")
}

fn cache_path(data_dir: &Path, resource_id: &str) -> PathBuf {
    let safe: String = resource_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    cache_dir(data_dir).join(format!("{safe}.txt"))
}

/// Garde le cache sous son plafond en effaçant les plus anciens fichiers.
fn prune_cache(dir: &Path, limit: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort();
    for (_, size, path) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
}

/// Lignes d'un réseau : du cache s'il a moins d'un jour, sinon du GTFS en ligne (le cache périmé sert de secours).
async fn load_routes(http: &reqwest::Client, data_dir: &Path, net: &Net) -> HashMap<String, RouteInfo> {
    let mut all = HashMap::new();
    for (resource_id, url) in &net.gtfs {
        let path = cache_path(data_dir, resource_id);
        let fresh = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age < ROUTES_REFRESH);
        let text = if fresh {
            std::fs::read(&path).ok()
        } else {
            match fetch_routes_txt(http, url).await {
                Ok(bytes) => {
                    let dir = cache_dir(data_dir);
                    if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&path, &bytes).is_ok() {
                        prune_cache(&dir, CACHE_LIMIT_BYTES);
                    }
                    Some(bytes)
                }
                Err(error) => {
                    warn!("transports : lignes de {} indisponibles : {error:#}", net.name);
                    std::fs::read(&path).ok()
                }
            }
        };
        if let Some(bytes) = text {
            for (id, route) in parse_routes(&String::from_utf8_lossy(&bytes)) {
                all.entry(id).or_insert(route);
            }
        }
    }
    all
}

// ───────────────────────── Réponse de l'API ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkOut<'a> {
    name: &'a str,
    licence: &'a str,
    vehicles: usize,
}

/// Une ligne (ou « ligne inconnue » d'un réseau) : les véhicules y renvoient par son indice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LineOut {
    network: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    /// Nom court (« A », « 12 »).
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// Intitulé complet (« Gares - CHU La Cavale »).
    #[serde(skip_serializing_if = "Option::is_none")]
    long_name: Option<String>,
    /// Couleur officielle, six chiffres hexadécimaux sans dièse.
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    /// `bus`, `tram`, `metro`, `train`, `ferry` ou `cable` ; absent si inconnu.
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<&'static str>,
}

#[derive(Serialize)]
struct VehicleOut {
    id: String,
    line: usize,
    lon: f64,
    lat: f64,
    /// Cap en degrés depuis le nord.
    #[serde(skip_serializing_if = "Option::is_none")]
    heading: Option<u16>,
    /// Vitesse en km/h.
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<u16>,
    /// Instant de la position (secondes UTC).
    ts: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TransitOut<'a> {
    updated_at: i64,
    networks: Vec<NetworkOut<'a>>,
    lines: Vec<LineOut>,
    vehicles: Vec<VehicleOut>,
}

type RouteTables = HashMap<String, Arc<HashMap<String, RouteInfo>>>;

fn round5(x: f64) -> f64 {
    (x * 1e5).round() / 1e5
}

/// Assemble la réponse : positions récentes de tous les flux, dédoublonnées par réseau et véhicule.
fn assemble(nets: &[Net], feeds: &[Feed], tables: &RouteTables, now: i64) -> Result<(Vec<u8>, usize, usize)> {
    // (réseau, identifiant de véhicule) → (position, âge) : en cas de doublon entre deux flux d'un même réseau, le plus frais gagne.
    let mut best: HashMap<(usize, &str), (&RawVehicle, i64)> = HashMap::new();
    for feed in feeds {
        for vehicle in &feed.last {
            let ts = vehicle.ts.or(feed.header_ts).unwrap_or(feed.received_at).min(now + MAX_CLOCK_SKEW_S);
            let ts = if ts > now { now } else { ts };
            if now - ts > MAX_POSITION_AGE_S {
                continue;
            }
            match best.get(&(feed.net, vehicle.id.as_str())) {
                Some((_, known)) if *known >= ts => {}
                _ => {
                    best.insert((feed.net, vehicle.id.as_str()), (vehicle, ts));
                }
            }
        }
    }
    let mut chosen: Vec<_> = best.into_iter().collect();
    chosen.sort_unstable_by(|a, b| a.0.cmp(&b.0)); // réponse stable d'un tour à l'autre

    let mut line_index: HashMap<(usize, Option<&str>), usize> = HashMap::new();
    let mut lines: Vec<LineOut> = Vec::new();
    let mut counts = vec![0usize; nets.len()];
    let mut vehicles = Vec::with_capacity(chosen.len());
    for ((net, _), (vehicle, ts)) in chosen {
        counts[net] += 1;
        let key = (net, vehicle.route_id.as_deref());
        let line = *line_index.entry(key).or_insert_with(|| {
            let info = vehicle.route_id.as_ref().and_then(|id| tables.get(&nets[net].slug)?.get(id));
            lines.push(LineOut {
                network: net,
                id: vehicle.route_id.clone(),
                name: info.and_then(|r| r.short.clone()),
                long_name: info.and_then(|r| r.long.clone()),
                color: info.and_then(|r| r.color.clone()),
                mode: info.and_then(|r| r.mode),
            });
            lines.len() - 1
        });
        vehicles.push(VehicleOut {
            id: vehicle.id.clone(),
            line,
            lon: round5(vehicle.lon),
            lat: round5(vehicle.lat),
            heading: vehicle.bearing.map(|b| (b.round() as u16) % 360),
            speed: vehicle.speed.map(|s| (s * 3.6).round() as u16),
            ts,
        });
    }
    let used: Vec<usize> = (0..nets.len()).filter(|n| counts[*n] > 0).collect();
    // Les réseaux sans véhicule ne sont pas envoyés : on renumérote.
    let renumber: HashMap<usize, usize> = used.iter().enumerate().map(|(new, old)| (*old, new)).collect();
    for line in &mut lines {
        line.network = renumber[&line.network];
    }
    let networks = used.iter().map(|n| NetworkOut { name: &nets[*n].name, licence: &nets[*n].licence, vehicles: counts[*n] }).collect();
    let (count, network_count) = (vehicles.len(), used.len());
    let body = serde_json::to_vec(&TransitOut { updated_at: now, networks, lines, vehicles })?;
    Ok((body, count, network_count))
}

// ───────────────────────── Boucle de collecte ─────────────────────────

/// Charge le catalogue, relit les positions toutes les 30 secondes et prépare la réponse.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf, state: AppState) {
    let tables: Arc<Mutex<RouteTables>> = Arc::default();
    let attempted: Arc<Mutex<HashMap<String, Instant>>> = Arc::default();
    let loading = Arc::new(AtomicBool::new(false));
    let global_gate = Arc::new(Semaphore::new(PARALLEL));

    let mut nets: Vec<Net> = Vec::new();
    let mut feeds: Vec<Feed> = Vec::new();
    let mut catalog_at: Option<Instant> = None;
    let mut tour: u64 = 0;
    let mut ticker = tokio::time::interval(POLL_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        ticker.tick().await;
        if catalog_at.is_none_or(|at| at.elapsed() > CATALOG_EVERY) {
            match load_catalog(&http).await {
                Ok(Catalog { nets: new_nets, feeds: new_feeds, with_key }) if !new_feeds.is_empty() => {
                    info!(reseaux = new_nets.len(), flux = new_feeds.len(), "transports : catalogue chargé");
                    if !with_key.is_empty() {
                        info!("transports : flux avec une clé publique du producteur : {}", with_key.join(", "));
                    }
                    // On garde l'état des flux déjà connus : un nouveau catalogue ne doit pas faire tout oublier.
                    let mut old: HashMap<String, Feed> = feeds.drain(..).map(|f| (f.url.clone(), f)).collect();
                    let mut gates: HashMap<String, Arc<Semaphore>> = HashMap::new();
                    feeds = new_feeds
                        .into_iter()
                        .map(|(net, url)| {
                            let host = reqwest::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
                            let gate = gates.entry(host).or_insert_with(|| Arc::new(Semaphore::new(PER_HOST))).clone();
                            match old.remove(&url) {
                                Some(mut known) => {
                                    known.net = net;
                                    known.gate = gate;
                                    known
                                }
                                None => Feed { net, url, gate, fails: 0, idle: 0, next_tour: 0, last: Vec::new(), header_ts: None, received_at: 0 },
                            }
                        })
                        .collect();
                    nets = new_nets;
                    catalog_at = Some(Instant::now());
                }
                Ok(_) => warn!("transports : aucun flux de positions dans le catalogue"),
                Err(error) => warn!("transports : catalogue indisponible : {error:#}"),
            }
        }
        if feeds.is_empty() {
            continue;
        }

        tour += 1;
        let ok = run_tour(&http, &mut feeds, &global_gate, tour).await;
        if ok == 0 {
            warn!("transports : aucun flux n'a répondu à ce tour");
            continue;
        }
        let now = Timestamp::now().as_second();
        let snapshot = tables.lock().expect("verrou des lignes").clone();
        match assemble(&nets, &feeds, &snapshot, now) {
            Ok((body, vehicles, networks)) => {
                info!(vehicules = vehicles, reseaux = networks, flux_ok = ok, flux = feeds.len(), "transports : positions mises à jour");
                state.set_transit(body);
            }
            Err(error) => warn!("transports : réponse non préparée : {error:#}"),
        }

        // Les lignes ne sont demandées qu'aux réseaux qui ont des véhicules, et au plus une fois par jour.
        if !loading.load(Ordering::Relaxed) {
            let active: HashSet<usize> = feeds.iter().filter(|f| !f.last.is_empty()).map(|f| f.net).collect();
            let due: Vec<Net> = {
                let attempted = attempted.lock().expect("verrou des essais");
                active
                    .into_iter()
                    .map(|n| &nets[n])
                    .filter(|n| !n.gtfs.is_empty() && attempted.get(&n.slug).is_none_or(|at| at.elapsed() > ROUTES_REFRESH))
                    .cloned()
                    .collect()
            };
            if !due.is_empty() {
                loading.store(true, Ordering::Relaxed);
                let (http, data_dir, tables, attempted, loading) = (http.clone(), data_dir.clone(), tables.clone(), attempted.clone(), loading.clone());
                tokio::spawn(async move {
                    for net in due {
                        attempted.lock().expect("verrou des essais").insert(net.slug.clone(), Instant::now());
                        let routes = load_routes(&http, &data_dir, &net).await;
                        info!(reseau = %net.name, lignes = routes.len(), "transports : lignes chargées");
                        if !routes.is_empty() {
                            tables.lock().expect("verrou des lignes").insert(net.slug.clone(), Arc::new(routes));
                        }
                    }
                    loading.store(false, Ordering::Relaxed);
                });
            }
        }
    }
}

async fn load_catalog(http: &reqwest::Client) -> Result<Catalog> {
    let response = http.get(CATALOG_URL).timeout(Duration::from_secs(60)).send().await?.error_for_status()?;
    let catalog: Value = serde_json::from_slice(&response.bytes().await?)?;
    parse_catalog(&catalog)
}

/// Un tour : relit les flux dus, en parallèle borné. Renvoie le nombre de flux qui ont répondu.
async fn run_tour(http: &reqwest::Client, feeds: &mut [Feed], gate: &Arc<Semaphore>, tour: u64) -> usize {
    let mut tasks = JoinSet::new();
    for (index, feed) in feeds.iter().enumerate() {
        if feed.next_tour > tour {
            continue;
        }
        let (http, url, host_gate, gate) = (http.clone(), feed.url.clone(), feed.gate.clone(), gate.clone());
        tasks.spawn(async move {
            // Les jetons sont pris dans cet ordre partout : pas d'interblocage.
            let _global = gate.acquire_owned().await;
            let _host = host_gate.acquire_owned().await;
            let result = match fetch_feed(&http, &url).await {
                Ok(bytes) => decode_vehicles(&bytes),
                Err(error) => Err(error),
            };
            (index, result)
        });
    }
    let (mut ok, received_at) = (0, Timestamp::now().as_second());
    while let Some(joined) = tasks.join_next().await {
        let Ok((index, result)) = joined else { continue };
        let feed = &mut feeds[index];
        match result {
            Ok((header_ts, vehicles)) => {
                ok += 1;
                feed.fails = 0;
                feed.idle = if vehicles.is_empty() { feed.idle + 1 } else { 0 };
                feed.next_tour = tour + if feed.idle >= IDLE_AFTER_TOURS { 3 } else { 1 };
                (feed.last, feed.header_ts, feed.received_at) = (vehicles, header_ts, received_at);
            }
            Err(error) => {
                feed.fails += 1;
                // Réessais espacés : 1, 2, 4… tours, jusqu'à 20 (10 minutes) ; une clé exigée n'est redemandée que tous les 120 tours (1 h).
                let wait = if auth_required(&error) { 120 } else { (1u64 << feed.fails.min(5)).min(20) };
                feed.next_tour = tour + wait;
                if feed.fails == 1 {
                    warn!("transports : flux en erreur ({}) : {error:#}", reqwest::Url::parse(&feed.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default());
                }
            }
        }
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extrait réel du flux Bibus (Brest) du 10 novembre 2026, tel que le sert le proxy du PAN :
    /// l'en-tête et deux véhicules. L'horodatage de chaque position est 0 (« non renseigné »).
    const BIBUS: &str = "0a0d0a03322e30100018ade5c9d70612440a1176656869636c653a323638343336353130222f0a0d0a0831383037343239312a0141120f0d388141421572b891c01d000076432800420b0a0932363834333635313012440a1176656869636c653a323638343335383634222f0a0d0a0831383131353435352a0144120f0d97aa414215dd958fc01d0000b1432800420b0a09323638343335383634";

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn decode_un_extrait_reel() {
        let (header, vehicles) = decode_vehicles(&unhex(BIBUS)).unwrap();
        assert_eq!(header, Some(1_794_273_965), "heure de production du flux");
        assert_eq!(vehicles.len(), 2);
        let first = &vehicles[0];
        assert_eq!(first.id, "268436510");
        assert_eq!(first.route_id.as_deref(), Some("A"));
        assert!((first.lat - 48.376).abs() < 0.01 && (first.lon + 4.554).abs() < 0.01, "{first:?}");
        assert_eq!(first.bearing, Some(246.0));
        assert_eq!(first.speed, None);
        assert_eq!(first.ts, None, "une position horodatée 0 n'a pas d'heure");
        assert_eq!(vehicles[1].route_id.as_deref(), Some("D"));
    }

    #[test]
    fn ecarte_les_positions_absentes_ou_nulles() {
        use crate::gtfs_rt::{FeedEntity, FeedHeader, Position, VehiclePosition};
        assert!(in_france(48.4, -4.5) && in_france(-21.1, 55.3) && !in_france(0.0, 0.0) && !in_france(-5.98, -1.36));
        let entity = |id: &str, lat: f32, lon: f32| FeedEntity {
            id: id.into(),
            is_deleted: None,
            trip_update: None,
            vehicle: Some(VehiclePosition { trip: None, position: Some(Position { latitude: lat, longitude: lon, bearing: Some(400.0), speed: Some(-1.0) }), vehicle: None, timestamp: Some(1_794_276_000) }),
        };
        let feed = FeedMessage {
            header: FeedHeader { gtfs_realtime_version: "2.0".into(), timestamp: None },
            entity: vec![entity("zero", 0.0, 0.0), entity("bon", 45.0, 4.8), FeedEntity { id: "sans".into(), is_deleted: None, trip_update: None, vehicle: None }],
        };
        let (_, vehicles) = decode_vehicles(&feed.encode_to_vec()).unwrap();
        assert_eq!(vehicles.len(), 1);
        assert_eq!(vehicles[0].id, "bon", "identifiant repris de l'entité faute de descripteur");
        assert_eq!((vehicles[0].bearing, vehicles[0].speed), (None, None), "cap et vitesse absurdes écartés");
        assert_eq!(vehicles[0].ts, Some(1_794_276_000));
    }

    /// Début du `routes.txt` du GTFS Bibus (Brest, 9 novembre 2026) : un tramway, un téléphérique, un bus.
    const ROUTES: &str = "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_color,route_text_color,route_sort_order\nA,1,A,\"Porte de PLOUZANÉ - Portes de GOUESNOU / GUIPAVAS\",,0,de007e,ffffff,1\nC,1,C,\"Jean Moulin - Ateliers\",,6,ea6758,ffffff,5\nD,1,D,\"Gares - Lambézellec\",,3,007738,ffffff,6\n02,1,2,\"BREST Port de Commerce - BREST Fort Montbarey / PLOUZANÉ Technopôle\",,3,ffe400,000000,20\n";

    #[test]
    fn lit_les_lignes_et_leur_mode() {
        let routes = parse_routes(ROUTES);
        assert_eq!(routes.len(), 4);
        let a = &routes["A"];
        assert_eq!((a.mode, a.color.as_deref(), a.short.as_deref()), (Some("tram"), Some("de007e"), Some("A")));
        assert_eq!(routes["C"].mode, Some("cable"));
        assert_eq!(routes["02"].mode, Some("bus"));
        assert!(routes["02"].long.as_deref().unwrap().contains("Technopôle"));
    }

    #[test]
    fn csv_avec_guillemets_et_couleur_invalide() {
        assert_eq!(csv_fields("a,\"b, c\",\"d \"\"e\"\"\""), vec!["a", "b, c", "d \"e\""]);
        let routes = parse_routes("\u{feff}route_id,route_short_name,route_type,route_color\n1,T1,900,zzz\n");
        assert_eq!((routes["1"].mode, routes["1"].color.clone()), (Some("tram"), None), "type étendu 900 = tram, couleur invalide ignorée");
    }

    #[test]
    fn modes_des_types_etendus() {
        assert_eq!(route_mode(1), Some("metro"));
        assert_eq!(route_mode(702), Some("bus"));
        assert_eq!(route_mode(11), Some("bus"));
        assert_eq!(route_mode(1200), Some("ferry"));
        assert_eq!(route_mode(2), Some("train"));
        assert_eq!(route_mode(9999), None);
    }

    /// Un zip minimal (un fichier stocké, `routes.txt` compressé) construit à la main.
    fn build_zip(routes: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut deflater = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
        deflater.write_all(routes).unwrap();
        let packed = deflater.finish().unwrap();
        let files: [(&str, Vec<u8>, u16); 2] = [("stops.txt", b"stop_id\n1\n".to_vec(), 0), ("gtfs/routes.txt", packed, 8)];
        let (mut zip, mut directory) = (Vec::new(), Vec::new());
        for (name, data, method) in &files {
            let offset = zip.len() as u32;
            zip.extend_from_slice(b"PK\x03\x04");
            zip.extend_from_slice(&[20, 0, 0, 0]);
            zip.extend_from_slice(&method.to_le_bytes());
            zip.extend_from_slice(&[0; 8]); // heure, date, CRC (non lus)
            zip.extend_from_slice(&(data.len() as u32).to_le_bytes());
            zip.extend_from_slice(&(data.len() as u32).to_le_bytes());
            zip.extend_from_slice(&(name.len() as u16).to_le_bytes());
            zip.extend_from_slice(&[0, 0]);
            zip.extend_from_slice(name.as_bytes());
            zip.extend_from_slice(data);
            directory.extend_from_slice(b"PK\x01\x02");
            directory.extend_from_slice(&[20, 0, 20, 0, 0, 0]);
            directory.extend_from_slice(&method.to_le_bytes());
            directory.extend_from_slice(&[0; 8]);
            directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(data.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
            directory.extend_from_slice(&[0; 12]);
            directory.extend_from_slice(&offset.to_le_bytes());
            directory.extend_from_slice(name.as_bytes());
        }
        let directory_offset = zip.len() as u32;
        zip.extend_from_slice(&directory);
        zip.extend_from_slice(b"PK\x05\x06\0\0\0\0");
        zip.extend_from_slice(&2u16.to_le_bytes());
        zip.extend_from_slice(&2u16.to_le_bytes());
        zip.extend_from_slice(&(directory.len() as u32).to_le_bytes());
        zip.extend_from_slice(&directory_offset.to_le_bytes());
        zip.extend_from_slice(&[0, 0]);
        zip
    }

    #[test]
    fn extrait_routes_txt_d_un_zip() {
        let zip = build_zip(ROUTES.as_bytes());
        assert_eq!(routes_from_whole_zip(&zip).unwrap(), ROUTES.as_bytes());
        // Même chemin que la lecture par Range : annuaire repéré depuis la fin, puis données locales.
        let (offset, size) = central_directory(&zip[zip.len() - 100..]).unwrap();
        let entry = find_routes_entry(&zip[offset as usize..(offset + size) as usize]).unwrap();
        assert_eq!(entry.method, 8);
        assert_eq!(extract_entry(&zip[entry.local_offset as usize..], &entry).unwrap(), ROUTES.as_bytes());
        assert!(routes_from_whole_zip(b"pas un zip").is_err());
    }

    /// Cas réel (GTFS Irigo, Angers) : tailles et position à 0xFFFFFFFF dans l'annuaire, la vraie valeur est dans le champ zip64.
    #[test]
    fn lit_les_tailles_zip64() {
        let name = b"routes.txt";
        let mut d = b"PK\x01\x02".to_vec();
        d.extend_from_slice(&[45, 0, 45, 0, 0, 0, 8, 0]); // versions, drapeaux, méthode
        d.extend_from_slice(&[0; 8]); // heure, date, CRC
        d.extend_from_slice(&u32::MAX.to_le_bytes()); // taille compressée
        d.extend_from_slice(&u32::MAX.to_le_bytes()); // taille d'origine
        d.extend_from_slice(&(name.len() as u16).to_le_bytes());
        d.extend_from_slice(&28u16.to_le_bytes()); // longueur du champ annexe
        d.extend_from_slice(&[0; 10]); // commentaire, disque, attributs
        d.extend_from_slice(&u32::MAX.to_le_bytes()); // position
        d.extend_from_slice(name);
        d.extend_from_slice(&[1, 0, 24, 0]);
        for value in [6714u64, 2071, 37025] {
            d.extend_from_slice(&value.to_le_bytes());
        }
        let entry = find_routes_entry(&d).unwrap();
        assert_eq!((entry.method, entry.compressed_size, entry.local_offset), (8, 2071, 37025));
    }

    #[test]
    fn catalogue_ecarte_sncf_et_indisponibles_garde_les_cles_publiques() {
        let rt = |url: &str, available: bool| serde_json::json!({"format":"gtfs-rt","features":["vehicle_positions"],"is_available":available,"original_url":url,"url":"https://www.data.gouv.fr/x"});
        let dataset = |title: &str, resources: Vec<Value>| serde_json::json!({"type":"public-transit","title":title,"slug":title,"licence":"lov2","resources":resources});
        let catalog = serde_json::json!([
            dataset("Réseau urbain Astuce", vec![rt("https://a.example/vp", true), rt("https://a.example/vp", true), serde_json::json!({"format":"GTFS","is_available":true,"datagouv_id":"g1","url":"https://www.data.gouv.fr/g1"})]),
            dataset("Réseau urbain TBM", vec![rt("https://b.example/vp?apiKey=secret", true)]),
            dataset("Horaires SNCF", vec![rt("https://c.example/vp", true)]),
            dataset("Réseau urbain Hors service", vec![rt("https://d.example/vp", false)]),
            dataset("Agrégat des réseaux", vec![rt("https://e.example/vp", true)]),
        ]);
        let Catalog { nets, feeds, with_key } = parse_catalog(&catalog).unwrap();
        assert_eq!(nets.len(), 2);
        assert_eq!((nets[0].name.as_str(), nets[0].gtfs.len()), ("Astuce", 1));
        assert_eq!(
            feeds,
            vec![(0, "https://a.example/vp".to_string()), (1, "https://b.example/vp?apiKey=secret".to_string())],
            "doublon d'adresse écarté, clé publique gardée"
        );
        assert_eq!(with_key, vec!["Réseau urbain TBM"]);
        assert_eq!(network_name("Réseau urbain de la zone Centre (CACEM)"), "Réseau urbain de la zone Centre (CACEM)");
        assert_eq!(network_name("Réseau urbain et scolaire TBM"), "TBM");
    }

    #[test]
    fn assemble_dedoublonne_et_ecarte_les_vieilles_positions() {
        let net = Net { slug: "brest".into(), name: "Bibus".into(), licence: "lov2".into(), gtfs: vec![] };
        let vehicle = |id: &str, route: Option<&str>, ts: Option<i64>| RawVehicle { id: id.into(), route_id: route.map(Into::into), lon: -4.5712345, lat: 48.3769876, bearing: Some(246.0), speed: Some(10.0), ts };
        let feed = |vehicles: Vec<RawVehicle>| Feed { net: 0, url: String::new(), gate: Arc::new(Semaphore::new(1)), fails: 0, idle: 0, next_tour: 0, last: vehicles, header_ts: Some(1000), received_at: 1000 };
        let feeds = [
            feed(vec![vehicle("1", Some("A"), Some(990)), vehicle("2", Some("A"), Some(100)), vehicle("3", None, None)]),
            feed(vec![vehicle("1", Some("A"), Some(995))]),
        ];
        let mut tables = RouteTables::new();
        tables.insert("brest".into(), Arc::new(parse_routes(ROUTES)));
        let (body, count, networks) = assemble(&[net], &feeds, &tables, 1000).unwrap();
        assert_eq!((count, networks), (2, 1), "le véhicule 2 a plus de 5 minutes, le 1 est en double");
        let json: Value = serde_json::from_slice(&body).unwrap();
        let first = &json["vehicles"][0];
        assert_eq!((first["id"].as_str(), first["ts"].as_i64(), first["speed"].as_i64(), first["heading"].as_i64()), (Some("1"), Some(995), Some(36), Some(246)));
        assert_eq!(first["lon"].as_f64(), Some(-4.57123));
        let line = &json["lines"][first["line"].as_u64().unwrap() as usize];
        assert_eq!((line["mode"].as_str(), line["color"].as_str(), line["name"].as_str()), (Some("tram"), Some("de007e"), Some("A")));
        let unknown = &json["lines"][json["vehicles"][1]["line"].as_u64().unwrap() as usize];
        assert!(unknown.get("mode").is_none() && unknown.get("id").is_none(), "ligne inconnue : ni mode ni identifiant");
    }

    #[test]
    fn le_cache_reste_sous_son_plafond() {
        let dir = std::env::temp_dir().join(format!("transit-cache-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["a", "b", "c"] {
            std::fs::write(dir.join(name), vec![0u8; 100]).unwrap();
            std::thread::sleep(Duration::from_millis(20));
        }
        prune_cache(&dir, 250);
        let mut left: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        left.sort();
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(left, ["b", "c"], "le plus ancien est effacé en premier");
    }
}
