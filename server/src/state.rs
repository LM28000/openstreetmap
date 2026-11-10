//! État partagé entre les requêtes HTTP et les tâches de fond.
//!
//! Le réseau (horaires et tracés) et le temps réel sont remplacés d'un bloc (jamais
//! modifiés sur place) : une requête qui a pris sa copie (`Arc`) la garde cohérente
//! jusqu'au bout, même si une mise à jour arrive pendant ce temps.

use std::sync::{Arc, Mutex, RwLock};

use axum::body::Bytes;
use tokio::sync::Notify;

use crate::multimodal::Extras;
use crate::network::Network;
use crate::realtime::Realtime;
use crate::timetable::Timetable;
use crate::transit::{TransitPart, TransitParts};
use crate::tracks::Tracks;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    /// Horaires, et tracés calculés pour eux : toujours de la même version.
    network: RwLock<Arc<Network>>,
    realtime: RwLock<Option<Arc<Realtime>>>,
    /// Cars et transports d'Île-de-France des isochrones, construits pour une version des horaires du rail (voir `multimodal.rs`).
    extras: RwLock<Option<Arc<Extras>>>,
    timetable_changed: Notify,
    /// Réponses JSON prêtes à servir, préparées par les collecteurs.
    bikes: RwLock<Option<Bytes>>,
    fires: RwLock<Option<Bytes>>,
    planes: RwLock<Option<Bytes>>,
    ships: RwLock<Option<Bytes>>,
    satellites: RwLock<Option<Bytes>>,
    starlink: RwLock<Option<Bytes>>,
    transit: RwLock<Option<Bytes>>,
    wind: RwLock<Option<Bytes>>,
    /// Couches rapides : bornes de recharge, trafic (événements, état des routes), vigilance météo.
    irve: RwLock<Option<Bytes>>,
    traffic: RwLock<Option<Bytes>>,
    traffic_state: RwLock<Option<Bytes>>,
    vigilance: RwLock<Option<Bytes>>,
    /// Qualité de l'air, et la raison de son absence quand la couche est désactivée (pas d'identifiants).
    air: RwLock<Option<Bytes>>,
    air_disabled: RwLock<Option<&'static str>>,
    /// Les deux morceaux de la réponse des transports (positions publiées, positions estimées), assemblés en `transit`.
    transit_parts: Mutex<TransitParts>,
    /// Tuiles vectorielles (population…) et la grille de population des isochrones (voir `tiles/`).
    tiles: crate::tiles::Registry,
}

impl AppState {
    pub fn new(timetable: Timetable) -> Self {
        Self(Arc::new(Inner {
            network: RwLock::new(Arc::new(Network::new(Arc::new(timetable), None))),
            realtime: RwLock::new(None),
            extras: RwLock::new(None),
            timetable_changed: Notify::new(),
            bikes: RwLock::new(None),
            fires: RwLock::new(None),
            planes: RwLock::new(None),
            ships: RwLock::new(None),
            satellites: RwLock::new(None),
            starlink: RwLock::new(None),
            transit: RwLock::new(None),
            wind: RwLock::new(None),
            irve: RwLock::new(None),
            traffic: RwLock::new(None),
            traffic_state: RwLock::new(None),
            vigilance: RwLock::new(None),
            air: RwLock::new(None),
            air_disabled: RwLock::new(None),
            transit_parts: Mutex::default(),
            tiles: crate::tiles::Registry::new(),
        }))
    }

    pub fn tiles(&self) -> &crate::tiles::Registry {
        &self.0.tiles
    }

    pub fn network(&self) -> Arc<Network> {
        self.0.network.read().expect("verrou du réseau").clone()
    }

    pub fn timetable(&self) -> Arc<Timetable> {
        self.network().timetable.clone()
    }

    /// Nouveaux horaires : les anciens tracés ne valent plus (les indices de gares changent).
    pub fn set_timetable(&self, timetable: Timetable) {
        let network = Arc::new(Network::new(Arc::new(timetable), None));
        *self.0.network.write().expect("verrou du réseau") = network;
        self.0.timetable_changed.notify_one();
    }

    /// Se termine à la prochaine nouvelle version des horaires.
    pub async fn timetable_changed(&self) {
        self.0.timetable_changed.notified().await;
    }

    /// Tracés prêts : ignorés si les horaires ont changé pendant leur calcul.
    pub fn set_tracks(&self, tracks: Tracks) {
        let timetable = self.timetable();
        if timetable.id != tracks.timetable_id {
            return;
        }
        let network = Arc::new(Network::new(timetable, Some(Arc::new(tracks))));
        let mut current = self.0.network.write().expect("verrou du réseau");
        if current.timetable.id == network.timetable.id {
            *current = network;
        }
    }

    pub fn extras(&self) -> Option<Arc<Extras>> {
        self.0.extras.read().expect("verrou des isochrones multimodales").clone()
    }

    pub fn set_extras(&self, extras: Extras) {
        *self.0.extras.write().expect("verrou des isochrones multimodales") = Some(Arc::new(extras));
    }

