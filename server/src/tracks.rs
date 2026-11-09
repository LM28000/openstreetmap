//! Tracés réels des trains : pour chaque paire de gares consécutives des horaires,
//! le chemin sur les voies OSM, avec l'altitude de chaque point.
//!
//! Calculé au démarrage en tâche de fond (le téléchargement des voies prend quelques
//! minutes la première fois, le calcul des chemins quelques secondes). En attendant,
//! les trains vont en ligne droite.

use std::collections::HashMap;
use std::path::Path;
use std::time::{Duration, Instant};

use anyhow::Result;
use tracing::{info, warn};

use crate::dem;
use crate::rails::{self, MAIN_NETWORK_NODES, MIN_COMPONENT_NODES, RailGraph, RailPath, Search, Structure, distance_m};
use crate::state::AppState;
use crate::timetable::Timetable;

/// Distance maximale entre le point d'une gare et une voie.
const SNAP_MAX_M: f64 = 1_500.0;
/// Les voies jusqu'à cette distance de plus que la plus proche restent candidates.
const SNAP_SLACK_M: f64 = 300.0;
/// Écart maximal toléré en simplifiant un tracé (environ 1,5 pixel au zoom 16).
const SIMPLIFY_M: f64 = 2.5;

/// Un tronçon de voie entre deux gares.
pub struct Segment {
    /// Points (longitude, latitude), de la gare d'indice le plus petit à l'autre.
    pub points: Vec<(f64, f64)>,
    /// Altitude du rail en chaque point, en mètres.
    pub heights: Vec<f32>,
}

pub struct Tracks {
    /// Les horaires pour lesquels ces tracés ont été calculés (voir `Timetable::id`).
    pub timetable_id: u64,
    pub segments: Vec<Segment>,
    by_pair: HashMap<(u32, u32), u32>,
    pub pair_count: usize,
}

impl Tracks {
    /// Tronçon entre deux gares (indices des horaires), et s'il faut le lire à l'envers.
    pub fn find(&self, from: u32, to: u32) -> Option<(u32, bool)> {
        let reversed = from > to;
        self.by_pair.get(&(from.min(to), from.max(to))).map(|&segment| (segment, reversed))
    }
}

/// Recalcule les tracés à chaque nouvelle version des horaires. En cas d'échec
/// (service de voies indisponible…), réessaie dix minutes plus tard.
pub async fn build_forever(http: reqwest::Client, data_dir: std::path::PathBuf, state: AppState) {
    loop {
        let timetable = state.timetable();
        match build(&http, &data_dir, &timetable).await {
            Ok(tracks) => {
                state.set_tracks(tracks);
                state.timetable_changed().await;
            }
            Err(error) => {
                warn!("tracés des trains indisponibles : {error:#} ; nouvel essai dans 10 min");
                tokio::select! {
                    () = tokio::time::sleep(Duration::from_secs(600)) => {},
                    () = state.timetable_changed() => {},
                }
            }
        }
    }
}

struct Routed {
    pair: (u32, u32),
    points: Vec<(f64, f64)>,
    structures: Vec<Structure>,
}

pub async fn build(http: &reqwest::Client, data_dir: &Path, timetable: &std::sync::Arc<Timetable>) -> Result<Tracks> {
    let rails_dir = data_dir.join("raw/osm-rails");
    rails::ensure_downloaded(http, &rails_dir).await?;

    let started = Instant::now();
    let pairs = timetable.station_pairs();
    let pair_count = pairs.len();
    let stations: Vec<(f64, f64)> = timetable.stations.iter().map(|s| (s.lon, s.lat)).collect();
    let routed = tokio::task::spawn_blocking(move || -> Result<Vec<Routed>> {
        let graph = rails::load(&rails_dir)?;
        let mut search = Search::default();
        let mut snaps: HashMap<(u32, u32), Vec<(u32, f64)>> = HashMap::new();
        let mut routed = Vec::new();
        for (a, b) in pairs {
            let (lon_a, lat_a) = stations[a as usize];
            let (lon_b, lat_b) = stations[b as usize];
            let direct = distance_m(lon_a, lat_a, lon_b, lat_b);
            // D'abord les voies les plus proches ; à défaut (gare accrochée à un îlot de voies
            // à quai sans liaison connue), seulement le grand réseau national.
            let path = [MIN_COMPONENT_NODES, MAIN_NETWORK_NODES].into_iter().find_map(|min_component| {
                let mut snap = |station: u32, lon: f64, lat: f64| {
                    snaps
                        .entry((station, min_component))
                        .or_insert_with(|| graph.candidates(lon, lat, SNAP_MAX_M, SNAP_SLACK_M, min_component))
                        .clone()
                };
                let (from, to) = (snap(a, lon_a, lat_a), snap(b, lon_b, lat_b));
                route(&graph, &from, &to, direct, &mut search)
            });
            let Some(path) = path else { continue };
            let points = path.nodes.iter().map(|&n| (graph.lon[n as usize], graph.lat[n as usize])).collect();
            routed.push(Routed { pair: (a, b), points, structures: path.structures });
        }
        Ok(routed)
    })
    .await??;
    info!(
        troncons = routed.len(),
        paires = pair_count,
        duree_s = started.elapsed().as_secs(),
        "chemins sur les voies calculés"
    );

    // Altitudes de tous les points d'un coup (chaque tuile de relief n'est lue qu'une fois).
    let all_points: Vec<(f64, f64)> = routed.iter().flat_map(|r| r.points.iter().copied()).collect();
    let heights = dem::heights(http, &data_dir.join("raw/dem"), &all_points).await?;

    let mut segments = Vec::with_capacity(routed.len());
    let mut by_pair = HashMap::with_capacity(routed.len());
    let mut offset = 0;
    let mut kept_points = 0;
    for route in routed {
        let count = route.points.len();
        let mut route_heights = heights[offset..offset + count].to_vec();
        offset += count;
        smooth_structures(&route.points, &mut route_heights, &route.structures);
        let kept = simplify(&route.points, SIMPLIFY_M);
        kept_points += kept.len();
        by_pair.insert(route.pair, segments.len() as u32);
        segments.push(Segment {
            points: kept.iter().map(|&i| route.points[i]).collect(),
            heights: kept.iter().map(|&i| route_heights[i]).collect(),
        });
    }
    info!(points = kept_points, duree_s = started.elapsed().as_secs(), "tracés des trains prêts");
    Ok(Tracks { timetable_id: timetable.id, segments, by_pair, pair_count })
}

