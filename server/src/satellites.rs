//! Satellites : éléments orbitaux publiés par CelesTrak (format GP/OMM en JSON).
//!
//! Le serveur ne calcule aucune position : il récupère les éléments orbitaux de
//! quelques groupes de satellites et les sert tels quels au navigateur, qui fait
//! tourner le modèle SGP4 à l'instant affiché (replay et accéléré compris).
//!
//! Politique de CelesTrak (https://celestrak.org/NORAD/documentation/gp-data-formats.php) :
//! les éléments ne sont renouvelés que toutes les 2 heures, et un même groupe ne doit
//! être téléchargé qu'une fois par renouvellement : une deuxième requête reçoit une
//! erreur 403, et les abus (beaucoup d'erreurs, requêtes en rafale) font bloquer l'adresse.
//! D'où trois précautions :
//! - une collecte toutes les 3 heures seulement, groupe après groupe, avec une pause entre deux ;
//! - chaque réponse est gardée sur disque : un redémarrage du serveur (ou plusieurs de
//!   suite, pendant le développement) ne retélécharge rien tant que le fichier a moins de 3 heures ;
//! - après une erreur, on garde les anciennes données et on ne réessaie qu'une heure plus tard
//!   (répéter une requête refusée ne change rien avant le prochain renouvellement).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use jiff::civil::DateTime;
use jiff::{Timestamp, tz::TimeZone};
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://celestrak.org/NORAD/elements/gp.php";
/// Groupes servis ensemble sur `/api/satellites`, par ordre de priorité : un satellite présent
/// dans plusieurs groupes est rangé dans le premier (un satellite météo qui est aussi
/// « brillant » reste météo ; « visual » vient en dernier pour ne garder que les autres).
const CORE_GROUPS: [(&str, &str); 5] = [
    ("stations", "Stations spatiales"),
    ("gps-ops", "GPS"),
    ("galileo", "Galileo"),
    ("weather", "Météo"),
    ("visual", "Les plus brillants"),
];
/// Constellation Starlink (environ 9 000 satellites) : servie à part, car lourde et optionnelle.
const STARLINK_GROUP: (&str, &str) = ("starlink", "Starlink");
/// Intervalle entre deux téléchargements d'un groupe (CelesTrak renouvelle toutes les 2 h).
const REFRESH_EVERY: Duration = Duration::from_secs(3 * 3600);
/// Délai avant de retenter un groupe dont le téléchargement a échoué.
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(3600);
/// Pause entre deux requêtes à CelesTrak.
const PAUSE_BETWEEN_REQUESTS: Duration = Duration::from_secs(3);
/// Au-delà, des éléments orbitaux sont trop vieux pour qu'on s'y fie (objet disparu ou abandonné).
const MAX_ELEMENT_AGE_S: i64 = 30 * 86_400;

/// Un enregistrement OMM de CelesTrak (seulement les champs utiles à SGP4).
#[derive(Deserialize)]
struct Omm {
    #[serde(rename = "OBJECT_NAME")]
    name: String,
    #[serde(rename = "OBJECT_ID", default)]
    intl: String,
    #[serde(rename = "EPOCH")]
    epoch: String,
    #[serde(rename = "MEAN_MOTION")]
    mean_motion: f64,
    #[serde(rename = "ECCENTRICITY")]
    eccentricity: f64,
    #[serde(rename = "INCLINATION")]
    inclination: f64,
    #[serde(rename = "RA_OF_ASC_NODE")]
    raan: f64,
    #[serde(rename = "ARG_OF_PERICENTER")]
    arg_of_pericenter: f64,
    #[serde(rename = "MEAN_ANOMALY")]
    mean_anomaly: f64,
    #[serde(rename = "NORAD_CAT_ID")]
    norad_id: u32,
    #[serde(rename = "ELEMENT_SET_NO", default)]
    element_set: u32,
    #[serde(rename = "REV_AT_EPOCH", default)]
    revolutions: u32,
    #[serde(rename = "BSTAR")]
    bstar: f64,
    #[serde(rename = "MEAN_MOTION_DOT")]
    mean_motion_dot: f64,
    #[serde(rename = "MEAN_MOTION_DDOT")]
    mean_motion_ddot: f64,
}

