//! Avions en vol au-dessus de la France, d'après les récepteurs ADS-B de la communauté
//! adsb.lol (https://api.adsb.lol, données sous licence ODbL : le crédit est affiché
//! dans la couche).
//!
//! L'API est ouverte et gratuite, sans clé ni limite de débit publiée (la documentation
//! annonce seulement qu'une clé deviendra nécessaire « à l'avenir », et demande de
//! prévenir avant un usage en production). On reste donc discret : trois requêtes
//! à la suite toutes les 10 secondes, et une longue pause si le serveur répond « 429 ».
//!
//! Chaque requête décrit un cercle de 250 milles nautiques (le maximum accepté) ; trois
//! cercles couvrent la métropole, la Corse et les abords. Un avion à la frontière de deux
//! cercles apparaît deux fois : on garde l'observation la plus récente de chaque code ICAO.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://api.adsb.lol/v2/point";
/// Centre (latitude, longitude) et rayon en milles nautiques de chaque requête.
const CIRCLES: [(f64, f64, u32); 3] = [(49.0, 0.5, 250), (44.8, 2.0, 250), (45.0, 8.0, 250)];
/// Le flux de l'API est rafraîchi chaque seconde environ ; 10 s suffisent à la carte, qui
/// extrapole les positions entre deux collectes.
const REFRESH_EVERY: Duration = Duration::from_secs(10);
/// Pause entre deux requêtes d'un même tour, pour ne pas les envoyer en rafale.
const PAUSE_BETWEEN_REQUESTS: Duration = Duration::from_millis(400);
/// Pause quand l'API demande de ralentir (429) ou répond mal.
const BACKOFF: Duration = Duration::from_secs(60);
/// Zone gardée (sud, ouest, nord, est) : France métropolitaine, Corse et abords proches.
const AREA: (f64, f64, f64, f64) = (41.0, -6.0, 51.8, 10.2);
/// Une position plus vieille que cela (secondes) n'est plus fiable : l'avion est perdu de vue.
const MAX_POSITION_AGE_S: f64 = 60.0;

/// Altitude barométrique : un nombre de pieds, ou le texte « ground » au sol.
#[derive(Deserialize)]
#[serde(untagged)]
enum BaroAltitude {
    Feet(f64),
    Text(String),
}

/// Un avion tel que le renvoie adsb.lol (seuls les champs utiles sont lus).
#[derive(Deserialize)]
struct RawAircraft {
    hex: String,
    flight: Option<String>,
    r: Option<String>,
    t: Option<String>,
    category: Option<String>,
    alt_baro: Option<BaroAltitude>,
    alt_geom: Option<f64>,
    gs: Option<f64>,
    track: Option<f64>,
    baro_rate: Option<f64>,
    geom_rate: Option<f64>,
    squawk: Option<String>,
    emergency: Option<String>,
    lat: Option<f64>,
    lon: Option<f64>,
    seen_pos: Option<f64>,
}

#[derive(Deserialize)]
struct RawResponse {
    #[serde(default)]
    ac: Vec<RawAircraft>,
}

/// Un avion tel que le site le reçoit. Les unités sont celles de l'aviation, que le site convertit.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct PlaneOut {
    /// Code ICAO sur 24 bits, en hexadécimal : identifiant stable de l'avion.
    hex: String,
    /// Indicatif d'appel (numéro de vol, par exemple « AFR1234 »).
    #[serde(skip_serializing_if = "Option::is_none")]
    callsign: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    registration: Option<String>,
    /// Code ICAO du type (« A320 », « B738 »…).
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<String>,
    /// Catégorie ADS-B (« A3 » : gros porteur moyen, « A7 » : hélicoptère…).
    #[serde(skip_serializing_if = "Option::is_none")]
    category: Option<String>,
    lon: f64,
    lat: f64,
    /// Altitude barométrique, en pieds (absente au sol).
    #[serde(skip_serializing_if = "Option::is_none")]
    alt_baro: Option<f64>,
    /// Altitude géométrique (GPS), en pieds.
    #[serde(skip_serializing_if = "Option::is_none")]
    alt_geom: Option<f64>,
    /// Vitesse sol, en nœuds.
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<f64>,
    /// Route suivie au sol, en degrés depuis le nord.
    #[serde(skip_serializing_if = "Option::is_none")]
    track: Option<f64>,
    /// Taux de montée (négatif : descente), en pieds par minute.
    #[serde(skip_serializing_if = "Option::is_none")]
    climb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    squawk: Option<String>,
    /// Urgence déclarée par l'avion (« general », « lifeguard », « minfuel »…), si elle l'est.
    #[serde(skip_serializing_if = "Option::is_none")]
    emergency: Option<String>,
    ground: bool,
    /// Âge de la position au moment de la collecte, en secondes.
    seen_pos: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanesOut {
    /// Instant de la collecte (secondes UTC).
    updated_at: i64,
    planes: Vec<PlaneOut>,
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let mut ticker = tokio::time::interval(REFRESH_EVERY);
    // Si un tour dure plus de 10 s, on ne rattrape pas le retard par une rafale de tours.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        match fetch_all(&http).await {
            Ok((body, count)) => {
                info!(avions = count, "avions : positions mises à jour");
                state.set_planes(body);
            }
            Err(error) => {
                // Un tour incomplet n'est pas publié : il ferait disparaître les avions d'un
                // cercle entier. Le site voit l'âge de la dernière collecte réussie.
                warn!("avions : données indisponibles : {error:#}");
                tokio::time::sleep(BACKOFF).await;
            }
        }
    }
}

