//! Le relevé : tronçons ouverts en mémoire, fermés puis écrits sur le disque, index du jour, durée de conservation.
//!
//! Chaque couche a ses tronçons ouverts (au plus deux à la fois). Un tronçon est **fermé** `GRACE_S` après sa fin :
//! ce délai laisse arriver le premier point d'après la fin de chaque objet (le « report de sortie » du format). Une
//! fois fermé, un tronçon ne change plus jamais : il est écrit (compressé, via un fichier temporaire renommé) puis
//! oublié de la mémoire. Un arrêt brutal ne perd donc que les tronçons ouverts, soit 10 à 13 minutes au plus.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::codec::{self, CHUNK_S, Chunk, Layer, Object, Point, push_point};
use super::sources::Obs;

/// Délai entre la fin d'un tronçon et sa fermeture : reçoit le premier point d'après la fin de chaque objet.
pub const GRACE_S: i64 = 160;
/// Un point d'après la fin du tronçon n'est gardé que s'il la suit de moins que cela (c'est la portée de l'interpolation).
const CARRY_OUT_S: i64 = 150;
/// Le dernier point d'avant le début n'est reporté que s'il est plus récent que cela.
const CARRY_IN_S: i64 = 150;
/// Une observation plus vieille que cela (par rapport à l'heure du serveur) n'entre plus dans aucun tronçon ouvert.
const FORGET_LAST_S: i64 = 400;
/// gzip : niveau 9 pour l'écriture (une fois par tronçon), 1 pour le tronçon encore ouvert servi à la demande.
const WRITE_LEVEL: u32 = 9;
const OPEN_LEVEL: u32 = 1;

/// Un tronçon en cours de remplissage : le tronçon lui-même, et de quoi retrouver vite un objet ou une chaîne.
struct Open {
    chunk: Chunk,
    by_id: HashMap<String, usize>,
    interned: [HashMap<String, u32>; 2],
    /// Premier et dernier instant d'une vraie observation du tronçon (hors reports), pour dire ce qui est couvert.
    first: Option<i64>,
    last: Option<i64>,
}

impl Open {
    fn new(layer: Layer, start: i64) -> Self {
        Self { chunk: Chunk::new(layer, start), by_id: HashMap::new(), interned: [HashMap::new(), HashMap::new()], first: None, last: None }
    }

    fn intern(&mut self, table: usize, text: &str) -> u32 {
        if let Some(&index) = self.interned[table].get(text) {
            return index;
        }
        let index = self.chunk.tables[table].len() as u32;
        self.chunk.tables[table].push(text.to_string());
        self.interned[table].insert(text.to_string(), index);
        index
    }

    /// Ajoute l'observation à son objet. `carried` : report d'entrée ou de sortie (pas une observation de ce tronçon).
    fn add(&mut self, obs: &Obs, carried: bool) {
        let start = self.chunk.start;
        let mut numbers = obs.numbers.clone();
        let mut v = obs.v;
        if self.chunk.layer == Layer::Transit {
            if let Some(line) = &obs.refs[0] {
                numbers[0] = self.intern(0, line) + 1;
            }
            if let Some(stop) = &obs.refs[1] {
                v[3] = self.intern(1, stop) as i32;
            }
        }
        let index = match self.by_id.get(&obs.key) {
            Some(&i) => i,
            None => {
                self.chunk.objects.push(Object::default());
                self.by_id.insert(obs.key.clone(), self.chunk.objects.len() - 1);
                self.chunk.objects.len() - 1
            }
        };
        let object = &mut self.chunk.objects[index];
        // L'identité la plus récente l'emporte (un indicatif arrive parfois après la première position).
        object.id.clone_from(&obs.id);
        object.strings.clone_from(&obs.strings);
        object.numbers = numbers;
        push_point(&mut object.points, Point { t: (obs.t - start) as i32, lon: obs.lon, lat: obs.lat, mask: obs.mask, v });
        if !carried {
            self.first = Some(self.first.map_or(obs.t, |f| f.min(obs.t)));
            self.last = Some(self.last.map_or(obs.t, |l| l.max(obs.t)));
        }
    }
}