/// Ce que le navigateur reçoit : les mêmes éléments, en camelCase, plus le groupe.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SatelliteOut<'a> {
    name: &'a str,
    /// Numéro de catalogue NORAD.
    id: u32,
    /// Désignation internationale (année de lancement, n° de lancement, pièce).
    intl: &'a str,
    group: &'a str,
    /// Date des éléments (UTC, sans fuseau, comme dans l'OMM).
    epoch: &'a str,
    mean_motion: f64,
    eccentricity: f64,
    inclination: f64,
    raan: f64,
    arg_of_pericenter: f64,
    mean_anomaly: f64,
    element_set: u32,
    revolutions: u32,
    bstar: f64,
    mean_motion_dot: f64,
    mean_motion_ddot: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupOut<'a> {
    id: &'a str,
    name: &'a str,
    /// Heure du téléchargement (secondes UTC).
    fetched_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SatellitesOut<'a> {
    updated_at: i64,
    groups: Vec<GroupOut<'a>>,
    satellites: Vec<SatelliteOut<'a>>,
}

/// Un groupe tel que téléchargé : son texte JSON brut et son heure de téléchargement.
struct Fetched {
    group: (&'static str, &'static str),
    body: String,
    fetched_at: SystemTime,
}

/// Collecte en boucle les groupes de CelesTrak et prépare les réponses de l'API.
pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf, state: AppState) {
    let cache_dir = data_dir.join("satellites");
    if let Err(error) = tokio::fs::create_dir_all(&cache_dir).await {
        warn!("satellites : dossier de cache inutilisable : {error}");
    }
    let all: Vec<(&'static str, &'static str)> = CORE_GROUPS.iter().copied().chain([STARLINK_GROUP]).collect();
    let mut fetched: Vec<Option<Fetched>> = Vec::new();
    // Prochain essai de chaque groupe (instant réel de la machine).
    let mut next_try: Vec<SystemTime> = Vec::new();
    for group in &all {
        let cached = read_cache(&cache_dir, group.0).await;
        next_try.push(cached.as_ref().map_or(SystemTime::now(), |(_, at)| *at + REFRESH_EVERY));
        fetched.push(cached.map(|(body, fetched_at)| Fetched { group: *group, body, fetched_at }));
    }
    publish(&state, &fetched);

    loop {
        let mut changed = false;
        let mut requests = 0;
        for (index, group) in all.iter().enumerate() {
            if next_try[index] > SystemTime::now() {
                continue;
            }
            if requests > 0 {
                tokio::time::sleep(PAUSE_BETWEEN_REQUESTS).await;
            }
            requests += 1;
            match download(&http, group.0).await {
                Ok(body) => {
                    info!(groupe = group.0, "satellites : éléments orbitaux téléchargés");
                    if let Err(error) = write_cache(&cache_dir, group.0, &body).await {
                        warn!("satellites : cache non écrit : {error}");
                    }
                    fetched[index] = Some(Fetched { group: *group, body, fetched_at: SystemTime::now() });
                    next_try[index] = SystemTime::now() + REFRESH_EVERY;
                    changed = true;
                }
                Err(error) => {
                    warn!(groupe = group.0, "satellites : téléchargement impossible : {error:#}");
                    next_try[index] = SystemTime::now() + RETRY_AFTER_ERROR;
                }
            }
        }
        if changed {
            publish(&state, &fetched);
        }
        let wait = next_try
            .iter()
            .filter_map(|at| at.duration_since(SystemTime::now()).ok())
            .min()
            .unwrap_or(Duration::from_secs(60))
            .clamp(Duration::from_secs(60), Duration::from_secs(600));
        tokio::time::sleep(wait).await;
    }
}

/// Prépare les deux réponses (groupes courants, Starlink) à partir de ce qu'on a de plus récent.
fn publish(state: &AppState, fetched: &[Option<Fetched>]) {
    let now = Timestamp::now().as_second();
    let core: Vec<&Fetched> = fetched.iter().flatten().filter(|f| f.group.0 != STARLINK_GROUP.0).collect();
    if !core.is_empty() {
        match prepare(&core, now) {
            Ok((body, count)) => {
                info!(satellites = count, "satellites : réponse préparée");
                state.set_satellites(body);
            }
            Err(error) => warn!("satellites : réponse non préparée : {error:#}"),
        }
    }
    let starlink: Vec<&Fetched> = fetched.iter().flatten().filter(|f| f.group.0 == STARLINK_GROUP.0).collect();
    if !starlink.is_empty() {
        match prepare(&starlink, now) {
            Ok((body, count)) => {
                info!(satellites = count, "satellites : Starlink prêt");
                state.set_starlink(body);
            }
            Err(error) => warn!("satellites : Starlink non préparé : {error:#}"),
        }
    }
}

