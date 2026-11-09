//! État partagé entre les requêtes HTTP et les tâches de fond.
//!
//! Les horaires et le temps réel sont remplacés d'un bloc (jamais modifiés sur
//! place) : une requête qui a pris sa copie (`Arc`) la garde cohérente jusqu'au
//! bout, même si une mise à jour arrive pendant ce temps.

use std::sync::{Arc, RwLock};

use crate::realtime::Realtime;
use crate::timetable::Timetable;

#[derive(Clone)]
pub struct AppState(Arc<Inner>);

struct Inner {
    timetable: RwLock<Arc<Timetable>>,
    realtime: RwLock<Option<Arc<Realtime>>>,
}

impl AppState {
    pub fn new(timetable: Timetable) -> Self {
        Self(Arc::new(Inner { timetable: RwLock::new(Arc::new(timetable)), realtime: RwLock::new(None) }))
    }

    pub fn timetable(&self) -> Arc<Timetable> {
        self.0.timetable.read().expect("verrou des horaires").clone()
    }

    pub fn set_timetable(&self, timetable: Timetable) {
        *self.0.timetable.write().expect("verrou des horaires") = Arc::new(timetable);
    }

    pub fn realtime(&self) -> Option<Arc<Realtime>> {
        self.0.realtime.read().expect("verrou du temps réel").clone()
    }

    pub fn set_realtime(&self, realtime: Realtime) {
        *self.0.realtime.write().expect("verrou du temps réel") = Some(Arc::new(realtime));
    }
}
