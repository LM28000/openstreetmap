//! Avions en vol au-dessus de la France, d'après les récepteurs ADS-B de la communauté
//! adsb.lol (https://api.adsb.lol, données sous licence ODbL : le crédit est affiché
//! dans la couche).
//!
//! L'API est ouverte et gratuite, sans clé ni limite de débit publiée (la documentation
//! annonce seulement qu'une clé deviendra nécessaire « à l'avenir », et demande de
//! prévenir avant un usage en production ; le README de l'API parle de limites « dynamiques selon la charge »). On reste donc
//! discret : une requête à la fois, un cercle après l'autre toutes les 5 s. À 3,3 s (18 requêtes par minute), l'API
//! refusait une requête en « 429 » presque exactement chaque minute : un quota par minute, dépassé de peu.
//!
//! Quand adsb.lol refuse ou échoue, le même cercle est demandé aussitôt à adsb.fi (https://opendata.adsb.fi, même format
//! readsb, usage personnel non commercial, une requête par seconde au plus), et adsb.fi sert les tours suivants tant que
//! dure la pause demandée par adsb.lol (`Retry-After`). Les cercles déjà obtenus restent publiés pendant ce temps.
//!
//! Chaque requête décrit un cercle de 250 milles nautiques (le maximum accepté) ; trois
//! cercles couvrent la métropole, la Corse et les abords. Un avion à la frontière de deux
//! cercles apparaît deux fois : on garde l'observation la plus récente de chaque code ICAO.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://api.adsb.lol/v2/point";
/// Source de secours, même format (la liste s'appelle `aircraft` et non `ac`).
const FALLBACK_URL: &str = "https://opendata.adsb.fi/api/v2";
/// Pause d'adsb.lol après un refus sans `Retry-After` : adsb.fi sert les cercles pendant ce temps.
const LOL_PAUSE_DEFAULT: Duration = Duration::from_secs(15);
/// Centre (latitude, longitude) et rayon en milles nautiques de chaque requête.
const CIRCLES: [(f64, f64, u32); 3] = [(49.0, 0.5, 250), (44.8, 2.0, 250), (45.0, 8.0, 250)];
/// Intervalle entre deux requêtes : chacun des trois cercles est relu toutes les 15 s, un seul à la fois, régulièrement
/// espacés (5 s, soit 12 requêtes par minute). La carte extrapole les positions entre deux relevés.
const SLOT: Duration = Duration::from_secs(5);
/// Recul après un refus ou un échec : 2 s, 4 s, 8 s, puis 12 s au plus (jamais de trou de plus de 20 s dans les données).
const BACKOFF_BASE: Duration = Duration::from_secs(2);
const BACKOFF_MAX: Duration = Duration::from_secs(12);
/// Plafond du `Retry-After` suivi : au-delà, la collecte laisserait plus de 20 s sans publication.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(19);
/// Après un 429, l'intervalle s'allonge de 25 % (jusqu'au double), puis revient de 2 % à chaque réussite.
const STRETCH_GROWTH: f64 = 1.25;
const STRETCH_DECAY: f64 = 0.98;
const MAX_STRETCH: f64 = 2.0;
/// Un cercle sans réponse depuis plus de cela n'est plus fusionné : ses avions disparaissent de la carte.
const STALE_CIRCLE: Duration = Duration::from_secs(40);
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
    #[serde(default, alias = "aircraft")]
    ac: Vec<RawAircraft>,
}

/// Un avion tel que le site le reçoit. Les unités sont celles de l'aviation, que le site convertit.
#[derive(Serialize, Debug, Clone)]
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

/// Dernier relevé d'un cercle : ses avions et l'instant de la réponse.
struct Snapshot {
    planes: Vec<PlaneOut>,
    answered: Instant,
}

/// Une requête refusée ou en échec. `retry_after` : le délai que l'API demande, s'il l'a donné.
struct Refusal {
    too_many: bool,
    retry_after: Option<Duration>,
    error: anyhow::Error,
}

impl From<anyhow::Error> for Refusal {
    fn from(error: anyhow::Error) -> Self {
        Refusal { too_many: false, retry_after: None, error }
    }
}

impl From<reqwest::Error> for Refusal {
    fn from(error: reqwest::Error) -> Self {
        Refusal { too_many: false, retry_after: None, error: error.into() }
    }
}

/// Cadence des requêtes : une seule à la fois, un cercle après l'autre, régulièrement espacées (au lieu de trois requêtes
/// en rafale toutes les 10 s, que l'API refusait). Le rythme se ralentit un peu après un refus et revient peu à peu.
#[derive(Debug, Clone, PartialEq)]
struct Pacer {
    /// Facteur d'allongement de l'intervalle entre deux requêtes (1 = cadence normale).
    stretch: f64,
    /// Refus ou échecs consécutifs.
    failures: u32,
}

