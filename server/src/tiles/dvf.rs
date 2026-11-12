//! Jeu de données « dvf » : les prix de l'immobilier (ventes de logements, DGFiP / Etalab).
//!
//! La source, ses conditions de réutilisation et le nettoyage des mutations sont dans `dvf_source.rs`. Ici : comment on
//! en fait des tuiles, et surtout **comment on calcule une médiane sur des données qu'on agrège**.
//!
//! # Deux représentations selon le zoom
//!
//! - **Zoom 14 et plus près** : les ventes elles-mêmes, un point chacune. Propriétés : `mo` (mois, en nombre de mois depuis
//!   janvier 2000), `ty` (0 appartement, 1 maison), `pc` (pièces), `sf` (surface bâtie, m²), `pr` (prix, €), `em` (€/m²).
//!   On ne garde ni adresse ni identifiant ; la date est réduite au mois et la position arrondie à 0,0002° (~20 m) :
//!   c'est la mesure prise contre la ré-identification des personnes (voir `dvf_source.rs`).
//! - **Zoom 13 et plus loin** : des **carreaux** (grille LAEA, 32 km à 100 m selon le zoom) qui portent, pour chaque
//!   combinaison *type de bien* (appartements, maisons, tous) × *période* (12 derniers mois, 5 ans), le nombre de ventes (`n…`),
//!   la **médiane** du prix au m² (`p…`) et les quartiles (`l…` : premier quartile, `h…` : troisième).
//!   Les noms suivent le motif `<grandeur><type><période>` : `pa5` = médiane (p), appartements (a), 5 ans (5) ;
//!   `nm1` = nombre de ventes de maisons (m) sur 12 mois (1) ; `ht5` = 3e quartile, tous biens (t), 5 ans.
//!
//! # Pourquoi pas simplement une médiane par carreau ?
//!
//! Parce qu'**une médiane ne s'additionne pas**. La médiane de deux carreaux n'est pas la moyenne de leurs médianes
//! (ni aucune fonction simple de celles-ci) : pour agréger 25 carreaux en un, il faut revenir aux ventes elles-mêmes. Or
//! à chaque zoom, la tuile doit être faite *sans* garder les 3,5 millions de ventes en mémoire.
//!
//! La solution classique est un **histogramme** : on découpe l'axe des €/m² en classes fixes et, par carreau, on ne
//! compte plus que « combien de ventes dans chaque classe ». Deux histogrammes se *fusionnent* en additionnant classe
//! par classe : c'est exactement ce qu'un `GridAggregator` sait faire avec des sommes. La médiane se lit ensuite sur
//! l'histogramme, une fois, à la fin (`finalize`) : on cherche la classe où le cumul passe la moitié des ventes, puis on
//! interpole à l'intérieur de la classe.
//!
//! Les classes sont **espacées en logarithme** : 128 classes entre 300 et 30 000 €/m², chacune 3,7 % plus large que la
//! précédente. Un prix se perçoit en proportion (de 2 000 à 2 100 €/m² comme de 8 000 à 8 400), donc la précision relative
//! doit être la même partout. Avec des classes d'une largeur fixe en euros, il en faudrait 6 fois plus pour avoir la même
//! précision à Saint-Étienne qu'à Paris. Erreur maximale d'une médiane : la moitié d'une classe, soit 1,8 %, bien en deçà
//! du bruit des données.
//!
//! # Mémoire
//!
//! Un histogramme complet par carreau (4 classes de vente × 128 cases × 4 octets = 2 Ko) pour des centaines de milliers de
//! carreaux ferait des centaines de Mo. La plupart des carreaux n'ont que quelques ventes : on les garde donc
//! *creux* : une liste de triplets (carreau, case, compte), triée et fusionnée de temps en temps (`Cells::compact`).
//! Les 4 « classes de vente » sont : appartement/maison × récent (12 mois) / plus ancien ; les 6 combinaisons affichées
//! (type × période) en sont des sommes (tous biens = appartements + maisons, 5 ans = récent + ancien).
//!
//! # Fabrication
//!
//! `spool_zoom` = 11 : les zooms 4 à 10 se font en un passage global (au plus ~1 M de triplets, quelques dizaines de Mo), les
//! zooms 11 et plus seau par seau (une zone de ~19 km). Pourquoi pas 12 ? Le dépôt garde en mémoire un tampon de 16 Ko *par seau* :
//! 12 000 seaux au zoom 12 coûtaient ~200 Mo de pointe, ~3 000 au zoom 11 en coûtent moins de 100. Un carreau à cheval sur deux seaux doit
//! voir *toutes* ses ventes : `influence` recopie donc dans les seaux voisins les ventes qui sont à moins de ~800 m de leur bord.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use anyhow::{Result, bail};
use tracing::info;

