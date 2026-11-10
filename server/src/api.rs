//! API HTTP, et le site lui-même (fichiers construits par `pnpm build`, servis à la racine).
//!
//! - `GET /api/health` : état du serveur (horaires chargés, fraîcheur du temps réel).
//! - `GET /api/velos` : stations de vélos en libre-service de France, avec vélos et places disponibles.
//! - `GET /api/feux` : feux détectés par satellite sur 7 jours.
//! - `GET /api/bateaux` : navires autour de la France (AIS, aisstream.io), toutes les 10 s.
//! - `GET /api/avions` : avions en vol au-dessus de la France (adsb.lol), mis à jour toutes les 10 s.
//! - `GET /api/satellites` : éléments orbitaux CelesTrak (stations, GPS, Galileo, météo, brillants) ;
//!   `GET /api/satellites/starlink` : ceux de la constellation Starlink, à part car volumineux.
//! - `GET /api/vent` : champ de vent à 10 m sur la France (Open-Meteo, ARPEGE), pour l'heure actuelle et les suivantes.
//! - `GET /api/bornes` : bornes de recharge (base nationale IRVE, regroupées par station).
//! - `GET /api/accidents` : accidents corporels de la circulation (ONISR, cinq dernières années), en colonnes, JSON compressé en gzip.
//! - `GET /api/monuments` : monuments historiques (base Mérimée, ministère de la Culture), JSON déjà compressé en gzip.
//! - `GET /api/trafic` : événements routiers (Bison Futé) ; `GET /api/trafic/etat` : état de la circulation.
//! - `GET /api/vigilance` : vigilance météo par département (Météo-France).
//! - `GET /api/air` : indice ATMO de qualité de l'air par commune, et épisodes de pollution (Atmo France / AASQA).
//! - `GET /api/trains?from=…&to=…` : les trains qui roulent entre deux instants
//!   (secondes UTC), avec leurs arrêts et leurs horaires prévus et réels. Le
//!   navigateur calcule lui-même la position de chaque train à chaque image.
//! - `GET /api/reseau/{version}` : les gares et les tracés auxquels renvoient les
//!   trains (voir `network.rs`). Ne change jamais pour une version donnée.
//! - `GET /api/reseau` : la version actuelle du réseau.
//! - `GET /api/isochrone?depuis=<code UIC>&depart=<secondes UTC>&max=<minutes>&correspondances=<n>` : les
//!   gares atteignables depuis une gare (algorithme RAPTOR, voir `raptor.rs`), avec durée et correspondances. Avec
//!   `&modes=train,car,idf` (défaut : tout ce qui est chargé), les cars et les transports d'Île-de-France comptent aussi
//!   et la réponse porte en plus les arrêts supplémentaires atteints (voir `multimodal.rs`) ;
//!   `GET /api/isochrone/trajet?…&vers=<code UIC>` : l'itinéraire jusqu'à l'une d'elles.
//! - `GET /api/arrets/{version}` : les arrêts supplémentaires (cars, métro, RER…) auxquels renvoient les isochrones.
//!   Ne change jamais pour une version donnée. `GET /api/arrets` : la version actuelle (ou `null` si rien n'est chargé).

use std::collections::{HashMap, HashSet};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::{get, get_service};
use axum::{Json, Router};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tower_http::compression::CompressionLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

use crate::multimodal::Extras;
use crate::network::Network;
use crate::raptor::{self, Leg, MAX_ROUNDS, MODE_ALL, MODE_CAR, MODE_IDF, MODE_TRAIN};
use crate::realtime::Realtime;
use crate::state::AppState;

/// Plage maximale d'une requête.
const MAX_WINDOW_S: i64 = 12 * 3600;
/// Un train très en retard peut encore rouler longtemps après son arrivée prévue.
const MAX_DELAY_S: i64 = 3 * 3600;

