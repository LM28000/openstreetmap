//! Jeu de données « couverture » : la couverture mobile théorique de l'ARCEP (« Mon réseau mobile »), rastérisée.
//!
//! C'est le deuxième exemple du moteur, et il illustre l'autre grande famille de données : des **polygones** (les zones
//! couvertes) que l'on transforme en **grille** pour pouvoir les agréger.
//!
//! # La source
//!
//! ARCEP, « Mon réseau mobile », cartes de couverture théorique (<https://data.arcep.fr/mobile/couvertures_theoriques/>,
//! jeu <https://www.data.gouv.fr/datasets/mon-reseau-mobile>), publiées chaque trimestre sous Licence Ouverte. Ce sont des
//! **simulations** des opérateurs, vérifiées par l'ARCEP : pas des mesures. Un fichier par opérateur et par technologie,
//! en GeoPackage (une base SQLite) compressé en 7z : 4G (`4G_data`, 3 niveaux de qualité) et 2G/3G voix (`2G3G_voix`) pour
//! Orange, SFR, Bouygues Telecom et Free Mobile. Ensemble : 2,1 Go de 7z, ~6 Go une fois décompressés ; chaque fichier
//! contient **une ligne par département et par niveau** : une géométrie (multipolygone en Lambert-93) de 1 à 40 Mo.
//! La 5G n'est pas publiée par l'ARCEP, et la 2G de Free Mobile non plus depuis 2024 : on prend donc « 2G/3G voix », qui
//! existe pour les quatre opérateurs. Outre-mer : pas pris en compte (autres repères, autres opérateurs).
//!
//! # Pourquoi rastériser
//!
//! Quatre opérateurs × deux technologies × trois niveaux, c'est ~2 Go de sommets de polygones qui se chevauchent. Les mettre
//! en tuiles tels quels ferait des tuiles lourdes et, surtout, ne permettrait pas de répondre à « combien d'opérateurs
//! ici ? » : cela demanderait d'intersecter des polygones à chaque tuile. En rastérisant, on décide **une fois** de ce qu'il y a
//! dans chaque carreau de 250 m, et tout le reste (le nombre d'opérateurs, les zones blanches, les parts de surface aux
//! zooms bas) devient de l'arithmétique sur des petits entiers, que le moteur sait déjà agréger (`GridAggregator`).
//!
//! # La grille
//!
//! Carreaux de 250 m dans le repère LAEA (EPSG:3035) : le même que la grille INSEE, et donc un `Cell` comme les autres
//! (aucun changement du moteur). 250 m divise 1, 2, 4, 8, 16 km : les carreaux agrégés des zooms bas se rangent exactement.
//! Pour chaque carreau et chaque technologie, **un octet** : 2 bits par opérateur, le meilleur niveau de qualité qui couvre
//! le *centre* du carreau (0 = rien, 1 = limitée, 2 = bonne, 3 = très bonne). La métropole fait ~4 000 × 4 800 carreaux :
//! 2 octets par carreau, 38 Mo, quel que soit le nombre de polygones lus. C'est cette grille compacte qui garde la mémoire bornée.
//!
//! # Rastériser un polygone : le remplissage par lignes de balayage (*scanline*)
//!
//! Pour chaque rangée de carreaux, on cherche où la droite horizontale qui passe par les centres des carreaux coupe les
//! côtés du polygone. On trie ces croisements de gauche à droite : le premier entre dans le polygone, le deuxième en sort, le
//! troisième entre à nouveau (un trou, ou un autre morceau), etc. (règle pair-impair, qui gère les trous sans rien de plus).
//! Les carreaux dont le centre tombe entre une entrée et une sortie sont dans le polygone. Chaque côté ne coûte que les
//! rangées qu'il traverse, et la géométrie n'est jamais gardée en mémoire : on lit les sommets un à un dans le blob WKB,
//! on les projette, on note les croisements `(rangée, x)`, puis on trie cette liste (un million d'entrées, 8 Mo) et on remplit.
//! Un côté est compté pour les rangées `y_min <= centre < y_max` (intervalle semi-ouvert) : un sommet partagé par deux côtés
//! n'est ainsi jamais compté deux fois.
//!
//! # Les zones blanches : un masque de terre
//!
//! Savoir qu'un carreau n'est couvert par personne ne suffit : il faut savoir qu'il est **sur la terre**, sinon la mer serait
//! une « zone blanche ». On rastérise donc aussi les départements (contours simplifiés à 100 m d'Etalab / IGN Admin Express) : un
//! carreau est émis s'il est sur la terre ou couvert. Les carreaux de terre sans couverture sont les zones blanches.
//!
//! # Ce que porte une tuile
//!
//! À l'entrée, un carreau porte deux entiers (un octet de niveaux par technologie). `Unpack` les éclate en 19 comptes,
//! que `GridAggregator` additionne, puis `finalize` en recalcule, **à partir des sommes**, 8 propriétés (4G : `g…`, voix : `v…`) :
//!
//! - `gq`, `vq` : la qualité de chacun des 4 opérateurs (Orange, SFR, Bouygues, Free), 7 bits chacun (0 à 100, 0 = aucune,
//!   33 = limitée, 67 = bonne, 100 = très bonne ; une moyenne aux zooms bas). Pas d'opérations binaires dans les expressions
//!   MapLibre : on lit l'opérateur `i` par `floor(v / 128^i) % 128` ;
//! - `gs`, `vs` : la part de la surface couverte (%) de chaque opérateur, même empaquetage ;
//! - `gm`, `vm` : le nombre moyen d'opérateurs, ×10 ;
//! - `gz`, `vz` : la part de la surface sans aucun opérateur (%).
//!
//! Aux zooms où le carreau est d'origine (250 m), toutes ces valeurs sont exactes (des 0 et des 100).

use std::fs::File;
use std::future::Future;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;

use anyhow::{Context, Result, bail};
use tracing::{info, warn};

use super::geom::Bounds;
use super::proj::{Crs, laea_forward};
use super::{Cell, Dataset, Feature, FeatureSet, Finalize, Generalizer, Geometry, GridAggregator, Value};

/// Trimestre des cartes (affiché ; changer de trimestre refait les tuiles). Dossier `<trimestre>/Metropole/00_Metropole/`.
const QUARTER: &str = "2026_T2";
/// Date butoir du trimestre, telle que l'ARCEP l'inscrit dans les fichiers (relue des fichiers à la fabrication).
const QUARTER_DATE: &str = "2026-06-30";
const BASE_URL: &str = "https://data.arcep.fr/mobile/couvertures_theoriques";
/// Contours des départements, 100 m de simplification (Etalab, IGN Admin Express COG-Carto) : 2,7 Mo.
const DEPARTMENTS_URL: &str = "https://etalab-datasets.geo.data.gouv.fr/contours-administratifs/2025/geojson/departements-100m.geojson";
const DEPARTMENTS_FILE: &str = "departements-100m.geojson";

