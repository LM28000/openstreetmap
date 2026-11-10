//! Archive PMTiles v3 : toutes les tuiles d'une carte dans un seul fichier, lisible sans serveur de tuiles.
//!
//! Spécification : <https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md>. Le fichier est :
//!
//! ```text
//! [ en-tête 127 octets ][ répertoire racine ][ métadonnées JSON ][ répertoires feuilles ][ données des tuiles ]
//! ```
//!
//! # Identifiant de tuile : la courbe de Hilbert
//!
//! Une tuile `(z, x, y)` est numérotée par un seul entier : d'abord toutes les tuiles du zoom 0, puis celles du
//! zoom 1, etc. ; à l'intérieur d'un zoom, dans l'ordre de la **courbe de Hilbert**, qui parcourt le plan sans
//! jamais faire de grand saut. Deux tuiles voisines ont des numéros proches : une lecture de plusieurs tuiles
//! voisines est donc presque contiguë dans le fichier, et les répertoires (triés par numéro) se compressent bien.
//!
//! # Répertoires
//!
//! Un répertoire est une liste triée d'entrées `(tile_id, offset, length, run_length)` : « les `run_length`
//! tuiles à partir de `tile_id` sont les mêmes octets, situés à `offset` ». Un `run_length` de 0 désigne un
//! *répertoire feuille* (même forme, rangé ailleurs) : quand il y a trop de tuiles pour tenir dans les ~16 Ko
//! qu'une première lecture ramène, la racine ne contient que des renvois vers des feuilles.
//! La sérialisation range les colonnes l'une après l'autre (tous les numéros, puis toutes les durées de
//! répétition…) et les numéros en différences : gzippé, c'est très compact.
//!
//! # Déduplication
//!
//! Des tuiles identiques (la mer, une zone sans donnée…) ne sont stockées qu'une fois : plusieurs entrées
//! pointent le même `offset`, et des numéros consécutifs qui partagent la même tuile se replient en une
//! seule entrée à `run_length > 1`.
//!
//! Ici : le `Writer` (écriture en plusieurs passes, dans le désordre, puis mise en ordre `clustered`) et le
//! `Reader` (celui qui sert les tuiles au site).

use std::collections::HashMap;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{BufWriter, Read, Write};
use std::os::unix::fs::FileExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;

const HEADER_LEN: usize = 127;
/// L'en-tête et le répertoire racine doivent tenir dans les 16 384 premiers octets (une seule lecture).
const ROOT_BUDGET: usize = 16_384 - HEADER_LEN;

// ---------------------------------------------------------------------------------------------
// Identifiants de tuiles
// ---------------------------------------------------------------------------------------------

/// Rotation de la courbe de Hilbert (reflet et échange des axes selon le quadrant).
fn rotate(n: u64, x: &mut u64, y: &mut u64, rx: u64, ry: u64) {
    if ry == 0 {
        if rx == 1 {
            *x = n.wrapping_sub(1).wrapping_sub(*x);
            *y = n.wrapping_sub(1).wrapping_sub(*y);
        }
        std::mem::swap(x, y);
    }
}

/// Numéro de la tuile `(z, x, y)` : nombre de tuiles des zooms inférieurs, plus sa position sur la courbe de Hilbert.
pub fn tile_id(z: u8, x: u32, y: u32) -> u64 {
    let acc: u64 = (0..z).map(|t| 1u64 << (2 * t)).sum();
    let (mut x, mut y) = (u64::from(x), u64::from(y));
    let n = 1u64 << z;
    let mut d = 0u64;
    let mut s = n / 2;
    while s > 0 {
        let rx = u64::from(x & s > 0);
        let ry = u64::from(y & s > 0);
        d += s * s * ((3 * rx) ^ ry);
        rotate(s, &mut x, &mut y, rx, ry);
        s /= 2;
    }
    acc + d
}