impl Pacer {
    fn new() -> Self {
        Pacer { stretch: 1.0, failures: 0 }
    }

    fn success(&mut self) {
        self.failures = 0;
        self.stretch = (self.stretch * STRETCH_DECAY).max(1.0);
    }

    fn failure(&mut self, too_many: bool) {
        self.failures += 1;
        if too_many {
            self.stretch = (self.stretch * STRETCH_GROWTH).min(MAX_STRETCH);
        }
    }

    /// Attente avant la prochaine requête. `took` : durée de la requête qui vient de finir (l'intervalle se compte d'un
    /// départ à l'autre). Après un échec : recul court et progressif, ou le `Retry-After` de l'API s'il est plus long.
    fn wait(&self, took: Duration, retry_after: Option<Duration>) -> Duration {
        if self.failures == 0 {
            return SLOT.mul_f64(self.stretch).saturating_sub(took);
        }
        let backoff = (BACKOFF_BASE * 2u32.pow((self.failures - 1).min(6))).min(BACKOFF_MAX);
        let asked = retry_after.map(|r| r.min(RETRY_AFTER_MAX)).unwrap_or_default();
        backoff.max(asked)
    }
}

/// Lit l'en-tête `Retry-After` : un nombre de secondes (une date HTTP n'est pas gérée : on la traite comme absente).
fn parse_retry_after(value: &str) -> Option<Duration> {
    let seconds: f64 = value.trim().parse().ok()?;
    (seconds.is_finite() && (0.0..=86_400.0).contains(&seconds)).then(|| Duration::from_secs_f64(seconds))
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let mut snapshots: [Option<Snapshot>; CIRCLES.len()] = std::array::from_fn(|_| None);
    let mut pacer = Pacer::new();
    let mut next = 0;
    let mut refusals = 0u32;
    // Tant qu'adsb.lol demande une pause, les cercles viennent d'adsb.fi.
    let mut lol_paused_until: Option<Instant> = None;
    loop {
        let started = Instant::now();
        let mut retry_after = None;
        let lol_paused = lol_paused_until.is_some_and(|until| started < until);
        let result = if lol_paused {
            fetch_from(&http, Source::Fallback, next).await
        } else {
            match fetch_from(&http, Source::Lol, next).await {
                Ok(planes) => Ok(planes),
                Err(refusal) => {
                    if refusal.too_many {
                        refusals += 1;
                    }
                    let pause = refusal.retry_after.unwrap_or(LOL_PAUSE_DEFAULT).min(Duration::from_secs(120));
                    lol_paused_until = Some(Instant::now() + pause);
                    warn!(refus_429 = refusals, "avions : adsb.lol indisponible pour le cercle {next} ({:#}) : adsb.fi pendant {pause:?}", refusal.error);
                    fetch_from(&http, Source::Fallback, next).await
                }
            }
        };
        match result {
            Ok(planes) => {
                snapshots[next] = Some(Snapshot { planes, answered: Instant::now() });
                next = (next + 1) % CIRCLES.len();
                pacer.success();
            }
            Err(refusal) => {
                // Les deux sources ont échoué. On garde les cercles déjà obtenus (ils vieillissent, voir `merge`) et on
                // retente le même cercle après un recul court.
                pacer.failure(refusal.too_many);
                retry_after = refusal.retry_after;
                warn!("avions : cercle {next} indisponible (adsb.lol et adsb.fi) : {:#}", refusal.error);
            }
        }
        // Publié aussi après un refus : les avions des cercles déjà obtenus sont republiés avec leur âge à jour, et le site
        // voit une collecte récente (`updatedAt`) au lieu d'un trou.
        if snapshots.iter().any(Option::is_some) {
            match merge(&snapshots, Instant::now()) {
                Ok((body, count)) => {
                    debug!(avions = count, "avions : positions mises à jour");
                    state.set_planes(body);
                }
                Err(error) => warn!("avions : publication impossible : {error:#}"),
            }
        }
        tokio::time::sleep(pacer.wait(started.elapsed(), retry_after)).await;
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

/// D'où vient un cercle : adsb.lol, ou adsb.fi en secours.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Source {
    Lol,
    Fallback,
}

impl Source {
    fn name(self) -> &'static str {
        match self {
            Source::Lol => "adsb.lol",
            Source::Fallback => "adsb.fi",
        }
    }

    fn url(self, (lat, lon, radius): (f64, f64, u32)) -> String {
        match self {
            Source::Lol => format!("{BASE_URL}/{lat}/{lon}/{radius}"),
            Source::Fallback => format!("{FALLBACK_URL}/lat/{lat}/lon/{lon}/dist/{radius}"),
        }
    }
}

