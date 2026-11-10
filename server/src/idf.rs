//! Île-de-France : métro, RER, Transilien, tramways (et, en option, bus), d'après les horaires théoriques d'Île-de-France
//! Mobilités (GTFS ouvert) et les prédictions en temps réel de sa plateforme PRIM.
//!
//! IDFM ne publie aucune position de véhicule. Elle publie, par l'API PRIM « Prochains passages — requête globale »
//! (`/estimated-timetable?LineRef=ALL`, SIRI Lite en JSON), l'heure prévue de chaque véhicule aux arrêts qu'il va desservir.
//! On convertit ces prédictions en « mises à jour de courses » au sens du GTFS-RT, que `estimates.rs` sait déjà transformer
//! en positions : le véhicule est placé le long du tracé de sa ligne d'après les heures annoncées.
//!
//! ## Quota
//! La clé PRIM a un quota de **1 000 requêtes par jour** pour cette API (en-têtes `x-ratelimit-limit-day`,
//! `x-ratelimit-remaining-day`, `ratelimit-reset`). Une requête globale pèse 6 à 7 Mo compressés (76 Mo de JSON) et prend
//! 5 à 10 s. On la relit toutes les 180 s par défaut (480 par jour, `IDFM_INTERVALLE_S`, 120 s au minimum) ; sous 60
//! requêtes restantes, on s'arrête jusqu'à la réinitialisation du quota.
//!
//! ## Rapprochement SIRI → GTFS (le point difficile)
//! Le SIRI ne donne pas l'identifiant GTFS de la course (`trip_id`). Il donne : la ligne (`LineRef` = `STIF:Line::C01371:`,
//! soit le `route_id` GTFS `IDFM:C01371`), un identifiant de circulation (`DatedVehicleJourneyRef`) et, par arrêt, l'arrêt
//! (`StopPointRef`) avec l'heure prévue et, parfois, l'heure théorique. Trois cas, dans l'ordre :
//! 1. **Identifiant direct** : pour la SNCF (RER, Transilien) et certains exploitants de bus, la fin de
//!    `DatedVehicleJourneyRef` (`…::3e64b3cc-…:LOC`) est la fin du `trip_id` GTFS (`IDFM:TN:SNCF:3e64b3cc-…`). On vérifie
//!    que la course est bien sur la même ligne.
//! 2. **Arrêts et heures** (métro, tramway RATP, la plupart des bus) : parmi les courses de la ligne dont le motif
//!    dessert les arrêts annoncés, avec les heures du jour, on garde celle dont les heures théoriques s'écartent le moins
//!    (médiane) des heures annoncées, à moins de 4 minutes (2 minutes quand le SIRI donne l'heure théorique).
//!    Un trajet qui desservirait les arrêts en sens inverse est écarté (heures contraires à l'ordre du motif) ;
//!    avec un seul arrêt annoncé, c'est le terminus (`DestinationRef`) qui tranche. Une course n'est attribuée qu'à un
//!    seul véhicule (le meilleur écart d'abord).
//! 3. Sinon le véhicule n'est pas affiché d'après le SIRI (la course reste à l'horaire théorique, en pointillé).
//!
//! Correspondance des arrêts : `STIF:StopPoint:Q:22085:` → `IDFM:22085` (quai) ; `STIF:StopArea:SP:43213:` →
//! `IDFM:monomodalStopPlace:43213` (gares SNCF). Une gare annoncée par sa zone d'arrêt est aussi cherchée par son quai
//! (`ExpectedQuayRef`).
//!
//! Le retard n'est affiché que quand le SIRI donne aussi l'heure théorique (RER, Transilien, bus) : celui du métro et du
//! tramway RATP, sans heure théorique, serait celui de l'écart avec une course choisie par proximité, donc faux.
//!
//! ## Variables d'environnement
//! - `IDFM_PRIM_API_KEY` : clé PRIM (sans elle, le réseau est ignoré) ;
//! - `IDFM_MODES` : modes gardés, `metro,tram,train,cable` par défaut ; ajouter `bus` pour les bus (≈ 75 000 courses par jour) ;
//! - `IDFM_INTERVALLE_S` : intervalle de relevé du SIRI (180 par défaut, 120 au minimum) ;
//! - `IDFM_MEMOIRE_MO` : budget de mémoire des horaires de ce réseau (100 par défaut) ;
//! - `IDFM_GTFS_URL` : adresse du GTFS (celle d'IDFM par défaut).

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use jiff::Timestamp;
use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

