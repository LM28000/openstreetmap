//! Lecture des réponses que le serveur sert déjà (`/api/avions`, `/api/bateaux`, `/api/transports`) pour en tirer
//! les observations à enregistrer.
//!
//! Le relevé part de ce que le site reçoit : ce qui est rejoué est exactement ce qui était affiché, sans second
//! contact avec les sources (adsb.lol, aisstream, PRIM…) et sans toucher aux collecteurs. Les champs d'identité
//! (indicatif, nom…) sont rangés à part des mesures, pour n'être écrits qu'une fois par objet et par tronçon.

use serde::Deserialize;

use super::codec::{Layer, MAX_COLS};

/// Une observation : un objet à un instant.
#[derive(Clone, Debug)]
pub struct Obs {
    /// Clé de l'objet dans la couche (les positions estimées d'un transport ne se confondent pas avec les relevées).
    pub key: String,
    pub id: String,
    pub strings: Vec<String>,
    /// 0 = absente, sinon valeur + 1.
    pub numbers: Vec<u32>,
    /// Transports : [descripteur de la ligne, prochain arrêt], rangés dans les tables du tronçon.
    pub refs: [Option<String>; 2],
    /// Instant de la mesure (secondes UNIX).
    pub t: i64,
    pub lon: i32,
    pub lat: i32,
    pub mask: u8,
    pub v: [i32; MAX_COLS],
}

fn quantize_degrees(degrees: f64) -> i32 {
    (degrees * 1e5).round() as i32
}

fn opt(number: Option<u32>) -> u32 {
    number.map_or(0, |n| n + 1)
}

struct Builder {
    mask: u8,
    v: [i32; MAX_COLS],
}

impl Builder {
    fn new() -> Self {
        Self { mask: 0, v: [0; MAX_COLS] }
    }

    fn set(&mut self, column: usize, value: Option<f64>) {
        if let Some(value) = value.filter(|v| v.is_finite()) {
            self.mask |= 1 << column;
            self.v[column] = value.round() as i32;
        }
    }
}

// ───────────────────────── Avions ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanesIn {
    updated_at: i64,
    planes: Vec<PlaneIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlaneIn {
    hex: String,
    callsign: Option<String>,
    registration: Option<String>,
    #[serde(rename = "type")]
    kind: Option<String>,
    category: Option<String>,
    lon: f64,
    lat: f64,
    alt_baro: Option<f64>,
    alt_geom: Option<f64>,
    speed: Option<f64>,
    track: Option<f64>,
    climb: Option<f64>,
    squawk: Option<String>,
    emergency: Option<String>,
    #[serde(default)]
    ground: bool,
    #[serde(default)]
    seen_pos: f64,
}

/// `known` : instant du dernier point déjà enregistré de chaque objet, pour ne pas refaire la même mesure.
pub fn planes(json: &[u8], known: &dyn Fn(&str) -> Option<i64>) -> anyhow::Result<Vec<Obs>> {
    let input: PlanesIn = serde_json::from_slice(json)?;
    let mut out = Vec::with_capacity(input.planes.len());
    for p in input.planes {
        // Instant de la mesure : celui de la collecte moins l'âge de la position (comme le fait le site).
        let t = input.updated_at - p.seen_pos.round() as i64;
        if known(&p.hex).is_some_and(|last| last >= t) {
            continue;
        }
        let mut b = Builder::new();
        b.set(0, p.alt_baro.map(|f| f / 25.0));
        b.set(1, p.alt_geom.map(|f| f / 25.0));
        b.set(2, p.speed);
        b.set(3, p.track);
        b.set(4, p.climb.map(|f| f / 64.0));
        b.set(5, Some(f64::from(u8::from(p.ground))));
        out.push(Obs {
            key: p.hex.clone(),
            id: p.hex,
            strings: [p.callsign, p.registration, p.kind, p.category, p.squawk, p.emergency]
                .into_iter()
                .map(Option::unwrap_or_default)
                .collect(),
            numbers: Vec::new(),
            refs: [None, None],
            t,
            lon: quantize_degrees(p.lon),
            lat: quantize_degrees(p.lat),
            mask: b.mask,
            v: b.v,
        });
    }
    Ok(out)
}

// ───────────────────────── Bateaux ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShipsIn {
    ships: Vec<ShipIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShipIn {
    mmsi: u32,
    #[serde(default)]
    name: String,
    lon: f64,
    lat: f64,
    sog: Option<f64>,
    cog: Option<f64>,
    heading: Option<u32>,
    status: Option<u32>,
    kind: Option<u32>,
    #[serde(default)]
    destination: String,
    #[serde(default)]
    call_sign: String,
    imo: Option<u32>,
    length: Option<u32>,
    width: Option<u32>,
    draught: Option<f64>,
    #[serde(default)]
    class_b: bool,
    at: i64,
}

