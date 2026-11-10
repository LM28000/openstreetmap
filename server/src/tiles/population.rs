//! Jeu de données « population » : les carreaux de 200 m de l'INSEE (Filosofi, revenus, pauvreté et niveau de vie).
//!
//! C'est l'exemple à suivre pour un nouveau jeu : une source en flux, des carreaux en entrée, un `GridAggregator` par zoom.
//!
//! # La source
//!
//! INSEE, « Revenus, pauvreté et niveau de vie en 2019 — Données carroyées », carreaux de 200 m
//! (<https://www.insee.fr/fr/statistiques/7655475>), licence ouverte Etalab. Un zip de 58 Mo qui contient une archive 7z,
//! qui contient trois CSV (France métropolitaine 2,29 M de carreaux, Martinique, La Réunion), 34 colonnes chacun. L'identifiant
//! d'un carreau encode sa position : `CRS3035RES200mN2029800E4252400` = repère EPSG:3035 (LAEA), côté 200 m, coin sud-ouest à
//! 2 029 800 m au nord et 4 252 400 m à l'est. On lit donc le CSV en flux, sans passer par le GeoPackage (200 Mo).
//! Les départements d'outre-mer présents (Martinique, La Réunion) sont dans leur propre repère UTM (`proj.rs`).
//!
//! # Le secret statistique
//!
//! Sous 11 ménages fiscaux, un carreau ne peut pas être publié tel quel : l'INSEE y met une valeur *imputée* (approchée, déduite
//! du carreau de 1 km qui le contient et de ses voisins), signalée par `i_est_200 = 1`. C'est le cas de ~79 % des carreaux
//! (mais d'une minorité des habitants : les carreaux imputés sont les ruraux). Les valeurs de ces carreaux sont donc
//! des ordres de grandeur, pas des mesures ; la fiche le dit, avec la part d'habitants concernée (`imp`).
//!
//! # Ce qu'on garde, et comment on généralise
//!
//! Par carreau, des **comptes** : individus (`ind`), ménages (`men`), ménages pauvres (`men_pauv`), somme des niveaux de vie des
//! individus (`ind_snv`), individus de 65 ans et plus (`ind_65_79 + ind_80p`), individus des carreaux imputés. Aux zooms bas, les carreaux
//! sont additionnés en carreaux de 400 m, 1, 2, 4, 8, 16, 32 km (`GridAggregator`), et les ratios sont recalculés
//! **à partir des sommes** à la fin : niveau de vie moyen = Σ ind_snv / Σ ind ; part de pauvres = Σ men_pauv / Σ men.
//! Jamais de moyenne de moyennes (un carreau de 3 habitants pèserait autant qu'un de 3 000).
//!
//! Propriétés d'une tuile : `pop` (habitants), `d` (densité, hab/km²), `men` (ménages), `niv` (niveau de vie moyen, €/an par
//! unité de consommation), `pauv` (% de ménages pauvres), `a65` (% de 65 ans et plus), `imp` (% d'habitants dans des carreaux imputés).

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::future::Future;
use std::pin::Pin;

use anyhow::{Context, Result, bail};
use tracing::{info, warn};

use super::geom::Bounds;
use super::popgrid::PopGrid;
use super::proj::Crs;
use super::{Cell, Dataset, Feature, Finalize, Generalizer, GridAggregator, Geometry, Value};

/// Millésime des données (affiché et dans l'identifiant de version : changer de millésime refait les tuiles).
const VINTAGE: &str = "2019";
const DEFAULT_URL: &str = "https://www.insee.fr/fr/statistiques/fichier/7655475/Filosofi2019_carreaux_200m_csv.zip";
const ZIP_NAME: &str = "carreaux_200m_csv.zip";
/// Côté des blocs alignés sur la grille qui servent de seaux : tous les carreaux d'un bloc se retrouvent dans le même seau,
/// et chaque taille de carreau agrégé (≤ 8 km aux zooms où les seaux servent) divise 8 km.
const BLOCK_M: i32 = 8000;

/// Côté des carreaux agrégés à chaque zoom (mètres) : environ 8 pixels d'écran par carreau quel que soit le zoom.
fn cell_size(zoom: u8) -> u32 {
    match zoom {
        ..=4 => 32_000,
        5 => 16_000,
        6 => 8_000,
        7 => 4_000,
        8 => 2_000,
        9 => 1_000,
        10 => 400,
        _ => 200,
    }
}

