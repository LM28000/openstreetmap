//! Marées et niveau de la mer : les marégraphes du réseau REFMAR (Shom et partenaires), en temps réel.
//!
//! # La source
//!
//! Le Shom diffuse les observations des marégraphes sur data.shom.fr, sans clé, en JSON :
//! `https://services.data.shom.fr/maregraphie/observation/json/<station>?sources=<n>&dtStart=…&dtEnd=…`.
//! Licence : Licence Ouverte 2.0 (Etalab), crédit « Shom, REFMAR ». Les sources utilisées :
//! - `1` : brut haute fréquence, une mesure par minute, quelques minutes de retard (le temps réel) ;
//! - `2` : brut temps différé, une mesure toutes les 10 minutes, jusqu'à la veille (pour estimer les marées).
//!
//! Ces mesures sont brutes : ni validées ni expertisées. Les hauteurs sont en mètres au-dessus du zéro hydrographique
//! (le « zéro des cartes marines »), pas du niveau moyen de la mer.
//!
//! # Les marées prévues ne sont pas ouvertes
//!
//! Les prédictions officielles du Shom (annuaire des marées, maree.shom.fr) ne sont pas en données ouvertes. On ne les
//! utilise pas. À la place, **une estimation** : pour chaque port où la marée est nette, on ajuste sur les 29 derniers jours
//! d'observations les sept composantes harmoniques qui font l'essentiel de la marée (M2, S2, N2, K1, O1, M4, MS4), puis
//! on prolonge la courbe. Comparée aux observations des deux jours suivants, l'estimation a retrouvé les heures des pleines
//! et basses mers à 7–15 minutes près et leurs hauteurs à 0,25–0,35 m près en Manche et Atlantique (voir README). Elle
//! ignore la météo (surcote, dépression) : c'est annoncé comme une estimation, jamais comme la prédiction du Shom.
//!
//! # Ce que garde le serveur
//!
//! Par station : 48 heures de mesures, en médianes de 10 minutes (quelques centaines de valeurs), et les constantes
//! harmoniques. Le tout tient en moins d'un mégaoctet.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures_util::future::join_all;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://services.data.shom.fr/maregraphie/observation/json";
/// Les stations retenues : celles de la France métropolitaine dont les mesures arrivent en continu (une par port,
/// les doublons d'un même site écartés). Voir le README pour la façon de la refaire.
const STATIONS: &str = include_str!("tides_stations.json");

/// Pas des valeurs gardées, en secondes.
const BUCKET_S: i64 = 600;
/// Durée gardée et envoyée au site.
const KEEP_S: i64 = 48 * 3600;
const REFRESH_EVERY: Duration = Duration::from_secs(10 * 60);
/// Nombre de requêtes en même temps : le service du Shom n'est pas fait pour les rafales.
const PARALLEL: usize = 4;
/// Durée des observations qui servent à ajuster les composantes harmoniques.
const FIT_DAYS: i64 = 29;
/// L'ajustement est refait une fois par jour (et retenté toutes les 6 heures s'il a échoué).
const FIT_EVERY_S: i64 = 20 * 3600;
const FIT_RETRY_S: i64 = 6 * 3600;
/// Pas des échantillons de l'ajustement et de la courbe prévue.
const FIT_STEP_S: i64 = 1800;
const FORECAST_HOURS: i64 = 36;
/// En dessous de cette amplitude de M2 (mètres), la marée est trop faible pour qu'on l'estime : la Méditerranée.
const MIN_M2_AMPLITUDE: f64 = 0.25;
/// Mesures de l'ajustement (au pas de 30 min) en dessous desquelles on renonce : environ 14,5 jours.
const MIN_FIT_SAMPLES: usize = 700;
/// Au-delà de cet écart quadratique moyen (mètres) entre l'ajustement et les observations, on ne prédit pas.
const MAX_FIT_RMS: f64 = 0.6;

