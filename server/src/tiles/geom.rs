//! Géométrie de tuile : du lon/lat aux coordonnées entières d'une tuile, découpage et simplification.
//!
//! # Les coordonnées
//!
//! Une tuile MVT est une grille de `EXTENT` × `EXTENT` (4096) unités. À un zoom `z`, le monde (Web Mercator)
//! compte `2^z` tuiles de large : la position « monde » d'un point est donc `x = (lon + 180) / 360 × 2^z × EXTENT`
//! (et de même pour `y`, vers le bas). La tuile `(tx, ty)` commence en `(tx × EXTENT, ty × EXTENT)` ; les
//! coordonnées locales d'un point sont sa position monde moins ce coin.
//!
//! # Découper, simplifier
//!
//! - **Découpage** (`clip_ring`, Sutherland-Hodgman) : un polygone qui déborde de la tuile est coupé au bord
//!   de la tuile *plus une marge* (`BUFFER`). La marge évite un liseré visible aux jointures de tuiles :
//!   le bord réel du polygone est dessiné par la tuile voisine, pas par la coupure.
//! - **Simplification** (`simplify`, Douglas-Peucker) : on retire les sommets qui dévient de moins d'une
//!   tolérance, exprimée en unités de tuile. À l'échelle d'une tuile 4096, 4 unités font moins d'un
//!   demi-pixel d'une tuile de 512 px : l'œil ne voit rien, la tuile pèse bien moins lourd. Comme la
//!   tolérance est en unités de *tuile*, un même polygone est automatiquement plus simplifié aux zooms bas.

use std::f64::consts::PI;

/// Taille d'une tuile, en unités de coordonnées.
pub const EXTENT: u32 = 4096;
/// Marge de découpage autour de la tuile, en unités.
pub const BUFFER: f64 = 64.0;

/// Position « monde » (en unités de tuile) d'un point lon/lat au zoom `z`.
pub fn world(lon: f64, lat: f64, z: u8) -> [f64; 2] {
    let n = f64::from(1u32 << z) * f64::from(EXTENT);
    // Le Web Mercator s'arrête vers ±85,0511° : au-delà, on borne.
    let lat = lat.clamp(-85.051_128_78, 85.051_128_78).to_radians();
    let x = (lon + 180.0) / 360.0 * n;
    let y = (1.0 - (lat.tan() + 1.0 / lat.cos()).ln() / PI) / 2.0 * n;
    [x, y]
}

/// Longitude et latitude (degrés) du coin nord-ouest de la tuile `(z, x, y)`.
pub fn tile_corner(z: u8, x: u32, y: u32) -> (f64, f64) {
    let n = f64::from(1u32 << z);
    let lon = f64::from(x) / n * 360.0 - 180.0;
    let lat = (PI * (1.0 - 2.0 * f64::from(y) / n)).sinh().atan().to_degrees();
    (lon, lat)
}

/// Étendue d'un ensemble de points.
#[derive(Clone, Copy, Debug)]
pub struct Bounds {
    pub min: [f64; 2],
    pub max: [f64; 2],
}

impl Bounds {
    pub const EMPTY: Bounds = Bounds { min: [f64::MAX; 2], max: [f64::MIN; 2] };

