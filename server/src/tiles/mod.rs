//! Moteur de tuiles vectorielles : préparer une fois de gros jeux de données, les généraliser par zoom,
//! les servir en tuiles.
//!
//! # Pourquoi des tuiles ?
//!
//! Le navigateur ne peut pas télécharger 2,3 millions de carreaux de population (ni les prix de l'immobilier,
//! ni les bureaux de vote). Il lui faut seulement ce qui est à l'écran, avec le bon niveau de détail. On
//! découpe donc le monde en tuiles (le schéma « XYZ » du Web Mercator : `2^z × 2^z` tuiles au zoom `z`),
//! et chaque tuile contient les objets de son carré, **généralisés** pour son zoom : à l'échelle de la France,
//! un carreau de 200 m ferait moins d'un pixel ; on en montre des agrégats de 16 km.
//!
//! # Les pièces (un fichier chacune)
//!
//! - `mvt` : l'encodage des tuiles (Mapbox Vector Tiles, du protobuf écrit à la main) ;
//! - `geom` : projection Web Mercator, découpage au bord de la tuile (avec marge) et simplification ;
//! - `pmtiles` : l'archive PMTiles v3 (numéros de Hilbert, répertoires, déduplication, gzip), en écriture et en lecture ;
//! - `proj` : les projections des jeux de données (LAEA, UTM) ;
//! - `builder` : la fabrication (ce fichier-ci dit les types, `builder` fait le travail) ;
//! - `serve` : la publication (`/api/tuiles/…`) et la fabrication en tâche de fond ;
//! - `dvf`, `dvf_source` : les prix de l'immobilier (médianes par histogrammes fusionnés) ;
//! - `population` : le premier jeu de données, les carreaux de 200 m de l'INSEE (exemple à suivre).
//!
//! # La fabrication, en trois temps (mémoire bornée)
//!
//! 1. **Dépôt** (`Dataset::scan`) : la source est lue *en flux*, objet par objet. Chacun est écrit dans un fichier
//!    temporaire « seau », celui de la tuile du zoom `SPOOL_ZOOM` qui contient son point d'ancrage. Rien n'est gardé en mémoire.
//! 2. **Zooms bas** (< `SPOOL_ZOOM`) : un passage sur tous les seaux *par zoom*. Un `Generalizer` agrège au fil de
//!    l'eau (carreaux voisins en un plus gros, points en grappes) : le résultat, petit, tient en mémoire, et on en tire les tuiles.
//! 3. **Zooms hauts** : seau par seau. On charge un seau (une zone de ~80 km), on généralise, on découpe en tuiles, on libère.
//!    Un seau n'est jamais plus gros qu'une région dense : la mémoire reste bornée, quelle que soit la taille de la source.
//!
//! Les tuiles sont écrites dans l'archive au fur et à mesure (le `pmtiles::Writer` les remet dans l'ordre à la fin).
//!
//! # Comment ajouter un jeu de données
//!
//! 1. Créer `tiles/mon_jeu.rs` et y définir un type qui implémente [`Dataset`] :
//!    - `id()` (« dvf ») : l'identifiant, qui sert dans l'adresse `/api/tuiles/dvf/…` ;
//!    - `layer()` et `keys()` : le nom de la couche MVT et les noms des propriétés, dans l'ordre de `Feature::props` ;
//!    - `zooms()` : zooms minimal et maximal des tuiles ; au-delà du maximum, le navigateur étire la dernière tuile ;
//!    - `scan()` : lit la source **en flux** et appelle `emit(Feature)` pour chaque objet (un point, un polygone,
//!      ou un carreau de grille) avec ses propriétés. Ne jamais accumuler les objets dans un `Vec` ici ;
//!    - `generalizer(zoom)` : comment réduire les objets à ce zoom. Prêts à l'emploi : [`PassThrough`] (polygones :
//!      la simplification et le découpage sont faits pour tout le monde à l'étape suivante), [`PointCluster`]
//!      (points → grappes sur une grille de pixels), [`GridAggregator`] (carreaux → carreaux plus gros, en
//!      *additionnant* les comptes : les ratios se recalculent à partir des sommes dans `finalize`, jamais en moyennant des moyennes) ;
//!    - `acquire()` : télécharge la source si elle manque ; `source_id()` : un identifiant du millésime de la source
//!      (l'archive n'est refaite que s'il change ; les sources de ce genre changent une fois par an) ;
//!    - facultatifs : `metadata()` (plages de valeurs pour les légendes), `finish()` (fichiers annexes), `influence()` et
//!      `anchor()` (voir « Données en grille » ci-dessous), `priority` de chaque objet (`Feature::weight`) quand une tuile est trop grosse.
//! 2. L'enregistrer dans [`serve::datasets`] : c'est tout pour le serveur. La fabrication part en tâche de fond au démarrage s'il
//!    n'y a pas d'archive pour ce millésime, et l'ancienne reste servie en attendant.
//! 3. Côté site : une source `vector` sur `/api/tuiles/<id>/<version>/{z}/{x}/{y}` (la version vient de `/api/tuiles/<id>`),
//!    voir `web/src/map/vectorTiles.ts` et `web/src/modules/population.ts`.
//!
//! ## Données en grille
//!
//! Un carreau (`Geometry::Cell`) coûte 8 octets au lieu d'un polygone. Un `GridAggregator` à un zoom donné doit voir
//! *tous* les carreaux qui forment un même gros carreau, sinon deux demi-sommes se superposent. `anchor()` choisit le seau
//! d'un objet (il doit être le même pour tous les objets qu'on agrège ensemble) et `influence()` dit quelle zone
//! l'objet peut toucher (le seau en reçoit une copie s'il la touche) : pour une grille, le bloc de plusieurs kilomètres
//! qui contient le carreau.
//!
//! ## Données en polygones (couverture mobile, bureaux de vote…)
//!
//! Utiliser `PassThrough` : à chaque zoom, chaque polygone est reprojeté, découpé au carré de la tuile plus une marge de
//! 64 unités, simplifié (tolérance en unités de tuile : donc plus fort aux zooms bas) et ignoré s'il fait moins d'un
//! pixel. Deux réglages : `zooms().0` (ne pas fabriquer les zooms où le jeu n'a pas de sens, car aux zooms bas
//! *tous* les polygones passent en mémoire) et la taille maximale d'une tuile (`Options::max_tile_bytes`) : au-delà, les
//! objets de plus faible `weight` sont retirés et un avertissement est journalisé.