/// Les tronçons ouverts d'une couche, et le dernier point connu de chaque objet.
struct LayerRec {
    layer: Layer,
    open: BTreeMap<i64, Open>,
    last: HashMap<String, Obs>,
}

fn chunk_start(t: i64) -> i64 {
    t.div_euclid(CHUNK_S) * CHUNK_S
}

impl LayerRec {
    fn new(layer: Layer) -> Self {
        Self { layer, open: BTreeMap::new(), last: HashMap::new() }
    }

    /// Ouvre le tronçon `start`, avec pour chaque objet récent son dernier point d'avant le début.
    fn open_chunk(&mut self, start: i64) {
        if self.open.contains_key(&start) {
            return;
        }
        let mut chunk = Open::new(self.layer, start);
        for obs in self.last.values() {
            if obs.t < start && start - obs.t <= CARRY_IN_S {
                chunk.add(obs, true);
            }
        }
        self.open.insert(start, chunk);
    }

    fn ingest(&mut self, observations: Vec<Obs>, now: i64) {
        for obs in observations {
            let start = chunk_start(obs.t);
            // Tronçon déjà fermé (ou trop ancien) : la mesure est perdue pour l'historique, pas pour le direct.
            if start + CHUNK_S + GRACE_S <= now {
                continue;
            }
            self.open_chunk(start);
            // Report de sortie du tronçon précédent, s'il est encore ouvert : le premier point qui suit sa fin.
            if let Some(previous) = self.open.get_mut(&(start - CHUNK_S)) {
                let end = previous.chunk.end();
                let pending = previous.by_id.get(&obs.key).is_none_or(|&i| {
                    previous.chunk.objects[i].points.last().is_none_or(|p| i64::from(p.t) + previous.chunk.start < end)
                });
                if pending && obs.t - end < CARRY_OUT_S {
                    previous.add(&obs, true);
                }
            }
            self.open.get_mut(&start).expect("tronçon ouvert").add(&obs, false);
            self.last.insert(obs.key.clone(), obs);
        }
    }

    /// Ouvre le tronçon de l'instant présent et ferme ceux dont le délai est passé.
    fn tick(&mut self, now: i64) -> Vec<Chunk> {
        self.open_chunk(chunk_start(now));
        self.last.retain(|_, obs| now - obs.t <= FORGET_LAST_S);
        let due: Vec<i64> = self.open.keys().copied().filter(|&s| s + CHUNK_S + GRACE_S <= now).collect();
        let mut closed = Vec::new();
        for start in due {
            let open = self.open.remove(&start).expect("tronçon ouvert");
            if open.first.is_some() {
                let mut chunk = open.chunk;
                chunk.closed = true;
                closed.push(chunk);
            }
        }
        closed
    }

    /// Photographie d'un tronçon encore ouvert, pour le servir.
    fn snapshot(&self, start: i64) -> Option<Chunk> {
        self.open.get(&start).filter(|o| o.first.is_some()).map(|o| o.chunk.clone())
    }
}

// ───────────────────────── Index sur disque ─────────────────────────

/// Ce que l'on sait d'un tronçon écrit : de quoi dire où il y a des données, sans l'ouvrir.
#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Meta {
    /// Début du tronçon.
    pub s: i64,
    /// Premier et dernier instant d'une observation du tronçon.
    pub first: i64,
    pub last: i64,
    pub objects: usize,
    pub points: usize,
    /// Taille du fichier compressé.
    pub bytes: usize,
}

#[derive(Serialize, Deserialize, Default)]
struct DayIndex {
    chunks: Vec<Meta>,
}

fn day_name(start: i64) -> String {
    Timestamp::from_second(start).map_or_else(|_| "invalide".into(), |t| t.strftime("%Y-%m-%d").to_string())
}

