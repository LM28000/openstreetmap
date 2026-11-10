//! Chargement des sources des isochrones multimodales, en tâche de fond, et publication de l'index.
//!
//! Les isochrones fonctionnent dès le démarrage avec le seul rail (`Timetable::raptor`). La tâche de fond ajoute,
//! dans l'ordre, et republie l'index à chaque étape (le serveur n'attend jamais une source lente) :
//!
//! 1. les **cars TER**, lus dans le GTFS de la SNCF déjà téléchargé (quelques secondes) ;
//! 2. **Île-de-France** (métro, RER, Transilien, tramway), dans le GTFS d'Île-de-France Mobilités ;
//! 3. les **cars interurbains régionaux** du catalogue de transport.data.gouv.fr (`regional.rs`).
//!
//! Téléchargements : au plus un par jour et par fichier (le zip en cache sert tant qu'il a moins de 24 h, et de secours
//! s'il ne peut être rafraîchi). Le GTFS d'Île-de-France est celui de `estimates.rs` (même fichier, même dossier :
//! jamais téléchargé deux fois) ; les cars régionaux ont leur dossier `transit-interurbain/`.
//!
//! Réglages (variables d'environnement) :
//! - `ISO_CARS_TER`, `ISO_IDF`, `ISO_CARS_REGIONAUX` : `non` pour désactiver une source (toutes actives par défaut) ;
//! - `ISO_CACHE_MO` : taille maximale du dossier des GTFS régionaux (800 Mo par défaut ; les ~55 réseaux en pèsent environ 600) ;
//! - `ISO_MEMOIRE_MO` : budget de mémoire des cars régionaux (80 Mo par défaut) : au-delà, les réseaux suivants sont laissés de côté.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result};
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use tracing::{info, warn};

use super::feed::{FeedSpec, RouteRow, read};
use super::{Extras, Kind, Line, RawFeed, idfm, regional};
use crate::state::AppState;

const CATALOG_URL: &str = "https://transport.data.gouv.fr/api/datasets";
/// Un GTFS en cache a une durée de vie d'un jour.
const ZIP_MAX_AGE: Duration = Duration::from_secs(24 * 3600);
/// Les sources sont relues au moins toutes les 12 h (et à chaque changement de jour : la fenêtre de jours glisse).
const SOURCES_MAX_AGE: Duration = Duration::from_secs(12 * 3600);
const CHECK_EVERY: Duration = Duration::from_secs(60);
const MAX_ZIP_BYTES: u64 = 150 << 20;
/// Fenêtre de jours gardés : de hier (les horaires de nuit, « 25:10 ») à dans trois jours. Un départ au plus tard après-demain
/// a besoin de la veille, du jour et du lendemain.
const DAYS_BEFORE: i64 = 1;
const DAYS: u8 = 5;

struct Config {
    cars_ter: bool,
    idf: bool,
    regional: bool,
    cache_limit: u64,
    memory_limit: usize,
}

impl Config {
    fn from_env() -> Self {
        let off = |name: &str| std::env::var(name).is_ok_and(|v| v.trim().eq_ignore_ascii_case("non"));
        let number = |name: &str, default: u64| std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default);
        Self {
            cars_ter: !off("ISO_CARS_TER"),
            idf: !off("ISO_IDF"),
            regional: !off("ISO_CARS_REGIONAUX"),
            cache_limit: number("ISO_CACHE_MO", 800) << 20,
            memory_limit: (number("ISO_MEMOIRE_MO", 80) << 20) as usize,
        }
    }
}

/// Ce qui est chargé, source par source (dans l'ordre où `Extras::build` les assemble).
#[derive(Default)]
struct Sources {
    cars_ter: Option<Arc<RawFeed>>,
    idf: Option<Arc<RawFeed>>,
    regional: Vec<Arc<RawFeed>>,
}

impl Sources {
    fn feeds(&self) -> Vec<Arc<RawFeed>> {
        self.cars_ter.iter().chain(&self.idf).chain(&self.regional).cloned().collect()
    }
}

fn paris_today() -> Date {
    Timestamp::now().to_zoned(TimeZone::get("Europe/Paris").unwrap_or(TimeZone::UTC)).date()
}

fn first_day(today: Date) -> Date {
    today.checked_sub(jiff::Span::new().days(DAYS_BEFORE)).unwrap_or(today)
}

