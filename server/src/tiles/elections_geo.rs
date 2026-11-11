//! Les formes du jeu « élections » : contours des bureaux de vote, communes et départements.
//!
//! # Trois sources, un même format de travail
//!
//! | niveau       | source                                                                 | volume brut        |
//! |--------------|------------------------------------------------------------------------|--------------------|
//! | bureaux      | Etalab, « contours des bureaux de vote » (data.gouv.fr, GeoJSON)        | ~650 Mo, 68 800 objets |
//! | communes     | IGN, ADMIN EXPRESS COG CARTO (service WFS de la Géoplateforme)         | ~190 Mo, 34 877 communes |
//! | départements | IGN, ADMIN EXPRESS COG CARTO (même service)                            | ~14 Mo, 101 départements |
//!
//! Ces fichiers sont gros et bavards (15 décimales pour les bureaux, soit des micromètres). On les lit **en flux**, on arrondit les
//! coordonnées à 5 décimales (~1 m), on retire les sommets qui dévient de moins de ~1,7 m (Douglas-Peucker), et on range
//! le résultat dans un petit fichier de travail par niveau : une ligne JSON par objet, compressée (`*.ndjson.gz`). Le fichier brut
//! n'est jamais écrit sur le disque : le GeoJSON des bureaux passe de la réponse HTTP au fichier compact, un objet à la fois
//! (le découpeur `FeatureSplitter` repère les accolades sans jamais garder plus d'un objet en mémoire).
//!
//! Le format de travail (`Shape`) : `{"c": code, "n": nom, "p": [[[[lon, lat], …], trou, …], autre partie, …]}`.
//! Un objet peut avoir plusieurs *parties* (un archipel, une commune coupée par une autre) : chaque partie est un polygone
//! (anneau extérieur, puis trous). Le moteur de tuiles n'accepte qu'un polygone par objet : `elections.rs` émet une
//! ligne de tuile par partie.

use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

use anyhow::{Context, Result, bail};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use tracing::info;

use super::geom::simplify_ring;

pub const BUREAUX_FILE: &str = "bureaux.ndjson.gz";
pub const COMMUNES_FILE: &str = "communes.ndjson.gz";
pub const DEPARTEMENTS_FILE: &str = "departements.ndjson.gz";

/// Contours des bureaux de vote d'Etalab (dernière version publiée : la date change à chaque mise à jour du fichier).
const BUREAUX_URL: &str = "https://data-pipeline-open.s3.sbg.io.cloud.ovh.net/reu/contours-france-entiere-latest-v2.geojson";
/// Service WFS de la Géoplateforme de l'IGN : ADMIN EXPRESS COG CARTO, millésime courant.
const WFS_URL: &str = "https://data.geopf.fr/wfs/ows?service=WFS&version=2.0.0&request=GetFeature&outputFormat=application/json&srsName=EPSG:4326&sortBy=cleabs&propertyName=code_insee,nom_officiel,geometrie";

/// Tolérance de simplification du fichier de travail, en degrés, selon le niveau. Elle se règle sur l'usage de la forme :
/// - bureaux (~3,3 m) : dessinés jusqu'au zoom 12, où une unité de tuile fait ~1,6 m à 48 °N et où le moteur simplifie à 4 unités (6 m) ; moins de sommets, c'est aussi moins de mémoire par seau à la fabrication ;
/// - communes (~4,4 m) : dessinées aux zooms 7 à 9 (une unité = 19 m au 9) ; au-delà, elles ne servent que de fond de repli sous les bureaux ;
/// - départements (~33 m) : dessinés aux zooms 4 à 6 seulement (une unité = 150 m au 6).
/// Sans cette simplification, les communes de l'IGN (200 sommets en moyenne) pèseraient ~100 Mo compressées ; elles en pèsent le tiers.
const TOLERANCE_BUREAUX: f64 = 0.000_03;
const TOLERANCE_COMMUNES: f64 = 0.000_04;
const TOLERANCE_DEPARTEMENTS: f64 = 0.000_3;

/// Un objet du fichier de travail.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Shape {
    /// Code : `75056_0101` (bureau), `75056` (commune), `75` (département).
    pub c: String,
    /// Nom : celui de la commune pour un bureau.
    pub n: String,
    /// Parties (polygones) : anneaux `[lon, lat]`, le premier est l'extérieur.
    pub p: Vec<Vec<Vec<[f64; 2]>>>,
}

