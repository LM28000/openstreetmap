//! Relief LiDAR HD de l'IGN en tuiles d'altitude pour le relief 3D de la carte.
//!
//! `GET /api/relief-lidar/{z}/{x}/{y}.png` répond une tuile de 512 × 512 pixels en « terrarium » (altitude =
//! R × 256 + V + B / 256 − 32 768 mètres), le même encodage que les tuiles Mapterhorn du relief ordinaire.
//!
//! D'où vient l'altitude : le MNT du LiDAR HD (terrain nu, maille de 50 cm) de la Géoplateforme, sans clé, en WMS-Raster
//! `image/x-bil;bits=32` (des flottants de 32 bits, l'IGN n'a pas de terrain-RGB), reprojeté par l'IGN dans le découpage
//! de la carte. Un pixel sans donnée vaut −9999. Le LiDAR HD est encore en cours de publication : certaines zones n'ont
//! pas de MNT.
//!
//! Hors de la zone couverte, la tuile « retombe » sur le relief ordinaire :
//! - tuile sans aucun pixel LiDAR : redirection (302) vers la même tuile Mapterhorn, sans rien décoder ;
//! - tuile en partie couverte (bord de la zone, littoral) : les pixels sans donnée reprennent l'altitude de Mapterhorn,
//!   avec un fondu sur quelques pixels pour qu'il n'y ait pas de marche au raccord ;
//! - zoom hors de 13 à 17, ou service de l'IGN en panne : même redirection, non gardée en cache.
//!
//! Mémoire : les conversions sont limitées à `PARALLEL` à la fois, aucune image décodée n'est gardée (1 à 2 Mo de
//! tampons par conversion, rendus aussitôt). Cache disque dans `DATA_DIR/relief-lidar/{z}/{x}/{y}.png` : plafond de taille
//! (`RELIEF_LIDAR_MO`, 300 par défaut ; les plus anciens fichiers partent d'abord) et expiration (30 jours pour une tuile,
//! 7 jours pour la mention « pas de LiDAR ici », un fichier `.vide`, puisque la couverture progresse).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use anyhow::{Result, ensure};
use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use flate2::Compression;
use flate2::write::ZlibEncoder;
use tokio::sync::Semaphore;
use tracing::{info, warn};

/// Côté d'une tuile, en pixels (comme les tuiles Mapterhorn de la carte).
const SIZE: usize = 512;
/// Zooms servis : au-dessus du 17 (0,6 m par pixel), Mapterhorn n'a plus rien ; en dessous du 13, le relief ordinaire (Mapterhorn, tuiles de 19 m par pixel) suffit et la requête à l'IGN serait gâchée.
const MIN_ZOOM: u32 = 13;
const MAX_ZOOM: u32 = 17;
/// Conversions simultanées : chacune tient 1 à 2 Mo, mais le serveur de production est serré.
const PARALLEL: usize = 2;
/// Valeur des pixels sans donnée dans le BIL de l'IGN. Le rééchantillonnage de l'IGN en mélange aux bords (−8 983 relevé) :
/// tout ce qui est sous ce seuil est sans donnée (aucun terrain de France n'est à −100 m).
const NO_DATA_BELOW: f32 = -100.0;
/// Largeur du fondu entre LiDAR et relief ordinaire au bord de la zone couverte, en pixels.
const FEATHER: f32 = 8.0;
/// Un pixel LiDAR qui s'écarte de plus que cela de Mapterhorn est une erreur de rééchantillonnage aux bords, pas du relief.
const MAX_DEVIATION_M: f32 = 150.0;
const TILE_TTL: Duration = Duration::from_secs(30 * 86_400);
const EMPTY_TTL: Duration = Duration::from_secs(7 * 86_400);
const DEFAULT_LIMIT_MB: u64 = 300;
const WMS_TIMEOUT: Duration = Duration::from_secs(25);
const WMS: &str = "https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&STYLES=&CRS=EPSG:3857&FORMAT=image/x-bil;bits=32&LAYERS=IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G";
const MAPTERHORN: &str = "https://tiles.mapterhorn.com";

