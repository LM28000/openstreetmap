//! Serveur de la carte vivante.
//!
//! - charge les horaires SNCF (GTFS) et les remet à jour quand la SNCF en publie de nouveaux ;
//! - interroge le flux temps réel SNCF (GTFS-RT) toutes les 30 secondes, et l'archive si demandé ;
//! - calcule le tracé réel des trains sur les voies OpenStreetMap, avec leur altitude ;
//! - rassemble les vélos en libre-service de France (GBFS) et les feux détectés par satellite ;
//! - sert l'API `/api/trains` au site.
//!
//! Réglages par variables d'environnement :
//! - `HOST` (127.0.0.1) et `PORT` (8787) : adresse d'écoute ;
//! - `DATA_DIR` (../data) : où ranger les fichiers téléchargés ;
//! - `ARCHIVE_DIR` (aucun) : si défini, archive chaque version du flux temps réel ;
//! - `RUST_LOG` (info) : niveau de détail des journaux.

mod api;
mod bikes;
mod dem;
mod fires;
mod gtfs_rt;
mod network;
mod planes;
mod rails;
mod realtime;
mod state;
mod timetable;
mod tracks;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use tracing::info;
use tracing_subscriber::EnvFilter;

struct Config {
    host: IpAddr,
    port: u16,
    data_dir: PathBuf,
    archive_dir: Option<PathBuf>,
}

impl Config {
    fn from_env() -> Result<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Ok(Self {
            host: var("HOST").map(|h| h.parse()).transpose().context("HOST invalide")?.unwrap_or([127, 0, 0, 1].into()),
            port: var("PORT").map(|p| p.parse()).transpose().context("PORT invalide")?.unwrap_or(8787),
            data_dir: var("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("../data")),
            archive_dir: var("ARCHIVE_DIR").map(PathBuf::from),
        })
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info,tower_http=warn")))
        .init();
    let config = Config::from_env()?;

    let http = reqwest::Client::builder()
        .user_agent(concat!("carte-vivante/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .build()?;

    let timetable = timetable::load_or_download(&http, &config.data_dir).await?;
    let state = state::AppState::new(timetable);

    if let Some(dir) = &config.archive_dir {
        info!(dossier = %dir.display(), "archivage du temps réel activé");
    }
    tokio::spawn(realtime::poll_forever(http.clone(), state.clone(), config.archive_dir.clone()));
    tokio::spawn(timetable::refresh_forever(http.clone(), config.data_dir.clone(), state.clone()));
    tokio::spawn(tracks::build_forever(http.clone(), config.data_dir.clone(), state.clone()));
    tokio::spawn(bikes::poll_forever(http.clone(), state.clone()));
    tokio::spawn(fires::poll_forever(http.clone(), state.clone()));
    tokio::spawn(planes::poll_forever(http.clone(), state.clone()));

    let address = SocketAddr::new(config.host, config.port);
    let listener = tokio::net::TcpListener::bind(address).await.with_context(|| format!("écoute sur {address}"))?;
    info!("serveur prêt sur http://{address}");
    axum::serve(listener, api::router(state)).with_graceful_shutdown(shutdown_signal()).await?;
    Ok(())
}

/// Arrêt propre sur Ctrl+C (ou sur SIGTERM, envoyé par Docker).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    info!("arrêt du serveur");
}