    pub fn add(&mut self, p: [f64; 2]) {
        for i in 0..2 {
            self.min[i] = self.min[i].min(p[i]);
            self.max[i] = self.max[i].max(p[i]);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.min[0] > self.max[0]
    }

    pub fn of(points: impl IntoIterator<Item = [f64; 2]>) -> Bounds {
        let mut bounds = Bounds::EMPTY;
        for p in points {
            bounds.add(p);
        }
        bounds
    }

    pub fn union(&mut self, other: &Bounds) {
        if !other.is_empty() {
            self.add(other.min);
            self.add(other.max);
        }
    }
}

/// Tuiles `(x, y)` du zoom `z` que touche un rectangle exprimé en positions monde du zoom `z`, marge comprise.
pub fn tile_range(bounds: &Bounds, z: u8, margin: f64) -> (u32, u32, u32, u32) {
    let last = (1u32 << z) - 1;
    let e = f64::from(EXTENT);
    let clamp = |v: f64| (v / e).floor().clamp(0.0, f64::from(last)) as u32;
    (
        clamp(bounds.min[0] - margin),
        clamp(bounds.min[1] - margin),
        clamp(bounds.max[0] + margin),
        clamp(bounds.max[1] + margin),
    )
}

/// Aire signée d'un anneau (formule du lacet), positive dans le sens horaire quand y pointe vers le bas,
/// c'est-à-dire dans le sens des anneaux extérieurs de MVT.
pub fn signed_area(ring: &[[i32; 2]]) -> i64 {
    let mut sum = 0i64;
    for i in 0..ring.len() {
        let a = ring[i];
        let b = ring[(i + 1) % ring.len()];
        sum += i64::from(a[0]) * i64::from(b[1]) - i64::from(b[0]) * i64::from(a[1]);
    }
    sum / 2
}

/// Découpe un anneau au rectangle `[min, max]` (Sutherland-Hodgman : on coupe contre chacun des quatre bords
/// l'un après l'autre). L'anneau n'a pas besoin d'être fermé ; le résultat non plus.
pub fn clip_ring(ring: &[[f64; 2]], min: [f64; 2], max: [f64; 2]) -> Vec<[f64; 2]> {
    let mut points = ring.to_vec();
    // Chaque bord : (axe, côté intérieur = bas ou haut, valeur).
    for (axis, is_min, bound) in [(0, true, min[0]), (0, false, max[0]), (1, true, min[1]), (1, false, max[1])] {
        if points.is_empty() {
            break;
        }
        let inside = |p: &[f64; 2]| if is_min { p[axis] >= bound } else { p[axis] <= bound };
        let mut out = Vec::with_capacity(points.len() + 4);
        for i in 0..points.len() {
            let (a, b) = (points[i], points[(i + 1) % points.len()]);
            let (a_in, b_in) = (inside(&a), inside(&b));
            if a_in != b_in {
                // Le segment traverse le bord : on ajoute le point d'intersection.
                let t = (bound - a[axis]) / (b[axis] - a[axis]);
                let mut p = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
                p[axis] = bound;
                out.push(p);
            }
            if b_in {
                out.push(b);
            }
        }
        points = out;
    }
    points
}

/// Douglas-Peucker sur une ligne ouverte : garde les extrémités, et récursivement le point le plus
/// éloigné du segment s'il dévie de plus de `tolerance`. Version itérative (pas de récursion profonde).
pub fn simplify(points: &[[f64; 2]], tolerance: f64) -> Vec<[f64; 2]> {
    if points.len() <= 2 || tolerance <= 0.0 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((first, last)) = stack.pop() {
        if last <= first + 1 {
            continue;
        }
        let (mut far, mut far_d) = (first, 0.0);
        for (i, p) in points.iter().enumerate().take(last).skip(first + 1) {
            let d = distance_to_segment(*p, points[first], points[last]);
            if d > far_d {
                far = i;
                far_d = d;
            }
        }
        if far_d > tolerance {
            keep[far] = true;
            stack.push((first, far));
            stack.push((far, last));
        }
    }
    points.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| *p).collect()
}

fn distance_to_segment(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len2 = dx * dx + dy * dy;
    if len2 == 0.0 {
        return (p[0] - a[0]).hypot(p[1] - a[1]);
    }
    let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2).clamp(0.0, 1.0);
    (p[0] - (a[0] + t * dx)).hypot(p[1] - (a[1] + t * dy))
}

/// Anneau fermé : simplification où les deux extrémités (identiques) ne sont plus privilégiées. On coupe
/// l'anneau au point le plus éloigné du premier, on simplifie chaque moitié, puis on les recolle.
pub fn simplify_ring(ring: &[[f64; 2]], tolerance: f64) -> Vec<[f64; 2]> {
    if ring.len() <= 4 || tolerance <= 0.0 {
        return ring.to_vec();
    }
    let far = (1..ring.len())
        .max_by(|&i, &j| {
            let d = |k: usize| (ring[k][0] - ring[0][0]).hypot(ring[k][1] - ring[0][1]);
            d(i).total_cmp(&d(j))
        })
        .unwrap_or(1);
    let first = ring[..=far].to_vec();
    let mut second = ring[far..].to_vec();
    second.push(ring[0]);
    let mut out = simplify(&first, tolerance);
    let tail = simplify(&second, tolerance);
    // `tail` commence au point le plus éloigné (déjà dans `out`) et finit au premier point (à ne pas répéter).
    out.extend(tail.iter().skip(1).take(tail.len().saturating_sub(2)));
    out
}