pub mod builder;
pub mod couverture;
pub mod dvf;
pub mod dvf_source;
pub mod elections;
pub mod elections_geo;
pub mod geom;
pub mod mvt;
pub mod pmtiles;
pub mod popgrid;
pub mod population;
pub mod proj;
pub mod serve;

use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;

use anyhow::Result;

use geom::Bounds;
use proj::Crs;

pub use mvt::Value;
pub use serve::Registry;

/// Un carreau d'une grille régulière : coin sud-ouest `(e, n)` en mètres dans le repère `crs`, côté `size` mètres.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Cell {
    pub crs: Crs,
    pub e: i32,
    pub n: i32,
    pub size: u32,
}

impl Cell {
    /// Les quatre coins en lon/lat, dans le sens des aiguilles d'une montre vu de dessus (sud-ouest, nord-ouest, nord-est, sud-est).
    pub fn corners(&self) -> [[f64; 2]; 4] {
        let (e0, n0) = (f64::from(self.e), f64::from(self.n));
        let s = f64::from(self.size);
        [(e0, n0), (e0, n0 + s), (e0 + s, n0 + s), (e0 + s, n0)].map(|(e, n)| {
            let (lon, lat) = self.crs.to_lonlat(e, n);
            [lon, lat]
        })
    }

    /// Le bloc de `block` mètres de côté, aligné sur la grille, qui contient ce carreau.
    pub fn block(&self, block: i32) -> Cell {
        Cell { crs: self.crs, e: self.e.div_euclid(block) * block, n: self.n.div_euclid(block) * block, size: block as u32 }
    }
}

/// Forme d'un objet, en lon/lat.
#[derive(Clone, Debug)]
pub enum Geometry {
    Point([f64; 2]),
    /// Anneau extérieur, puis les trous. Les anneaux n'ont pas besoin d'être fermés.
    Polygon(Vec<Vec<[f64; 2]>>),
    Cell(Cell),
}

