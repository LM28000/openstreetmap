//! Encodage des tuiles vectorielles Mapbox (MVT), à la main.
//!
//! Une tuile MVT est un message *Protocol Buffers* (spécification `vector_tile.proto`, version 2.1). Le format
//! protobuf se résume à très peu de choses, et c'est instructif de l'écrire soi-même :
//!
//! - un message est une suite de champs ; chaque champ commence par une **clé** = `numéro << 3 | type` ;
//! - type 0 : un entier en **varint** (7 bits utiles par octet, le bit de poids fort dit « il y a un octet de plus ») ;
//! - type 2 : une suite d'octets précédée de sa longueur (texte, message imbriqué, liste « packed » d'entiers) ;
//! - type 5 : un flottant 32 bits, type 1 : un flottant 64 bits.
//!
//! # La structure d'une tuile
//!
//! ```text
//! Tile    { layers[3]: Layer }
//! Layer   { version[15]=2, name[1], features[2], keys[3], values[4], extent[5]=4096 }
//! Feature { id[1], tags[2]: paires (clé, valeur) en indices, type[3]: 1 point, 2 ligne, 3 polygone, geometry[4] }
//! Value   { string[1] | float[2] | double[3] | int[4] | uint[5] | sint[6] | bool[7] }
//! ```
//!
//! Les clés et les valeurs de propriétés sont **dédupliquées** au niveau de la couche : une propriété est
//! une paire d'indices dans ces deux listes, ce qui rend les tuiles denses (mêmes valeurs répétées) très compactes.
//!
//! # La géométrie
//!
//! Une suite d'entiers de commandes : `MoveTo(1)`, `LineTo(2)`, `ClosePath(7)`. Chaque commande s'écrit
//! `(nombre de répétitions << 3) | commande`, suivie de ses coordonnées **relatives au point précédent**,
//! chacune en *zigzag* (`(n << 1) ^ (n >> 31)`, pour que les petits négatifs restent petits).
//! Un polygone : `MoveTo(1) x y, LineTo(n-1) …, ClosePath`, par anneau ; l'anneau extérieur tourne dans le
//! sens positif de la formule du lacet (voir `geom::signed_area`), les trous dans l'autre.

use std::collections::HashMap;

/// Valeur d'une propriété (le sous-ensemble de MVT dont on se sert).
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Int(i64),
    Float(f32),
    Str(Box<str>),
    Bool(bool),
}

/// Type de géométrie d'un objet de tuile.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GeomType {
    Point = 1,
    Line = 2,
    Polygon = 3,
}

/// Un objet de tuile, géométrie déjà encodée en commandes.
pub struct TileFeature {
    pub geom_type: GeomType,
    pub geometry: Vec<u32>,
    /// Propriétés dans l'ordre des clés de la couche.
    pub props: Vec<Value>,
}

/// Une couche de tuile.
pub struct TileLayer {
    pub name: String,
    pub keys: Vec<String>,
    pub features: Vec<TileFeature>,
    pub extent: u32,
}

// ---------------------------------------------------------------------------------------------
// Protobuf
// ---------------------------------------------------------------------------------------------

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8 & 0x7f) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

fn put_key(out: &mut Vec<u8>, field: u32, wire: u8) {
    put_varint(out, u64::from(field) << 3 | u64::from(wire));
}