pub fn router(http: reqwest::Client, data_dir: PathBuf) -> Router {
    let limit = std::env::var("RELIEF_LIDAR_MO").ok().and_then(|v| v.parse::<u64>().ok()).unwrap_or(DEFAULT_LIMIT_MB) << 20;
    let relief = Arc::new(Relief {
        http,
        dir: data_dir.join("relief-lidar"),
        gate: Semaphore::new(PARALLEL),
        size: AtomicU64::new(0),
        limit,
        pruning: AtomicBool::new(false),
    });
    let scan = relief.clone();
    tokio::task::spawn_blocking(move || {
        let total = dir_size(&scan.dir);
        scan.size.store(total, Ordering::Relaxed);
        info!(taille_mo = total >> 20, plafond_mo = scan.limit >> 20, "relief LiDAR : cache relu");
        scan.prune_if_needed();
    });
    Router::new().route("/api/relief-lidar/{z}/{x}/{y}", get(tile)).with_state(relief)
}

struct Relief {
    http: reqwest::Client,
    dir: PathBuf,
    gate: Semaphore,
    /// Taille approximative du cache (octets), tenue à jour à chaque écriture.
    size: AtomicU64,
    limit: u64,
    pruning: AtomicBool,
}

/// Réponse : la tuile, ou le retour au relief ordinaire.
enum Answer {
    Png(Vec<u8>),
    Fallback { cache: bool },
}

async fn tile(State(relief): State<Arc<Relief>>, UrlPath((z, x, y)): UrlPath<(u32, u32, String)>) -> Response {
    let Some(y) = y.strip_suffix(".png").and_then(|y| y.parse::<u32>().ok()) else {
        return (StatusCode::NOT_FOUND, "tuile inconnue").into_response();
    };
    if z > MAX_ZOOM || x >= 1 << z || y >= 1 << z {
        return (StatusCode::NOT_FOUND, "tuile hors de la carte").into_response();
    }
    match relief.answer(z, x, y).await {
        Answer::Png(bytes) => {
            ([(header::CONTENT_TYPE, "image/png"), (header::CACHE_CONTROL, "public, max-age=86400")], bytes).into_response()
        }
        Answer::Fallback { cache } => {
            let location = format!("{MAPTERHORN}/{z}/{x}/{y}.webp");
            let control = if cache { "public, max-age=3600" } else { "no-store" };
            let mut response = (StatusCode::FOUND, [(header::CACHE_CONTROL, HeaderValue::from_static(control))]).into_response();
            if let Ok(value) = HeaderValue::from_str(&location) {
                response.headers_mut().insert(header::LOCATION, value);
            }
            response
        }
    }
}

impl Relief {
    fn png_path(&self, z: u32, x: u32, y: u32) -> PathBuf {
        self.dir.join(format!("{z}/{x}/{y}.png"))
    }

    fn empty_path(&self, z: u32, x: u32, y: u32) -> PathBuf {
        self.dir.join(format!("{z}/{x}/{y}.vide"))
    }

    async fn answer(self: &Arc<Self>, z: u32, x: u32, y: u32) -> Answer {
        if !(MIN_ZOOM..=MAX_ZOOM).contains(&z) {
            return Answer::Fallback { cache: true };
        }
        if let Some(answer) = self.cached(z, x, y).await {
            return answer;
        }
        // Une conversion à la fois par place : celles qui attendent trouvent souvent la tuile déjà faite.
        let Ok(_permit) = self.gate.acquire().await else { return Answer::Fallback { cache: false } };
        if let Some(answer) = self.cached(z, x, y).await {
            return answer;
        }
        match self.convert(z, x, y).await {
            Ok(Some(png)) => {
                self.store(&self.png_path(z, x, y), &png).await;
                Answer::Png(png)
            }
            Ok(None) => {
                self.store(&self.empty_path(z, x, y), &[]).await;
                Answer::Fallback { cache: true }
            }
            Err(error) => {
                warn!(z, x, y, "relief LiDAR : {error:#}");
                // Mieux vaut une tuile périmée que pas de tuile.
                if let Ok(bytes) = tokio::fs::read(self.png_path(z, x, y)).await {
                    return Answer::Png(bytes);
                }
                Answer::Fallback { cache: false }
            }
        }
    }

