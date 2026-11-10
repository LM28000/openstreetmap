//! La fabrication d'une archive de tuiles : dépôt en seaux, zooms bas, zooms hauts (voir `tiles/mod.rs`).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result};
use tracing::{info, warn};

use super::geom::{self, BUFFER, Bounds, EXTENT};
use super::mvt::{self, GeomType, TileFeature, TileLayer, Value};
use super::pmtiles::{self, Header, Writer};
use super::{Cell, Dataset, Feature, FeatureSet, Geometry};
use super::proj::Crs;

/// Réglages de la fabrication.
#[derive(Clone, Debug)]
pub struct Options {
    /// Taille maximale d'une tuile non compressée, en octets (la recommandation de Mapbox est 500 Ko). Au-delà, les
    /// objets de plus faible `weight` sont retirés et un avertissement est journalisé.
    pub max_tile_bytes: usize,
    /// Tolérance de simplification des polygones, en unités de tuile.
    pub tolerance: f64,
    /// Aire minimale d'un polygone (unités² de tuile) : en dessous, il est trop petit pour être vu.
    pub min_area: f64,
}

impl Default for Options {
    fn default() -> Self {
        Options { max_tile_bytes: 500_000, tolerance: 4.0, min_area: 4.0 }
    }
}

/// Ce que la fabrication a produit.
#[derive(Clone, Debug, Default)]
pub struct Report {
    pub features: u64,
    pub tiles: u64,
    pub unique_tiles: u64,
    pub archive_bytes: u64,
    /// Tuiles qui ont dépassé la taille permise (des objets en ont été retirés).
    pub capped_tiles: u64,
    pub bounds: [f64; 4],
    pub seconds: f32,
}

// ---------------------------------------------------------------------------------------------
// Dépôt : sérialisation compacte des objets dans les seaux
// ---------------------------------------------------------------------------------------------

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn get_varint(bytes: &[u8], at: &mut usize) -> u64 {
    let (mut value, mut shift) = (0u64, 0);
    loop {
        let byte = bytes[*at];
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return value;
        }
        shift += 7;
    }
}

fn get<const N: usize>(bytes: &[u8], at: &mut usize) -> [u8; N] {
    let out: [u8; N] = bytes[*at..*at + N].try_into().expect("longueur fixe");
    *at += N;
    out
}

/// Écrit un objet : poids, forme, propriétés.
fn write_feature(out: &mut Vec<u8>, f: &Feature) {
    out.extend_from_slice(&f.weight.to_le_bytes());
    match &f.geom {
        Geometry::Point(p) => {
            out.push(0);
            out.extend_from_slice(&p[0].to_le_bytes());
            out.extend_from_slice(&p[1].to_le_bytes());
        }
        Geometry::Polygon(rings) => {
            out.push(1);
            put_varint(out, rings.len() as u64);
            for ring in rings {
                put_varint(out, ring.len() as u64);
                for p in ring {
                    out.extend_from_slice(&p[0].to_le_bytes());
                    out.extend_from_slice(&p[1].to_le_bytes());
                }
            }
        }
        Geometry::Cell(c) => {
            out.push(2);
            out.push(c.crs.index());
            out.extend_from_slice(&c.e.to_le_bytes());
            out.extend_from_slice(&c.n.to_le_bytes());
            put_varint(out, u64::from(c.size));
        }
    }
    // Les objets de la source n'ont pas forcément les propriétés des tuiles (des comptes, avant `finalize`) : on dit combien.
    put_varint(out, f.props.len() as u64);
    for v in &f.props {
        match v {
            Value::Int(i) => {
                out.push(0);
                put_varint(out, ((i << 1) ^ (i >> 63)) as u64);
            }
            Value::Float(x) => {
                out.push(1);
                out.extend_from_slice(&x.to_le_bytes());
            }
            Value::Str(s) => {
                out.push(2);
                put_varint(out, s.len() as u64);
                out.extend_from_slice(s.as_bytes());
            }
            Value::Bool(b) => out.push(3 + u8::from(*b)),
        }
    }
}