pub struct Population {
    url: String,
    samples: Mutex<Samples>,
    /// Carreaux métropolitains `(est, nord, habitants)` ramassés pendant la lecture, pour la grille des isochrones (fabrication).
    grid_cells: Mutex<Vec<(u16, u16, f32)>>,
    /// La grille chargée, pour les isochrones (service).
    grid: RwLock<Option<Arc<PopGrid>>>,
}

/// Échantillon de valeurs (valeur, habitants) pour calculer les bornes des légendes, et totaux.
#[derive(Default)]
struct Samples {
    density: Vec<(f32, f32)>,
    income: Vec<(f32, f32)>,
    poverty: Vec<(f32, f32)>,
    elderly: Vec<(f32, f32)>,
    cells: u64,
    imputed_cells: u64,
    population: f64,
    imputed_population: f64,
}

/// Valeurs d'un carreau à additionner (indices dans `Feature::props` à l'entrée des généralisateurs).
mod raw {
    pub const IND: usize = 0;
    pub const MEN: usize = 1;
    pub const MEN_PAUV: usize = 2;
    pub const IND_SNV: usize = 3;
    pub const IND_65: usize = 4;
    pub const IND_IMP: usize = 5;
}

impl Population {
    pub fn new() -> Population {
        let url = std::env::var("INSEE_CARREAUX_URL").ok().filter(|u| !u.is_empty()).unwrap_or_else(|| DEFAULT_URL.to_string());
        Population { url, samples: Mutex::new(Samples::default()), grid_cells: Mutex::new(Vec::with_capacity(2_320_000)), grid: RwLock::new(None) }
    }

    /// La grille de population des isochrones, une fois l'archive en service.
    pub fn grid(&self) -> Option<Arc<PopGrid>> {
        self.grid.read().expect("verrou de la grille").clone()
    }

    fn grid_file(dir: &Path, version: &str) -> std::path::PathBuf {
        dir.join(format!("population-grille-{version}.bin"))
    }

    fn scan_csv(&self, reader: &mut dyn Read, emit: &mut dyn FnMut(Feature) -> Result<()>, unknown: &mut u64) -> Result<u64> {
        let mut csv = csv::ReaderBuilder::new().from_reader(reader);
        let headers = csv.headers()?.clone();
        let column = |name: &str| headers.iter().position(|h| h == name).with_context(|| format!("colonne « {name} » absente du CSV"));
        let (c_id, c_imp) = (column("idcar_200m")?, column("i_est_200")?);
        let (c_ind, c_men, c_pauv, c_snv) = (column("ind")?, column("men")?, column("men_pauv")?, column("ind_snv")?);
        let (c_65, c_80) = (column("ind_65_79")?, column("ind_80p")?);
        let mut record = csv::ByteRecord::new();
        let mut count = 0u64;
        let number = |record: &csv::ByteRecord, column: usize| -> f32 {
            std::str::from_utf8(record.get(column).unwrap_or_default()).ok().and_then(|t| t.parse::<f32>().ok()).unwrap_or(0.0)
        };
        while csv.read_byte_record(&mut record)? {
            let Some((crs, size, n, e)) = std::str::from_utf8(record.get(c_id).unwrap_or_default()).ok().and_then(parse_id) else {
                *unknown += 1;
                continue;
            };
            let (ind, men, pauv, snv) = (number(&record, c_ind), number(&record, c_men), number(&record, c_pauv), number(&record, c_snv));
            let elderly = number(&record, c_65) + number(&record, c_80);
            let imputed = record.get(c_imp) == Some(b"1");
            if ind <= 0.0 {
                continue; // carreau sans habitant : rien à montrer
            }
            if crs == Crs::Laea && count % 16 == 0 {
                // Échantillon pour les légendes, pondéré par les habitants.
                let mut s = self.samples.lock().expect("échantillons");
                s.density.push((ind / 0.04, ind));
                s.income.push((snv / ind, ind));
                if men > 0.0 {
                    s.poverty.push((100.0 * pauv / men, ind));
                }
                s.elderly.push((100.0 * elderly / ind, ind));
            }
            {
                let mut s = self.samples.lock().expect("échantillons");
                s.cells += 1;
                s.population += f64::from(ind);
                if imputed {
                    s.imputed_cells += 1;
                    s.imputed_population += f64::from(ind);
                }
            }
            if crs == Crs::Laea && size == 200 {
                self.grid_cells.lock().expect("carreaux de la grille").push(((e / 200) as u16, (n / 200) as u16, ind));
            }
            let cell = Cell { crs, e, n, size };
            emit(Feature {
                geom: Geometry::Cell(cell),
                props: [ind, men, pauv, snv, elderly, if imputed { ind } else { 0.0 }].into_iter().map(Value::Float).collect(),
                weight: ind,
            })?;
            count += 1;
        }
        Ok(count)
    }
}