/// L'inverse : numéro → `(z, x, y)`.
pub fn tile_zxy(id: u64) -> (u8, u32, u32) {
    let mut acc = 0u64;
    for z in 0..32u8 {
        let count = 1u64 << (2 * z);
        if acc + count > id {
            let n = 1u64 << z;
            let mut t = id - acc;
            let (mut x, mut y) = (0u64, 0u64);
            let mut s = 1u64;
            while s < n {
                let rx = 1 & (t / 2);
                let ry = 1 & (t ^ rx);
                rotate(s, &mut x, &mut y, rx, ry);
                x += s * rx;
                y += s * ry;
                t /= 4;
                s *= 2;
            }
            return (z, x as u32, y as u32);
        }
        acc += count;
    }
    (0, 0, 0)
}

// ---------------------------------------------------------------------------------------------
// Répertoires
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Entry {
    pub tile_id: u64,
    pub offset: u64,
    pub length: u32,
    /// Nombre de tuiles consécutives qui partagent ce contenu ; 0 : l'entrée désigne un répertoire feuille.
    pub run_length: u32,
}

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn get_varint(bytes: &[u8], at: &mut usize) -> Result<u64> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes.get(*at).context("répertoire PMTiles tronqué")?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
    }
    bail!("varint trop long")
}

/// Sérialise un répertoire (non compressé).
pub fn serialize_directory(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    put_varint(&mut out, entries.len() as u64);
    let mut last = 0;
    for e in entries {
        put_varint(&mut out, e.tile_id - last);
        last = e.tile_id;
    }
    for e in entries {
        put_varint(&mut out, u64::from(e.run_length));
    }
    for e in entries {
        put_varint(&mut out, u64::from(e.length));
    }
    for (i, e) in entries.iter().enumerate() {
        // 0 = « juste après l'entrée précédente » (le cas courant quand les tuiles sont rangées dans l'ordre) ;
        // sinon l'offset plus un.
        if i > 0 && e.offset == entries[i - 1].offset + u64::from(entries[i - 1].length) {
            put_varint(&mut out, 0);
        } else {
            put_varint(&mut out, e.offset + 1);
        }
    }
    out
}

pub fn parse_directory(bytes: &[u8]) -> Result<Vec<Entry>> {
    let mut at = 0;
    let count = get_varint(bytes, &mut at)? as usize;
    if count > bytes.len() {
        bail!("répertoire PMTiles incohérent");
    }
    let mut entries = vec![Entry { tile_id: 0, offset: 0, length: 0, run_length: 0 }; count];
    let mut last = 0;
    for e in &mut entries {
        last += get_varint(bytes, &mut at)?;
        e.tile_id = last;
    }
    for e in &mut entries {
        e.run_length = get_varint(bytes, &mut at)? as u32;
    }
    for e in &mut entries {
        e.length = get_varint(bytes, &mut at)? as u32;
    }
    for i in 0..count {
        let v = get_varint(bytes, &mut at)?;
        entries[i].offset = if v == 0 && i > 0 { entries[i - 1].offset + u64::from(entries[i - 1].length) } else { v.saturating_sub(1) };
    }
    Ok(entries)
}

pub fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::with_capacity(bytes.len() / 3 + 32), Compression::best());
    encoder.write_all(bytes).expect("écriture en mémoire");
    encoder.finish().expect("écriture en mémoire")
}

pub fn gunzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    GzDecoder::new(bytes).read_to_end(&mut out).context("gzip invalide")?;
    Ok(out)
}