/// Côté des carreaux de la grille (mètres).
const CELL_M: i32 = 250;
/// Côté des blocs qui servent de seaux (voir `population.rs`) : chaque taille de carreau agrégé aux zooms des seaux divise 8 km.
const BLOCK_M: i32 = 8000;

/// Les opérateurs, dans l'ordre de l'empaquetage des propriétés : `(code dans les noms de fichiers, nom affiché)`.
const OPERATORS: [(&str, &str); 4] = [("OF", "Orange"), ("SFR0", "SFR"), ("BOUY", "Bouygues Telecom"), ("FREE", "Free Mobile")];
/// Les technologies : `(clé, suffixe des noms de fichiers)`. 4G data, puis 2G/3G voix.
const TECHS: [(&str, &str); 2] = [("4g", "4G_data"), ("voix", "2G3G_voix")];

/// Côté des carreaux agrégés à chaque zoom (mètres) : il **double à chaque zoom perdu**, de 250 m au zoom 11 à 32 km au zoom 4.
/// Une tuile de 512 pixels contient ainsi toujours ~78 × 78 carreaux de ~6 pixels : ~6 000 objets, de 200 Ko avant compression.
/// (Avec moins d'agrégation, les tuiles des zooms 7 et 8 dépassaient les 500 Ko permis et perdaient des carreaux.)
fn cell_size(zoom: u8) -> u32 {
    250 << (11 - zoom.clamp(4, 11))
}

// ---------------------------------------------------------------------------------------------
// Réglages de développement (variables d'environnement) : restreindre ce qu'on télécharge et lit
// ---------------------------------------------------------------------------------------------

/// Une partie seulement des fichiers, pour les essais : `ARCEP_OPERATEURS=OF,SFR0`, `ARCEP_TECHNOS=4g`, `ARCEP_DEPARTEMENTS=29,22`.
/// Sans eux : tout. Ils entrent dans l'identifiant de la source : une archive d'essai n'est jamais prise pour la vraie.
#[derive(Clone, Debug, Default)]
struct Filters {
    operators: Option<Vec<String>>,
    techs: Option<Vec<String>>,
    departments: Option<Vec<String>>,
}

impl Filters {
    fn from_env() -> Filters {
        let list = |name: &str| -> Option<Vec<String>> {
            let value = std::env::var(name).ok()?;
            let items: Vec<String> = value.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            (!items.is_empty()).then_some(items)
        };
        Filters { operators: list("ARCEP_OPERATEURS"), techs: list("ARCEP_TECHNOS"), departments: list("ARCEP_DEPARTEMENTS") }
    }
    fn operator(&self, code: &str) -> bool {
        self.operators.as_ref().is_none_or(|l| l.iter().any(|o| o == code))
    }
    fn tech(&self, key: &str) -> bool {
        self.techs.as_ref().is_none_or(|l| l.iter().any(|t| t == key))
    }
    fn department(&self, code: &str) -> bool {
        self.departments.as_ref().is_none_or(|l| l.iter().any(|d| d == code))
    }
}

/// Les fichiers de couverture à lire : `(technologie, opérateur, nom du 7z)`.
fn archive_name(operator: &str, suffix: &str) -> String {
    format!("{QUARTER}_couv_Metropole_{operator}_{suffix}.gpkg.7z")
}

// ---------------------------------------------------------------------------------------------
// Lambert-93 → LAEA
// ---------------------------------------------------------------------------------------------

/// EPSG:2154 (Lambert-93, cône conforme, ellipsoïde GRS80) : mètres (est, nord) → (longitude, latitude) en degrés.
/// Formules de la note IGN NTG 71 : `n`, `c`, `xs`, `ys` sont les constantes de la projection (parallèles 44° et 49°).
fn lambert93_inverse(e: f64, n: f64) -> (f64, f64) {
    const ECC: f64 = 0.081_819_191_042_815_8;
    const EXPONENT: f64 = 0.725_607_765_053_267;
    const C: f64 = 11_754_255.426_096;
    const XS: f64 = 700_000.0;
    const YS: f64 = 12_655_612.049_876;
    let (dx, dy) = (e - XS, YS - n);
    let r = dx.hypot(dy);
    let lon = 3.0_f64.to_radians() + dx.atan2(dy) / EXPONENT;
    let l = -(r / C).ln() / EXPONENT;
    let mut phi = 2.0 * l.exp().atan() - std::f64::consts::FRAC_PI_2;
    for _ in 0..8 {
        let s = ECC * phi.sin();
        phi = 2.0 * (((1.0 + s) / (1.0 - s)).powf(ECC / 2.0) * l.exp()).atan() - std::f64::consts::FRAC_PI_2;
    }
    (lon.to_degrees(), phi.to_degrees())
}

/// Lambert-93 → LAEA, **sans** refaire les deux projections complètes à chaque sommet : une source en a des dizaines de
/// millions. On calcule la transformation exacte aux nœuds d'un quadrillage de 5 km, et on interpole bilinéairement entre
/// eux. Les deux projections varient doucement : l'écart à la transformation exacte est de quelques centimètres.
struct Lambert93ToLaea {
    nodes: Vec<(f64, f64)>,
    columns: usize,
}

impl Lambert93ToLaea {
    const E0: f64 = 0.0;
    const N0: f64 = 5_900_000.0;
    const STEP: f64 = 5_000.0;
    const E_MAX: f64 = 1_400_000.0;
    const N_MAX: f64 = 7_300_000.0;

    fn new() -> Self {
        let columns = ((Self::E_MAX - Self::E0) / Self::STEP) as usize + 2;
        let rows = ((Self::N_MAX - Self::N0) / Self::STEP) as usize + 2;
        let mut nodes = Vec::with_capacity(columns * rows);
        for r in 0..rows {
            for c in 0..columns {
                nodes.push(Self::exact(Self::E0 + c as f64 * Self::STEP, Self::N0 + r as f64 * Self::STEP));
            }
        }
        Lambert93ToLaea { nodes, columns }
    }

    fn exact(e: f64, n: f64) -> (f64, f64) {
        let (lon, lat) = lambert93_inverse(e, n);
        laea_forward(lon, lat)
    }

