//! Projections cartographiques dont on a besoin, écrites à la main (quelques lignes chacune).
//!
//! - **ETRS89-LAEA (EPSG:3035)** : la projection européenne « à surfaces égales » dans laquelle l'INSEE
//!   numérote ses carreaux de 200 m (`CRS3035RES200mN2029800E3210400` : le coin sud-ouest du carreau est à
//!   2 029 800 m au nord et 3 210 400 m à l'est de l'origine). Formules de Snyder, ellipsoïde GRS80.
//! - **UTM** (Martinique : RGAF09 UTM 20N, EPSG:5490 ; La Réunion : RGR92 UTM 40S, EPSG:2975) : projection
//!   de Mercator transverse, inversée par les séries de Krüger. Les ellipsoïdes des deux repères sont, à
//!   quelques centimètres près, le GRS80 : c'est très en deçà de la taille d'un carreau.
//!
//! Les carreaux d'un même pays sont des carrés dans *leur* projection, mais des quadrilatères légèrement
//! inclinés sur le Web Mercator de l'écran : on passe donc par les coins du carreau, un à un.

use std::f64::consts::PI;

/// Ellipsoïde GRS80.
const A: f64 = 6_378_137.0;
const F: f64 = 1.0 / 298.257_222_101;
const E2: f64 = F * (2.0 - F);

/// Repères dans lesquels l'INSEE publie ses carreaux.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Crs {
    /// EPSG:3035, la France métropolitaine.
    Laea,
    /// EPSG:5490, la Martinique.
    UtmMartinique,
    /// EPSG:2975, La Réunion.
    UtmReunion,
}

impl Crs {
    pub const ALL: [Crs; 3] = [Crs::Laea, Crs::UtmMartinique, Crs::UtmReunion];

    /// Numéro EPSG, tel qu'il figure dans les identifiants de carreaux (`CRS3035RES…`).
    pub fn epsg(self) -> u32 {
        match self {
            Crs::Laea => 3035,
            Crs::UtmMartinique => 5490,
            Crs::UtmReunion => 2975,
        }
    }

    pub fn from_epsg(code: u32) -> Option<Crs> {
        Crs::ALL.into_iter().find(|crs| crs.epsg() == code)
    }

    /// Petit numéro stable pour les fichiers intermédiaires.
    pub fn index(self) -> u8 {
        Crs::ALL.iter().position(|&c| c == self).unwrap_or(0) as u8
    }

    pub fn from_index(index: u8) -> Crs {
        Crs::ALL[(index as usize).min(Crs::ALL.len() - 1)]
    }