/// Un objet à mettre en tuiles : une forme et ses propriétés (dans l'ordre de `Dataset::keys`).
#[derive(Clone, Debug)]
pub struct Feature {
    pub geom: Geometry,
    pub props: Vec<Value>,
    /// Importance de l'objet : quand une tuile dépasse la taille permise, les moins importants partent d'abord.
    pub weight: f32,
}

impl Feature {
    /// Anneaux de la forme en lon/lat (vide pour un point).
    pub fn rings(&self) -> Vec<Vec<[f64; 2]>> {
        match &self.geom {
            Geometry::Point(_) => Vec::new(),
            Geometry::Polygon(rings) => rings.clone(),
            Geometry::Cell(cell) => vec![cell.corners().to_vec()],
        }
    }

    pub fn bounds(&self) -> Bounds {
        match &self.geom {
            Geometry::Point(p) => Bounds::of([*p]),
            Geometry::Polygon(rings) => Bounds::of(rings.iter().flatten().copied()),
            Geometry::Cell(cell) => Bounds::of(cell.corners()),
        }
    }
}

/// Les objets à dessiner à un zoom, accessibles un par un : un `Vec<Feature>` convient, mais un ensemble énorme (des
/// centaines de milliers de carreaux) peut fabriquer chaque objet à la demande au lieu de tous les garder en mémoire.
pub trait FeatureSet {
    fn len(&self) -> usize;
    fn get(&self, index: usize) -> std::borrow::Cow<'_, Feature>;
    fn to_vec(&self) -> Vec<Feature> {
        (0..self.len()).map(|i| self.get(i).into_owned()).collect()
    }
}

impl FeatureSet for Vec<Feature> {
    fn len(&self) -> usize {
        <[Feature]>::len(self)
    }
    fn get(&self, index: usize) -> std::borrow::Cow<'_, Feature> {
        std::borrow::Cow::Borrowed(&self[index])
    }
}

/// Réduit les objets d'un zoom donné : reçoit les objets de la source un à un (`push`), rend ceux à dessiner (`finish`).
pub trait Generalizer {
    fn push(&mut self, feature: &Feature);
    fn finish(self: Box<Self>) -> Box<dyn FeatureSet>;
}

