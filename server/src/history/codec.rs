//! Format d'un tronçon d'historique : des trajectoires en colonnes, des entiers codés en différences.
//!
//! Un tronçon couvre `CHUNK_S` secondes d'une couche (avions, bateaux, transports). Il contient, pour chaque
//! objet vu pendant ce temps, ses points (instant, position, quelques mesures) et ses champs d'identité
//! (indicatif, nom du navire, ligne…) **une seule fois**, pas à chaque point.
//!
//! Ce qui rend le format compact, dans l'ordre d'importance :
//!
//! 1. **Colonnes plutôt que lignes** : on écrit d'abord tous les instants, puis toutes les longitudes, puis toutes
//!    les latitudes… Des valeurs voisines se ressemblent, la compression finale les rapproche.
//! 2. **Entiers quantifiés** : une coordonnée est un entier en cent-millièmes de degré (environ 1,1 m), une altitude
//!    un nombre de paliers de 25 ft (le pas du transpondeur), etc. Pas de flottants.
//! 3. **Différences** : on n'écrit pas la valeur mais son écart avec la précédente, de l'objet. Les écarts sont
//!    petits, donc tiennent sur un ou deux octets en entier à longueur variable (« varint », 7 bits utiles par octet).
//!    Pour la position on va plus loin : on prédit le point suivant en prolongeant la vitesse du segment précédent
//!    (`prédiction linéaire`) et on n'écrit que l'erreur de prédiction, quasi nulle sur une trajectoire rectiligne.
//! 4. **Lignes constantes fusionnées** : un objet immobile (bus au dépôt, avion au parking) qui répète le même point
//!    n'en garde que le premier et le dernier (voir `Chunk::push`). Sans perte : l'interpolation donne la même chose.
//! 5. **gzip** par-dessus, que le navigateur sait défaire tout seul (`Content-Encoding: gzip`).
//!
//! Chaque tronçon est **autonome pour l'interpolation** : il porte, par objet, le dernier point d'avant son début
//! (« report d'entrée », instant négatif) et le premier point d'après sa fin (« report de sortie »). Le navigateur
//! n'a donc besoin que du tronçon qui contient l'instant regardé.
//!
//! Disposition (avant gzip), `varint` = entier non signé à longueur variable, `zigzag` = entier signé replié :
//!
//! ```text
//! "CVH1" | couche u8 | drapeaux u8 (1 = fermé) | début u32 | fin u32
//! tables : varint n, puis n × (varint m, m × chaîne)            (chaînes : varint longueur + UTF-8)
//! varint nombre d'objets
//! par objet : id, N chaînes, N valeurs (varint, 0 = absente sinon valeur + 1)
//! par objet : varint nombre de points
//! colonne t   : par objet, zigzag(t0 − début) puis écarts non signés
//! colonne lon : par objet, zigzag(lon0), zigzag(lon1 − lon0), puis zigzag(écart de prédiction)
//! colonne lat : idem
//! colonne masque : un octet par point (bit k : la mesure k est présente)
//! mesure k    : pour chaque point où elle est présente, zigzag(écart avec la précédente de l'objet)
//! ```

use anyhow::{Result, bail, ensure};

/// Durée d'un tronçon, en secondes (alignée sur le temps UNIX : 00:00, 00:10, 00:20…).
pub const CHUNK_S: i64 = 600;
/// Nombre maximal de mesures par point (les couches n'en utilisent que `Layer::columns()`).
pub const MAX_COLS: usize = 6;
const MAGIC: &[u8; 4] = b"CVH1";

/// Les couches enregistrées.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, PartialOrd, Ord)]
pub enum Layer {
    Planes,
    Ships,
    Transit,
}

impl Layer {
    pub const ALL: [Layer; 3] = [Layer::Planes, Layer::Ships, Layer::Transit];