    /// La tuile du cache disque si elle n'a pas expiré (une tuile périmée ne sert que de secours, voir `answer`).
    async fn cached(&self, z: u32, x: u32, y: u32) -> Option<Answer> {
        let (png, empty) = (self.png_path(z, x, y), self.empty_path(z, x, y));
        if fresh(&empty, EMPTY_TTL).await {
            return Some(Answer::Fallback { cache: true });
        }
        if fresh(&png, TILE_TTL).await {
            return tokio::fs::read(&png).await.ok().map(Answer::Png);
        }
        None
    }

    async fn store(self: &Arc<Self>, path: &Path, bytes: &[u8]) {
        let result: Result<()> = async {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            // Écriture sous un nom provisoire puis renommage : une lecture ne voit jamais un fichier à moitié écrit.
            let part = path.with_extension("part");
            tokio::fs::write(&part, bytes).await?;
            tokio::fs::rename(&part, path).await?;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                self.size.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                self.prune_if_needed();
            }
            Err(error) => warn!("relief LiDAR : écriture du cache impossible : {error:#}"),
        }
    }

    /// Efface les plus anciens fichiers quand le cache dépasse son plafond (jusqu'à 85 % de celui-ci), dans un fil à part
    /// puisqu'il parcourt tout l'arbre.
    fn prune_if_needed(self: &Arc<Self>) {
        if self.size.load(Ordering::Relaxed) <= self.limit || self.pruning.swap(true, Ordering::AcqRel) {
            return;
        }
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let total = prune_dir(&this.dir, this.limit / 100 * 85);
            this.size.store(total, Ordering::Relaxed);
            this.pruning.store(false, Ordering::Release);
            info!(taille_mo = total >> 20, "relief LiDAR : cache nettoyé");
        });
    }

    /// Convertit une tuile : `None` si le LiDAR HD n'y couvre rien.
    async fn convert(&self, z: u32, x: u32, y: u32) -> Result<Option<Vec<u8>>> {
        let bil = self.fetch_bil(z, x, y).await?;
        let lidar = parse_bil(&bil)?;
        drop(bil);
        if !lidar.iter().any(|&v| v > NO_DATA_BELOW) {
            return Ok(None);
        }
        // Le relief ordinaire ne sert qu'aux tuiles incomplètes.
        let complete = lidar.iter().all(|&v| v > NO_DATA_BELOW);
        let base = if complete { None } else { self.fetch_mapterhorn(z, x, y).await.ok() };
        let heights = blend(&lidar, base.as_deref());
        Ok(Some(encode_png(&terrarium(&heights))?))
    }

    async fn fetch_bil(&self, z: u32, x: u32, y: u32) -> Result<Vec<u8>> {
        let [west, south, east, north] = tile_bounds(z, x, y);
        let url = format!("{WMS}&BBOX={west},{south},{east},{north}&WIDTH={SIZE}&HEIGHT={SIZE}");
        let mut response = self.http.get(url).timeout(WMS_TIMEOUT).send().await?.error_for_status()?;
        let expected = SIZE * SIZE * 4;
        let mut bytes = Vec::with_capacity(expected);
        while let Some(chunk) = response.chunk().await? {
            bytes.extend_from_slice(&chunk);
            // Une erreur de l'IGN est un petit document XML : on s'arrête dès que la taille ne peut plus convenir.
            ensure!(bytes.len() <= expected, "réponse de l'IGN trop grosse");
        }
        ensure!(bytes.len() == expected, "réponse de l'IGN inattendue ({} octets)", bytes.len());
        Ok(bytes)
    }

    async fn fetch_mapterhorn(&self, z: u32, x: u32, y: u32) -> Result<Vec<f32>> {
        let response = self.http.get(format!("{MAPTERHORN}/{z}/{x}/{y}.webp")).timeout(Duration::from_secs(15)).send().await?.error_for_status()?;
        let bytes = response.bytes().await?;
        ensure!(bytes.len() < 2 << 20, "tuile Mapterhorn trop grosse");
        let heights = crate::dem::decode(&bytes)?;
        ensure!(heights.len() == SIZE * SIZE, "tuile Mapterhorn de taille inattendue");
        Ok(heights)
    }
}