use super::dvf_source::{self, MAX_EURO_M2, MIN_EURO_M2, Sale, YearReport};
use super::geom::Bounds;
use super::proj::{Crs, laea_forward};
use super::{Cell, Dataset, Feature, FeatureSet, Generalizer, Geometry, Value};

/// À partir de ce zoom, on montre les ventes (des points) ; avant, des carreaux.
pub const POINTS_FROM: u8 = 14;
/// Nombre de classes de l'histogramme des €/m².
pub(crate) const BINS: usize = 128;
/// Une vente a au plus cet âge (en mois, depuis le mois de référence exclu) pour entrer dans « 5 ans » ; « récent » : 12 mois.
const MAX_AGE: u32 = 60;
const RECENT_AGE: u32 = 12;
/// Pas d'arrondi de la position d'une vente (degrés) : ~22 m en latitude. Mesure contre la ré-identification.
const SNAP: f64 = 0.0002;
/// Marge de recopie dans les seaux voisins (degrés, large : ~800 m en latitude, plus en longitude) : plus que la diagonale du plus gros
/// carreau agrégé dans un seau (250 m au zoom 11).
const MARGIN_LAT: f64 = 0.0075;
const MARGIN_LON: f64 = 0.0110;

/// Propriétés d'un point (une vente), puis les 4 grandeurs des carreaux × 6 combinaisons (type × période).
const KEYS: [&str; 30] = [
    "mo", "ty", "pc", "sf", "pr", "em", //
    "na1", "na5", "nm1", "nm5", "nt1", "nt5", //
    "pa1", "pa5", "pm1", "pm5", "pt1", "pt5", //
    "la1", "la5", "lm1", "lm5", "lt1", "lt5", //
    "ha1", "ha5", "hm1", "hm5", "ht1", "ht5",
];
const POINT_KEYS: usize = 6;

/// Côté des carreaux à chaque zoom (mètres) : ~10 pixels d'écran à toutes les échelles. Une tuile fait 512 pixels : elle
/// contient donc au plus ~2 600 carreaux, que le plafond de 500 Ko encaisse (un carreau pèse ~150 octets : 30 propriétés).
/// Avec 5 pixels (comme la population, qui n'a que 7 propriétés), les tuiles des zooms 5 à 7 dépassaient 1 Mo.
fn cell_size(zoom: u8) -> u32 {
    match zoom {
        ..=4 => 32_000,
        5 => 16_000,
        6 => 8_000,
        7 => 4_000,
        8 => 2_000,
        9 => 1_000,
        10 => 500,
        11 => 250,
        12 => 125,
        _ => 100,
    }
}

// ---------------------------------------------------------------------------------------------
// L'histogramme logarithmique et la médiane qu'on y lit
// ---------------------------------------------------------------------------------------------

/// Numéro de la classe d'un prix au m². Les prix hors bornes sont ramenés à la première ou à la dernière classe.
pub(crate) fn bin_of(euro_m2: f64) -> usize {
    let position = (euro_m2 / MIN_EURO_M2).ln() / (MAX_EURO_M2 / MIN_EURO_M2).ln() * BINS as f64;
    position.floor().clamp(0.0, (BINS - 1) as f64) as usize
}

/// Le quantile `q` (0,5 : la médiane) d'un histogramme : on trouve la classe où le cumul atteint `q × total`, puis on
/// interpole *géométriquement* à l'intérieur (la classe est une plage log-régulière : milieu = moyenne géométrique de ses bornes).
fn quantile(hist: &[u32], q: f64) -> f64 {
    let total: f64 = hist.iter().map(|&c| f64::from(c)).sum();
    if total == 0.0 {
        return 0.0;
    }
    let target = q * total;
    let mut cumulative = 0.0;
    for (bin, &count) in hist.iter().enumerate() {
        let next = cumulative + f64::from(count);
        if count > 0 && next >= target {
            let inside = ((target - cumulative) / f64::from(count)).clamp(0.0, 1.0);
            return MIN_EURO_M2 * (MAX_EURO_M2 / MIN_EURO_M2).powf((bin as f64 + inside) / BINS as f64);
        }
        cumulative = next;
    }
    MAX_EURO_M2
}