/// `CRS3035RES200mN2029800E4252400` → (repère, côté, nord, est).
fn parse_id(id: &str) -> Option<(Crs, u32, i32, i32)> {
    let rest = id.strip_prefix("CRS")?;
    let (epsg, rest) = rest.split_once("RES")?;
    let (size, rest) = rest.split_once('m')?;
    let (n, e) = rest.strip_prefix('N')?.split_once('E')?;
    Some((Crs::from_epsg(epsg.parse().ok()?)?, size.parse().ok()?, n.parse().ok()?, e.parse().ok()?))
}

/// Ratios et arrondis d'un carreau (ou d'un agrégat) à partir de ses sommes.
fn finalize(sums: &[f32], size: u32) -> (Vec<Value>, f32) {
    let ind = sums[raw::IND];
    let km2 = (f64::from(size) / 1000.0).powi(2) as f32;
    let ratio = |num: f32, den: f32| if den > 0.0 { num / den } else { 0.0 };
    let props = vec![
        Value::Int(ind.round() as i64),
        Value::Int((ind / km2).round() as i64),
        Value::Int(sums[raw::MEN].round() as i64),
        Value::Int(ratio(sums[raw::IND_SNV], ind).round() as i64),
        Value::Int((100.0 * ratio(sums[raw::MEN_PAUV], sums[raw::MEN])).round() as i64),
        Value::Int((100.0 * ratio(sums[raw::IND_65], ind)).round() as i64),
        Value::Int((100.0 * ratio(sums[raw::IND_IMP], ind)).round() as i64),
    ];
    (props, ind)
}

/// Seuils de légende : quantiles de la distribution **des habitants** (chaque valeur pèse ses habitants), arrondis, strictement croissants.
fn stops(samples: &mut [(f32, f32)], round_to: f32) -> Vec<f32> {
    samples.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: f64 = samples.iter().map(|s| f64::from(s.1)).sum();
    let mut out: Vec<f32> = Vec::new();
    let mut cumulative = 0.0;
    let mut targets = [0.03, 0.17, 0.33, 0.5, 0.67, 0.83, 0.97].into_iter().peekable();
    for (value, weight) in samples.iter() {
        cumulative += f64::from(*weight);
        while targets.peek().is_some_and(|t| cumulative >= t * total) {
            targets.next();
            let rounded = (value / round_to).round() * round_to;
            out.push(if out.last().is_some_and(|last| rounded <= *last) { out.last().copied().unwrap_or(0.0) + round_to } else { rounded });
        }
    }
    while out.len() < 7 {
        out.push(out.last().copied().unwrap_or(0.0) + round_to);
    }
    out
}