/// Composantes retenues, avec leur vitesse angulaire en degrés par heure.
const CONSTITUENTS: [(&str, f64); 7] = [
    ("M2", 28.984_104_2),
    ("S2", 30.0),
    ("N2", 28.439_729_5),
    ("K1", 15.041_068_6),
    ("O1", 13.943_035_6),
    ("M4", 57.968_208_4),
    ("MS4", 58.984_104_2),
];
const UNKNOWNS: usize = 1 + 2 * CONSTITUENTS.len();

#[derive(Deserialize)]
struct StationDef {
    id: u32,
    nom: String,
    lon: f64,
    lat: f64,
}

/// Les constantes harmoniques d'un port : `hauteur(t) = moyenne + Σ (a·cos ωt + b·sin ωt)`, `t` en heures depuis `t0`.
#[derive(Clone, Debug)]
struct Harmonics {
    t0: i64,
    coefficients: [f64; UNKNOWNS],
    /// Amplitude de M2, en mètres : la mesure de la force de la marée du port.
    m2: f64,
    rms: f64,
}

impl Harmonics {
    fn at(&self, t: i64) -> f64 {
        let hours = (t - self.t0) as f64 / 3600.0;
        let mut height = self.coefficients[0];
        for (k, (_, speed)) in CONSTITUENTS.iter().enumerate() {
            let angle = (speed * hours).to_radians();
            height += self.coefficients[1 + 2 * k] * angle.cos() + self.coefficients[2 + 2 * k] * angle.sin();
        }
        height
    }
}

struct Gauge {
    def: StationDef,
    /// Médianes de 10 minutes : clé = `ts / BUCKET_S`.
    buckets: BTreeMap<i64, f32>,
    /// La dernière mesure brute (heure, mètres).
    latest: Option<(i64, f32)>,
    harmonics: Option<Harmonics>,
    /// Dernière tentative d'ajustement, réussie ou non.
    fit_attempt: i64,
}

// --- Ce que reçoit le site ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Extreme {
    /// Pleine mer (`true`) ou basse mer.
    high: bool,
    time: i64,
    /// Mètres au-dessus du zéro hydrographique.
    height: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GaugeOut<'a> {
    id: u32,
    name: &'a str,
    lon: f64,
    lat: f64,
    /// Dernière mesure : mètres au-dessus du zéro hydrographique et son heure (secondes UTC).
    level: f64,
    time: i64,
    /// Variation en mètres par heure sur la dernière demi-heure (positive : la mer monte).
    rate: f64,
    /// Plus bas et plus haut niveaux des 48 dernières heures.
    min: f64,
    max: f64,
    /// Y a-t-il une vraie marée ? (marnage de plus de 0,8 m sur 48 h).
    tidal: bool,
    /// Les 48 dernières heures, en centimètres, une valeur par `series_step` secondes à partir de `series_start` (trou : `null`).
    series_start: i64,
    series_step: i64,
    series: Vec<Option<i32>>,
    /// Pleines et basses mers observées (les plus anciennes d'abord).
    extremes: Vec<Extreme>,
    /// Estimation (analyse harmonique) : courbe en centimètres au pas de `forecast_step`, et prochaines pleines et basses mers.
    forecast_start: i64,
    forecast_step: i64,
    forecast: Vec<i32>,
    next: Vec<Extreme>,
    /// Amplitude de M2 d'après l'ajustement et écart quadratique de l'ajustement (mètres), quand il y en a un.
    #[serde(skip_serializing_if = "Option::is_none")]
    fit_rms: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TidesOut<'a> {
    updated_at: i64,
    gauges: Vec<GaugeOut<'a>>,
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let defs: Vec<StationDef> = match serde_json::from_str(STATIONS) {
        Ok(defs) => defs,
        Err(error) => {
            warn!("marées : liste des stations illisible : {error}");
            return;
        }
    };
    let mut gauges: Vec<Gauge> = defs
        .into_iter()
        .map(|def| Gauge { def, buckets: BTreeMap::new(), latest: None, harmonics: None, fit_attempt: 0 })
        .collect();
    loop {
        refresh_observations(&http, &mut gauges).await;
        publish(&state, &gauges);
        // Les estimations demandent 29 jours d'observations par port : après les observations, pour que la couche s'affiche tout de suite.
        if refresh_harmonics(&http, &mut gauges).await > 0 {
            publish(&state, &gauges);
        }
        tokio::time::sleep(REFRESH_EVERY).await;
    }
}

