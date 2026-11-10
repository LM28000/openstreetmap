//! État partagé entre les requêtes HTTP et les tâches de fond.
//!
//! Les horaires, le temps réel et les tracés sont remplacés d'un bloc (jamais
//! modifiés sur place) : une requête qui a pris sa copie (`Arc`) la garde cohérente
//! jusqu'au bout, même si une mise à jour arrive pendant ce temps.

use std::sync::{Arc, RwLock};

use tokio::sync::Notify;

use crate::realtime::Realtime;
use crate::timetable::Timetable;
use crate::tracks::Tracks;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    timetable: RwLock<Arc<Timetable>>,
    realtime: RwLock<Option<Arc<Realtime>>>,
    tracks: RwLock<Option<Arc<Tracks>>>,
    timetable_changed: Notify,
    /// Réponses JSON prêtes à servir, préparées par les collecteurs.
    bikes: RwLock<Option<Arc<Vec<u8>>>>,
    fires: RwLock<Option<Arc<Vec<u8>>>>,
}

impl AppState {
    pub fn new(timetable: Timetable) -> Self {
        Self(Arc::new(Inner {
            timetable: RwLock::new(Arc::new(timetable)),
            realtime: RwLock::new(None),
            tracks: RwLock::new(None),
            timetable_changed: Notify::new(),
            bikes: RwLock::new(None),
            fires: RwLock::new(None),
        }))
    }

    pub fn timetable(&self) -> Arc<Timetable> {
        self.0.timetable.read().expect("verrou des horaires").clone()
    }

    pub fn set_timetable(&self, timetable: Timetable) {
        *self.0.timetable.write().expect("verrou des horaires") = Arc::new(timetable);
        self.0.timetable_changed.notify_one();
    }

    /// Se termine à la prochaine nouvelle version des horaires.
    pub async fn timetable_changed(&self) {
        self.0.timetable_changed.notified().await;
    }

    pub fn realtime(&self) -> Option<Arc<Realtime>> {
        self.0.realtime.read().expect("verrou du temps réel").clone()
    }

    pub fn set_realtime(&self, realtime: Realtime) {
        *self.0.realtime.write().expect("verrou du temps réel") = Some(Arc::new(realtime));
    }

    /// Les tracés, seulement s'ils ont été calculés pour ces horaires-là.
    pub fn tracks_for(&self, timetable: &Timetable) -> Option<Arc<Tracks>> {
        let tracks = self.0.tracks.read().expect("verrou des tracés").clone()?;
        (tracks.timetable_id == timetable.id).then_some(tracks)
    }

    pub fn set_tracks(&self, tracks: Tracks) {
        *self.0.tracks.write().expect("verrou des tracés") = Some(Arc::new(tracks));
    }

    pub fn bikes(&self) -> Option<Arc<Vec<u8>>> {
        self.0.bikes.read().expect("verrou des vélos").clone()
    }

    pub fn set_bikes(&self, body: Vec<u8>) {
        *self.0.bikes.write().expect("verrou des vélos") = Some(Arc::new(body));
    }

    pub fn fires(&self) -> Option<Arc<Vec<u8>>> {
        self.0.fires.read().expect("verrou des feux").clone()
    }

    pub fn set_fires(&self, body: Vec<u8>) {
        *self.0.fires.write().expect("verrou des feux") = Some(Arc::new(body));
    }
}