    /// Mètres (est, nord) → (longitude, latitude) en degrés.
    pub fn to_lonlat(self, e: f64, n: f64) -> (f64, f64) {
        match self {
            Crs::Laea => laea_inverse(e, n),
            Crs::UtmMartinique => utm_inverse(e, n, -63.0, 0.0),
            Crs::UtmReunion => utm_inverse(e, n, 57.0, 10_000_000.0),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// LAEA
// ---------------------------------------------------------------------------------------------

const LAEA_LAT0: f64 = 52.0;
const LAEA_LON0: f64 = 10.0;
const LAEA_FE: f64 = 4_321_000.0;
const LAEA_FN: f64 = 3_210_000.0;

/// Fonction `q` de Snyder : aire (normalisée) de la bande de la sphère authalique jusqu'à la latitude `phi`.
fn q(phi: f64) -> f64 {
    let e = E2.sqrt();
    let s = phi.sin();
    (1.0 - E2) * (s / (1.0 - E2 * s * s) - (1.0 / (2.0 * e)) * ((1.0 - e * s) / (1.0 + e * s)).ln())
}

/// Constantes de la projection.
struct Laea {
    qp: f64,
    beta0: f64,
    rq: f64,
    d: f64,
}

/// Calculées une seule fois : cette projection est appelée des millions de fois (un coin par carreau).
fn laea() -> &'static Laea {
    static CONSTANTS: std::sync::OnceLock<Laea> = std::sync::OnceLock::new();
    CONSTANTS.get_or_init(|| {
        let phi0 = LAEA_LAT0.to_radians();
        let qp = q(PI / 2.0);
        let beta0 = (q(phi0) / qp).asin();
        let rq = A * (qp / 2.0).sqrt();
        let d = A * (phi0.cos() / (1.0 - E2 * phi0.sin().powi(2)).sqrt()) / (rq * beta0.cos());
        Laea { qp, beta0, rq, d }
    })
}

/// (longitude, latitude) en degrés → mètres (est, nord) EPSG:3035.
pub fn laea_forward(lon: f64, lat: f64) -> (f64, f64) {
    let p = laea();
    let phi = lat.to_radians();
    let dl = (lon - LAEA_LON0).to_radians();
    let beta = (q(phi) / p.qp).asin();
    let b = p.rq * (2.0 / (1.0 + p.beta0.sin() * beta.sin() + p.beta0.cos() * beta.cos() * dl.cos())).sqrt();
    let x = b * p.d * beta.cos() * dl.sin();
    let y = (b / p.d) * (p.beta0.cos() * beta.sin() - p.beta0.sin() * beta.cos() * dl.cos());
    (LAEA_FE + x, LAEA_FN + y)
}

/// Mètres (est, nord) EPSG:3035 → (longitude, latitude) en degrés.
pub fn laea_inverse(e: f64, n: f64) -> (f64, f64) {
    let p = laea();
    let x = e - LAEA_FE;
    let y = n - LAEA_FN;
    let rho = ((x / p.d).powi(2) + (p.d * y).powi(2)).sqrt();
    if rho < 1e-9 {
        return (LAEA_LON0, LAEA_LAT0);
    }
    let ce = 2.0 * (rho / (2.0 * p.rq)).asin();
    let beta = (ce.cos() * p.beta0.sin() + p.d * y * ce.sin() * p.beta0.cos() / rho).asin();
    let lon = LAEA_LON0.to_radians()
        + (x * ce.sin()).atan2(p.d * rho * p.beta0.cos() * ce.cos() - p.d * p.d * y * p.beta0.sin() * ce.sin());
    // Latitude géodésique à partir de la latitude authalique : série en sin(2β), sin(4β), sin(6β).
    let (e4, e6) = (E2 * E2, E2 * E2 * E2);
    let phi = beta
        + (E2 / 3.0 + 31.0 * e4 / 180.0 + 517.0 * e6 / 5040.0) * (2.0 * beta).sin()
        + (23.0 * e4 / 360.0 + 251.0 * e6 / 3780.0) * (4.0 * beta).sin()
        + (761.0 * e6 / 45360.0) * (6.0 * beta).sin();
    (lon.to_degrees(), phi.to_degrees())
}

// ---------------------------------------------------------------------------------------------
// UTM (Mercator transverse), inverse seulement
// ---------------------------------------------------------------------------------------------

const UTM_K0: f64 = 0.9996;
const UTM_FE: f64 = 500_000.0;

/// Mètres (est, nord) UTM → (longitude, latitude) en degrés. `lon0` : méridien central ; `false_northing` : 0 au nord, 10 000 000 au sud.
fn utm_inverse(e: f64, n: f64, lon0: f64, false_northing: f64) -> (f64, f64) {
    let nn = F / (2.0 - F);
    let a_big = A / (1.0 + nn) * (1.0 + nn * nn / 4.0 + nn.powi(4) / 64.0);
    let beta = [
        nn / 2.0 - 2.0 * nn * nn / 3.0 + 37.0 * nn.powi(3) / 96.0 - nn.powi(4) / 360.0,
        nn * nn / 48.0 + nn.powi(3) / 15.0 - 437.0 * nn.powi(4) / 1440.0,
        17.0 * nn.powi(3) / 480.0 - 37.0 * nn.powi(4) / 840.0,
        4397.0 * nn.powi(4) / 161_280.0,
    ];
    let delta = [
        2.0 * nn - 2.0 * nn * nn / 3.0 - 2.0 * nn.powi(3) + 116.0 * nn.powi(4) / 45.0,
        7.0 * nn * nn / 3.0 - 8.0 * nn.powi(3) / 5.0 - 227.0 * nn.powi(4) / 45.0,
        56.0 * nn.powi(3) / 15.0 - 136.0 * nn.powi(4) / 35.0,
        4279.0 * nn.powi(4) / 630.0,
    ];
    let xi = (n - false_northing) / (UTM_K0 * a_big);
    let eta = (e - UTM_FE) / (UTM_K0 * a_big);
    let mut xi_p = xi;
    let mut eta_p = eta;
    for (j, b) in beta.iter().enumerate() {
        let k = 2.0 * (j as f64 + 1.0);
        xi_p -= b * (k * xi).sin() * (k * eta).cosh();
        eta_p -= b * (k * xi).cos() * (k * eta).sinh();
    }
    let chi = (xi_p.sin() / eta_p.cosh()).asin();
    let mut phi = chi;
    for (j, d) in delta.iter().enumerate() {
        phi += d * (2.0 * (j as f64 + 1.0) * chi).sin();
    }
    let lon = lon0 + (eta_p.sinh() / xi_p.cos()).atan().to_degrees();
    (lon, phi.to_degrees())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn laea_exemple_epsg() {
        // Exemple officiel du guide EPSG GN7-2 : 50° N, 5° E → E 3 962 799,45 m, N 2 999 718,85 m.
        let (e, n) = laea_forward(5.0, 50.0);
        assert!((e - 3_962_799.45).abs() < 0.05, "E = {e}");
        assert!((n - 2_999_718.85).abs() < 0.05, "N = {n}");
        let (lon, lat) = laea_inverse(e, n);
        assert!((lon - 5.0).abs() < 1e-7 && (lat - 50.0).abs() < 1e-7, "{lon} {lat}");
    }

    #[test]
    fn laea_aller_retour_france() {
        for &(lon, lat) in &[(2.3522, 48.8566), (-4.4861, 48.3904), (9.45, 42.0), (7.75, 48.58), (-1.55, 43.4)] {
            let (e, n) = laea_forward(lon, lat);
            let (l2, p2) = laea_inverse(e, n);
            assert!((l2 - lon).abs() < 1e-7 && (p2 - lat).abs() < 1e-7);
        }
        // Paris est au nord-ouest du centre de la grille.
        let (e, n) = laea_forward(2.3522, 48.8566);
        assert!((3_750_000.0..3_770_000.0).contains(&e) && (2_880_000.0..2_900_000.0).contains(&n), "{e} {n}");
    }

    #[test]
    fn utm_outre_mer() {
        // Carreaux des fichiers INSEE : Martinique (E 728 800, N 1 592 600) et La Réunion (E 359 400, N 7 634 200).
        let (lon, lat) = Crs::UtmMartinique.to_lonlat(728_800.0, 1_592_600.0);
        assert!((-61.1..-60.7).contains(&lon) && (14.3..14.5).contains(&lat), "{lon} {lat}");
        let (lon, lat) = Crs::UtmReunion.to_lonlat(359_400.0, 7_634_200.0);
        assert!((55.3..55.7).contains(&lon) && (-21.5..-21.1).contains(&lat), "{lon} {lat}");
        // Sur le méridien central, à l'équateur : exactement le méridien.
        let (lon, lat) = utm_inverse(500_000.0, 0.0, -63.0, 0.0);
        assert!((lon + 63.0).abs() < 1e-9 && lat.abs() < 1e-9);
    }
}