use crate::estimates::{Event, Realtime, StopUpdate, TripUpdate};
use crate::gtfs_compact::{Schedule, Trip};
use crate::transit::RouteInfo;

pub const PRIM_URL: &str = "https://prim.iledefrance-mobilites.fr/marketplace/estimated-timetable?LineRef=ALL";
pub const DEFAULT_GTFS_URL: &str = "https://eu.ftp.opendatasoft.com/stif/GTFS/IDFM-gtfs.zip";
pub const SLUG: &str = "idfm-prim";
pub const NAME: &str = "Île-de-France Mobilités";
/// Identifiant de ressource pour le cache du zip.
pub const RESOURCE_ID: &str = "idfm-gtfs";
const DEFAULT_EVERY_S: u64 = 180;
const MIN_EVERY_S: u64 = 120;
/// Sous ce nombre de requêtes restantes dans la journée, on laisse le quota tranquille jusqu'à sa réinitialisation.
pub const QUOTA_RESERVE: u32 = 60;
/// Écart (s) maximal entre les heures annoncées et l'horaire d'une course trouvée par ses arrêts.
const MAX_SCORE_S: f64 = 240.0;
const MAX_SCORE_AIMED_S: f64 = 120.0;
/// Les courses qui commencent plus de tant de secondes après le dernier arrêt annoncé, ou finissent avant le premier, ne sont pas candidates.
const WINDOW_S: i64 = 900;
/// Un décalage entre l'heure théorique d'une course trouvée par son identifiant et celle annoncée au-delà de cela : on s'en méfie.
const MAX_DIRECT_GAP_S: i64 = 3 * 3600;

// ───────────────────────── Configuration ─────────────────────────

#[derive(Clone)]
pub struct Config {
    /// Valeur de la clé : jamais écrite dans les journaux.
    key: Arc<str>,
    pub modes: Vec<String>,
    pub every: Duration,
    pub memory_limit: usize,
    pub gtfs_url: String,
}