fn file_name(start: i64) -> String {
    Timestamp::from_second(start).map_or_else(|_| "invalide".into(), |t| format!("{}.cvh.gz", t.strftime("%H%M")))
}

/// Le relevé tout entier : tronçons ouverts, index des tronçons écrits, dossier.
pub struct History {
    pub dir: PathBuf,
    pub retention_days: i64,
    shared: Mutex<Shared>,
    index: Mutex<BTreeMap<Layer, BTreeMap<i64, Meta>>>,
}

struct Shared {
    layers: Vec<LayerRec>,
    /// Tronçons fermés dont le fichier n'est pas encore écrit : toujours servis, sans trou.
    closing: Vec<Arc<Chunk>>,
}

/// Ce qu'une requête obtient pour un tronçon.
pub enum Served {
    /// Fichier gzip complet, fermé pour toujours.
    Closed(Vec<u8>),
    /// Tronçon encore ouvert : gzip d'un état provisoire.
    Open(Vec<u8>),
}

impl History {
    pub fn new(dir: PathBuf, retention_days: i64) -> Arc<Self> {
        let layers = Layer::ALL.into_iter().map(LayerRec::new).collect();
        Arc::new(Self {
            dir,
            retention_days,
            shared: Mutex::new(Shared { layers, closing: Vec::new() }),
            index: Mutex::new(BTreeMap::new()),
        })
    }

    fn layer_dir(&self, layer: Layer) -> PathBuf {
        self.dir.join(layer.slug())
    }

    fn chunk_path(&self, layer: Layer, start: i64) -> PathBuf {
        self.layer_dir(layer).join(day_name(start)).join(file_name(start))
    }

    /// Relit l'index des jours déjà sur le disque (redémarrage du serveur).
    pub fn load_index(&self) {
        let mut all = BTreeMap::new();
        for layer in Layer::ALL {
            let mut metas = BTreeMap::new();
            let Ok(days) = std::fs::read_dir(self.layer_dir(layer)) else { continue };
            for day in days.flatten().filter(|d| d.path().is_dir()) {
                match read_day(&day.path()) {
                    Ok(list) => metas.extend(list.into_iter().map(|m| (m.s, m))),
                    Err(error) => warn!(dossier = %day.path().display(), "historique : jour illisible : {error:#}"),
                }
            }
            if !metas.is_empty() {
                info!(couche = layer.slug(), troncons = metas.len(), "historique : index relu");
            }
            all.insert(layer, metas);
        }
        *self.index.lock().expect("verrou de l'index") = all;
    }

    /// Enregistre la réponse JSON servie par une couche : ne garde que les observations nouvelles. Rend leur nombre.
    pub fn ingest_json(&self, layer: Layer, json: &[u8], now: i64) -> Result<usize> {
        let mut shared = self.shared.lock().expect("verrou de l'historique");
        let rec = shared.layers.iter_mut().find(|l| l.layer == layer).expect("couche");
        let observations = super::sources::parse(layer, json, &|key| rec.last.get(key).map(|o| o.t))?;
        let count = observations.len();
        rec.ingest(observations, now);
        Ok(count)
    }

    /// Ferme ce qui doit l'être et écrit sur le disque.
    pub async fn tick(self: &Arc<Self>, now: i64) {
        let closed: Vec<Arc<Chunk>> = {
            let mut shared = self.shared.lock().expect("verrou de l'historique");
            let mut closed = Vec::new();
            for rec in &mut shared.layers {
                closed.extend(rec.tick(now).into_iter().map(Arc::new));
            }
            shared.closing.extend(closed.iter().cloned());
            closed
        };
        for chunk in closed {
            let history = self.clone();
            let for_disk = chunk.clone();
            let result = tokio::task::spawn_blocking(move || history.write(&for_disk)).await;
            match result {
                Ok(Ok(meta)) => info!(
                    couche = chunk.layer.slug(),
                    debut = chunk.start,
                    objets = meta.objects,
                    points = meta.points,
                    octets = meta.bytes,
                    "historique : tronçon écrit"
                ),
                Ok(Err(error)) => warn!(couche = chunk.layer.slug(), "historique : écriture impossible : {error:#}"),
                Err(error) => warn!("historique : écriture interrompue : {error}"),
            }
            // Écrit (ou perdu faute de disque) : plus la peine de le garder en mémoire.
            self.shared.lock().expect("verrou de l'historique").closing.retain(|c| !Arc::ptr_eq(c, &chunk));
        }
    }