// ---------------------------------------------------------------------------------------------
// Une vente en deux entiers (économie de mémoire du dépôt)
// ---------------------------------------------------------------------------------------------

/// Une vente telle qu'elle circule entre `scan` et les généralisateurs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct SaleProps {
    month: u32,
    kind: u32,
    rooms: u32,
    surface: u32,
    euro_m2: u32,
    price: u32,
}

impl SaleProps {
    /// Deux `Value::Int` au lieu de six : un `Feature` en mémoire pèse ~240 octets avec six propriétés (24 octets chacune), ~120
    /// avec deux. Le seau le plus dense (Paris et sa proche couronne, ~600 000 ventes) est chargé en entier : c'est ce qui fixait
    /// la pointe de mémoire de la fabrication. Mois (10 bits), type (1), pièces (5), surface (10), €/m² (15) dans le premier entier ; le prix dans le second.
    fn pack(self) -> Vec<Value> {
        let a = i64::from(self.month) | i64::from(self.kind) << 10 | i64::from(self.rooms) << 11 | i64::from(self.surface) << 16 | i64::from(self.euro_m2) << 26;
        vec![Value::Int(a), Value::Int(i64::from(self.price))]
    }

    fn unpack(props: &[Value]) -> Option<SaleProps> {
        let (Some(Value::Int(a)), Some(Value::Int(price))) = (props.first(), props.get(1)) else { return None };
        let field = |shift: u32, bits: u32| ((*a >> shift) & ((1 << bits) - 1)) as u32;
        Some(SaleProps { month: field(0, 10), kind: field(10, 1), rooms: field(11, 5), surface: field(16, 10), euro_m2: field(26, 15), price: *price as u32 })
    }
}

// ---------------------------------------------------------------------------------------------
// Les carreaux : histogrammes creux fusionnés
// ---------------------------------------------------------------------------------------------

/// « Il y a `count` ventes de la classe de vente `class` dans la case `bin` du carreau `cell` » : 12 octets.
#[derive(Clone, Copy)]
struct Entry {
    /// Indices du carreau (est, nord) à ce zoom.
    cell: [u32; 2],
    /// `classe de vente × 128 + case` sur 9 bits (classe : 0 appartement récent, 1 appartement ancien, 2 maison récente,
    /// 3 maison ancienne), puis le décompte sur 23 bits (jusqu'à 8 millions : plus que toutes les ventes de France).
    class_bin_count: u32,
}

const COUNT_BITS: u32 = 23;
const COUNT_MASK: u32 = (1 << COUNT_BITS) - 1;

impl Entry {
    fn class_bin(&self) -> u32 {
        self.class_bin_count >> COUNT_BITS
    }
    fn count(&self) -> u32 {
        self.class_bin_count & COUNT_MASK
    }
    fn key(&self) -> u64 {
        u64::from(self.cell[0]) << 32 | u64::from(self.cell[1])
    }
}

/// Mois de la vente depuis janvier 2000.
fn month_of(sale: &Sale) -> u32 {
    (u32::from(sale.date.0) - 2000) * 12 + u32::from(sale.date.1) - 1
}

/// Le généralisateur des zooms 4 à 13 : des ventes (points) en carreaux de `size` mètres, par histogrammes fusionnés.
pub struct Cells {
    size: u32,
    reference_month: u32,
    entries: Vec<Entry>,
    /// Nombre de triplets à partir duquel on fusionne les identiques (une fois et demie le nombre de triplets distincts après la dernière fusion).
    limit: usize,
    /// Plancher de `limit` (réglable pour les tests).
    floor: usize,
}

impl Cells {
    pub fn new(size: u32, reference_month: u32) -> Cells {
        Cells { size, reference_month, entries: Vec::new(), limit: 1 << 18, floor: 1 << 18 }
    }

