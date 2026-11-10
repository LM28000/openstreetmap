//! Feux détectés par satellite (NASA FIRMS, capteurs VIIRS des satellites Suomi NPP,
//! NOAA-20 et NOAA-21) sur les 7 derniers jours, en France et autour.
//!
//! Chaque détection est un point chaud de 375 m vu par un satellite lors de son
//! passage : un incendie de forêt, mais aussi un brûlage agricole ou une torchère
//! industrielle. La puissance radiative (FRP, en mégawatts) dit son intensité.

use std::time::Duration;

use anyhow::{Context, Result};
use jiff::Timestamp;
use jiff::civil::DateTime;
use serde::Serialize;
use tracing::{info, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://firms.modaps.eosdis.nasa.gov/data/active_fire";
const SOURCES: [(&str, &str); 3] = [
    ("Suomi NPP", "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_7d.csv"),
    ("NOAA-20", "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_7d.csv"),
    ("NOAA-21", "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_7d.csv"),
];
/// Les fichiers sont régénérés à chaque passage de satellite : une demi-heure suffit.
const REFRESH_EVERY: Duration = Duration::from_secs(30 * 60);
/// France métropolitaine et Corse, avec une marge (sud, ouest, nord, est).
const AREA: (f64, f64, f64, f64) = (41.0, -5.5, 51.5, 10.0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FireOut {
    lon: f64,
    lat: f64,
    /// Heure de la détection (secondes UTC).
    time: i64,
    /// Puissance radiative du feu, en mégawatts.
    frp: f64,
    /// Fiabilité : « l » faible, « n » normale, « h » élevée.
    confidence: String,
    satellite: &'static str,
    /// Détection de jour (`true`) ou de nuit.
    day: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FiresOut {
    updated_at: i64,
    fires: Vec<FireOut>,
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    loop {
        match fetch_all(&http).await {
            Ok((body, count)) => {
                info!(feux = count, "feux : détections mises à jour");
                state.set_fires(body);
            }
            Err(error) => warn!("feux : données indisponibles : {error:#}"),
        }
        tokio::time::sleep(REFRESH_EVERY).await;
    }
}

async fn fetch_all(http: &reqwest::Client) -> Result<(Vec<u8>, usize)> {
    let mut fires = Vec::new();
    for (satellite, path) in SOURCES {
        let csv = http.get(format!("{BASE_URL}/{path}")).send().await?.error_for_status()?.text().await?;
        fires.extend(parse_csv(&csv, satellite).with_context(|| satellite)?);
    }
    let count = fires.len();
    let body = serde_json::to_vec(&FiresOut { updated_at: Timestamp::now().as_second(), fires })?;
    Ok((body, count))
}

/// Colonnes : latitude, longitude, bright_ti4, scan, track, acq_date, acq_time,
/// satellite, confidence, version, bright_ti5, frp, daynight.
fn parse_csv(csv: &str, satellite: &'static str) -> Result<Vec<FireOut>> {
    let mut lines = csv.lines();
    let header: Vec<&str> = lines.next().context("fichier vide")?.split(',').collect();
    let column = |name: &str| header.iter().position(|h| *h == name).with_context(|| format!("colonne {name} absente"));
    let (lat_i, lon_i, date_i, time_i) = (column("latitude")?, column("longitude")?, column("acq_date")?, column("acq_time")?);
    let (frp_i, conf_i, day_i) = (column("frp")?, column("confidence")?, column("daynight")?);
    let (south, west, north, east) = AREA;

    let mut fires = Vec::new();
    for line in lines {
        let fields: Vec<&str> = line.split(',').collect();
        let get = |i: usize| fields.get(i).copied().unwrap_or_default();
        let (Ok(lat), Ok(lon)) = (get(lat_i).parse::<f64>(), get(lon_i).parse::<f64>()) else { continue };
        if !(south..=north).contains(&lat) || !(west..=east).contains(&lon) {
            continue;
        }
        // Date « 2026-11-09 » et heure « 1342 » (UTC).
        let hhmm = format!("{:0>4}", get(time_i));
        let Ok(datetime) = format!("{}T{}:{}:00", get(date_i), &hhmm[..2], &hhmm[2..]).parse::<DateTime>() else { continue };
        let Ok(zoned) = datetime.to_zoned(jiff::tz::TimeZone::UTC) else { continue };
        fires.push(FireOut {
            lon,
            lat,
            time: zoned.timestamp().as_second(),
            frp: get(frp_i).parse().unwrap_or(0.0),
            confidence: get(conf_i).to_string(),
            satellite,
            day: get(day_i) == "D",
        });
    }
    Ok(fires)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_une_detection_en_france() {
        let csv = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight\n\
                   44.12,1.53,330.2,0.4,0.4,2026-11-09,132,N20,n,2.0NRT,290.1,4.7,D\n\
                   60.0,10.0,330.2,0.4,0.4,2026-11-09,132,N20,n,2.0NRT,290.1,4.7,D\n";
        let fires = parse_csv(csv, "NOAA-20").unwrap();
        assert_eq!(fires.len(), 1, "le point en Norvège est hors zone");
        // « 132 » = 01:32 UTC.
        assert_eq!(fires[0].time, "2026-11-09T01:32:00Z".parse::<Timestamp>().unwrap().as_second());
        assert!(fires[0].day && (fires[0].frp - 4.7).abs() < 1e-9);
    }
}