    /// Écrit un tronçon fermé : fichier temporaire puis renommage, puis index du jour.
    fn write(&self, chunk: &Chunk) -> Result<Meta> {
        let path = self.chunk_path(chunk.layer, chunk.start);
        let folder = path.parent().context("dossier du jour")?;
        std::fs::create_dir_all(folder)?;
        let bytes = codec::gzip(&codec::encode(chunk), WRITE_LEVEL);
        let (first, last) = observed_range(chunk);
        let meta = Meta { s: chunk.start, first, last, objects: chunk.objects.len(), points: chunk.point_count(), bytes: bytes.len() };
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, &bytes)?;
        std::fs::rename(&temporary, &path)?;

        let mut index = self.index.lock().expect("verrou de l'index");
        let metas = index.entry(chunk.layer).or_default();
        metas.insert(chunk.start, meta.clone());
        let day = day_name(chunk.start);
        let list: Vec<Meta> = metas.values().filter(|m| day_name(m.s) == day).cloned().collect();
        drop(index);
        let json = serde_json::to_vec(&DayIndex { chunks: list })?;
        let temporary = folder.join("index.json.tmp");
        std::fs::write(&temporary, json)?;
        std::fs::rename(&temporary, folder.join("index.json"))?;
        Ok(meta)
    }

    /// Le tronçon commençant à `start` : sur le disque s'il est fermé, sinon en mémoire.
    pub fn serve(&self, layer: Layer, start: i64) -> Result<Option<Served>> {
        {
            let shared = self.shared.lock().expect("verrou de l'historique");
            if let Some(chunk) = shared.closing.iter().find(|c| c.layer == layer && c.start == start) {
                return Ok(Some(Served::Closed(codec::gzip(&codec::encode(chunk), OPEN_LEVEL))));
            }
            let rec = shared.layers.iter().find(|l| l.layer == layer).expect("couche");
            if let Some(chunk) = rec.snapshot(start) {
                drop(shared);
                return Ok(Some(Served::Open(codec::gzip(&codec::encode(&chunk), OPEN_LEVEL))));
            }
        }
        match std::fs::read(self.chunk_path(layer, start)) {
            Ok(bytes) => Ok(Some(Served::Closed(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Les plages couvertes de chaque couche (secondes UNIX), tronçons écrits et ouverts réunis.
    pub fn coverage(&self, layer: Layer) -> Vec<(i64, i64)> {
        let mut spans: Vec<(i64, i64)> = {
            let index = self.index.lock().expect("verrou de l'index");
            index.get(&layer).map(|m| m.values().map(|m| (m.first, m.last)).collect()).unwrap_or_default()
        };
        {
            let shared = self.shared.lock().expect("verrou de l'historique");
            for chunk in &shared.closing {
                if chunk.layer == layer {
                    spans.push(observed_range(chunk));
                }
            }
            let rec = shared.layers.iter().find(|l| l.layer == layer).expect("couche");
            spans.extend(rec.open.values().filter_map(|o| o.first.zip(o.last)));
        }
        merge_spans(spans, MERGE_GAP_S)
    }

    /// Supprime les jours entièrement plus vieux que la durée de conservation, dans les dossiers des couches
    /// seulement. L'archive brute du temps réel SNCF (`sncf-trip-updates`) est gardée sans limite : c'est la mémoire
    /// longue des retards, à analyser plus tard. Rend le nombre de dossiers supprimés.
    pub fn purge(&self, now: i64) -> usize {
        let cutoff = now - self.retention_days * 86_400;
        let mut removed = 0;
        let folders: Vec<PathBuf> = Layer::ALL.iter().map(|l| self.layer_dir(*l)).collect();
        for folder in folders {
            let Ok(days) = std::fs::read_dir(&folder) else { continue };
            for day in days.flatten() {
                let Some(start) = day.file_name().to_str().and_then(parse_day) else { continue };
                if start + 86_400 <= cutoff {
                    match std::fs::remove_dir_all(day.path()) {
                        Ok(()) => {
                            removed += 1;
                            info!(dossier = %day.path().display(), "historique : jour supprimé (conservation de {} jours)", self.retention_days);
                        }
                        Err(error) => warn!(dossier = %day.path().display(), "historique : suppression impossible : {error}"),
                    }
                }
            }
        }
        if removed > 0 {
            let mut index = self.index.lock().expect("verrou de l'index");
            for metas in index.values_mut() {
                metas.retain(|&s, _| s + CHUNK_S + 86_400 > cutoff);
            }
        }
        removed
    }

    /// Volume écrit sur le disque par couche, par jour (pour les journaux et le README).
    pub fn disk_usage(&self) -> Vec<(Layer, i64, usize)> {
        let index = self.index.lock().expect("verrou de l'index");
        let mut out = Vec::new();
        for (layer, metas) in index.iter() {
            let mut per_day: BTreeMap<i64, usize> = BTreeMap::new();
            for m in metas.values() {
                *per_day.entry(chunk_start(m.s).div_euclid(86_400) * 86_400).or_default() += m.bytes;
            }
            out.extend(per_day.into_iter().map(|(day, bytes)| (*layer, day, bytes)));
        }
        out
    }
}

/// Deux tronçons voisins se rejoignent s'ils sont séparés de moins que cela : un redémarrage ou une coupure de la
/// source plus longue est signalée comme un trou.
pub const MERGE_GAP_S: i64 = 200;

pub fn merge_spans(mut spans: Vec<(i64, i64)>, gap: i64) -> Vec<(i64, i64)> {
    spans.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (from, to) in spans {
        match merged.last_mut() {
            Some(last) if from - last.1 <= gap => last.1 = last.1.max(to),
            _ => merged.push((from, to)),
        }
    }
    merged
}

fn observed_range(chunk: &Chunk) -> (i64, i64) {
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    for p in chunk.objects.iter().flat_map(|o| &o.points) {
        let t = chunk.start + i64::from(p.t);
        if (chunk.start..chunk.end()).contains(&t) {
            first = first.min(t);
            last = last.max(t);
        }
    }
    if first > last { (chunk.start, chunk.start) } else { (first, last) }
}

fn parse_day(name: &str) -> Option<i64> {
    jiff::civil::Date::strptime("%Y-%m-%d", name).ok()?.to_zoned(jiff::tz::TimeZone::UTC).ok().map(|z| z.timestamp().as_second())
}

/// L'index d'un jour ; reconstruit depuis les fichiers s'il manque.
fn read_day(folder: &Path) -> Result<Vec<Meta>> {
    if let Ok(bytes) = std::fs::read(folder.join("index.json")) {
        if let Ok(index) = serde_json::from_slice::<DayIndex>(&bytes) {
            return Ok(index.chunks);
        }
    }
    let mut metas = Vec::new();
    for file in std::fs::read_dir(folder)?.flatten() {
        let path = file.path();
        if !path.to_string_lossy().ends_with(".cvh.gz") {
            continue;
        }
        let bytes = std::fs::read(&path)?;
        let chunk = codec::decode(&codec::gunzip(&bytes)?)?;
        let (first, last) = observed_range(&chunk);
        metas.push(Meta { s: chunk.start, first, last, objects: chunk.objects.len(), points: chunk.point_count(), bytes: bytes.len() });
    }
    Ok(metas)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(key: &str, t: i64, lon: i32) -> Obs {
        Obs {
            key: key.into(),
            id: key.into(),
            strings: vec![String::new(); 6],
            numbers: Vec::new(),
            refs: [None, None],
            t,
            lon,
            lat: 4_000_000,
            mask: 0b100000,
            v: [0; 6],
        }
    }

    #[test]
    fn reports_d_entree_et_de_sortie_rendent_les_troncons_autonomes() {
        let base = 1_794_268_800; // multiple de 600
        let mut rec = LayerRec::new(Layer::Planes);
        // Un avion observé toutes les 10 s, de 30 s avant la fin du premier tronçon à 30 s après son début.
        let mut now = base + 500;
        for t in (base + 570..base + 630).step_by(10) {
            now = t + 1;
            rec.ingest(vec![obs("x", t, 1_000_000 + (t - base) as i32 * 100)], now);
        }
        let closed = rec.tick(base + CHUNK_S + GRACE_S);
        assert_eq!(closed.len(), 1);
        let first = &closed[0];
        let times: Vec<i64> = first.objects[0].points.iter().map(|p| first.start + i64::from(p.t)).collect();
        assert_eq!(times, vec![base + 570, base + 580, base + 590, base + 600], "le premier point après la fin est reporté");
        let next = rec.open.get(&(base + CHUNK_S)).expect("tronçon suivant ouvert").chunk.objects[0]
            .points
            .iter()
            .map(|p| base + CHUNK_S + i64::from(p.t))
            .collect::<Vec<_>>();
        assert_eq!(next, vec![base + 590, base + 600, base + 610, base + 620], "le dernier point d'avant le début est reporté");
        let _ = now;
    }

    #[test]
    fn les_mesures_trop_tardives_sont_ecartees() {
        let base = 1_794_268_800;
        let mut rec = LayerRec::new(Layer::Planes);
        rec.ingest(vec![obs("x", base + 10, 1)], base + CHUNK_S + GRACE_S + 5);
        assert!(rec.open.is_empty(), "le tronçon de cette mesure est déjà fermé");
    }

    #[test]
    fn plages_fusionnees() {
        let spans = vec![(100, 200), (1000, 1100), (250, 400)];
        assert_eq!(merge_spans(spans, 100), vec![(100, 400), (1000, 1100)]);
    }

    #[test]
    fn ecriture_relecture_et_conservation() {
        let dir = std::env::temp_dir().join(format!("historique-essai-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let history = History::new(dir.clone(), 7);
        let base = 1_794_268_800;
        let mut chunk = Chunk::new(Layer::Planes, base);
        let mut o = Object { id: "x".into(), strings: vec![String::new(); 6], numbers: vec![], points: vec![] };
        push_point(&mut o.points, Point { t: 5, lon: 1, lat: 2, mask: 0, v: [0; 6] });
        chunk.objects.push(o);
        chunk.closed = true;
        let meta = history.write(&chunk).unwrap();
        assert_eq!((meta.first, meta.last), (base + 5, base + 5));
        let fresh = History::new(dir.clone(), 7);
        fresh.load_index();
        assert_eq!(fresh.coverage(Layer::Planes), vec![(base + 5, base + 5)]);
        let Some(Served::Closed(bytes)) = fresh.serve(Layer::Planes, base).unwrap() else { panic!("tronçon absent") };
        assert_eq!(codec::decode(&codec::gunzip(&bytes).unwrap()).unwrap().objects[0].id, "x");
        assert!(fresh.serve(Layer::Planes, base + CHUNK_S).unwrap().is_none());
        // Bien plus tard : le jour est supprimé.
        assert_eq!(fresh.purge(base + 9 * 86_400), 1);
        assert!(fresh.serve(Layer::Planes, base).unwrap().is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
