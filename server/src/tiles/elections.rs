//! Jeu de données « élections » : les résultats des scrutins nationaux récents **par bureau de vote**, en polygones.
//!
//! C'est le premier jeu de *polygones* du moteur (le premier, `population`, est une grille). Il montre trois choses :
//! la jointure de deux sources par un identifiant, la généralisation par **niveaux administratifs**, et la somme
//! (jamais la moyenne) des comptes d'un niveau au suivant.
//!
//! # Un jeu de données par scrutin
//!
//! Cinq scrutins, donc cinq jeux (`elec-p22t1`, `elec-p22t2`, `elec-eu24`, `elec-l24t1`, `elec-l24t2`), chacun son archive.
//! Une archive unique aurait réuni les cinq scrutins dans chaque objet (~80 propriétés) : une tuile de communes au zoom 7 en aurait
//! porté trois fois trop, au-dessus du plafond de 500 Ko. Cinq archives, ce sont cinq fois la forme des bureaux (qui pèse peu devant
//! les propriétés) mais des tuiles légères, et le site ne charge que le scrutin qu'on regarde. Les cinq archives se fabriquent
//! l'une après l'autre (une fabrication à la fois), chacune ne lit que son fichier de résultats.
//!
//! # Les sources
//!
//! - **Résultats** : ministère de l'Intérieur, data.gouv.fr, « résultats définitifs par bureau de vote » (`serve::datasets`
//!   en donne la liste, `SCRUTINS` les adresses). Un fichier CSV par scrutin, ~70 000 lignes (les présidentielles sont en Latin-1).
//! - **Formes** : voir `elections_geo.rs` (Etalab pour les bureaux, IGN pour les communes et les départements).
//!
//! # La jointure
//!
//! Les contours d'Etalab portent `codeBureauVote` = `<code INSEE de la commune>_<numéro du bureau sur 4 chiffres>` (`01001_0001`). Les
//! fichiers du ministère donnent le département, la commune et le bureau dans des colonnes séparées, mais pas toujours dans la même
//! forme (3 chiffres pour la commune en 2022, `1001` sans zéro initial aux législatives du 1er tour, des lettres `ZA`… pour l'outre-mer
//! en 2022). `commune_code` les ramène à la forme INSEE à 5 caractères. Paris, Lyon et Marseille restent sous leur code de commune
//! (`75056`) avec un bureau `0101` = arrondissement 01, bureau 01, comme dans les contours.
//!
//! Résultat de la jointure (mesures de la fabrication complète, voir `metadata`) : ~95-97 % des bureaux et 93-97 % des inscrits
//! trouvent leur contour ; il manque les Français établis hors de France (sans forme), la Nouvelle-Calédonie et la Polynésie, et les
//! bureaux créés ou fusionnés depuis la date des contours (juin 2022).
//!
//! # Généralisation : des niveaux administratifs, pas une dissolution
//!
//! Fondre 70 000 polygones en des polygones plus grossiers à chaque zoom serait long et inutile : l'administration nous donne déjà
//! les regroupements. Chaque niveau est un objet à part, avec **ses propres totaux**, sommes des bureaux :
//!
//! | zooms  | niveau (`niv`) | objets   | pourquoi                                                              |
//! |--------|----------------|----------|-----------------------------------------------------------------------|
//! | 4 à 6  | 0 département  | ~100     | à l'échelle de la France, une commune fait moins de deux pixels       |
//! | 7 à 9  | 1 commune      | ~35 000  | une commune de 15 km² fait ~10 px au zoom 7 ; le détail des bureaux serait du bruit |
//! | 10 à 12| 2 bureau       | ~68 000  | un bureau urbain (~0,3 km) fait ~6 px au zoom 10 et ~25 px au zoom 12 |
//!
//! Les propriétés du département et de la commune sont les **sommes** des bureaux (inscrits, votants, exprimés, voix de chaque
//! candidat ou liste) : on ne moyenne jamais des pourcentages, le site les recalcule à partir des sommes. Les sommes viennent
//! du fichier des résultats (tous les bureaux, y compris ceux sans contour), pas des seules formes : un département compte tous
//! ses électeurs.
//!
//! Le zoom qui change de niveau est, pour le moteur, un simple filtre : `generalizer(zoom)` ne garde que les objets du niveau de ce zoom
//! (`LevelFilter`), et simplifie leur forme dès l'entrée aux zooms bas (35 000 communes en pleine résolution ne tiendraient pas dans le
//! budget de mémoire de la fabrication ; simplifiées à l'échelle du zoom, ~15 sommets chacune, elles pèsent une vingtaine de Mo).
//!
//! **Communes de repli.** Quand un bureau de la commune n'a pas de contour (sa part des électeurs existe dans les résultats), la
//! zone serait trouée aux zooms de bureaux. Ces communes-là sont aussi émises au niveau 3 (« commune de repli ») : leur forme, avec les
//! totaux de la commune, est dessinée *sous* les bureaux (elle passe en premier dans la tuile) et ne se voit que là où des bureaux manquent.
//!
//! # Ce que contient une tuile
//!
//! Couche `elections`, propriétés : `niv`, `code` (`75056_0101`, `75056`, `75`), `nom`, puis `i` (inscrits), `v` (votants), `x` (exprimés), `t`
//! (la tête : rang + 1 de la colonne la mieux placée, 0 s'il n'y a pas de résultat) et `c0`, `c1`… les **voix** de chaque colonne.
//! Les colonnes sont les candidats (présidentielle), les nuances politiques du ministère (législatives) ou les listes (européennes) ;
//! l'ensemble des colonnes mineures est regroupé dans une dernière colonne « autres » : 38 listes aux européennes, dont 12 au-dessus
//! de 1 % des exprimés au niveau national. Un pourcentage (part des exprimés, participation) se calcule dans le navigateur.
//! `weight` d'un objet = ses inscrits : si une tuile dépasse le plafond, les plus petits bureaux partent d'abord.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use flate2::read::GzDecoder;
use serde_json::json;
use tracing::{info, warn};