/// Positions « monde » (au zoom `z`) des anneaux d'un polygone en lon/lat : à calculer une fois par objet,
/// puis à donner à `polygon_in_tile` pour chaque tuile qu'il touche.
pub fn world_rings(rings: &[Vec<[f64; 2]>], z: u8) -> Vec<Vec<[f64; 2]>> {
    rings.iter().map(|ring| ring.iter().map(|p| world(p[0], p[1], z)).collect()).collect()
}

/// Un polygone (anneaux extérieur puis intérieurs, en positions monde) vu depuis la tuile `(tx, ty)` :
/// coordonnées entières locales, découpées avec marge et simplifiées. `None` s'il n'en reste rien de visible.
///
/// `min_area` : aire minimale (en unités², valeur absolue) d'un anneau ; en deçà il est trop petit pour être vu.
pub fn polygon_in_tile(world_rings: &[Vec<[f64; 2]>], tx: u32, ty: u32, tolerance: f64, min_area: f64) -> Option<Vec<Vec<[i32; 2]>>> {
    let origin = [f64::from(tx) * f64::from(EXTENT), f64::from(ty) * f64::from(EXTENT)];
    let (lo, hi) = (-BUFFER, f64::from(EXTENT) + BUFFER);
    let mut out: Vec<Vec<[i32; 2]>> = Vec::new();
    for (i, ring) in world_rings.iter().enumerate() {
        let local: Vec<[f64; 2]> = ring.iter().map(|w| [w[0] - origin[0], w[1] - origin[1]]).collect();
        let mut clipped = clip_ring(&local, [lo, lo], [hi, hi]);
        if clipped.len() >= 4 {
            clipped = simplify_ring(&clipped, tolerance);
        }
        let mut ints: Vec<[i32; 2]> = clipped.iter().map(|p| [p[0].round() as i32, p[1].round() as i32]).collect();
        ints.dedup();
        if ints.len() > 1 && ints.first() == ints.last() {
            ints.pop();
        }
        if ints.len() < 3 {
            if i == 0 {
                return None; // plus d'anneau extérieur : les trous n'ont plus de sens
            }
            continue;
        }
        let area = signed_area(&ints);
        if (area.unsigned_abs() as f64) < min_area {
            if i == 0 {
                return None;
            }
            continue;
        }
        // MVT : extérieur d'aire positive, trous d'aire négative.
        if (i == 0) != (area > 0) {
            ints.reverse();
        }
        out.push(ints);
    }
    if out.is_empty() { None } else { Some(out) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn monde_et_coin_de_tuile_sont_inverses() {
        // Le coin nord-ouest de la tuile (z, x, y) est à la position monde (x × EXTENT, y × EXTENT).
        for &(z, x, y) in &[(0u8, 0u32, 0u32), (5, 16, 11), (12, 2072, 1409)] {
            let (lon, lat) = tile_corner(z, x, y);
            let w = world(lon, lat, z);
            assert!((w[0] - f64::from(x) * 4096.0).abs() < 1e-3, "{w:?}");
            assert!((w[1] - f64::from(y) * 4096.0).abs() < 1e-3, "{w:?}");
        }
        // Le point (0, 0) est au milieu de la tuile unique du zoom 0.
        let w = world(0.0, 0.0, 0);
        assert!((w[0] - 2048.0).abs() < 1e-9 && (w[1] - 2048.0).abs() < 1e-9);
    }

    #[test]
    fn decoupage_d_un_carre_qui_deborde() {
        let square = [[-100.0, -100.0], [100.0, -100.0], [100.0, 100.0], [-100.0, 100.0]];
        let clipped = clip_ring(&square, [0.0, 0.0], [50.0, 50.0]);
        let b = Bounds::of(clipped.iter().copied());
        assert_eq!((b.min, b.max), ([0.0, 0.0], [50.0, 50.0]));
        assert_eq!(clipped.len(), 4);
        // Un carré entièrement dedans ne change pas ; entièrement dehors, il disparaît.
        assert_eq!(clip_ring(&square, [-200.0, -200.0], [200.0, 200.0]).len(), 4);
        assert!(clip_ring(&square, [300.0, 300.0], [400.0, 400.0]).is_empty());
    }

    #[test]
    fn simplification_retire_les_points_alignes_et_garde_les_coins() {
        let line: Vec<[f64; 2]> = (0..=10).map(|i| [f64::from(i), 0.0]).chain((1..=10).map(|i| [10.0, f64::from(i)])).collect();
        let s = simplify(&line, 0.5);
        assert_eq!(s, vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0]]);
        // Une bosse de 3 unités survit à une tolérance de 1, pas à une tolérance de 5.
        let bump = [[0.0, 0.0], [5.0, 3.0], [10.0, 0.0]];
        assert_eq!(simplify(&bump, 1.0).len(), 3);
        assert_eq!(simplify(&bump, 5.0).len(), 2);
    }

    #[test]
    fn simplification_d_un_anneau_ferme() {
        // Un cercle de 200 points, rayon 1000, tolérance 10 : bien moins de points, et aire à peu près conservée.
        let circle: Vec<[f64; 2]> =
            (0..200).map(|i| (f64::from(i) / 200.0 * 2.0 * PI)).map(|a| [1000.0 * a.cos(), 1000.0 * a.sin()]).collect();
        let s = simplify_ring(&circle, 10.0);
        assert!(s.len() < 60 && s.len() > 8, "{}", s.len());
        let area = |r: &[[f64; 2]]| {
            (0..r.len()).map(|i| r[i][0] * r[(i + 1) % r.len()][1] - r[(i + 1) % r.len()][0] * r[i][1]).sum::<f64>().abs() / 2.0
        };
        assert!((area(&s) / area(&circle) - 1.0).abs() < 0.02);
    }

    #[test]
    fn polygone_dans_une_tuile() {
        // Un carré de 0,01° autour de Paris, vu depuis sa tuile du zoom 12 : entier, orienté, avec ses 4 coins.
        let (lon, lat) = (2.35, 48.85);
        let ring = vec![[lon, lat], [lon + 0.01, lat], [lon + 0.01, lat + 0.01], [lon, lat + 0.01]];
        let w = world(lon, lat, 12);
        let (tx, ty) = ((w[0] / 4096.0) as u32, (w[1] / 4096.0) as u32);
        let poly = polygon_in_tile(&world_rings(&[ring.clone()], 12), tx, ty, 1.0, 0.0).expect("visible");
        assert_eq!(poly.len(), 1);
        assert_eq!(poly[0].len(), 4);
        assert!(signed_area(&poly[0]) > 0, "extérieur dans le sens positif");
        // Vu depuis une tuile lointaine : rien.
        assert!(polygon_in_tile(&world_rings(&[ring.clone()], 12), tx + 5, ty, 1.0, 0.0).is_none());
        // Au zoom 3, le même carré est plus petit qu'un pixel : l'aire minimale l'écarte.
        let w3 = world(lon, lat, 3);
        assert!(polygon_in_tile(&world_rings(&[ring], 3), (w3[0] / 4096.0) as u32, (w3[1] / 4096.0) as u32, 1.0, 4.0).is_none());
    }

    #[test]
    fn trou_est_oriente_a_l_envers() {
        let outer = vec![[2.0, 48.0], [2.1, 48.0], [2.1, 48.1], [2.0, 48.1]];
        let hole = vec![[2.04, 48.04], [2.06, 48.04], [2.06, 48.06], [2.04, 48.06]];
        let w = world(2.05, 48.05, 10);
        let poly = polygon_in_tile(&world_rings(&[outer, hole], 10), (w[0] / 4096.0) as u32, (w[1] / 4096.0) as u32, 0.5, 0.0).unwrap();
        assert_eq!(poly.len(), 2);
        assert!(signed_area(&poly[0]) > 0 && signed_area(&poly[1]) < 0);
    }
}