fn put_bytes(out: &mut Vec<u8>, field: u32, bytes: &[u8]) {
    put_key(out, field, 2);
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

fn put_packed(out: &mut Vec<u8>, field: u32, values: impl IntoIterator<Item = u32>) {
    let mut body = Vec::new();
    for v in values {
        put_varint(&mut body, u64::from(v));
    }
    put_bytes(out, field, &body);
}

fn zigzag(n: i64) -> u64 {
    ((n << 1) ^ (n >> 63)) as u64
}

fn encode_value(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    match value {
        Value::Str(s) => put_bytes(&mut out, 1, s.as_bytes()),
        Value::Float(f) => {
            put_key(&mut out, 2, 5);
            out.extend_from_slice(&f.to_le_bytes());
        }
        Value::Int(i) => {
            // sint_value (zigzag) : correct pour les négatifs comme pour les positifs.
            put_key(&mut out, 6, 0);
            put_varint(&mut out, zigzag(*i));
        }
        Value::Bool(b) => {
            put_key(&mut out, 7, 0);
            put_varint(&mut out, u64::from(*b));
        }
    }
    out
}

/// Clé de déduplication des valeurs (les flottants par leurs bits : 0,0 et -0,0 restent distincts, tant pis).
#[derive(Hash, PartialEq, Eq)]
enum ValueKey {
    Int(i64),
    Float(u32),
    Str(Box<str>),
    Bool(bool),
}

fn value_key(v: &Value) -> ValueKey {
    match v {
        Value::Int(i) => ValueKey::Int(*i),
        Value::Float(f) => ValueKey::Float(f.to_bits()),
        Value::Str(s) => ValueKey::Str(s.clone()),
        Value::Bool(b) => ValueKey::Bool(*b),
    }
}

/// Encode une tuile (non compressée) à partir de ses couches.
pub fn encode_tile(layers: &[TileLayer]) -> Vec<u8> {
    let mut tile = Vec::new();
    for layer in layers {
        put_bytes(&mut tile, 3, &encode_layer(layer));
    }
    tile
}

fn encode_layer(layer: &TileLayer) -> Vec<u8> {
    // Table des valeurs distinctes : chaque propriété devient un indice.
    let mut value_index: HashMap<ValueKey, u32> = HashMap::new();
    let mut values: Vec<&Value> = Vec::new();
    let mut features = Vec::new();
    for feature in &layer.features {
        let mut tags = Vec::with_capacity(feature.props.len() * 2);
        for (key, value) in feature.props.iter().enumerate() {
            let next = values.len() as u32;
            let index = *value_index.entry(value_key(value)).or_insert_with(|| {
                values.push(value);
                next
            });
            tags.push(key as u32);
            tags.push(index);
        }
        let mut f = Vec::new();
        put_packed(&mut f, 2, tags);
        put_key(&mut f, 3, 0);
        put_varint(&mut f, feature.geom_type as u64);
        put_packed(&mut f, 4, feature.geometry.iter().copied());
        features.push(f);
    }
    let mut out = Vec::new();
    put_key(&mut out, 15, 0);
    put_varint(&mut out, 2); // version de la spécification
    put_bytes(&mut out, 1, layer.name.as_bytes());
    for f in &features {
        put_bytes(&mut out, 2, f);
    }
    for key in &layer.keys {
        put_bytes(&mut out, 3, key.as_bytes());
    }
    for value in values {
        put_bytes(&mut out, 4, &encode_value(value));
    }
    put_key(&mut out, 5, 0);
    put_varint(&mut out, u64::from(layer.extent));
    out
}

// ---------------------------------------------------------------------------------------------
// Géométrie
// ---------------------------------------------------------------------------------------------

const MOVE_TO: u32 = 1;
const LINE_TO: u32 = 2;
const CLOSE_PATH: u32 = 7;

fn zz32(n: i32) -> u32 {
    ((n << 1) ^ (n >> 31)) as u32
}

/// Géométrie d'un point.
pub fn point_geometry(x: i32, y: i32) -> Vec<u32> {
    vec![1 << 3 | MOVE_TO, zz32(x), zz32(y)]
}

/// Géométrie d'un polygone : un anneau extérieur puis ses trous (chaque anneau non fermé, sans répéter le premier point).
pub fn polygon_geometry(rings: &[Vec<[i32; 2]>]) -> Vec<u32> {
    let mut out = Vec::new();
    let mut cursor = [0i32, 0i32];
    for ring in rings {
        out.push(1 << 3 | MOVE_TO);
        out.push(zz32(ring[0][0] - cursor[0]));
        out.push(zz32(ring[0][1] - cursor[1]));
        cursor = ring[0];
        out.push((ring.len() as u32 - 1) << 3 | LINE_TO);
        for p in &ring[1..] {
            out.push(zz32(p[0] - cursor[0]));
            out.push(zz32(p[1] - cursor[1]));
            cursor = *p;
        }
        out.push(1 << 3 | CLOSE_PATH);
    }
    out
}

/// Décode une géométrie de polygone ou de points en anneaux de coordonnées absolues (pour les tests et le débogage).
pub fn decode_geometry(commands: &[u32]) -> Vec<Vec<[i32; 2]>> {
    let unzig = |v: u32| ((v >> 1) as i32) ^ -((v & 1) as i32);
    let mut rings: Vec<Vec<[i32; 2]>> = Vec::new();
    let mut cursor = [0i32, 0i32];
    let mut i = 0;
    while i < commands.len() {
        let (command, count) = (commands[i] & 7, commands[i] >> 3);
        i += 1;
        match command {
            MOVE_TO | LINE_TO => {
                for _ in 0..count {
                    cursor = [cursor[0] + unzig(commands[i]), cursor[1] + unzig(commands[i + 1])];
                    i += 2;
                    if command == MOVE_TO {
                        rings.push(Vec::new());
                    }
                    if let Some(ring) = rings.last_mut() {
                        ring.push(cursor);
                    }
                }
            }
            _ => {} // ClosePath : l'anneau est déjà complet
        }
    }
    rings
}

// ---------------------------------------------------------------------------------------------
// Lecture d'une tuile (pour l'analyse de zone : on relit les archives que l'on a écrites)
// ---------------------------------------------------------------------------------------------

/// Un objet lu dans une tuile : sa géométrie (commandes brutes, voir `decode_geometry`) et ses propriétés en paires
/// (indice de clé, indice de valeur) dans les tables de sa couche.
pub struct ReadFeature {
    pub geom_type: u8,
    pub geometry: Vec<u32>,
    tags: Vec<u32>,
}

/// Une couche lue : les clés et les valeurs sont dédupliquées, les objets y renvoient par indices.
pub struct ReadLayer {
    pub name: String,
    pub keys: Vec<String>,
    values: Vec<Value>,
    pub features: Vec<ReadFeature>,
}

impl ReadLayer {
    /// Indice d'une clé de propriété (à chercher une fois par tuile, pas une fois par objet).
    pub fn key(&self, name: &str) -> Option<u32> {
        self.keys.iter().position(|k| k == name).map(|i| i as u32)
    }

    /// La valeur de la propriété `key` (indice donné par `key`) d'un objet.
    pub fn get(&self, feature: &ReadFeature, key: u32) -> Option<&Value> {
        feature.tags.chunks_exact(2).find(|pair| pair[0] == key).and_then(|pair| self.values.get(pair[1] as usize))
    }

    /// Une propriété numérique (entière ou flottante), 0 si elle manque.
    pub fn number(&self, feature: &ReadFeature, key: u32) -> f64 {
        match self.get(feature, key) {
            Some(Value::Int(i)) => *i as f64,
            Some(Value::Float(f)) => f64::from(*f),
            Some(Value::Bool(b)) => f64::from(u8::from(*b)),
            _ => 0.0,
        }
    }

    pub fn text(&self, feature: &ReadFeature, key: u32) -> Option<&str> {
        match self.get(feature, key) {
            Some(Value::Str(s)) => Some(s),
            _ => None,
        }
    }
}

/// Curseur sur un message protobuf : le miroir en lecture de `put_varint`, `put_key` et `put_bytes`.
struct Cursor<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Cursor<'a> {
    fn varint(&mut self) -> Option<u64> {
        let (mut value, mut shift) = (0u64, 0);
        loop {
            let byte = *self.data.get(self.at)?;
            self.at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(value);
            }
            shift += 7;
            if shift > 63 {
                return None;
            }
        }
    }

    /// Le champ suivant : `(numéro, type de fil)`, ou `None` à la fin du message.
    fn key(&mut self) -> Option<(u32, u8)> {
        if self.at >= self.data.len() {
            return None;
        }
        let key = self.varint()?;
        Some(((key >> 3) as u32, (key & 7) as u8))
    }

    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.varint()? as usize;
        let slice = self.data.get(self.at..self.at.checked_add(len)?)?;
        self.at += len;
        Some(slice)
    }

    /// Passe un champ dont on ne veut pas.
    fn skip(&mut self, wire: u8) -> Option<()> {
        match wire {
            0 => self.varint().map(|_| ()),
            1 => self.advance(8),
            2 => self.bytes().map(|_| ()),
            5 => self.advance(4),
            _ => None,
        }
    }

    fn advance(&mut self, n: usize) -> Option<()> {
        (self.at + n <= self.data.len()).then(|| self.at += n)
    }

    fn fixed32(&mut self) -> Option<[u8; 4]> {
        let out = self.data.get(self.at..self.at + 4)?.try_into().ok()?;
        self.at += 4;
        Some(out)
    }

    fn packed(&mut self) -> Option<Vec<u32>> {
        let mut inner = Cursor { data: self.bytes()?, at: 0 };
        let mut out = Vec::new();
        while inner.at < inner.data.len() {
            out.push(inner.varint()? as u32);
        }
        Some(out)
    }
}