use super::elections_geo::{self as geo, Shape};
use super::geom::simplify_ring;
use super::{Dataset, Feature, FeatureSet, Generalizer, Geometry, Value};

/// Premier et dernier zoom des tuiles.
const MIN_ZOOM: u8 = 4;
const MAX_ZOOM: u8 = 12;
/// Zooms où chaque niveau est dessiné : départements jusqu'au 6, communes de 7 à 9, bureaux à partir du 10.
const DEPARTMENT_MAX_ZOOM: u8 = 6;
const COMMUNE_MAX_ZOOM: u8 = 9;

/// Niveaux, tels que le site les lit dans `niv`.
const LEVEL_DEPARTMENT: i64 = 0;
const LEVEL_COMMUNE: i64 = 1;
const LEVEL_BUREAU: i64 = 2;
/// Commune dont certains bureaux n'ont pas de contour : dessinée sous les bureaux.
const LEVEL_FALLBACK: i64 = 3;

/// Nombre de propriétés avant les voix : `niv`, `code`, `nom`, `i`, `v`, `x`, `t`.
const FIXED_PROPS: usize = 7;

const DATA_GOUV: &str = "https://static.data.gouv.fr/resources";

/// Comment lire le fichier d'un scrutin : les colonnes de candidats n'ont pas la même forme d'un scrutin à l'autre.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    /// Présidentielle 2022 : fichier Latin-1, candidats nommés (`Nom`), pas de nuance.
    Presidentielle,
    /// Législatives 2024 : un candidat par ligne de bureau, avec sa nuance ; on additionne les candidats d'une même nuance.
    Legislatives,
    /// Européennes 2024 : listes, reconnues par leur numéro de panneau.
    Europeennes,
}

/// Un scrutin : où trouver ses résultats et quelles colonnes en garder.
struct Scrutin {
    /// Identifiant du jeu de tuiles.
    id: &'static str,
    label: &'static str,
    /// Nom du fichier de résultats compressé dans le dossier des sources.
    file: &'static str,
    url: &'static str,
    kind: Kind,
    /// Clés qui reconnaissent chaque colonne (nom, nuance ou numéro de panneau, selon `kind`), dans l'ordre des propriétés `c0`, `c1`…
    columns: &'static [&'static str],
    /// Les candidats ou listes qui ne sont pas dans `columns` s'additionnent dans une dernière colonne « autres ».
    others: bool,
}

impl Scrutin {
    fn column_count(&self) -> usize {
        self.columns.len() + usize::from(self.others)
    }
    /// Valeurs par bureau : inscrits, votants, exprimés, puis une voix par colonne.
    fn row_width(&self) -> usize {
        3 + self.column_count()
    }
}

/// Les 12 candidats de la présidentielle 2022, dans l'ordre des panneaux.
const PRESIDENTIELLE_T1: &[&str] =
    &["ARTHAUD", "ROUSSEL", "MACRON", "LASSALLE", "LE PEN", "ZEMMOUR", "MÉLENCHON", "HIDALGO", "JADOT", "PÉCRESSE", "POUTOU", "DUPONT-AIGNAN"];
/// Nuances du ministère aux législatives 2024 (celles qui pèsent plus de 0,7 % des exprimés au 1er tour), de la gauche vers la droite.
const LEGISLATIVES: &[&str] = &["EXG", "UG", "DVG", "ENS", "HOR", "DVC", "LR", "DVD", "UXD", "RN", "REC", "REG"];
/// Numéros de panneau des 12 listes qui ont dépassé 1 % des exprimés aux européennes 2024 (les 26 autres vont dans « autres »).
const EUROPEENNES: &[&str] = &["5", "11", "27", "4", "18", "6", "3", "33", "29", "8", "35", "15"];

const SCRUTINS: &[Scrutin] = &[
    Scrutin {
        id: "elec-p22t1",
        label: "Présidentielle 2022, 1er tour",
        file: "p22t1.csv.gz",
        url: "election-presidentielle-des-10-et-24-avril-2022-resultats-definitifs-du-1er-tour/20220414-152542/resultats-par-niveau-burvot-t1-france-entiere.txt",
        kind: Kind::Presidentielle,
        columns: PRESIDENTIELLE_T1,
        others: false,
    },
    Scrutin {
        id: "elec-p22t2",
        label: "Présidentielle 2022, 2nd tour",
        file: "p22t2.csv.gz",
        url: "election-presidentielle-des-10-et-24-avril-2022-resultats-definitifs-du-2nd-tour/20220428-142237/resultats-par-niveau-burvot-t2-france-entiere.txt",
        kind: Kind::Presidentielle,
        columns: &["MACRON", "LE PEN"],
        others: false,
    },
    Scrutin {
        id: "elec-eu24",
        label: "Européennes 2024",
        file: "eu24.csv.gz",
        url: "resultats-des-elections-europeennes-du-9-juin-2024/20240613-154804/resultats-definitifs-par-bureau-de-vote.csv",
        kind: Kind::Europeennes,
        columns: EUROPEENNES,
        others: true,
    },
    Scrutin {
        id: "elec-l24t1",
        label: "Législatives 2024, 1er tour",
        file: "l24t1.csv.gz",
        url: "elections-legislatives-des-30-juin-et-7-juillet-2024-resultats-definitifs-du-1er-tour/20240710-171445/resultats-definitifs-par-bureau-de-vote.csv",
        kind: Kind::Legislatives,
        columns: LEGISLATIVES,
        others: true,
    },
    Scrutin {
        id: "elec-l24t2",
        label: "Législatives 2024, 2nd tour",
        file: "l24t2.csv.gz",
        url: "elections-legislatives-des-30-juin-et-7-juillet-2024-resultats-definitifs-du-2nd-tour/20240710-170658/resultats-definitifs-par-bureau-de-vote.csv",
        kind: Kind::Legislatives,
        columns: LEGISLATIVES,
        others: true,
    },
];