impl Config {
    pub fn from_env() -> Option<Self> {
        let key = std::env::var("IDFM_PRIM_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty())?;
        let modes: Vec<String> = std::env::var("IDFM_MODES")
            .ok()
            .map(|v| v.split(',').map(|m| m.trim().to_lowercase()).filter(|m| !m.is_empty()).collect())
            .filter(|v: &Vec<String>| !v.is_empty())
            .unwrap_or_else(|| ["metro", "tram", "train", "cable"].map(String::from).to_vec());
        let every = std::env::var("IDFM_INTERVALLE_S").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(DEFAULT_EVERY_S).max(MIN_EVERY_S);
        let memory_mb: usize = std::env::var("IDFM_MEMOIRE_MO").ok().and_then(|v| v.trim().parse().ok()).unwrap_or(100);
        let gtfs_url = std::env::var("IDFM_GTFS_URL").ok().filter(|u| u.starts_with("https://")).unwrap_or_else(|| DEFAULT_GTFS_URL.to_string());
        Some(Self { key: key.into(), modes, every: Duration::from_secs(every), memory_limit: memory_mb << 20, gtfs_url })
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    /// Les lignes qu'on garde : modes demandés, sans les TER de l'annuaire d'IDFM (ceux de la SNCF sont déjà dans la couche des trains).
    pub fn keeps(&self, info: &RouteInfo) -> bool {
        let Some(mode) = info.mode else { return false };
        self.modes.iter().any(|m| m == mode) && !(mode == "train" && info.short.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("ter")))
    }
}

/// « A » → « RER A », « H » → « Transilien H » (le GTFS ne distingue les deux que par l'exploitant) ; le reste est inchangé.
pub fn decorate(schedule: &mut Schedule) {
    for route in &mut schedule.routes {
        if route.mode == Some("train")
            && let Some(short) = route.short.clone()
        {
            let rer = matches!(short.as_str(), "A" | "B" | "C" | "D" | "E");
            route.long = Some(format!("{} {short}", if rer { "RER" } else { "Transilien" }));
        }
    }
}

// ───────────────────────── Lecture du SIRI ─────────────────────────

/// Un arrêt, par son numéro : `area` pour une zone d'arrêt SNCF (`StopArea:SP`), sinon un quai (`StopPoint:Q`).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct StopCode {
    area: bool,
    n: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct Call {
    stop: StopCode,
    quay: Option<StopCode>,
    aimed_arrival: Option<i64>,
    aimed_departure: Option<i64>,
    arrival: Option<i64>,
    departure: Option<i64>,
}

impl Call {
    /// Heure annoncée (arrivée, sinon départ) pour classer et comparer.
    fn expected(&self) -> Option<i64> {
        self.arrival.or(self.departure)
    }
    fn aimed(&self) -> Option<i64> {
        self.aimed_arrival.or(self.aimed_departure)
    }
}

#[derive(Debug)]
pub struct Journey {
    /// `route_id` GTFS (`IDFM:C01371`).
    route: String,
    /// Fin de `DatedVehicleJourneyRef`, entre `::` et `:LOC`.
    short_ref: String,
    destination: Option<StopCode>,
    calls: Vec<Call>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Val {
    value: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct RawAssignment {
    expected_quay_ref: Val,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct RawCall {
    stop_point_ref: Val,
    expected_arrival_time: Option<String>,
    expected_departure_time: Option<String>,
    aimed_arrival_time: Option<String>,
    aimed_departure_time: Option<String>,
    arrival_status: Option<String>,
    departure_status: Option<String>,
    arrival_stop_assignment: Option<RawAssignment>,
    departure_stop_assignment: Option<RawAssignment>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct RawCalls {
    estimated_call: Vec<RawCall>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct RawJourney {
    line_ref: Val,
    dated_vehicle_journey_ref: Val,
    destination_ref: Val,
    estimated_calls: RawCalls,
}

/// `STIF:StopPoint:Q:22085:` ou `STIF:StopArea:SP:43213:`.
fn stop_code(reference: &str) -> Option<StopCode> {
    let mut parts = reference.split(':');
    let area = match (parts.next()?, parts.next()?) {
        ("STIF", "StopPoint") => false,
        ("STIF", "StopArea") => true,
        _ => return None,
    };
    let n = parts.nth(1)?.parse().ok()?;
    Some(StopCode { area, n })
}

fn time(text: &Option<String>) -> Option<i64> {
    text.as_deref()?.parse::<Timestamp>().ok().map(|t| t.as_second())
}

fn convert(raw: RawJourney) -> Option<Journey> {
    // `STIF:Line::C01371:` → `IDFM:C01371`
    let line = raw.line_ref.value?;
    let id = line.split(':').nth(3).filter(|id| !id.is_empty())?;
    let reference = raw.dated_vehicle_journey_ref.value?;
    let short_ref = reference.split_once("::").map_or(reference.as_str(), |(_, rest)| rest.rsplit_once(':').map_or(rest, |(id, _)| id)).to_string();
    let calls: Vec<Call> = raw
        .estimated_calls
        .estimated_call
        .iter()
        .filter(|c| !is_cancelled(&c.arrival_status) && !is_cancelled(&c.departure_status))
        .filter_map(|c| {
            let quay = [&c.arrival_stop_assignment, &c.departure_stop_assignment].into_iter().flatten().find_map(|a| a.expected_quay_ref.value.as_deref().and_then(stop_code));
            let call = Call {
                stop: c.stop_point_ref.value.as_deref().and_then(stop_code)?,
                quay,
                aimed_arrival: time(&c.aimed_arrival_time),
                aimed_departure: time(&c.aimed_departure_time),
                arrival: time(&c.expected_arrival_time),
                departure: time(&c.expected_departure_time),
            };
            call.expected().or(call.aimed()).map(|_| call)
        })
        .collect();
    if calls.is_empty() {
        return None;
    }
    Some(Journey { route: format!("IDFM:{id}"), short_ref, destination: raw.destination_ref.value.as_deref().and_then(stop_code), calls })
}

fn is_cancelled(status: &Option<String>) -> bool {
    status.as_deref().is_some_and(|s| s.eq_ignore_ascii_case("cancelled"))
}

/// Les circulations, converties une à une pendant la lecture (le JSON complet pèse 76 Mo : on ne le garde pas).
struct Journeys(Vec<Journey>);

impl<'de> Deserialize<'de> for Journeys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Collect;
        impl<'de> Visitor<'de> for Collect {
            type Value = Journeys;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("une liste de circulations")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Journeys, A::Error> {
                let mut out = Vec::new();
                while let Some(raw) = seq.next_element::<RawJourney>()? {
                    out.extend(convert(raw));
                }
                Ok(Journeys(out))
            }
        }
        deserializer.deserialize_seq(Collect)
    }
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Frame {
    estimated_vehicle_journey: Option<Journeys>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Delivery {
    estimated_journey_version_frame: Vec<Frame>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct ServiceDelivery {
    estimated_timetable_delivery: Vec<Delivery>,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Siri {
    service_delivery: ServiceDelivery,
}

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "PascalCase")]
struct Root {
    siri: Siri,
}

/// Lit la réponse (JSON, éventuellement compressé en gzip) ; ne garde que les circulations des lignes `accept`.
pub fn parse_siri(body: &[u8], accept: &dyn Fn(&str) -> bool) -> Result<Vec<Journey>> {
    let reader: Box<dyn Read + '_> = if body.starts_with(&[0x1f, 0x8b]) { Box::new(flate2::read::GzDecoder::new(body)) } else { Box::new(body) };
    let root: Root = serde_json::from_reader(BufReader::with_capacity(1 << 16, reader)).context("réponse SIRI illisible")?;
    let mut journeys: Vec<Journey> = root.siri.service_delivery.estimated_timetable_delivery.into_iter().flat_map(|d| d.estimated_journey_version_frame).filter_map(|f| f.estimated_vehicle_journey).flat_map(|j| j.0).collect();
    journeys.retain(|j| accept(&j.route));
    Ok(journeys)
}

// ───────────────────────── Rapprochement ─────────────────────────

/// Bilan d'un rapprochement, pour le journal.
#[derive(Default, Debug, PartialEq)]
pub struct Stats {
    pub journeys: usize,
    pub by_id: usize,
    pub by_stops: usize,
    pub unmatched: usize,
}

/// Numéro d'un arrêt GTFS : `IDFM:22085` → quai 22085 ; `IDFM:monomodalStopPlace:43213` → zone 43213.
fn gtfs_stop_code(id: &str) -> Option<StopCode> {
    let rest = id.strip_prefix("IDFM:")?;
    match rest.strip_prefix("monomodalStopPlace:") {
        Some(n) => Some(StopCode { area: true, n: n.parse().ok()? }),
        None => Some(StopCode { area: false, n: rest.parse().ok()? }),
    }
}

/// Une course choisie pour une circulation : (course, jour 0/1/2 de `Trip::days`, écart en secondes).
#[derive(Clone, Copy, Debug)]
struct Candidate {
    trip: u32,
    day: usize,
    score: f64,
}

struct Index<'a> {
    schedule: &'a Schedule,
    route_of: HashMap<&'a str, u32>,
    trips_of_route: Vec<Vec<u32>>,
    /// Fin du `trip_id` (après le dernier `:`) → course.
    by_suffix: HashMap<&'a str, u32>,
    /// Numéro GTFS de chaque arrêt du modèle.
    code_of_stop: Vec<Option<StopCode>>,
    known: HashSet<StopCode>,
}

impl<'a> Index<'a> {
    fn new(schedule: &'a Schedule) -> Self {
        let route_of = schedule.route_ids.iter().enumerate().map(|(i, id)| (&**id, i as u32)).collect();
        let mut trips_of_route = vec![Vec::new(); schedule.routes.len()];
        let mut by_suffix = HashMap::with_capacity(schedule.trips.len());
        for (i, trip) in schedule.trips.iter().enumerate() {
            trips_of_route[trip.route as usize].push(i as u32);
            if let Some((_, suffix)) = trip.id.rsplit_once(':') {
                by_suffix.insert(suffix, i as u32);
            }
        }
        let code_of_stop: Vec<Option<StopCode>> = schedule.stops.iter().map(|s| gtfs_stop_code(&s.id)).collect();
        let known = code_of_stop.iter().flatten().copied().collect();
        Self { schedule, route_of, trips_of_route, by_suffix, code_of_stop, known }
    }

    /// Rang dans le motif de la course de l'arrêt annoncé par `call` : l'arrêt le plus proche en heure s'il est desservi plusieurs fois.
    fn position(&self, trip: &Trip, call: &Call, day_start: i64) -> Option<usize> {
        let pattern = &self.schedule.patterns[trip.pattern as usize];
        let target = call.aimed().or(call.expected());
        let mut best: Option<(i64, usize)> = None;
        for (i, &stop) in pattern.stop.iter().enumerate() {
            let Some(code) = self.code_of_stop[stop as usize] else { continue };
            if code != call.stop && Some(code) != call.quay {
                continue;
            }
            let gap = target.map_or(0, |t| (day_start + i64::from(self.schedule.times_of(trip, i).0) - t).abs());
            if best.is_none_or(|(g, _)| gap < g) {
                best = Some((gap, i));
            }
        }
        best.map(|(_, i)| i)
    }

    /// Écart entre l'horaire de `trip` ce jour-là et les heures annoncées, d'après les arrêts annoncés ; `None` si la course ne convient pas.
    fn score(&self, journey: &Journey, trip: &Trip, day: usize) -> Option<f64> {
        let day_start = self.schedule.day_starts[day];
        let mut gaps = Vec::with_capacity(journey.calls.len());
        let mut found: Vec<(usize, i64)> = Vec::with_capacity(journey.calls.len());
        let mut resolvable = 0;
        for call in &journey.calls {
            let Some(target) = call.aimed().or(call.expected()) else { continue };
            if self.stop_is_known(call) {
                resolvable += 1;
            }
            if let Some(i) = self.position(trip, call, day_start) {
                gaps.push((day_start + i64::from(self.schedule.times_of(trip, i).0) - target).abs() as f64);
                if let Some(t) = call.expected() {
                    found.push((i, t));
                }
            }
        }
        // Au moins 80 % des arrêts connus du réseau doivent être desservis par le motif.
        if gaps.is_empty() || (gaps.len() as f64) < 0.8 * resolvable as f64 {
            return None;
        }
        // Les heures annoncées doivent croître avec le rang des arrêts (sinon c'est l'autre sens de la ligne).
        found.sort_unstable();
        let (mut pairs, mut inverted) = (0u32, 0u32);
        for a in 0..found.len() {
            for b in a + 1..found.len() {
                if found[a].0 != found[b].0 {
                    pairs += 1;
                    inverted += u32::from(found[b].1 < found[a].1 - 20);
                }
            }
        }
        if pairs > 0 && f64::from(inverted) > 0.2 * f64::from(pairs) {
            return None;
        }
        // Un seul arrêt annoncé : le sens vient du terminus.
        let pattern = &self.schedule.patterns[trip.pattern as usize];
        let last = self.code_of_stop[*pattern.stop.last()? as usize];
        let mut penalty = 0.0;
        if let (Some(destination), Some(last)) = (journey.destination, last)
            && destination != last
        {
            if found.len() < 2 {
                return None;
            }
            penalty = 60.0;
        }
        gaps.sort_by(f64::total_cmp);
        Some(gaps[gaps.len() / 2] + penalty)
    }

    fn stop_is_known(&self, call: &Call) -> bool {
        self.known.contains(&call.stop) || call.quay.is_some_and(|q| self.known.contains(&q))
    }
}

/// Convertit les circulations du SIRI en mises à jour de courses du GTFS `schedule` (voir l'en-tête du module).
pub fn match_journeys(schedule: &Schedule, journeys: &[Journey], now: i64) -> (Realtime, Stats) {
    let index = Index::new(schedule);
    let mut stats = Stats { journeys: journeys.len(), ..Stats::default() };
    let mut chosen: Vec<Option<(Candidate, bool)>> = vec![None; journeys.len()];
    let mut claimed: HashSet<(u32, usize)> = HashSet::new();

    // 1. Identifiant direct.
    for (j, journey) in journeys.iter().enumerate() {
        let Some(&route) = index.route_of.get(journey.route.as_str()) else { continue };
        let Some(&trip_index) = index.by_suffix.get(journey.short_ref.as_str()) else { continue };
        let trip = &schedule.trips[trip_index as usize];
        if trip.route != route {
            continue;
        }
        // Le jour de la course : celui dont l'horaire est le plus proche des heures annoncées.
        let anchor = journey.calls.iter().find_map(|c| c.aimed().or(c.expected()).map(|t| (c, t)));
        let day = (0..3).filter(|d| trip.days & (1 << d) != 0).min_by_key(|&d| match anchor {
            Some((call, target)) => index.position(trip, call, schedule.day_starts[d]).map_or(i64::MAX, |i| (schedule.day_starts[d] + i64::from(schedule.times_of(trip, i).0) - target).abs()),
            None => 0,
        });
        let Some(day) = day else { continue };
        let gap = anchor.and_then(|(call, target)| index.position(trip, call, schedule.day_starts[day]).map(|i| (schedule.day_starts[day] + i64::from(schedule.times_of(trip, i).0) - target).abs()));
        if gap.is_none_or(|g| g > MAX_DIRECT_GAP_S) || !claimed.insert((trip_index, day)) {
            continue;
        }
        chosen[j] = Some((Candidate { trip: trip_index, day, score: 0.0 }, true));
        stats.by_id += 1;
    }

    // 2. Arrêts et heures : les meilleurs écarts d'abord, chaque course une seule fois.
    let mut candidates: Vec<(usize, Vec<Candidate>)> = Vec::new();
    for (j, journey) in journeys.iter().enumerate() {
        if chosen[j].is_some() {
            continue;
        }
        let Some(&route) = index.route_of.get(journey.route.as_str()) else { continue };
        if !journey.calls.iter().any(|c| index.stop_is_known(c)) {
            continue;
        }
        let times: Vec<i64> = journey.calls.iter().filter_map(|c| c.aimed().or(c.expected())).collect();
        let (first, last) = (times.iter().min().copied().unwrap_or(0), times.iter().max().copied().unwrap_or(0));
        let aimed = journey.calls.iter().any(|c| c.aimed().is_some());
        let limit = if aimed { MAX_SCORE_AIMED_S } else { MAX_SCORE_S };
        let mut found: Vec<Candidate> = Vec::new();
        for &trip_index in &index.trips_of_route[route as usize] {
            let trip = &schedule.trips[trip_index as usize];
            for day in 0..3 {
                if trip.days & (1 << day) == 0 {
                    continue;
                }
                let start = schedule.day_starts[day] + i64::from(trip.start);
                let end = schedule.day_starts[day] + i64::from(trip.end);
                if end < first - WINDOW_S || start > last + WINDOW_S {
                    continue;
                }
                if let Some(score) = index.score(journey, trip, day).filter(|s| *s <= limit) {
                    found.push(Candidate { trip: trip_index, day, score });
                }
            }
        }
        found.sort_by(|a, b| a.score.total_cmp(&b.score));
        found.truncate(4);
        if !found.is_empty() {
            candidates.push((j, found));
        }
    }
    candidates.sort_by(|a, b| a.1[0].score.total_cmp(&b.1[0].score));
    for (j, found) in candidates {
        if let Some(c) = found.into_iter().find(|c| claimed.insert((c.trip, c.day))) {
            chosen[j] = Some((c, false));
            stats.by_stops += 1;
        }
    }
    stats.unmatched = journeys.len() - stats.by_id - stats.by_stops;

    // Mises à jour de courses.
    let mut trips: HashMap<String, Vec<TripUpdate>> = HashMap::new();
    for (journey, chosen) in journeys.iter().zip(chosen) {
        let Some((candidate, _)) = chosen else { continue };
        let trip = &schedule.trips[candidate.trip as usize];
        let day_start = schedule.day_starts[candidate.day];
        let stops: Vec<StopUpdate> = journey
            .calls
            .iter()
            .filter_map(|call| {
                let i = index.position(trip, call, day_start)?;
                let pattern = &schedule.patterns[trip.pattern as usize];
                // Avec l'heure théorique, le retard est exact ; sans elle, on donne l'heure prévue.
                let event = |expected: Option<i64>, aimed: Option<i64>| match (expected, aimed) {
                    (Some(e), Some(a)) => Some(Event { delay: i32::try_from(e - a).ok(), time: None }),
                    (Some(e), None) => Some(Event { delay: None, time: Some(e) }),
                    _ => None,
                };
                let (arrival, departure) = (event(call.arrival, call.aimed_arrival), event(call.departure, call.aimed_departure));
                (arrival.is_some() || departure.is_some()).then_some(StopUpdate { stop_sequence: Some(pattern.seq[i]), stop_id: None, arrival, departure })
            })
            .collect();
        if stops.is_empty() {
            continue;
        }
        let delay_known = journey.calls.iter().any(|c| c.aimed().is_some());
        trips.entry(trip.id.to_string()).or_default().push(TripUpdate { start_date: Some(schedule.dates[candidate.day]), canceled: false, stops, delay_known });
    }
    (Realtime { fetched_at: now, trips }, stats)
}

#[cfg(test)]
pub(crate) mod tests;
