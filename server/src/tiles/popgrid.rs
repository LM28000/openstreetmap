//! Grille de population compacte, pour compter les habitants que touche un isochrone.
//!
//! Les 2,3 millions de carreaux de 200 m de la France métropolitaine tiennent dans ~18 Mo :
//!
//! - les carreaux sont rangés par **case de 1 km** (le repère est le LAEA EPSG:3035, en mètres : une case est un
//!   carré, et une distance est un simple théorème de Pythagore) ; une case contient au plus 5 × 5 carreaux ;
//! - un carreau est alors un **octet** (sa position dans la case, `ix × 5 + iy`) et un **f32** (ses habitants) ;
//! - un index « CSR » donne, pour chaque case, la plage de ses carreaux : `offsets[case]..offsets[case + 1]`.
//!   Les cases vides ne coûtent que 4 octets.
//!
//! # La règle
//!
//! Un carreau compte si, pour au moins un arrêt atteint, `arrivée à l'arrêt + marche de l'arrêt au centre du carreau ≤ limite`.
//! La marche est celle des correspondances à pied de `raptor.rs` : 4,5 km/h (1,25 m/s) sur la distance à vol d'oiseau
//! multipliée par 1,3 (détour des rues), plafonnée de la même façon (1,2 km autour d'une gare, 1 km autour d'un arrêt de
//! car ou de métro). Pas de marge de 3 minutes ici : elle sert à sortir d'une gare pour entrer dans une autre.
//!
//! # Le calcul
//!
//! Pour chaque arrêt atteint, on ne visite que les cases que son disque de marche touche (rayon = ce que le temps restant permet,
//! plafonné), et on garde pour chaque carreau le meilleur temps. Un carreau touché par plusieurs arrêts n'est compté qu'une fois,
//! dans la tranche de son meilleur temps. Coût : quelques arrêts × quelques cases × quelques carreaux, soit une ou deux
//! millisecondes pour toute la France.

use std::path::Path;

use anyhow::{Context, Result, bail};

/// Côté d'une case, en mètres, et nombre de carreaux de 200 m par côté de case.
const BUCKET_M: i32 = 1000;
const CELL_M: i32 = 200;
const PER_SIDE: i32 = BUCKET_M / CELL_M;

/// Vitesse de marche (m/s) et détour des rues : ceux de `raptor.rs` (`WALK_SPEED_MS`, `WALK_DETOUR`).
const WALK_SPEED_MS: f32 = 1.25;
const WALK_DETOUR: f32 = 1.3;
/// Marche maximale à partir d'une gare du réseau ferré, et d'un arrêt supplémentaire (mètres) : `WALK_RADIUS_M` et
/// `WALK_RADIUS_EXTRA_M` de `raptor.rs`.
pub const MAX_WALK_RAIL_M: f32 = 1200.0;
pub const MAX_WALK_EXTRA_M: f32 = 1000.0;

const MAGIC: &[u8; 8] = b"CVPOPG01";

pub struct PopGrid {
    /// Indices de la case en bas à gauche de la grille (mètres / 1000).
    e0: i32,
    n0: i32,
    /// Largeur et hauteur en cases.
    w: u32,
    h: u32,
    offsets: Vec<u32>,
    pos: Vec<u8>,
    pop: Vec<f32>,
}

/// Position d'un arrêt dans le repère de la grille, et marche maximale à partir de lui (mètres).
#[derive(Clone, Copy, Debug)]
pub struct StopPos {
    pub e: f32,
    pub n: f32,
    pub max_walk: f32,
}

impl StopPos {
    /// `(longitude, latitude)` d'une gare du réseau ferré ou d'un arrêt supplémentaire.
    pub fn new(lon: f64, lat: f64, rail: bool) -> StopPos {
        let (e, n) = super::proj::laea_forward(lon, lat);
        StopPos { e: e as f32, n: n as f32, max_walk: if rail { MAX_WALK_RAIL_M } else { MAX_WALK_EXTRA_M } }
    }
}

