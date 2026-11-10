//! Navires : positions AIS en temps réel autour de la France, par le flux WebSocket
//! d'aisstream.io.
//!
//! La clé d'accès est lue dans la variable d'environnement `AISSTREAM_API_KEY` et ne
//! quitte jamais le serveur (aisstream interdit d'ailleurs les connexions depuis un
//! navigateur). Le serveur garde la dernière position et la fiche de chaque navire, et
//! prépare toutes les 10 s la liste servie par `/api/bateaux`.
//!
//! Une position AIS arrive toutes les 2 à 10 s pour un navire en route, toutes les
//! 3 min à quai ou au mouillage : un navire silencieux depuis 30 min est oublié.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tokio_tungstenite::tungstenite::Message;
use tracing::{info, warn};

use crate::state::AppState;

const URL: &str = "wss://stream.aisstream.io/v0/stream";
/// France métropolitaine et ses mers, avec le pas de Calais et la Corse : coins
/// (latitude, longitude), comme l'attend aisstream.
const BOUNDING_BOX: [[f64; 2]; 2] = [[51.6, -6.5], [41.0, 10.0]];
/// Seuls les messages utiles : positions (classes A et B) et fiches des navires.
const MESSAGE_TYPES: [&str; 5] =
    ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"];
const PUBLISH_EVERY: Duration = Duration::from_secs(10);
const FORGET_AFTER_S: i64 = 30 * 60;
/// Sans aucun message pendant ce temps, la connexion est considérée comme morte.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_BACKOFF: Duration = Duration::from_secs(300);

#[derive(Default, Clone)]
struct Ship {
    name: String,
    lon: f64,
    lat: f64,
    /// Vitesse sur le fond (nœuds) et route sur le fond (degrés).
    sog: Option<f32>,
    cog: Option<f32>,
    /// Cap du navire (degrés), s'il est connu (511 = non disponible en AIS).
    heading: Option<u16>,
    /// Statut de navigation AIS (0 en route au moteur, 1 au mouillage, 5 amarré…).
    status: Option<u8>,
    /// Type de navire AIS (70-79 cargo, 80-89 citerne, 60-69 passagers…).
    kind: Option<u8>,
    destination: String,
    call_sign: String,
    imo: Option<u32>,
    /// Longueur et largeur (m), tirant d'eau (m).
    length: Option<u16>,
    width: Option<u16>,
    draught: Option<f32>,
    class_b: bool,
    /// Heure de réception de la dernière position (secondes UTC) ; 0 tant qu'aucune n'est connue.
    at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShipOut<'a> {
    mmsi: u32,
    #[serde(skip_serializing_if = "str::is_empty")]
    name: &'a str,
    lon: f64,
    lat: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    sog: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cog: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    heading: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<u8>,
    #[serde(skip_serializing_if = "str::is_empty")]
    destination: &'a str,
    #[serde(skip_serializing_if = "str::is_empty")]
    call_sign: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    imo: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    length: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    draught: Option<f32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    class_b: bool,
    at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShipsOut<'a> {
    updated_at: i64,
    /// Raison pour laquelle la couche est indisponible (pas de clé…), sinon absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    disabled: Option<&'a str>,
    ships: Vec<ShipOut<'a>>,
}

// --- Messages d'aisstream (seuls les champs utiles) ---

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Envelope {
    message_type: String,
    #[serde(default)]
    meta_data: MetaData,
    #[serde(default)]
    message: serde_json::Map<String, serde_json::Value>,
}