/// L'API, et le site s'il est construit (`web_dir`).
pub fn router(state: AppState, web_dir: Option<&std::path::Path>) -> Router {
    let mut router = Router::new()
        .route("/api/health", get(health))
        .route("/api/trains", get(trains))
        .route("/api/reseau", get(network_version))
        .route("/api/reseau/{version}", get(network))
        .route("/api/isochrone", get(isochrone))
        .route("/api/isochrone/trajet", get(isochrone_journey))
        .route("/api/arrets", get(extras_version))
        .route("/api/arrets/{version}", get(extras_stops))
        .route("/api/velos", get(|State(state): State<AppState>| async move { prepared(state.bikes(), "vélos") }))
        .route("/api/feux", get(|State(state): State<AppState>| async move { prepared(state.fires(), "feux") }))
        .route("/api/avions", get(|State(state): State<AppState>| async move { prepared(state.planes(), "avions") }))
        .route("/api/transports", get(|State(state): State<AppState>| async move { prepared(state.transit(), "transports") }))
        .route("/api/bateaux", get(|State(state): State<AppState>| async move { prepared(state.ships(), "bateaux") }))
        .route("/api/satellites", get(|State(state): State<AppState>| async move { prepared(state.satellites(), "satellites") }))
        .route("/api/bornes", get(|State(state): State<AppState>| async move { prepared(state.irve(), "bornes") }))
        .route("/api/accidents", get(|| async { crate::accidents::response() }))
        .route("/api/monuments", get(|| async { crate::monuments::response() }))
        .route("/api/trafic", get(|State(state): State<AppState>| async move { prepared(state.traffic(), "trafic") }))
        .route("/api/trafic/etat", get(|State(state): State<AppState>| async move { prepared(state.traffic_state(), "état du trafic") }))
        .route("/api/vigilance", get(|State(state): State<AppState>| async move { prepared(state.vigilance(), "vigilance") }))
        .route("/api/air", get(air))
        .route("/api/satellites/starlink", get(|State(state): State<AppState>| async move { prepared(state.starlink(), "Starlink") }))
        .route("/api/vent", get(|State(state): State<AppState>| async move { prepared(state.wind(), "vent") }))
        // Une adresse d'API inconnue est une erreur, pas la page du site.
        .route("/api/{*rest}", get(|| async { (StatusCode::NOT_FOUND, "adresse d'API inconnue") }));
    if let Some(dir) = web_dir {
        // Les fichiers de assets/ portent une empreinte de leur contenu dans leur nom : ils ne
        // changent jamais. La page d'accueil, elle, est revérifiée à chaque visite pour
        // qu'une mise à jour du site soit vue aussitôt.
        let immutable =
            SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable"));
        let revalidate = SetResponseHeaderLayer::if_not_present(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        let pages = ServeDir::new(dir).fallback(ServeFile::new(dir.join("index.html")));
        router = router
            .nest_service("/assets", get_service(ServeDir::new(dir.join("assets"))).layer(immutable))
            .fallback_service(get_service(pages).layer(revalidate));
    }
    router.layer(CompressionLayer::new()).layer(TraceLayer::new_for_http()).with_state(state)
}

#[derive(Deserialize)]
struct TrainsQuery {
    from: i64,
    to: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainsResponse<'a> {
    generated_at: i64,
    from: i64,
    to: i64,
    realtime: Option<RealtimeInfo>,
    /// Version du réseau (gares et tracés) auquel renvoient les indices des trains.
    network: &'a str,
    /// Catégories et lignes, que les trains désignent par indice.
    categories: Vec<&'a str>,
    lines: Vec<&'a str>,
    trains: Vec<TrainOut<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RealtimeInfo {
    feed_timestamp: i64,
    fetched_at: i64,
}

#[derive(Serialize)]
struct TrainOut<'a> {
    number: &'a str,
    /// Le numéro et l'heure du premier départ identifient une circulation ; dans le cas
    /// (rare) où deux circulations les partagent, ce rang les distingue.
    #[serde(skip_serializing_if = "Option::is_none")]
    variant: Option<u32>,
    /// Indices dans `categories` et `lines`.
    category: u32,
    line: u32,
    /// Indices des gares du réseau, dans l'ordre de passage.
    stations: Vec<u32>,
    /// Tracé entre chaque gare et la suivante : `k > 0` = tracé `k - 1` du réseau dans le
    /// sens d'écriture, `k < 0` = tracé `-k - 1` à l'envers, `0` = pas de tracé (ligne droite).
    tracks: Vec<i32>,
    /// Horaires prévus, arrivée et départ de chaque arrêt en alternance : le premier en
    /// secondes UTC, chacun des suivants en écart avec le précédent.
    times: Vec<i64>,
    /// Retards (secondes) dans le même ordre, si le temps réel parle de ce train.
    #[serde(skip_serializing_if = "Option::is_none")]
    delays: Option<Vec<i64>>,
    /// Indices des arrêts non desservis.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    skipped: Vec<u32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    canceled: bool,
}

async fn trains(
    State(state): State<AppState>,
    Query(query): Query<TrainsQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if query.to <= query.from || query.to - query.from > MAX_WINDOW_S {
        return Err((StatusCode::BAD_REQUEST, "plage horaire invalide (de 1 s à 12 h)".to_string()));
    }
    let network = state.network();
    let realtime = state.realtime();
    // Calcul un peu long (quelques millisecondes) : hors de la boucle asynchrone.
    let body = tokio::task::spawn_blocking(move || trains_json(&network, realtime.as_deref(), query.from, query.to))
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(([(header::CONTENT_TYPE, "application/json")], body))
}

fn trains_json(network: &Network, realtime: Option<&Realtime>, from: i64, to: i64) -> serde_json::Result<Vec<u8>> {
    let timetable = &network.timetable;
    let tracks = network.tracks.as_deref();
    let mut categories = Indexer::default();
    let mut lines = Indexer::default();
    let mut identities = HashSet::new();
    let mut trains = Vec::new();

    for run in timetable.runs_between(from - MAX_DELAY_S, to) {
        let stops = &run.trip.stops;
        let planned: Vec<i64> = stops
            .iter()
            .flat_map(|s| [run.day_start + i64::from(s.arrival), run.day_start + i64::from(s.departure)])
            .collect();
        let live = realtime.and_then(|rt| rt.apply(&run, &timetable.stop_points));

        // Fenêtre réelle de circulation, retards compris.
        let (start, end) = match &live {
            Some(l) => (l.departure.first().copied(), l.arrival.last().copied()),
            None => (planned.get(1).copied(), planned.len().checked_sub(2).map(|i| planned[i])),
        };
        let (Some(start), Some(end)) = (start, end) else { continue };
        if end < from || start > to {
            continue;
        }

        let mut variant = 0;
        while !identities.insert((run.trip.number.as_str(), planned[1], variant)) {
            variant += 1;
        }
        let train_tracks = stops
            .windows(2)
            .map(|pair| match tracks.and_then(|t| t.find(pair[0].station, pair[1].station)) {
                Some((segment, reversed)) => {
                    let k = segment as i32 + 1;
                    if reversed { -k } else { k }
                }
                None => 0,
            })
            .collect();
        let times = planned.iter().scan(0, |previous, &t| Some(t - std::mem::replace(previous, t))).collect();

        let (delays, skipped, canceled) = match live {
            Some(l) => {
                let actual = l.arrival.iter().zip(&l.departure).flat_map(|(&a, &d)| [a, d]);
                (Some(actual.zip(&planned).map(|(a, &p)| a - p).collect()), l.skipped, l.canceled)
            }
            None => (None, Vec::new(), false),
        };
        trains.push(TrainOut {
            number: &run.trip.number,
            variant: (variant > 0).then_some(variant),
            category: categories.index(&run.trip.category),
            line: lines.index(&run.trip.line),
            stations: stops.iter().map(|s| s.station).collect(),
            tracks: train_tracks,
            times,
            delays,
            skipped,
            canceled,
        });
    }

    serde_json::to_vec(&TrainsResponse {
        generated_at: Timestamp::now().as_second(),
        from,
        to,
        realtime: realtime.map(|rt| RealtimeInfo { feed_timestamp: rt.feed_timestamp, fetched_at: rt.fetched_at }),
        network: &network.version,
        categories: categories.values,
        lines: lines.values,
        trains,
    })
}

/// Liste de textes sans doublon, chacun désigné par son indice.
#[derive(Default)]
struct Indexer<'a> {
    values: Vec<&'a str>,
    positions: HashMap<&'a str, u32>,
}