    /// Trie les triplets et additionne ceux qui désignent la même case du même carreau : l'*addition d'histogrammes*.
    /// Fusion *sur place* (deux indices dans le même tableau) : une copie ferait pointer la mémoire au double de la taille utile.
    fn compact(&mut self) {
        self.entries.sort_unstable_by_key(|e| (e.cell, e.class_bin_count >> COUNT_BITS));
        let mut write = 0;
        for read in 0..self.entries.len() {
            let entry = self.entries[read];
            if write > 0 && self.entries[write - 1].cell == entry.cell && self.entries[write - 1].class_bin() == entry.class_bin() {
                self.entries[write - 1].class_bin_count += entry.count();
            } else {
                self.entries[write] = entry;
                write += 1;
            }
        }
        self.entries.truncate(write);
        // On refusionne quand le tableau aura grandi de moitié : la mémoire reste proportionnelle au nombre de triplets *distincts*.
        self.limit = (self.entries.len() * 3 / 2).max(self.floor);
        self.entries.reserve_exact(self.limit - self.entries.len());
    }

    fn add(&mut self, lon: f64, lat: f64, class: u16, bin: usize, count: u32) {
        let (e, n) = laea_forward(lon, lat);
        let size = f64::from(self.size);
        let cell = [(e / size).floor() as i32 as u32, (n / size).floor() as i32 as u32];
        self.entries.push(Entry { cell, class_bin_count: (u32::from(class) * BINS as u32 + bin as u32) << COUNT_BITS | count });
        if self.entries.len() >= self.limit {
            self.compact();
        }
    }
}

impl Generalizer for Cells {
    /// Une vente (Feature point, propriétés empaquetées par `SaleProps::pack`) ajoute 1 dans sa case.
    fn push(&mut self, feature: &Feature) {
        let Geometry::Point(p) = feature.geom else { return };
        let Some(sale) = SaleProps::unpack(&feature.props) else { return };
        let recent = self.reference_month.saturating_sub(sale.month) < RECENT_AGE;
        let class = sale.kind as u16 * 2 + u16::from(!recent);
        self.add(p[0], p[1], class, bin_of(f64::from(sale.euro_m2)), 1);
    }

    fn finish(mut self: Box<Self>) -> Box<dyn FeatureSet> {
        self.compact();
        self.entries.shrink_to_fit(); // la réserve de `compact` ne sert plus
        let mut starts: Vec<(u64, u32)> = Vec::new();
        for (i, entry) in self.entries.iter().enumerate() {
            if starts.last().is_none_or(|s| s.0 != entry.key()) {
                starts.push((entry.key(), i as u32));
            }
        }
        Box::new(CellSet { entries: self.entries, starts, size: self.size })
    }
}

/// Les carreaux d'un zoom, fabriqués à la demande à partir des histogrammes creux (12 octets par triplet, 16 par carreau).
struct CellSet {
    entries: Vec<Entry>,
    /// Pour chaque carreau : sa clé et la position de son premier triplet.
    starts: Vec<(u64, u32)>,
    size: u32,
}

impl FeatureSet for CellSet {
    fn len(&self) -> usize {
        self.starts.len()
    }

    fn get(&self, index: usize) -> std::borrow::Cow<'_, Feature> {
        let (key, start) = self.starts[index];
        let end = self.starts.get(index + 1).map_or(self.entries.len(), |s| s.1 as usize);
        let mut hist = [[0u32; BINS]; 4];
        for entry in &self.entries[start as usize..end] {
            hist[entry.class_bin() as usize / BINS][entry.class_bin() as usize % BINS] += entry.count();
        }
        let (props, weight) = finalize(&hist, self.size < 250);
        let (ix, iy) = ((key >> 32) as u32 as i32, key as u32 as i32);
        let cell = Cell { crs: Crs::Laea, e: ix * self.size as i32, n: iy * self.size as i32, size: self.size };
        std::borrow::Cow::Owned(Feature { geom: Geometry::Cell(cell), props, weight })
    }
}