/// Plus court chemin sur les voies entre deux ensembles de candidats, rejeté s'il fait
/// un détour énorme (signe d'une voie manquante dans OSM : la ligne droite vaut mieux).
fn route(graph: &RailGraph, from: &[(u32, f64)], to: &[(u32, f64)], direct: f64, search: &mut Search) -> Option<RailPath> {
    if from.is_empty() || to.is_empty() {
        return None; // gare loin de toute voie connue
    }
    let path = graph.shortest_path(from, to, direct * 3.0 + 20_000.0, search)?;
    (path.nodes.len() >= 2 && path.length_m <= direct * 2.5 + 10_000.0).then_some(path)
}

/// Sur un pont ou dans un tunnel, le sol (le fond de la vallée, le sommet de la
/// montagne) n'est pas à la hauteur du rail : on le remplace par une pente régulière
/// entre les deux extrémités de l'ouvrage.
fn smooth_structures(points: &[(f64, f64)], heights: &mut [f32], structures: &[Structure]) {
    let step = |k: usize| distance_m(points[k].0, points[k].1, points[k + 1].0, points[k + 1].1);
    let mut edge = 0;
    while edge < structures.len() {
        if structures[edge] == Structure::None {
            edge += 1;
            continue;
        }
        let start = edge;
        while edge < structures.len() && structures[edge] != Structure::None {
            edge += 1;
        }
        // Les arêtes start..edge relient les points start..=edge.
        let total: f64 = (start..edge).map(step).sum();
        if total <= 0.0 {
            continue;
        }
        let (first, last) = (heights[start], heights[edge]);
        let mut along = 0.0;
        for (k, height) in heights.iter_mut().enumerate().take(edge).skip(start + 1) {
            along += step(k - 1);
            *height = first + (last - first) * (along / total) as f32;
        }
    }
}

/// Algorithme de Douglas-Peucker : garde les points qui s'écartent de plus de
/// `tolerance_m` de la ligne droite entre leurs voisins gardés. Renvoie leurs indices.
fn simplify(points: &[(f64, f64)], tolerance_m: f64) -> Vec<usize> {
    if points.len() <= 2 {
        return (0..points.len()).collect();
    }
    // Projection locale en mètres, suffisante à l'échelle d'un tronçon.
    let cos_lat = points[0].1.to_radians().cos();
    let xy: Vec<(f64, f64)> = points.iter().map(|&(lon, lat)| (lon * cos_lat * 111_320.0, lat * 110_540.0)).collect();

    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0, points.len() - 1)];
    while let Some((first, last)) = stack.pop() {
        let (ax, ay) = xy[first];
        let (bx, by) = xy[last];
        let (dx, dy) = (bx - ax, by - ay);
        let length = (dx * dx + dy * dy).sqrt();
        let mut farthest = (0.0, first);
        for (i, &(px, py)) in xy.iter().enumerate().take(last).skip(first + 1) {
            let distance = if length > 0.0 {
                ((px - ax) * dy - (py - ay) * dx).abs() / length
            } else {
                ((px - ax).powi(2) + (py - ay).powi(2)).sqrt()
            };
            if distance > farthest.0 {
                farthest = (distance, i);
            }
        }
        if farthest.0 > tolerance_m {
            keep[farthest.1] = true;
            stack.push((first, farthest.1));
            stack.push((farthest.1, last));
        }
    }
    keep.iter().enumerate().filter_map(|(i, &k)| k.then_some(i)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simplification_garde_les_virages() {
        // Une ligne droite avec un coude de 50 m au milieu.
        let points = [(2.0, 48.0), (2.001, 48.0), (2.002, 48.0005), (2.003, 48.0), (2.004, 48.0)];
        assert_eq!(simplify(&points, 2.5), vec![0, 1, 2, 3, 4]);
        // Les points alignés disparaissent.
        let straight = [(2.0, 48.0), (2.001, 48.0), (2.002, 48.0), (2.003, 48.0)];
        assert_eq!(simplify(&straight, 2.5), vec![0, 3]);
    }

    #[test]
    fn tunnel_lisse_l_altitude() {
        // Entrée de tunnel à 100 m, montagne à 900 m au-dessus, sortie à 200 m.
        let points = [(2.0, 48.0), (2.01, 48.0), (2.02, 48.0), (2.03, 48.0)];
        let mut heights = [100.0, 900.0, 900.0, 200.0];
        let structures = [Structure::Tunnel, Structure::Tunnel, Structure::Tunnel];
        smooth_structures(&points, &mut heights, &structures);
        assert!((heights[1] - 133.3).abs() < 1.0 && (heights[2] - 166.7).abs() < 1.0, "{heights:?}");
    }
}