impl<'a> Indexer<'a> {
    fn index(&mut self, value: &'a str) -> u32 {
        *self.positions.entry(value).or_insert_with(|| {
            self.values.push(value);
            (self.values.len() - 1) as u32
        })
    }
}

/// Version actuelle du réseau, pour qui veut le réseau sans passer par les trains.
async fn network_version(State(state): State<AppState>) -> impl IntoResponse {
    ([(header::CACHE_CONTROL, "no-cache")], Json(serde_json::json!({ "version": state.network().version })))
}

/// Le réseau d'une version donnée ne change jamais : le navigateur peut le garder en cache.
async fn network(State(state): State<AppState>, Path(version): Path<String>) -> axum::response::Response {
    let network = state.network();
    if network.version != version {
        return (StatusCode::NOT_FOUND, "version du réseau périmée : recharger les trains").into_response();
    }
    (
        [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
        network.body.clone(),
    )
        .into_response()
}

/// Réponse préparée par un collecteur, ou 503 tant que la première collecte n'est pas finie.
fn prepared(body: Option<Bytes>, what: &str) -> axum::response::Response {
    match body {
        Some(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        None => (StatusCode::SERVICE_UNAVAILABLE, format!("{what} : première collecte en cours")).into_response(),
    }
}

/// Qualité de l'air : 503 avec la raison quand la couche est désactivée (pas d'identifiants Atmo Data).
async fn air(State(state): State<AppState>) -> axum::response::Response {
    match state.air_disabled() {
        Some(reason) => (StatusCode::SERVICE_UNAVAILABLE, format!("qualité de l'air : {reason}")).into_response(),
        None => prepared(state.air(), "qualité de l'air"),
    }
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let network = state.network();
    let timetable = &network.timetable;
    let realtime = state.realtime();
    let now = Timestamp::now().as_second();
    let runs = timetable.runs_between(now, now);
    let live = realtime
        .as_deref()
        .map_or(0, |rt| runs.iter().filter(|run| rt.apply(run, &timetable.stop_points).is_some()).count());
    Json(serde_json::json!({
        "timetable": { "version": timetable.feed_version, "trips": timetable.trip_count() },
        "network": network.version,
        "tracks": network.tracks.as_ref().map(|t| serde_json::json!({ "segments": t.segments.len(), "stationPairs": t.pair_count })),
        "realtime": realtime.map(|rt| serde_json::json!({
            "feedTimestamp": rt.feed_timestamp,
            "fetchedAt": rt.fetched_at,
            "trips": rt.trip_count(),
        })),
        "now": { "running": runs.len(), "withRealtime": live },
        "isochrones": state.extras().map(|e| serde_json::json!({ "version": e.version, "stats": e.stats })),
    }))
}

// --- Isochrones ---

/// Durée maximale par défaut, et plafond (minutes). Au-delà de 12 h, le jour de service suivant entrerait en jeu.
const DEFAULT_MAX_MINUTES: i32 = 180;
const MAX_MINUTES: i32 = 12 * 60;

#[derive(Deserialize)]
struct IsochroneQuery {
    /// Code UIC de la gare de départ (« 87471003 »), tel que le donne `/api/reseau/{version}`.
    depuis: String,
    /// Heure de départ, en secondes UTC.
    depart: i64,
    /// Durée maximale du trajet, en minutes.
    max: Option<i32>,
    /// Nombre maximal de correspondances ; absent : pas de limite (au plus `MAX_ROUNDS` trains).
    correspondances: Option<usize>,
    /// Modes de transport permis, séparés par des virgules : `train`, `car` (TER et réseaux régionaux), `idf`
    /// (métro, RER, Transilien et tramway d'Île-de-France). Absent : tous.
    modes: Option<String>,
    /// Gare d'arrivée (pour `/api/isochrone/trajet` seulement).
    vers: Option<String>,
}

/// Les groupes de modes demandés (voir `raptor::MODE_*`). Le train est toujours permis : sans lui, rien ne partirait d'une gare.
fn parse_modes(text: Option<&str>) -> u8 {
    let Some(text) = text else { return MODE_ALL };
    text.split(',').fold(MODE_TRAIN, |mask, word| match word.trim() {
        "car" | "cars" => mask | MODE_CAR,
        "idf" => mask | MODE_IDF,
        _ => mask,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IsochroneResponse<'a> {
    /// Version du réseau, à laquelle renvoient les indices de gares.
    network: &'a str,
    origin: u32,
    departure: i64,
    /// Le temps réel (retards, suppressions) a-t-il été appliqué ?
    realtime: bool,
    /// Gares atteintes, en colonnes pour rester compact : indice, durée en secondes, correspondances.
    stations: Vec<u32>,
    seconds: Vec<i32>,
    transfers: Vec<u8>,
    /// Version de la ressource `/api/arrets/{version}` à laquelle renvoient `extra_stops`, ou `null` quand les cars et
    /// Île-de-France ne sont pas (encore) chargés. Les modes réellement pris en compte sont dans `modes`.
    extras: Option<&'a str>,
    modes: Vec<&'static str>,
    /// Arrêts supplémentaires atteints : indice dans la ressource, durée en secondes, correspondances.
    extra_stops: Vec<u32>,
    extra_seconds: Vec<i32>,
    extra_transfers: Vec<u8>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum LegOut<'a> {
    Train {
        number: &'a str,
        category: &'a str,
        line: &'a str,
        from: u32,
        to: u32,
        departure: i64,
        arrival: i64,
        /// Arrêts desservis, extrémités comprises.
        stops: u16,
    },
    /// Car, métro, RER, Transilien ou tramway (réseau supplémentaire) : `from` et `to` sont des indices de l'index complet
    /// (gares, puis arrêts supplémentaires : voir `stationCount` de la réponse).
    #[serde(rename_all = "camelCase")]
    Transit {
        /// « car », « metro », « rer », « transilien » ou « tram ».
        mode: &'static str,
        /// « Car TER », « Car BreizhGo 7 », « RER B », « Métro 14 ».
        label: &'a str,
        /// Nom complet de la ligne, et destination.
        line: &'a str,
        headsign: Option<&'a str>,
        /// Couleurs officielles (hexadécimal sans dièse), si le GTFS les donne.
        color: Option<&'a str>,
        text_color: Option<&'a str>,
        from: u32,
        to: u32,
        departure: i64,
        arrival: i64,
        stops: u16,
    },
    /// Correspondance à pied, ou en métro ou RER entre deux gares parisiennes (sans les transports d'Île-de-France).
    Walk { from: u32, to: u32, departure: i64, arrival: i64 },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JourneyResponse<'a> {
    network: &'a str,
    /// Nombre de gares : les indices au-delà sont des arrêts supplémentaires (indice − `station_count` dans la ressource).
    station_count: u32,
    extras: Option<&'a str>,
    realtime: bool,
    legs: Vec<LegOut<'a>>,
}

/// Lance RAPTOR (quelques millisecondes à quelques dizaines : hors de la boucle asynchrone) et met en forme.
async fn run_isochrone<T: Send + 'static>(
    state: &AppState,
    query: IsochroneQuery,
    format: impl FnOnce(&Network, Option<&Extras>, &raptor::Isochrone, &IsochroneQuery) -> Result<T, (StatusCode, String)> + Send + 'static,
) -> Result<T, (StatusCode, String)> {
    let network = state.network();
    let extras = state.extras().filter(|extras| extras.timetable_id == network.timetable.id);
    let realtime = state.realtime();
    tokio::task::spawn_blocking(move || {
        let timetable = &network.timetable;
        let origin = station_by_code(&network, &query.depuis)
            .ok_or_else(|| (StatusCode::NOT_FOUND, format!("gare inconnue : {}", query.depuis)))?;
        let max_minutes = query.max.unwrap_or(DEFAULT_MAX_MINUTES).clamp(1, MAX_MINUTES);
        let params = raptor::Params {
            origin,
            depart: query.depart,
            max_duration: max_minutes * 60,
            max_trips: query.correspondances.map_or(MAX_ROUNDS, |n| n.saturating_add(1)),
        };
        let now = Timestamp::now().as_second();
        // Sans les cars et Île-de-France chargés, ou si l'on ne demande que des trains, l'index du rail seul suffit.
        let modes = parse_modes(query.modes.as_deref());
        let iso = match &extras {
            Some(extras) if modes != MODE_TRAIN => raptor::isochrone_with(timetable, &extras.raptor, modes, realtime.as_deref(), now, &params),
            _ => raptor::isochrone(timetable, realtime.as_deref(), now, &params),
        };
        format(&network, extras.as_deref().filter(|_| modes != MODE_TRAIN), &iso, &query)
    })
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
}

fn station_by_code(network: &Network, code: &str) -> Option<u32> {
    network.timetable.stations.iter().position(|s| s.code == code).map(|i| i as u32)
}

async fn isochrone(
    State(state): State<AppState>,
    Query(query): Query<IsochroneQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let body = run_isochrone(&state, query, |network, extras, iso, query| {
        let reached = iso.reached();
        let origin = station_by_code(network, &query.depuis).unwrap_or_default();
        let station_count = network.timetable.stations.len() as u32;
        let (rail, other): (Vec<_>, Vec<_>) = reached.iter().partition(|r| r.station < station_count);
        let modes = parse_modes(query.modes.as_deref());
        serde_json::to_vec(&IsochroneResponse {
            network: &network.version,
            origin,
            departure: query.depart,
            realtime: iso.realtime,
            stations: rail.iter().map(|r| r.station).collect(),
            seconds: rail.iter().map(|r| r.seconds).collect(),
            transfers: rail.iter().map(|r| r.transfers).collect(),
            extras: extras.map(|e| e.version.as_str()),
            modes: [(MODE_TRAIN, "train"), (MODE_CAR, "car"), (MODE_IDF, "idf")].into_iter().filter(|(bit, _)| modes & bit != 0).map(|(_, name)| name).collect(),
            extra_stops: other.iter().map(|r| r.station - station_count).collect(),
            extra_seconds: other.iter().map(|r| r.seconds).collect(),
            extra_transfers: other.iter().map(|r| r.transfers).collect(),
        })
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
    })
    .await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], body))
}

