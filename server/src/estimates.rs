//! Bus, trams et métros « estimés » : la position des véhicules des réseaux qui publient leurs
//! **horaires en temps réel** (GTFS-RT « TripUpdates ») mais pas leurs positions.
//!
//! C'est le même principe que pour les trains SNCF : on ne sait pas où est le véhicule, mais on sait à
//! quelle heure il doit passer à chaque arrêt (GTFS statique) et de combien il est en retard (flux temps
//! réel). On en déduit où il est, en le faisant avancer le long du tracé de la ligne (`shapes.txt`, sinon
//! en ligne droite) à vitesse constante d'un arrêt au suivant, et à l'arrêt pendant la durée d'arrêt.
//!
//! Réseaux retenus : ceux du catalogue de transport.data.gouv.fr dont une ressource GTFS-RT annonce
//! `trip_updates` sans clé d'accès, et dont aucun flux de positions n'est lu par `transit.rs` (ceux-là
//! ont déjà leurs vrais véhicules). Données sous licence ouverte (Licence Ouverte 2.0 ou ODbL selon le
//! producteur : la réponse porte la licence de chaque réseau). Les trains (SNCF, Trenitalia, Eurostar, TER
//! de région) sont écartés : leur couche est ailleurs.
//!
//! Rythme :
//! - GTFS statique : téléchargé au plus une fois par jour (cache `DATA_DIR/transit-estimates/`, 300 Mo au plus,
//!   un fichier par ressource donc jamais deux versions), relu à chaque changement de jour local ;
//! - temps réel : toutes les 30 secondes ;
//! - positions : recalculées toutes les 10 secondes. Chaque véhicule part avec sa trajectoire des 64 secondes
//!   suivantes (un point toutes les 8 secondes) : le navigateur interpole avec son horloge, le mouvement est
//!   continu et juste même entre deux réponses.
//!
//! Mémoire : un budget global de 150 Mo pour les modèles compacts ; au-delà, les réseaux suivants sont laissés de côté.
//! Un réseau de plus de 120 000 courses sur trois jours est réduit à ses tramways et métros.
//!
//! Désactivation : `TRANSPORTS_ESTIMES=non`.
//!
//! Test hors du direct : `TRANSPORTS_DECALAGE_S` décale l'horloge du calcul (en secondes, négatif pour reculer). Les
//! horaires du jour sont alors lus à cette heure-là, et le temps réel, qui ne vaut que pour maintenant, est ignoré.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use jiff::civil::Date;
use prost::Message;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::gtfs_compact::{self, Schedule, Trip};
use crate::gtfs_rt::{self, FeedMessage};
use crate::state::AppState;
use crate::transit::{EstimateOut, LineOut, NetworkOut, TransitOut, TransitPart, VehicleOut, is_excluded, network_name, round5, url_has_key};

const CATALOG_URL: &str = "https://transport.data.gouv.fr/api/datasets";
const CATALOG_EVERY: Duration = Duration::from_secs(6 * 3600);
const RT_EVERY: Duration = Duration::from_secs(30);
const COMPUTE_EVERY: Duration = Duration::from_secs(10);
const LOAD_CHECK_EVERY: Duration = Duration::from_secs(300);
const RT_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_RT_BYTES: usize = 8 << 20;
/// Un temps réel plus vieux que cela n'est plus de confiance : on retombe sur l'horaire théorique.
const RT_MAX_AGE_S: i64 = 600;
const GTFS_REFRESH: Duration = Duration::from_secs(24 * 3600);
/// Après un échec de chargement, on attend avant de réessayer.
const RETRY_AFTER: Duration = Duration::from_secs(900);
const CACHE_LIMIT_BYTES: u64 = 300 << 20;
const MAX_ZIP_BYTES: u64 = 150 << 20;
const MEMORY_BUDGET_BYTES: usize = 150 << 20;
const MAX_GTFS_PER_NETWORK: usize = 2;
const PARALLEL_FEEDS: usize = 8;
/// Trajectoire envoyée avec chaque véhicule : `PATH_POINTS` points, un toutes les `PATH_STEP_S` secondes.
pub const PATH_STEP_S: i64 = 8;
const PATH_POINTS: usize = 9;
/// Un véhicule apparaît à son terminus au plus tôt cette durée (s) avant son départ.
const APPEAR_BEFORE_S: i64 = 20;
/// Un trajet qui a pris plus de retard que cela (s) n'est plus cherché : le flux n'est pas fiable.
const MAX_DELAY_S: i64 = 3 * 3600;
/// Après ce nombre de tours sans la moindre circulation dans le flux, on ne le relit plus qu'un tour sur trois.
const IDLE_AFTER_TOURS: u32 = 4;

