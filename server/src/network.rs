//! Le réseau tel que l'envoie l'API : les gares et les tracés des voies entre elles.
//!
//! Il ne change qu'avec les horaires (une fois par jour) ou quand les tracés sont prêts,
//! alors que la position des trains est rafraîchie chaque minute. Il est donc publié à
//! part, sous une version qui est l'empreinte de son contenu (`/api/reseau/{version}`) :
//! le navigateur le télécharge une fois et le garde en cache, et les réponses des trains
//! y renvoient par indices.

use std::sync::Arc;

use axum::body::Bytes;
use serde::Serialize;

use crate::timetable::Timetable;
use crate::tracks::Tracks;

pub struct Network {
    pub timetable: Arc<Timetable>,
    /// Les tracés calculés pour ces horaires, s'ils sont prêts (sinon, les trains vont en ligne droite).
    pub tracks: Option<Arc<Tracks>>,
    /// Empreinte du contenu : elle change si et seulement si le réseau change.
    pub version: String,
    /// Réponse JSON prête à servir.
    pub body: Bytes,
}

#[derive(Serialize)]
struct NetworkOut<'a> {
    /// Toutes les gares des horaires (les trains y renvoient par indice).
    stations: Vec<StationOut<'a>>,
    /// Tracés sur les voies, au format « polyline » de Google étendu : quadruplets
    /// (latitude × 10⁵, longitude × 10⁵, altitude en m, vitesse maximale en km/h de la portion
    /// qui part du point, 0 si inconnue), chacun codé en écart avec le précédent.
    tracks: Vec<String>,
    /// Les deux gares (indices dans `stations`) reliées par chaque tracé, dans son sens d'écriture.
    ends: Vec<(u32, u32)>,
}

#[derive(Serialize)]
struct StationOut<'a> {
    /// Code UIC, stable d'un chargement à l'autre (l'indice, lui, change).
    code: &'a str,
    name: &'a str,
    lon: f64,
    lat: f64,
}

impl Network {
    /// `tracks` doit avoir été calculé pour `timetable`.
    pub fn new(timetable: Arc<Timetable>, tracks: Option<Arc<Tracks>>) -> Self {
        debug_assert!(tracks.as_ref().is_none_or(|t| t.timetable_id == timetable.id));
        let out = NetworkOut {
            stations: timetable.stations.iter().map(|s| StationOut { code: &s.code, name: &s.name, lon: s.lon, lat: s.lat }).collect(),
            tracks: tracks
                .iter()
                .flat_map(|t| &t.segments)
                .map(|s| encode_track(&s.points, &s.heights, &s.limits))
                .collect(),
            ends: tracks.as_ref().map(|t| t.ends()).unwrap_or_default(),
        };
        let body = serde_json::to_vec(&out).expect("le réseau se sérialise toujours");
        let version = format!("{:016x}", fnv1a(&body));
        Self { timetable, tracks, version, body: Bytes::from(body) }
    }
}

/// Empreinte FNV-1a sur 64 bits : stable d'une compilation et d'un démarrage à l'autre,
/// pour que le cache des navigateurs survive aux redémarrages du serveur.
pub(crate) fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, &b| (hash ^ u64::from(b)).wrapping_mul(0x100_0000_01b3))
}

/// Code un tracé au format « polyline » (voir `NetworkOut::tracks`) : chaque valeur est
/// l'écart avec le point précédent, écrite en caractères imprimables par paquets de 5 bits.
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

    #[test]
    fn empreinte_stable() {
        // Valeur de référence de FNV-1a 64 bits pour « a ».
        assert_eq!(fnv1a(b"a"), 0xaf63_dc4c_8601_ec8c);
    }
}