    fn apply(&self, e: f64, n: f64) -> (f64, f64) {
        let (fx, fy) = ((e - Self::E0) / Self::STEP, (n - Self::N0) / Self::STEP);
        let rows = self.nodes.len() / self.columns;
        if fx < 0.0 || fy < 0.0 || fx >= (self.columns - 1) as f64 || fy >= (rows - 1) as f64 {
            return Self::exact(e, n); // hors de la France : sans importance, mais jamais faux
        }
        let (c, r) = (fx as usize, fy as usize);
        let (tx, ty) = (fx - c as f64, fy - r as f64);
        let at = |c: usize, r: usize| self.nodes[r * self.columns + c];
        let (a, b, d, f) = (at(c, r), at(c + 1, r), at(c, r + 1), at(c + 1, r + 1));
        let lerp = |p: f64, q: f64, t: f64| p + (q - p) * t;
        (
            lerp(lerp(a.0, b.0, tx), lerp(d.0, f.0, tx), ty),
            lerp(lerp(a.1, b.1, tx), lerp(d.1, f.1, tx), ty),
        )
    }
}

// ---------------------------------------------------------------------------------------------
// La grille et le remplissage par lignes de balayage
// ---------------------------------------------------------------------------------------------

/// La grille de la métropole : coin sud-ouest `(e0, n0)` en mètres LAEA (multiples de 250), `w` colonnes, `h` rangées.
struct Grid {
    e0: i32,
    n0: i32,
    w: usize,
    h: usize,
    /// Par technologie, un octet par carreau : 2 bits par opérateur (le niveau 0 à 3).
    levels: [Vec<u8>; 2],
    /// Un bit par carreau : le centre est sur la terre (dans un département).
    land: Vec<u64>,
}

impl Grid {
    /// L'emprise est celle des contours de la terre (en mètres LAEA), plus une marge de 10 km pour les eaux proches des côtes
    /// (une couverture au-delà de la grille est simplement ignorée).
    fn around(land: &[Vec<(f64, f64)>]) -> Grid {
        let (mut e_min, mut e_max, mut n_min, mut n_max) = (f64::MAX, f64::MIN, f64::MAX, f64::MIN);
        for &(e, n) in land.iter().flatten() {
            (e_min, e_max, n_min, n_max) = (e_min.min(e), e_max.max(e), n_min.min(n), n_max.max(n));
        }
        let margin = 10_000.0;
        let c = f64::from(CELL_M);
        let e0 = (((e_min - margin) / c).floor() as i32) * CELL_M;
        let n0 = (((n_min - margin) / c).floor() as i32) * CELL_M;
        let w = ((e_max + margin - f64::from(e0)) / c).ceil() as usize + 1;
        let h = ((n_max + margin - f64::from(n0)) / c).ceil() as usize + 1;
        Grid { e0, n0, w, h, levels: [vec![0; w * h], vec![0; w * h]], land: vec![0; (w * h).div_ceil(64)] }
    }

    /// Coordonnées LAEA (mètres) → coordonnées de la grille, en carreaux (le centre du carreau `(i, j)` est en `(i + ½, j + ½)`).
    fn to_cells(&self, e: f64, n: f64) -> (f64, f64) {
        ((e - f64::from(self.e0)) / f64::from(CELL_M), (n - f64::from(self.n0)) / f64::from(CELL_M))
    }

    /// Donne le niveau `level` à l'opérateur `op` sur `i0..i1` de la rangée `row`, s'il est meilleur que l'actuel.
    fn paint_level(&mut self, tech: usize, op: usize, level: u8, row: usize, i0: usize, i1: usize) {
        let shift = 2 * op;
        for byte in &mut self.levels[tech][row * self.w + i0..row * self.w + i1] {
            if (*byte >> shift) & 3 < level {
                *byte = (*byte & !(3 << shift)) | (level << shift);
            }
        }
    }

    fn paint_land(&mut self, row: usize, i0: usize, i1: usize) {
        for k in row * self.w + i0..row * self.w + i1 {
            self.land[k / 64] |= 1 << (k % 64);
        }
    }

    fn is_land(&self, k: usize) -> bool {
        self.land[k / 64] >> (k % 64) & 1 == 1
    }
}

/// Les croisements des côtés d'un polygone avec les droites horizontales des centres de carreaux (voir « Rastériser un polygone »).
#[derive(Default)]
struct Crossings {
    list: Vec<(u32, f32)>,
}

impl Crossings {
    /// Un côté `a → b`, en coordonnées de grille. `rows` : nombre de rangées de la grille (le reste est hors de la France).
    fn edge(&mut self, a: (f64, f64), b: (f64, f64), rows: usize) {
        if a.1 == b.1 {
            return; // un côté horizontal ne coupe aucune droite horizontale
        }
        let (low, high) = if a.1 < b.1 { (a, b) } else { (b, a) };
        // Rangées `j` dont le centre `j + ½` vérifie `low.y <= j + ½ < high.y`.
        let first = (low.1 - 0.5).ceil().max(0.0) as u32;
        let end = ((high.1 - 0.5).ceil().max(0.0) as u32).min(rows as u32);
        let slope = (high.0 - low.0) / (high.1 - low.1);
        for j in first..end {
            self.list.push((j, (low.0 + (f64::from(j) + 0.5 - low.1) * slope) as f32));
        }
    }

