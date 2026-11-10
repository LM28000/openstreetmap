//! État partagé entre les requêtes HTTP et les tâches de fond.
//!
//! Le réseau (horaires et tracés) et le temps réel sont remplacés d'un bloc (jamais
//! modifiés sur place) : une requête qui a pris sa copie (`Arc`) la garde cohérente
//! jusqu'au bout, même si une mise à jour arrive pendant ce temps.

use std::sync::{Arc, RwLock};

use axum::body::Bytes;
use tokio::sync::Notify;

use crate::network::Network;
use crate::realtime::Realtime;
use crate::timetable::Timetable;
use crate::tracks::Tracks;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    /// Horaires, et tracés calculés pour eux : toujours de la même version.
    network: RwLock<Arc<Network>>,
    realtime: RwLock<Option<Arc<Realtime>>>,
    timetable_changed: Notify,
    /// Réponses JSON prêtes à servir, préparées par les collecteurs.
    bikes: RwLock<Option<Bytes>>,
    fires: RwLock<Option<Bytes>>,
    planes: RwLock<Option<Bytes>>,
    ships: RwLock<Option<Bytes>>,
    satellites: RwLock<Option<Bytes>>,
    starlink: RwLock<Option<Bytes>>,
    /// Couches rapides : bornes de recharge, trafic (événements, état des routes), vigilance météo.
    irve: RwLock<Option<Bytes>>,
    traffic: RwLock<Option<Bytes>>,
    traffic_state: RwLock<Option<Bytes>>,
    vigilance: RwLock<Option<Bytes>>,
}

impl AppState {
    pub fn new(timetable: Timetable) -> Self {
        Self(Arc::new(Inner {
            network: RwLock::new(Arc::new(Network::new(Arc::new(timetable), None))),
            realtime: RwLock::new(None),
            timetable_changed: Notify::new(),
            bikes: RwLock::new(None),
            fires: RwLock::new(None),
            planes: RwLock::new(None),
            ships: RwLock::new(None),
            satellites: RwLock::new(None),
            starlink: RwLock::new(None),
            irve: RwLock::new(None),
            traffic: RwLock::new(None),
            traffic_state: RwLock::new(None),
            vigilance: RwLock::new(None),
        }))
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

    pub fn vigilance(&self) -> Option<Bytes> {
        self.0.vigilance.read().expect("verrou de la vigilance").clone()
    }

    pub fn set_vigilance(&self, body: Vec<u8>) {
        *self.0.vigilance.write().expect("verrou de la vigilance") = Some(Bytes::from(body));
    }
}