fn read_value(data: &[u8]) -> Option<Value> {
    let mut c = Cursor { data, at: 0 };
    let mut out = None;
    while let Some((field, wire)) = c.key() {
        out = match (field, wire) {
            (1, 2) => Some(Value::Str(String::from_utf8_lossy(c.bytes()?).into())),
            (2, 5) => Some(Value::Float(f32::from_le_bytes(c.fixed32()?))),
            (3, 1) => {
                let bytes: [u8; 8] = c.data.get(c.at..c.at + 8)?.try_into().ok()?;
                c.at += 8;
                Some(Value::Float(f64::from_le_bytes(bytes) as f32))
            }
            (4, 0) | (5, 0) => Some(Value::Int(c.varint()? as i64)),
            (6, 0) => {
                let z = c.varint()?;
                Some(Value::Int(((z >> 1) as i64) ^ -((z & 1) as i64)))
            }
            (7, 0) => Some(Value::Bool(c.varint()? != 0)),
            _ => {
                c.skip(wire)?;
                out
            }
        };
    }
    out
}

fn read_feature(data: &[u8]) -> Option<ReadFeature> {
    let mut c = Cursor { data, at: 0 };
    let mut feature = ReadFeature { geom_type: 0, geometry: Vec::new(), tags: Vec::new() };
    while let Some((field, wire)) = c.key() {
        match (field, wire) {
            (2, 2) => feature.tags = c.packed()?,
            (3, 0) => feature.geom_type = c.varint()? as u8,
            (4, 2) => feature.geometry = c.packed()?,
            _ => c.skip(wire)?,
        }
    }
    Some(feature)
}