    /// Trie les croisements, puis remplit entre le 1er et le 2e, le 3e et le 4e… : `paint(rangée, premier carreau, dernier + 1)`.
    fn fill(&mut self, columns: usize, mut paint: impl FnMut(usize, usize, usize)) {
        self.list.sort_unstable_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let mut k = 0;
        while k < self.list.len() {
            let row = self.list[k].0;
            let mut end = k;
            while end < self.list.len() && self.list[end].0 == row {
                end += 1;
            }
            for pair in self.list[k..end].chunks_exact(2) {
                // Les centres de carreaux `i + ½` dans `[x_entrée, x_sortie)`.
                let i0 = (f64::from(pair[0].1) - 0.5).ceil().max(0.0) as usize;
                let i1 = ((f64::from(pair[1].1) - 0.5).ceil().max(0.0) as usize).min(columns);
                if i0 < i1 {
                    paint(row as usize, i0, i1);
                }
            }
            k = end;
        }
        self.list.clear();
        if self.list.capacity() > 4_000_000 {
            self.list = Vec::new(); // ne pas garder une liste énorme jusqu'au polygone suivant
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Lecture d'une géométrie GeoPackage (en-tête GP + WKB), sans la copier
// ---------------------------------------------------------------------------------------------

/// Un anneau dans un blob WKB : les sommets restent dans le blob, on les lit à la demande.
struct RingRef<'a> {
    data: &'a [u8],
    points: usize,
    little: bool,
    /// Octets par sommet (16 pour x, y ; 24 avec z ou m ; 32 avec les deux).
    stride: usize,
}

impl RingRef<'_> {
    fn point(&self, i: usize) -> (f64, f64) {
        let at = i * self.stride;
        let read = |offset: usize| {
            let bytes: [u8; 8] = self.data[at + offset..at + offset + 8].try_into().expect("8 octets");
            if self.little { f64::from_le_bytes(bytes) } else { f64::from_be_bytes(bytes) }
        };
        (read(0), read(8))
    }
}

/// Lit un entier de 32 bits dans l'ordre d'octets donné.
fn read_u32(data: &[u8], at: &mut usize, little: bool) -> Result<u32> {
    let bytes: [u8; 4] = data.get(*at..*at + 4).context("WKB tronqué")?.try_into().expect("4 octets");
    *at += 4;
    Ok(if little { u32::from_le_bytes(bytes) } else { u32::from_be_bytes(bytes) })
}

/// Les anneaux (extérieurs et trous mêlés : la règle pair-impair les distingue) d'un polygone ou multipolygone WKB.
fn wkb_rings<'a>(data: &'a [u8], at: &mut usize, out: &mut Vec<RingRef<'a>>) -> Result<()> {
    let little = *data.get(*at).context("WKB vide")? == 1;
    *at += 1;
    let kind = read_u32(data, at, little)?;
    // Types ISO (1003 = polygone avec z, 2003 = avec m, 3003 = avec z et m) ou « EWKB » (drapeaux dans les bits hauts).
    let dims = 2 + usize::from(kind / 1000 == 1 || kind / 1000 == 3 || kind & 0x8000_0000 != 0) + usize::from(kind / 1000 == 2 || kind / 1000 == 3 || kind & 0x4000_0000 != 0);
    match kind & 0xff {
        3 => {
            let rings = read_u32(data, at, little)?;
            for _ in 0..rings {
                let points = read_u32(data, at, little)? as usize;
                let len = points * dims * 8;
                let slice = data.get(*at..*at + len).context("anneau WKB tronqué")?;
                *at += len;
                out.push(RingRef { data: slice, points, little, stride: dims * 8 });
            }
        }
        6 | 7 => {
            let parts = read_u32(data, at, little)?;
            for _ in 0..parts {
                wkb_rings(data, at, out)?;
            }
        }
        other => bail!("géométrie WKB de type {other} non prévue"),
    }
    Ok(())
}

/// Saute l'en-tête GeoPackage (`GP`, version, drapeaux, SRID, enveloppe) : rend le WKB.
fn gpkg_wkb(blob: &[u8]) -> Result<&[u8]> {
    if blob.len() < 8 || &blob[..2] != b"GP" {
        bail!("géométrie GeoPackage invalide");
    }
    let flags = blob[3];
    if flags & 0b10_0000 != 0 {
        bail!("géométrie GeoPackage étendue (non prévue)");
    }
    let envelope = match (flags >> 1) & 7 {
        0 => 0,
        1 => 32,
        2 | 3 => 48,
        4 => 64,
        _ => bail!("enveloppe GeoPackage inconnue"),
    };
    blob.get(8 + envelope..).context("géométrie GeoPackage tronquée")
}

// ---------------------------------------------------------------------------------------------
// Le jeu de données
// ---------------------------------------------------------------------------------------------

/// Les chiffres tirés de la grille, pour les légendes et la fiche de la couche.
#[derive(Default, Clone)]
struct Stats {
    /// Carreaux de terre.
    land_cells: u64,
    /// Par technologie : par opérateur, les carreaux de terre couverts à chaque niveau (index 1 à 3).
    by_operator: [[[u64; 4]; 4]; 2],
    /// Par technologie : carreaux de terre couverts par 0, 1, 2, 3 ou 4 opérateurs.
    by_count: [[u64; 5]; 2],
    /// Date des cartes (inscrite dans les fichiers).
    date: String,
}

pub struct Couverture {
    filters: Filters,
    stats: Mutex<Stats>,
}

impl Couverture {
    pub fn new() -> Couverture {
        Couverture { filters: Filters::from_env(), stats: Mutex::new(Stats::default()) }
    }

    /// Les 7z à télécharger : `(nom de fichier, adresse)`.
    fn downloads(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for (tech, suffix) in TECHS {
            for (code, _) in OPERATORS {
                if self.filters.tech(tech) && self.filters.operator(code) {
                    let name = archive_name(code, suffix);
                    out.push((name.clone(), format!("{BASE_URL}/{QUARTER}/Metropole/00_Metropole/{name}")));
                }
            }
        }
        out
    }
}

impl Default for Couverture {
    fn default() -> Self {
        Couverture::new()
    }
}

/// Télécharge `url` vers `target` en flux (par un fichier `.partiel`, renommé à la fin).
async fn download(http: &reqwest::Client, url: &str, target: &Path, min_bytes: u64) -> Result<()> {
    if std::fs::metadata(target).is_ok_and(|m| m.len() >= min_bytes) {
        return Ok(());
    }
    let mut response = http.get(url).timeout(std::time::Duration::from_secs(3600)).send().await?.error_for_status()?;
    let partial = target.with_extension("partiel");
    let mut file = BufWriter::new(File::create(&partial)?);
    let mut bytes = 0u64;
    while let Some(chunk) = response.chunk().await? {
        std::io::Write::write_all(&mut file, &chunk)?;
        bytes += chunk.len() as u64;
    }
    std::io::Write::flush(&mut file)?;
    drop(file);
    if bytes < min_bytes {
        bail!("fichier ARCEP suspect ({bytes} octets) : {url}");
    }
    std::fs::rename(&partial, target)?;
    Ok(())
}

/// Sort le GeoPackage d'une archive 7z, en flux, dans `out`.
fn extract_gpkg(archive: &Path, out: &Path) -> Result<()> {
    let mut reader = sevenz_rust2::ArchiveReader::open(archive, sevenz_rust2::Password::empty()).context("7z ARCEP illisible")?;
    reader.set_thread_count(1); // un seul fil de décodage : bien moins de mémoire
    let mut found = false;
    reader
        .for_each_entries(|item, data| {
            if !item.name().ends_with(".gpkg") {
                return Ok(true);
            }
            let mut file = BufWriter::new(File::create(out).map_err(|e| sevenz_rust2::Error::Other(e.to_string().into()))?);
            std::io::copy(data, &mut file).map_err(|e| sevenz_rust2::Error::Other(e.to_string().into()))?;
            std::io::Write::flush(&mut file).map_err(|e| sevenz_rust2::Error::Other(e.to_string().into()))?;
            found = true;
            Ok(false)
        })
        .context("décompression du 7z ARCEP")?;
    if !found {
        bail!("pas de GeoPackage dans {}", archive.display());
    }
    Ok(())
}

