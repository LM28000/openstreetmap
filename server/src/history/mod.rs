//! L'historique : enregistrer ce que montrent les couches mobiles, pour que remonter la frise rejoue le passé.
//!
//! - `codec` : le format des tronçons (colonnes, entiers en différences, gzip) ;
//! - `sources` : ce qu'on retient des réponses servies pour les avions, les bateaux et les transports ;
//! - `recorder` : tronçons ouverts en mémoire, écriture sur disque, index, conservation ;
//! - `trains` : relecture de l'archive brute du temps réel SNCF.
//!
//! Routes :
//! - `GET /api/historique` : pour chaque couche, les plages enregistrées (le reste est un trou) ;
//! - `GET /api/historique/{couche}/{debut}` : le tronçon de 10 minutes qui commence à `debut` (secondes UNIX, multiple
//!   de 600). Fermé : gzip immuable, cache d'un an. Encore ouvert : état provisoire, à redemander ;
//! - `GET /api/historique/trains?from=…&to=…&at=…` : comme `/api/trains`, avec les retards connus à l'instant `at`.
//!
//! Réglages : `ARCHIVE_DIR` (sans lui, rien n'est enregistré) et `HISTORIQUE_JOURS` (7) : durée de conservation.

pub mod codec;
pub mod recorder;
pub mod sources;
pub mod trains;

use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;
use tracing::{info, warn};

use crate::state::AppState;
use codec::{CHUNK_S, Layer};
use recorder::{History, Served};

/// Ce que contrôle l'environnement.
pub struct Settings {
    pub dir: std::path::PathBuf,
    pub retention_days: i64,
}

impl Settings {
    /// `None` sans `ARCHIVE_DIR` : pas d'historique.
    pub fn from_env(archive_dir: Option<&std::path::Path>) -> Option<Self> {
        let dir = archive_dir?.to_path_buf();
        let retention_days = std::env::var("HISTORIQUE_JOURS").ok().and_then(|v| v.trim().parse::<i64>().ok()).filter(|d| (1..=365).contains(d)).unwrap_or(7);
        Some(Self { dir, retention_days })
    }
}

#[derive(Clone)]
pub struct Handle {
    history: Arc<History>,
    feeds: Arc<trains::FeedArchive>,
    state: AppState,
    /// Un seul décodage de flux archivé à la fois : la mémoire du conteneur est comptée.
    replay_lock: Arc<Semaphore>,
}

/// Lance le relevé et rend de quoi servir l'historique.
pub fn start(settings: Settings, state: AppState) -> Handle {
    let history = History::new(settings.dir.clone(), settings.retention_days);
    history.load_index();
    info!(dossier = %settings.dir.display(), jours = settings.retention_days, "historique activé");
    tokio::spawn(record_forever(history.clone(), state.clone()));
    Handle { history, feeds: Arc::new(trains::FeedArchive::new(&settings.dir)), state, replay_lock: Arc::new(Semaphore::new(1)) }
}

const LOOP_EVERY: Duration = Duration::from_secs(2);
const PURGE_EVERY_S: i64 = 3600;

async fn record_forever(history: Arc<History>, state: AppState) {
    let mut seen: [Option<axum::body::Bytes>; 3] = [None, None, None];
    let mut last_purge = 0;
    loop {
        let now = Timestamp::now().as_second();
        for (i, layer) in Layer::ALL.into_iter().enumerate() {
            let body = match layer {
                Layer::Planes => state.planes(),
                Layer::Ships => state.ships(),
                Layer::Transit => state.transit(),
            };
            // La réponse est remplacée d'un bloc à chaque collecte : même adresse mémoire et même taille = rien de neuf.
            // (On garde l'ancienne réponse en main : tant qu'elle vit, son adresse ne peut pas être réutilisée.)
            let Some(body) = body else { continue };
            if seen[i].as_ref().is_some_and(|old| old.as_ptr() == body.as_ptr() && old.len() == body.len()) {
                continue;
            }
            seen[i] = Some(body.clone());
            let history = history.clone();
            // Lecture du JSON et rangement : hors de la boucle asynchrone, qui sert aussi le site.
            let result = tokio::task::spawn_blocking(move || history.ingest_json(layer, &body, now)).await;
            match result {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => warn!(couche = layer.slug(), "historique : réponse illisible : {error:#}"),
                Err(error) => warn!("historique : lecture interrompue : {error}"),
            }
        }
        history.tick(now).await;
        if now - last_purge >= PURGE_EVERY_S {
            last_purge = now;
            let h = history.clone();
            let _ = tokio::task::spawn_blocking(move || {
                h.purge(now);
                for (layer, day, bytes) in h.disk_usage() {
                    info!(couche = layer.slug(), jour = day, mo = bytes / 1_000_000, "historique : volume du jour");
                }
            })
            .await;
        }
        tokio::time::sleep(LOOP_EVERY).await;
    }
}

