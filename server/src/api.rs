//! API HTTP, et le site lui-même (fichiers construits par `pnpm build`, servis à la racine).
//!
//! - `GET /api/health` : état du serveur (horaires chargés, fraîcheur du temps réel).
//! - `GET /api/velos` : stations de vélos en libre-service de France, avec vélos et places disponibles.
//! - `GET /api/feux` : feux détectés par satellite sur 7 jours.
//! - `GET /api/bateaux` : navires autour de la France (AIS, aisstream.io), toutes les 10 s.
//! - `GET /api/avions` : avions en vol au-dessus de la France (adsb.lol), mis à jour toutes les 10 s.
//! - `GET /api/satellites` : éléments orbitaux CelesTrak (stations, GPS, Galileo, météo, brillants) ;
//!   `GET /api/satellites/starlink` : ceux de la constellation Starlink, à part car volumineux.
//! - `GET /api/trains?from=…&to=…` : les trains qui roulent entre deux instants
//!   (secondes UTC), avec leurs arrêts et leurs horaires prévus et réels. Le
//!   navigateur calcule lui-même la position de chaque train à chaque image.
//! - `GET /api/reseau/{version}` : les gares et les tracés auxquels renvoient les
//!   trains (voir `network.rs`). Ne change jamais pour une version donnée.
//! - `GET /api/reseau` : la version actuelle du réseau.

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

use crate::network::Network;
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
        .route("/api/velos", get(|State(state): State<AppState>| async move { prepared(state.bikes(), "vélos") }))
        .route("/api/feux", get(|State(state): State<AppState>| async move { prepared(state.fires(), "feux") }))
        .route("/api/avions", get(|State(state): State<AppState>| async move { prepared(state.planes(), "avions") }))
        .route("/api/bateaux", get(|State(state): State<AppState>| async move { prepared(state.ships(), "bateaux") }))
        .route("/api/satellites", get(|State(state): State<AppState>| async move { prepared(state.satellites(), "satellites") }))
        .route("/api/satellites/starlink", get(|State(state): State<AppState>| async move { prepared(state.starlink(), "Starlink") }))
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
    }))
}
