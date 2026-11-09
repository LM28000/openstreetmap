//! API HTTP.
//!
//! - `GET /api/health` : état du serveur (horaires chargés, fraîcheur du temps réel).
//! - `GET /api/trains?from=…&to=…` : les trains qui roulent entre deux instants
//!   (secondes UTC), avec leurs arrêts et leurs horaires prévus et réels. Le
//!   navigateur calcule lui-même la position de chaque train à chaque image.

use std::collections::HashMap;

use axum::extract::{Query, State};
use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tower_http::compression::CompressionLayer;
use tower_http::trace::TraceLayer;

use crate::realtime::Realtime;
use crate::state::AppState;
use crate::timetable::Timetable;

/// Plage maximale d'une requête.
const MAX_WINDOW_S: i64 = 12 * 3600;
/// Un train très en retard peut encore rouler longtemps après son arrivée prévue.
const MAX_DELAY_S: i64 = 3 * 3600;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/trains", get(trains))
        .layer(CompressionLayer::new())
        .layer(TraceLayer::new_for_http())
        .with_state(state)
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
    /// Gares utilisées par les trains ci-dessous (les trains y renvoient par indice).
    stations: Vec<StationOut<'a>>,
    trains: Vec<TrainOut<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RealtimeInfo {
    feed_timestamp: i64,
    fetched_at: i64,
}

#[derive(Serialize)]
struct StationOut<'a> {
    name: &'a str,
    lon: f64,
    lat: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainOut<'a> {
    id: &'a str,
    number: &'a str,
    category: &'a str,
    line: &'a str,
    /// Indices dans `stations`, dans l'ordre de passage.
    stations: Vec<u32>,
    /// Horaires prévus (secondes UTC).
    arr: Vec<i64>,
    dep: Vec<i64>,
    /// Horaires réels, si le temps réel parle de ce train.
    #[serde(skip_serializing_if = "Option::is_none")]
    arr_rt: Option<Vec<i64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dep_rt: Option<Vec<i64>>,
    /// Indices des arrêts non desservis.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    skipped: Vec<u32>,
    canceled: bool,
}

async fn trains(
    State(state): State<AppState>,
    Query(query): Query<TrainsQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if query.to <= query.from || query.to - query.from > MAX_WINDOW_S {
        return Err((StatusCode::BAD_REQUEST, "plage horaire invalide (de 1 s à 12 h)".to_string()));
    }
    let timetable = state.timetable();
    let realtime = state.realtime();
    // Calcul un peu long (quelques millisecondes) : hors de la boucle asynchrone.
    let body = tokio::task::spawn_blocking(move || {
        trains_json(&timetable, realtime.as_deref(), query.from, query.to)
    })
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(([(header::CONTENT_TYPE, "application/json")], body))
}

fn trains_json(timetable: &Timetable, realtime: Option<&Realtime>, from: i64, to: i64) -> serde_json::Result<Vec<u8>> {
    let mut station_ids: HashMap<u32, u32> = HashMap::new();
    let mut stations = Vec::new();
    let mut trains = Vec::new();

    for run in timetable.runs_between(from - MAX_DELAY_S, to) {
        let stops = &run.trip.stops;
        let arr: Vec<i64> = stops.iter().map(|s| run.day_start + i64::from(s.arrival)).collect();
        let dep: Vec<i64> = stops.iter().map(|s| run.day_start + i64::from(s.departure)).collect();
        let live = realtime.and_then(|rt| rt.apply(&run, &timetable.stop_points));

        // Fenêtre réelle de circulation, retards compris.
        let (start, end) = match &live {
            Some(l) => (l.departure.first().copied(), l.arrival.last().copied()),
            None => (dep.first().copied(), arr.last().copied()),
        };
        let (Some(start), Some(end)) = (start, end) else { continue };
        if end < from || start > to {
            continue;
        }

        let indices = stops
            .iter()
            .map(|s| {
                *station_ids.entry(s.station).or_insert_with(|| {
                    let station = &timetable.stations[s.station as usize];
                    stations.push(StationOut { name: &station.name, lon: station.lon, lat: station.lat });
                    (stations.len() - 1) as u32
                })
            })
            .collect();

        let (arr_rt, dep_rt, skipped, canceled) = match live {
            Some(l) => (Some(l.arrival), Some(l.departure), l.skipped, l.canceled),
            None => (None, None, Vec::new(), false),
        };
        trains.push(TrainOut {
            id: &run.trip.id,
            number: &run.trip.number,
            category: &run.trip.category,
            line: &run.trip.line,
            stations: indices,
            arr,
            dep,
            arr_rt,
            dep_rt,
            skipped,
            canceled,
        });
    }

    serde_json::to_vec(&TrainsResponse {
        generated_at: Timestamp::now().as_second(),
        from,
        to,
        realtime: realtime.map(|rt| RealtimeInfo { feed_timestamp: rt.feed_timestamp, fetched_at: rt.fetched_at }),
        stations,
        trains,
    })
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let timetable = state.timetable();
    let realtime = state.realtime();
    let now = Timestamp::now().as_second();
    let runs = timetable.runs_between(now, now);
    let live = realtime
        .as_deref()
        .map_or(0, |rt| runs.iter().filter(|run| rt.apply(run, &timetable.stop_points).is_some()).count());
    Json(serde_json::json!({
        "timetable": { "version": timetable.feed_version, "trips": timetable.trip_count() },
        "realtime": realtime.map(|rt| serde_json::json!({
            "feedTimestamp": rt.feed_timestamp,
            "fetchedAt": rt.fetched_at,
            "trips": rt.trip_count(),
        })),
        "now": { "running": runs.len(), "withRealtime": live },
    }))
}