/// Un arrêt atteint : position dans le repère LAEA (mètres), arrivée (secondes après le départ), marche maximale (mètres).
#[derive(Clone, Copy)]
pub struct Source {
    pub e: f32,
    pub n: f32,
    pub arrival: i32,
    pub max_walk: f32,
}

/// Habitants atteints : total, et par tranche de temps de `band_s` secondes (la tranche `i` : de `i × band_s` à `(i + 1) × band_s`).
#[derive(Clone, Debug, PartialEq)]
pub struct Reach {
    pub total: f64,
    pub bands: Vec<f64>,
}

impl PopGrid {
    /// Construit la grille à partir de carreaux `(est, nord du coin sud-ouest, habitants)` en mètres LAEA.
    pub fn build(cells: &[(i32, i32, f32)]) -> PopGrid {
        let bucket = |v: i32| v.div_euclid(BUCKET_M);
        let (mut e_min, mut e_max, mut n_min, mut n_max) = (i32::MAX, i32::MIN, i32::MAX, i32::MIN);
        for &(e, n, _) in cells {
            e_min = e_min.min(bucket(e));
            e_max = e_max.max(bucket(e));
            n_min = n_min.min(bucket(n));
            n_max = n_max.max(bucket(n));
        }
        if cells.is_empty() {
            return PopGrid { e0: 0, n0: 0, w: 0, h: 0, offsets: vec![0], pos: Vec::new(), pop: Vec::new() };
        }
        let (w, h) = ((e_max - e_min + 1) as u32, (n_max - n_min + 1) as u32);
        let index = |e: i32, n: i32| ((bucket(n) - n_min) as u32 * w + (bucket(e) - e_min) as u32) as usize;
        // Tri par comptage : on compte les carreaux de chaque case, puis on les range.
        let mut offsets = vec![0u32; (w * h) as usize + 1];
        for &(e, n, _) in cells {
            offsets[index(e, n) + 1] += 1;
        }
        for i in 0..(w * h) as usize {
            offsets[i + 1] += offsets[i];
        }
        let mut next = offsets.clone();
        let mut pos = vec![0u8; cells.len()];
        let mut pop = vec![0f32; cells.len()];
        for &(e, n, ind) in cells {
            let at = &mut next[index(e, n)];
            let ix = e.rem_euclid(BUCKET_M) / CELL_M;
            let iy = n.rem_euclid(BUCKET_M) / CELL_M;
            pos[*at as usize] = (ix * PER_SIDE + iy) as u8;
            pop[*at as usize] = ind;
            *at += 1;
        }
        PopGrid { e0: e_min, n0: n_min, w, h, offsets, pos, pop }
    }

    pub fn cell_count(&self) -> usize {
        self.pop.len()
    }

    /// Mémoire occupée (octets).
    pub fn bytes(&self) -> usize {
        self.offsets.len() * 4 + self.pos.len() + self.pop.len() * 4
    }

    pub fn total_population(&self) -> f64 {
        self.pop.iter().map(|&p| f64::from(p)).sum()
    }

