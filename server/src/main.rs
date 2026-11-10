//! Serveur de la carte vivante.
//!
//! - charge les horaires SNCF (GTFS) et les remet à jour quand la SNCF en publie de nouveaux ;
//! - interroge le flux temps réel SNCF (GTFS-RT) toutes les 30 secondes, et l'archive si demandé ;
//! - calcule le tracé réel des trains sur les voies OpenStreetMap, avec leur altitude ;
//! - rassemble les vélos en libre-service de France (GBFS) et les feux détectés par satellite ;
//! - relève les éléments orbitaux des satellites (CelesTrak), que le navigateur propage lui-même ;
//! - rassemble les bus, trams et métros en direct des réseaux qui publient leurs positions ;
//! - relève le champ de vent (Open-Meteo, modèle ARPEGE) toutes les 6 heures ;
//! - relève l'indice de qualité de l'air (Atmo Data, avec un compte) toutes les heures ;
//! - estime la position des bus, trams et métros des réseaux qui ne publient que leurs horaires en temps réel ;
//! - sert l'API `/api/trains` au site.
//!
//! Réglages par variables d'environnement :
//! - `HOST` (127.0.0.1) et `PORT` (8787) : adresse d'écoute ;
//! - `DATA_DIR` (../data) : où ranger les fichiers téléchargés ;
//! - `ARCHIVE_DIR` (aucun) : si défini, archive chaque version du flux temps réel et enregistre l'historique des avions, bateaux et transports ;
//! - `HISTORIQUE_JOURS` (7) : durée de conservation des positions enregistrées, en jours (l'archive SNCF est gardée) ;
//! - `RUST_LOG` (info) : niveau de détail des journaux ;
//! - `AISSTREAM_API_KEY` (aucune) : clé du flux des navires ; sans elle, la couche est désactivée ;
//! - `ATMO_USERNAME` et `ATMO_PASSWORD` (aucun) : compte Atmo Data pour la qualité de l'air ; sans eux, la couche est désactivée.

mod air;
mod api;
mod bikes;
mod dem;
mod estimates;
mod fires;
mod gtfs_compact;
mod gtfs_rt;
mod history;
mod idf;
mod irve;
mod multimodal;
mod network;
mod planes;
mod raptor;
mod rails;
mod realtime;
mod ships;
mod satellites;
mod state;
mod timetable;
mod tracks;
mod transit;
mod wind;
mod traffic;
mod traffic_state;
mod vigilance;

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
    /// Le site construit (`pnpm build` dans web/), servi à la racine ; absent = API seule.
    web_dir: Option<PathBuf>,
}

impl Config {
    fn from_env() -> Result<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.is_empty());
        Ok(Self {
            host: var("HOST").map(|h| h.parse()).transpose().context("HOST invalide")?.unwrap_or([127, 0, 0, 1].into()),
            port: var("PORT").map(|p| p.parse()).transpose().context("PORT invalide")?.unwrap_or(8787),
            data_dir: var("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("../data")),
            archive_dir: var("ARCHIVE_DIR").map(PathBuf::from),
            web_dir: Some(var("WEB_DIR").map_or_else(|| PathBuf::from("../web/dist"), PathBuf::from))
                .filter(|dir| dir.join("index.html").is_file()),
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
    tokio::spawn(ships::poll_forever(state.clone()));
    tokio::spawn(satellites::poll_forever(http.clone(), config.data_dir.clone(), state.clone()));
    tokio::spawn(transit::poll_forever(http.clone(), config.data_dir.clone(), state.clone()));
    tokio::spawn(wind::poll_forever(http.clone(), config.data_dir.clone(), state.clone()));
    tokio::spawn(irve::poll_forever(http.clone(), config.data_dir.clone(), state.clone()));
    tokio::spawn(traffic::poll_forever(http.clone(), state.clone()));
    tokio::spawn(traffic_state::poll_forever(http.clone(), state.clone()));
    tokio::spawn(vigilance::poll_forever(http.clone(), state.clone()));
    tokio::spawn(air::poll_forever(http.clone(), state.clone()));
    tokio::spawn(estimates::poll_forever(http.clone(), config.data_dir.clone(), state.clone()));
    tokio::spawn(multimodal::load::load_forever(http.clone(), config.data_dir.clone(), state.clone()));

    // Historique des couches mobiles (avions, bateaux, transports) et des retards des trains : demande `ARCHIVE_DIR`.
    let history = history::Settings::from_env(config.archive_dir.as_deref()).map(|settings| history::start(settings, state.clone()));

    match &config.web_dir {
        Some(dir) => info!(dossier = %dir.display(), "site servi à la racine"),
        None => info!("pas de site construit (pnpm build dans web/) : API seule"),
    }
    let address = SocketAddr::new(config.host, config.port);
    let listener = tokio::net::TcpListener::bind(address).await.with_context(|| format!("écoute sur {address}"))?;
    info!("serveur prêt sur http://{address}");
    axum::serve(listener, api::router(state, config.web_dir.as_deref()).merge(history::router(history))).with_graceful_shutdown(shutdown_signal()).await?;
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