fn read_feature(bytes: &[u8], at: &mut usize) -> Feature {
    let weight = f32::from_le_bytes(get(bytes, at));
    let tag = bytes[*at];
    *at += 1;
    let geom = match tag {
        0 => Geometry::Point([f64::from_le_bytes(get(bytes, at)), f64::from_le_bytes(get(bytes, at))]),
        1 => {
            let rings = get_varint(bytes, at) as usize;
            Geometry::Polygon(
                (0..rings)
                    .map(|_| {
                        let n = get_varint(bytes, at) as usize;
                        (0..n).map(|_| [f64::from_le_bytes(get(bytes, at)), f64::from_le_bytes(get(bytes, at))]).collect()
                    })
                    .collect(),
            )
        }
        _ => {
            let crs = Crs::from_index(bytes[*at]);
            *at += 1;
            let e = i32::from_le_bytes(get(bytes, at));
            let n = i32::from_le_bytes(get(bytes, at));
            let size = get_varint(bytes, at) as u32;
            Geometry::Cell(Cell { crs, e, n, size })
        }
    };
    let keys = get_varint(bytes, at) as usize;
    let props = (0..keys)
        .map(|_| {
            let t = bytes[*at];
            *at += 1;
            match t {
                0 => {
                    let z = get_varint(bytes, at);
                    Value::Int(((z >> 1) as i64) ^ -((z & 1) as i64))
                }
                1 => Value::Float(f32::from_le_bytes(get(bytes, at))),
                2 => {
                    let n = get_varint(bytes, at) as usize;
                    let s = String::from_utf8_lossy(&bytes[*at..*at + n]).into_owned();
                    *at += n;
                    Value::Str(s.into_boxed_str())
                }
                other => Value::Bool(other == 4),
            }
        })
        .collect();
    Feature { geom, props, weight }
}

/// Les seaux : un fichier par tuile du zoom de découpage. Les écritures sont groupées (quelques dizaines de Ko par seau en mémoire).
struct Spool {
    dir: PathBuf,
    zoom: u8,
    buffers: HashMap<(u32, u32), Vec<u8>>,
    bounds: Bounds,
    count: u64,
}

const FLUSH_BYTES: usize = 16 * 1024;

impl Spool {
    fn new(dir: &Path, zoom: u8) -> Result<Spool> {
        fs::create_dir_all(dir)?;
        Ok(Spool { dir: dir.to_path_buf(), zoom, buffers: HashMap::new(), bounds: Bounds::EMPTY, count: 0 })
    }

    fn path(&self, bucket: (u32, u32)) -> PathBuf {
        self.dir.join(format!("{}-{}.seau", bucket.0, bucket.1))
    }

    fn bucket_of(&self, lon: f64, lat: f64) -> (u32, u32) {
        let w = geom::world(lon, lat, self.zoom);
        let last = (1u32 << self.zoom) - 1;
        (((w[0] / f64::from(EXTENT)).floor().max(0.0) as u32).min(last), ((w[1] / f64::from(EXTENT)).floor().max(0.0) as u32).min(last))
    }