/// Un jeu de données mis en tuiles. Voir « Comment ajouter un jeu de données » en tête de ce module.
pub trait Dataset: Send + Sync {
    /// Identifiant court, dans les adresses et les noms de fichiers.
    fn id(&self) -> &'static str;
    /// Nom de la couche dans les tuiles.
    fn layer(&self) -> &'static str;
    /// Noms des propriétés, dans l'ordre de `Feature::props`.
    fn keys(&self) -> &'static [&'static str];
    /// Zoom minimal et maximal des tuiles.
    fn zooms(&self) -> (u8, u8);
    /// Version du *schéma* : à augmenter quand le code change ce que contiennent les tuiles (elles sont alors refaites).
    fn schema_version(&self) -> u32;
    /// Identifiant du millésime de la source (« filosofi-2019 »). L'archive n'est refaite que s'il change.
    fn source_id(&self) -> String;
    /// Crédit et licence, affichés par le site.
    fn attribution(&self) -> &'static str;
    fn license(&self) -> &'static str;

    /// Jeux dont la fabrication doit être terminée avant celle-ci (par exemple `couverture` croise ses carreaux avec la grille
    /// de `population`). Le serveur attend que leur archive du millésime courant soit sur le disque, **sans** tenir la file
    /// des fabrications (sinon, chacun attendrait l'autre).
    fn depends_on(&self) -> &'static [&'static str] {
        &[]
    }

    /// S'assure que la source est dans `dir` (la télécharge si elle manque).
    fn acquire<'a>(&'a self, http: &'a reqwest::Client, dir: &'a Path) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;
    /// Lit la source **en flux** et appelle `emit` pour chaque objet.
    fn scan(&self, dir: &Path, emit: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()>;
    /// Le généralisateur du zoom `zoom`.
    fn generalizer(&self, zoom: u8) -> Box<dyn Generalizer>;

    /// Zone (lon/lat) que l'objet peut toucher une fois généralisé : le seau qui la touche en reçoit une copie.
    fn influence(&self, feature: &Feature) -> Bounds {
        feature.bounds()
    }
    /// Point d'ancrage : son seau « possède » l'objet (compté une seule fois aux zooms bas).
    fn anchor(&self, feature: &Feature) -> [f64; 2] {
        let b = feature.bounds();
        [(b.min[0] + b.max[0]) / 2.0, (b.min[1] + b.max[1]) / 2.0]
    }
    /// Zoom du découpage en seaux (voir « La fabrication »). Les zooms inférieurs sont faits en un passage global.
    fn spool_zoom(&self) -> u8 {
        8
    }
    /// Informations pour le site (plages de valeurs des légendes…), disponibles une fois `scan` terminé.
    fn metadata(&self) -> serde_json::Value {
        serde_json::json!({})
    }
    /// À la mise en service de l'archive `version` : charger les fichiers annexes écrits par `finish`.
    fn load_extras(&self, _dir: &Path, _version: &str) -> Result<()> {
        Ok(())
    }
    /// Après la fabrication : écrire des fichiers annexes dans `out_dir` (la version est dans leur nom).
    fn finish(&self, _out_dir: &Path, _version: &str) -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Généralisateurs prêts à l'emploi
// ---------------------------------------------------------------------------------------------

/// Ne change rien : les polygones sont découpés et simplifiés à l'étape des tuiles, pour tous les jeux.
#[derive(Default)]
pub struct PassThrough {
    features: Vec<Feature>,
}

impl Generalizer for PassThrough {
    fn push(&mut self, feature: &Feature) {
        self.features.push(feature.clone());
    }
    fn finish(self: Box<Self>) -> Box<dyn FeatureSet> {
        Box::new(self.features)
    }
}

/// Transforme les sommes d'un gros carreau en propriétés d'affichage et en poids : `(sommes, côté en mètres) → (propriétés, poids)`.
pub type Finalize = Box<dyn Fn(&[f32], u32) -> (Vec<Value>, f32) + Send + Sync>;

/// Carreaux → carreaux de `size` mètres : chaque propriété numérique est **additionnée** par gros carreau.
/// Les carreaux d'entrée portent donc des *comptes* (habitants, ménages…), jamais des ratios ; `finalize` recalcule les
/// ratios à partir des sommes. Les carreaux d'origine passent aussi par `finalize` (taille inchangée) : un jeu de
/// propriétés unique à tous les zooms.
pub struct GridAggregator {
    size: u32,
    /// Gros carreau → rang ; les sommes de tous les gros carreaux sont mises bout à bout dans `sums` (`stride` valeurs
    /// chacun) : bien moins de mémoire qu'un `Vec` par carreau (on en agrège des centaines de milliers).
    index: HashMap<(Crs, i32, i32), u32>,
    sums: Vec<f32>,
    stride: usize,
    finalize: Finalize,
}

impl GridAggregator {
    pub fn new(size: u32, finalize: Finalize) -> Self {
        GridAggregator { size, index: HashMap::new(), sums: Vec::new(), stride: 0, finalize }
    }
}

impl Generalizer for GridAggregator {
    fn push(&mut self, feature: &Feature) {
        let Geometry::Cell(cell) = &feature.geom else { return };
        if self.stride == 0 {
            self.stride = feature.props.len();
        }
        let size = self.size as i32;
        let key = (cell.crs, cell.e.div_euclid(size), cell.n.div_euclid(size));
        let next = self.index.len() as u32;
        let rank = *self.index.entry(key).or_insert(next) as usize;
        if (rank + 1) * self.stride > self.sums.len() {
            self.sums.resize((rank + 1) * self.stride, 0.0);
        }
        let sums = &mut self.sums[rank * self.stride..(rank + 1) * self.stride];
        for (sum, value) in sums.iter_mut().zip(&feature.props) {
            *sum += match value {
                Value::Int(i) => *i as f32,
                Value::Float(f) => *f,
                _ => 0.0,
            };
        }
    }

    fn finish(self: Box<Self>) -> Box<dyn FeatureSet> {
        let mut keys: Vec<((Crs, i32, i32), u32)> = self.index.into_iter().collect();
        keys.sort_by_key(|&((crs, e, n), _)| (crs.index(), e, n)); // ordre stable : des archives identiques d'un jour à l'autre
        Box::new(GridSet { keys, sums: self.sums, stride: self.stride, size: self.size, finalize: self.finalize })
    }
}

/// Les gros carreaux d'un `GridAggregator`, fabriqués à la demande à partir de leurs sommes (16 octets de clé et 4 de rang
/// par carreau, au lieu d'un objet complet).
struct GridSet {
    keys: Vec<((Crs, i32, i32), u32)>,
    sums: Vec<f32>,
    stride: usize,
    size: u32,
    finalize: Finalize,
}

impl FeatureSet for GridSet {
    fn len(&self) -> usize {
        self.keys.len()
    }
    fn get(&self, index: usize) -> std::borrow::Cow<'_, Feature> {
        let (key, rank) = self.keys[index];
        let rank = rank as usize;
        let (props, weight) = (self.finalize)(&self.sums[rank * self.stride..(rank + 1) * self.stride], self.size);
        let cell = Cell { crs: key.0, e: key.1 * self.size as i32, n: key.2 * self.size as i32, size: self.size };
        std::borrow::Cow::Owned(Feature { geom: Geometry::Cell(cell), props, weight })
    }
}