fn publish(state: &AppState, gauges: &[Gauge]) {
    let now = Timestamp::now().as_second();
    let out: Vec<GaugeOut> = gauges.iter().filter_map(|g| gauge_out(g, now)).collect();
    if out.is_empty() {
        return;
    }
    let count = out.len();
    match serde_json::to_vec(&TidesOut { updated_at: now, gauges: out }) {
        Ok(body) => {
            info!(marégraphes = count, octets = body.len(), "marées : niveaux mis à jour");
            state.set_tides(body);
        }
        Err(error) => warn!("marées : réponse impossible à écrire : {error}"),
    }
}

/// Demande les dernières mesures de chaque marégraphe : 48 h la première fois, ensuite ce qui manque.
async fn refresh_observations(http: &reqwest::Client, gauges: &mut [Gauge]) {
    let now = Timestamp::now().as_second();
    let mut failures = 0;
    for chunk in gauges.chunks_mut(PARALLEL) {
        let results = join_all(chunk.iter().map(|gauge| {
            let from = match gauge.buckets.keys().next_back() {
                Some(last) => ((last - 2) * BUCKET_S).max(now - KEEP_S),
                None => now - KEEP_S,
            };
            fetch(http, gauge.def.id, 1, from, now + 3600)
        }))
        .await;
        for (gauge, result) in chunk.iter_mut().zip(results) {
            match result {
                Ok(samples) => gauge.add_observations(&samples, now),
                Err(error) => {
                    failures += 1;
                    warn!(station = gauge.def.id, nom = %gauge.def.nom, "marées : mesures indisponibles : {error:#}");
                }
            }
        }
    }
    if failures == gauges.len() {
        warn!("marées : aucun marégraphe n'a répondu");
    }
}

/// Refait l'ajustement des ports dont il est temps. Renvoie le nombre d'ajustements réussis.
async fn refresh_harmonics(http: &reqwest::Client, gauges: &mut [Gauge]) -> usize {
    let now = Timestamp::now().as_second();
    let mut done = 0;
    let due: Vec<usize> = (0..gauges.len())
        .filter(|&i| {
            let gauge = &gauges[i];
            let age = now - gauge.fit_attempt;
            // Un port sans marée nette est vu une fois par jour, comme les autres : il peut devenir un cas d'espèce.
            age >= if gauge.harmonics.is_some() { FIT_EVERY_S } else { FIT_RETRY_S }
        })
        .collect();
    for chunk in due.chunks(PARALLEL) {
        let results = join_all(chunk.iter().map(|&i| fetch(http, gauges[i].def.id, 2, now - FIT_DAYS * 86_400, now))).await;
        for (&i, result) in chunk.iter().zip(results) {
            let gauge = &mut gauges[i];
            gauge.fit_attempt = now;
            match result {
                Ok(samples) => {
                    let regular: Vec<(i64, f64)> =
                        samples.into_iter().filter(|(t, _)| t % FIT_STEP_S == 0).map(|(t, v)| (t, f64::from(v))).collect();
                    gauge.harmonics = fit(&regular);
                    if gauge.harmonics.is_some() {
                        done += 1;
                    }
                }
                Err(error) => warn!(station = gauge.def.id, "marées : observations différées indisponibles : {error:#}"),
            }
        }
    }
    if !due.is_empty() {
        let with = gauges.iter().filter(|g| g.harmonics.is_some()).count();
        info!(ports = with, "marées : estimations ajustées");
    }
    done
}

/// Les mesures d'une station : `(secondes UTC, mètres)`, dans l'ordre. `source` : 1 temps réel, 2 temps différé.
async fn fetch(http: &reqwest::Client, station: u32, source: u8, from: i64, to: i64) -> Result<Vec<(i64, f32)>> {
    let iso = |t: i64| Timestamp::from_second(t).map(|t| t.to_string()).unwrap_or_default();
    let url = format!("{BASE_URL}/{station}?sources={source}&dtStart={}&dtEnd={}", iso(from), iso(to));
    let body = http.get(url).send().await?.error_for_status()?.text().await?;
    parse_observations(&body)
}