impl Dataset for Population {
    fn id(&self) -> &'static str {
        "population"
    }
    fn layer(&self) -> &'static str {
        "population"
    }
    fn keys(&self) -> &'static [&'static str] {
        &["pop", "d", "men", "niv", "pauv", "a65", "imp"]
    }
    fn zooms(&self) -> (u8, u8) {
        (4, 12)
    }
    fn schema_version(&self) -> u32 {
        1
    }
    fn source_id(&self) -> String {
        format!("filosofi-{VINTAGE}|{}", self.url)
    }
    fn attribution(&self) -> &'static str {
        "INSEE, Filosofi 2019"
    }
    fn license(&self) -> &'static str {
        "Licence ouverte Etalab 2.0"
    }
    fn spool_zoom(&self) -> u8 {
        10
    }

    fn acquire<'a>(&'a self, http: &'a reqwest::Client, dir: &'a Path) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let target = dir.join(ZIP_NAME);
            if std::fs::metadata(&target).is_ok_and(|m| m.len() > 1_000_000) {
                return Ok(());
            }
            info!(url = %self.url, "population : téléchargement des carreaux INSEE");
            let mut response = http.get(&self.url).timeout(std::time::Duration::from_secs(3600)).send().await?.error_for_status()?;
            let partial = dir.join(format!("{ZIP_NAME}.partiel"));
            let mut file = File::create(&partial)?;
            let mut bytes = 0u64;
            while let Some(chunk) = response.chunk().await? {
                std::io::Write::write_all(&mut file, &chunk)?;
                bytes += chunk.len() as u64;
            }
            drop(file);
            if bytes < 1_000_000 {
                bail!("fichier INSEE suspect ({bytes} octets)");
            }
            std::fs::rename(&partial, &target)?;
            info!(mo = bytes / 1_048_576, "population : carreaux INSEE téléchargés");
            Ok(())
        })
    }

    fn scan(&self, dir: &Path, emit: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
        *self.samples.lock().expect("échantillons") = Samples::default();
        let file = File::open(dir.join(ZIP_NAME)).context("zip INSEE absent")?;
        let mut zip = zip::ZipArchive::new(BufReader::new(file)).context("zip INSEE illisible")?;
        let mut unknown = 0u64;
        let mut total = 0u64;
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i)?;
            let name = entry.name().to_string();
            if name.ends_with(".csv") {
                total += self.scan_csv(&mut entry, emit, &mut unknown)?;
            } else if name.ends_with(".7z") {
                // L'INSEE emballe ses CSV dans un 7z lui-même zippé : on sort le 7z, et on lit ses CSV un à un, en flux.
                let inner = dir.join("carreaux.7z");
                std::io::copy(&mut entry, &mut File::create(&inner)?)?;
                drop(entry);
                let mut failure: Option<anyhow::Error> = None;
                let mut reader = sevenz_rust2::ArchiveReader::open(&inner, sevenz_rust2::Password::empty()).context("7z INSEE illisible")?;
                reader.set_thread_count(1); // un seul fil de décodage : bien moins de mémoire
                let result = reader.for_each_entries(|item, data| {
                    if !item.name().ends_with(".csv") {
                        return Ok(true);
                    }
                    info!(fichier = item.name(), "population : lecture");
                    match self.scan_csv(data, emit, &mut unknown) {
                        Ok(n) => {
                            total += n;
                            Ok(true)
                        }
                        Err(error) => {
                            failure = Some(error);
                            Err(sevenz_rust2::Error::Other("lecture interrompue".into()))
                        }
                    }
                });
                let _ = std::fs::remove_file(&inner);
                if let Some(error) = failure {
                    return Err(error);
                }
                result.context("lecture du 7z INSEE")?;
            }
        }
        if unknown > 0 {
            warn!(carreaux = unknown, "population : carreaux dans un repère inconnu, ignorés");
        }
        if total == 0 {
            bail!("aucun carreau lu dans la source INSEE");
        }
        info!(carreaux = total, "population : carreaux lus");
        Ok(())
    }

    fn finish(&self, out_dir: &Path, version: &str) -> Result<()> {
        let cells = std::mem::take(&mut *self.grid_cells.lock().expect("carreaux de la grille"));
        let cells: Vec<(i32, i32, f32)> = cells.iter().map(|&(e, n, ind)| (i32::from(e) * 200, i32::from(n) * 200, ind)).collect();
        let grid = PopGrid::build(&cells);
        drop(cells);
        grid.write(&Self::grid_file(out_dir, version))?;
        info!(carreaux = grid.cell_count(), mo = grid.bytes() / 1_048_576, "population : grille des isochrones écrite");
        Ok(())
    }

    fn load_extras(&self, dir: &Path, version: &str) -> Result<()> {
        let grid = PopGrid::read(&Self::grid_file(dir, version))?;
        info!(carreaux = grid.cell_count(), mo = grid.bytes() / 1_048_576, "population : grille des isochrones chargée");
        *self.grid.write().expect("verrou de la grille") = Some(Arc::new(grid));
        Ok(())
    }

    fn generalizer(&self, zoom: u8) -> Box<dyn Generalizer> {
        let finalize: Finalize = Box::new(finalize);
        Box::new(GridAggregator::new(cell_size(zoom), finalize))
    }

    /// Un carreau se rattache au seau du centre de son bloc de 8 km : tous les carreaux qu'on additionne ensemble
    /// (aux zooms des seaux, ≤ 1 km) tombent dans le même.
    fn anchor(&self, feature: &Feature) -> [f64; 2] {
        let Geometry::Cell(cell) = &feature.geom else { return [0.0, 0.0] };
        let block = cell.block(BLOCK_M);
        let (lon, lat) = block.crs.to_lonlat(f64::from(block.e) + f64::from(BLOCK_M) / 2.0, f64::from(block.n) + f64::from(BLOCK_M) / 2.0);
        [lon, lat]
    }

    /// … et il est recopié dans les seaux voisins que son bloc déborde, pour que leurs tuiles de bord soient complètes.
    fn influence(&self, feature: &Feature) -> Bounds {
        let Geometry::Cell(cell) = &feature.geom else { return Bounds::EMPTY };
        Bounds::of(cell.block(BLOCK_M).corners())
    }

    fn metadata(&self) -> serde_json::Value {
        let mut s = self.samples.lock().expect("échantillons");
        let density = stops(&mut s.density, 10.0);
        let income = stops(&mut s.income, 500.0);
        let poverty = stops(&mut s.poverty, 1.0);
        let elderly = stops(&mut s.elderly, 1.0);
        serde_json::json!({
            "millesime": VINTAGE,
            "habitants": s.population.round(),
            "carreaux": s.cells,
            "carreauxImputes": s.imputed_cells,
            "habitantsImputes": s.imputed_population.round(),
            // Seuils des légendes (quantiles pondérés par les habitants), du plus clair au plus foncé.
            "seuils": { "d": density, "niv": income, "pauv": poverty, "a65": elderly },
            "tailles": (4..=12).map(|z| serde_json::json!([z, cell_size(z)])).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiants_de_carreaux() {
        assert_eq!(parse_id("CRS3035RES200mN2029800E4252400"), Some((Crs::Laea, 200, 2_029_800, 4_252_400)));
        assert_eq!(parse_id("CRS5490RES200mN1592600E728800"), Some((Crs::UtmMartinique, 200, 1_592_600, 728_800)));
        assert_eq!(parse_id("CRS2975RES1000mN7634000E359000"), Some((Crs::UtmReunion, 1000, 7_634_000, 359_000)));
        assert_eq!(parse_id("CRS9999RES200mN1E1"), None);
        assert_eq!(parse_id("n'importe quoi"), None);
    }

    #[test]
    fn ratios_recalcules_depuis_les_sommes() {
        // Un carreau de 1 km : 400 habitants, 160 ménages dont 40 pauvres, niveaux de vie cumulés 8 M€, 100 de 65 ans et plus, 300 en carreaux imputés.
        let (props, weight) = finalize(&[400.0, 160.0, 40.0, 8_000_000.0, 100.0, 300.0], 1000);
        assert_eq!(
            props,
            vec![Value::Int(400), Value::Int(400), Value::Int(160), Value::Int(20_000), Value::Int(25), Value::Int(25), Value::Int(75)]
        );
        assert_eq!(weight, 400.0);
        // Un carreau de 200 m : la densité se rapporte à 0,04 km².
        let (props, _) = finalize(&[20.0, 8.0, 0.0, 400_000.0, 0.0, 0.0], 200);
        assert_eq!(props[1], Value::Int(500));
        // Pas de ménages : pas de division par zéro.
        let (props, _) = finalize(&[5.0, 0.0, 0.0, 0.0, 0.0, 0.0], 200);
        assert_eq!(props[4], Value::Int(0));
    }

    #[test]
    fn seuils_ponderes_par_les_habitants() {
        // 90 % des habitants vivent dans des cellules à 10, 10 % dans des cellules à 1000 : les seuils suivent les habitants.
        let mut samples: Vec<(f32, f32)> = (0..90).map(|_| (10.0, 10.0)).chain((0..10).map(|_| (1000.0, 10.0))).collect();
        let s = stops(&mut samples, 1.0);
        assert_eq!(s.len(), 7);
        assert!(s.windows(2).all(|w| w[0] < w[1]), "strictement croissants : {s:?}");
        assert_eq!(s[0], 10.0);
        assert_eq!(s[6], 1000.0);
    }

    #[test]
    fn les_tailles_de_carreaux_se_rangent_dans_les_blocs() {
        // Aux zooms des seaux (≥ 9), chaque taille divise le bloc de 8 km.
        for z in 9..=12 {
            assert_eq!(BLOCK_M as u32 % cell_size(z), 0, "zoom {z}");
        }
        assert!(cell_size(4) > cell_size(8) && cell_size(8) > cell_size(12));
    }
}