    /// Habitants atteints en `limit_s` secondes, par tranche de `band_s`.
    pub fn reach(&self, sources: &[Source], limit_s: i32, band_s: i32) -> Reach {
        let band_count = ((limit_s + band_s - 1) / band_s).max(1) as usize;
        let mut bands = vec![0f64; band_count];
        if self.pop.is_empty() {
            return Reach { total: 0.0, bands };
        }
        // Meilleur temps de chaque carreau (u16 : les isochrones vont jusqu'à 12 h = 43 200 s), et la liste de ceux qu'on a touchés.
        let mut best = vec![u16::MAX; self.pop.len()];
        let mut touched: Vec<u32> = Vec::new();
        let seconds_per_meter = WALK_DETOUR / WALK_SPEED_MS;
        for s in sources {
            let left = limit_s - s.arrival;
            if left < 0 {
                continue;
            }
            // Ce que le temps restant permet de marcher, plafonné.
            let radius = (left as f32 / seconds_per_meter).min(s.max_walk);
            let r2 = radius * radius;
            let b = |v: f32| (v / BUCKET_M as f32).floor() as i32;
            let (bx0, bx1) = ((b(s.e - radius) - self.e0).max(0), (b(s.e + radius) - self.e0).min(self.w as i32 - 1));
            let (by0, by1) = ((b(s.n - radius) - self.n0).max(0), (b(s.n + radius) - self.n0).min(self.h as i32 - 1));
            for by in by0..=by1 {
                for bx in bx0..=bx1 {
                    let bucket = (by as u32 * self.w + bx as u32) as usize;
                    let origin_e = ((self.e0 + bx) * BUCKET_M) as f32;
                    let origin_n = ((self.n0 + by) * BUCKET_M) as f32;
                    for i in self.offsets[bucket] as usize..self.offsets[bucket + 1] as usize {
                        let p = i32::from(self.pos[i]);
                        let de = origin_e + (p / PER_SIDE * CELL_M + CELL_M / 2) as f32 - s.e;
                        let dn = origin_n + (p % PER_SIDE * CELL_M + CELL_M / 2) as f32 - s.n;
                        let d2 = de * de + dn * dn;
                        if d2 > r2 {
                            continue;
                        }
                        let t = s.arrival + (d2.sqrt() * seconds_per_meter).ceil() as i32;
                        if t <= limit_s && (t as u32) < u32::from(best[i]) {
                            if best[i] == u16::MAX {
                                touched.push(i as u32);
                            }
                            best[i] = t as u16;
                        }
                    }
                }
            }
        }
        let mut total = 0.0;
        for &i in &touched {
            let band = (i32::from(best[i as usize]) / band_s).min(band_count as i32 - 1) as usize;
            let pop = f64::from(self.pop[i as usize]);
            bands[band] += pop;
            total += pop;
        }
        Reach { total, bands }
    }

    // --- Fichier ---

    pub fn write(&self, path: &Path) -> Result<()> {
        let mut out = Vec::with_capacity(self.bytes() + 32);
        out.extend_from_slice(MAGIC);
        for v in [self.e0, self.n0] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in [self.w, self.h, self.pop.len() as u32] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for o in &self.offsets {
            out.extend_from_slice(&o.to_le_bytes());
        }
        out.extend_from_slice(&self.pos);
        for p in &self.pop {
            out.extend_from_slice(&p.to_le_bytes());
        }
        let partial = path.with_extension("partiel");
        std::fs::write(&partial, out)?;
        std::fs::rename(partial, path)?;
        Ok(())
    }