/// Des 4 histogrammes (classes de vente) aux propriétés de la tuile : c'est ici qu'on **lit** les médianes.
/// `short` : sans les quartiles (aux zooms où un carreau a trop peu de ventes pour qu'ils veuillent dire quelque chose).
fn finalize(hist: &[[u32; BINS]; 4], short: bool) -> (Vec<Value>, f32) {
    // Les 6 combinaisons, dans l'ordre des clés : (a, m, tous) × (12 mois, 5 ans). Classes : 0 a. récent, 1 a. ancien, 2 m. récente, 3 m. ancienne.
    const COMBOS: [&[usize]; 6] = [&[0], &[0, 1], &[2], &[2, 3], &[0, 2], &[0, 1, 2, 3]];
    let mut counts = Vec::with_capacity(6);
    let mut medians = Vec::with_capacity(6);
    let mut lows = Vec::with_capacity(6);
    let mut highs = Vec::with_capacity(6);
    for combo in COMBOS {
        let mut merged = [0u32; BINS];
        for &class in combo {
            for (sum, count) in merged.iter_mut().zip(&hist[class]) {
                *sum += count;
            }
        }
        let n: u32 = merged.iter().sum();
        counts.push(Value::Int(i64::from(n)));
        let round = |q: f64| Value::Int(if n == 0 { 0 } else { quantile(&merged, q).round() as i64 });
        medians.push(round(0.5));
        lows.push(round(0.25));
        highs.push(round(0.75));
    }
    let weight = match &counts[5] {
        Value::Int(n) => *n as f32,
        _ => 0.0,
    };
    let mut props: Vec<Value> = vec![Value::Int(0); POINT_KEYS]; // les clés des points (positions 0 à 5) : sans objet pour un carreau
    props.extend(counts);
    props.extend(medians);
    if !short {
        props.extend(lows);
        props.extend(highs);
    }
    (props, weight)
}

// ---------------------------------------------------------------------------------------------
// Les points : les ventes, sous forme compacte
// ---------------------------------------------------------------------------------------------

/// Une vente en 32 octets (un `Feature` en ferait ~200) : on en garde des dizaines de milliers par seau.
#[derive(Clone, Copy)]
struct Pt {
    lon: f64,
    lat: f64,
    month: u16,
    kind: u8,
    rooms: u8,
    surface: u16,
    euro_m2: u16,
    price: u32,
}

#[derive(Default)]
struct Points {
    points: Vec<Pt>,
}

impl Generalizer for Points {
    fn push(&mut self, feature: &Feature) {
        let Geometry::Point(p) = feature.geom else { return };
        let Some(sale) = SaleProps::unpack(&feature.props) else { return };
        self.points.push(Pt {
            lon: p[0],
            lat: p[1],
            month: sale.month as u16,
            kind: sale.kind as u8,
            rooms: sale.rooms as u8,
            surface: sale.surface as u16,
            price: sale.price,
            euro_m2: sale.euro_m2 as u16,
        });
    }

    fn finish(self: Box<Self>) -> Box<dyn FeatureSet> {
        Box::new(PointSet { points: self.points })
    }
}

struct PointSet {
    points: Vec<Pt>,
}