async fn download(http: &reqwest::Client, group: &str) -> Result<String> {
    let response = http
        // Noms de groupes fixes, sans caractère à protéger : pas besoin d'encoder l'adresse.
        .get(format!("{BASE_URL}?GROUP={group}&FORMAT=json"))
        .timeout(Duration::from_secs(60))
        .send()
        .await?;
    let status = response.status();
    let body = response.text().await?;
    if !status.is_success() {
        // Le texte d'un refus (403) explique la raison : on le garde dans le message.
        bail!("CelesTrak a répondu {status} : {}", body.chars().take(200).collect::<String>());
    }
    // Un groupe inconnu ou vide renvoie un simple texte avec le code 200 : on vérifie que c'est du JSON.
    parse(&body).with_context(|| format!("réponse inattendue : {}", body.chars().take(120).collect::<String>()))?;
    Ok(body)
}

fn cache_path(dir: &Path, group: &str) -> PathBuf {
    dir.join(format!("{group}.json"))
}

async fn read_cache(dir: &Path, group: &str) -> Option<(String, SystemTime)> {
    let path = cache_path(dir, group);
    let fetched_at = tokio::fs::metadata(&path).await.ok()?.modified().ok()?;
    let body = tokio::fs::read_to_string(&path).await.ok()?;
    parse(&body).ok()?; // fichier abîmé : on le télécharge à nouveau
    Some((body, fetched_at))
}

/// Écriture en deux temps : un fichier à moitié écrit ne doit jamais passer pour valide.
async fn write_cache(dir: &Path, group: &str, body: &str) -> Result<()> {
    let path = cache_path(dir, group);
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, body).await?;
    tokio::fs::rename(&temporary, &path).await?;
    Ok(())
}

fn parse(body: &str) -> Result<Vec<Omm>> {
    let list: Vec<Omm> = serde_json::from_str(body).context("JSON OMM invalide")?;
    if list.is_empty() {
        bail!("aucun satellite");
    }
    Ok(list)
}

fn epoch_seconds(epoch: &str) -> Option<i64> {
    let civil: DateTime = epoch.parse().ok()?;
    Some(civil.to_zoned(TimeZone::UTC).ok()?.timestamp().as_second())
}