async fn fresh(path: &Path, ttl: Duration) -> bool {
    tokio::fs::metadata(path).await.and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok()).is_some_and(|age| age < ttl)
}

/// Emprise d'une tuile en mètres Web Mercator : ouest, sud, est, nord.
fn tile_bounds(z: u32, x: u32, y: u32) -> [f64; 4] {
    const HALF_WORLD: f64 = 20_037_508.342_789_244;
    let width = 2.0 * HALF_WORLD / f64::from(1u32 << z);
    let west = -HALF_WORLD + f64::from(x) * width;
    let north = HALF_WORLD - f64::from(y) * width;
    [west, north - width, west + width, north]
}

/// Lit un BIL 32 bits (flottants petit-boutistes, ligne par ligne du nord au sud).
fn parse_bil(bytes: &[u8]) -> Result<Vec<f32>> {
    ensure!(bytes.len() == SIZE * SIZE * 4, "BIL de taille inattendue");
    Ok(bytes.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

/// Altitudes finales : le LiDAR là où il y en a, fondu vers `base` (relief ordinaire, ou 0 en mer) sur `FEATHER` pixels
/// autour des pixels sans donnée.
fn blend(lidar: &[f32], base: Option<&[f32]>) -> Vec<f32> {
    let valid: Vec<bool> = lidar
        .iter()
        .enumerate()
        .map(|(i, &v)| v > NO_DATA_BELOW && base.is_none_or(|b| (v - b[i]).abs() <= MAX_DEVIATION_M))
        .collect();
    if valid.iter().all(|&v| v) {
        return lidar.to_vec();
    }
    let distance = distance_to_invalid(&valid);
    (0..lidar.len())
        .map(|i| {
            let fallback = base.map_or(0.0, |b| b[i]);
            // Un pixel sans donnée ou tout proche : relief ordinaire ; puis fondu linéaire jusqu'au LiDAR pur.
            let weight = ((distance[i] - 1.0) / FEATHER).clamp(0.0, 1.0);
            if weight >= 1.0 { lidar[i] } else if weight <= 0.0 { fallback } else { lidar[i] * weight + fallback * (1.0 - weight) }
        })
        .collect()
}

/// Distance (en pixels, approchée en 8-voisinage pondéré) de chaque pixel au plus proche pixel invalide ; 0 pour un pixel
/// invalide. Deux passes de chanfrein : pas d'allocation autre que le résultat.
fn distance_to_invalid(valid: &[bool]) -> Vec<f32> {
    const FAR: f32 = 1.0e6;
    const DIAGONAL: f32 = std::f32::consts::SQRT_2;
    let mut d: Vec<f32> = valid.iter().map(|&v| if v { FAR } else { 0.0 }).collect();
    let at = |x: usize, y: usize| y * SIZE + x;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let mut best = d[at(x, y)];
            if x > 0 {
                best = best.min(d[at(x - 1, y)] + 1.0);
            }
            if y > 0 {
                best = best.min(d[at(x, y - 1)] + 1.0);
                if x > 0 {
                    best = best.min(d[at(x - 1, y - 1)] + DIAGONAL);
                }
                if x + 1 < SIZE {
                    best = best.min(d[at(x + 1, y - 1)] + DIAGONAL);
                }
            }
            d[at(x, y)] = best;
        }
    }
    for y in (0..SIZE).rev() {
        for x in (0..SIZE).rev() {
            let mut best = d[at(x, y)];
            if x + 1 < SIZE {
                best = best.min(d[at(x + 1, y)] + 1.0);
            }
            if y + 1 < SIZE {
                best = best.min(d[at(x, y + 1)] + 1.0);
                if x + 1 < SIZE {
                    best = best.min(d[at(x + 1, y + 1)] + DIAGONAL);
                }
                if x > 0 {
                    best = best.min(d[at(x - 1, y + 1)] + DIAGONAL);
                }
            }
            d[at(x, y)] = best;
        }
    }
    d
}