/// Tâche de fond : charge les sources, publie l'index, le reconstruit quand les horaires du rail ou le jour changent.
pub async fn load_forever(http: reqwest::Client, data_dir: PathBuf, state: AppState) {
    let config = Config::from_env();
    if !(config.cars_ter || config.idf || config.regional) {
        info!("isochrones multimodales : désactivées (ISO_CARS_TER, ISO_IDF et ISO_CARS_REGIONAUX à « non »)");
        return;
    }
    info!(cars_ter = config.cars_ter, idf = config.idf, cars_regionaux = config.regional, "isochrones multimodales : activées");
    let mut sources = Sources::default();
    let mut loaded: Option<(Date, Instant)> = None;
    loop {
        let today = paris_today();
        let stale = loaded.is_none_or(|(day, at)| day != today || at.elapsed() > SOURCES_MAX_AGE);
        if stale {
            // Le jour change ou les sources vieillissent : on les relit, étape par étape, en republiant à chacune.
            if config.cars_ter {
                match read_cars_ter(&data_dir, today).await {
                    Ok(feed) => {
                        sources.cars_ter = Some(Arc::new(feed));
                        publish(&state, &sources).await;
                    }
                    Err(error) => warn!("isochrones : cars TER indisponibles : {error:#}"),
                }
            }
            if config.idf {
                match read_idf(&http, &data_dir, today).await {
                    Ok(feed) => {
                        sources.idf = Some(Arc::new(feed));
                        publish(&state, &sources).await;
                    }
                    Err(error) => warn!("isochrones : Île-de-France indisponible : {error:#}"),
                }
            }
            if config.regional {
                match read_regional(&http, &data_dir, today, &config, &state, &mut sources).await {
                    Ok(()) => {}
                    Err(error) => warn!("isochrones : cars régionaux indisponibles : {error:#}"),
                }
            }
            loaded = Some((today, Instant::now()));
        } else if state.extras().is_none_or(|extras| extras.timetable_id != state.timetable().id) {
            // De nouveaux horaires du rail : les numéros de gares ont changé, on rattache les sources aux nouvelles gares.
            publish(&state, &sources).await;
        }
        tokio::time::sleep(CHECK_EVERY).await;
    }
}

/// Construit l'index à partir des sources chargées, pour les horaires du rail du moment, et le publie.
async fn publish(state: &AppState, sources: &Sources) {
    let feeds = sources.feeds();
    if feeds.is_empty() {
        return;
    }
    let timetable = state.timetable();
    let started = Instant::now();
    let built = tokio::task::spawn_blocking(move || Extras::build(&timetable, &feeds)).await;
    match built {
        Ok(extras) => {
            info!(secondes = started.elapsed().as_secs_f32(), "isochrones multimodales : publiées");
            state.set_extras(extras);
        }
        Err(error) => warn!("isochrones multimodales : construction de l'index échouée : {error}"),
    }
}

// ───────────────────────── Cars TER (GTFS de la SNCF) ─────────────────────────

/// Les cars TER du GTFS de la SNCF : lignes de type bus, arrêts « StopPoint:OCECar TER-… ». Les « Car à réservation »
/// (réservation obligatoire) et les navettes n'en font pas partie.
async fn read_cars_ter(data_dir: &Path, today: Date) -> Result<RawFeed> {
    let path = crate::timetable::gtfs_path(data_dir);
    tokio::task::spawn_blocking(move || read_cars_ter_from(&path, today)).await.context("lecture des cars TER interrompue")?
}

pub(crate) fn read_cars_ter_from(path: &Path, today: Date) -> Result<RawFeed> {
    let classify = |row: &RouteRow| {
        // Le type 3 du GTFS SNCF : cars et navettes ; seuls les arrêts « Car TER » sont retenus plus loin.
        (row.route_type == 3).then(|| Line {
            kind: Kind::Coach,
            label: "Car TER".to_string(),
            name: if row.long.is_empty() { row.short.clone() } else { row.long.clone() },
            color: row.color.clone(),
            text_color: row.text_color.clone(),
        })
    };
    let keep_stop = |id: &[u8]| id.starts_with(b"StopPoint:OCECar TER-");
    let started = Instant::now();
    let feed = read(
        path,
        &FeedSpec {
            name: "Car TER (SNCF)",
            first_day: first_day(today),
            days: DAYS,
            classify: &classify,
            use_parent: true,
            interurban_only: false,
            keep_stop: Some(&keep_stop),
            match_by_name: false,
        },
    )?;
    info!(circulations = feed.trips.len(), arrets = feed.stops.len(), secondes = started.elapsed().as_secs_f32(), "isochrones : cars TER lus");
    Ok(feed)
}

// ───────────────────────── Île-de-France ─────────────────────────