/// Lit un fichier de travail, objet par objet.
pub fn read_shapes(path: &Path, mut each: impl FnMut(Shape) -> Result<()>) -> Result<()> {
    let file = File::open(path).with_context(|| format!("{} absent", path.display()))?;
    for line in BufReader::new(GzDecoder::new(file)).lines() {
        let line = line?;
        if line.is_empty() {
            continue;
        }
        each(serde_json::from_str(&line).context("ligne de forme illisible")?)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// GeoJSON → format de travail
// ---------------------------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(tag = "type")]
enum Geo {
    Polygon { coordinates: Vec<Vec<[f64; 2]>> },
    MultiPolygon { coordinates: Vec<Vec<Vec<[f64; 2]>>> },
}

/// Propriétés qu'on lit (les autres sont ignorées) : celles des bureaux d'Etalab et celles de l'IGN.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Props {
    #[serde(rename = "codeBureauVote")]
    code_bureau: Option<String>,
    #[serde(rename = "nomCommune")]
    nom_commune: Option<String>,
    code_insee: Option<String>,
    nom_officiel: Option<String>,
}

#[derive(Deserialize)]
struct RawFeature {
    #[serde(default)]
    properties: Props,
    geometry: Option<Geo>,
}

/// Arrondit à 5 décimales, simplifie, et ferme l'anneau. `None` s'il n'en reste pas un polygone.
fn compact_ring(ring: &[[f64; 2]], tolerance: f64) -> Option<Vec<[f64; 2]>> {
    let mut points: Vec<[f64; 2]> = ring.iter().map(|p| [(p[0] * 1e5).round() / 1e5, (p[1] * 1e5).round() / 1e5]).collect();
    points.dedup();
    if points.len() > 1 && points.first() != points.last() {
        points.push(points[0]);
    }
    let mut out = simplify_ring(&points, tolerance);
    // `simplify_ring` rend l'anneau sans répéter le premier point (sauf quand il n'y a rien à simplifier) : on le referme.
    if out.first() != out.last() {
        out.push(out[0]);
    }
    if out.len() < 4 { None } else { Some(out) }
}

fn compact_polygons(geo: Geo, tolerance: f64) -> Vec<Vec<Vec<[f64; 2]>>> {
    let polygons = match geo {
        Geo::Polygon { coordinates } => vec![coordinates],
        Geo::MultiPolygon { coordinates } => coordinates,
    };
    polygons
        .iter()
        .filter_map(|rings| {
            let mut rings = rings.iter();
            // Sans anneau extérieur, les trous n'ont plus de sens ; un trou dégénéré, lui, s'ignore.
            let outer = compact_ring(rings.next()?, tolerance)?;
            let mut out = vec![outer];
            out.extend(rings.filter_map(|r| compact_ring(r, tolerance)));
            Some(out)
        })
        .collect()
}

/// Convertit un objet GeoJSON brut en ligne de travail. `None` pour ce qui n'est pas un bureau / une commune / un département.
fn shape_from_feature(bytes: &[u8], tolerance: f64) -> Result<Option<Shape>> {
    shape_from_raw(serde_json::from_slice(bytes).context("objet GeoJSON illisible")?, tolerance)
}

fn shape_from_raw(raw: RawFeature, tolerance: f64) -> Result<Option<Shape>> {
    let Some(geometry) = raw.geometry else { return Ok(None) };
    let (code, name) = match (raw.properties.code_bureau, raw.properties.code_insee) {
        (Some(code), _) => (code, raw.properties.nom_commune.unwrap_or_default()),
        (None, Some(code)) => (code, raw.properties.nom_officiel.unwrap_or_default()),
        _ => return Ok(None),
    };
    let parts = compact_polygons(geometry, tolerance);
    if parts.is_empty() {
        return Ok(None);
    }
    Ok(Some(Shape { c: code, n: name, p: parts }))
}

/// Écrit des objets dans un fichier de travail (`.partiel` puis renommage : jamais de fichier à moitié écrit en service).
struct ShapeWriter {
    out: GzEncoder<BufWriter<File>>,
    partial: std::path::PathBuf,
    target: std::path::PathBuf,
    count: u64,
}

impl ShapeWriter {
    fn create(target: &Path) -> Result<ShapeWriter> {
        let partial = target.with_extension("gz.partiel");
        let out = GzEncoder::new(BufWriter::new(File::create(&partial)?), Compression::default());
        Ok(ShapeWriter { out, partial, target: target.to_path_buf(), count: 0 })
    }

    fn write(&mut self, shape: &Shape) -> Result<()> {
        serde_json::to_writer(&mut self.out, shape)?;
        self.out.write_all(b"\n")?;
        self.count += 1;
        Ok(())
    }

    fn finish(self) -> Result<u64> {
        let mut inner = self.out.finish()?;
        inner.flush()?;
        drop(inner);
        std::fs::rename(&self.partial, &self.target)?;
        Ok(self.count)
    }
}

// ---------------------------------------------------------------------------------------------
// Découpeur de GeoJSON en flux
// ---------------------------------------------------------------------------------------------

/// Repère, dans un flux d'octets qui arrive par morceaux, les objets du premier niveau d'une `FeatureCollection`
/// (`{"type": "FeatureCollection", "features": [ {…}, {…} ]}`) : chaque objet du tableau `features` est rendu entier, un à un.
///
/// L'idée : compter les accolades en ignorant celles qui sont dans une chaîne (`"…{…"`, avec ses `\"` échappés). Un objet commence
/// quand la profondeur passe de 1 à 2 et finit quand elle redescend à 1. On ne garde en mémoire que l'objet en cours : un fichier
/// de 650 Mo se lit avec quelques centaines de Ko. (Le petit objet `"crs": {…}` de l'en-tête passe aussi : il n'a pas de géométrie, il est écarté plus loin.)
#[derive(Default)]
pub struct FeatureSplitter {
    depth: u32,
    in_string: bool,
    escaped: bool,
    current: Vec<u8>,
}

impl FeatureSplitter {
    /// Pousse un morceau ; `each` reçoit chaque objet terminé.
    pub fn push(&mut self, chunk: &[u8], mut each: impl FnMut(&[u8]) -> Result<()>) -> Result<()> {
        for &byte in chunk {
            if self.in_string {
                if self.depth >= 2 {
                    self.current.push(byte);
                }
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.in_string = false;
                }
                continue;
            }
            match byte {
                b'"' => {
                    self.in_string = true;
                    if self.depth >= 2 {
                        self.current.push(byte);
                    }
                }
                b'{' => {
                    self.depth += 1;
                    if self.depth >= 2 {
                        self.current.push(byte);
                    }
                }
                b'}' => {
                    if self.depth >= 2 {
                        self.current.push(byte);
                    }
                    self.depth = self.depth.saturating_sub(1);
                    if self.depth == 1 && !self.current.is_empty() {
                        each(&self.current)?;
                        self.current.clear();
                    }
                }
                _ => {
                    if self.depth >= 2 {
                        self.current.push(byte);
                    }
                }
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Téléchargements
// ---------------------------------------------------------------------------------------------

/// S'assure que les trois fichiers de formes sont dans `dir` ; télécharge et convertit ceux qui manquent.
pub async fn acquire_shapes(http: &reqwest::Client, dir: &Path) -> Result<()> {
    if !dir.join(DEPARTEMENTS_FILE).exists() {
        info!("élections : téléchargement des départements (IGN, ADMIN EXPRESS)");
        let n = download_wfs(http, "departement", 10, TOLERANCE_DEPARTEMENTS, &dir.join(DEPARTEMENTS_FILE)).await?;
        info!(departements = n, "élections : départements prêts");
    }
    if !dir.join(COMMUNES_FILE).exists() {
        info!("élections : téléchargement des communes (IGN, ADMIN EXPRESS), 70 pages");
        let n = download_wfs(http, "commune", 500, TOLERANCE_COMMUNES, &dir.join(COMMUNES_FILE)).await?;
        info!(communes = n, "élections : communes prêtes");
    }
    if !dir.join(BUREAUX_FILE).exists() {
        info!("élections : téléchargement des contours des bureaux de vote (Etalab, ~650 Mo en flux)");
        let n = download_bureaux(http, &dir.join(BUREAUX_FILE)).await?;
        info!(bureaux = n, "élections : contours des bureaux prêts");
    }
    Ok(())
}

/// Les contours d'Etalab : une seule grosse réponse, convertie à la volée.
async fn download_bureaux(http: &reqwest::Client, target: &Path) -> Result<u64> {
    let mut response = http.get(BUREAUX_URL).timeout(std::time::Duration::from_secs(3600)).send().await?.error_for_status()?;
    let mut writer = ShapeWriter::create(target)?;
    let mut splitter = FeatureSplitter::default();
    while let Some(chunk) = response.chunk().await? {
        splitter.push(&chunk, |feature| {
            if let Some(shape) = shape_from_feature(feature, TOLERANCE_BUREAUX)? {
                writer.write(&shape)?;
            }
            Ok(())
        })?;
    }
    let count = writer.finish()?;
    if count < 60_000 {
        let _ = std::fs::remove_file(target);
        bail!("contours des bureaux incomplets ({count} objets, il en faut ~68 000)");
    }
    Ok(count)
}

/// Une couche de l'IGN, page par page (`count` objets à la fois : une page se lit en mémoire, d'où le petit `count` pour les communes).
async fn download_wfs(http: &reqwest::Client, layer: &str, count: usize, tolerance: f64, target: &Path) -> Result<u64> {
    let mut writer = ShapeWriter::create(target)?;
    let mut start = 0usize;
    loop {
        let url = format!("{WFS_URL}&typeName=ADMINEXPRESS-COG-CARTO.LATEST:{layer}&count={count}&startIndex={start}");
        let mut attempt = 0;
        let body = loop {
            attempt += 1;
            let result = async {
                let response = http.get(&url).timeout(std::time::Duration::from_secs(300)).send().await?.error_for_status()?;
                anyhow::Ok(response.bytes().await?)
            }
            .await;
            match result {
                Ok(body) => break body,
                Err(error) if attempt < 4 => {
                    tracing::warn!("élections : page IGN {layer} à partir de {start} : {error:#}, nouvel essai");
                    tokio::time::sleep(std::time::Duration::from_secs(5 * attempt)).await;
                }
                Err(error) => return Err(error).context("service WFS de l'IGN"),
            }
        };
        #[derive(Deserialize)]
        struct Page {
            features: Vec<RawFeature>,
        }
        let page: Page = serde_json::from_slice(&body).context("page WFS illisible")?;
        let n = page.features.len();
        for feature in page.features {
            if let Some(shape) = shape_from_raw(feature, tolerance)? {
                writer.write(&shape)?;
            }
        }
        if n < count {
            break;
        }
        start += n;
    }
    let total = writer.finish()?;
    // Garde-fou : une couche vide ou tronquée ne doit pas devenir « la » source.
    let minimum = if layer == "departement" { 90 } else { 30_000 };
    if (total as usize) < minimum {
        let _ = std::fs::remove_file(target);
        bail!("couche IGN « {layer} » incomplète ({total} objets)");
    }
    Ok(total)
}

/// Télécharge un fichier de résultats et le range compressé (`gzip`) : le CSV des européennes pèse 254 Mo, une fois compressé ~25 Mo.
pub async fn download_gz(http: &reqwest::Client, url: &str, target: &Path) -> Result<()> {
    let mut response = http.get(url).timeout(std::time::Duration::from_secs(1800)).send().await?.error_for_status()?;
    let partial = target.with_extension("gz.partiel");
    let mut out = GzEncoder::new(BufWriter::new(File::create(&partial)?), Compression::default());
    let mut bytes = 0u64;
    while let Some(chunk) = response.chunk().await? {
        out.write_all(&chunk)?;
        bytes += chunk.len() as u64;
    }
    out.finish()?.flush()?;
    if bytes < 1_000_000 {
        let _ = std::fs::remove_file(&partial);
        bail!("fichier de résultats suspect ({bytes} octets) : {url}");
    }
    std::fs::rename(&partial, target)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_decoupeur_rend_chaque_objet_meme_coupe_en_morceaux_et_avec_des_accolades_dans_les_chaines() {
        let json = br#"{"type":"FeatureCollection","crs":{"type":"name"},"features":[{"type":"Feature","properties":{"n":"a } { \" b"},"geometry":null},{"type":"Feature","properties":{"n":"c"},"geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]}}]}"#;
        // Par morceaux de 7 octets : les coupures tombent partout, y compris dans une chaîne échappée.
        let mut splitter = FeatureSplitter::default();
        let mut found: Vec<String> = Vec::new();
        for chunk in json.chunks(7) {
            splitter.push(chunk, |f| {
                found.push(String::from_utf8(f.to_vec()).unwrap());
                Ok(())
            })
            .unwrap();
        }
        assert_eq!(found.len(), 3, "{found:?}"); // l'en-tête `crs`, puis les deux objets
        assert!(found[1].contains(r#"a } { \" b"#));
        assert!(found[2].ends_with("0]]]}}"));
        // Chaque morceau est un JSON valide.
        for f in &found {
            serde_json::from_str::<serde_json::Value>(f).unwrap();
        }
    }

    #[test]
    fn la_conversion_arrondit_ferme_et_separe_les_parties() {
        let feature = br#"{"type":"Feature","properties":{"codeBureauVote":"01001_0001","nomCommune":"L'Abergement"},"geometry":{"type":"MultiPolygon","coordinates":[
            [[[4.9581212345,46.153159],[4.96,46.153159],[4.96,46.16],[4.9581212345,46.16],[4.9581212345,46.153159]]],
            [[[5.0,46.0],[5.1,46.0],[5.1,46.1],[5.0,46.0]]]]}}"#;
        let shape = shape_from_feature(feature, TOLERANCE_BUREAUX).unwrap().expect("un bureau");
        assert_eq!((shape.c.as_str(), shape.n.as_str()), ("01001_0001", "L'Abergement"));
        assert_eq!(shape.p.len(), 2, "deux parties");
        let ring = &shape.p[0][0];
        assert_eq!(ring.first(), ring.last(), "anneau fermé");
        assert_eq!(ring[0], [4.95812, 46.15316], "5 décimales");
        // L'en-tête `crs` (sans géométrie ni code) est écarté.
        assert!(shape_from_feature(br#"{"type":"name","properties":{"name":"urn:ogc"}}"#, TOLERANCE_BUREAUX).unwrap().is_none());
    }
}