/// Les jeux de données « élections » (un par scrutin), à enregistrer dans `serve::datasets`.
pub fn datasets() -> Vec<Arc<dyn Dataset>> {
    SCRUTINS.iter().map(|scrutin| Arc::new(Elections::new(scrutin)) as Arc<dyn Dataset>).collect()
}

/// Dossier des sources communes aux cinq jeux (les formes pèsent ~100 Mo : on ne les range pas cinq fois) : à côté du dossier du jeu.
fn shared_dir(dir: &Path) -> PathBuf {
    dir.parent().unwrap_or(dir).join("elections-sources")
}

pub struct Elections {
    scrutin: &'static Scrutin,
    keys: &'static [&'static str],
    /// Fiche pour le site, remplie par `scan` (lue par `metadata`).
    sheet: Mutex<serde_json::Value>,
}

impl Elections {
    fn new(scrutin: &'static Scrutin) -> Elections {
        // `Dataset::keys` rend des `&'static str` : on les fabrique une fois (quelques dizaines d'octets par jeu) et on les garde.
        let mut keys: Vec<&'static str> = vec!["niv", "code", "nom", "i", "v", "x", "t"];
        keys.extend((0..scrutin.column_count()).map(|i| &*Box::leak(format!("c{i}").into_boxed_str())));
        Elections { scrutin, keys: Box::leak(keys.into_boxed_slice()), sheet: Mutex::new(json!({})) }
    }
}

// ---------------------------------------------------------------------------------------------
// Lecture des résultats
// ---------------------------------------------------------------------------------------------

/// Latin-1 → UTF-8 au fil de la lecture (les fichiers de la présidentielle 2022 ne sont pas en UTF-8).
struct Latin1<R: Read> {
    inner: R,
    pending: Vec<u8>,
    position: usize,
}

impl<R: Read> Read for Latin1<R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.position >= self.pending.len() {
            let mut raw = [0u8; 8192];
            let n = self.inner.read(&mut raw)?;
            if n == 0 {
                return Ok(0);
            }
            // Chaque octet Latin-1 est le point de code Unicode de même valeur.
            self.pending = raw[..n].iter().map(|&b| char::from(b)).collect::<String>().into_bytes();
            self.position = 0;
        }
        let n = out.len().min(self.pending.len() - self.position);
        out[..n].copy_from_slice(&self.pending[self.position..self.position + n]);
        self.position += n;
        Ok(n)
    }
}

/// Code INSEE à 5 caractères d'une commune, d'après les colonnes « département » et « commune » du fichier. `None` : hors de France
/// (les Français établis hors de France votent dans des bureaux sans commune ni contour).
fn commune_code(department: &str, commune: &str) -> Option<String> {
    let (department, commune) = (department.trim(), commune.trim());
    if department.is_empty() || commune.is_empty() || department == "ZZ" {
        return None;
    }
    if commune.len() == 5 {
        return Some(commune.to_string()); // européennes, législatives du 2nd tour : déjà la forme INSEE
    }
    if department.starts_with('Z') {
        // Présidentielle 2022, outre-mer : `ZA` = Guadeloupe (971)…, et la commune sur 3 chiffres (`101` pour `97101`).
        let prefix = if matches!(department, "ZN" | "ZP" | "ZW") { "98" } else { "97" };
        return Some(format!("{prefix}{commune:0>3}"));
    }
    if commune.len() == 3 && department.len() <= 2 {
        return Some(format!("{department:0>2}{commune}")); // présidentielle 2022 : `01` + `053`
    }
    Some(format!("{commune:0>5}")) // législatives du 1er tour : `1001` pour `01001`
}

/// Code de département INSEE d'une commune : 2 caractères en métropole (`2A` comprise), 3 en outre-mer (`971`).
fn department_of(commune: &str) -> &str {
    if commune.starts_with("97") || commune.starts_with("98") { &commune[..3] } else { &commune[..2] }
}

/// Les résultats d'un scrutin, aux trois niveaux. Chaque valeur est un `Vec<u32>` : inscrits, votants, exprimés, voix par colonne.
#[derive(Default)]
struct Results {
    /// Par `commune_bureau` (`01001_0001`).
    bureaux: HashMap<String, Vec<u32>>,
    communes: HashMap<String, Vec<u32>>,
    departements: HashMap<String, Vec<u32>>,
    /// Inscrits des bureaux sans commune (Français établis hors de France…).
    abroad_voters: u64,
    /// Voix de candidats qu'aucune colonne ne reconnaît (à zéro quand la définition des colonnes est complète).
    unrecognised_votes: u64,
}

fn add_into(target: &mut Vec<u32>, row: &[u32]) {
    if target.is_empty() {
        target.resize(row.len(), 0);
    }
    for (sum, value) in target.iter_mut().zip(row) {
        *sum += value;
    }
}