/// Les grandes villes d'abord : le budget de mémoire est épuisé dans l'ordre, et ce sont celles qui comptent.
const PRIORITY_SLUGS: [&str; 6] = [
    "ilevia-localisation-des-arrets-bus-metro-et-tram-gtfs",
    "tisseo-reseau-transport-urbain-toulousain",
    "reseau-de-transports-collectifs-naolib",
    "offre-de-transport-du-reseau-grand-reims-mobilites-communaute-urbaine-du-grand-reims",
    "fr-200052264-t0039-0000-1",
    "fr-200052264-t0034-0000-1",
];

// ───────────────────────── Catalogue ─────────────────────────

#[derive(Clone, Debug, PartialEq)]
struct Source {
    slug: String,
    name: String,
    licence: String,
    rt_url: String,
    /// (identifiant de ressource, adresse) des GTFS statiques.
    gtfs: Vec<(String, String)>,
}

fn is_rail(title: &str) -> bool {
    let t = title.to_lowercase();
    ["train", "trenitalia", "eurostar", "ter "].iter().any(|word| t.contains(word))
}

/// Les ressources GTFS-RT d'un jeu de données qui annoncent `feature` et n'ont pas de clé dans leur adresse : (adresse, disponible).
fn rt_resources<'a>(resources: &'a [Value], feature: &'a str) -> impl Iterator<Item = (&'a str, bool)> + 'a {
    resources
        .iter()
        .filter(move |r| r["format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("gtfs-rt")) && r["features"].as_array().is_some_and(|f| f.iter().any(|v| v == feature)))
        .filter_map(|r| r["original_url"].as_str().or(r["url"].as_str()).map(|url| (url, r["is_available"].as_bool().unwrap_or(false))))
        .filter(|(url, _)| !url_has_key(url))
}

/// Les réseaux à estimer (voir l'en-tête du module).
fn parse_sources(catalog: &Value) -> Result<Vec<Source>> {
    let mut sources = Vec::new();
    let mut seen_rt = HashSet::new();
    for dataset in catalog.as_array().context("catalogue inattendu")? {
        let title = dataset["title"].as_str().unwrap_or_default();
        if dataset["type"] != "public-transit" || is_excluded(title) || is_rail(title) {
            continue;
        }
        let resources = dataset["resources"].as_array().map(Vec::as_slice).unwrap_or_default();
        // Même règle que `transit.rs` : un réseau dont les positions sont lues n'est pas estimé en plus.
        if rt_resources(resources, "vehicle_positions").any(|(_, available)| available) {
            continue;
        }
        // Le flux « disponible » d'abord ; un flux que le catalogue donne indisponible est tout de même essayé
        // (le proxy du catalogue l'a parfois marqué hors service à tort : sans lui, on garde l'horaire théorique).
        let Some((rt_url, _)) = rt_resources(resources, "trip_updates").min_by_key(|(_, available)| !available) else { continue };
        if !seen_rt.insert(rt_url.to_string()) {
            continue;
        }
        let gtfs: Vec<(String, String)> = resources
            .iter()
            .filter(|r| r["format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("gtfs")) && r["is_available"].as_bool().unwrap_or(false))
            .filter_map(|r| Some((r["datagouv_id"].as_str()?.to_string(), r["url"].as_str()?.to_string())))
            .take(MAX_GTFS_PER_NETWORK)
            .collect();
        if gtfs.is_empty() {
            continue;
        }
        sources.push(Source {
            slug: dataset["slug"].as_str().unwrap_or(title).to_string(),
            name: network_name(title),
            licence: dataset["licence"].as_str().unwrap_or_default().to_string(),
            rt_url: rt_url.to_string(),
            gtfs,
        });
    }
    sources.sort_by_key(|s| PRIORITY_SLUGS.iter().position(|p| *p == s.slug).unwrap_or(usize::MAX));
    Ok(sources)
}

// ───────────────────────── Temps réel (TripUpdates) ─────────────────────────

#[derive(Clone, Copy)]
struct Event {
    delay: Option<i32>,
    time: Option<i64>,
}

impl Event {
    /// Retard en secondes, que le flux donne une heure prévue ou directement un retard.
    fn delay_from(self, scheduled: i64) -> Option<i64> {
        self.time.map(|time| time - scheduled).or(self.delay.map(i64::from))
    }
}

struct StopUpdate {
    stop_sequence: Option<u32>,
    stop_id: Option<String>,
    arrival: Option<Event>,
    departure: Option<Event>,
}

struct TripUpdate {
    start_date: Option<Date>,
    canceled: bool,
    stops: Vec<StopUpdate>,
}

/// Le dernier flux de temps réel d'un réseau.
#[derive(Default)]
struct Realtime {
    fetched_at: i64,
    trips: HashMap<String, Vec<TripUpdate>>,
}

fn decode_realtime(bytes: &[u8], fetched_at: i64) -> Result<Realtime> {
    let feed = FeedMessage::decode(bytes).context("flux GTFS-RT illisible")?;
    let mut trips: HashMap<String, Vec<TripUpdate>> = HashMap::new();
    for entity in feed.entity {
        if entity.is_deleted == Some(true) {
            continue;
        }
        let Some(update) = entity.trip_update else { continue };
        let Some(trip_id) = update.trip.trip_id else { continue };
        let relationship = update.trip.schedule_relationship.unwrap_or_default();
        let event = |e: Option<gtfs_rt::StopTimeEvent>| e.map(|e| Event { delay: e.delay, time: e.time });
        let stops = update
            .stop_time_update
            .into_iter()
            .map(|u| StopUpdate { stop_sequence: u.stop_sequence, stop_id: u.stop_id, arrival: event(u.arrival), departure: event(u.departure) })
            .collect();
        trips.entry(trip_id).or_default().push(TripUpdate {
            start_date: update.trip.start_date.as_deref().and_then(parse_date),
            canceled: matches!(relationship, gtfs_rt::TRIP_CANCELED | gtfs_rt::TRIP_DELETED),
            stops,
        });
    }
    Ok(Realtime { fetched_at, trips })
}

fn parse_date(text: &str) -> Option<Date> {
    let n: i32 = text.trim().parse().ok().filter(|n| *n > 19_000_101)?;
    Date::new(i16::try_from(n / 10_000).ok()?, i8::try_from(n / 100 % 100).ok()?, i8::try_from(n % 100).ok()?).ok()
}

// ───────────────────────── Estimation ─────────────────────────

/// Heures d'une circulation, théoriques ou corrigées par le temps réel (secondes UTC).
struct LiveTimes {
    arrival: Vec<i64>,
    departure: Vec<i64>,
    /// Arrivée théorique à chaque arrêt, pour en déduire le retard.
    scheduled_arrival: Vec<i64>,
}

/// Applique le temps réel à une circulation : même règle que pour les trains. Un retard annoncé à un arrêt vaut pour les
/// suivants jusqu'à la prochaine annonce ; avant la première annonce, c'est l'horaire prévu.
///
/// `None` si l'annonce n'est pas plausible pour ce jour de service : un flux sans `start_date` (Tisséo) vaut pour
/// la course d'hier comme pour celle d'aujourd'hui, et ses heures ne collent qu'avec l'une des deux. Un retard de plus de
/// trois heures (ou de 24 h, quand le flux a calculé son retard sur le mauvais jour) est le signe d'un mauvais jour.
fn live_times(schedule: &Schedule, trip: &Trip, day_start: i64, update: Option<&TripUpdate>) -> Option<LiveTimes> {
    let pattern = &schedule.patterns[trip.pattern as usize];
    let n = pattern.stop.len();
    let mut live = LiveTimes { arrival: Vec::with_capacity(n), departure: Vec::with_capacity(n), scheduled_arrival: Vec::with_capacity(n) };
    let mut carried = 0i64;
    for i in 0..n {
        let (arrival, departure) = schedule.times_of(trip, i);
        let (scheduled_arrival, scheduled_departure) = (day_start + i64::from(arrival), day_start + i64::from(departure));
        let stop_id = &*schedule.stops[pattern.stop[i] as usize].id;
        let announced = update.and_then(|u| {
            u.stops.iter().find(|s| match s.stop_sequence {
                Some(sequence) => sequence == pattern.seq[i],
                None => s.stop_id.as_deref() == Some(stop_id),
            })
        });
        let (arrival_delay, departure_delay) = match announced {
            Some(s) => {
                let arrival_delay = s.arrival.and_then(|e| e.delay_from(scheduled_arrival));
                let departure_delay = s.departure.and_then(|e| e.delay_from(scheduled_departure));
                let arrival_delay = arrival_delay.or(departure_delay).unwrap_or(carried);
                let departure_delay = departure_delay.unwrap_or(arrival_delay);
                if arrival_delay.abs() > MAX_DELAY_S || departure_delay.abs() > MAX_DELAY_S {
                    return None;
                }
                carried = departure_delay;
                (arrival_delay, departure_delay)
            }
            None => (carried, carried),
        };
        // Garde-fous contre les incohérences du flux : un véhicule n'arrive pas avant d'être parti de l'arrêt précédent,
        // et ne repart pas avant d'être arrivé.
        let mut live_arrival = scheduled_arrival + arrival_delay;
        if let Some(&previous) = live.departure.last() {
            live_arrival = live_arrival.max(previous);
        }
        let live_departure = (scheduled_departure + departure_delay).max(live_arrival);
        live.arrival.push(live_arrival);
        live.departure.push(live_departure);
        live.scheduled_arrival.push(scheduled_arrival);
    }
    Some(live)
}

/// Où est le véhicule à l'instant `t`.
struct Placement {
    /// Distance le long du tracé (m).
    along: f32,
    /// Vitesse (m/s), 0 à l'arrêt.
    speed: f32,
    /// Prochain arrêt à desservir (rang dans le motif), s'il en reste.
    next: Option<usize>,
}

fn place_at(schedule: &Schedule, trip: &Trip, live: &LiveTimes, t: i64) -> Placement {
    let dist = &schedule.patterns[trip.pattern as usize].dist;
    let last = live.arrival.len() - 1;
    // Dernier arrêt atteint (arrivée ≤ t) ; avant le premier, on attend au premier.
    let k = live.arrival.partition_point(|a| *a <= t).saturating_sub(1);
    if k >= last {
        return Placement { along: dist[last], speed: 0.0, next: None };
    }
    if t <= live.departure[k] {
        return Placement { along: dist[k], speed: 0.0, next: Some(k + 1) };
    }
    // En route de k à k + 1 : vitesse constante.
    let travel = (live.arrival[k + 1] - live.departure[k]).max(1) as f32;
    let fraction = ((t - live.departure[k]) as f32 / travel).clamp(0.0, 1.0);
    let meters = dist[k + 1] - dist[k];
    Placement { along: dist[k] + meters * fraction, speed: meters / travel, next: Some(k + 1) }
}

struct EstimatedVehicle {
    route: u32,
    out: VehicleOut,
}

/// Les véhicules en circulation d'un réseau à l'instant `now`, positions estimées d'après les horaires de `schedule`
/// corrigés par `realtime` (s'il est récent).
fn estimate(schedule: &Schedule, realtime: Option<&Realtime>, now: i64) -> Vec<EstimatedVehicle> {
    let mut vehicles = Vec::new();
    let realtime = realtime.filter(|r| now - r.fetched_at <= RT_MAX_AGE_S);
    for trip in &schedule.trips {
        for day in 0..3 {
            if trip.days & (1 << day) == 0 {
                continue;
            }
            let day_start = schedule.day_starts[day];
            // Écart d'avance ou de retard maximal admis : pas la peine de calculer les courses lointaines.
            if now + APPEAR_BEFORE_S + MAX_DELAY_S < day_start + i64::from(trip.start) || now - MAX_DELAY_S > day_start + i64::from(trip.end) {
                continue;
            }
            let updates = realtime.and_then(|r| r.trips.get(&*trip.id));
            let update = updates.and_then(|list| list.iter().find(|u| u.start_date.is_none_or(|d| d == schedule.dates[day])));
            if update.is_some_and(|u| u.canceled) {
                continue;
            }
            let corrected = update.and_then(|u| live_times(schedule, trip, day_start, Some(u)));
            // Sans temps réel (ou avec une annonce qui ne vaut pas pour ce jour), les heures sont celles de l'horaire :
            // le tri se fait sans rien calculer.
            let (live, update) = match corrected {
                Some(live) => (live, update),
                None => {
                    if now + APPEAR_BEFORE_S < day_start + i64::from(trip.start) || now > day_start + i64::from(trip.end) {
                        continue;
                    }
                    match live_times(schedule, trip, day_start, None) {
                        Some(live) => (live, None),
                        None => continue,
                    }
                }
            };
            let (first, last) = (live.arrival[0], live.arrival[live.arrival.len() - 1]);
            if now + APPEAR_BEFORE_S < first || now > last {
                continue;
            }
            let pattern = &schedule.patterns[trip.pattern as usize];
            let shape = &schedule.shapes[pattern.shape as usize];
            // Trajectoire : un point toutes les PATH_STEP_S secondes, dont le premier est la position actuelle.
            let mut points = Vec::with_capacity(PATH_POINTS);
            let mut current = None;
            for s in 0..PATH_POINTS {
                let placement = place_at(schedule, trip, &live, now + s as i64 * PATH_STEP_S);
                let point = shape.point_at(placement.along);
                if s == 0 {
                    current = Some((placement, point));
                }
                points.push((e5(point.lon), e5(point.lat)));
            }
            let Some((placement, point)) = current else { continue };
            let mut path = Vec::with_capacity(2 * (PATH_POINTS - 1));
            for pair in points.windows(2) {
                path.push(pair[1].0 - pair[0].0);
                path.push(pair[1].1 - pair[0].1);
            }
            let next = placement.next;
            let delay = next.filter(|_| update.is_some()).map(|i| (live.arrival[i] - live.scheduled_arrival[i]) as i32);
            vehicles.push(EstimatedVehicle {
                route: trip.route,
                out: VehicleOut {
                    id: trip.id.to_string(),
                    line: 0,
                    lon: f64::from(points[0].0) / 1e5,
                    lat: f64::from(points[0].1) / 1e5,
                    heading: Some((point.bearing.round() as u16) % 360),
                    speed: Some((placement.speed * 3.6).round() as u16),
                    ts: now,
                    est: Some(EstimateOut {
                        theoretical: update.is_none(),
                        to: (trip.headsign != u32::MAX).then(|| schedule.headsigns[trip.headsign as usize].to_string()),
                        next: next.map(|i| schedule.stops[pattern.stop[i] as usize].name.to_string()).filter(|n| !n.is_empty()),
                        next_at: next.map(|i| live.arrival[i]),
                        delay,
                        path,
                    }),
                },
            });
        }
    }
    vehicles
}

fn e5(degrees: f64) -> i32 {
    (round5(degrees) * 1e5).round() as i32
}

// ───────────────────────── État partagé ─────────────────────────

/// Un réseau suivi : sa source, son modèle compact et son dernier temps réel.
struct Slot {
    source: Source,
    schedules: RwLock<Vec<Arc<Schedule>>>,
    realtime: RwLock<Option<Arc<Realtime>>>,
    /// Dernier essai de chargement, et si on le retente.
    attempt: Mutex<Option<(Instant, bool)>>,
    /// Tours de temps réel de suite sans aucune circulation, et prochain tour où on le relit.
    idle: Mutex<(u32, u64)>,
    /// Échecs de suite du temps réel (429, panne…) : l'attente double à chacun.
    fails: Mutex<u32>,
    built_at: Mutex<Option<Instant>>,
}

struct Shared {
    slots: RwLock<Vec<Arc<Slot>>>,
    /// Décalage de l'horloge (voir `TRANSPORTS_DECALAGE_S`).
    offset_s: i64,
    tour: AtomicU64,
}

impl Shared {
    fn now(&self) -> i64 {
        Timestamp::now().as_second() + self.offset_s
    }

    fn memory_used(&self) -> usize {
        let slots = self.slots.read().expect("verrou des réseaux estimés");
        slots.iter().map(|s| s.schedules.read().expect("verrou des horaires").iter().map(|sch| sch.approx_bytes()).sum::<usize>()).sum()
    }
}

// ───────────────────────── Téléchargement et cache ─────────────────────────

fn cache_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("transit-estimates")
}

fn cache_path(data_dir: &Path, resource_id: &str) -> PathBuf {
    let safe: String = resource_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    cache_dir(data_dir).join(format!("{safe}.zip"))
}

fn dir_size(dir: &Path, except: &Path) -> u64 {
    std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok).filter(|e| e.path() != except).filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum()
}

/// Efface du cache ce qui ne sert plus : zips de ressources qui ne sont plus au catalogue (anciennes versions), restes de téléchargement.
fn prune_cache(data_dir: &Path, sources: &[Source]) {
    let keep: HashSet<PathBuf> = sources.iter().flat_map(|s| s.gtfs.iter().map(|(id, _)| cache_path(data_dir, id))).collect();
    for entry in std::fs::read_dir(cache_dir(data_dir)).into_iter().flatten().filter_map(Result::ok) {
        let path = entry.path();
        if !keep.contains(&path) && std::fs::remove_file(&path).is_ok() {
            info!(fichier = %path.display(), "transports estimés : ancien GTFS effacé");
        }
    }
}

/// Le zip du GTFS d'une ressource : celui du cache s'il a moins d'un jour, sinon retéléchargé (le cache périmé sert de secours).
async fn ensure_zip(http: &reqwest::Client, data_dir: &Path, resource_id: &str, url: &str) -> Result<PathBuf> {
    let path = cache_path(data_dir, resource_id);
    let age = std::fs::metadata(&path).and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
    if age.is_some_and(|age| age < GTFS_REFRESH) {
        return Ok(path);
    }
    match download(http, data_dir, &path, url).await {
        Ok(()) => Ok(path),
        Err(error) if age.is_some() => {
            warn!("transports estimés : GTFS {resource_id} non rafraîchi ({error:#}), l'ancien sert encore");
            Ok(path)
        }
        Err(error) => Err(error),
    }
}

async fn download(http: &reqwest::Client, data_dir: &Path, path: &Path, url: &str) -> Result<()> {
    tokio::fs::create_dir_all(cache_dir(data_dir)).await?;
    let mut response = http.get(url).timeout(Duration::from_secs(300)).send().await?.error_for_status()?;
    let announced = response.content_length();
    if announced.is_some_and(|n| n > MAX_ZIP_BYTES) {
        bail!("GTFS trop gros ({} Mo)", announced.unwrap_or(0) >> 20);
    }
    // Le plafond du cache s'applique avant d'écrire : le fichier qu'on remplace ne compte pas.
    if dir_size(&cache_dir(data_dir), path) + announced.unwrap_or(MAX_ZIP_BYTES / 4) > CACHE_LIMIT_BYTES {
        bail!("plafond de {} Mo du cache des GTFS atteint", CACHE_LIMIT_BYTES >> 20);
    }
    let part = path.with_extension("zip.part");
    let mut file = tokio::fs::File::create(&part).await?;
    let mut size = 0u64;
    let result: Result<()> = async {
        while let Some(chunk) = response.chunk().await? {
            size += chunk.len() as u64;
            if size > MAX_ZIP_BYTES {
                bail!("GTFS trop gros");
            }
            file.write_all(&chunk).await?;
        }
        file.flush().await?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(error);
    }
    tokio::fs::rename(&part, path).await?;
    Ok(())
}

// ───────────────────────── Chargement des horaires ─────────────────────────

/// Charge les modèles compacts d'un réseau. `Ok(None)` : budget de mémoire épuisé.
async fn load_slot(http: &reqwest::Client, data_dir: &Path, shared: &Shared, slot: &Slot) -> Result<Option<Vec<Arc<Schedule>>>> {
    let mut schedules = Vec::new();
    for (resource_id, url) in &slot.source.gtfs {
        let path = ensure_zip(http, data_dir, resource_id, url).await?;
        let now = shared.now();
        let built = tokio::task::spawn_blocking(move || {
            gtfs_compact::build(&path, now, false).or_else(|error| {
                // Un réseau trop gros : on retente avec ses seuls tramways et métros.
                if format!("{error:#}").contains("trop de courses") { gtfs_compact::build(&path, now, true) } else { Err(error) }
            })
        })
        .await?;
        match built {
            Ok(schedule) => schedules.push(Arc::new(schedule)),
            Err(error) => {
                // Un zip abîmé ne doit pas être gardé : le prochain essai le retélécharge.
                if format!("{error:#}").contains("zip illisible") {
                    let _ = std::fs::remove_file(cache_path(data_dir, resource_id));
                }
                warn!("transports estimés : GTFS de {} inutilisable : {error:#}", slot.source.name);
            }
        }
    }
    if schedules.is_empty() {
        bail!("aucun GTFS utilisable");
    }
    let added: usize = schedules.iter().map(|s| s.approx_bytes()).sum();
    let replaced: usize = slot.schedules.read().expect("verrou des horaires").iter().map(|s| s.approx_bytes()).sum();
    if shared.memory_used() - replaced + added > MEMORY_BUDGET_BYTES {
        return Ok(None);
    }
    Ok(Some(schedules))
}

fn needs_load(slot: &Slot, shared: &Shared) -> bool {
    let schedules = slot.schedules.read().expect("verrou des horaires");
    let attempt = *slot.attempt.lock().expect("verrou des essais");
    if let Some((at, ok)) = attempt
        && (!ok && at.elapsed() < RETRY_AFTER || ok && schedules.is_empty())
    {
        // Échec récent, ou budget épuisé : on n'insiste pas avant le prochain catalogue.
        return false;
    }
    if schedules.is_empty() {
        return true;
    }
    // Nouveau jour local : « aujourd'hui » et « demain » ont changé. Les GTFS ont aussi une durée de vie d'un jour.
    let today_changed = schedules.iter().any(|s| Timestamp::from_second(shared.now()).ok().is_some_and(|t| t.to_zoned(s.tz.clone()).date() != s.built_for));
    today_changed || slot.built_at.lock().expect("verrou de la date").is_some_and(|at| at.elapsed() > GTFS_REFRESH)
}

async fn loader(http: reqwest::Client, data_dir: PathBuf, shared: Arc<Shared>) {
    let mut catalog_at: Option<Instant> = None;
    loop {
        if catalog_at.is_none_or(|at| at.elapsed() > CATALOG_EVERY) {
            match fetch_catalog(&http).await {
                Ok(sources) => {
                    info!(reseaux = sources.len(), "transports estimés : catalogue chargé");
                    prune_cache(&data_dir, &sources);
                    let mut slots = shared.slots.write().expect("verrou des réseaux estimés");
                    let mut old: HashMap<String, Arc<Slot>> = slots.drain(..).map(|s| (s.source.slug.clone(), s)).collect();
                    *slots = sources
                        .into_iter()
                        .map(|source| match old.remove(&source.slug) {
                            Some(known) if known.source == source => known,
                            known => {
                                let schedules = known.map(|k| k.schedules.read().expect("verrou des horaires").clone()).unwrap_or_default();
                                Arc::new(Slot { source, schedules: RwLock::new(schedules), realtime: RwLock::default(), attempt: Mutex::default(), idle: Mutex::default(), fails: Mutex::default(), built_at: Mutex::default() })
                            }
                        })
                        .collect();
                    // Le budget épuisé n'est pas définitif : un nouveau catalogue redonne sa chance à chacun.
                    for slot in slots.iter() {
                        let mut attempt = slot.attempt.lock().expect("verrou des essais");
                        if attempt.is_some_and(|(_, ok)| ok) && slot.schedules.read().expect("verrou des horaires").is_empty() {
                            *attempt = None;
                        }
                    }
                    catalog_at = Some(Instant::now());
                }
                Err(error) => warn!("transports estimés : catalogue indisponible : {error:#}"),
            }
        }
        let slots: Vec<Arc<Slot>> = shared.slots.read().expect("verrou des réseaux estimés").clone();
        for slot in slots {
            if !needs_load(&slot, &shared) {
                continue;
            }
            let started = Instant::now();
            match load_slot(&http, &data_dir, &shared, &slot).await {
                Ok(Some(schedules)) => {
                    let (trips, bytes) = (schedules.iter().map(|s| s.trip_count()).sum::<usize>(), schedules.iter().map(|s| s.approx_bytes()).sum::<usize>());
                    let guided = schedules.iter().any(|s| s.guided_only);
                    let shape_points: usize = schedules.iter().map(|s| s.shape_points()).sum();
                    info!(reseau = %slot.source.name, courses = trips, memoire_ko = bytes >> 10, points_de_trace = shape_points, secondes = started.elapsed().as_secs(), tramways_et_metros_seulement = guided, "transports estimés : horaires chargés");
                    *slot.schedules.write().expect("verrou des horaires") = schedules;
                    *slot.built_at.lock().expect("verrou de la date") = Some(Instant::now());
                    *slot.attempt.lock().expect("verrou des essais") = Some((Instant::now(), true));
                }
                Ok(None) => {
                    info!(reseau = %slot.source.name, "transports estimés : budget de mémoire épuisé, réseau laissé de côté");
                    *slot.attempt.lock().expect("verrou des essais") = Some((Instant::now(), true));
                }
                Err(error) => {
                    warn!("transports estimés : horaires de {} indisponibles : {error:#}", slot.source.name);
                    *slot.attempt.lock().expect("verrou des essais") = Some((Instant::now(), false));
                }
            }
        }
        tokio::time::sleep(LOAD_CHECK_EVERY).await;
    }
}

async fn fetch_catalog(http: &reqwest::Client) -> Result<Vec<Source>> {
    let response = http.get(CATALOG_URL).timeout(Duration::from_secs(60)).send().await?.error_for_status()?;
    parse_sources(&serde_json::from_slice(&response.bytes().await?)?)
}

// ───────────────────────── Temps réel : relevé périodique ─────────────────────────

async fn fetch_realtime(http: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let mut response = http.get(url).timeout(RT_TIMEOUT).send().await?.error_for_status()?;
    if response.content_length().is_some_and(|n| n as usize > MAX_RT_BYTES) {
        bail!("flux trop gros");
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_RT_BYTES {
            bail!("flux trop gros");
        }
    }
    if body.starts_with(&[0x1f, 0x8b]) {
        let mut plain = Vec::new();
        std::io::Read::read_to_end(&mut std::io::Read::take(flate2::read::GzDecoder::new(body.as_slice()), MAX_RT_BYTES as u64), &mut plain)?;
        return Ok(plain);
    }
    Ok(body)
}

async fn realtime_poller(http: reqwest::Client, shared: Arc<Shared>) {
    let gate = Arc::new(Semaphore::new(PARALLEL_FEEDS));
    let mut ticker = tokio::time::interval(RT_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        // Le temps réel ne vaut que pour maintenant : avec l'horloge décalée, on s'en passe.
        if shared.offset_s != 0 {
            continue;
        }
        let tour = shared.tour.fetch_add(1, Ordering::Relaxed) + 1;
        let slots: Vec<Arc<Slot>> = shared.slots.read().expect("verrou des réseaux estimés").clone();
        let mut tasks = JoinSet::new();
        for (index, slot) in slots.iter().enumerate() {
            if slot.schedules.read().expect("verrou des horaires").is_empty() || slot.idle.lock().expect("verrou du repos").1 > tour {
                continue;
            }
            let (http, gate, url) = (http.clone(), gate.clone(), slot.source.rt_url.clone());
            tasks.spawn(async move {
                let _permit = gate.acquire_owned().await;
                let fetched_at = Timestamp::now().as_second();
                let result = match fetch_realtime(&http, &url).await {
                    Ok(bytes) => decode_realtime(&bytes, fetched_at),
                    Err(error) => Err(error),
                };
                (index, result)
            });
        }
        let (mut ok, mut failed) = (0, 0);
        while let Some(joined) = tasks.join_next().await {
            let Ok((index, result)) = joined else { continue };
            let slot = &slots[index];
            match result {
                Ok(realtime) => {
                    ok += 1;
                    *slot.fails.lock().expect("verrou des échecs") = 0;
                    let mut idle = slot.idle.lock().expect("verrou du repos");
                    idle.0 = if realtime.trips.is_empty() { idle.0 + 1 } else { 0 };
                    idle.1 = tour + if idle.0 >= IDLE_AFTER_TOURS { 3 } else { 1 };
                    *slot.realtime.write().expect("verrou du temps réel") = Some(Arc::new(realtime));
                }
                Err(error) => {
                    failed += 1;
                    // Un flux en panne ou qui demande d'attendre (429) : on garde le dernier (il perd sa valeur
                    // au bout de 10 minutes) et on espace les essais, de 1 min jusqu'à 30 min, sans insister.
                    let mut fails = slot.fails.lock().expect("verrou des échecs");
                    *fails += 1;
                    let wait_tours = (2u64 << (*fails - 1).min(5)).min(60);
                    slot.idle.lock().expect("verrou du repos").1 = tour + wait_tours;
                    // Un avertissement au premier échec, puis seulement de temps en temps.
                    if fails.is_power_of_two() {
                        warn!("transports estimés : temps réel de {} en erreur ({} fois de suite) : {error:#}", slot.source.name, *fails);
                    }
                }
            }
        }
        if ok + failed > 0 {
            info!(flux_ok = ok, flux_en_erreur = failed, "transports estimés : temps réel relu");
        }
    }
}

// ───────────────────────── Réponse ─────────────────────────

/// Tous les véhicules estimés des réseaux chargés, au format de `/api/transports`.
fn assemble(slots: &[Arc<Slot>], now: i64, use_realtime: bool) -> TransitOut {
    let mut networks: Vec<NetworkOut> = Vec::new();
    let mut lines: Vec<LineOut> = Vec::new();
    let mut vehicles: Vec<VehicleOut> = Vec::new();
    for slot in slots {
        let schedules = slot.schedules.read().expect("verrou des horaires").clone();
        let realtime = if use_realtime { slot.realtime.read().expect("verrou du temps réel").clone() } else { None };
        let mut line_index: HashMap<(usize, u32), usize> = HashMap::new();
        let network = networks.len();
        let first_vehicle = vehicles.len();
        for (which, schedule) in schedules.iter().enumerate() {
            for mut v in estimate(schedule, realtime.as_deref(), now) {
                v.out.line = *line_index.entry((which, v.route)).or_insert_with(|| {
                    let info = &schedule.routes[v.route as usize];
                    lines.push(LineOut {
                        network,
                        id: Some(schedule.route_ids[v.route as usize].to_string()),
                        name: info.short.clone(),
                        long_name: info.long.clone(),
                        color: info.color.clone(),
                        mode: info.mode,
                    });
                    lines.len() - 1
                });
                vehicles.push(v.out);
            }
        }
        let count = vehicles.len() - first_vehicle;
        if count > 0 {
            networks.push(NetworkOut { name: slot.source.name.clone(), licence: slot.source.licence.clone(), vehicles: count });
        } else {
            lines.retain(|l| l.network != network);
        }
    }
    TransitOut { updated_at: now, est_step: Some(PATH_STEP_S), networks, lines, vehicles }
}

async fn publisher(state: AppState, shared: Arc<Shared>) {
    let mut ticker = tokio::time::interval(COMPUTE_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_log = Instant::now() - Duration::from_secs(3600);
    loop {
        ticker.tick().await;
        let slots: Vec<Arc<Slot>> = shared.slots.read().expect("verrou des réseaux estimés").clone();
        if slots.iter().all(|s| s.schedules.read().expect("verrou des horaires").is_empty()) {
            continue;
        }
        let now = shared.now();
        let started = Instant::now();
        let out = assemble(&slots, now, shared.offset_s == 0);
        if last_log.elapsed() > Duration::from_secs(300) {
            let theoretical = out.vehicles.iter().filter(|v| v.est.as_ref().is_some_and(|e| e.theoretical)).count();
            info!(vehicules = out.vehicles.len(), horaire_theorique = theoretical, reseaux = out.networks.len(), ms = started.elapsed().as_millis() as u64, "transports estimés : positions calculées");
            last_log = Instant::now();
        }
        state.set_transit_part(TransitPart::Estimated(out));
    }
}

/// Lance le chargement des horaires, le relevé du temps réel et le calcul des positions.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf, state: AppState) {
    if std::env::var("TRANSPORTS_ESTIMES").is_ok_and(|v| v == "non") {
        info!("transports estimés : désactivés (TRANSPORTS_ESTIMES=non)");
        return;
    }
    let offset_s = std::env::var("TRANSPORTS_DECALAGE_S").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(0);
    if offset_s != 0 {
        warn!(decalage_s = offset_s, "transports estimés : horloge décalée (test hors du direct), temps réel ignoré");
    }
    let shared = Arc::new(Shared { slots: RwLock::default(), offset_s, tour: AtomicU64::new(0) });
    tokio::spawn(loader(http.clone(), data_dir, shared.clone()));
    tokio::spawn(realtime_poller(http, shared.clone()));
    publisher(state, shared).await;
}

#[cfg(test)]
mod tests;