    fn add(&mut self, dataset: &dyn Dataset, feature: &Feature) -> Result<()> {
        let anchor = dataset.anchor(feature);
        let primary = self.bucket_of(anchor[0], anchor[1]);
        let influence = dataset.influence(feature);
        self.bounds.union(&feature.bounds());
        // Seaux touchés : de l'angle nord-ouest à l'angle sud-est de la zone d'influence, plus le seau d'ancrage.
        let (a, b) = (self.bucket_of(influence.min[0], influence.max[1]), self.bucket_of(influence.max[0], influence.min[1]));
        let mut record = Vec::with_capacity(64);
        write_feature(&mut record, feature);
        let mut buckets: Vec<(u32, u32)> = (a.0..=b.0).flat_map(|x| (a.1..=b.1).map(move |y| (x, y))).collect();
        if !buckets.contains(&primary) {
            buckets.push(primary);
        }
        for bucket in buckets {
            let buffer = self.buffers.entry(bucket).or_default();
            // Le premier octet dit si ce seau est celui de l'ancre (« propriétaire »).
            buffer.push(u8::from(bucket == primary));
            buffer.extend_from_slice(&record);
            if buffer.len() >= FLUSH_BYTES {
                self.flush(bucket)?;
            }
        }
        self.count += 1;
        Ok(())
    }

    fn flush(&mut self, bucket: (u32, u32)) -> Result<()> {
        let path = self.path(bucket);
        let Some(buffer) = self.buffers.get_mut(&bucket) else { return Ok(()) };
        if buffer.is_empty() {
            return Ok(());
        }
        let mut file = fs::OpenOptions::new().create(true).append(true).open(path)?;
        file.write_all(buffer)?;
        buffer.clear();
        Ok(())
    }

    /// Termine le dépôt et rend la liste des seaux, triée.
    fn close(&mut self) -> Result<Vec<(u32, u32)>> {
        let all: Vec<_> = self.buffers.keys().copied().collect();
        for bucket in all {
            self.flush(bucket)?;
        }
        self.buffers.clear();
        let mut buckets: Vec<(u32, u32)> = Vec::new();
        for entry in fs::read_dir(&self.dir)? {
            let name = entry?.file_name().to_string_lossy().into_owned();
            if let Some((x, y)) = name.strip_suffix(".seau").and_then(|n| n.split_once('-')) {
                if let (Ok(x), Ok(y)) = (x.parse(), y.parse()) {
                    buckets.push((x, y));
                }
            }
        }
        buckets.sort_unstable();
        Ok(buckets)
    }