impl Elections {
    fn read_results(&self, dir: &Path) -> Result<Results> {
        let scrutin = self.scrutin;
        let path = dir.join(scrutin.file);
        let file = File::open(&path).with_context(|| format!("{} absent", path.display()))?;
        let gz: Box<dyn Read> = Box::new(GzDecoder::new(file));
        let reader: Box<dyn Read> = if scrutin.kind == Kind::Presidentielle { Box::new(Latin1 { inner: gz, pending: Vec::new(), position: 0 }) } else { gz };
        let mut csv = csv::ReaderBuilder::new().delimiter(b';').flexible(true).from_reader(reader);
        let headers: Vec<String> = csv.headers()?.iter().map(|h| h.trim().trim_start_matches('\u{feff}').to_string()).collect();
        let find = |names: &[&str]| -> Result<usize> {
            names
                .iter()
                .find_map(|name| headers.iter().position(|h| h == name))
                .with_context(|| format!("colonne {names:?} absente de {}", scrutin.file))
        };
        let (c_dept, c_com, c_bv) = (find(&["Code du département", "Code département"])?, find(&["Code de la commune", "Code commune"])?, find(&["Code du b.vote", "Code BV"])?);
        let (c_ins, c_vot, c_exp) = (find(&["Inscrits"])?, find(&["Votants"])?, find(&["Exprimés"])?);
        // Les colonnes de candidats se répètent, par blocs de même forme : on repère le premier bloc et le pas.
        let (base, stride, c_key, c_votes) = match scrutin.kind {
            Kind::Presidentielle => {
                let base = find(&["N°Panneau"])?;
                (base, 7, base + 2, base + 4)
            }
            Kind::Legislatives | Kind::Europeennes => {
                let base = find(&["Numéro de panneau 1"])?;
                let stride = find(&["Numéro de panneau 2"])? - base;
                let key = if scrutin.kind == Kind::Legislatives { base + 1 } else { base };
                (base, stride, key, find(&["Voix 1"])?)
            }
        };
        let votes_offset = c_votes - base;
        let key_offset = c_key - base;

        let width = scrutin.row_width();
        let mut results = Results::default();
        let mut record = csv::StringRecord::new();
        while csv.read_record(&mut record)? {
            let number = |i: usize| record.get(i).and_then(|v| v.trim().parse::<u32>().ok());
            let (Some(inscrits), Some(votants), Some(exprimes)) = (number(c_ins), number(c_vot), number(c_exp)) else { continue };
            let mut row = vec![0u32; width];
            row[0] = inscrits;
            row[1] = votants;
            row[2] = exprimes;
            let mut start = base;
            while start + votes_offset < record.len() {
                let key = record.get(start + key_offset).unwrap_or("").trim();
                if key.is_empty() {
                    break;
                }
                let votes = number(start + votes_offset).unwrap_or(0);
                match scrutin.columns.iter().position(|c| *c == key) {
                    Some(column) => row[3 + column] += votes,
                    None if scrutin.others => row[width - 1] += votes,
                    None => results.unrecognised_votes += u64::from(votes),
                }
                start += stride;
            }
            let Some(commune) = commune_code(record.get(c_dept).unwrap_or(""), record.get(c_com).unwrap_or("")) else {
                results.abroad_voters += u64::from(inscrits);
                continue;
            };
            let bureau = record.get(c_bv).unwrap_or("").trim();
            // Un bureau coupé entre deux circonscriptions (législatives) a deux lignes : on les additionne.
            add_into(results.bureaux.entry(format!("{commune}_{bureau:0>4}")).or_default(), &row);
            add_into(results.departements.entry(department_of(&commune).to_string()).or_default(), &row);
            add_into(results.communes.entry(commune).or_default(), &row);
        }
        if results.bureaux.len() < 1000 {
            bail!("{} : seulement {} bureaux lus, le fichier est incomplet", scrutin.file, results.bureaux.len());
        }
        Ok(results)
    }
}

// ---------------------------------------------------------------------------------------------
// Statistiques pour la fiche du site
// ---------------------------------------------------------------------------------------------

/// Quantiles pondérés : pour chaque rang de `percentiles` (0-100), la plus petite valeur dont le poids cumulé atteint ce rang.
fn weighted_quantiles(mut samples: Vec<(f32, f32)>, percentiles: &[f64]) -> Vec<f64> {
    samples.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: f64 = samples.iter().map(|s| f64::from(s.1)).sum();
    let mut out = Vec::with_capacity(percentiles.len());
    let (mut cumulative, mut index) = (0.0, 0);
    for p in percentiles {
        let target = total * p / 100.0;
        while index < samples.len() - 1 && cumulative + f64::from(samples[index].1) < target {
            cumulative += f64::from(samples[index].1);
            index += 1;
        }
        out.push(f64::from(samples[index].0));
    }
    out
}

/// Arrondi à un chiffre après la virgule.
fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

// ---------------------------------------------------------------------------------------------
// Le jeu de données
// ---------------------------------------------------------------------------------------------

/// Niveau(x) dessiné(s) à un zoom.
fn levels_at(zoom: u8) -> &'static [i64] {
    match zoom {
        ..=DEPARTMENT_MAX_ZOOM => &[LEVEL_DEPARTMENT],
        ..=COMMUNE_MAX_ZOOM => &[LEVEL_COMMUNE],
        // Les communes de repli d'abord : elles passent en premier dans la tuile, donc dessous.
        _ => &[LEVEL_FALLBACK, LEVEL_BUREAU],
    }
}

/// Ne garde que les objets du niveau du zoom, et simplifie leur forme aux zooms bas (voir l'en-tête du module).
struct LevelFilter {
    levels: &'static [i64],
    /// Tolérance de simplification en degrés (0 : aucune) ; l'étape des tuiles simplifie ensuite à sa propre mesure.
    tolerance: f64,
    features: Vec<Feature>,
}