pub fn ships(json: &[u8], known: &dyn Fn(&str) -> Option<i64>) -> anyhow::Result<Vec<Obs>> {
    let input: ShipsIn = serde_json::from_slice(json)?;
    let mut out = Vec::with_capacity(input.ships.len());
    for s in input.ships {
        let key = s.mmsi.to_string();
        if known(&key).is_some_and(|last| last >= s.at) {
            continue; // le navire n'a pas émis de nouvelle position depuis la dernière collecte
        }
        let mut b = Builder::new();
        b.set(0, s.sog.map(|v| v * 10.0));
        b.set(1, s.cog.map(|v| v * 10.0));
        b.set(2, s.heading.map(f64::from));
        b.set(3, s.status.map(f64::from));
        out.push(Obs {
            key: key.clone(),
            id: key,
            strings: vec![s.name, s.destination, s.call_sign],
            numbers: vec![
                opt(s.kind),
                opt(s.imo),
                opt(s.length),
                opt(s.width),
                opt(s.draught.map(|d| (d * 10.0).round() as u32)),
                u32::from(s.class_b) + 1,
            ],
            refs: [None, None],
            t: s.at,
            lon: quantize_degrees(s.lon),
            lat: quantize_degrees(s.lat),
            mask: b.mask,
            v: b.v,
        });
    }
    Ok(out)
}

// ───────────────────────── Transports ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransitIn {
    networks: Vec<NetworkIn>,
    lines: Vec<LineIn>,
    vehicles: Vec<VehicleIn>,
}

#[derive(Deserialize)]
struct NetworkIn {
    name: String,
    #[serde(default)]
    licence: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LineIn {
    network: usize,
    id: Option<String>,
    name: Option<String>,
    long_name: Option<String>,
    color: Option<String>,
    mode: Option<String>,
}

#[derive(Deserialize)]
struct VehicleIn {
    id: String,
    line: usize,
    lon: f64,
    lat: f64,
    heading: Option<u32>,
    speed: Option<u32>,
    ts: i64,
    est: Option<EstimateIn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EstimateIn {
    #[serde(default)]
    theoretical: bool,
    to: Option<String>,
    next: Option<String>,
    next_at: Option<i64>,
    delay: Option<i32>,
}

/// Une position estimée est recalculée toutes les 10 s : on n'en garde une toutes les 30 s, la route entre deux
/// points se fait par interpolation. Les positions relevées, elles, ne changent que quand le véhicule émet.
const ESTIMATE_EVERY_S: i64 = 30;

pub fn transit(json: &[u8], known: &dyn Fn(&str) -> Option<i64>) -> anyhow::Result<Vec<Obs>> {
    let input: TransitIn = serde_json::from_slice(json)?;
    // Descripteur de chaque ligne : « réseau \t licence \t id \t nom \t nom long \t couleur \t mode ».
    let descriptors: Vec<String> = input
        .lines
        .iter()
        .map(|l| {
            let network = input.networks.get(l.network);
            [
                network.map_or("", |n| n.name.as_str()),
                network.map_or("", |n| n.licence.as_str()),
                l.id.as_deref().unwrap_or(""),
                l.name.as_deref().unwrap_or(""),
                l.long_name.as_deref().unwrap_or(""),
                l.color.as_deref().unwrap_or(""),
                l.mode.as_deref().unwrap_or(""),
            ]
            .join("\t")
        })
        .collect();

    let mut out = Vec::with_capacity(input.vehicles.len() / 2);
    for v in input.vehicles {
        let estimated = v.est.is_some();
        let key = if estimated { format!("~{}", v.id) } else { v.id.clone() };
        let wait = if estimated { ESTIMATE_EVERY_S } else { 1 };
        if known(&key).is_some_and(|last| v.ts - last < wait) {
            continue;
        }
        let mut b = Builder::new();
        b.set(0, v.heading.map(f64::from));
        b.set(1, v.speed.map(f64::from));
        let (nature, to, next) = match &v.est {
            Some(e) => {
                b.set(2, e.delay.map(f64::from));
                b.set(4, e.next_at.map(|t| t as f64));
                (if e.theoretical { 3 } else { 2 }, e.to.clone().unwrap_or_default(), e.next.clone().filter(|_| e.next_at.is_some()))
            }
            None => (1, String::new(), None),
        };
        if next.is_some() {
            b.mask |= 1 << 3; // la valeur est l'indice dans la table des arrêts, posé à l'insertion
        }
        out.push(Obs {
            key,
            id: v.id,
            strings: vec![to],
            numbers: vec![0, nature], // l'indice de ligne est posé à l'insertion, d'après `refs`
            refs: [descriptors.get(v.line).cloned(), next],
            t: v.ts,
            lon: quantize_degrees(v.lon),
            lat: quantize_degrees(v.lat),
            mask: b.mask,
            v: b.v,
        });
    }
    Ok(out)
}

pub fn parse(layer: Layer, json: &[u8], known: &dyn Fn(&str) -> Option<i64>) -> anyhow::Result<Vec<Obs>> {
    match layer {
        Layer::Planes => planes(json, known),
        Layer::Ships => ships(json, known),
        Layer::Transit => transit(json, known),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn avions_instant_et_quantification() {
        let json = br#"{"updatedAt":1000,"planes":[
          {"hex":"4d24cb","callsign":"RYR4AU","type":"B38M","lon":0.408424,"lat":50.423894,"altBaro":37000,"altGeom":37500,"speed":466.4,"track":137.52,"climb":-64,"ground":false,"seenPos":0.4},
          {"hex":"3814ba","lon":1.34,"lat":43.63,"ground":true,"seenPos":49.6}]}"#;
        let known: HashMap<String, i64> = HashMap::new();
        let lookup = |k: &str| known.get(k).copied();
        let obs = planes(json, &lookup).unwrap();
        assert_eq!(obs.len(), 2);
        assert_eq!(obs[0].t, 1000);
        assert_eq!((obs[0].lon, obs[0].lat), (40842, 5042389));
        assert_eq!((obs[0].v[0], obs[0].v[1], obs[0].v[2], obs[0].v[3], obs[0].v[4]), (1480, 1500, 466, 138, -1));
        assert_eq!(obs[0].mask, 0b111111);
        assert_eq!(obs[1].t, 950);
        assert_eq!(obs[1].mask, 0b100000, "au sol : seule la colonne « au sol » est présente");
        let mut known = HashMap::new();
        known.insert("4d24cb".to_string(), 1000);
        let lookup = |k: &str| known.get(k).copied();
        assert_eq!(planes(json, &lookup).unwrap().len(), 1, "une mesure déjà enregistrée est ignorée");
    }