#[derive(Deserialize)]
struct ObservationsJson {
    data: Vec<ObservationJson>,
}

#[derive(Deserialize)]
struct ObservationJson {
    value: Option<f64>,
    timestamp: String,
}

/// `{"data":[{"idstation":3,"idsource":1,"value":2.99,"timestamp":"2026/11/10 00:00:00"}, …]}`
fn parse_observations(body: &str) -> Result<Vec<(i64, f32)>> {
    if body.trim_start().starts_with('<') {
        bail!("le service a répondu par une page web (blocage ?)");
    }
    let json: ObservationsJson = serde_json::from_str(body).context("réponse illisible")?;
    let mut out: Vec<(i64, f32)> = json
        .data
        .into_iter()
        .filter_map(|o| {
            let value = o.value?;
            // Les mesures aberrantes (capteur en panne) sont écartées : aucune marée de France ne dépasse 20 m.
            (value.abs() < 20.0).then_some(())?;
            Some((parse_time(&o.timestamp)?, value as f32))
        })
        .collect();
    out.sort_by_key(|(t, _)| *t);
    Ok(out)
}

/// « 2026/11/10 00:05:00 » (UTC) en secondes depuis 1970.
fn parse_time(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // Jours depuis 1970 (algorithme de Howard Hinnant).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hour * 3600 + minute * 60 + second)
}

impl Gauge {
    /// Range les mesures dans les médianes de 10 minutes (les dernières, qui se complètent, sont refaites) et oublie les plus anciennes.
    fn add_observations(&mut self, samples: &[(i64, f32)], now: i64) {
        let mut groups: BTreeMap<i64, Vec<f32>> = BTreeMap::new();
        for &(t, v) in samples {
            groups.entry(t.div_euclid(BUCKET_S)).or_default().push(v);
        }
        for (bucket, mut values) in groups {
            values.sort_by(|a, b| a.total_cmp(b));
            self.buckets.insert(bucket, values[values.len() / 2]);
        }
        if let Some(&last) = samples.last() {
            if self.latest.is_none_or(|(t, _)| last.0 >= t) {
                self.latest = Some(last);
            }
        }
        let oldest = (now - KEEP_S).div_euclid(BUCKET_S);
        self.buckets = self.buckets.split_off(&oldest);
    }
}

// --- Analyse harmonique ---

/// Ajuste les composantes sur des mesures au pas de 30 minutes. `None` si les données sont trop pauvres,
/// si la marée est trop faible pour être estimée, ou si l'ajustement colle mal aux mesures.
fn fit(samples: &[(i64, f64)]) -> Option<Harmonics> {
    if samples.len() < MIN_FIT_SAMPLES {
        return None;
    }
    let t0 = samples.last()?.0;
    // Les mesures doivent s'étaler sur au moins 20 jours : sans cela, M2 et S2 ne se distinguent pas.
    if t0 - samples.first()?.0 < 20 * 86_400 {
        return None;
    }
    let design = |t: i64| -> [f64; UNKNOWNS] {
        let hours = (t - t0) as f64 / 3600.0;
        let mut row = [0.0; UNKNOWNS];
        row[0] = 1.0;
        for (k, (_, speed)) in CONSTITUENTS.iter().enumerate() {
            let angle = (speed * hours).to_radians();
            row[1 + 2 * k] = angle.cos();
            row[2 + 2 * k] = angle.sin();
        }
        row
    };
    // Équations normales AᵀA·x = Aᵀb.
    let mut ata = vec![vec![0.0; UNKNOWNS]; UNKNOWNS];
    let mut atb = vec![0.0; UNKNOWNS];
    for &(t, value) in samples {
        let row = design(t);
        for i in 0..UNKNOWNS {
            atb[i] += row[i] * value;
            for j in 0..UNKNOWNS {
                ata[i][j] += row[i] * row[j];
            }
        }
    }
    let solution = solve(ata, atb)?;
    let mut coefficients = [0.0; UNKNOWNS];
    coefficients.copy_from_slice(&solution);
    let m2 = coefficients[1].hypot(coefficients[2]);
    let harmonics = Harmonics { t0, coefficients, m2, rms: 0.0 };
    let squares: f64 = samples.iter().map(|&(t, v)| (harmonics.at(t) - v).powi(2)).sum();
    let rms = (squares / samples.len() as f64).sqrt();
    (m2 >= MIN_M2_AMPLITUDE && rms <= MAX_FIT_RMS).then_some(Harmonics { rms, ..harmonics })
}