impl LevelFilter {
    fn new(zoom: u8) -> LevelFilter {
        // Une demi-unité de tuile (4096 par tuile) : invisible, mais ~10 fois moins de sommets qu'à la source aux zooms bas.
        let tolerance = if zoom < 8 { 0.5 * 360.0 / (f64::from(1u32 << zoom) * 4096.0) } else { 0.0 };
        LevelFilter { levels: levels_at(zoom), tolerance, features: Vec::new() }
    }
}

impl Generalizer for LevelFilter {
    fn push(&mut self, feature: &Feature) {
        let Some(Value::Int(level)) = feature.props.first() else { return };
        if !self.levels.contains(level) {
            return;
        }
        let geom = match &feature.geom {
            Geometry::Polygon(rings) if self.tolerance > 0.0 => {
                Geometry::Polygon(rings.iter().map(|ring| simplify_ring(ring, self.tolerance)).collect())
            }
            other => other.clone(),
        };
        self.features.push(Feature { geom, props: feature.props.clone(), weight: feature.weight });
    }
    fn finish(self: Box<Self>) -> Box<dyn FeatureSet> {
        Box::new(self.features)
    }
}

/// « 1er », « 2e »… pour les arrondissements de Paris, Lyon et Marseille.
fn ordinal(n: u32) -> String {
    if n == 1 { "1er".into() } else { format!("{n}e") }
}

impl Elections {
    /// Les propriétés d'un objet : niveau, code, nom, puis les valeurs de `row` (aucune donnée : des zéros, `i` = 0 dit « pas de résultat »).
    fn props(&self, level: i64, code: &str, name: &str, row: Option<&Vec<u32>>) -> (Vec<Value>, f32) {
        let width = self.scrutin.row_width();
        let zeros;
        let row = match row {
            Some(row) => row,
            None => {
                zeros = vec![0u32; width];
                &zeros
            }
        };
        // La tête : la colonne nommée qui a le plus de voix (« autres » ne compte pas : c'est un regroupement), 0 s'il n'y a pas de voix.
        let named = &row[3..3 + self.scrutin.columns.len()];
        let leader = named.iter().enumerate().max_by_key(|(_, v)| **v).filter(|(_, v)| **v > 0).map_or(0, |(i, _)| i + 1);
        let mut props = Vec::with_capacity(FIXED_PROPS + self.scrutin.column_count());
        props.push(Value::Int(level));
        props.push(Value::Str(code.into()));
        props.push(Value::Str(name.into()));
        props.extend(row[..3].iter().map(|v| Value::Int(i64::from(*v))));
        props.push(Value::Int(leader as i64));
        props.extend(row[3..].iter().map(|v| Value::Int(i64::from(*v))));
        (props, row[0] as f32)
    }

    /// Émet une ligne par partie du polygone (le moteur n'accepte qu'un anneau extérieur par objet).
    fn emit_shape(&self, emit: &mut dyn FnMut(Feature) -> Result<()>, level: i64, shape: Shape, name: &str, row: Option<&Vec<u32>>) -> Result<()> {
        let (props, weight) = self.props(level, &shape.c, name, row);
        for part in shape.p {
            emit(Feature { geom: Geometry::Polygon(part), props: props.clone(), weight })?;
        }
        Ok(())
    }
}

/// Nom d'un bureau : celui de la commune ; à Paris, Lyon et Marseille, celui de l'arrondissement (le bureau `0101` est le bureau 01 du 1er).
fn bureau_name(code: &str, commune_name: &str) -> String {
    let arrondissement = match code.split_once('_') {
        Some(("75056" | "13055" | "69123", bureau)) if bureau.len() == 4 => bureau[..2].parse::<u32>().ok(),
        _ => None,
    };
    match arrondissement {
        Some(n) => format!("{commune_name} {} arrondissement", ordinal(n)),
        None => commune_name.to_string(),
    }
}