/// Garde, pour chaque avion, l'observation la plus récente. `answered_s` : l'instant (secondes depuis le début du tour) où
/// adsb.lol a répondu ; `seen_pos` en est l'âge à cet instant. On compare donc des instants d'observation, et non des âges
/// pris à des moments différents (les trois requêtes se suivent à plusieurs secondes d'écart).
fn keep_freshest(best: &mut HashMap<String, (PlaneOut, f64)>, planes: Vec<PlaneOut>, answered_s: f64) {
    for plane in planes {
        let observed_s = answered_s - plane.seen_pos;
        match best.get(&plane.hex) {
            Some((_, known)) if *known >= observed_s => {}
            _ => {
                best.insert(plane.hex.clone(), (plane, observed_s));
            }
        }
    }
}

/// Remet l'âge de chaque position à l'instant `end_s` de la fin du tour, celui que porte `updatedAt` : le site retranche cet
/// âge à l'heure de la collecte pour dater l'observation. Sans cela, un avion relevé par la première requête paraissait
/// plus jeune qu'il n'est de l'écart qui sépare les requêtes (jusqu'à plusieurs secondes, soit plusieurs km à 250 m/s).
fn aged_at(best: HashMap<String, (PlaneOut, f64)>, end_s: f64) -> Vec<PlaneOut> {
    best.into_values()
        .map(|(mut plane, observed_s)| {
            plane.seen_pos = ((end_s - observed_s) * 1000.0).round().max(0.0) / 1000.0;
            plane
        })
        .collect()
}

async fn fetch_all(http: &reqwest::Client) -> Result<(Vec<u8>, usize)> {
    let started = Instant::now();
    let mut best: HashMap<String, (PlaneOut, f64)> = HashMap::new();
    for (i, (lat, lon, radius)) in CIRCLES.into_iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(PAUSE_BETWEEN_REQUESTS).await;
        }
        let response = http.get(format!("{BASE_URL}/{lat}/{lon}/{radius}")).timeout(Duration::from_secs(15)).send().await?;
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            bail!("adsb.lol demande de ralentir (429)");
        }
        let text = response.error_for_status()?.text().await?;
        let answered_s = started.elapsed().as_secs_f64();
        keep_freshest(&mut best, parse(&text).with_context(|| format!("cercle {lat},{lon}"))?, answered_s);
    }
    let mut planes = aged_at(best, started.elapsed().as_secs_f64());
    planes.sort_unstable_by(|a, b| a.hex.cmp(&b.hex)); // réponse stable d'un tour à l'autre
    let count = planes.len();
    let body = serde_json::to_vec(&PlanesOut { updated_at: Timestamp::now().as_second(), planes })?;
    Ok((body, count))
}