/// Les contours des départements de métropole : des anneaux (extérieurs et trous mêlés) en mètres LAEA. Rend aussi le nombre de départements.
fn read_land(geojson: &Path, filters: &Filters) -> Result<(Vec<Vec<(f64, f64)>>, u64)> {
    let text = std::fs::read_to_string(geojson).context("contours des départements absents")?;
    let json: serde_json::Value = serde_json::from_str(&text).context("contours des départements illisibles")?;
    let mut rings = Vec::new();
    let mut kept = 0;
    for feature in json["features"].as_array().context("pas de « features » dans les contours")? {
        let code = feature["properties"]["code"].as_str().unwrap_or_default();
        // La métropole : 01 à 95, 2A et 2B (les départements d'outre-mer commencent par 97).
        if code.starts_with("97") || code.starts_with("98") || !filters.department(code) {
            continue;
        }
        let polygons: Vec<&serde_json::Value> = match feature["geometry"]["type"].as_str() {
            Some("Polygon") => vec![&feature["geometry"]["coordinates"]],
            Some("MultiPolygon") => feature["geometry"]["coordinates"].as_array().map(|a| a.iter().collect()).unwrap_or_default(),
            _ => continue,
        };
        for polygon in polygons {
            for ring in polygon.as_array().into_iter().flatten() {
                rings.push(
                    ring.as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|p| Some(laea_forward(p[0].as_f64()?, p[1].as_f64()?)))
                        .collect(),
                );
            }
        }
        kept += 1;
    }
    Ok((rings, kept))
}

/// Rastérise les contours dans le masque de terre.
fn paint_land(grid: &mut Grid, land: &[Vec<(f64, f64)>]) {
    let mut crossings = Crossings::default();
    for ring in land {
        let points: Vec<(f64, f64)> = ring.iter().map(|&(e, n)| grid.to_cells(e, n)).collect();
        for pair in points.windows(2) {
            crossings.edge(pair[0], pair[1], grid.h);
        }
    }
    let w = grid.w;
    crossings.fill(w, |row, i0, i1| grid.paint_land(row, i0, i1));
}

/// Lit un GeoPackage de couverture et rastérise ses polygones dans la grille (technologie `tech`, opérateur `op`).
/// Rend la date des cartes.
fn rasterize_gpkg(gpkg: &Path, grid: &mut Grid, tech: usize, op: usize, converter: &Lambert93ToLaea, filters: &Filters) -> Result<String> {
    let db = rusqlite::Connection::open_with_flags(gpkg, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).context("GeoPackage illisible")?;
    // Une seule table de données ; son nom change à chaque trimestre (`2026_T2_couv_Metropole_OF_4G_data`).
    let table: String = db.query_row("SELECT table_name FROM gpkg_contents WHERE data_type = 'features' LIMIT 1", [], |r| r.get(0)).context("pas de table de données")?;
    let mut statement = db.prepare(&format!("SELECT geom, niveau, dept, date FROM \"{table}\"")).context("table de couverture illisible")?;
    let mut rows = statement.query([])?;
    let mut crossings = Crossings::default();
    let mut date = String::new();
    let mut polygons = 0u64;
    while let Some(row) = rows.next()? {
        let dept: Option<String> = row.get(2)?;
        if !filters.department(dept.as_deref().unwrap_or_default()) {
            continue;
        }
        // CL, BC, TBC : couverture limitée, bonne, très bonne. Une 3G « data » n'a pas de niveau : on la prend pour bonne.
        let level = match row.get::<_, Option<String>>(1)?.as_deref() {
            Some("CL") => 1,
            Some("TBC") => 3,
            _ => 2,
        };
        if date.is_empty() {
            date = row.get::<_, Option<String>>(3)?.unwrap_or_default();
        }
        let blob = row.get_ref(0)?.as_blob().context("géométrie absente")?;
        let wkb = gpkg_wkb(blob)?;
        let mut rings = Vec::new();
        wkb_rings(wkb, &mut 0, &mut rings)?;
        for ring in &rings {
            let mut previous: Option<(f64, f64)> = None;
            let mut first: Option<(f64, f64)> = None;
            for i in 0..ring.points {
                let (e, n) = ring.point(i);
                let (e, n) = converter.apply(e, n);
                let p = grid.to_cells(e, n);
                first.get_or_insert(p);
                if let Some(q) = previous {
                    crossings.edge(q, p, grid.h);
                }
                previous = Some(p);
            }
            // Un anneau bien formé est fermé ; sinon on le ferme (les croisements doivent être en nombre pair).
            if let (Some(a), Some(b)) = (previous, first) {
                if a != b {
                    crossings.edge(a, b, grid.h);
                }
            }
        }
        polygons += 1;
        let w = grid.w;
        crossings.fill(w, |r, i0, i1| grid.paint_level(tech, op, level, r, i0, i1));
    }
    info!(fichier = %gpkg.file_name().and_then(|n| n.to_str()).unwrap_or_default(), geometries = polygons, "couverture : rastérisé");
    Ok(date)
}