impl FeatureSet for PointSet {
    fn len(&self) -> usize {
        self.points.len()
    }
    fn get(&self, index: usize) -> std::borrow::Cow<'_, Feature> {
        let p = self.points[index];
        let ints = [p.month.into(), p.kind.into(), p.rooms.into(), p.surface.into(), p.price.into(), p.euro_m2.into()];
        std::borrow::Cow::Owned(Feature {
            geom: Geometry::Point([p.lon, p.lat]),
            props: ints.into_iter().map(Value::Int).collect(),
            // Si une tuile est trop grosse, les ventes les plus anciennes partent d'abord.
            weight: f32::from(p.month),
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Le jeu de données
// ---------------------------------------------------------------------------------------------

/// Ce qu'on apprend pendant la lecture, pour la fiche du jeu (légendes, avertissements).
struct ScanState {
    /// Histogrammes nationaux : [type][0 = 12 mois, 1 = plus ancien].
    national: [[[u32; BINS]; 2]; 2],
    reports: Vec<YearReport>,
    too_old: u64,
    emitted: u64,
}

impl Default for ScanState {
    fn default() -> Self {
        ScanState { national: [[[0; BINS]; 2]; 2], reports: Vec::new(), too_old: 0, emitted: 0 }
    }
}

pub struct Dvf {
    state: Mutex<ScanState>,
    /// Mois de la vente la plus récente (mois depuis janvier 2000) : la « fin » des périodes. Fixé par `scan`.
    reference_month: AtomicU32,
}

impl Dvf {
    pub fn new() -> Dvf {
        Dvf { state: Mutex::new(ScanState::default()), reference_month: AtomicU32::new(0) }
    }
}

impl Default for Dvf {
    fn default() -> Self {
        Dvf::new()
    }
}

fn now_year_half() -> (u16, u8) {
    let now = jiff::Timestamp::now().to_zoned(jiff::tz::TimeZone::UTC);
    (now.year() as u16, if now.month() <= 6 { 1 } else { 2 })
}

fn month_label(month: u32) -> String {
    format!("{:04}-{:02}", 2000 + month / 12, month % 12 + 1)
}

impl Dataset for Dvf {
    fn id(&self) -> &'static str {
        "dvf"
    }
    fn layer(&self) -> &'static str {
        "dvf"
    }
    fn keys(&self) -> &'static [&'static str] {
        &KEYS
    }
    fn zooms(&self) -> (u8, u8) {
        (4, POINTS_FROM)
    }
    fn schema_version(&self) -> u32 {
        1
    }
    /// Etalab publie de nouvelles ventes en avril et en octobre environ : l'archive est refaite deux fois par an (et
    /// la source, retéléchargée seulement si Etalab a modifié ses fichiers).
    fn source_id(&self) -> String {
        let (year, half) = now_year_half();
        format!("dvf-{year}S{half}-nettoyage{}", dvf_source::CLEAN_VERSION)
    }
    fn attribution(&self) -> &'static str {
        "DGFiP, DVF ; Etalab"
    }
    fn license(&self) -> &'static str {
        "Licence ouverte Etalab 2.0"
    }
    /// 11 : voir l'en-tête (mémoire des tampons de dépôt contre taille d'un seau).
    fn spool_zoom(&self) -> u8 {
        11
    }

    fn acquire<'a>(&'a self, http: &'a reqwest::Client, dir: &'a Path) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move { dvf_source::acquire(http, dir, now_year_half().0).await })
    }

    fn scan(&self, dir: &Path, emit: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        let years = dvf_source::cleaned_years(dir);
        if years.is_empty() {
            bail!("aucune vente DVF nettoyée dans {}", dir.display());
        }
        // Passe 1 : le mois le plus récent, qui est la fin des périodes (« 12 derniers mois » = les 12 mois qui s'y terminent).
        let mut newest = 0u32;
        for &year in &years {
            dvf_source::read_sales(dir, year, |sale| {
                newest = newest.max(month_of(&sale));
                Ok(())
            })?;
        }
        self.reference_month.store(newest, Ordering::Relaxed);
        let mut state = ScanState { reports: years.iter().filter_map(|y| dvf_source::read_report(dir, *y)).collect(), ..Default::default() };

        // Passe 2 : les ventes.
        for &year in &years {
            dvf_source::read_sales(dir, year, |sale| {
                let month = month_of(&sale);
                let age = newest - month;
                if age >= MAX_AGE {
                    state.too_old += 1;
                    return Ok(());
                }
                let euro_m2 = sale.euro_m2();
                state.national[usize::from(sale.kind)][usize::from(age >= RECENT_AGE)][bin_of(euro_m2)] += 1;
                state.emitted += 1;
                let snap = |v: f64| (v / SNAP).round() * SNAP;
                emit(Feature {
                    geom: Geometry::Point([snap(sale.lon), snap(sale.lat)]),
                    props: SaleProps {
                        month,
                        kind: u32::from(sale.kind),
                        rooms: u32::from(sale.rooms),
                        surface: u32::from(sale.surface),
                        euro_m2: euro_m2.round() as u32,
                        price: sale.price,
                    }
                    .pack(),
                    weight: month as f32,
                })
            })?;
            info!(annee = year, "dvf : ventes lues");
        }
        info!(ventes = state.emitted, trop_anciennes = state.too_old, mois_reference = %month_label(newest), "dvf : lecture terminée");
        *self.state.lock().expect("état de la lecture") = state;
        Ok(())
    }

    fn generalizer(&self, zoom: u8) -> Box<dyn Generalizer> {
        if zoom >= POINTS_FROM {
            Box::new(Points::default())
        } else {
            Box::new(Cells::new(cell_size(zoom), self.reference_month.load(Ordering::Relaxed)))
        }
    }

    /// Une vente peut changer le carreau d'un seau voisin si elle est près de son bord : on la lui recopie.
    fn influence(&self, feature: &Feature) -> Bounds {
        let Geometry::Point(p) = feature.geom else { return Bounds::EMPTY };
        Bounds { min: [p[0] - MARGIN_LON, p[1] - MARGIN_LAT], max: [p[0] + MARGIN_LON, p[1] + MARGIN_LAT] }
    }

    fn metadata(&self) -> serde_json::Value {
        let state = self.state.lock().expect("état de la lecture");
        let newest = self.reference_month.load(Ordering::Relaxed);
        // Statistiques nationales par (type, période) : n, médiane, quartiles.
        let stats = |hist: &[u32; BINS]| {
            serde_json::json!({ "n": hist.iter().map(|&c| u64::from(c)).sum::<u64>(), "mediane": quantile(hist, 0.5).round(), "q1": quantile(hist, 0.25).round(), "q3": quantile(hist, 0.75).round() })
        };
        let merge = |classes: &[(usize, usize)]| {
            let mut merged = [0u32; BINS];
            for &(kind, period) in classes {
                for (sum, count) in merged.iter_mut().zip(&state.national[kind][period]) {
                    *sum += count;
                }
            }
            merged
        };
        let national = serde_json::json!({
            "a1": stats(&merge(&[(0, 0)])), "a5": stats(&merge(&[(0, 0), (0, 1)])),
            "m1": stats(&merge(&[(1, 0)])), "m5": stats(&merge(&[(1, 0), (1, 1)])),
            "t1": stats(&merge(&[(0, 0), (1, 0)])), "t5": stats(&merge(&[(0, 0), (0, 1), (1, 0), (1, 1)])),
        });
        serde_json::json!({
            "moisReference": month_label(newest),
            "debut12mois": month_label((newest + 1).saturating_sub(RECENT_AGE)),
            "debut5ans": month_label((newest + 1).saturating_sub(MAX_AGE)),
            "pointsDepuis": POINTS_FROM,
            "ventes": state.emitted,
            "tropAnciennes": state.too_old,
            // Médianes de la France entière : le milieu de la palette divergente et de la légende.
            "national": national,
            "annees": state.reports,
            "tailles": (4..POINTS_FROM).map(|z| serde_json::json!([z, cell_size(z)])).collect::<Vec<_>>(),
            "explorateur": "https://explore.data.gouv.fr/fr/immobilier",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sale_feature(lon: f64, lat: f64, month: u32, kind: u8, euro_m2: i64) -> Feature {
        Feature {
            geom: Geometry::Point([lon, lat]),
            props: SaleProps { month, kind: u32::from(kind), rooms: 3, surface: 60, euro_m2: euro_m2 as u32, price: euro_m2 as u32 * 60 }.pack(),
            weight: 1.0,
        }
    }

    fn int(value: &Value) -> i64 {
        match value {
            Value::Int(i) => *i,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn la_mediane_lue_dans_l_histogramme_est_juste_a_deux_pour_cent_pres() {
        // 1 001 prix répartis régulièrement en log de 1 000 à 9 000 €/m² : la médiane exacte est 3 000.
        let mut hist = [0u32; BINS];
        let mut prices = Vec::new();
        for i in 0..=1000 {
            let price = 1000.0 * 9f64.powf(f64::from(i) / 1000.0);
            prices.push(price);
            hist[bin_of(price)] += 1;
        }
        for (q, exact) in [(0.25, prices[250]), (0.5, prices[500]), (0.75, prices[750])] {
            let read = quantile(&hist, q);
            assert!((read / exact - 1.0).abs() < 0.02, "q = {q} : lu {read}, exact {exact}");
        }
    }

    #[test]
    fn deux_histogrammes_fusionnes_donnent_la_mediane_de_l_ensemble() {
        // La moyenne des médianes de deux groupes inégaux se trompe de beaucoup ; la fusion des histogrammes, non.
        let mut a = [0u32; BINS];
        let mut b = [0u32; BINS];
        let mut all = Vec::new();
        for i in 0..900 {
            let p = 2000.0 + f64::from(i); // 900 ventes de 2 000 à 2 900
            a[bin_of(p)] += 1;
            all.push(p);
        }
        for i in 0..100 {
            let p = 8000.0 + f64::from(i) * 10.0; // 100 ventes de 8 000 à 8 990
            b[bin_of(p)] += 1;
            all.push(p);
        }
        let merged: Vec<u32> = a.iter().zip(&b).map(|(x, y)| x + y).collect();
        let exact = all[500]; // médiane exacte de 1 000 ventes triées
        assert!((quantile(&merged, 0.5) / exact - 1.0).abs() < 0.02);
        // La « moyenne des médianes » : (2 450 + 8 500) / 2 = 5 475, très loin.
        let average_of_medians = (quantile(&a, 0.5) + quantile(&b, 0.5)) / 2.0;
        assert!((average_of_medians / exact - 1.0).abs() > 1.0);
    }

    #[test]
    fn les_carreaux_comptent_par_type_et_periode() {
        let reference = 300; // mois de référence
        let mut cells = Cells::new(1000, reference);
        // Dans le même kilomètre carré : 3 appartements récents à ~4 000, 1 appartement ancien à 3 000, 2 maisons récentes à ~2 000.
        for (month, kind, price) in [(300, 0, 4000), (295, 0, 4100), (292, 0, 3900), (250, 0, 3000), (299, 1, 2000), (298, 1, 2100)] {
            cells.push(&sale_feature(2.3522, 48.8566, month, kind, price));
        }
        // Une vente à l'autre bout de la France : un autre carreau.
        cells.push(&sale_feature(-1.55, 43.4, 300, 0, 5000));
        let set = Box::new(cells).finish();
        assert_eq!(set.len(), 2);
        let features = set.to_vec();
        let paris = features.iter().find(|f| int(&f.props[POINT_KEYS]) > 1 || int(&f.props[POINT_KEYS + 1]) > 1).expect("carreau de Paris");
        let n = |name: &str| int(&paris.props[KEYS.iter().position(|k| *k == name).unwrap()]);
        assert_eq!((n("na1"), n("na5"), n("nm1"), n("nm5"), n("nt1"), n("nt5")), (3, 4, 2, 2, 5, 6));
        // Médiane des appartements récents : 4 000 (±2 %) ; des maisons : 2 000 à 2 100.
        assert!((n("pa1") as f64 / 4000.0 - 1.0).abs() < 0.03, "{}", n("pa1"));
        assert!((2000..=2150).contains(&n("pm5")), "{}", n("pm5"));
        assert!(n("la5") <= n("pa5") && n("pa5") <= n("ha5"));
        assert_eq!(paris.weight, 6.0);
        // Les propriétés de points sont des zéros inertes : une tuile garde les mêmes clés pour tous les objets.
        assert!(paris.props[..POINT_KEYS].iter().all(|v| int(v) == 0));
        assert_eq!(paris.props.len(), KEYS.len());
    }

    #[test]
    fn la_fusion_periodique_ne_change_pas_le_resultat() {
        // `limit` minuscule : on fusionne les triplets tous les quelques ajouts ; même résultat qu'une fusion unique.
        let sales: Vec<Feature> = (0..500).map(|i| sale_feature(2.30 + f64::from(i % 7) * 0.01, 48.85, 290 + i % 10, (i % 2) as u8, 2000 + i64::from(i) * 5)).collect();
        let mut small = Cells::new(1000, 299);
        (small.limit, small.floor) = (8, 8);
        let mut large = Cells::new(1000, 299);
        for s in &sales {
            small.push(s);
            large.push(s);
        }
        let (a, b) = (Box::new(small).finish().to_vec(), Box::new(large).finish().to_vec());
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(&b) {
            assert_eq!(x.props, y.props);
        }
    }

    #[test]
    fn l_empaquetage_d_une_vente_est_reversible() {
        let sale = SaleProps { month: 311, kind: 1, rooms: 20, surface: 600, euro_m2: 30_000, price: 17_999_999 };
        assert_eq!(SaleProps::unpack(&sale.pack()), Some(sale));
        let small = SaleProps { month: 0, kind: 0, rooms: 0, surface: 9, euro_m2: 300, price: 10_000 };
        assert_eq!(SaleProps::unpack(&small.pack()), Some(small));
    }

    #[test]
    fn les_points_gardent_leurs_proprietes() {
        let mut points: Box<dyn Generalizer> = Box::new(Points::default());
        points.push(&sale_feature(2.3522, 48.8566, 300, 1, 3000));
        let out = points.finish().to_vec();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].props.iter().map(int).collect::<Vec<_>>(), vec![300, 1, 3, 60, 180_000, 3000]);
        assert_eq!(out[0].weight, 300.0);
    }

    #[test]
    fn les_cles_et_les_tailles_sont_coherentes() {
        assert_eq!(KEYS.len(), POINT_KEYS + 24);
        assert!(cell_size(4) > cell_size(8) && cell_size(8) > cell_size(13));
        // La marge de recopie couvre deux fois la diagonale du plus gros carreau agrégé dans un seau (zoom 11).
        assert!(MARGIN_LAT * 111_000.0 > 2.0 * f64::from(cell_size(11)) * 1.42);
        assert_eq!(month_label(24 * 12 + 11), "2024-12");
    }
}