    /// Nom dans les adresses et dans les dossiers d'archive.
    pub fn slug(self) -> &'static str {
        match self {
            Layer::Planes => "avions",
            Layer::Ships => "bateaux",
            Layer::Transit => "transports",
        }
    }

    pub fn from_slug(slug: &str) -> Option<Layer> {
        Layer::ALL.into_iter().find(|l| l.slug() == slug)
    }

    fn code(self) -> u8 {
        match self {
            Layer::Planes => 1,
            Layer::Ships => 2,
            Layer::Transit => 3,
        }
    }

    fn from_code(code: u8) -> Option<Layer> {
        Layer::ALL.into_iter().find(|l| l.code() == code)
    }

    /// Champs d'identité (texte), une fois par objet et par tronçon.
    /// - avions : indicatif, immatriculation, type, catégorie, squawk, urgence ;
    /// - bateaux : nom, destination, indicatif radio ;
    /// - transports : terminus.
    pub fn strings(self) -> usize {
        match self {
            Layer::Planes => 6,
            Layer::Ships => 3,
            Layer::Transit => 1,
        }
    }

    /// Champs d'identité numériques.
    /// - bateaux : type AIS, IMO, longueur, largeur, tirant d'eau (dixièmes de m), classe B ;
    /// - transports : ligne (indice dans la table 0), nature de la position (0 relevée, 1 estimée d'après le temps
    ///   réel du réseau, 2 estimée d'après l'horaire théorique).
    pub fn numbers(self) -> usize {
        match self {
            Layer::Planes => 0,
            Layer::Ships => 6,
            Layer::Transit => 2,
        }
    }

    /// Mesures par point.
    /// - avions : altitude baro (paliers de 25 ft), altitude GPS (25 ft), vitesse (nœuds), route (°), montée (64 ft/min), au sol (0/1) ;
    /// - bateaux : vitesse (0,1 nœud), route (0,1°), cap (°), statut de navigation ;
    /// - transports : cap (°), vitesse (km/h), retard (s), prochain arrêt (indice dans la table 1), heure d'arrivée au prochain arrêt (s UTC).
    pub fn columns(self) -> usize {
        match self {
            Layer::Planes => 6,
            Layer::Ships => 4,
            Layer::Transit => 5,
        }
    }

    /// Mesure qui est un instant (UTC) : codée par rapport au début du tronçon plutôt qu'à zéro.
    fn time_column(self) -> Option<usize> {
        (self == Layer::Transit).then_some(4)
    }

    /// Prédiction linéaire de la position : utile pour ce qui avance droit et vite (avions, navires).
    /// Les bus tournent à chaque carrefour : la simple différence suffit.
    fn predicts(self) -> bool {
        self != Layer::Transit
    }
}

/// Un point d'une trajectoire. `t` : secondes par rapport au début du tronçon (négatif pour le report d'entrée).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Point {
    pub t: i32,
    /// Cent-millièmes de degré.
    pub lon: i32,
    pub lat: i32,
    /// Bit k : la mesure k est présente (la valeur de `v[k]` n'a de sens que dans ce cas).
    pub mask: u8,
    pub v: [i32; MAX_COLS],
}

impl Point {
    /// Même contenu, à l'instant près : sert à fusionner les répétitions d'un objet immobile.
    fn same_state(&self, other: &Point) -> bool {
        self.lon == other.lon && self.lat == other.lat && self.mask == other.mask && self.v == other.v
    }
}

#[derive(Clone, Debug, Default)]
pub struct Object {
    pub id: String,
    pub strings: Vec<String>,
    /// 0 = absente, sinon valeur + 1.
    pub numbers: Vec<u32>,
    pub points: Vec<Point>,
}

#[derive(Clone, Debug)]
pub struct Chunk {
    pub layer: Layer,
    /// Début du tronçon (secondes UNIX), multiple de `CHUNK_S`.
    pub start: i64,
    pub closed: bool,
    /// Tables de chaînes communes (transports : 0 = lignes, 1 = arrêts).
    pub tables: Vec<Vec<String>>,
    pub objects: Vec<Object>,
}

impl Chunk {
    pub fn new(layer: Layer, start: i64) -> Self {
        let tables = if layer == Layer::Transit { vec![Vec::new(), Vec::new()] } else { Vec::new() };
        Self { layer, start, closed: false, tables, objects: Vec::new() }
    }

    pub fn end(&self) -> i64 {
        self.start + CHUNK_S
    }

    pub fn point_count(&self) -> usize {
        self.objects.iter().map(|o| o.points.len()).sum()
    }
}

/// Ajoute un point à la suite d'un objet, en fusionnant les répétitions : si les deux derniers points de l'objet
/// et le nouveau ont le même contenu, le dernier est simplement prolongé jusqu'à l'instant du nouveau.
pub fn push_point(points: &mut Vec<Point>, point: Point) {
    if let Some(last) = points.last()
        && point.t <= last.t
    {
        return;
    }
    if let [.., before, last] = points.as_slice()
        && before.same_state(last)
        && last.same_state(&point)
    {
        points.last_mut().expect("deux points au moins").t = point.t;
        return;
    }
    points.push(point);
}