async fn fetch_from(http: &reqwest::Client, source: Source, index: usize) -> Result<Vec<PlaneOut>, Refusal> {
    let (lat, lon, _) = CIRCLES[index];
    let response = http.get(source.url(CIRCLES[index])).timeout(Duration::from_secs(15)).send().await?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_after = response.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(parse_retry_after);
        let name = source.name();
        return Err(Refusal { too_many: true, retry_after, error: anyhow::anyhow!("{name} demande de ralentir (429, Retry-After {retry_after:?})") });
    }
    let text = response.error_for_status()?.text().await?;
    Ok(parse(&text).with_context(|| format!("cercle {lat},{lon}"))?)
}

/// Fusionne les derniers relevés encore valables des cercles, au moment `now` : l'observation la plus récente de chaque avion,
/// l'âge de sa position ramené à `now`. Un cercle sans réponse depuis plus de `STALE_CIRCLE` est écarté.
fn merge(snapshots: &[Option<Snapshot>], now: Instant) -> Result<(Vec<u8>, usize)> {
    let mut best: HashMap<String, (PlaneOut, f64)> = HashMap::new();
    for snapshot in snapshots.iter().flatten() {
        let ago = now.saturating_duration_since(snapshot.answered);
        if ago > STALE_CIRCLE {
            continue;
        }
        keep_freshest(&mut best, snapshot.planes.clone(), -ago.as_secs_f64());
    }
    let mut planes: Vec<PlaneOut> = aged_at(best, 0.0).into_iter().filter(|p| p.seen_pos <= MAX_POSITION_AGE_S).collect();
    planes.sort_unstable_by(|a, b| a.hex.cmp(&b.hex)); // réponse stable d'un relevé à l'autre
    let count = planes.len();
    let body = serde_json::to_vec(&PlanesOut { updated_at: Timestamp::now().as_second(), planes })?;
    Ok((body, count))
}