impl Dataset for Couverture {
    fn id(&self) -> &'static str {
        "couverture"
    }
    fn layer(&self) -> &'static str {
        "couverture"
    }
    fn keys(&self) -> &'static [&'static str] {
        &["gq", "gs", "gm", "gz", "vq", "vs", "vm", "vz"]
    }
    fn zooms(&self) -> (u8, u8) {
        (4, 11)
    }
    fn schema_version(&self) -> u32 {
        1
    }
    fn source_id(&self) -> String {
        format!("arcep-{QUARTER}|{:?}", self.filters)
    }
    fn attribution(&self) -> &'static str {
        "ARCEP, Mon réseau mobile"
    }
    fn license(&self) -> &'static str {
        "Licence Ouverte (Etalab)"
    }
    /// Seaux de 1/1024 de monde (~1 000 km² ici), comme la population.
    fn spool_zoom(&self) -> u8 {
        10
    }

    /// Télécharge, l'un après l'autre, les 7z (2,1 Go) et les contours des départements. `scan` efface chaque 7z dès qu'il est rastérisé.
    fn acquire<'a>(&'a self, http: &'a reqwest::Client, dir: &'a Path) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            download(http, DEPARTMENTS_URL, &dir.join(DEPARTMENTS_FILE), 100_000).await.context("contours des départements")?;
            for (name, url) in self.downloads() {
                if std::fs::metadata(dir.join(&name)).is_ok_and(|m| m.len() > 1_000_000) {
                    continue;
                }
                info!(fichier = %name, "couverture : téléchargement");
                download(http, &url, &dir.join(&name), 1_000_000).await.with_context(|| format!("téléchargement de {name}"))?;
            }
            Ok(())
        })
    }

    fn scan(&self, dir: &Path, emit: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        let started = std::time::Instant::now();
        let keep_sources = std::env::var_os("ARCEP_GARDER_SOURCES").is_some();
        let converter = Lambert93ToLaea::new();
        let (land, departments) = read_land(&dir.join(DEPARTMENTS_FILE), &self.filters)?;
        if land.is_empty() {
            bail!("aucun département dans les contours (filtre ARCEP_DEPARTEMENTS ?)");
        }
        let mut grid = Grid::around(&land);
        info!(colonnes = grid.w, rangees = grid.h, mo = (grid.w * grid.h * 2) >> 20, "couverture : grille de 250 m");
        paint_land(&mut grid, &land);
        drop(land);
        info!(departements = departments, "couverture : masque de terre");

        let mut date = String::new();
        let extracted: PathBuf = dir.join("extrait.gpkg");
        for (t, (tech, suffix)) in TECHS.iter().enumerate() {
            for (o, (code, _)) in OPERATORS.iter().enumerate() {
                if !(self.filters.tech(tech) && self.filters.operator(code)) {
                    continue;
                }
                let archive = dir.join(archive_name(code, suffix));
                extract_gpkg(&archive, &extracted).with_context(|| format!("{}", archive.display()))?;
                let result = rasterize_gpkg(&extracted, &mut grid, t, o, &converter, &self.filters);
                let _ = std::fs::remove_file(&extracted); // jusqu'à 2 Go : ne jamais les garder
                if !keep_sources {
                    let _ = std::fs::remove_file(&archive);
                }
                let found = result.with_context(|| format!("{}", archive.display()))?;
                if date.is_empty() {
                    date = found;
                }
            }
        }
        if date.is_empty() {
            date = QUARTER_DATE.to_string();
        }
        info!(secondes = started.elapsed().as_secs(), "couverture : polygones rastérisés");

        // Émission des carreaux : ceux de terre (zones blanches comprises) et ceux couverts (en mer, près des côtes).
        let mut stats = Stats { date, ..Stats::default() };
        let mut emitted = 0u64;
        for j in 0..grid.h {
            for i in 0..grid.w {
                let k = j * grid.w + i;
                let (a, v) = (grid.levels[0][k], grid.levels[1][k]);
                let land = grid.is_land(k);
                if !land && a == 0 && v == 0 {
                    continue;
                }
                if land {
                    stats.land_cells += 1;
                    for (t, packed) in [a, v].into_iter().enumerate() {
                        let mut operators = 0;
                        for o in 0..4 {
                            let level = usize::from((packed >> (2 * o)) & 3);
                            if level > 0 {
                                stats.by_operator[t][o][level] += 1;
                                operators += 1;
                            }
                        }
                        stats.by_count[t][operators] += 1;
                    }
                }
                let cell = Cell { crs: Crs::Laea, e: grid.e0 + i as i32 * CELL_M, n: grid.n0 + j as i32 * CELL_M, size: CELL_M as u32 };
                emit(Feature { geom: Geometry::Cell(cell), props: vec![Value::Int(i64::from(a)), Value::Int(i64::from(v))], weight: 1.0 })?;
                emitted += 1;
            }
        }
        if emitted == 0 || stats.land_cells == 0 {
            bail!("aucun carreau de couverture : sources ou filtres invalides");
        }
        info!(carreaux = emitted, terre = stats.land_cells, secondes = started.elapsed().as_secs(), "couverture : carreaux émis");
        if stats.land_cells < 1_000_000 && self.filters.departments.is_none() {
            warn!(terre = stats.land_cells, "couverture : très peu de carreaux de terre, le masque est-il complet ?");
        }
        *self.stats.lock().expect("statistiques") = stats;
        Ok(())
    }

    fn generalizer(&self, zoom: u8) -> Box<dyn Generalizer> {
        let finalize: Finalize = Box::new(finalize);
        Box::new(Unpack::new(GridAggregator::new(cell_size(zoom), finalize)))
    }

    /// Un carreau se rattache au seau du centre de son bloc de 8 km (voir `population.rs`).
    fn anchor(&self, feature: &Feature) -> [f64; 2] {
        let Geometry::Cell(cell) = &feature.geom else { return [0.0, 0.0] };
        let block = cell.block(BLOCK_M);
        let (lon, lat) = block.crs.to_lonlat(f64::from(block.e) + f64::from(BLOCK_M) / 2.0, f64::from(block.n) + f64::from(BLOCK_M) / 2.0);
        [lon, lat]
    }

    /// … et il est recopié dans les seaux voisins que son bloc déborde.
    fn influence(&self, feature: &Feature) -> Bounds {
        let Geometry::Cell(cell) = &feature.geom else { return Bounds::EMPTY };
        Bounds::of(cell.block(BLOCK_M).corners())
    }

    fn metadata(&self) -> serde_json::Value {
        let s = self.stats.lock().expect("statistiques").clone();
        let km2 = |cells: u64| (cells as f64 * f64::from(CELL_M).powi(2) / 1e6).round();
        let share = |cells: u64| if s.land_cells == 0 { 0.0 } else { (1000.0 * cells as f64 / s.land_cells as f64).round() / 10.0 };
        let techs: serde_json::Map<String, serde_json::Value> = TECHS
            .iter()
            .enumerate()
            .map(|(t, (key, _))| {
                let operators: Vec<serde_json::Value> = OPERATORS
                    .iter()
                    .enumerate()
                    .map(|(o, (_, name))| {
                        let levels = s.by_operator[t][o];
                        serde_json::json!({
                            "nom": name,
                            "couvert": share(levels[1] + levels[2] + levels[3]),
                            "tresBonne": share(levels[3]),
                        })
                    })
                    .collect();
                (
                    (*key).to_string(),
                    serde_json::json!({
                        "operateurs": operators,
                        "nbOperateurs": s.by_count[t].iter().map(|c| share(*c)).collect::<Vec<_>>(),
                        "zoneBlancheKm2": km2(s.by_count[t][0]),
                    }),
                )
            })
            .collect();
        serde_json::json!({
            "trimestre": QUARTER.replace('_', " "),
            "date": s.date,
            "operateurs": OPERATORS.iter().map(|(_, n)| n).collect::<Vec<_>>(),
            "terreKm2": km2(s.land_cells),
            "stats": techs,
            "tailles": (4..=11).map(|z| serde_json::json!([z, cell_size(z)])).collect::<Vec<_>>(),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Éclater les octets de niveaux en comptes additionnables, et les recomposer
// ---------------------------------------------------------------------------------------------

/// Nombre de comptes par carreau : `n`, puis par technologie 4 niveaux, 4 « couvert » et « zone blanche ». Le nombre moyen
/// d'opérateurs n'a pas son compte : c'est la somme des 4 « couvert » (moins il y a de comptes, moins la mémoire du
/// `GridAggregator` aux zooms bas est grande : il en garde `SUMS` par gros carreau, ~550 000 au zoom 9).
const SUMS: usize = 1 + 2 * 9;

/// Décore un `GridAggregator` : les carreaux de la source portent des octets de niveaux (compacts, 2 entiers : c'est ce
/// qui est déposé dans les seaux), et `GridAggregator` ne sait qu'additionner des nombres. On éclate donc chaque octet en
/// comptes juste avant l'addition. Les comptes d'un carreau d'origine sont des 0 et 1 (et 0 à 3 pour les niveaux).
struct Unpack {
    inner: GridAggregator,
    scratch: Feature,
}

impl Unpack {
    fn new(inner: GridAggregator) -> Unpack {
        Unpack {
            inner,
            scratch: Feature { geom: Geometry::Point([0.0, 0.0]), props: vec![Value::Int(0); SUMS], weight: 1.0 },
        }
    }
}

impl Generalizer for Unpack {
    fn push(&mut self, feature: &Feature) {
        let Geometry::Cell(_) = feature.geom else { return };
        let packed = |i: usize| match feature.props.get(i) {
            Some(Value::Int(v)) => *v as u8,
            _ => 0,
        };
        self.scratch.geom = feature.geom.clone();
        self.scratch.props[0] = Value::Int(1);
        for t in 0..2 {
            let byte = packed(t);
            let base = 1 + t * 9;
            let mut covered = 0;
            for o in 0..4 {
                let level = i64::from((byte >> (2 * o)) & 3);
                self.scratch.props[base + o] = Value::Int(level);
                self.scratch.props[base + 4 + o] = Value::Int(i64::from(level > 0));
                covered += i64::from(level > 0);
            }
            self.scratch.props[base + 8] = Value::Int(i64::from(covered == 0));
        }
        self.inner.push(&self.scratch);
    }

    fn finish(self: Box<Self>) -> Box<dyn FeatureSet> {
        Box::new(self.inner).finish()
    }
}

/// Les sommes d'un carreau (ou d'un gros carreau) → les 8 propriétés d'une tuile. Tout est recalculé à partir des sommes.
fn finalize(sums: &[f32], _size: u32) -> (Vec<Value>, f32) {
    let n = sums[0].max(1.0);
    let mut props = Vec::with_capacity(8);
    for t in 0..2 {
        let base = 1 + t * 9;
        // Chaque opérateur sur 7 bits (0 à 100), du premier (poids faible) au dernier.
        let (mut quality, mut share) = (0i64, 0i64);
        for o in (0..4).rev() {
            quality = quality * 128 + (100.0 * sums[base + o] / (3.0 * n)).round() as i64;
            share = share * 128 + (100.0 * sums[base + 4 + o] / n).round() as i64;
        }
        props.push(Value::Int(quality));
        props.push(Value::Int(share));
        let operators: f32 = sums[base + 4..base + 8].iter().sum();
        props.push(Value::Int((10.0 * operators / n).round() as i64));
        props.push(Value::Int((100.0 * sums[base + 8] / n).round() as i64));
    }
    (props, n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lambert93_connu() {
        // Paris (Notre-Dame, environ) : 2,35° E, 48,853° N ↔ environ (652 400 ; 6 862 000) en Lambert-93.
        let (lon, lat) = lambert93_inverse(652_400.0, 6_862_000.0);
        assert!((lon - 2.3522).abs() < 0.004 && (lat - 48.8566).abs() < 0.004, "{lon} {lat}");
        // Le point d'origine de la projection (parallèle 46,5° N, méridien 3° E) : E 700 000, N 6 600 000.
        let (lon, lat) = lambert93_inverse(700_000.0, 6_600_000.0);
        assert!((lon - 3.0).abs() < 1e-9 && (lat - 46.5).abs() < 1e-8, "{lon} {lat}");
    }

    #[test]
    fn interpolation_proche_de_la_projection_exacte() {
        let converter = Lambert93ToLaea::new();
        for (e, n) in [(652_400.0, 6_862_000.0), (99_500.0, 6_049_000.0), (1_270_000.0, 6_090_000.0), (350_123.0, 6_700_456.0), (1_000_001.0, 7_100_000.0)] {
            let (x, y) = converter.apply(e, n);
            let (xe, ye) = Lambert93ToLaea::exact(e, n);
            assert!((x - xe).abs() < 0.15 && (y - ye).abs() < 0.15, "({e}, {n}) : écart {} m", (x - xe).hypot(y - ye));
        }
    }

    #[test]
    fn la_grille_entoure_la_terre_et_s_aligne_sur_250_m() {
        // Un « pays » de 100 km sur 60 km.
        let land = vec![vec![(3_800_000.0, 2_800_000.0), (3_900_000.0, 2_800_000.0), (3_900_000.0, 2_860_000.0), (3_800_000.0, 2_860_000.0)]];
        let grid = Grid::around(&land);
        assert_eq!((grid.e0 % CELL_M, grid.n0 % CELL_M), (0, 0));
        for &(e, n) in &land[0] {
            let (x, y) = grid.to_cells(e, n);
            assert!(x > 39.0 && y > 39.0 && (x as usize) + 39 < grid.w && (y as usize) + 39 < grid.h, "marge de 10 km = 40 carreaux");
        }
    }

    /// Remplit un polygone et rend les carreaux atteints, sous la forme `(rangée, début, fin)`.
    fn fill(rings: &[&[(f64, f64)]], rows: usize, columns: usize) -> Vec<(usize, usize, usize)> {
        let mut crossings = Crossings::default();
        for ring in rings {
            for k in 0..ring.len() {
                crossings.edge(ring[k], ring[(k + 1) % ring.len()], rows);
            }
        }
        let mut spans = Vec::new();
        crossings.fill(columns, |row, a, b| spans.push((row, a, b)));
        spans
    }

    #[test]
    fn remplissage_d_un_rectangle() {
        // x de 1,2 à 4,8 et y de 0,6 à 2,4 : les centres (i + ½, j + ½) à l'intérieur sont i = 1..4 (1,5 à 4,5) et j = 1, 2 → 1,5 et 2,5 > 2,4 : seulement j = 1.
        let spans = fill(&[&[(1.2, 0.6), (4.8, 0.6), (4.8, 2.4), (1.2, 2.4)]], 10, 10);
        assert_eq!(spans, vec![(1, 1, 5)]);
    }

    #[test]
    fn remplissage_avec_un_trou() {
        // Un carré de 6 × 6 carreaux percé d'un trou de 2 × 2 au milieu : 36 - 4 = 32 carreaux.
        let outer = [(0.1, 0.1), (6.1, 0.1), (6.1, 6.1), (0.1, 6.1)];
        let hole = [(2.1, 2.1), (4.1, 2.1), (4.1, 4.1), (2.1, 4.1)];
        let spans = fill(&[&outer, &hole], 10, 10);
        let total: usize = spans.iter().map(|(_, a, b)| b - a).sum();
        assert_eq!(total, 32);
    }

    #[test]
    fn remplissage_triangle_et_sommets_partages() {
        // Un losange dont deux sommets tombent exactement sur un centre de rangée : aucune rangée n'est comptée en double.
        let diamond = [(5.0, 1.5), (8.0, 4.5), (5.0, 7.5), (2.0, 4.5)];
        let spans = fill(&[&diamond], 10, 10);
        let rows: Vec<usize> = spans.iter().map(|s| s.0).collect();
        let mut unique = rows.clone();
        unique.dedup();
        assert_eq!(rows, unique, "une plage par rangée");
        assert!(spans.iter().all(|(_, a, b)| a < b));
        // Aire du losange : 18 ; on doit s'en approcher à un carreau de bord près.
        let area: usize = spans.iter().map(|(_, a, b)| b - a).sum();
        assert!((15..=21).contains(&area), "{area}");
    }

    #[test]
    fn les_niveaux_gardent_le_meilleur() {
        let mut grid = Grid { e0: 0, n0: 0, w: 4, h: 1, levels: [vec![0; 4], vec![0; 4]], land: vec![0] };
        grid.paint_level(0, 1, 2, 0, 0, 3);
        grid.paint_level(0, 1, 1, 0, 1, 4); // plus faible : ne change pas les carreaux 1 et 2
        grid.paint_level(0, 0, 3, 0, 2, 3);
        assert_eq!(grid.levels[0], vec![2 << 2, 2 << 2, (2 << 2) | 3, 1 << 2]);
        grid.paint_land(0, 1, 3);
        assert!(!grid.is_land(0) && grid.is_land(1) && grid.is_land(2) && !grid.is_land(3));
    }

    #[test]
    fn wkb_polygone_avec_en_tete_geopackage() {
        // En-tête GP : « GP », version 0, drapeaux 0x01 (petit-boutiste, pas d'enveloppe), SRID 100000.
        let mut blob = vec![b'G', b'P', 0, 1];
        blob.extend_from_slice(&100_000i32.to_le_bytes());
        // Multipolygone de deux polygones d'un anneau chacun.
        blob.push(1);
        blob.extend_from_slice(&6u32.to_le_bytes());
        blob.extend_from_slice(&2u32.to_le_bytes());
        for offset in [0.0f64, 10.0] {
            blob.push(1);
            blob.extend_from_slice(&3u32.to_le_bytes());
            blob.extend_from_slice(&1u32.to_le_bytes());
            blob.extend_from_slice(&4u32.to_le_bytes());
            for (x, y) in [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0)] {
                blob.extend_from_slice(&(x + offset).to_le_bytes());
                blob.extend_from_slice(&(y as f64).to_le_bytes());
            }
        }
        let wkb = gpkg_wkb(&blob).expect("en-tête valide");
        let mut rings = Vec::new();
        wkb_rings(wkb, &mut 0, &mut rings).expect("WKB valide");
        assert_eq!(rings.len(), 2);
        assert_eq!(rings[1].points, 4);
        assert_eq!(rings[1].point(1), (11.0, 0.0));
        // Tronqué : une erreur, pas un plantage.
        assert!(wkb_rings(&wkb[..wkb.len() - 5], &mut 0, &mut Vec::new()).is_err());
    }

    fn cell_with(a: u8, v: u8) -> Feature {
        Feature { geom: Geometry::Cell(Cell { crs: Crs::Laea, e: 3_760_000, n: 2_890_000, size: 250 }), props: vec![Value::Int(i64::from(a)), Value::Int(i64::from(v))], weight: 1.0 }
    }

    #[test]
    fn un_carreau_d_origine_garde_ses_niveaux_exacts() {
        // 4G : Orange très bonne (3), SFR limitée (1), Bouygues rien, Free bonne (2). Voix : personne.
        let byte = 3 | (1 << 2) | (2 << 6);
        let mut generalizer: Box<dyn Generalizer> = Box::new(Unpack::new(GridAggregator::new(250, Box::new(finalize))));
        generalizer.push(&cell_with(byte, 0));
        let out = generalizer.finish().to_vec();
        assert_eq!(out.len(), 1);
        let ints: Vec<i64> = out[0].props.iter().map(|v| if let Value::Int(i) = v { *i } else { -1 }).collect();
        let unpack = |packed: i64, i: u32| (packed / 128i64.pow(i)) % 128;
        assert_eq!([0, 1, 2, 3].map(|i| unpack(ints[0], i)), [100, 33, 0, 67]);
        assert_eq!([0, 1, 2, 3].map(|i| unpack(ints[1], i)), [100, 100, 0, 100]);
        assert_eq!(ints[2], 30); // trois opérateurs
        assert_eq!(ints[3], 0);
        assert_eq!([ints[4], ints[5], ints[6], ints[7]], [0, 0, 0, 100]); // voix : zone blanche
    }

    #[test]
    fn les_parts_se_recalculent_depuis_les_sommes() {
        // Quatre carreaux de 250 m dans un de 500 m : un couvert par Orange en 4G (très bonne), trois non couverts.
        let mut generalizer: Box<dyn Generalizer> = Box::new(Unpack::new(GridAggregator::new(500, Box::new(finalize))));
        let covered = 3u8;
        for (k, byte) in [covered, 0, 0, 0].into_iter().enumerate() {
            let mut f = cell_with(byte, 0);
            if let Geometry::Cell(c) = &mut f.geom {
                c.e += 250 * (k as i32 % 2);
                c.n += 250 * (k as i32 / 2);
            }
            generalizer.push(&f);
        }
        let out = generalizer.finish().to_vec();
        assert_eq!(out.len(), 1);
        let Value::Int(share) = out[0].props[1] else { panic!() };
        assert_eq!(share % 128, 25, "un quart de la surface couverte par Orange");
        assert_eq!(out[0].props[3], Value::Int(75), "trois quarts sans opérateur");
        assert_eq!(out[0].props[2], Value::Int(3), "0,25 opérateur en moyenne, ×10 arrondi");
    }

    #[test]
    fn les_tailles_se_rangent_dans_les_blocs() {
        for z in 9..=11 {
            assert_eq!(BLOCK_M as u32 % cell_size(z), 0);
            assert_eq!(cell_size(z) % CELL_M as u32, 0);
        }
        assert!(cell_size(4) > cell_size(8) && cell_size(8) > cell_size(11));
        assert_eq!((cell_size(4), cell_size(7), cell_size(10), cell_size(11)), (32_000, 4_000, 500, 250));
    }
}