fn read_layer(data: &[u8]) -> Option<ReadLayer> {
    let mut c = Cursor { data, at: 0 };
    let mut layer = ReadLayer { name: String::new(), keys: Vec::new(), values: Vec::new(), features: Vec::new() };
    while let Some((field, wire)) = c.key() {
        match (field, wire) {
            (1, 2) => layer.name = String::from_utf8_lossy(c.bytes()?).into_owned(),
            (2, 2) => layer.features.push(read_feature(c.bytes()?)?),
            (3, 2) => layer.keys.push(String::from_utf8_lossy(c.bytes()?).into_owned()),
            (4, 2) => layer.values.push(read_value(c.bytes()?)?),
            _ => c.skip(wire)?,
        }
    }
    Some(layer)
}

/// Lit une tuile non compressée : ses couches, ou `None` si le protobuf est invalide.
pub fn read_tile(bytes: &[u8]) -> Option<Vec<ReadLayer>> {
    let mut c = Cursor { data: bytes, at: 0 };
    let mut layers = Vec::new();
    while let Some((field, wire)) = c.key() {
        if (field, wire) == (3, 2) {
            layers.push(read_layer(c.bytes()?)?);
        } else {
            c.skip(wire)?;
        }
    }
    Some(layers)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use prost::Message;

    // Décodeur de référence : le schéma `vector_tile.proto`, écrit avec les structures de prost. Ce n'est pas notre
    // encodeur à l'envers : c'est une lecture indépendante du même format.
    #[derive(Clone, PartialEq, Message)]
    pub(crate) struct PTile {
        #[prost(message, repeated, tag = "3")]
        pub(crate) layers: Vec<PLayer>,
    }
    #[derive(Clone, PartialEq, Message)]
    pub(crate) struct PLayer {
        #[prost(uint32, required, tag = "15")]
        pub(crate) version: u32,
        #[prost(string, required, tag = "1")]
        pub(crate) name: String,
        #[prost(message, repeated, tag = "2")]
        pub(crate) features: Vec<PFeature>,
        #[prost(string, repeated, tag = "3")]
        pub(crate) keys: Vec<String>,
        #[prost(message, repeated, tag = "4")]
        pub(crate) values: Vec<PValue>,
        #[prost(uint32, optional, tag = "5")]
        pub(crate) extent: Option<u32>,
    }
    #[derive(Clone, PartialEq, Message)]
    pub(crate) struct PFeature {
        #[prost(uint32, repeated, packed = "true", tag = "2")]
        pub(crate) tags: Vec<u32>,
        #[prost(int32, optional, tag = "3")]
        pub(crate) r#type: Option<i32>,
        #[prost(uint32, repeated, packed = "true", tag = "4")]
        pub(crate) geometry: Vec<u32>,
    }
    #[derive(Clone, PartialEq, Message)]
    pub(crate) struct PValue {
        #[prost(string, optional, tag = "1")]
        pub(crate) string_value: Option<String>,
        #[prost(float, optional, tag = "2")]
        pub(crate) float_value: Option<f32>,
        #[prost(sint64, optional, tag = "6")]
        pub(crate) sint_value: Option<i64>,
        #[prost(bool, optional, tag = "7")]
        pub(crate) bool_value: Option<bool>,
    }

    fn sample_layer() -> TileLayer {
        let square = vec![[10, 10], [110, 10], [110, 110], [10, 110]];
        let hole = vec![[40, 40], [40, 80], [80, 80], [80, 40]]; // sens inverse
        TileLayer {
            name: "test".into(),
            keys: vec!["nom".into(), "n".into(), "ratio".into(), "ok".into()],
            extent: 4096,
            features: vec![
                TileFeature {
                    geom_type: GeomType::Polygon,
                    geometry: polygon_geometry(&[square, hole]),
                    props: vec![Value::Str("carré".into()), Value::Int(-42), Value::Float(0.25), Value::Bool(true)],
                },
                TileFeature {
                    geom_type: GeomType::Point,
                    geometry: point_geometry(-5, 4100),
                    // Mêmes valeurs que l'objet précédent : elles doivent être dédupliquées.
                    props: vec![Value::Str("carré".into()), Value::Int(-42), Value::Float(0.25), Value::Bool(true)],
                },
            ],
        }
    }

    #[test]
    fn aller_retour_avec_un_decodeur_independant() {
        let bytes = encode_tile(&[sample_layer()]);
        let tile = PTile::decode(bytes.as_slice()).expect("protobuf valide");
        assert_eq!(tile.layers.len(), 1);
        let layer = &tile.layers[0];
        assert_eq!((layer.version, layer.name.as_str(), layer.extent), (2, "test", Some(4096)));
        assert_eq!(layer.keys, ["nom", "n", "ratio", "ok"]);
        // Déduplication : 4 valeurs distinctes pour 8 propriétés.
        assert_eq!(layer.values.len(), 4);
        assert_eq!(layer.values[0].string_value.as_deref(), Some("carré"));
        assert_eq!(layer.values[1].sint_value, Some(-42));
        assert_eq!(layer.values[2].float_value, Some(0.25));
        assert_eq!(layer.values[3].bool_value, Some(true));
        assert_eq!(layer.features.len(), 2);
        assert_eq!(layer.features[0].tags, [0, 0, 1, 1, 2, 2, 3, 3]);
        assert_eq!(layer.features[1].tags, layer.features[0].tags);
        assert_eq!(layer.features[0].r#type, Some(3));
        // La géométrie reprend exactement les anneaux (extérieur + trou), coordonnées négatives et hors tuile comprises.
        let rings = decode_geometry(&layer.features[0].geometry);
        assert_eq!(rings, vec![vec![[10, 10], [110, 10], [110, 110], [10, 110]], vec![[40, 40], [40, 80], [80, 80], [80, 40]]]);
        assert_eq!(decode_geometry(&layer.features[1].geometry), vec![vec![[-5, 4100]]]);
    }

    #[test]
    fn notre_lecteur_relit_ce_que_notre_encodeur_ecrit() {
        let bytes = encode_tile(&[sample_layer()]);
        let layers = read_tile(&bytes).expect("tuile lisible");
        assert_eq!(layers.len(), 1);
        let layer = &layers[0];
        assert_eq!((layer.name.as_str(), layer.features.len()), ("test", 2));
        let (nom, n, ratio, ok) = (layer.key("nom").unwrap(), layer.key("n").unwrap(), layer.key("ratio").unwrap(), layer.key("ok").unwrap());
        let f = &layer.features[0];
        assert_eq!(layer.text(f, nom), Some("carré"));
        assert_eq!(layer.number(f, n), -42.0);
        assert_eq!(layer.number(f, ratio), 0.25);
        assert_eq!(layer.number(f, ok), 1.0);
        assert_eq!(f.geom_type, 3);
        assert_eq!(decode_geometry(&layer.features[1].geometry), vec![vec![[-5, 4100]]]);
        assert!(layer.key("absente").is_none());
        // Une tuile tronquée ne fait pas paniquer.
        let _ = read_tile(&bytes[..bytes.len() / 2]);
    }

    #[test]
    fn varint_et_zigzag() {
        let mut v = Vec::new();
        put_varint(&mut v, 300);
        assert_eq!(v, [0xac, 0x02]); // l'exemple de la documentation protobuf
        assert_eq!([zz32(0), zz32(-1), zz32(1), zz32(-2), zz32(2)], [0, 1, 2, 3, 4]);
        assert_eq!(zigzag(-42), 83);
    }

    #[test]
    fn commandes_de_polygone() {
        // Un carré : MoveTo(1), LineTo(3), ClosePath, avec des déplacements relatifs.
        let g = polygon_geometry(&[vec![[2, 2], [5, 2], [5, 5], [2, 5]]]);
        assert_eq!(g[0], 9); // 1 << 3 | 1
        assert_eq!(&g[1..3], &[4, 4]); // (2,2) en zigzag
        assert_eq!(g[3], 3 << 3 | 2);
        assert_eq!(*g.last().unwrap(), 15); // ClosePath
    }
}