async fn isochrone_journey(
    State(state): State<AppState>,
    Query(query): Query<IsochroneQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if query.vers.is_none() {
        return Err((StatusCode::BAD_REQUEST, "paramètre « vers » manquant".to_string()));
    }
    let body = run_isochrone(&state, query, |network, extras, iso, query| {
        let target = query.vers.as_deref().unwrap_or_default();
        let station_count = network.timetable.stations.len() as u32;
        // Une gare du rail (code UIC), ou un arrêt supplémentaire (« x<indice dans la ressource> »).
        let station = match target.strip_prefix('x').and_then(|n| n.parse::<u32>().ok()) {
            Some(index) => station_count + index,
            None => station_by_code(network, target).ok_or_else(|| (StatusCode::NOT_FOUND, format!("gare inconnue : {target}")))?,
        };
        let legs = iso.journey(station).ok_or_else(|| (StatusCode::NOT_FOUND, "gare hors de portée".to_string()))?;
        let timetable = &network.timetable;
        let legs = legs
            .into_iter()
            .map(|leg| match leg {
                Leg::Train { trip, from, to, departure, arrival, stops } => match extras.and_then(|e| e.trip(trip)) {
                    Some((line, headsign)) => LegOut::Transit {
                        mode: line.kind.name(),
                        label: &line.label,
                        line: &line.name,
                        headsign,
                        color: line.color.as_deref(),
                        text_color: line.text_color.as_deref(),
                        from,
                        to,
                        departure,
                        arrival,
                        stops,
                    },
                    None => {
                        let trip = &timetable.trips[trip as usize];
                        LegOut::Train { number: &trip.number, category: &trip.category, line: &trip.line, from, to, departure, arrival, stops }
                    }
                },
                Leg::Walk { from, to, departure, arrival } => LegOut::Walk { from, to, departure, arrival },
            })
            .collect();
        serde_json::to_vec(&JourneyResponse { network: &network.version, station_count, extras: extras.map(|e| e.version.as_str()), realtime: iso.realtime, legs })
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
    })
    .await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], body))
}

/// Version actuelle de la ressource des arrêts supplémentaires, ou `null` tant que rien n'est chargé.
async fn extras_version(State(state): State<AppState>) -> impl IntoResponse {
    let extras = state.extras();
    ([(header::CACHE_CONTROL, "no-cache")], Json(serde_json::json!({ "version": extras.as_ref().map(|e| e.version.as_str()) })))
}

/// Les arrêts supplémentaires d'une version donnée ne changent jamais : le navigateur peut les garder en cache.
async fn extras_stops(State(state): State<AppState>, Path(version): Path<String>) -> axum::response::Response {
    match state.extras() {
        Some(extras) if extras.version == version => (
            [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "public, max-age=31536000, immutable")],
            extras.body.clone(),
        )
            .into_response(),
        _ => (StatusCode::NOT_FOUND, "version des arrêts périmée : relancer l'isochrone").into_response(),
    }
}