/// Répartit les entrées en répertoire racine et feuilles : tout dans la racine si elle tient dans le budget,
/// sinon des feuilles de plus en plus grosses jusqu'à ce que la racine (qui ne contient que des renvois) tienne.
/// Renvoie `(racine compressée, feuilles compressées mises bout à bout)`.
fn optimize_directories(entries: &[Entry]) -> (Vec<u8>, Vec<u8>) {
    let whole = gzip(&serialize_directory(entries));
    if whole.len() <= ROOT_BUDGET {
        return (whole, Vec::new());
    }
    let mut leaf_size = (entries.len() / 3500).max(4096);
    loop {
        let mut root: Vec<Entry> = Vec::new();
        let mut leaves = Vec::new();
        for chunk in entries.chunks(leaf_size) {
            let bytes = gzip(&serialize_directory(chunk));
            root.push(Entry { tile_id: chunk[0].tile_id, offset: leaves.len() as u64, length: bytes.len() as u32, run_length: 0 });
            leaves.extend_from_slice(&bytes);
        }
        let root_bytes = gzip(&serialize_directory(&root));
        if root_bytes.len() <= ROOT_BUDGET {
            return (root_bytes, leaves);
        }
        leaf_size = leaf_size * 6 / 5;
    }
}

// ---------------------------------------------------------------------------------------------
// En-tête
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct Header {
    pub root_offset: u64,
    pub root_length: u64,
    pub metadata_offset: u64,
    pub metadata_length: u64,
    pub leaves_offset: u64,
    pub leaves_length: u64,
    pub data_offset: u64,
    pub data_length: u64,
    pub addressed_tiles: u64,
    pub tile_entries: u64,
    pub tile_contents: u64,
    pub min_zoom: u8,
    pub max_zoom: u8,
    /// Emprise en degrés : ouest, sud, est, nord.
    pub bounds: [f64; 4],
    pub center_zoom: u8,
    pub center: [f64; 2],
}