/// Assemble les groupes en une réponse : un satellite par numéro NORAD, sans doublon.
fn prepare(groups: &[&Fetched], now: i64) -> Result<(Vec<u8>, usize)> {
    let mut parsed: Vec<(&Fetched, Vec<Omm>)> = Vec::new();
    for fetched in groups {
        parsed.push((fetched, parse(&fetched.body)?));
    }
    // Priorité des groupes : l'ordre de CORE_GROUPS.
    parsed.sort_by_key(|(f, _)| CORE_GROUPS.iter().position(|g| g.0 == f.group.0).unwrap_or(usize::MAX));

    let mut seen = std::collections::HashSet::new();
    let mut satellites = Vec::new();
    for (fetched, list) in &parsed {
        // Les modules d'une station (Zarya, Nauka, Tianhe…) partagent exactement l'orbite de
        // la station : un seul point suffit, sinon vingt points se superposent.
        let mut orbits: Vec<[f64; 4]> = Vec::new();
        for omm in list {
            let Some(epoch) = epoch_seconds(&omm.epoch) else { continue };
            if now - epoch > MAX_ELEMENT_AGE_S || !seen.insert(omm.norad_id) {
                continue;
            }
            if fetched.group.0 == "stations" {
                let orbit = [omm.mean_motion, omm.inclination, omm.raan, omm.mean_anomaly];
                if orbits.contains(&orbit) {
                    continue;
                }
                orbits.push(orbit);
            }
            satellites.push(SatelliteOut {
                name: &omm.name,
                id: omm.norad_id,
                intl: &omm.intl,
                group: fetched.group.0,
                epoch: &omm.epoch,
                mean_motion: omm.mean_motion,
                eccentricity: omm.eccentricity,
                inclination: omm.inclination,
                raan: omm.raan,
                arg_of_pericenter: omm.arg_of_pericenter,
                mean_anomaly: omm.mean_anomaly,
                element_set: omm.element_set,
                revolutions: omm.revolutions,
                bstar: omm.bstar,
                mean_motion_dot: omm.mean_motion_dot,
                mean_motion_ddot: omm.mean_motion_ddot,
            });
        }
    }
    let count = satellites.len();
    let body = serde_json::to_vec(&SatellitesOut {
        updated_at: parsed
            .iter()
            .filter_map(|(f, _)| f.fetched_at.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .max()
            .unwrap_or(now),
        groups: parsed
            .iter()
            .map(|(f, _)| GroupOut {
                id: f.group.0,
                name: f.group.1,
                fetched_at: f.fetched_at.duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64),
            })
            .collect(),
        satellites,
    })?;
    Ok((body, count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn omm(name: &str, id: u32, epoch: &str, mean_motion: f64) -> String {
        format!(
            r#"{{"OBJECT_NAME":"{name}","OBJECT_ID":"1998-067A","EPOCH":"{epoch}","MEAN_MOTION":{mean_motion},"ECCENTRICITY":0.0007,"INCLINATION":51.6,"RA_OF_ASC_NODE":301.1,"ARG_OF_PERICENTER":6.3,"MEAN_ANOMALY":353.8,"EPHEMERIS_TYPE":0,"CLASSIFICATION_TYPE":"U","NORAD_CAT_ID":{id},"ELEMENT_SET_NO":999,"REV_AT_EPOCH":59427,"BSTAR":0.0001,"MEAN_MOTION_DOT":8.6e-5,"MEAN_MOTION_DDOT":0}}"#
        )
    }

    fn group(id: &'static str, items: &[String]) -> Fetched {
        let name = CORE_GROUPS.iter().find(|g| g.0 == id).map_or("?", |g| g.1);
        Fetched { group: (id, name), body: format!("[{}]", items.join(",")), fetched_at: SystemTime::now() }
    }

    fn output(groups: &[&Fetched], now: i64) -> serde_json::Value {
        let (body, _) = prepare(groups, now).unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    const NOW: i64 = 1_794_000_000; // novembre 2026

    #[test]
    fn epoque_en_secondes() {
        assert_eq!(epoch_seconds("2026-11-09T11:10:18.771456"), Some(1_794_222_618));
        assert_eq!(epoch_seconds("pas une date"), None);
    }

    #[test]
    fn les_modules_d_une_station_ne_font_qu_un_point() {
        let epoch = "2026-11-09T11:10:18.771456";
        let stations = group(
            "stations",
            &[omm("ISS (ZARYA)", 25544, epoch, 15.49), omm("POISK", 36086, epoch, 15.49), omm("CSS (TIANHE)", 48274, epoch, 15.61)],
        );
        let json = output(&[&stations], NOW);
        let names: Vec<&str> = json["satellites"].as_array().unwrap().iter().map(|s| s["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["ISS (ZARYA)", "CSS (TIANHE)"]);
    }

    #[test]
    fn un_satellite_n_est_range_que_dans_un_groupe() {
        let epoch = "2026-11-09T11:10:18.771456";
        let visual = group("visual", &[omm("NOAA 15", 25338, epoch, 14.2), omm("CZ-3B R/B", 40000, epoch, 14.0)]);
        let weather = group("weather", &[omm("NOAA 15", 25338, epoch, 14.2)]);
        // Même si « visual » arrive en premier, « météo » est prioritaire.
        let json = output(&[&visual, &weather], NOW);
        let found: Vec<(&str, &str)> = json["satellites"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| (s["name"].as_str().unwrap(), s["group"].as_str().unwrap()))
            .collect();
        assert_eq!(found, [("NOAA 15", "weather"), ("CZ-3B R/B", "visual")]);
        assert_eq!(json["groups"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn des_elements_trop_vieux_sont_ecartes() {
        let visual = group("visual", &[omm("VIEUX", 1, "2026-08-01T00:00:00", 14.0), omm("RECENT", 2, "2026-11-09T00:00:00", 14.0)]);
        let json = output(&[&visual], NOW);
        assert_eq!(json["satellites"].as_array().unwrap().len(), 1);
        assert_eq!(json["satellites"][0]["name"], "RECENT");
        assert_eq!(json["satellites"][0]["meanMotion"], 14.0);
    }

    #[test]
    fn les_reponses_qui_ne_sont_pas_des_elements_sont_refusees() {
        assert!(parse("No GP data found").is_err());
        assert!(parse("[]").is_err());
        assert!(parse("[{\"OBJECT_NAME\":\"X\"}]").is_err());
    }
}