/// Décode une réponse et ne garde que les avions positionnés, récents et dans la zone.
fn parse(json: &str) -> Result<Vec<PlaneOut>> {
    let raw: RawResponse = serde_json::from_str(json).context("réponse illisible")?;
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
    fn decode_une_reponse_adsb_fi() {
        // adsb.fi : même format readsb, mais la liste s'appelle `aircraft`.
        let fi = SAMPLE.replacen("\"ac\":[", "\"aircraft\":[", 1);
        assert_eq!(parse(&fi).unwrap().len(), 2);
        assert_eq!(Source::Fallback.url((49.0, 0.5, 250)), "https://opendata.adsb.fi/api/v2/lat/49/lon/0.5/dist/250");
        assert_eq!(Source::Lol.url((49.0, 0.5, 250)), "https://api.adsb.lol/v2/point/49/0.5/250");
    }

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

    const S: fn(u64) -> Duration = Duration::from_secs;

    #[test]
    fn les_requetes_sont_espacees_regulierement() {
        let pacer = Pacer::new();
        // Une requête de 0,4 s : on attend le reste de l'intervalle, de départ à départ.
        let wait = pacer.wait(Duration::from_millis(400), None);
        assert_eq!(wait + Duration::from_millis(400), SLOT);
        // 12 requêtes par minute au plus (à 18, adsb.lol refusait une requête par minute) ; chaque cercle relu toutes les 15 s.
        assert!(Duration::from_secs(60).as_secs_f64() / SLOT.as_secs_f64() <= 12.0);
        assert_eq!(SLOT * 3, S(15));
        // Une requête plus longue que l'intervalle n'est pas suivie d'une attente.
        assert_eq!(pacer.wait(S(5), None), Duration::ZERO);
    }

    #[test]
    fn le_recul_est_court_et_progressif() {
        let mut pacer = Pacer::new();
        let mut waits = Vec::new();
        for _ in 0..8 {
            pacer.failure(true);
            waits.push(pacer.wait(Duration::from_millis(300), None));
        }
        assert_eq!(waits[..4], [S(2), S(4), S(8), S(12)], "doublé puis plafonné");
        assert!(waits.iter().all(|w| *w <= S(12)), "{waits:?}");
        // Un succès remet le recul à zéro.
        pacer.success();
        assert_eq!(pacer.failures, 0);
        assert!(pacer.wait(Duration::from_millis(300), None) <= SLOT.mul_f64(MAX_STRETCH), "plus de recul : retour à l'intervalle normal");
    }

    #[test]
    fn retry_after_est_suivi_mais_plafonne() {
        let mut pacer = Pacer::new();
        pacer.failure(true);
        assert_eq!(pacer.wait(Duration::ZERO, Some(S(5))), S(5), "plus long que le recul de 2 s");
        assert_eq!(pacer.wait(Duration::ZERO, Some(S(1))), S(2), "plus court : le recul court s'applique");
        assert_eq!(pacer.wait(Duration::ZERO, Some(S(300))), RETRY_AFTER_MAX, "plafonné pour ne pas laisser de trou de plus de 20 s");
    }

    #[test]
    fn lecture_de_retry_after() {
        assert_eq!(parse_retry_after("3"), Some(S(3)));
        assert_eq!(parse_retry_after(" 1.5 "), Some(Duration::from_millis(1500)));
        assert_eq!(parse_retry_after("0"), Some(Duration::ZERO));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2026 07:28:00 GMT"), None, "date HTTP non gérée");
        assert_eq!(parse_retry_after("-4"), None);
        assert_eq!(parse_retry_after("inf"), None);
        assert_eq!(parse_retry_after(""), None);
    }

    #[test]
    fn apres_des_refus_le_rythme_ralentit_puis_revient() {
        let mut pacer = Pacer::new();
        for _ in 0..10 {
            pacer.failure(true);
        }
        assert_eq!(pacer.stretch, MAX_STRETCH, "au plus le double de l'intervalle");
        // Un échec autre qu'un 429 (délai dépassé…) recule mais ne ralentit pas la cadence.
        let mut other = Pacer::new();
        other.failure(false);
        assert_eq!(other.stretch, 1.0);
        for _ in 0..200 {
            pacer.success();
        }
        assert_eq!(pacer.stretch, 1.0);
        // Même au plus lent, chaque cercle est relu bien avant d'être écarté (`STALE_CIRCLE`).
        assert!(SLOT.mul_f64(MAX_STRETCH) * 3 < STALE_CIRCLE);
    }

    #[test]
    fn le_pire_trou_reste_sous_20_s() {
        // Les trois cercles répondent chacun toutes les 10 s ; en cas de 429 à la suite, le recul est plafonné à 12 s.
        assert!(BACKOFF_MAX + Duration::from_secs(8) <= S(20), "recul plafonné + temps d'une requête");
        assert!(BACKOFF_MAX <= S(20) && RETRY_AFTER_MAX <= S(20));
    }

    fn snapshot(planes: Vec<PlaneOut>, seconds_ago: u64) -> Option<Snapshot> {
        Some(Snapshot { planes, answered: Instant::now().checked_sub(S(seconds_ago)).unwrap() })
    }

    fn merged(snapshots: &[Option<Snapshot>]) -> Vec<(String, f64)> {
        let (body, count) = merge(snapshots, Instant::now()).unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let planes = json["planes"].as_array().unwrap();
        assert_eq!(planes.len(), count);
        planes.iter().map(|p| (p["hex"].as_str().unwrap().to_string(), p["seenPos"].as_f64().unwrap())).collect()
    }

    #[test]
    fn un_cercle_refuse_garde_ses_derniers_avions() {
        // Le cercle 2 n'a pas répondu depuis 12 s (refus) : ses avions restent, plus âgés de 12 s.
        let snapshots = [snapshot(vec![plane("a", 1.0, 1.0)], 2), snapshot(vec![plane("b", 2.0, 3.0)], 12), None];
        let planes = merged(&snapshots);
        assert_eq!(planes.len(), 2);
        let age = |hex: &str| planes.iter().find(|(h, _)| h == hex).unwrap().1;
        assert!((age("a") - 3.0).abs() < 0.1, "{planes:?}");
        assert!((age("b") - 15.0).abs() < 0.1, "{planes:?}");
    }

    #[test]
    fn un_cercle_trop_ancien_est_ecarte() {
        let snapshots = [snapshot(vec![plane("a", 1.0, 1.0)], 2), snapshot(vec![plane("b", 2.0, 1.0)], 41), snapshot(vec![plane("c", 3.0, 30.0)], 35)];
        let planes = merged(&snapshots);
        let hexes: Vec<_> = planes.iter().map(|(h, _)| h.as_str()).collect();
        assert_eq!(hexes, ["a"], "b : cercle trop ancien ; c : position de plus de 60 s une fois vieillie");
    }

    #[test]
    fn json_servi_est_compact() {
        let planes = parse(SAMPLE).unwrap();
        let json = serde_json::to_string(&planes[1]).unwrap();
        assert!(json.contains("\"ground\":true") && !json.contains("callsign"), "{json}");
    }
}