/// Décode une réponse et ne garde que les avions positionnés, récents et dans la zone.
fn parse(json: &str) -> Result<Vec<PlaneOut>> {
    let raw: RawResponse = serde_json::from_str(json).context("réponse adsb.lol illisible")?;
    let (south, west, north, east) = AREA;
    let clean = |text: Option<String>| text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());

    let mut planes = Vec::new();
    for a in raw.ac {
        let (Some(lat), Some(lon)) = (a.lat, a.lon) else { continue };
        if !(south..=north).contains(&lat) || !(west..=east).contains(&lon) {
            continue;
        }
        let seen_pos = a.seen_pos.unwrap_or(0.0);
        // Position périmée, ou cible relayée sans code ICAO propre (« ~ » : TIS-B).
        if seen_pos > MAX_POSITION_AGE_S || a.hex.starts_with('~') {
            continue;
        }
        let (alt_baro, ground) = match a.alt_baro {
            Some(BaroAltitude::Feet(feet)) => (Some(feet), false),
            Some(BaroAltitude::Text(text)) => (None, text == "ground"),
            None => (None, false),
        };
        planes.push(PlaneOut {
            hex: a.hex.to_ascii_lowercase(),
            callsign: clean(a.flight),
            registration: clean(a.r),
            kind: clean(a.t),
            category: clean(a.category),
            lon,
            lat,
            alt_baro,
            alt_geom: a.alt_geom,
            speed: a.gs,
            track: a.track,
            climb: a.baro_rate.or(a.geom_rate),
            squawk: clean(a.squawk),
            emergency: clean(a.emergency).filter(|e| e != "none"),
            ground,
            seen_pos,
        });
    }
    Ok(planes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extrait réel d'une réponse (10 novembre 2026) : un avion en croisière, un autre au sol
    /// dont la position a 49 s, et (ajouté) un hors de la zone.
    const SAMPLE: &str = r#"{"msg":"No error","now":1794272392500,"total":3,"ctime":1794272392500,"ptime":0,"ac":[
      {"hex":"4d24cb","type":"adsb_icao","flight":"RYR4AU  ","r":"9H-VVJ","t":"B38M","alt_baro":37000,"alt_geom":37500,"gs":466.4,"ias":256,"track":137.52,"track_rate":-0.03,"baro_rate":-64,"geom_rate":0,"squawk":"2267","emergency":"none","category":"A3","lat":50.423894,"lon":0.408424,"seen_pos":0.366,"mlat":[],"tisb":[],"messages":46555,"seen":0.3,"rssi":-23.4},
      {"hex":"3814BA","type":"adsb_icao","r":"F-WWIR","t":"A20N","alt_baro":"ground","gs":0.1,"squawk":"7776","emergency":"none","lat":43.634399,"lon":1.344979,"seen_pos":49.622,"mlat":[],"tisb":[],"messages":8086,"seen":4.1},
      {"hex":"a1b2c3","flight":"UAL1","alt_baro":35000,"gs":480,"track":90,"lat":55.0,"lon":0.5,"seen_pos":1.0}]}"#;

    #[test]
    fn decode_un_extrait_reel() {
        let planes = parse(SAMPLE).unwrap();
        assert_eq!(planes.len(), 2, "l'avion au-dessus de la mer du Nord est hors zone");
        let ryr = &planes[0];
        assert_eq!(ryr.callsign.as_deref(), Some("RYR4AU"), "espaces de fin retirés");
        assert_eq!((ryr.alt_baro, ryr.alt_geom, ryr.climb), (Some(37000.0), Some(37500.0), Some(-64.0)));
        assert!(!ryr.ground && ryr.emergency.is_none());
        let ground = &planes[1];
        assert!(ground.ground && ground.alt_baro.is_none());
        assert_eq!(ground.hex, "3814ba", "hexadécimal en minuscules");
        assert!(ground.callsign.is_none());
    }

    #[test]
    fn ecarte_les_positions_perimees() {
        let json = r#"{"ac":[{"hex":"abc123","lat":47.0,"lon":2.0,"seen_pos":75.0,"alt_baro":3000}]}"#;
        assert!(parse(json).unwrap().is_empty());
    }

    fn plane(hex: &str, lon: f64, seen_pos: f64) -> PlaneOut {
        PlaneOut {
            hex: hex.into(),
            callsign: None,
            registration: None,
            kind: None,
            category: None,
            lon,
            lat: 47.0,
            alt_baro: None,
            alt_geom: None,
            speed: None,
            track: None,
            climb: None,
            squawk: None,
            emergency: None,
            ground: false,
            seen_pos,
        }
    }

    #[test]
    fn deux_cercles_comparent_des_instants_d_observation() {
        // Cercle 1 (réponse à 0,2 s) : relevé il y a 0,5 s, soit à -0,3 s. Cercle 3 (réponse à 1,6 s) : relevé il y a 1,5 s,
        // soit à +0,1 s : c'est le plus récent, bien que son âge brut soit le plus grand.
        let mut best = HashMap::new();
        keep_freshest(&mut best, vec![plane("a", 1.0, 0.5)], 0.2);
        keep_freshest(&mut best, vec![plane("a", 2.0, 1.5)], 1.6);
        assert_eq!(best["a"].0.lon, 2.0);
        // Un relevé plus ancien arrivé plus tard ne remplace pas le plus récent.
        keep_freshest(&mut best, vec![plane("a", 3.0, 5.0)], 2.0);
        assert_eq!(best["a"].0.lon, 2.0);
    }

    #[test]
    fn l_age_est_ramene_a_la_fin_du_tour() {
        let mut best = HashMap::new();
        keep_freshest(&mut best, vec![plane("a", 1.0, 0.5)], 0.2); // observé à -0,3 s
        keep_freshest(&mut best, vec![plane("b", 1.0, 0.1)], 1.6); // observé à 1,5 s
        let planes = aged_at(best, 2.0);
        let age = |hex: &str| planes.iter().find(|p| p.hex == hex).unwrap().seen_pos;
        assert_eq!((age("a"), age("b")), (2.3, 0.5));
    }

    #[test]
    fn json_servi_est_compact() {
        let planes = parse(SAMPLE).unwrap();
        let json = serde_json::to_string(&planes[1]).unwrap();
        assert!(json.contains("\"ground\":true") && !json.contains("callsign"), "{json}");
    }
}