async fn read_idf(http: &reqwest::Client, data_dir: &Path, today: Date) -> Result<RawFeed> {
    let url = std::env::var("IDFM_GTFS_URL").ok().filter(|u| u.starts_with("https://")).unwrap_or_else(|| crate::idf::DEFAULT_GTFS_URL.to_string());
    // Même fichier et même dossier que `estimates.rs` : s'il est frais, il n'est pas retéléchargé.
    let path = crate::estimates::ensure_zip(http, data_dir, crate::idf::RESOURCE_ID, &url, true).await?;
    let first = first_day(today);
    tokio::task::spawn_blocking(move || {
        let started = Instant::now();
        let feed = idfm::read_feed(&path, first, DAYS)?;
        info!(circulations = feed.trips.len(), arrets = feed.stops.len(), secondes = started.elapsed().as_secs_f32(), "isochrones : Île-de-France lu");
        Ok(feed)
    })
    .await
    .context("lecture d'Île-de-France interrompue")?
}

// ───────────────────────── Cars interurbains régionaux ─────────────────────────

fn regional_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("transit-interurbain")
}

/// Le zip d'une ressource régionale : celui du cache s'il a moins d'un jour, sinon retéléchargé (le périmé sert de secours).
async fn ensure_regional_zip(http: &reqwest::Client, dir: &Path, resource_id: &str, url: &str, cache_limit: u64) -> Result<PathBuf> {
    let safe: String = resource_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    let path = dir.join(format!("{safe}.zip"));
    let age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
    if age.is_some_and(|age| age < ZIP_MAX_AGE) {
        return Ok(path);
    }
    match crate::estimates::download(http, dir, &path, url, MAX_ZIP_BYTES, cache_limit).await {
        Ok(()) => Ok(path),
        Err(error) if age.is_some() => {
            warn!("isochrones : GTFS {resource_id} non rafraîchi ({error:#}), l'ancien sert encore");
            Ok(path)
        }
        Err(error) => Err(error),
    }
}

/// Efface du dossier les zips qui ne sont plus au catalogue.
fn prune_regional(dir: &Path, networks: &[regional::Network]) {
    let keep: std::collections::HashSet<String> = networks
        .iter()
        .flat_map(|n| n.resources.iter().map(|(id, _)| id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect::<String>() + ".zip"))
        .collect();
    for entry in std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !keep.contains(&name) && std::fs::remove_file(entry.path()).is_ok() {
            info!(fichier = name, "isochrones : ancien GTFS régional effacé");
        }
    }
}

async fn read_regional(http: &reqwest::Client, data_dir: &Path, today: Date, config: &Config, state: &AppState, sources: &mut Sources) -> Result<()> {
    let response = http.get(CATALOG_URL).timeout(Duration::from_secs(60)).send().await?.error_for_status()?;
    let catalog: serde_json::Value = serde_json::from_slice(&response.bytes().await?)?;
    let networks = regional::select(&catalog);
    let dir = regional_dir(data_dir);
    tokio::fs::create_dir_all(&dir).await?;
    prune_regional(&dir, &networks);
    info!(reseaux = networks.len(), "isochrones : réseaux interurbains du catalogue");

    let first = first_day(today);
    let started = Instant::now();
    let mut loaded: Vec<Arc<RawFeed>> = Vec::new();
    let (mut bytes, mut skipped_memory) = (0usize, 0usize);
    for (n, network) in networks.iter().enumerate() {
        if bytes >= config.memory_limit {
            skipped_memory += 1;
            continue;
        }
        let mut network_trips = 0;
        for (resource_id, url) in &network.resources {
            let path = match ensure_regional_zip(http, &dir, resource_id, url, config.cache_limit).await {
                Ok(path) => path,
                Err(error) => {
                    warn!("isochrones : GTFS de {} indisponible : {error:#}", network.name);
                    continue;
                }
            };
            let name = network.name.clone();
            let read_one = tokio::task::spawn_blocking(move || regional::read_feed(&path, &name, first, DAYS)).await;
            match read_one {
                Ok(Ok(feed)) if !feed.trips.is_empty() => {
                    bytes += feed.bytes();
                    network_trips += feed.trips.len();
                    loaded.push(Arc::new(feed));
                }
                Ok(Ok(_)) => {}
                Ok(Err(error)) => warn!("isochrones : GTFS de {} illisible : {error:#}", network.name),
                Err(error) => warn!("isochrones : lecture de {} interrompue : {error}", network.name),
            }
        }
        info!(reseau = network.name, circulations = network_trips, "isochrones : réseau interurbain lu");
        // On publie de temps en temps : les premiers réseaux servent sans attendre les derniers.
        if (n + 1) % 15 == 0 {
            sources.regional = loaded.clone();
            publish(state, sources).await;
        }
    }
    let trips: usize = loaded.iter().map(|f| f.trips.len()).sum();
    info!(
        reseaux = networks.len() - skipped_memory,
        ignores_faute_de_memoire = skipped_memory,
        circulations = trips,
        memoire_mo = bytes >> 20,
        secondes = started.elapsed().as_secs(),
        "isochrones : cars régionaux chargés"
    );
    sources.regional = loaded;
    publish(state, sources).await;
    Ok(())
}