    pub fn read(path: &Path) -> Result<PopGrid> {
        let bytes = std::fs::read(path).with_context(|| format!("lecture de {}", path.display()))?;
        if bytes.len() < 28 || &bytes[..8] != MAGIC {
            bail!("grille de population invalide");
        }
        let int = |at: usize| i32::from_le_bytes(bytes[at..at + 4].try_into().expect("4 octets"));
        let (e0, n0) = (int(8), int(12));
        let (w, h, n) = (int(16) as u32, int(20) as u32, int(24) as usize);
        let cells = (w as usize) * (h as usize);
        let expected = 28 + (cells + 1) * 4 + n + n * 4;
        if bytes.len() != expected {
            bail!("grille de population tronquée ({} octets au lieu de {expected})", bytes.len());
        }
        let mut at = 28;
        let offsets: Vec<u32> = bytes[at..at + (cells + 1) * 4].chunks_exact(4).map(|c| u32::from_le_bytes(c.try_into().expect("4 octets"))).collect();
        at += (cells + 1) * 4;
        let pos = bytes[at..at + n].to_vec();
        at += n;
        let pop: Vec<f32> = bytes[at..at + n * 4].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().expect("4 octets"))).collect();
        Ok(PopGrid { e0, n0, w, h, offsets, pos, pop })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Une grille de 20 × 20 carreaux de 200 m (4 km de côté), 10 habitants par carreau.
    fn square() -> PopGrid {
        let cells: Vec<(i32, i32, f32)> =
            (0..20).flat_map(|i| (0..20).map(move |j| (3_000_000 + i * 200, 2_000_000 + j * 200, 10.0))).collect();
        PopGrid::build(&cells)
    }

    #[test]
    fn construction_et_total() {
        let grid = square();
        assert_eq!(grid.cell_count(), 400);
        assert_eq!(grid.total_population(), 4000.0);
        // ~5 octets par carreau (+ l'index des cases).
        assert!(grid.bytes() < 400 * 5 + 100);
    }

    #[test]
    fn disque_de_marche_autour_d_un_arret() {
        let grid = square();
        // Un arrêt au milieu (3 002 000, 2 002 000), atteint à l'instant 0, 10 minutes de marge : rayon = min(max_walk, 600 s / 1,04 s/m).
        let source = Source { e: 3_002_000.0, n: 2_002_000.0, arrival: 0, max_walk: 1000.0 };
        let reach = grid.reach(&[source], 600, 300);
        // Rayon 576 m (600 s / 1,04) : ~ π × 576² / 40 000 m² = 26 carreaux, de 10 habitants.
        assert!((200.0..=320.0).contains(&reach.total), "{}", reach.total);
        // Deux tranches de 5 minutes : la première (≤ 300 s, ≤ 288 m) en a moins que la seconde.
        assert_eq!(reach.bands.len(), 2);
        assert!(reach.bands[0] < reach.bands[1]);
        assert_eq!(reach.bands[0] + reach.bands[1], reach.total);
        // Plafond de marche : 300 m au plus, même avec beaucoup de temps.
        let capped = grid.reach(&[Source { max_walk: 300.0, ..source }], 3600, 3600);
        assert!(capped.total < reach.total && capped.total >= 40.0, "{}", capped.total);
        // Arrivée trop tardive : rien.
        assert_eq!(grid.reach(&[Source { arrival: 700, ..source }], 600, 300).total, 0.0);
    }

    #[test]
    fn un_carreau_n_est_compte_qu_une_fois_au_meilleur_temps() {
        let grid = square();
        let near = Source { e: 3_002_000.0, n: 2_002_000.0, arrival: 0, max_walk: 1000.0 };
        // Le même arrêt, mais atteint plus tard : ne change rien au résultat.
        let late = Source { arrival: 200, ..near };
        let alone = grid.reach(&[near], 1200, 600);
        let both = grid.reach(&[late, near, late], 1200, 600);
        assert_eq!(alone, both);
        // Un arrêt lointain atteint tôt pousse des carreaux dans la première tranche.
        let far = Source { e: 3_003_500.0, n: 2_003_500.0, arrival: 0, max_walk: 1000.0 };
        let two = grid.reach(&[near, far], 1200, 600);
        assert!(two.total > alone.total);
    }

    #[test]
    fn aller_retour_fichier() {
        let grid = square();
        let path = std::env::temp_dir().join(format!("carte-vivante-popgrid-{}.bin", std::process::id()));
        grid.write(&path).unwrap();
        let back = PopGrid::read(&path).unwrap();
        let source = Source { e: 3_002_000.0, n: 2_002_000.0, arrival: 0, max_walk: 1000.0 };
        assert_eq!(back.reach(&[source], 900, 300), grid.reach(&[source], 900, 300));
        assert_eq!(back.cell_count(), 400);
        std::fs::remove_file(&path).ok();
        assert!(PopGrid::read(&path).is_err());
    }

    #[test]
    fn grille_vide_ou_hors_zone() {
        assert_eq!(PopGrid::build(&[]).reach(&[], 600, 300).total, 0.0);
        let grid = square();
        // Un arrêt à Paris (loin de la grille d'essai) ne touche rien et ne plante pas.
        let paris = Source { e: 3_760_000.0, n: 2_890_000.0, arrival: 0, max_walk: 1200.0 };
        assert_eq!(grid.reach(&[paris], 3600, 1800).total, 0.0);
    }
}
