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
use crate::tracks::Tracks;

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
    /// Tracés sur les voies, au format « polyline » de Google étendu : quadruplets
    /// (latitude × 10⁵, longitude × 10⁵, altitude en m, vitesse maximale en km/h de la portion
    /// qui part du point, 0 si inconnue), chacun codé en écart avec le précédent.
    tracks: Vec<String>,
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
    /// Tracé entre chaque gare et la suivante : `k > 0` = `tracks[k - 1]` dans le sens
    /// d'écriture, `k < 0` = `tracks[-k - 1]` à l'envers, `0` = pas de tracé (ligne droite).
    tracks: Vec<i32>,
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
    let tracks = state.tracks_for(&timetable);
    // Calcul un peu long (quelques millisecondes) : hors de la boucle asynchrone.
    let body = tokio::task::spawn_blocking(move || {
        trains_json(&timetable, realtime.as_deref(), tracks.as_deref(), query.from, query.to)
    })
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(([(header::CONTENT_TYPE, "application/json")], body))
}

fn trains_json(
    timetable: &Timetable,
    realtime: Option<&Realtime>,
    tracks: Option<&Tracks>,
    from: i64,
    to: i64,
) -> serde_json::Result<Vec<u8>> {
    let mut station_ids: HashMap<u32, u32> = HashMap::new();
    let mut stations = Vec::new();
    let mut track_ids: HashMap<u32, i32> = HashMap::new();
    let mut encoded_tracks = Vec::new();
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

        // Chaque tracé n'est envoyé qu'une fois, même si plusieurs trains l'empruntent.
        let train_tracks = stops
            .windows(2)
            .map(|pair| {
                let Some((segment, reversed)) = tracks.and_then(|t| t.find(pair[0].station, pair[1].station)) else {
                    return 0;
                };
                let local = *track_ids.entry(segment).or_insert_with(|| {
                    let s = &tracks.expect("tracés présents").segments[segment as usize];
                    encoded_tracks.push(encode_track(&s.points, &s.heights, &s.limits));
                    encoded_tracks.len() as i32
                });
                if reversed { -local } else { local }
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
            tracks: train_tracks,
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
        tracks: encoded_tracks,
        trains,
    })
}

/// Code un tracé au format « polyline » (voir `TrainsResponse::tracks`) : chaque valeur
/// est l'écart avec le point précédent, écrit en caractères imprimables par paquets de 5 bits.
fn encode_track(points: &[(f64, f64)], heights: &[f32], limits: &[u16]) -> String {
    let mut out = String::with_capacity(points.len() * 11);
    let mut previous = [0i64; 4];
    for ((&(lon, lat), &height), &limit) in points.iter().zip(heights).zip(limits) {
        let current = [(lat * 1e5).round() as i64, (lon * 1e5).round() as i64, height.round() as i64, i64::from(limit)];
        for (value, last) in current.iter().zip(previous.iter_mut()) {
            encode_value(value - *last, &mut out);
            *last = *value;
        }
    }
    out
}

fn encode_value(value: i64, out: &mut String) {
    let mut v = if value < 0 { !(value << 1) } else { value << 1 };
    while v >= 0x20 {
        out.push(char::from(((0x20 | (v & 0x1f)) + 63) as u8));
        v >>= 5;
    }
    out.push(char::from((v + 63) as u8));
}


async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    let timetable = state.timetable();
    let realtime = state.realtime();
    let now = Timestamp::now().as_second();
    let runs = timetable.runs_between(now, now);
    let live = realtime
        .as_deref()
        .map_or(0, |rt| runs.iter().filter(|run| rt.apply(run, &timetable.stop_points).is_some()).count());
    let tracks = state.tracks_for(&timetable);
    Json(serde_json::json!({
        "timetable": { "version": timetable.feed_version, "trips": timetable.trip_count() },
        "tracks": tracks.map(|t| serde_json::json!({ "segments": t.segments.len(), "stationPairs": t.pair_count })),
        "realtime": realtime.map(|rt| serde_json::json!({
            "feedTimestamp": rt.feed_timestamp,
            "fetchedAt": rt.fetched_at,
            "trips": rt.trip_count(),
        })),
        "now": { "running": runs.len(), "withRealtime": live },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polyline_comme_google() {
        // Exemple de la documentation Google (sans altitude) : (38.5, -120.2), (40.7, -120.95).
        let mut out = String::new();
        for v in [3_850_000, -12_020_000, 220_000, -75_000] {
            encode_value(v, &mut out);
        }
        assert_eq!(out, "_p~iF~ps|U_ulLnnqC");
    }
}