#[derive(Deserialize, Default)]
struct MetaData {
    #[serde(rename = "MMSI", default)]
    mmsi: u32,
    #[serde(rename = "ShipName", default)]
    ship_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Position {
    #[serde(default = "yes")]
    valid: bool,
    latitude: f64,
    longitude: f64,
    sog: Option<f32>,
    cog: Option<f32>,
    true_heading: Option<u16>,
    navigational_status: Option<u8>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct StaticData {
    name: String,
    call_sign: String,
    imo_number: u32,
    #[serde(rename = "Type")]
    kind: u8,
    destination: String,
    dimension: Dimension,
    maximum_static_draught: f32,
}

/// Distances (m) de l'antenne GPS à la proue (A), la poupe (B), bâbord (C) et tribord (D).
#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct Dimension {
    a: u16,
    b: u16,
    c: u16,
    d: u16,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct StaticDataReport {
    report_a: ReportA,
    report_b: ReportB,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ReportA {
    valid: bool,
    name: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "PascalCase", default)]
struct ReportB {
    valid: bool,
    ship_type: u8,
    call_sign: String,
    dimension: Dimension,
}

const fn yes() -> bool {
    true
}

/// Les textes AIS sont complétés par des « @ » ou des espaces.
fn clean(text: &str) -> String {
    text.trim_matches(|c: char| c == '@' || c.is_whitespace()).to_string()
}

impl Dimension {
    fn length(&self) -> Option<u16> {
        let l = self.a + self.b;
        (l > 0).then_some(l)
    }

    fn width(&self) -> Option<u16> {
        let w = self.c + self.d;
        (w > 0).then_some(w)
    }
}

/// Intègre un message du flux. Renvoie faux s'il n'a rien appris d'utile.
fn apply(ships: &mut HashMap<u32, Ship>, envelope: Envelope, now: i64) -> bool {
    let mmsi = envelope.meta_data.mmsi;
    if mmsi == 0 {
        return false;
    }
    let Some(body) = envelope.message.get(&envelope.message_type).cloned() else { return false };
    match envelope.message_type.as_str() {
        "PositionReport" | "StandardClassBPositionReport" | "ExtendedClassBPositionReport" => {
            let Ok(p) = serde_json::from_value::<Position>(body) else { return false };
            // AIS code « inconnu » par 91° de latitude et 181° de longitude.
            if !p.valid || p.latitude.abs() > 90.0 || p.longitude.abs() > 180.0 {
                return false;
            }
            let ship = ships.entry(mmsi).or_default();
            ship.lon = p.longitude;
            ship.lat = p.latitude;
            // 102,3 nœuds et 360° signifient « non disponible ».
            ship.sog = p.sog.filter(|&s| s < 102.2);
            ship.cog = p.cog.filter(|&c| c < 360.0);
            ship.heading = p.true_heading.filter(|&h| h < 360);
            if p.navigational_status.is_some_and(|s| s != 15) {
                ship.status = p.navigational_status;
            }
            ship.class_b = envelope.message_type != "PositionReport";
            ship.at = now;
            if ship.name.is_empty() {
                ship.name = clean(&envelope.meta_data.ship_name);
            }
            true
        }
        "ShipStaticData" => {
            let Ok(s) = serde_json::from_value::<StaticData>(body) else { return false };
            let ship = ships.entry(mmsi).or_default();
            let name = clean(&s.name);
            if !name.is_empty() {
                ship.name = name;
            }
            ship.call_sign = clean(&s.call_sign);
            ship.imo = (s.imo_number > 0).then_some(s.imo_number);
            ship.kind = (s.kind > 0).then_some(s.kind);
            ship.destination = clean(&s.destination);
            ship.length = s.dimension.length();
            ship.width = s.dimension.width();
            ship.draught = (s.maximum_static_draught > 0.0).then_some(s.maximum_static_draught);
            true
        }
        "StaticDataReport" => {
            let Ok(r) = serde_json::from_value::<StaticDataReport>(body) else { return false };
            let ship = ships.entry(mmsi).or_default();
            if r.report_a.valid && !clean(&r.report_a.name).is_empty() {
                ship.name = clean(&r.report_a.name);
            }
            if r.report_b.valid {
                ship.kind = (r.report_b.ship_type > 0).then_some(r.report_b.ship_type);
                ship.call_sign = clean(&r.report_b.call_sign);
                ship.length = r.report_b.dimension.length();
                ship.width = r.report_b.dimension.width();
            }
            true
        }
        _ => false,
    }
}

fn snapshot(ships: &HashMap<u32, Ship>, now: i64) -> Result<Vec<u8>> {
    let out: Vec<ShipOut<'_>> = ships
        .iter()
        // Une fiche sans position (reçue avant la première position) n'est pas encore affichable.
        .filter(|(_, s)| s.at > 0)
        .map(|(&mmsi, s)| ShipOut {
            mmsi,
            name: &s.name,
            lon: s.lon,
            lat: s.lat,
            sog: s.sog,
            cog: s.cog,
            heading: s.heading,
            status: s.status,
            kind: s.kind,
            destination: &s.destination,
            call_sign: &s.call_sign,
            imo: s.imo,
            length: s.length,
            width: s.width,
            draught: s.draught,
            class_b: s.class_b,
            at: s.at,
        })
        .collect();
    Ok(serde_json::to_vec(&ShipsOut { updated_at: now, disabled: None, ships: out })?)
}

/// Reste connecté au flux AIS, en se reconnectant avec une attente croissante.
pub async fn poll_forever(state: AppState) {
    let Some(key) = std::env::var("AISSTREAM_API_KEY").ok().filter(|k| !k.trim().is_empty()) else {
        info!("bateaux : pas de clé AISSTREAM_API_KEY, couche désactivée");
        let body = ShipsOut {
            updated_at: Timestamp::now().as_second(),
            disabled: Some("pas de clé aisstream configurée sur le serveur"),
            ships: Vec::new(),
        };
        if let Ok(body) = serde_json::to_vec(&body) {
            state.set_ships(body);
        }
        return;
    };
    let mut ships: HashMap<u32, Ship> = HashMap::new();
    let mut backoff = Duration::from_secs(2);
    loop {
        match stream(&key, &mut ships, &state).await {
            Ok(()) => warn!("bateaux : flux AIS fermé, reconnexion"),
            Err(error) => warn!("bateaux : flux AIS interrompu : {error:#}"),
        }
        // Attente croissante, avec un peu de hasard pour ne pas revenir pile en même temps qu'un autre client.
        let jitter = Duration::from_millis(u64::from(Timestamp::now().subsec_millisecond().unsigned_abs()));
        tokio::time::sleep(backoff + jitter).await;
        backoff = (backoff * 2).min(MAX_BACKOFF);
        if ships.values().any(|s| Timestamp::now().as_second() - s.at < 60) {
            backoff = Duration::from_secs(2); // la connexion précédente avait marché
        }
    }
}

/// Une connexion au flux, jusqu'à sa fermeture.
async fn stream(key: &str, ships: &mut HashMap<u32, Ship>, state: &AppState) -> Result<()> {
    let (mut socket, _) =
        tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(URL)).await.context("connexion trop longue")??;
    // L'abonnement doit partir dans les 3 s qui suivent la connexion.
    let subscription = serde_json::json!({
        "APIKey": key,
        "BoundingBoxes": [BOUNDING_BOX],
        "FilterMessageTypes": MESSAGE_TYPES,
    });
    socket.send(Message::text(subscription.to_string())).await?;

    let mut publish = tokio::time::interval(PUBLISH_EVERY);
    let mut received = 0u64;
    let mut confirmed = false;
    loop {
        tokio::select! {
            frame = tokio::time::timeout(SILENCE_TIMEOUT, socket.next()) => {
                let Some(frame) = frame.context("aucun message depuis 90 s")? else { return Ok(()) };
                let text = match frame? {
                    Message::Text(text) => text.as_bytes().to_vec(),
                    Message::Binary(bytes) => bytes.to_vec(),
                    Message::Close(reason) => {
                        // Clé refusée, abonnement invalide… : le motif est dans la trame de fermeture.
                        bail!("fermé par aisstream : {}", reason.map(|r| r.reason.to_string()).unwrap_or_default());
                    }
                    _ => continue,
                };
                let Ok(envelope) = serde_json::from_slice::<Envelope>(&text) else {
                    // Une erreur d'abonnement arrive en clair : {"error": "..."}
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&text)
                        && let Some(error) = value.get("error").and_then(|e| e.as_str())
                    {
                        bail!("aisstream : {error}");
                    }
                    continue;
                };
                if envelope.message_type == "SubscriptionConfirmation" {
                    confirmed = true;
                    info!("bateaux : abonné au flux AIS");
                    continue;
                }
                if apply(ships, envelope, Timestamp::now().as_second()) {
                    received += 1;
                }
            }
            _ = publish.tick() => {
                let now = Timestamp::now().as_second();
                ships.retain(|_, s| s.at == 0 || now - s.at <= FORGET_AFTER_S);
                // Une fiche reçue sans jamais de position finit aussi par être oubliée.
                if ships.len() > 50_000 {
                    ships.retain(|_, s| s.at > 0);
                }
                if received > 0 {
                    state.set_ships(snapshot(ships, now)?);
                }
                if received > 0 && !confirmed {
                    confirmed = true; // certains flux n'envoient pas de confirmation
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn position_puis_fiche() {
        // Messages au format d'aisstream (champs documentés dans ais-message-models).
        let position = r#"{"MessageType":"PositionReport","MetaData":{"MMSI":227123456,"ShipName":"PONT AVEN   ","latitude":49.65,"longitude":-1.62,"time_utc":"2026-11-10 02:30:00.0 +0000 UTC"},
            "Message":{"PositionReport":{"Cog":312.4,"Latitude":49.65,"Longitude":-1.62,"MessageID":1,"NavigationalStatus":0,"Sog":17.9,"TrueHeading":311,"UserID":227123456,"Valid":true}}}"#;
        let fiche = r#"{"MessageType":"ShipStaticData","MetaData":{"MMSI":227123456,"ShipName":"PONT AVEN"},
            "Message":{"ShipStaticData":{"CallSign":"FNPA@@@","Destination":"PORTSMOUTH@@@@@@","Dimension":{"A":150,"B":34,"C":15,"D":16},"ImoNumber":9268708,"MaximumStaticDraught":6.8,"Name":"PONT AVEN","Type":60,"UserID":227123456,"Valid":true}}}"#;
        let mut ships = HashMap::new();
        assert!(apply(&mut ships, serde_json::from_str(position).unwrap(), 100));
        assert!(apply(&mut ships, serde_json::from_str(fiche).unwrap(), 101));
        let ship = &ships[&227_123_456];
        assert_eq!(ship.name, "PONT AVEN");
        assert_eq!((ship.lat, ship.lon), (49.65, -1.62));
        assert_eq!(ship.heading, Some(311));
        assert_eq!(ship.kind, Some(60));
        assert_eq!(ship.destination, "PORTSMOUTH");
        assert_eq!(ship.call_sign, "FNPA");
        assert_eq!((ship.length, ship.width), (Some(184), Some(31)));
        assert!(!ship.class_b);
        let json = String::from_utf8(snapshot(&ships, 102).unwrap()).unwrap();
        assert!(json.contains(r#""mmsi":227123456"#) && json.contains(r#""callSign":"FNPA""#));
    }

    #[test]
    fn valeurs_non_disponibles() {
        let position = r#"{"MessageType":"StandardClassBPositionReport","MetaData":{"MMSI":228000001,"ShipName":""},
            "Message":{"StandardClassBPositionReport":{"Cog":360,"Latitude":43.29,"Longitude":5.36,"Sog":102.3,"TrueHeading":511,"Valid":true}}}"#;
        let mut ships = HashMap::new();
        assert!(apply(&mut ships, serde_json::from_str(position).unwrap(), 5));
        let ship = &ships[&228_000_001];
        assert_eq!((ship.sog, ship.cog, ship.heading), (None, None, None));
        assert!(ship.class_b);
    }
}