/// Altitudes en pixels RGB « terrarium » : altitude + 32 768 = R × 256 + V + B / 256, arrondie au 1/16 m (6 cm). Le bruit
/// du LiDAR est plus grand que cela, et la tuile pèse 90 Ko au lieu de 210 Ko (le bas de B est du pur bruit, qui se compresse mal).
fn terrarium(heights: &[f32]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(heights.len() * 3);
    for &h in heights {
        let v = ((f64::from(h) + 32_768.0) * 16.0).round() / 16.0;
        let v = v.clamp(0.0, 65_535.99);
        let whole = v.floor();
        rgb.extend_from_slice(&[(whole / 256.0) as u8, (whole % 256.0) as u8, ((v - whole) * 256.0) as u8]);
    }
    rgb
}

/// PNG RGB 8 bits, filtre « Sub » sur chaque ligne (l'altitude varie peu d'un pixel au suivant), écrit à la main.
fn encode_png(rgb: &[u8]) -> Result<Vec<u8>> {
    ensure!(rgb.len() == SIZE * SIZE * 3, "image de taille inattendue");
    let row = SIZE * 3;
    let mut raw = Vec::with_capacity((row + 1) * SIZE);
    for line in rgb.chunks_exact(row) {
        raw.push(1);
        for (i, &byte) in line.iter().enumerate() {
            raw.push(byte.wrapping_sub(if i >= 3 { line[i - 3] } else { 0 }));
        }
    }
    let mut zlib = ZlibEncoder::new(Vec::new(), Compression::new(6));
    zlib.write_all(&raw)?;
    let data = zlib.finish()?;

    let mut png = Vec::with_capacity(data.len() + 64);
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&(SIZE as u32).to_be_bytes());
    header.extend_from_slice(&(SIZE as u32).to_be_bytes());
    header.extend_from_slice(&[8, 2, 0, 0, 0]); // 8 bits, RGB, compression, filtre et entrelacement par défaut
    chunk(&mut png, b"IHDR", &header);
    chunk(&mut png, b"IDAT", &data);
    chunk(&mut png, b"IEND", &[]);
    Ok(png)
}

fn chunk(png: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    png.extend_from_slice(&(data.len() as u32).to_be_bytes());
    png.extend_from_slice(kind);
    png.extend_from_slice(data);
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(data);
    png.extend_from_slice(&crc.sum().to_be_bytes());
}

#[cfg(test)]
mod tests;

/// Taille des fichiers d'un dossier et de ses sous-dossiers.
fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    for entry in std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok) {
        let Ok(meta) = entry.metadata() else { continue };
        total += if meta.is_dir() { dir_size(&entry.path()) } else { meta.len() };
    }
    total
}

/// Efface les tuiles expirées et les restes d'écriture, puis les plus anciens fichiers jusqu'à passer sous `target` octets.
/// Rend la taille restante.
fn prune_dir(dir: &Path, target: u64) -> u64 {
    let mut files = Vec::new();
    collect_files(dir, &mut files);
    let now = SystemTime::now();
    let mut kept = Vec::new();
    let mut total = 0u64;
    for (path, modified, size) in files {
        let age = now.duration_since(modified).unwrap_or_default();
        let limit = match path.extension().and_then(|e| e.to_str()) {
            Some("png") => TILE_TTL,
            Some("vide") => EMPTY_TTL,
            _ => Duration::from_secs(3600),
        };
        if age >= limit && std::fs::remove_file(&path).is_ok() {
            continue;
        }
        total += size;
        kept.push((modified, size, path));
    }
    kept.sort();
    for (_, size, path) in kept {
        if total <= target {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= size;
        }
    }
    total
}

fn collect_files(dir: &Path, files: &mut Vec<(PathBuf, SystemTime, u64)>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().filter_map(Result::ok) {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            collect_files(&entry.path(), files);
        } else {
            files.push((entry.path(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()));
        }
    }
}