    /// Données synthétiques : sans clé aisstream, la couche des bateaux ne se teste pas autrement.
    #[test]
    fn bateaux_donnees_synthetiques() {
        let json = br#"{"updatedAt":2000,"ships":[
          {"mmsi":227123456,"name":"BRETAGNE","lon":-4.48,"lat":48.38,"sog":17.3,"cog":212.5,"heading":210,"status":0,"kind":60,"destination":"ROSCOFF","callSign":"FNBA","imo":9171634,"length":165,"width":27,"draught":6.5,"at":1995},
          {"mmsi":2275001,"lon":2.0,"lat":51.0,"classB":true,"at":1990}]}"#;
        let known = HashMap::from([("2275001".to_string(), 1990)]);
        let obs = ships(json, &|k: &str| known.get(k).copied()).unwrap();
        assert_eq!(obs.len(), 1, "le second navire n'a pas émis depuis");
        let s = &obs[0];
        assert_eq!(s.id, "227123456");
        assert_eq!((s.v[0], s.v[1], s.v[2], s.v[3]), (173, 2125, 210, 0));
        assert_eq!(s.strings, vec!["BRETAGNE", "ROSCOFF", "FNBA"]);
        assert_eq!(s.numbers, vec![61, 9_171_635, 166, 28, 66, 1]);
        assert_eq!(s.t, 1995);
    }

    #[test]
    fn transports_releves_et_estimes() {
        let json = br#"{"updatedAt":3000,"estStep":10,
          "networks":[{"name":"TAN","licence":"ODbL"}],
          "lines":[{"network":0,"id":"1","name":"1","longName":"Ligne 1","color":"00ff00","mode":"tram"}],
          "vehicles":[
            {"id":"a","line":0,"lon":-1.55,"lat":47.21,"heading":90,"speed":30,"ts":2990},
            {"id":"a","line":0,"lon":-1.56,"lat":47.22,"ts":3000,"est":{"to":"Orvault","next":"Commerce","nextAt":3060,"delay":45,"path":[1,2]}},
            {"id":"b","line":0,"lon":-1.0,"lat":47.0,"ts":3000,"est":{"theoretical":true,"path":[]}}]}"#;
        let known = HashMap::from([("~b".to_string(), 2990)]);
        let obs = transit(json, &|k: &str| known.get(k).copied()).unwrap();
        assert_eq!(obs.len(), 2, "b a déjà été enregistré il y a moins de 30 s");
        assert_eq!(obs[0].key, "a");
        assert_eq!(obs[1].key, "~a", "la position estimée d'un véhicule n'écrase pas la relevée");
        assert_eq!(obs[1].numbers, vec![0, 2]);
        assert_eq!(obs[1].mask, 0b11100);
        assert_eq!(obs[1].v[2], 45);
        assert_eq!(obs[1].refs[1].as_deref(), Some("Commerce"));
        assert_eq!(obs[0].refs[0].as_deref(), Some("TAN\tODbL\t1\t1\tLigne 1\t00ff00\ttram"));
    }
}