/// Résout `a·x = b` (élimination de Gauss, pivot partiel). `None` si le système est singulier.
fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        let pivot = (col..n).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()))?;
        if a[pivot][col].abs() < 1e-9 {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        for row in col + 1..n {
            let factor = a[row][col] / a[col][col];
            for k in col..n {
                a[row][k] -= factor * a[col][k];
            }
            b[row] -= factor * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let sum: f64 = (row + 1..n).map(|k| a[row][k] * x[k]).sum();
        x[row] = (b[row] - sum) / a[row][row];
    }
    Some(x)
}

// --- Extrema ---

/// Pleines et basses mers d'une série : un extremum compte quand le niveau s'en est éloigné d'au moins `threshold`.
fn zigzag(series: &[(i64, f64)], threshold: f64) -> Vec<Extreme> {
    let mut out = Vec::new();
    let Some(&first) = series.first() else { return out };
    let (mut hi, mut lo) = (first, first);
    // 1 : la mer monte (on cherche une pleine mer), -1 : elle descend, 0 : on ne sait pas encore.
    let mut direction = 0;
    for &(t, v) in series {
        if v > hi.1 {
            hi = (t, v);
        }
        if v < lo.1 {
            lo = (t, v);
        }
        if direction >= 0 && hi.1 - v >= threshold {
            out.push(Extreme { high: true, time: hi.0, height: hi.1 });
            direction = -1;
            (hi, lo) = ((t, v), (t, v));
        } else if direction <= 0 && v - lo.1 >= threshold {
            out.push(Extreme { high: false, time: lo.0, height: lo.1 });
            direction = 1;
            (hi, lo) = ((t, v), (t, v));
        }
    }
    out
}

/// Moyenne mobile sur trois valeurs : la série de 10 minutes bruitée par le clapot donne des extrema plus nets.
fn smooth(series: &[(i64, f64)]) -> Vec<(i64, f64)> {
    (0..series.len())
        .map(|i| {
            let window = &series[i.saturating_sub(1)..(i + 2).min(series.len())];
            (series[i].0, window.iter().map(|p| p.1).sum::<f64>() / window.len() as f64)
        })
        .collect()
}

/// Pleines et basses mers futures d'après les composantes : les maxima et minima de la courbe, au pas de 5 minutes.
fn predicted_extremes(harmonics: &Harmonics, from: i64, to: i64) -> Vec<Extreme> {
    let step = 300;
    let points: Vec<(i64, f64)> = (0..=(to - from) / step).map(|k| (from + k * step, harmonics.at(from + k * step))).collect();
    let mut out = Vec::new();
    for w in points.windows(3) {
        let (a, b, c) = (w[0].1, w[1].1, w[2].1);
        if b > a && b >= c {
            out.push(Extreme { high: true, time: w[1].0, height: b });
        } else if b < a && b <= c {
            out.push(Extreme { high: false, time: w[1].0, height: b });
        }
    }
    out
}

fn centimeters(meters: f64) -> i32 {
    (meters * 100.0).round() as i32
}