    /// Les objets d'un seau : `(propriétaire, objet)`.
    fn read(&self, bucket: (u32, u32)) -> Result<Vec<(bool, Feature)>> {
        let bytes = fs::read(self.path(bucket))?;
        let mut at = 0;
        let mut out = Vec::new();
        while at < bytes.len() {
            let primary = bytes[at] == 1;
            at += 1;
            out.push((primary, read_feature(&bytes, &mut at)));
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------------------------
// Tuiles
// ---------------------------------------------------------------------------------------------

/// Compteurs de la fabrication.
#[derive(Default)]
struct Counters {
    tiles: u64,
    capped: u64,
    /// Les premières tuiles trop grosses sont détaillées dans le journal ; les suivantes, résumées à la fin.
    capped_logged: u32,
}

/// Fabrique et écrit les tuiles du zoom `z` pour ces objets. `bucket` : `(zoom, x, y)` d'un seau — seules les tuiles
/// qu'il contient sont écrites (les autres appartiennent à un autre seau, qui les écrira).
#[allow(clippy::too_many_arguments)]
fn emit_tiles(
    dataset: &dyn Dataset,
    z: u8,
    features: &dyn FeatureSet,
    bucket: Option<(u8, u32, u32)>,
    writer: &mut Writer,
    options: &Options,
    counters: &mut Counters,
) -> Result<()> {
    // Positions monde de chaque objet, puis les tuiles qu'il touche.
    let mut worlds: Vec<Vec<Vec<[f64; 2]>>> = Vec::with_capacity(features.len());
    let mut groups: BTreeMap<(u32, u32), Vec<u32>> = BTreeMap::new();
    let inside = |tx: u32, ty: u32| match bucket {
        Some((bz, bx, by)) if z >= bz => tx >> (z - bz) == bx && ty >> (z - bz) == by,
        _ => true,
    };
    for i in 0..features.len() {
        let feature = features.get(i);
        match &feature.geom {
            Geometry::Point(p) => {
                let w = geom::world(p[0], p[1], z);
                worlds.push(Vec::new()); // recalculé à la demande : on ne garde rien par point
                let last = (1u32 << z) - 1;
                let (tx, ty) = (((w[0] / f64::from(EXTENT)).floor().max(0.0) as u32).min(last), ((w[1] / f64::from(EXTENT)).floor().max(0.0) as u32).min(last));
                if inside(tx, ty) {
                    groups.entry((tx, ty)).or_default().push(i as u32);
                }
            }
            _ => {
                let rings = geom::world_rings(&feature.rings(), z);
                let bounds = Bounds::of(rings.iter().flatten().copied());
                let (x0, y0, x1, y1) = geom::tile_range(&bounds, z, BUFFER);
                // Un carreau n'a que quatre coins : les recalculer par tuile coûte moins que de garder des millions de petits `Vec`.
                worlds.push(if matches!(feature.geom, Geometry::Cell(_)) { Vec::new() } else { rings });
                for tx in x0..=x1 {
                    for ty in y0..=y1 {
                        if inside(tx, ty) {
                            groups.entry((tx, ty)).or_default().push(i as u32);
                        }
                    }
                }
            }
        }
    }

    let keys: Vec<String> = dataset.keys().iter().map(|k| (*k).to_string()).collect();
    for ((tx, ty), members) in groups {
        let mut tile_features: Vec<(f32, TileFeature)> = Vec::with_capacity(members.len());
        for &i in &members {
            let feature = features.get(i as usize);
            let (geom_type, geometry) = match &feature.geom {
                Geometry::Point(_) => {
                    let Geometry::Point(p) = &feature.geom else { unreachable!() };
                    let w = geom::world(p[0], p[1], z);
                    let (x, y) = (w[0] - f64::from(tx) * f64::from(EXTENT), w[1] - f64::from(ty) * f64::from(EXTENT));
                    (GeomType::Point, mvt::point_geometry(x.floor() as i32, y.floor() as i32))
                }
                _ => {
                    let lazy;
                    let rings_world = if worlds[i as usize].is_empty() {
                        lazy = geom::world_rings(&feature.rings(), z);
                        &lazy
                    } else {
                        &worlds[i as usize]
                    };
                    match geom::polygon_in_tile(rings_world, tx, ty, options.tolerance, options.min_area) {
                        Some(rings) => (GeomType::Polygon, mvt::polygon_geometry(&rings)),
                        None => continue,
                    }
                }
            };
            tile_features.push((feature.weight, TileFeature { geom_type, geometry, props: feature.props.clone() }));
        }
        if tile_features.is_empty() {
            continue;
        }
        let encode = |list: &[(f32, TileFeature)]| {
            // `encode_tile` veut des `TileLayer` possédant leurs objets : on les déplace le temps de l'encodage.
            let layer = TileLayer {
                name: dataset.layer().to_string(),
                keys: keys.clone(),
                extent: EXTENT,
                features: list.iter().map(|(_, f)| TileFeature { geom_type: f.geom_type, geometry: f.geometry.clone(), props: f.props.clone() }).collect(),
            };
            mvt::encode_tile(&[layer])
        };
        let mut bytes = encode(&tile_features);
        if bytes.len() > options.max_tile_bytes {
            // Tuile trop grosse : on garde les objets les plus importants, en réduisant au prorata jusqu'à tenir.
            let (before, count) = (bytes.len(), tile_features.len());
            tile_features.sort_by(|a, b| b.0.total_cmp(&a.0));
            while bytes.len() > options.max_tile_bytes && tile_features.len() > 1 {
                let keep = (tile_features.len() as f64 * options.max_tile_bytes as f64 / bytes.len() as f64 * 0.9) as usize;
                tile_features.truncate(keep.clamp(1, tile_features.len() - 1));
                bytes = encode(&tile_features);
            }
            counters.capped += 1;
            if counters.capped_logged < 5 {
                counters.capped_logged += 1;
                warn!(
                    jeu = dataset.id(),
                    tuile = %format!("{z}/{tx}/{ty}"),
                    avant_ko = before / 1024,
                    apres_ko = bytes.len() / 1024,
                    objets_retires = count - tile_features.len(),
                    "tuile au plafond de {} Ko : les objets les moins importants sont retirés",
                    options.max_tile_bytes / 1024
                );
            }
        }
        writer.add(pmtiles::tile_id(z, tx, ty), &pmtiles::gzip(&bytes))?;
        counters.tiles += 1;
    }
    Ok(())
}

/// Fabrique l'archive `out` pour `dataset`, à partir de la source rangée dans `source_dir`.
/// `work_dir` reçoit les fichiers temporaires (seaux) ; il est supprimé à la fin.
pub fn build(dataset: &dyn Dataset, source_dir: &Path, work_dir: &Path, out: &Path, options: &Options) -> Result<Report> {
    let started = Instant::now();
    let (min_zoom, max_zoom) = dataset.zooms();
    let spool_zoom = dataset.spool_zoom().clamp(min_zoom.max(1), max_zoom);
    let _ = fs::remove_dir_all(work_dir);

    // 1. Dépôt.
    let mut spool = Spool::new(&work_dir.join("seaux"), spool_zoom)?;
    dataset.scan(source_dir, &mut |feature| spool.add(dataset, &feature))?;
    let buckets = spool.close()?;
    info!(jeu = dataset.id(), objets = spool.count, seaux = buckets.len(), secondes = started.elapsed().as_secs_f32(), "tuiles : dépôt terminé");

    let mut writer = Writer::create(&work_dir.join("tuiles.tmp"))?;
    let mut counters = Counters::default();

    // 2. Zooms bas : un passage sur tous les seaux par zoom, les objets agrégés au fil de l'eau.
    for z in min_zoom..spool_zoom {
        let mut generalizer = dataset.generalizer(z);
        for &bucket in &buckets {
            for (primary, feature) in spool.read(bucket)? {
                if primary {
                    generalizer.push(&feature);
                }
            }
        }
        let features = generalizer.finish();
        let before = counters.tiles;
        emit_tiles(dataset, z, features.as_ref(), None, &mut writer, options, &mut counters)?;
        info!(jeu = dataset.id(), zoom = z, objets = features.len(), tuiles = counters.tiles - before, "tuiles : zoom bas fait");
    }

    // 3. Zooms hauts : seau par seau.
    for &bucket in &buckets {
        let loaded = spool.read(bucket)?;
        for z in spool_zoom..=max_zoom {
            let mut generalizer = dataset.generalizer(z);
            for (_, feature) in &loaded {
                generalizer.push(feature);
            }
            let features = generalizer.finish();
            emit_tiles(dataset, z, features.as_ref(), Some((spool_zoom, bucket.0, bucket.1)), &mut writer, options, &mut counters)?;
        }
    }
    info!(jeu = dataset.id(), tuiles = counters.tiles, secondes = started.elapsed().as_secs_f32(), "tuiles : zooms hauts faits");

    // 4. Archive.
    let b = spool.bounds;
    let bounds = if b.is_empty() { [0.0; 4] } else { [b.min[0], b.min[1], b.max[0], b.max[1]] };
    let header = Header {
        min_zoom,
        max_zoom,
        bounds,
        center_zoom: min_zoom + (max_zoom - min_zoom) / 2,
        center: [(bounds[0] + bounds[2]) / 2.0, (bounds[1] + bounds[3]) / 2.0],
        ..Header::default()
    };
    let fields: serde_json::Map<String, serde_json::Value> =
        dataset.keys().iter().map(|k| ((*k).to_string(), serde_json::json!("Number"))).collect();
    let metadata = serde_json::json!({
        "name": dataset.id(),
        "format": "pbf",
        "minzoom": min_zoom,
        "maxzoom": max_zoom,
        "attribution": dataset.attribution(),
        "vector_layers": [{ "id": dataset.layer(), "fields": fields, "minzoom": min_zoom, "maxzoom": max_zoom }],
        "carte_vivante": dataset.metadata(),
    });
    let stats = writer.finish(out, header, &metadata).context("écriture de l'archive")?;
    let _ = fs::remove_dir_all(work_dir);
    if counters.capped > 0 {
        warn!(jeu = dataset.id(), tuiles = counters.capped, "tuiles : {} tuile(s) ont atteint le plafond de taille", counters.capped);
    }
    Ok(Report {
        features: spool.count,
        tiles: stats.addressed_tiles,
        unique_tiles: stats.unique_tiles,
        archive_bytes: stats.file_bytes,
        capped_tiles: counters.capped,
        bounds,
        seconds: started.elapsed().as_secs_f32(),
    })
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;

    use prost::Message;

    use super::super::mvt::tests::{PTile, PValue};
    use super::super::pmtiles::{Reader, gunzip};
    use super::super::{Finalize, GridAggregator, Generalizer, PassThrough};
    use super::*;

    /// Jeu de données de test : une grille de carreaux autour de Paris, un grand polygone et des points.
    struct Demo {
        cells: i32,
    }

    impl Dataset for Demo {
        fn id(&self) -> &'static str {
            "demo"
        }
        fn layer(&self) -> &'static str {
            "demo"
        }
        fn keys(&self) -> &'static [&'static str] {
            &["pop", "men"]
        }
        fn zooms(&self) -> (u8, u8) {
            (4, 10)
        }
        fn schema_version(&self) -> u32 {
            1
        }
        fn source_id(&self) -> String {
            "demo".into()
        }
        fn attribution(&self) -> &'static str {
            "test"
        }
        fn license(&self) -> &'static str {
            "test"
        }
        fn spool_zoom(&self) -> u8 {
            7
        }
        fn acquire<'a>(&'a self, _: &'a reqwest::Client, _: &'a Path) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async { Ok(()) })
        }
        fn scan(&self, _: &Path, emit: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
            for i in 0..self.cells {
                for j in 0..self.cells {
                    let cell = Cell { crs: Crs::Laea, e: 3_755_000 + i * 200, n: 2_885_000 + j * 200, size: 200 };
                    emit(Feature { geom: Geometry::Cell(cell), props: vec![Value::Float(10.0), Value::Float(5.0)], weight: 10.0 })?;
                }
            }
            Ok(())
        }
        fn generalizer(&self, zoom: u8) -> Box<dyn Generalizer> {
            let size = match zoom {
                ..=5 => 16_000,
                6..=7 => 4_000,
                8..=9 => 1_000,
                _ => 200,
            };
            let finalize: Finalize = Box::new(|sums, _| (vec![Value::Float(sums[0]), Value::Float(sums[1])], sums[0]));
            Box::new(GridAggregator::new(size, finalize))
        }
        fn anchor(&self, f: &Feature) -> [f64; 2] {
            let Geometry::Cell(cell) = &f.geom else { unreachable!() };
            let block = cell.block(16_000);
            let c = Crs::Laea.to_lonlat(f64::from(block.e) + 8000.0, f64::from(block.n) + 8000.0);
            [c.0, c.1]
        }
        fn influence(&self, f: &Feature) -> Bounds {
            let Geometry::Cell(cell) = &f.geom else { unreachable!() };
            Feature { geom: Geometry::Cell(cell.block(16_000)), props: vec![], weight: 0.0 }.bounds()
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("carte-vivante-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Les objets d'une tuile : `(poids, premier anneau)` décodés.
    fn read_tile(reader: &Reader, z: u8, x: u32, y: u32) -> Vec<(f32, Vec<[i32; 2]>)> {
        let Some(gz) = reader.tile(z, x, y).unwrap() else { return Vec::new() };
        let tile = PTile::decode(gunzip(&gz).unwrap().as_slice()).unwrap();
        let layer = &tile.layers[0];
        layer
            .features
            .iter()
            .map(|f| {
                // La première propriété (`pop`) : sa valeur est à l'indice donné par les tags.
                let value: &PValue = &layer.values[f.tags[1] as usize];
                (value.float_value.unwrap(), mvt::decode_geometry(&f.geometry).remove(0))
            })
            .collect()
    }

    #[test]
    fn fabrication_complete_et_relecture() {
        let dir = temp("builder");
        let demo = Demo { cells: 60 }; // 12 km × 12 km, soit 3 600 carreaux de 10 habitants
        let out = dir.join("demo.pmtiles");
        let report = build(&demo, &dir, &dir.join("travail"), &out, &Options::default()).unwrap();
        assert_eq!(report.features, 3600);
        assert!(!dir.join("travail").exists(), "les fichiers temporaires sont effacés");
        assert_eq!(report.capped_tiles, 0);

        let reader = Reader::open(&out).unwrap();
        assert_eq!((reader.header().min_zoom, reader.header().max_zoom), (4, 10));
        assert!(reader.header().bounds[0] < 2.4 && reader.header().bounds[2] > 2.3);
        let metadata = reader.metadata().unwrap();
        assert_eq!(metadata["vector_layers"][0]["id"], "demo");

        // Zoom 4 : la tuile unique qui contient Paris a un seul gros carreau de 16 km par morceau ; la somme des
        // habitants est conservée (36 000), à ceci près qu'un gros carreau à cheval sur deux tuiles est répété.
        let w = geom::world(2.35, 48.85, 4);
        let (tx, ty) = ((w[0] / 4096.0) as u32, (w[1] / 4096.0) as u32);
        let low = read_tile(&reader, 4, tx, ty);
        let total: f32 = low.iter().map(|(pop, _)| pop).sum();
        assert_eq!(total, 36_000.0, "somme conservée au zoom 4");
        // Zoom 10 : les 3 600 carreaux d'origine, chacun avec ses 10 habitants (tuiles voisines comprises).
        let w10 = geom::world(2.35, 48.85, 10);
        let (cx, cy) = ((w10[0] / 4096.0) as u32, (w10[1] / 4096.0) as u32);
        let mut seen = 0;
        for x in cx - 3..=cx + 3 {
            for y in cy - 3..=cy + 3 {
                for (pop, ring) in read_tile(&reader, 10, x, y) {
                    assert_eq!(pop, 10.0);
                    // Un carré (4 sommets) ; une tuile qui n'en voit que le coin garde un triangle ou un pentagone.
                    assert!((3..=5).contains(&ring.len()), "{ring:?}");
                    // Un carreau de 200 m fait à ce zoom (tuile 4096 unités ≈ 38 km à 48°N) une vingtaine d'unités.
                    let width = ring.iter().map(|p| p[0]).max().unwrap() - ring.iter().map(|p| p[0]).min().unwrap();
                    assert!(width <= 40, "{width}");
                    seen += 1;
                }
            }
        }
        assert!(seen >= 3600, "{seen} carreaux vus au zoom 10");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plafond_de_taille_des_tuiles() {
        let dir = temp("plafond");
        let demo = Demo { cells: 60 };
        let out = dir.join("demo.pmtiles");
        // Plafond minuscule : toutes les tuiles du zoom 10 (des centaines de carreaux) le dépassent.
        let options = Options { max_tile_bytes: 600, ..Options::default() };
        let report = build(&demo, &dir, &dir.join("travail"), &out, &options).unwrap();
        assert!(report.capped_tiles > 0);
        let reader = Reader::open(&out).unwrap();
        let w10 = geom::world(2.35, 48.85, 10);
        let (cx, cy) = ((w10[0] / 4096.0) as u32, (w10[1] / 4096.0) as u32);
        let tile = reader.tile(10, cx, cy).unwrap().expect("tuile");
        assert!(gunzip(&tile).unwrap().len() <= 600 + 200, "tuile ramenée au plafond");
        fs::remove_dir_all(&dir).ok();
    }

    /// Jeu de polygones : un grand rectangle qui couvre plusieurs tuiles.
    struct Polygons;

    impl Dataset for Polygons {
        fn id(&self) -> &'static str {
            "poly"
        }
        fn layer(&self) -> &'static str {
            "poly"
        }
        fn keys(&self) -> &'static [&'static str] {
            &["id"]
        }
        fn zooms(&self) -> (u8, u8) {
            (3, 7)
        }
        fn schema_version(&self) -> u32 {
            1
        }
        fn source_id(&self) -> String {
            "poly".into()
        }
        fn attribution(&self) -> &'static str {
            ""
        }
        fn license(&self) -> &'static str {
            ""
        }
        fn spool_zoom(&self) -> u8 {
            5
        }
        fn acquire<'a>(&'a self, _: &'a reqwest::Client, _: &'a Path) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
            Box::pin(async { Ok(()) })
        }
        fn scan(&self, _: &Path, emit: &mut dyn FnMut(Feature) -> Result<()>) -> Result<()> {
            // Un rectangle de 10° × 4° (un peu plus que l'Europe de l'Ouest) avec un trou, et un minuscule.
            let outer = vec![[-5.0, 42.0], [5.0, 42.0], [5.0, 46.0], [-5.0, 46.0]];
            let hole = vec![[-1.0, 43.0], [1.0, 43.0], [1.0, 45.0], [-1.0, 45.0]];
            emit(Feature { geom: Geometry::Polygon(vec![outer, hole]), props: vec![Value::Int(1)], weight: 1.0 })?;
            let tiny = vec![[2.0, 44.0], [2.00001, 44.0], [2.00001, 44.00001]];
            emit(Feature { geom: Geometry::Polygon(vec![tiny]), props: vec![Value::Int(2)], weight: 1.0 })
        }
        fn generalizer(&self, _: u8) -> Box<dyn Generalizer> {
            Box::new(PassThrough::default())
        }
    }

    #[test]
    fn polygone_decoupe_aux_tuiles_et_minuscule_ecarte() {
        let dir = temp("poly");
        let out = dir.join("poly.pmtiles");
        build(&Polygons, &dir, &dir.join("travail"), &out, &Options::default()).unwrap();
        let reader = Reader::open(&out).unwrap();
        // Zoom 7 : le rectangle (≈ 10° de large) couvre plusieurs tuiles ; dans chacune, ses sommets restent dans la tuile + marge.
        let mut tiles_with_polygon = 0;
        for x in 60..70 {
            for y in 40..50 {
                let Some(gz) = reader.tile(7, x, y).unwrap() else { continue };
                tiles_with_polygon += 1;
                let tile = PTile::decode(gunzip(&gz).unwrap().as_slice()).unwrap();
                for f in &tile.layers[0].features {
                    for ring in mvt::decode_geometry(&f.geometry) {
                        for p in ring {
                            assert!((-65..=4161).contains(&p[0]) && (-65..=4161).contains(&p[1]), "{p:?} hors tuile + marge");
                        }
                    }
                    // Le minuscule polygone (1 m) est écarté : seul le grand reste.
                    assert_eq!(tile.layers[0].values[f.tags[1] as usize].sint_value, Some(1));
                }
            }
        }
        assert!(tiles_with_polygon >= 6, "{tiles_with_polygon}");
        // Zoom 3 : le grand polygone tient dans une ou deux tuiles et est très simplifié (4 sommets + trou de 4).
        fs::remove_dir_all(&dir).ok();
    }
}