// ───────────────────────── Entiers à longueur variable ─────────────────────────

pub fn put_uvar(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn zigzag(value: i64) -> u64 {
    ((value << 1) ^ (value >> 63)) as u64
}

fn unzigzag(value: u64) -> i64 {
    ((value >> 1) as i64) ^ -((value & 1) as i64)
}

pub fn put_ivar(out: &mut Vec<u8>, value: i64) {
    put_uvar(out, zigzag(value));
}

fn put_str(out: &mut Vec<u8>, text: &str) {
    put_uvar(out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Result<u8> {
        let b = *self.bytes.get(self.pos).ok_or_else(|| anyhow::anyhow!("tronçon tronqué"))?;
        self.pos += 1;
        Ok(b)
    }

    fn uvar(&mut self) -> Result<u64> {
        let mut value = 0u64;
        let mut shift = 0;
        loop {
            let b = self.byte()?;
            value |= u64::from(b & 0x7f) << shift;
            if b < 0x80 {
                return Ok(value);
            }
            shift += 7;
            ensure!(shift < 64, "entier trop long");
        }
    }

    fn ivar(&mut self) -> Result<i64> {
        Ok(unzigzag(self.uvar()?))
    }

    fn u32(&mut self) -> Result<u32> {
        let slice = self.bytes.get(self.pos..self.pos + 4).ok_or_else(|| anyhow::anyhow!("tronçon tronqué"))?;
        self.pos += 4;
        Ok(u32::from_le_bytes(slice.try_into().expect("quatre octets")))
    }

    fn string(&mut self) -> Result<String> {
        let len = self.uvar()? as usize;
        let slice = self.bytes.get(self.pos..self.pos + len).ok_or_else(|| anyhow::anyhow!("tronçon tronqué"))?;
        self.pos += len;
        Ok(String::from_utf8(slice.to_vec())?)
    }
}

// ───────────────────────── Prédiction ─────────────────────────

/// Valeur attendue du point `i` d'une coordonnée, d'après les deux précédents : on prolonge la vitesse du dernier
/// segment sur la durée du segment à venir. Division entière arrondie « vers le bas » (`div_euclid`), pour que
/// l'encodeur (Rust) et le décodeur (TypeScript) retrouvent exactement la même valeur.
fn predict(values: &[i32], times: &[i32], i: usize, enabled: bool) -> i64 {
    match i {
        0 => 0,
        1 => i64::from(values[0]),
        _ if !enabled => i64::from(values[i - 1]),
        _ => {
            let (p0, p1) = (i64::from(values[i - 2]), i64::from(values[i - 1]));
            let dt0 = i64::from(times[i - 1] - times[i - 2]);
            let dt1 = i64::from(times[i] - times[i - 1]);
            if dt0 <= 0 {
                return p1;
            }
            p1 + (2 * (p1 - p0) * dt1 + dt0).div_euclid(2 * dt0)
        }
    }
}

// ───────────────────────── Écriture ─────────────────────────

pub fn encode(chunk: &Chunk) -> Vec<u8> {
    let layer = chunk.layer;
    let mut out = Vec::with_capacity(1 << 16);
    out.extend_from_slice(MAGIC);
    out.push(layer.code());
    out.push(u8::from(chunk.closed));
    out.extend_from_slice(&(chunk.start as u32).to_le_bytes());
    out.extend_from_slice(&(chunk.end() as u32).to_le_bytes());

    put_uvar(&mut out, chunk.tables.len() as u64);
    for table in &chunk.tables {
        put_uvar(&mut out, table.len() as u64);
        for text in table {
            put_str(&mut out, text);
        }
    }

    // Objets triés par identifiant : sortie déterministe, et des identifiants voisins se compressent mieux.
    let mut objects: Vec<&Object> = chunk.objects.iter().collect();
    objects.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    put_uvar(&mut out, objects.len() as u64);
    for object in &objects {
        put_str(&mut out, &object.id);
        for text in &object.strings {
            put_str(&mut out, text);
        }
        for &number in &object.numbers {
            put_uvar(&mut out, u64::from(number));
        }
    }
    for object in &objects {
        put_uvar(&mut out, object.points.len() as u64);
    }

    // Instants.
    for object in &objects {
        let mut previous = 0;
        for (i, p) in object.points.iter().enumerate() {
            if i == 0 {
                put_ivar(&mut out, i64::from(p.t));
            } else {
                put_uvar(&mut out, (p.t - previous) as u64);
            }
            previous = p.t;
        }
    }
    // Positions : prédiction linéaire (ou simple différence).
    for which in 0..2 {
        for object in &objects {
            let times: Vec<i32> = object.points.iter().map(|p| p.t).collect();
            let values: Vec<i32> = object.points.iter().map(|p| if which == 0 { p.lon } else { p.lat }).collect();
            for i in 0..values.len() {
                put_ivar(&mut out, i64::from(values[i]) - predict(&values, &times, i, layer.predicts()));
            }
        }
    }
    // Masque de présence des mesures.
    for object in &objects {
        out.extend(object.points.iter().map(|p| p.mask));
    }
    // Mesures : écart avec la dernière valeur présente de l'objet.
    for k in 0..layer.columns() {
        for object in &objects {
            let mut previous = if layer.time_column() == Some(k) { chunk.start } else { 0 };
            for p in &object.points {
                if p.mask & (1 << k) != 0 {
                    put_ivar(&mut out, i64::from(p.v[k]) - previous);
                    previous = i64::from(p.v[k]);
                }
            }
        }
    }
    out
}

/// Compresse en gzip (le navigateur le défait tout seul quand on le sert avec `Content-Encoding: gzip`).
pub fn gzip(bytes: &[u8], level: u32) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::with_capacity(bytes.len() / 3), flate2::Compression::new(level));
    std::io::Write::write_all(&mut encoder, bytes).expect("écriture en mémoire");
    encoder.finish().expect("écriture en mémoire")
}

