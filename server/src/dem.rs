//! Altitudes du relief, lues dans les mêmes tuiles que la carte (Mapterhorn), pour
//! poser les trains à la hauteur du sol affiché.
//!
//! Chaque tuile est une image de 512 × 512 pixels où la couleur code l'altitude
//! (encodage « terrarium » : altitude = R × 256 + V + B / 256 − 32 768 mètres).

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::task::JoinSet;
use tracing::info;

/// Zoom 11 : un pixel fait environ 26 m en France, assez pour des voies ferrées.
pub const ZOOM: u32 = 11;
const SIZE: usize = 512;
const TILE_URL: &str = "https://tiles.mapterhorn.com";
/// Téléchargements simultanés : le service est gratuit, on reste raisonnable.
const PARALLEL: usize = 4;

pub type TileId = (u32, u32);

/// Tuile contenant un point, et position du point dans la tuile (en pixels).
pub fn locate(lon: f64, lat: f64) -> (TileId, f64, f64) {
    let n = f64::from(1u32 << ZOOM);
    let x = (lon + 180.0) / 360.0 * n;
    let lat_rad = lat.to_radians();
    let y = (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n;
    let (tx, ty) = (x.floor(), y.floor());
    ((tx as u32, ty as u32), (x - tx) * SIZE as f64, (y - ty) * SIZE as f64)
}

pub struct Tile {
    heights: Vec<f32>,
}

impl Tile {
    /// Altitude au point (px, py), par interpolation entre les 4 pixels voisins.
    pub fn sample(&self, px: f64, py: f64) -> f32 {
        let max = (SIZE - 1) as f64;
        let (x, y) = ((px - 0.5).clamp(0.0, max), (py - 0.5).clamp(0.0, max));
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1) = ((x0 + 1).min(SIZE - 1), (y0 + 1).min(SIZE - 1));
        let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
        let h = |x: usize, y: usize| self.heights[y * SIZE + x];
        let top = h(x0, y0) * (1.0 - fx) + h(x1, y0) * fx;
        let bottom = h(x0, y1) * (1.0 - fx) + h(x1, y1) * fx;
        top * (1.0 - fy) + bottom * fy
    }
}

fn tile_path(dir: &Path, (x, y): TileId) -> PathBuf {
    dir.join(format!("{ZOOM}/{x}/{y}.webp"))
}

/// Télécharge les tuiles manquantes. Une tuile absente du service (en mer) est
/// gardée comme fichier vide : altitude 0, et on ne la redemande pas.
pub async fn ensure_tiles(http: &reqwest::Client, dir: &Path, tiles: &HashSet<TileId>) -> Result<()> {
    let missing: Vec<TileId> = tiles.iter().copied().filter(|&t| !tile_path(dir, t).exists()).collect();
    if missing.is_empty() {
        return Ok(());
    }
    info!(tuiles = missing.len(), "téléchargement des altitudes…");
    let mut queue = missing.into_iter();
    let mut running = JoinSet::new();
    loop {
        while running.len() < PARALLEL {
            let Some(tile) = queue.next() else { break };
            let (http, path) = (http.clone(), tile_path(dir, tile));
            running.spawn(async move { download(&http, tile, &path).await });
        }
        match running.join_next().await {
            Some(result) => result??,
            None => return Ok(()),
        }
    }
}

async fn download(http: &reqwest::Client, (x, y): TileId, path: &Path) -> Result<()> {
    let response = http.get(format!("{TILE_URL}/{ZOOM}/{x}/{y}.webp")).send().await?;
    let bytes = if response.status() == reqwest::StatusCode::NOT_FOUND {
        Vec::new()
    } else {
        response.error_for_status()?.bytes().await?.to_vec()
    };
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(path, bytes).await?;
    Ok(())
}

/// Décode une tuile. `None` si elle est vide (pas de données : en mer).
pub fn load(dir: &Path, tile: TileId) -> Result<Option<Tile>> {
    let path = tile_path(dir, tile);
    let bytes = std::fs::read(&path).with_context(|| format!("lecture de {}", path.display()))?;
    if bytes.is_empty() {
        return Ok(None);
    }
    Ok(Some(Tile { heights: decode(&bytes)? }))
}

/// Altitudes (mètres, ligne par ligne) d'une tuile WebP « terrarium » de 512 × 512 pixels.
pub fn decode(bytes: &[u8]) -> Result<Vec<f32>> {
    let mut decoder = image_webp::WebPDecoder::new(Cursor::new(bytes))?;
    let (width, height) = decoder.dimensions();
    anyhow::ensure!(width as usize == SIZE && height as usize == SIZE, "tuile d'altitude de taille inattendue");
    let channels = if decoder.has_alpha() { 4 } else { 3 };
    let mut pixels = vec![0; decoder.output_buffer_size().context("taille de tuile inconnue")?];
    decoder.read_image(&mut pixels)?;
    Ok(pixels
        .chunks_exact(channels)
        .map(|p| f32::from(p[0]) * 256.0 + f32::from(p[1]) + f32::from(p[2]) / 256.0 - 32_768.0)
        .collect())
}

/// Altitude de nombreux points d'un coup : chaque tuile n'est décodée qu'une fois.
pub async fn heights(http: &reqwest::Client, dir: &Path, points: &[(f64, f64)]) -> Result<Vec<f32>> {
    let located: Vec<_> = points.iter().map(|&(lon, lat)| locate(lon, lat)).collect();
    let tiles: HashSet<TileId> = located.iter().map(|l| l.0).collect();
    ensure_tiles(http, dir, &tiles).await?;

    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<Vec<f32>> {
        let mut by_tile: HashMap<TileId, Vec<usize>> = HashMap::new();
        for (i, (tile, ..)) in located.iter().enumerate() {
            by_tile.entry(*tile).or_default().push(i);
        }
        let mut result = vec![0.0; located.len()];
        for (tile, indices) in by_tile {
            let Some(data) = load(&dir, tile)? else { continue };
            for i in indices {
                let (_, px, py) = located[i];
                result[i] = data.sample(px, py);
            }
        }
        Ok(result)
    })
    .await?
}