pub fn router(handle: Option<Handle>) -> Router {
    let state = handle;
    Router::new()
        .route("/api/historique", get(availability))
        .route("/api/historique/trains", get(trains_at))
        .route("/api/historique/{layer}/{start}", get(chunk))
        .with_state(state)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Availability {
    /// Faux sans `ARCHIVE_DIR` : rien n'est enregistré.
    active: bool,
    now: i64,
    retention_days: i64,
    chunk_s: i64,
    /// Plages `[de, à]` (secondes UNIX) où il y a des données ; tout le reste est un trou.
    layers: std::collections::BTreeMap<&'static str, Vec<(i64, i64)>>,
}

async fn availability(State(handle): State<Option<Handle>>) -> impl IntoResponse {
    let now = Timestamp::now().as_second();
    let body = match handle {
        None => Availability { active: false, now, retention_days: 0, chunk_s: CHUNK_S, layers: Default::default() },
        Some(handle) => {
            // Lecture du dossier de l'archive des trains : hors de la boucle asynchrone.
            let result = tokio::task::spawn_blocking(move || {
                let mut layers: std::collections::BTreeMap<&'static str, Vec<(i64, i64)>> =
                    Layer::ALL.into_iter().map(|l| (l.slug(), handle.history.coverage(l))).collect();
                layers.insert("trains", handle.feeds.coverage());
                Availability { active: true, now, retention_days: handle.history.retention_days, chunk_s: CHUNK_S, layers }
            })
            .await;
            match result {
                Ok(body) => body,
                Err(error) => return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
            }
        }
    };
    // Change toutes les quelques secondes : le navigateur la redemande, pas de cache partagé.
    ([(header::CACHE_CONTROL, "no-cache")], Json(body)).into_response()
}

fn gzip_response(bytes: Vec<u8>, cache: &'static str) -> Response {
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    // Déjà compressé : le navigateur le défait, la couche de compression du serveur n'y touche pas.
    headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

async fn chunk(State(handle): State<Option<Handle>>, Path((layer, start)): Path<(String, i64)>) -> Response {
    let Some(handle) = handle else { return (StatusCode::NOT_FOUND, "historique désactivé").into_response() };
    let Some(layer) = Layer::from_slug(&layer) else { return (StatusCode::NOT_FOUND, "couche inconnue").into_response() };
    if start.rem_euclid(CHUNK_S) != 0 {
        return (StatusCode::BAD_REQUEST, "le début d'un tronçon est un multiple de 600 s").into_response();
    }
    let history = handle.history.clone();
    match tokio::task::spawn_blocking(move || history.serve(layer, start)).await {
        Ok(Ok(Some(Served::Closed(bytes)))) => gzip_response(bytes, "public, max-age=31536000, immutable"),
        // Encore ouvert : il grossit pendant ~13 minutes. Redemandé au plus toutes les 15 s.
        Ok(Ok(Some(Served::Open(bytes)))) => gzip_response(bytes, "public, max-age=15"),
        Ok(Ok(None)) => (StatusCode::NOT_FOUND, [(header::CACHE_CONTROL, "no-store")], "pas d'enregistrement").into_response(),
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct TrainsAt {
    from: i64,
    to: i64,
    at: i64,
}

/// Les trains d'une plage, avec les retards que le flux de la SNCF annonçait à l'instant `at`.
/// Si l'archive n'a rien d'assez proche, la réponse est celle des horaires prévus (`realtime: null`).
async fn trains_at(State(handle): State<Option<Handle>>, Query(query): Query<TrainsAt>) -> Response {
    let Some(handle) = handle else { return (StatusCode::NOT_FOUND, "historique désactivé").into_response() };
    if query.to <= query.from || query.to - query.from > crate::api::MAX_WINDOW_S {
        return (StatusCode::BAD_REQUEST, "plage horaire invalide (de 1 s à 12 h)").into_response();
    }
    let Ok(_permit) = handle.replay_lock.acquire().await else { return StatusCode::SERVICE_UNAVAILABLE.into_response() };
    let network = handle.state.network();
    let feeds = handle.feeds.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let realtime = feeds.realtime_at(query.at)?.map(|(_, realtime)| realtime);
        Ok(crate::api::trains_json(&network, realtime.as_ref(), query.from, query.to)?)
    })
    .await;
    match result {
        Ok(Ok(body)) => (
            // Le passé ne change pas, sauf si de nouveaux horaires arrivent : une heure de cache.
            [(header::CONTENT_TYPE, "application/json"), (header::CACHE_CONTROL, "public, max-age=3600")],
            body,
        )
            .into_response(),
        Ok(Err(error)) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{error:#}")).into_response(),
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response(),
    }
}