impl Header {
    fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut b = [0u8; HEADER_LEN];
        b[..7].copy_from_slice(b"PMTiles");
        b[7] = 3;
        let u64s = [
            self.root_offset,
            self.root_length,
            self.metadata_offset,
            self.metadata_length,
            self.leaves_offset,
            self.leaves_length,
            self.data_offset,
            self.data_length,
            self.addressed_tiles,
            self.tile_entries,
            self.tile_contents,
        ];
        for (i, v) in u64s.iter().enumerate() {
            b[8 + i * 8..16 + i * 8].copy_from_slice(&v.to_le_bytes());
        }
        b[96] = 1; // clustered : les tuiles sont rangées dans l'ordre de leur numéro
        b[97] = 2; // compression des répertoires et des métadonnées : gzip
        b[98] = 2; // compression des tuiles : gzip
        b[99] = 1; // type de tuile : MVT
        b[100] = self.min_zoom;
        b[101] = self.max_zoom;
        let e7 = |v: f64| ((v * 1e7).round() as i32).to_le_bytes();
        b[102..106].copy_from_slice(&e7(self.bounds[0]));
        b[106..110].copy_from_slice(&e7(self.bounds[1]));
        b[110..114].copy_from_slice(&e7(self.bounds[2]));
        b[114..118].copy_from_slice(&e7(self.bounds[3]));
        b[118] = self.center_zoom;
        b[119..123].copy_from_slice(&e7(self.center[0]));
        b[123..127].copy_from_slice(&e7(self.center[1]));
        b
    }

    fn from_bytes(b: &[u8]) -> Result<Header> {
        if b.len() < HEADER_LEN || &b[..7] != b"PMTiles" {
            bail!("ce n'est pas une archive PMTiles");
        }
        if b[7] != 3 {
            bail!("PMTiles version {} non gérée (seule la 3 l'est)", b[7]);
        }
        let u = |i: usize| u64::from_le_bytes(b[8 + i * 8..16 + i * 8].try_into().expect("8 octets"));
        let e7 = |at: usize| f64::from(i32::from_le_bytes(b[at..at + 4].try_into().expect("4 octets"))) / 1e7;
        if b[97] != 2 || b[98] != 2 || b[99] != 1 {
            bail!("seules les archives MVT en gzip sont gérées");
        }
        Ok(Header {
            root_offset: u(0),
            root_length: u(1),
            metadata_offset: u(2),
            metadata_length: u(3),
            leaves_offset: u(4),
            leaves_length: u(5),
            data_offset: u(6),
            data_length: u(7),
            addressed_tiles: u(8),
            tile_entries: u(9),
            tile_contents: u(10),
            min_zoom: b[100],
            max_zoom: b[101],
            bounds: [e7(102), e7(106), e7(110), e7(114)],
            center_zoom: b[118],
            center: [e7(119), e7(123)],
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------------------------

/// Chiffres de l'archive écrite.
#[derive(Debug, Clone, Default)]
pub struct WriteStats {
    pub addressed_tiles: u64,
    pub unique_tiles: u64,
    pub file_bytes: u64,
    pub tile_bytes: u64,
}

/// Écrit une archive. Les tuiles arrivent dans n'importe quel ordre (`add`, par zoom ou par zone) et sont
/// rangées dans un fichier temporaire ; `finish` les remet dans l'ordre de leur numéro pour produire l'archive finale.
pub struct Writer {
    temp: BufWriter<File>,
    temp_path: PathBuf,
    written: u64,
    /// Empreinte du contenu → (offset dans le fichier temporaire, longueur).
    seen: HashMap<u128, (u64, u32)>,
    /// (numéro de tuile, offset temporaire, longueur).
    entries: Vec<(u64, u64, u32)>,
}

/// Empreinte de 128 bits d'une tuile, par deux passes de SipHash graînées différemment : assez large pour que
/// deux tuiles différentes ne se confondent jamais en pratique (la longueur est de plus comparée).
fn fingerprint(bytes: &[u8]) -> u128 {
    let mut a = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut a);
    let mut b = std::collections::hash_map::DefaultHasher::new();
    0x9e37_79b9_u32.hash(&mut b);
    bytes.len().hash(&mut b);
    bytes.hash(&mut b);
    u128::from(a.finish()) << 64 | u128::from(b.finish())
}

impl Writer {
    pub fn create(temp_path: &Path) -> Result<Writer> {
        let file = File::create(temp_path).with_context(|| format!("création de {}", temp_path.display()))?;
        Ok(Writer { temp: BufWriter::new(file), temp_path: temp_path.to_path_buf(), written: 0, seen: HashMap::new(), entries: Vec::new() })
    }

    /// Ajoute une tuile (déjà compressée en gzip). Un contenu déjà vu n'est pas réécrit.
    pub fn add(&mut self, id: u64, compressed: &[u8]) -> Result<()> {
        let key = fingerprint(compressed);
        let (offset, length) = match self.seen.get(&key) {
            Some(&(offset, length)) if length as usize == compressed.len() => (offset, length),
            _ => {
                let at = self.written;
                self.temp.write_all(compressed)?;
                self.written += compressed.len() as u64;
                self.seen.insert(key, (at, compressed.len() as u32));
                (at, compressed.len() as u32)
            }
        };
        self.entries.push((id, offset, length));
        Ok(())
    }

    /// Nombre de tuiles ajoutées jusqu'ici.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Écrit l'archive `out` (via un fichier voisin renommé à la fin : on ne voit jamais d'archive à moitié écrite).
    pub fn finish(mut self, out: &Path, mut header: Header, metadata: &serde_json::Value) -> Result<WriteStats> {
        self.temp.flush()?;
        let source = File::open(&self.temp_path)?;
        self.entries.sort_unstable_by_key(|e| e.0);
        if self.entries.windows(2).any(|w| w[0].0 == w[1].0) {
            bail!("deux tuiles portent le même numéro");
        }

        // Mise en ordre : chaque contenu est copié à sa première apparition dans l'ordre des numéros. Le début du
        // fichier (en-tête, répertoires) n'est connu qu'à la fin : les données vont d'abord dans un fichier à part.
        let partial = out.with_extension("pmtiles.partiel");
        let data_path = out.with_extension("pmtiles.donnees");
        let mut data = BufWriter::new(File::create(&data_path)?);
        let mut moved: HashMap<u64, u64> = HashMap::new(); // offset temporaire → offset final
        let mut final_len = 0u64;
        let mut directory: Vec<Entry> = Vec::new();
        let mut buffer = Vec::new();
        for &(id, old, length) in &self.entries {
            let offset = match moved.get(&old) {
                Some(&o) => o,
                None => {
                    buffer.resize(length as usize, 0);
                    source.read_exact_at(&mut buffer, old)?;
                    data.write_all(&buffer)?;
                    moved.insert(old, final_len);
                    final_len += u64::from(length);
                    final_len - u64::from(length)
                }
            };
            // Repli : le même contenu pour le numéro qui suit directement → une seule entrée plus longue.
            match directory.last_mut() {
                Some(last) if last.offset == offset && last.length == length && last.tile_id + u64::from(last.run_length) == id => {
                    last.run_length += 1;
                }
                _ => directory.push(Entry { tile_id: id, offset, length, run_length: 1 }),
            }
        }
        data.flush()?;
        drop(data);

        let (root, leaves) = optimize_directories(&directory);
        let metadata_gz = gzip(serde_json::to_string(metadata)?.as_bytes());
        header.root_offset = HEADER_LEN as u64;
        header.root_length = root.len() as u64;
        header.metadata_offset = header.root_offset + header.root_length;
        header.metadata_length = metadata_gz.len() as u64;
        header.leaves_offset = header.metadata_offset + header.metadata_length;
        header.leaves_length = leaves.len() as u64;
        header.data_offset = header.leaves_offset + header.leaves_length;
        header.data_length = final_len;
        header.addressed_tiles = self.entries.len() as u64;
        header.tile_entries = directory.len() as u64;
        header.tile_contents = moved.len() as u64;

        let mut file = BufWriter::new(File::create(&partial)?);
        file.write_all(&header.to_bytes())?;
        file.write_all(&root)?;
        file.write_all(&metadata_gz)?;
        file.write_all(&leaves)?;
        std::io::copy(&mut File::open(&data_path)?, &mut file)?;
        file.flush()?;
        drop(file);
        std::fs::remove_file(&data_path)?;
        std::fs::remove_file(&self.temp_path)?;
        let file_bytes = std::fs::metadata(&partial)?.len();
        std::fs::rename(&partial, out)?;
        Ok(WriteStats {
            addressed_tiles: header.addressed_tiles,
            unique_tiles: header.tile_contents,
            file_bytes,
            tile_bytes: final_len,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------

/// Lecteur d'archive : garde la racine en mémoire, lit les feuilles et les tuiles à la demande (lecture
/// positionnée : plusieurs requêtes en parallèle sans verrou sur le fichier).
pub struct Reader {
    file: File,
    header: Header,
    root: Vec<Entry>,
    /// Feuilles déjà lues, par offset (quelques-unes suffisent : les tuiles voisines partagent leur feuille).
    leaves: Mutex<HashMap<u64, Arc<Vec<Entry>>>>,
}

impl Reader {
    pub fn open(path: &Path) -> Result<Reader> {
        let file = File::open(path).with_context(|| format!("ouverture de {}", path.display()))?;
        let mut head = [0u8; HEADER_LEN];
        file.read_exact_at(&mut head, 0).context("lecture de l'en-tête")?;
        let header = Header::from_bytes(&head)?;
        let mut root = vec![0u8; header.root_length as usize];
        file.read_exact_at(&mut root, header.root_offset)?;
        let root = parse_directory(&gunzip(&root)?)?;
        Ok(Reader { file, header, root, leaves: Mutex::new(HashMap::new()) })
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    pub fn metadata(&self) -> Result<serde_json::Value> {
        let mut bytes = vec![0u8; self.header.metadata_length as usize];
        self.file.read_exact_at(&mut bytes, self.header.metadata_offset)?;
        Ok(serde_json::from_slice(&gunzip(&bytes)?)?)
    }

    fn leaf(&self, entry: &Entry) -> Result<Arc<Vec<Entry>>> {
        if let Some(found) = self.leaves.lock().expect("cache des feuilles").get(&entry.offset) {
            return Ok(found.clone());
        }
        let mut bytes = vec![0u8; entry.length as usize];
        self.file.read_exact_at(&mut bytes, self.header.leaves_offset + entry.offset)?;
        let leaf = Arc::new(parse_directory(&gunzip(&bytes)?)?);
        let mut cache = self.leaves.lock().expect("cache des feuilles");
        if cache.len() > 64 {
            cache.clear();
        }
        cache.insert(entry.offset, leaf.clone());
        Ok(leaf)
    }

    /// La tuile `(z, x, y)` telle que stockée (MVT compressé en gzip), ou `None` si l'archive n'en a pas.
    pub fn tile(&self, z: u8, x: u32, y: u32) -> Result<Option<Vec<u8>>> {
        if z > self.header.max_zoom || z < self.header.min_zoom {
            return Ok(None);
        }
        let id = tile_id(z, x, y);
        let mut entries: Arc<Vec<Entry>> = Arc::new(self.root.clone());
        // Au plus trois niveaux de répertoires (racine, feuille, feuille de feuille).
        for _ in 0..3 {
            let after = entries.partition_point(|e| e.tile_id <= id);
            if after == 0 {
                return Ok(None);
            }
            let entry = entries[after - 1];
            if entry.run_length == 0 {
                entries = self.leaf(&entry)?;
            } else if id < entry.tile_id + u64::from(entry.run_length) {
                let mut bytes = vec![0u8; entry.length as usize];
                self.file.read_exact_at(&mut bytes, self.header.data_offset + entry.offset)?;
                return Ok(Some(bytes));
            } else {
                return Ok(None);
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numeros_de_tuiles_de_la_specification() {
        // Valeurs de la spécification : zoom 0 = 0 ; zoom 1 suit la courbe de Hilbert (0,0) (0,1) (1,1) (1,0).
        assert_eq!(tile_id(0, 0, 0), 0);
        assert_eq!([tile_id(1, 0, 0), tile_id(1, 0, 1), tile_id(1, 1, 1), tile_id(1, 1, 0)], [1, 2, 3, 4]);
        assert_eq!(tile_id(2, 0, 0), 5);
    }

    #[test]
    fn numero_et_tuile_sont_inverses_et_la_courbe_est_continue() {
        for z in 0..=6u8 {
            let n = 1u32 << z;
            let mut previous: Option<(u32, u32)> = None;
            let first = tile_id(z, 0, 0);
            let mut ids: Vec<(u64, u32, u32)> = (0..n).flat_map(|x| (0..n).map(move |y| (tile_id(z, x, y), x, y))).collect();
            ids.sort_unstable();
            for (id, x, y) in ids {
                assert_eq!(tile_zxy(id), (z, x, y));
                if let Some((px, py)) = previous {
                    // Deux numéros consécutifs sont deux tuiles côte à côte : c'est la propriété de Hilbert.
                    assert_eq!(px.abs_diff(x) + py.abs_diff(y), 1, "z{z} id {id}");
                }
                previous = Some((x, y));
            }
            assert!(first >= (0..z).map(|t| 1u64 << (2 * t)).sum::<u64>());
        }
        // Un zoom élevé ne déborde pas.
        assert_eq!(tile_zxy(tile_id(14, 8000, 5000)), (14, 8000, 5000));
    }

    #[test]
    fn repertoire_aller_retour() {
        let entries = vec![
            Entry { tile_id: 3, offset: 0, length: 10, run_length: 1 },
            Entry { tile_id: 4, offset: 10, length: 20, run_length: 3 }, // contigu : offset codé 0
            Entry { tile_id: 9, offset: 10, length: 20, run_length: 1 }, // même contenu que la précédente : non contigu
            Entry { tile_id: 1_000_000, offset: 5000, length: 1, run_length: 0 }, // renvoi vers une feuille
        ];
        let bytes = serialize_directory(&entries);
        assert_eq!(parse_directory(&bytes).unwrap(), entries);
        assert!(parse_directory(&bytes[..bytes.len() - 3]).is_err() || parse_directory(&bytes[..3]).is_err());
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("carte-vivante-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn archive_aller_retour_avec_deduplication() {
        let dir = temp_dir("pmtiles");
        let mut writer = Writer::create(&dir.join("w.tmp")).unwrap();
        // Tuiles ajoutées dans le désordre ; trois zooms ; certaines identiques.
        let same = gzip(b"tuile vide");
        let mut expected: Vec<((u8, u32, u32), Vec<u8>)> = Vec::new();
        for z in [3u8, 1, 2] {
            for x in (0..(1u32 << z)).rev() {
                for y in 0..(1u32 << z) {
                    let body = if (x + y) % 2 == 0 { same.clone() } else { gzip(format!("tuile {z}/{x}/{y}").as_bytes()) };
                    writer.add(tile_id(z, x, y), &body).unwrap();
                    expected.push(((z, x, y), body));
                }
            }
        }
        let header = Header { min_zoom: 1, max_zoom: 3, bounds: [-5.0, 41.0, 10.0, 51.5], center_zoom: 2, center: [2.0, 46.0], ..Header::default() };
        let out = dir.join("a.pmtiles");
        let stats = writer.finish(&out, header, &serde_json::json!({ "name": "essai" })).unwrap();
        assert_eq!(stats.addressed_tiles, expected.len() as u64);
        // Déduplication : bien moins de contenus que de tuiles.
        assert!(stats.unique_tiles < stats.addressed_tiles / 2 + 2, "{stats:?}");

        let reader = Reader::open(&out).unwrap();
        assert_eq!((reader.header().min_zoom, reader.header().max_zoom), (1, 3));
        assert!((reader.header().bounds[2] - 10.0).abs() < 1e-6);
        assert_eq!(reader.metadata().unwrap()["name"], "essai");
        for ((z, x, y), body) in &expected {
            assert_eq!(reader.tile(*z, *x, *y).unwrap().as_deref(), Some(body.as_slice()), "{z}/{x}/{y}");
        }
        // Une tuile absente, et une hors des zooms de l'archive.
        assert!(reader.tile(3, 0, 0).unwrap().is_some());
        assert!(reader.tile(5, 0, 0).unwrap().is_none());
        assert!(reader.tile(0, 0, 0).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gros_repertoire_decoupe_en_feuilles() {
        // Assez d'entrées distinctes pour que la racine ne tienne pas dans 16 Ko : elle doit renvoyer à des feuilles.
        let entries: Vec<Entry> = (0..60_000u64)
            .map(|i| Entry { tile_id: i * 3 + (i * i) % 3, offset: i * 100_003 % 7_777_777, length: 50 + (i % 997) as u32, run_length: 1 })
            .collect();
        let (root, leaves) = optimize_directories(&entries);
        assert!(root.len() <= ROOT_BUDGET);
        assert!(!leaves.is_empty(), "la racine seule ne suffisait pas");
        // Chaque feuille se relit et la concaténation redonne toutes les entrées.
        let root_entries = parse_directory(&gunzip(&root).unwrap()).unwrap();
        assert!(root_entries.iter().all(|e| e.run_length == 0));
        let mut all = Vec::new();
        for e in &root_entries {
            let bytes = &leaves[e.offset as usize..e.offset as usize + e.length as usize];
            all.extend(parse_directory(&gunzip(bytes).unwrap()).unwrap());
        }
        assert_eq!(all, entries);
    }
}