pub fn gunzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(bytes), &mut out)?;
    Ok(out)
}

// ───────────────────────── Lecture ─────────────────────────

pub fn decode(bytes: &[u8]) -> Result<Chunk> {
    ensure!(bytes.len() > 14 && &bytes[..4] == MAGIC, "pas un tronçon d'historique");
    let mut r = Reader { bytes, pos: 4 };
    let Some(layer) = Layer::from_code(r.byte()?) else { bail!("couche inconnue") };
    let closed = r.byte()? & 1 != 0;
    let start = i64::from(r.u32()?);
    let _end = r.u32()?;

    let mut tables = Vec::new();
    for _ in 0..r.uvar()? {
        let mut table = Vec::new();
        for _ in 0..r.uvar()? {
            table.push(r.string()?);
        }
        tables.push(table);
    }
    let count = r.uvar()? as usize;
    let mut objects: Vec<Object> = Vec::with_capacity(count);
    for _ in 0..count {
        let id = r.string()?;
        let strings = (0..layer.strings()).map(|_| r.string()).collect::<Result<Vec<_>>>()?;
        let numbers = (0..layer.numbers()).map(|_| r.uvar().map(|n| n as u32)).collect::<Result<Vec<_>>>()?;
        objects.push(Object { id, strings, numbers, points: Vec::new() });
    }
    let counts = (0..count).map(|_| r.uvar().map(|n| n as usize)).collect::<Result<Vec<_>>>()?;
    for (object, &n) in objects.iter_mut().zip(&counts) {
        object.points = vec![Point { t: 0, lon: 0, lat: 0, mask: 0, v: [0; MAX_COLS] }; n];
    }

    for object in &mut objects {
        let mut previous = 0i64;
        for (i, p) in object.points.iter_mut().enumerate() {
            previous = if i == 0 { r.ivar()? } else { previous + r.uvar()? as i64 };
            p.t = previous as i32;
        }
    }
    for which in 0..2 {
        for object in &mut objects {
            let times: Vec<i32> = object.points.iter().map(|p| p.t).collect();
            let mut values: Vec<i32> = Vec::with_capacity(times.len());
            for i in 0..times.len() {
                let value = predict(&values, &times, i, layer.predicts()) + r.ivar()?;
                values.push(value as i32);
            }
            for (p, &v) in object.points.iter_mut().zip(&values) {
                if which == 0 {
                    p.lon = v;
                } else {
                    p.lat = v;
                }
            }
        }
    }
    for object in &mut objects {
        for p in &mut object.points {
            p.mask = r.byte()?;
        }
    }
    for k in 0..layer.columns() {
        for object in &mut objects {
            let mut previous = if layer.time_column() == Some(k) { start } else { 0 };
            for p in &mut object.points {
                if p.mask & (1 << k) != 0 {
                    previous += r.ivar()?;
                    p.v[k] = previous as i32;
                }
            }
        }
    }
    Ok(Chunk { layer, start, closed, tables, objects })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(t: i32, lon: i32, lat: i32, v0: i32) -> Point {
        let mut v = [0; MAX_COLS];
        v[0] = v0;
        Point { t, lon, lat, mask: 1, v }
    }

    fn sample() -> Chunk {
        let mut chunk = Chunk::new(Layer::Planes, 1_794_272_400);
        let mut a = Object { id: "3814ba".into(), strings: vec!["AFR123".into(), "F-GKXA".into(), "A320".into(), "A3".into(), String::new(), String::new()], numbers: vec![], points: vec![] };
        // Un avion qui avance droit à vitesse constante, avec une irrégularité de cadence.
        for (i, t) in [-4, 6, 17, 26, 37, 47].into_iter().enumerate() {
            let i = i as i32;
            push_point(&mut a.points, point(t, 20_000_000 + 1500 * t, 4_800_000 - 700 * t, 1480 + i));
        }
        let mut b = Object { id: "a1b2c3".into(), strings: vec![String::new(); 6], numbers: vec![], points: vec![] };
        // Un avion au sol : le même point répété, fusionné.
        for t in [0, 10, 20, 30, 40, 50] {
            push_point(&mut b.points, point(t, 1_000_000, 4_500_000, 0));
        }
        chunk.objects = vec![a, b];
        chunk
    }

    #[test]
    fn aller_retour_et_fusion_des_repetitions() {
        let chunk = sample();
        assert_eq!(chunk.objects[1].points.len(), 2, "avion immobile : premier et dernier point seulement");
        assert_eq!(chunk.objects[1].points[1].t, 50);
        let decoded = decode(&encode(&chunk)).unwrap();
        assert_eq!(decoded.layer, Layer::Planes);
        assert_eq!(decoded.start, chunk.start);
        let mut expected = chunk.objects.clone();
        expected.sort_by(|a, b| a.id.cmp(&b.id));
        assert_eq!(decoded.objects.len(), 2);
        for (got, want) in decoded.objects.iter().zip(&expected) {
            assert_eq!(got.id, want.id);
            assert_eq!(got.strings, want.strings);
            assert_eq!(got.points, want.points);
        }
    }

    #[test]
    fn la_prediction_rend_la_trajectoire_rectiligne_presque_gratuite() {
        let mut chunk = Chunk::new(Layer::Planes, 0);
        let mut o = Object { id: "x".into(), strings: vec![String::new(); 6], numbers: vec![], points: vec![] };
        for i in 0..50 {
            push_point(&mut o.points, point(i * 10, 10_000_000 + 2_000 * i, 4_000_000 - 900 * i, 0));
        }
        chunk.objects.push(o);
        let with_prediction = encode(&chunk).len();
        // 50 points : environ 1 octet d'écart par coordonnée après les deux premiers points.
        assert!(with_prediction < 50 * 5 + 40, "{with_prediction} octets");
    }

    #[test]
    fn colonne_horaire_des_transports() {
        let mut chunk = Chunk::new(Layer::Transit, 1_794_272_400);
        chunk.tables[0].push("TAN\tODbL\tL1\t1\tLigne 1\t00ff00\ttram".into());
        chunk.tables[1].push("Commerce".into());
        let mut o = Object { id: "v1".into(), strings: vec!["Terminus".into()], numbers: vec![1, 2], points: vec![] };
        let mut p = point(10, 100, 200, 90);
        p.mask = 0b11111;
        p.v = [90, 30, -45, 0, 1_794_272_500, 0];
        o.points.push(p);
        let mut q = p;
        q.t = 40;
        q.lon += 50;
        q.v[4] = 1_794_272_520;
        o.points.push(q);
        chunk.objects.push(o);
        let decoded = decode(&encode(&chunk)).unwrap();
        assert_eq!(decoded.tables, chunk.tables);
        assert_eq!(decoded.objects[0].points, chunk.objects[0].points);
        assert_eq!(decoded.objects[0].numbers, vec![1, 2]);
    }

    #[test]
    fn gzip_aller_retour_et_refus_des_donnees_invalides() {
        let raw = encode(&sample());
        assert_eq!(gunzip(&gzip(&raw, 6)).unwrap(), raw);
        assert!(decode(b"nimportequoi, trop court").is_err());
        assert!(decode(&raw[..raw.len() / 2]).is_err());
    }
}