/// Points → grappes : sur une grille de `cell_units` unités de tuile (4096 = une tuile), les points d'une même case se
/// fondent en un seul, placé à leur barycentre. Propriétés de sortie : la **somme** de chaque propriété numérique d'entrée,
/// puis le nombre de points (`Int`) en dernière position (la dernière clé du jeu doit donc être le décompte).
/// Aux zooms à partir de `exact_from`, les points sont gardés tels quels (décompte 1).
pub struct PointCluster {
    zoom: u8,
    cell_units: f64,
    exact: bool,
    clusters: HashMap<(i64, i64), (f64, f64, Vec<f32>, i64)>,
    singles: Vec<Feature>,
}

impl PointCluster {
    pub fn new(zoom: u8, cell_units: f64, exact_from: u8) -> Self {
        PointCluster { zoom, cell_units, exact: zoom >= exact_from, clusters: HashMap::new(), singles: Vec::new() }
    }
}

fn numeric(value: &Value) -> f32 {
    match value {
        Value::Int(i) => *i as f32,
        Value::Float(f) => *f,
        _ => 0.0,
    }
}

impl Generalizer for PointCluster {
    fn push(&mut self, feature: &Feature) {
        let Geometry::Point(p) = feature.geom else { return };
        if self.exact {
            let mut props: Vec<Value> = feature.props.clone();
            props.push(Value::Int(1));
            self.singles.push(Feature { geom: Geometry::Point(p), props, weight: feature.weight });
            return;
        }
        let w = geom::world(p[0], p[1], self.zoom);
        let key = ((w[0] / self.cell_units).floor() as i64, (w[1] / self.cell_units).floor() as i64);
        let entry = self.clusters.entry(key).or_insert_with(|| (0.0, 0.0, vec![0.0; feature.props.len()], 0));
        entry.0 += p[0];
        entry.1 += p[1];
        for (sum, value) in entry.2.iter_mut().zip(&feature.props) {
            *sum += numeric(value);
        }
        entry.3 += 1;
    }