impl Dataset for Elections {
    fn id(&self) -> &'static str {
        self.scrutin.id
    }
    fn layer(&self) -> &'static str {
        "elections"
    }
    fn keys(&self) -> &'static [&'static str] {
        self.keys
    }
    fn zooms(&self) -> (u8, u8) {
        (MIN_ZOOM, MAX_ZOOM)
    }
    fn schema_version(&self) -> u32 {
        1
    }
    fn source_id(&self) -> String {
        // Résultats définitifs de scrutins passés : la source ne bouge plus. Les contours d'Etalab, eux, sont refaits de temps en temps :
        // on ne refabrique pas pour autant (voir le README : effacer `elections-sources` pour forcer).
        "resultats-definitifs-2022-2024;contours-etalab-v2;ign-cog-carto".into()
    }
    fn attribution(&self) -> &'static str {
        "Ministère de l’Intérieur ; Etalab (contours des bureaux de vote) ; IGN"
    }
    fn license(&self) -> &'static str {
        "Licence Ouverte 2.0 (Etalab). Les contours des bureaux sont une approximation à partir des adresses du répertoire électoral unique : ils n'ont pas valeur officielle."
    }

    fn acquire<'a>(&'a self, http: &'a reqwest::Client, dir: &'a Path) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let shared = shared_dir(dir);
            std::fs::create_dir_all(&shared)?;
            let target = shared.join(self.scrutin.file);
            if !target.exists() {
                info!(scrutin = self.scrutin.id, "élections : téléchargement des résultats par bureau de vote (ministère de l'Intérieur)");
                geo::download_gz(http, &format!("{DATA_GOUV}/{}", self.scrutin.url), &target).await?;
            }
            geo::acquire_shapes(http, &shared).await
        })
    }

    fn scan(&self, dir: &Path, emit: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        let scrutin = self.scrutin;
        let shared = shared_dir(dir);
        let results = self.read_results(&shared)?;

        // Jointure : quels bureaux des résultats ont un contour ? On lit les codes des contours une première fois.
        let mut with_shape: HashSet<String> = HashSet::new();
        geo::read_shapes(&shared.join(geo::BUREAUX_FILE), |shape| {
            with_shape.insert(shape.c);
            Ok(())
        })?;
        let mut voters_matched = 0u64;
        let mut voters_total = 0u64;
        let mut bureaux_total = 0u64;
        let mut bureaux_matched = 0u64;
        let mut fallback: HashSet<String> = HashSet::new();
        for (code, row) in &results.bureaux {
            if row[0] == 0 {
                continue;
            }
            bureaux_total += 1;
            voters_total += u64::from(row[0]);
            if with_shape.contains(code) {
                bureaux_matched += 1;
                voters_matched += u64::from(row[0]);
            } else {
                fallback.insert(code[..5].to_string());
            }
        }

        // Statistiques pour les légendes : sur les bureaux, pondérées (un bureau de 2 000 inscrits pèse plus qu'un de 50).
        let width = scrutin.row_width();
        let rows: Vec<&Vec<u32>> = results.bureaux.values().filter(|r| r[0] > 0).collect();
        let participation = weighted_quantiles(rows.iter().filter(|r| r[1] > 0).map(|r| (r[1] as f32 / r[0] as f32 * 100.0, r[0] as f32)).collect(), &[10.0, 25.0, 40.0, 60.0, 75.0, 90.0]);
        let shares: Vec<Vec<f64>> = (0..scrutin.column_count())
            .map(|c| weighted_quantiles(rows.iter().filter(|r| r[2] > 0).map(|r| (r[3 + c] as f32 / r[2] as f32 * 100.0, r[2] as f32)).collect(), &[15.0, 30.0, 45.0, 60.0, 75.0, 90.0]))
            .collect();
        let mut national = vec![0u64; width];
        for row in &rows {
            for (sum, value) in national.iter_mut().zip(row.iter()) {
                *sum += u64::from(*value);
            }
        }
        let mut columns: Vec<String> = scrutin.columns.iter().map(|c| (*c).to_string()).collect();
        if scrutin.others {
            columns.push("autres".into());
        }
        *self.sheet.lock().expect("fiche des élections") = json!({
            "scrutin": scrutin.id,
            "libelle": scrutin.label,
            "colonnes": columns,
            "participation": participation.iter().map(|v| round1(*v)).collect::<Vec<_>>(),
            "parts": shares.iter().map(|s| s.iter().map(|v| round1(*v)).collect::<Vec<_>>()).collect::<Vec<_>>(),
            "national": { "inscrits": national[0], "votants": national[1], "exprimes": national[2], "voix": &national[3..] },
            "niveaux": { "departement": [MIN_ZOOM, DEPARTMENT_MAX_ZOOM], "commune": [DEPARTMENT_MAX_ZOOM + 1, COMMUNE_MAX_ZOOM], "bureau": [COMMUNE_MAX_ZOOM + 1, MAX_ZOOM] },
            "appariement": {
                "bureaux": bureaux_total,
                "bureauxAvecContour": bureaux_matched,
                "inscrits": voters_total,
                "inscritsAvecContour": voters_matched,
                "inscritsHorsDeFrance": results.abroad_voters,
                "communesDeRepli": fallback.len(),
                "voixNonReconnues": results.unrecognised_votes,
            },
        });
        info!(
            scrutin = scrutin.id,
            bureaux = bureaux_total,
            avec_contour = bureaux_matched,
            taux_bureaux = format!("{:.1} %", 100.0 * bureaux_matched as f64 / bureaux_total.max(1) as f64),
            taux_inscrits = format!("{:.1} %", 100.0 * voters_matched as f64 / voters_total.max(1) as f64),
            communes_de_repli = fallback.len(),
            "élections : jointure des résultats et des contours"
        );
        if results.unrecognised_votes > 0 {
            warn!(scrutin = scrutin.id, voix = results.unrecognised_votes, "élections : des voix n'ont pas de colonne");
        }
        drop(rows);
        drop(with_shape);

        // Émission : départements, communes de repli, communes, puis bureaux (l'ordre est celui des objets dans les tuiles : le dessous d'abord).
        geo::read_shapes(&shared.join(geo::DEPARTEMENTS_FILE), |shape| {
            let Some(row) = results.departements.get(&shape.c) else { return Ok(()) };
            let name = shape.n.clone();
            self.emit_shape(emit, LEVEL_DEPARTMENT, shape, &name, Some(row))
        })?;
        let mut communes_with_results = 0u64;
        geo::read_shapes(&shared.join(geo::COMMUNES_FILE), |shape| {
            let Some(row) = results.communes.get(&shape.c) else { return Ok(()) };
            communes_with_results += 1;
            let name = shape.n.clone();
            if fallback.contains(&shape.c) {
                self.emit_shape(emit, LEVEL_FALLBACK, shape.clone(), &name, Some(row))?;
            }
            self.emit_shape(emit, LEVEL_COMMUNE, shape, &name, Some(row))
        })?;
        info!(scrutin = scrutin.id, communes = communes_with_results, sur = results.communes.len(), "élections : communes avec contour");
        geo::read_shapes(&shared.join(geo::BUREAUX_FILE), |shape| {
            let row = results.bureaux.get(&shape.c);
            let name = bureau_name(&shape.c, &shape.n);
            self.emit_shape(emit, LEVEL_BUREAU, shape, &name, row)
        })?;
        Ok(())
    }

    fn generalizer(&self, zoom: u8) -> Box<dyn Generalizer> {
        Box::new(LevelFilter::new(zoom))
    }

    fn metadata(&self) -> serde_json::Value {
        self.sheet.lock().expect("fiche des élections").clone()
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::Compression;
    use flate2::write::GzEncoder;
    use prost::Message;

    use super::super::builder::{self, Options};
    use super::super::geom;
    use super::super::mvt::tests::{PTile, PValue};
    use super::super::pmtiles::{Reader, gunzip};
    use super::*;

    #[test]
    fn les_codes_de_commune_de_chaque_fichier_se_ramenent_a_la_forme_insee() {
        assert_eq!(commune_code("01", "053").as_deref(), Some("01053")); // présidentielle : département + 3 chiffres
        assert_eq!(commune_code("2A", "004").as_deref(), Some("2A004"));
        assert_eq!(commune_code("1", "1001").as_deref(), Some("01001")); // législatives, 1er tour : zéro initial perdu
        assert_eq!(commune_code("01", "01053").as_deref(), Some("01053")); // européennes
        assert_eq!(commune_code("ZA", "101").as_deref(), Some("97101")); // outre-mer 2022
        assert_eq!(commune_code("ZP", "701").as_deref(), Some("98701"));
        assert_eq!(commune_code("ZZ", "001"), None); // Français de l'étranger
        assert_eq!(department_of("97101"), "971");
        assert_eq!(department_of("2A004"), "2A");
        assert_eq!(department_of("75056"), "75");
    }

    #[test]
    fn les_bureaux_parisiens_prennent_le_nom_de_leur_arrondissement() {
        assert_eq!(bureau_name("75056_0101", "Paris"), "Paris 1er arrondissement");
        assert_eq!(bureau_name("13055_1601", "Marseille"), "Marseille 16e arrondissement");
        assert_eq!(bureau_name("01001_0001", "L'Abergement"), "L'Abergement");
    }

    #[test]
    fn les_quantiles_sont_ponderes() {
        // Un seul bureau de 90 inscrits à 10 %, dix de 1 inscrit à 90 % : le poids est du côté du gros bureau.
        let mut samples = vec![(10.0, 90.0)];
        samples.extend((0..10).map(|_| (90.0, 1.0)));
        assert_eq!(weighted_quantiles(samples, &[10.0, 50.0, 95.0]), vec![10.0, 10.0, 90.0]);
    }

    fn gz(path: &Path, text: &[u8]) {
        let mut out = GzEncoder::new(File::create(path).unwrap(), Compression::fast());
        out.write_all(text).unwrap();
        out.finish().unwrap();
    }

    fn square(lon: f64, lat: f64, side: f64) -> Vec<Vec<[f64; 2]>> {
        vec![vec![[lon, lat], [lon + side, lat], [lon + side, lat + side], [lon, lat + side], [lon, lat]]]
    }

    fn write_shapes(path: &Path, shapes: &[Shape]) {
        let mut out = GzEncoder::new(File::create(path).unwrap(), Compression::fast());
        for shape in shapes {
            serde_json::to_writer(&mut out, shape).unwrap();
            out.write_all(b"\n").unwrap();
        }
        out.finish().unwrap();
    }

    /// Un mini-pays : 2 communes dans le département 75, dont une avec deux bureaux (l'un d'eux sans contour), et 1 bureau à l'étranger.
    #[test]
    fn fabrication_de_bout_en_bout_sur_un_mini_scrutin() {
        let root = std::env::temp_dir().join(format!("carte-vivante-test-elections-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let shared = root.join("elections-sources");
        std::fs::create_dir_all(&shared).unwrap();
        let own = root.join("elec-p22t2");

        // Résultats : entête et lignes de la présidentielle (Latin-1 : on écrit « é » en un octet).
        let header = "Code du d\u{e9}partement;Libell\u{e9} du d\u{e9}partement;Code de la circonscription;Libell\u{e9} de la circonscription;Code de la commune;Libell\u{e9} de la commune;Code du b.vote;Inscrits;Abstentions;% Abs/Ins;Votants;% Vot/Ins;Blancs;% Blancs/Ins;% Blancs/Vot;Nuls;% Nuls/Ins;% Nuls/Vot;Exprim\u{e9}s;% Exp/Ins;% Exp/Vot;N\u{b0}Panneau;Sexe;Nom;Pr\u{e9}nom;Voix;% Voix/Ins;% Voix/Exp;N\u{b0}Panneau;Sexe;Nom;Pr\u{e9}nom;Voix;% Voix/Ins;% Voix/Exp";
        let line = |dept: &str, com: &str, bv: &str, ins: u32, macron: u32, lepen: u32| {
            format!("{dept};D;01;C;{com};Commune;{bv};{ins};0;0;{v};0;0;0;0;0;0;0;{v};0;0;1;M;MACRON;E;{macron};0;0;2;F;LE PEN;M;{lepen};0;0", v = macron + lepen)
        };
        let lines = [
            header.to_string(),
            line("75", "056", "0101", 1000, 600, 300),
            line("75", "056", "0102", 800, 200, 500), // pas de contour : la commune sera « de repli »
            line("75", "101", "0001", 500, 100, 300),
            line("ZZ", "001", "0001", 9000, 1, 1),
        ];
        // 1 000 bureaux au moins : le garde-fou de la lecture refuse un fichier tronqué. On en ajoute dans un autre département.
        let mut all = lines.join("\r\n");
        for i in 0..1000 {
            all.push_str("\r\n");
            all.push_str(&line("33", "063", &format!("{:04}", i + 1), 100, 60, 30));
        }
        let latin1: Vec<u8> = all.chars().map(|c| c as u32 as u8).collect();
        gz(&shared.join("p22t2.csv.gz"), &latin1);

        let shape = |code: &str, name: &str, lon: f64, lat: f64, side: f64| Shape { c: code.into(), n: name.into(), p: vec![square(lon, lat, side)] };
        write_shapes(&shared.join(geo::DEPARTEMENTS_FILE), &[shape("75", "Paris", 2.2, 48.8, 0.2), shape("33", "Gironde", -0.6, 44.8, 0.4)]);
        write_shapes(&shared.join(geo::COMMUNES_FILE), &[shape("75056", "Paris", 2.2, 48.8, 0.1), shape("75101", "Autre", 2.3, 48.8, 0.1), shape("33063", "Bordeaux", -0.6, 44.8, 0.1)]);
        let mut bureaux = vec![shape("75056_0101", "Paris", 2.2, 48.8, 0.05), shape("75101_0001", "Autre", 2.3, 48.8, 0.05)];
        bureaux.extend((0..1000).map(|i| shape(&format!("33063_{:04}", i + 1), "Bordeaux", -0.6 + f64::from(i % 40) * 0.0005, 44.8 + f64::from(i / 40) * 0.0005, 0.0004)));
        write_shapes(&shared.join(geo::BUREAUX_FILE), &bureaux);

        let dataset = Elections::new(&SCRUTINS[1]);
        let out = root.join("elections.pmtiles");
        let report = builder::build(&dataset, &own, &root.join("travail"), &out, &Options::default()).unwrap();
        assert!(report.features > 1000);

        // La fiche : jointure, communes de repli, totaux, sans les 9 000 inscrits de l'étranger.
        let sheet = dataset.metadata();
        assert_eq!(sheet["appariement"]["bureaux"], 1003);
        assert_eq!(sheet["appariement"]["bureauxAvecContour"], 1002);
        assert_eq!(sheet["appariement"]["communesDeRepli"], 1);
        assert_eq!(sheet["appariement"]["inscritsHorsDeFrance"], 9000);
        assert_eq!(sheet["national"]["inscrits"], 1000 + 800 + 500 + 100_000);
        assert_eq!(sheet["colonnes"], json!(["MACRON", "LE PEN"]));

        let reader = Reader::open(&out).unwrap();
        let tile_at = |z: u8, lon: f64, lat: f64| {
            let w = geom::world(lon, lat, z);
            let (x, y) = ((w[0] / 4096.0) as u32, (w[1] / 4096.0) as u32);
            let gz = reader.tile(z, x, y).unwrap().unwrap_or_else(|| panic!("tuile {z}/{x}/{y} absente"));
            PTile::decode(gunzip(&gz).unwrap().as_slice()).unwrap()
        };
        // Les propriétés d'un objet, par nom.
        let props = |tile: &PTile| -> Vec<HashMap<String, PValue>> {
            let layer = &tile.layers[0];
            layer
                .features
                .iter()
                .map(|f| f.tags.chunks(2).map(|kv| (layer.keys[kv[0] as usize].clone(), layer.values[kv[1] as usize].clone())).collect())
                .collect()
        };
        let int = |v: &PValue| v.sint_value.expect("entier");

        // Zoom 5 : un seul niveau, les départements ; le 75 additionne ses trois bureaux (1 000 + 800 + 500 inscrits, 1 600 + ... voix).
        let low = props(&tile_at(5, 2.3, 48.85));
        assert!(low.iter().all(|f| int(&f["niv"]) == LEVEL_DEPARTMENT));
        let paris = low.iter().find(|f| f["code"].string_value.as_deref() == Some("75")).expect("département 75");
        assert_eq!(int(&paris["i"]), 2300);
        assert_eq!(int(&paris["c0"]) + int(&paris["c1"]), 600 + 300 + 200 + 500 + 100 + 300, "somme des voix, pas moyenne");
        assert_eq!(int(&paris["t"]), 2, "Le Pen en tête (1re colonne = 1) : 1 100 voix contre 900");

        // Zoom 8 : les communes ; la commune 75056 additionne ses deux bureaux, avec ou sans contour.
        let mid = props(&tile_at(8, 2.25, 48.85));
        assert!(mid.iter().all(|f| int(&f["niv"]) == LEVEL_COMMUNE));
        let commune = mid.iter().find(|f| f["code"].string_value.as_deref() == Some("75056")).expect("commune 75056");
        assert_eq!(int(&commune["i"]), 1800);

        // Zoom 12 : les bureaux, et la commune de repli dessous (niv 3, en premier), qui montre le bureau sans contour.
        let near = props(&tile_at(12, 2.22, 48.82));
        let levels: Vec<i64> = near.iter().map(|f| int(&f["niv"])).collect();
        assert!(levels.contains(&LEVEL_BUREAU) && levels.contains(&LEVEL_FALLBACK), "{levels:?}");
        assert!(levels.iter().position(|l| *l == LEVEL_FALLBACK) < levels.iter().position(|l| *l == LEVEL_BUREAU), "le repli est dessous");
        let bureau = near.iter().find(|f| int(&f["niv"]) == LEVEL_BUREAU).unwrap();
        assert_eq!(bureau["code"].string_value.as_deref(), Some("75056_0101"));
        assert_eq!(bureau["nom"].string_value.as_deref(), Some("Paris 1er arrondissement"));
        assert_eq!((int(&bureau["i"]), int(&bureau["v"]), int(&bureau["c0"]), int(&bureau["c1"])), (1000, 900, 600, 300));
        std::fs::remove_dir_all(&root).ok();
    }
}