fn gauge_out(gauge: &Gauge, now: i64) -> Option<GaugeOut<'_>> {
    let (time, level) = gauge.latest?;
    let level = f64::from(level);
    // Une mesure vieille de plus de 12 h n'a plus rien de « temps réel » : la station est ignorée jusqu'à son retour.
    if now - time > 12 * 3600 {
        return None;
    }
    let first_bucket = (now - KEEP_S).div_euclid(BUCKET_S);
    let last_bucket = *gauge.buckets.keys().next_back()?;
    let series: Vec<Option<i32>> =
        (first_bucket..=last_bucket).map(|b| gauge.buckets.get(&b).map(|&v| centimeters(f64::from(v)))).collect();
    let values: Vec<(i64, f64)> = gauge.buckets.iter().map(|(&b, &v)| (b * BUCKET_S + BUCKET_S / 2, f64::from(v))).collect();
    let (min, max) = values.iter().fold((f64::MAX, f64::MIN), |(lo, hi), &(_, v)| (lo.min(v), hi.max(v)));
    let range = max - min;
    let tidal = range >= 0.8;
    // Variation sur la dernière demi-heure : la mesure d'il y a 30 minutes est celle de la case de 10 minutes qui la contient.
    let reference = gauge.buckets.range(..=(time - 1800).div_euclid(BUCKET_S)).next_back();
    let rate = reference.map_or(0.0, |(&b, &v)| {
        let hours = (time - (b * BUCKET_S + BUCKET_S / 2)) as f64 / 3600.0;
        if hours > 0.25 && hours < 1.5 { (level - f64::from(v)) / hours } else { 0.0 }
    });
    let extremes = if tidal { zigzag(&smooth(&values), (0.15 * range).max(0.2)) } else { Vec::new() };

    let forecast_start = (now / FIT_STEP_S + 1) * FIT_STEP_S;
    let end = now + FORECAST_HOURS * 3600;
    let (forecast, next) = match &gauge.harmonics {
        Some(h) if tidal => (
            (0..=(end - forecast_start) / FIT_STEP_S).map(|k| centimeters(h.at(forecast_start + k * FIT_STEP_S))).collect(),
            predicted_extremes(h, now, end).into_iter().filter(|e| e.time > now).take(4).collect(),
        ),
        _ => (Vec::new(), Vec::new()),
    };
    Some(GaugeOut {
        id: gauge.def.id,
        name: &gauge.def.nom,
        lon: gauge.def.lon,
        lat: gauge.def.lat,
        level,
        time,
        rate,
        min,
        max,
        tidal,
        series_start: first_bucket * BUCKET_S + BUCKET_S / 2,
        series_step: BUCKET_S,
        series,
        extremes,
        forecast_start,
        forecast_step: FIT_STEP_S,
        forecast,
        next,
        fit_rms: gauge.harmonics.as_ref().filter(|_| tidal).map(|h| (h.rms * 100.0).round() / 100.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_une_reponse_du_shom() {
        let body = r#"{"data":[
            {"idstation":3,"idsource":1,"value":2.9943,"timestamp":"2026/11/10 00:00:00"},
            {"idstation":3,"idsource":1,"value":null,"timestamp":"2026/11/10 00:01:00"},
            {"idstation":3,"idsource":1,"value":-999.0,"timestamp":"2026/11/10 00:02:00"},
            {"idstation":3,"idsource":1,"value":3.0098,"timestamp":"2026/11/10 00:03:00"}]}"#;
        let samples = parse_observations(body).unwrap();
        assert_eq!(samples.len(), 2, "la valeur absente et la valeur aberrante sont écartées");
        // 2026-11-10 00:00:00 UTC.
        assert_eq!(samples[0].0, "2026-11-10T00:00:00Z".parse::<Timestamp>().unwrap().as_second());
        assert_eq!(samples[1].0 - samples[0].0, 180);
        assert!(parse_observations("<html>Security Error</html>").is_err());
    }

    #[test]
    fn convertit_les_dates() {
        for text in ["1970/01/01 00:00:00", "2000/02/29 23:59:59", "2026/03/01 12:00:00", "2026/12/31 06:30:15"] {
            let expected = text.replace('/', "-").replacen(' ', "T", 1) + "Z";
            assert_eq!(parse_time(text), Some(expected.parse::<Timestamp>().unwrap().as_second()), "{text}");
        }
        assert_eq!(parse_time("n'importe quoi"), None);
    }

    /// Une marée synthétique : on retrouve ses composantes, et ses pleines mers tombent où il faut.
    fn synthetic(t: i64) -> f64 {
        let hours = t as f64 / 3600.0;
        4.0 + 2.0 * (28.9841042_f64 * hours).to_radians().cos() + 0.7 * (30.0_f64 * hours + 40.0).to_radians().cos() + 0.3 * (15.0410686_f64 * hours).to_radians().sin()
    }

    #[test]
    fn retrouve_une_maree_synthetique() {
        let end = 1_800_000_000 / FIT_STEP_S * FIT_STEP_S;
        let samples: Vec<(i64, f64)> = (0..FIT_DAYS * 48).map(|k| end - (FIT_DAYS * 48 - k) * FIT_STEP_S).map(|t| (t, synthetic(t))).collect();
        let h = fit(&samples).expect("l'ajustement doit réussir");
        assert!((h.m2 - 2.0).abs() < 0.02, "amplitude de M2 : {}", h.m2);
        assert!(h.rms < 0.01, "écart quadratique : {}", h.rms);
        // Prévision des 36 heures suivantes : pleines et basses mers alternent, et collent à la courbe de départ.
        let extremes = predicted_extremes(&h, end, end + 36 * 3600);
        assert!(extremes.len() >= 5, "{} extrema", extremes.len());
        assert!(extremes.windows(2).all(|w| w[0].high != w[1].high), "alternance pleine mer / basse mer");
        for e in &extremes {
            let around = [-300, 300].map(|d| synthetic(e.time + d));
            assert!((e.height - synthetic(e.time)).abs() < 0.03 && around.iter().all(|&v| (v < e.height) == e.high), "{e:?}", e = (e.time, e.height));
        }
    }

    #[test]
    fn refuse_les_donnees_trop_courtes_ou_la_maree_trop_faible() {
        let end = 1_800_000_000 / FIT_STEP_S * FIT_STEP_S;
        let short: Vec<(i64, f64)> = (0..300).map(|k| (end - k * FIT_STEP_S, synthetic(end - k * FIT_STEP_S))).collect();
        assert!(fit(&short).is_none());
        let weak: Vec<(i64, f64)> = (0..FIT_DAYS * 48)
            .map(|k| end - k * FIT_STEP_S)
            .map(|t| (t, 0.3 + 0.05 * (28.9841042_f64 * (t as f64 / 3600.0)).to_radians().cos()))
            .collect();
        assert!(fit(&weak).is_none(), "marée de Méditerranée : pas d'estimation");
    }

    #[test]
    fn zigzag_trouve_les_pleines_et_basses_mers() {
        // Deux cycles de 12 h, un point toutes les 10 minutes, avec un peu de bruit.
        let series: Vec<(i64, f64)> = (0..288)
            .map(|k| {
                let t = k * 600;
                (t, 3.0 + 2.0 * (std::f64::consts::TAU * t as f64 / 44_700.0).cos() + if k % 3 == 0 { 0.03 } else { -0.02 })
            })
            .collect();
        let extremes = zigzag(&smooth(&series), 0.5);
        assert!(extremes.len() >= 6 && extremes.windows(2).all(|w| w[0].high != w[1].high), "{}", extremes.len());
        let highs: Vec<_> = extremes.iter().filter(|e| e.high).collect();
        assert!(highs.iter().all(|e| e.height > 4.9), "les pleines mers sont à 5 m");
    }

    #[test]
    fn les_mesures_anciennes_sont_oubliees_et_les_dernieres_remplacees() {
        let mut gauge = Gauge {
            def: StationDef { id: 1, nom: "Essai".into(), lon: 0.0, lat: 0.0 },
            buckets: BTreeMap::new(),
            latest: None,
            harmonics: None,
            fit_attempt: 0,
        };
        let now = 1_800_000_000;
        gauge.add_observations(&[(now - 3 * 86_400, 1.0), (now - 120, 2.0), (now - 60, 2.2), (now, 9.0)], now);
        assert_eq!(gauge.latest, Some((now, 9.0)));
        assert!(gauge.buckets.values().all(|&v| v != 1.0), "la mesure de 3 jours est oubliée");
        // Une nouvelle demande recouvre la dernière case : elle est remplacée, pas doublée.
        let before = gauge.buckets.len();
        gauge.add_observations(&[(now - 60, 2.2), (now, 2.4)], now);
        assert_eq!(gauge.buckets.len(), before);
    }
}