    fn finish(self: Box<Self>) -> Box<dyn FeatureSet> {
        let mut out = self.singles;
        let mut keys: Vec<_> = self.clusters.keys().copied().collect();
        keys.sort_unstable();
        for key in keys {
            let (lon, lat, sums, count) = &self.clusters[&key];
            let n = *count as f64;
            let mut props: Vec<Value> = sums.iter().map(|s| Value::Float(*s)).collect();
            props.push(Value::Int(*count));
            out.push(Feature { geom: Geometry::Point([lon / n, lat / n]), props, weight: *count as f32 });
        }
        Box::new(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell_feature(e: i32, n: i32, pop: f32, men: f32) -> Feature {
        Feature {
            geom: Geometry::Cell(Cell { crs: Crs::Laea, e, n, size: 200 }),
            props: vec![Value::Float(pop), Value::Float(men)],
            weight: pop,
        }
    }

    #[test]
    fn la_grille_additionne_les_comptes_et_recalcule_les_ratios() {
        // Deux carreaux de 200 m dans le même carreau de 1 km, et un autre ailleurs.
        let finalize: Finalize = Box::new(|sums, _| {
            let (pop, men) = (sums[0], sums[1]);
            (vec![Value::Float(pop), Value::Float(pop / men)], pop)
        });
        let mut aggregator: Box<dyn Generalizer> = Box::new(GridAggregator::new(1000, finalize));
        aggregator.push(&cell_feature(3_210_000, 2_029_000, 100.0, 50.0)); // 2 habitants par ménage
        aggregator.push(&cell_feature(3_210_200, 2_029_200, 300.0, 50.0)); // 6 habitants par ménage
        aggregator.push(&cell_feature(3_212_000, 2_029_000, 10.0, 10.0));
        let out = aggregator.finish().to_vec();
        assert_eq!(out.len(), 2);
        let first = &out[0];
        let Geometry::Cell(cell) = &first.geom else { panic!() };
        assert_eq!((cell.e, cell.n, cell.size), (3_210_000, 2_029_000, 1000));
        // 400 habitants pour 100 ménages : 4. La moyenne des moyennes ferait (2 + 6) / 2 = 4 ici par hasard ;
        // l'autre test ci-dessous distingue vraiment les deux.
        assert_eq!(first.props, vec![Value::Float(400.0), Value::Float(4.0)]);
        assert_eq!(first.weight, 400.0);
    }

    #[test]
    fn jamais_de_moyenne_de_moyennes() {
        let finalize: Finalize = Box::new(|sums, _| (vec![Value::Float(sums[0] / sums[1])], sums[0]));
        let mut aggregator: Box<dyn Generalizer> = Box::new(GridAggregator::new(400, finalize));
        // Un carreau de 1 habitant à 1 ménage de... et un de 99 habitants pour 33 ménages : 3 hab./ménage au total.
        aggregator.push(&cell_feature(0, 0, 1.0, 1.0)); // ratio 1
        aggregator.push(&cell_feature(200, 0, 99.0, 33.0)); // ratio 3
        let out = aggregator.finish().to_vec();
        // 100 / 34 = 2,94, et non (1 + 3) / 2 = 2.
        let Value::Float(ratio) = out[0].props[0] else { panic!() };
        assert!((ratio - 100.0 / 34.0).abs() < 1e-5);
    }

    #[test]
    fn les_points_proches_se_fondent_en_grappes() {
        let point = |lon: f64, lat: f64, v: f32| Feature { geom: Geometry::Point([lon, lat]), props: vec![Value::Float(v)], weight: 1.0 };
        let mut at_z5 = PointCluster::new(5, 200.0, 12);
        // Trois points à quelques mètres l'un de l'autre, un à 100 km.
        for f in [point(2.0, 48.0, 10.0), point(2.0001, 48.0001, 20.0), point(2.0002, 48.0, 30.0), point(3.5, 48.8, 5.0)] {
            at_z5.push(&f);
        }
        let out = Box::new(at_z5).finish().to_vec();
        assert_eq!(out.len(), 2);
        let big = out.iter().find(|f| f.props[1] == Value::Int(3)).expect("une grappe de 3");
        assert_eq!(big.props[0], Value::Float(60.0));
        let Geometry::Point(p) = big.geom else { panic!() };
        assert!((p[0] - 2.0001).abs() < 1e-4);
        // Au zoom d'affichage exact, rien n'est fondu.
        let mut exact = PointCluster::new(12, 200.0, 12);
        exact.push(&point(2.0, 48.0, 10.0));
        exact.push(&point(2.0001, 48.0001, 20.0));
        assert_eq!(Box::new(exact).finish().len(), 2);
    }

    #[test]
    fn les_coins_d_un_carreau_sont_un_carre_a_200_m() {
        let cell = Cell { crs: Crs::Laea, e: 3_760_000, n: 2_890_000, size: 200 };
        let c = cell.corners();
        // Distance entre coins voisins : 200 m, à un mètre près.
        let dist = |a: [f64; 2], b: [f64; 2]| {
            let dx = (a[0] - b[0]) * a[1].to_radians().cos() * 111_320.0;
            let dy = (a[1] - b[1]) * 110_950.0;
            dx.hypot(dy)
        };
        for i in 0..4 {
            let d = dist(c[i], c[(i + 1) % 4]);
            assert!((d - 200.0).abs() < 3.0, "{d}");
        }
        assert_eq!(cell.block(8000).e, 3_760_000);
        assert_eq!(Cell { e: -100, ..cell }.block(8000).e, -8000);
    }
}