    pub fn realtime(&self) -> Option<Arc<Realtime>> {
        self.0.realtime.read().expect("verrou du temps réel").clone()
    }

    pub fn set_realtime(&self, realtime: Realtime) {
        *self.0.realtime.write().expect("verrou du temps réel") = Some(Arc::new(realtime));
    }

    pub fn bikes(&self) -> Option<Bytes> {
        self.0.bikes.read().expect("verrou des vélos").clone()
    }

    pub fn set_bikes(&self, body: Vec<u8>) {
        *self.0.bikes.write().expect("verrou des vélos") = Some(Bytes::from(body));
    }

    pub fn fires(&self) -> Option<Bytes> {
        self.0.fires.read().expect("verrou des feux").clone()
    }

    pub fn set_fires(&self, body: Vec<u8>) {
        *self.0.fires.write().expect("verrou des feux") = Some(Bytes::from(body));
    }

    pub fn planes(&self) -> Option<Bytes> {
        self.0.planes.read().expect("verrou des avions").clone()
    }

    pub fn set_planes(&self, body: Vec<u8>) {
        *self.0.planes.write().expect("verrou des avions") = Some(Bytes::from(body));
    }

    pub fn ships(&self) -> Option<Bytes> {
        self.0.ships.read().expect("verrou des bateaux").clone()
    }

    pub fn set_ships(&self, body: Vec<u8>) {
        *self.0.ships.write().expect("verrou des bateaux") = Some(Bytes::from(body));
    }

    pub fn satellites(&self) -> Option<Bytes> {
        self.0.satellites.read().expect("verrou des satellites").clone()
    }

    pub fn set_satellites(&self, body: Vec<u8>) {
        *self.0.satellites.write().expect("verrou des satellites") = Some(Bytes::from(body));
    }

    pub fn starlink(&self) -> Option<Bytes> {
        self.0.starlink.read().expect("verrou de Starlink").clone()
    }

    pub fn set_starlink(&self, body: Vec<u8>) {
        *self.0.starlink.write().expect("verrou de Starlink") = Some(Bytes::from(body));
    }

    pub fn transit(&self) -> Option<Bytes> {
        self.0.transit.read().expect("verrou des transports").clone()
    }

    /// Met à jour un des deux morceaux de la réponse et refait la réponse entière.
    pub fn set_transit_part(&self, part: TransitPart) {
        let mut parts = self.0.transit_parts.lock().expect("verrou des morceaux des transports");
        parts.set(part);
        match parts.to_json() {
            Some(Ok(body)) => *self.0.transit.write().expect("verrou des transports") = Some(Bytes::from(body)),
            Some(Err(error)) => tracing::warn!("transports : réponse non préparée : {error:#}"),
            None => {}
        }
    }

    pub fn wind(&self) -> Option<Bytes> {
        self.0.wind.read().expect("verrou du vent").clone()
    }

    pub fn set_wind(&self, body: Vec<u8>) {
        *self.0.wind.write().expect("verrou du vent") = Some(Bytes::from(body));
    }

    pub fn irve(&self) -> Option<Bytes> {
        self.0.irve.read().expect("verrou des bornes").clone()
    }

    pub fn set_irve(&self, body: Vec<u8>) {
        *self.0.irve.write().expect("verrou des bornes") = Some(Bytes::from(body));
    }

    pub fn traffic(&self) -> Option<Bytes> {
        self.0.traffic.read().expect("verrou du trafic").clone()
    }

    pub fn set_traffic(&self, body: Vec<u8>) {
        *self.0.traffic.write().expect("verrou du trafic") = Some(Bytes::from(body));
    }

    pub fn traffic_state(&self) -> Option<Bytes> {
        self.0.traffic_state.read().expect("verrou de l'état du trafic").clone()
    }

    pub fn set_traffic_state(&self, body: Vec<u8>) {
        *self.0.traffic_state.write().expect("verrou de l'état du trafic") = Some(Bytes::from(body));
    }

    pub fn air(&self) -> Option<Bytes> {
        self.0.air.read().expect("verrou de la qualité de l'air").clone()
    }

    pub fn set_air(&self, body: Vec<u8>) {
        *self.0.air.write().expect("verrou de la qualité de l'air") = Some(Bytes::from(body));
    }

    pub fn air_disabled(&self) -> Option<&'static str> {
        *self.0.air_disabled.read().expect("verrou de la qualité de l'air")
    }

    pub fn set_air_disabled(&self, reason: &'static str) {
        *self.0.air_disabled.write().expect("verrou de la qualité de l'air") = Some(reason);
    }

    pub fn vigilance(&self) -> Option<Bytes> {
        self.0.vigilance.read().expect("verrou de la vigilance").clone()
    }

    pub fn set_vigilance(&self, body: Vec<u8>) {
        *self.0.vigilance.write().expect("verrou de la vigilance") = Some(Bytes::from(body));
    }
}
