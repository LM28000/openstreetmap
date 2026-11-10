//! État de la circulation : des tronçons de route colorés de « fluide » à « coupé ».
//!
//! Sources (toutes ouvertes, sans clé) :
//! - **Réseau routier national non concédé, autour des grandes agglomérations** (Bison Futé,
//!   Licence Ouverte 2.0) : l'état (`freeFlow`, `heavy`, `congested`, `impossible`) de chaque
//!   point de mesure, publié par agglomération (dossiers `TRAFICOLOR-DIR/Trafic…/`, un fichier
//!   par minute), les vitesses et débits moyens (`QTV-DIR/qtvDir.xml`) et le référentiel qui
//!   donne la position de chaque tronçon (`QTV-DIR/refDir.csv`, en Lambert 93). Seuls les
//!   834 tronçons du référentiel qui ont une position sont montrés (sur 1 205).
//! - **Rennes Métropole** (ODbL) : l'état de 2 859 tronçons, avec leur tracé, estimé à partir
//!   de véhicules traceurs (FCD), relu toutes les 5 minutes.
//!
//! Ne sont **pas** couverts : les autoroutes concédées (Vinci, APRR, Sanef…), qui ne publient
//! pas d'état en données ouvertes ; Lyon (le service de la Métropole demande désormais un
//! compte) ; Bordeaux (clé d'API).
//!
//! Format commun : un tronçon (`Section`) a une ligne, un état de 0 (fluide) à 3 (coupé),
//! une vitesse si on la connaît, l'heure de la mesure et sa source.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use roxmltree::Document;
use serde::Serialize;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::state::AppState;

const BISON_ROOT: &str = "http://tipi.bison-fute.gouv.fr/bison-fute-ouvert/publicationsDIR";
const RENNES_URL: &str = "https://data.rennesmetropole.fr/api/explore/v2.1/catalog/datasets/conditions-de-circulation-automobile-en-temps-reel-sur-rennes-metropole/exports/geojson";
const REFRESH_EVERY: Duration = Duration::from_secs(3 * 60);
const RENNES_EVERY: Duration = Duration::from_secs(5 * 60);
/// Le référentiel et la liste des agglomérations changent rarement.
const REFERENCE_EVERY: Duration = Duration::from_secs(6 * 3600);
/// Une mesure plus vieille n'est plus de l'état : le capteur ou la source est en panne.
const MAX_AGE_S: i64 = 30 * 60;
const PARALLEL: usize = 8;

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    id: String,
    /// « Bison Futé (DIR Centre-Est) », « Rennes Métropole ».
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    road: Option<String>,
    /// Nom de la rue (Rennes) ou sens de circulation (Bison Futé).
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// 0 fluide, 1 ralenti, 2 saturé, 3 coupé.
    state: u8,
    /// Vitesse moyenne mesurée, en km/h.
    #[serde(skip_serializing_if = "Option::is_none")]
    speed: Option<f32>,
    /// Débit, en véhicules par heure.
    #[serde(skip_serializing_if = "Option::is_none")]
    flow: Option<u32>,
    /// Heure de la mesure (secondes UTC).
    time: i64,
    line: Vec<[f64; 2]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Out<'a> {
    updated_at: i64,
    sections: &'a [Section],
}

// --- Lambert 93 → WGS 84 -----------------------------------------------------------------------

/// Projection conique conforme de Lambert, RGF93 / Lambert-93 (EPSG:2154), en sens inverse.
pub fn lambert93_to_wgs84(easting: f64, northing: f64) -> (f64, f64) {
    const A: f64 = 6_378_137.0;
    const E2: f64 = 0.006_694_380_022_90;
    let e = E2.sqrt();
    let (lat0, lat1, lat2) = (46.5f64.to_radians(), 44f64.to_radians(), 49f64.to_radians());
    let lon0 = 3f64.to_radians();
    let (x0, y0) = (700_000.0, 6_600_000.0);
    let m = |lat: f64| lat.cos() / (1.0 - E2 * lat.sin().powi(2)).sqrt();
    let t = |lat: f64| {
        let s = e * lat.sin();
        (std::f64::consts::FRAC_PI_4 - lat / 2.0).tan() / ((1.0 - s) / (1.0 + s)).powf(e / 2.0)
    };
    let n = (m(lat1) / m(lat2)).ln() / (t(lat1) / t(lat2)).ln();
    let f = m(lat1) / (n * t(lat1).powf(n));
    let rho0 = A * f * t(lat0).powf(n);
    let (dx, dy) = (easting - x0, rho0 - (northing - y0));
    let rho = n.signum() * dx.hypot(dy);
    let theta = dx.atan2(dy * n.signum());
    let tt = (rho / (A * f)).powf(1.0 / n);
    let lon = theta / n + lon0;
    let mut lat = std::f64::consts::FRAC_PI_2 - 2.0 * tt.atan();
    for _ in 0..8 {
        let s = e * lat.sin();
        lat = std::f64::consts::FRAC_PI_2 - 2.0 * (tt * ((1.0 - s) / (1.0 + s)).powf(e / 2.0)).atan();
    }
    (lon.to_degrees(), lat.to_degrees())
}

// --- Référentiel des tronçons ------------------------------------------------------------------

struct Reference {
    /// DIR gestionnaire (« DIRCE »).
    manager: String,
    road: String,
    direction: Option<&'static str>,
    line: [[f64; 2]; 2],
}

fn direction_label(raw: &str) -> Option<&'static str> {
    Some(match raw {
        "NORD_SUD" => "du nord vers le sud",
        "SUD_NORD" => "du sud vers le nord",
        "EST_OUEST" => "de l’est vers l’ouest",
        "OUEST_EST" => "de l’ouest vers l’est",
        _ => return None,
    })
}

fn dir_name(code: &str) -> String {
    let name = match code {
        "DIRA" => "Atlantique",
        "DIRCE" => "Centre-Est",
        "DIRCO" => "Centre-Ouest",
        "DIRE" => "Est",
        "DIRIF" => "Île-de-France",
        "DIRMC" => "Massif Central",
        "DIRMED" => "Méditerranée",
        "DIRNO" => "Nord",
        "DIRN" => "Nord",
        "DIRO" => "Ouest",
        "DIRSO" => "Sud-Ouest",
        other => return other.to_string(),
    };
    format!("DIR {name}")
}

/// « N0165 » → « N165 ».
fn road_number(raw: &str) -> String {
    let split = raw.find(|c: char| c.is_ascii_digit()).unwrap_or(raw.len());
    let (letters, digits) = raw.split_at(split);
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() { raw.to_string() } else { format!("{letters}{digits}") }
}

/// Le fichier a 20 en-têtes mais 19 colonnes par ligne (la colonne `code_insee_commune` est absente
/// des données) : on lit donc par position, sans en-tête. Colonnes : 0 identifiant du point de mesure,
/// 1 gestionnaire, 3 route, 9 sens, 12 longueur, 14 à 17 coordonnées Lambert 93 du début et de la fin.
fn parse_reference(csv_text: &str) -> Result<HashMap<String, Reference>> {
    let mut reader = csv::ReaderBuilder::new().delimiter(b';').has_headers(true).flexible(true).from_reader(csv_text.as_bytes());
    let mut references = HashMap::new();
    let mut rows = 0;
    for record in reader.records() {
        let record = record.context("ligne du référentiel illisible")?;
        rows += 1;
        let field = |i: usize| record.get(i).unwrap_or("").trim();
        let coordinate = |i: usize| field(i).parse::<f64>().ok();
        let (Some(x1), Some(y1), Some(x2), Some(y2)) = (coordinate(14), coordinate(15), coordinate(16), coordinate(17)) else { continue };
        let (lon1, lat1) = lambert93_to_wgs84(x1, y1);
        let (lon2, lat2) = lambert93_to_wgs84(x2, y2);
        references.insert(
            field(0).to_string(),
            Reference { manager: field(1).to_string(), road: road_number(field(3)), direction: direction_label(field(9)), line: [[lon1, lat1], [lon2, lat2]] },
        );
    }
    if rows < 100 {
        bail!("référentiel trop court ({rows} lignes) : le format a changé");
    }
    Ok(references)
}

// --- Mesures -----------------------------------------------------------------------------------

fn parse_time(text: &str) -> Option<i64> {
    text.trim().parse::<Timestamp>().ok().map(|t| t.as_second())
}

fn state_of(status: &str) -> Option<u8> {
    match status {
        "freeFlow" => Some(0),
        "heavy" => Some(1),
        "congested" => Some(2),
        "impossible" => Some(3),
        _ => None, // « unknown » : pas de mesure
    }
}

/// État de chaque point de mesure dans un fichier de `TRAFICOLOR-DIR` : identifiant → (état, heure).
fn parse_statuses(xml: &str) -> Result<HashMap<String, (u8, i64)>> {
    let document = Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).context("XML invalide")?;
    let mut out = HashMap::new();
    for site in document.descendants().filter(|d| d.is_element() && d.tag_name().name() == "siteMeasurements") {
        let id = site.descendants().find(|d| d.tag_name().name() == "measurementSiteReference").and_then(|d| d.attribute("id"));
        let time = site.descendants().find(|d| d.tag_name().name() == "measurementTimeDefault").and_then(|d| d.text()).and_then(parse_time);
        let status = site.descendants().find(|d| d.tag_name().name() == "trafficStatusValue").and_then(|d| d.text());
        if let (Some(id), Some(time), Some(state)) = (id, time, status.and_then(|s| state_of(s.trim()))) {
            out.insert(id.to_string(), (state, time));
        }
    }
    Ok(out)
}

struct Measure {
    speed: Option<f32>,
    flow: Option<u32>,
}

/// Vitesses et débits moyens de `qtvDir.xml` : identifiant → mesure.
fn parse_measures(xml: &str) -> Result<HashMap<String, Measure>> {
    let document = Document::parse_with_options(xml, roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() }).context("XML invalide")?;
    let mut out = HashMap::new();
    for site in document.descendants().filter(|d| d.is_element() && d.tag_name().name() == "siteMeasurements") {
        let Some(id) = site.descendants().find(|d| d.tag_name().name() == "measurementSiteReference").and_then(|d| d.attribute("id")) else { continue };
        let number = |name: &str| site.descendants().find(|d| d.is_element() && d.tag_name().name() == name).and_then(|d| d.text()).and_then(|t| t.trim().parse::<f32>().ok());
        // Une vitesse de 0 ou négative est une absence de mesure, pas un arrêt (le capteur n'a vu personne).
        let speed = number("speed").filter(|s| *s > 0.0 && *s < 250.0);
        let flow = number("vehicleFlowRate").filter(|f| *f >= 0.0).map(|f| f as u32);
        out.insert(id.to_string(), Measure { speed, flow });
    }
    Ok(out)
}

/// Nom du premier fichier d'une page d'index triée du plus récent au plus ancien (`?C=M;O=D`).
fn first_xml(index_html: &str) -> Option<String> {
    index_html.split("href=\"").skip(1).filter_map(|p| p.split('"').next()).find(|h| h.ends_with(".xml") && !h.contains('/')).map(str::to_string)
}

fn directories(index_html: &str) -> Vec<String> {
    index_html
        .split("href=\"")
        .skip(1)
        .filter_map(|p| p.split('"').next())
        .filter(|h| h.ends_with('/') && !h.starts_with('/') && !h.starts_with('?') && !h.starts_with(".."))
        .map(|h| h.trim_end_matches('/').to_string())
        .collect()
}

/// Les tronçons de Rennes Métropole (export GeoJSON d'Opendatasoft).
fn parse_rennes(json: &str, now: i64) -> Result<Vec<Section>> {
    let value: serde_json::Value = serde_json::from_str(json).context("JSON invalide")?;
    let features = value["features"].as_array().context("pas de « features »")?;
    let mut sections = Vec::new();
    for feature in features {
        let properties = &feature["properties"];
        let Some(state) = properties["fcd_trafic_status"].as_str().and_then(state_of) else { continue };
        let Some(time) = properties["fcd_datetime"].as_str().and_then(parse_time) else { continue };
        if now - time > 2 * 3600 {
            continue; // mesure périmée
        }
        let line: Vec<[f64; 2]> = feature["geometry"]["coordinates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| Some([p[0].as_f64()?, p[1].as_f64()?]))
            .collect();
        if line.len() < 2 {
            continue;
        }
        sections.push(Section {
            id: format!("rennes-{}", properties["id_troncon"].as_str().unwrap_or_default()),
            source: "Rennes Métropole".to_string(),
            road: None,
            name: properties["denomination"].as_str().map(str::to_string),
            state,
            speed: properties["fcd_avg_speed"].as_f64().filter(|s| *s > 0.0).map(|s| s as f32),
            flow: None,
            time,
            line,
        });
    }
    Ok(sections)
}

// --- Collecte ----------------------------------------------------------------------------------

async fn get_text(http: &reqwest::Client, url: &str) -> Result<String> {
    Ok(http.get(url).timeout(Duration::from_secs(60)).send().await?.error_for_status()?.text().await?)
}

/// Le fichier le plus récent d'un dossier d'agglomération : seul le début de la page d'index
/// (triée du plus récent au plus ancien) est lu, car l'index entier pèse 150 Ko.
async fn latest_status(http: &reqwest::Client, directory: String) -> Result<HashMap<String, (u8, i64)>> {
    let index_url = format!("{BISON_ROOT}/TRAFICOLOR-DIR/{directory}/?C=M;O=D");
    let mut response = http.get(&index_url).timeout(Duration::from_secs(30)).send().await?.error_for_status()?;
    let mut head = Vec::new();
    while head.len() < 16 * 1024 && let Some(chunk) = response.chunk().await? {
        head.extend_from_slice(&chunk);
        if first_xml(&String::from_utf8_lossy(&head)).is_some() {
            break;
        }
    }
    drop(response);
    let file = first_xml(&String::from_utf8_lossy(&head)).with_context(|| format!("{directory} : aucun fichier"))?;
    let xml = get_text(http, &format!("{BISON_ROOT}/TRAFICOLOR-DIR/{directory}/{file}")).await?;
    parse_statuses(&xml).with_context(|| file)
}

struct Cache {
    references: HashMap<String, Reference>,
    directories: Vec<String>,
    loaded_at: Option<std::time::Instant>,
}

async fn load_reference(http: &reqwest::Client) -> Result<(HashMap<String, Reference>, Vec<String>)> {
    let references = parse_reference(&get_text(http, &format!("{BISON_ROOT}/QTV-DIR/refDir.csv")).await?)?;
    let directories = directories(&get_text(http, &format!("{BISON_ROOT}/TRAFICOLOR-DIR/")).await?);
    Ok((references, directories))
}

async fn bison_sections(http: &reqwest::Client, cache: &Cache, now: i64) -> Result<Vec<Section>> {
    let mut tasks = JoinSet::new();
    let mut queue = cache.directories.iter().cloned();
    let mut statuses: HashMap<String, (u8, i64)> = HashMap::new();
    loop {
        while tasks.len() < PARALLEL {
            let Some(directory) = queue.next() else { break };
            let http = http.clone();
            tasks.spawn(async move { latest_status(&http, directory.clone()).await.with_context(|| directory) });
        }
        match tasks.join_next().await {
            Some(Ok(Ok(found))) => statuses.extend(found),
            Some(Ok(Err(error))) => warn!("état du trafic : agglomération ignorée : {error:#}"),
            Some(Err(error)) => warn!("état du trafic : tâche interrompue : {error}"),
            None => break,
        }
    }
    let measures = match get_text(http, &format!("{BISON_ROOT}/QTV-DIR/qtvDir.xml")).await {
        Ok(xml) => tokio::task::spawn_blocking(move || parse_measures(&xml)).await??,
        Err(error) => {
            warn!("état du trafic : vitesses indisponibles : {error:#}");
            HashMap::new()
        }
    };

    let mut sections = Vec::new();
    for (id, (state, time)) in statuses {
        if now - time > MAX_AGE_S {
            continue;
        }
        let Some(reference) = cache.references.get(&id) else { continue };
        let measure = measures.get(&id);
        sections.push(Section {
            id: format!("dir-{id}"),
            source: format!("Bison Futé ({})", dir_name(&reference.manager)),
            road: Some(reference.road.clone()),
            name: reference.direction.map(str::to_string),
            state,
            speed: measure.and_then(|m| m.speed),
            flow: measure.and_then(|m| m.flow),
            time,
            line: reference.line.to_vec(),
        });
    }
    sections.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(sections)
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let mut cache = Cache { references: HashMap::new(), directories: Vec::new(), loaded_at: None };
    let mut rennes: Vec<Section> = Vec::new();
    let mut rennes_at: Option<std::time::Instant> = None;
    loop {
        if cache.loaded_at.is_none_or(|at| at.elapsed() > REFERENCE_EVERY) {
            match load_reference(&http).await {
                Ok((references, directories)) => {
                    info!(troncons = references.len(), agglomerations = directories.len(), "état du trafic : référentiel chargé");
                    cache = Cache { references, directories, loaded_at: Some(std::time::Instant::now()) };
                }
                Err(error) => warn!("état du trafic : référentiel indisponible : {error:#}"),
            }
        }
        let now = Timestamp::now().as_second();
        if rennes_at.is_none_or(|at| at.elapsed() >= RENNES_EVERY) {
            rennes_at = Some(std::time::Instant::now());
            match get_text(&http, RENNES_URL).await.and_then(|json| parse_rennes(&json, now)) {
                Ok(sections) => {
                    info!(troncons = sections.len(), "état du trafic : Rennes mis à jour");
                    rennes = sections;
                }
                Err(error) => {
                    warn!("état du trafic : Rennes indisponible : {error:#}");
                    rennes.clear();
                }
            }
        }
        if cache.loaded_at.is_some() {
            match bison_sections(&http, &cache, now).await {
                Ok(mut sections) => {
                    info!(troncons = sections.len(), "état du trafic : Bison Futé mis à jour");
                    sections.extend(rennes.iter().cloned());
                    match serde_json::to_vec(&Out { updated_at: now, sections: &sections }) {
                        Ok(body) => state.set_traffic_state(body),
                        Err(error) => warn!("état du trafic : réponse impossible à préparer : {error}"),
                    }
                }
                Err(error) => warn!("état du trafic : Bison Futé indisponible : {error:#}"),
            }
        }
        tokio::time::sleep(REFRESH_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convertit_le_lambert_93() {
        // La tour Eiffel : E 648 237, N 6 862 271 en Lambert 93.
        let (lon, lat) = lambert93_to_wgs84(648_237.0, 6_862_271.0);
        assert!((lon - 2.2945).abs() < 0.001 && (lat - 48.8584).abs() < 0.001, "{lon} {lat}");
        // Le point d'origine de la projection : 3° E, 46,5° N.
        let (lon, lat) = lambert93_to_wgs84(700_000.0, 6_600_000.0);
        assert!((lon - 3.0).abs() < 1e-6 && (lat - 46.5).abs() < 1e-6, "{lon} {lat}");
    }

    const REFERENCE: &str = "code_pme;source;source_2;code_insee_commune;axe;pr_debut;abscisse_debut;pr_fin;abscisse_fin;sens_gestionnaire;sens_cardinal;sens_migratoire;sens_giratoire;longueur;nb_voies;x_deb;y_deb;x_fin;y_fin;code_traficolor\n\
MUM76.h1;DIRNO;237676517;A28;76PR91D;800;76PR94D;840;1;NORD_SUD;Y;;3035;0;569981.6;6938140.0;568217.6;6935783.5;RO76\n\
MB631.B8;DIRSO;733131555;A620;31PR1G;751;31PR2G;604;1;SUD_NORD;W;INTERIEUR;834;0;572626.2;6284049.5;572552.9;6283075.0;TO31\n\
MWO56.J1;DIRO;535656251;N0165;39;0;;;1;;;;0;2;;;;;\n";

    #[test]
    fn lit_le_referentiel_par_position() {
        // Le jeu réel compte plus de 1 000 lignes : on abaisse le seuil en répétant l'extrait.
        let mut text = REFERENCE.to_string();
        for i in 0..120 {
            text.push_str(&format!("MX{i}.a1;DIRO;1;N0165;39;0;;;1;;;;0;2;;;;;\n"));
        }
        let references = parse_reference(&text).unwrap();
        // Les tronçons sans coordonnées sont ignorés.
        assert_eq!(references.len(), 2);
        let rouen = &references["MUM76.h1"];
        assert_eq!(rouen.road, "A28");
        assert_eq!(rouen.manager, "DIRNO");
        assert_eq!(rouen.direction, Some("du nord vers le sud"));
        // A28 près de Rouen.
        assert!((rouen.line[0][1] - 49.4).abs() < 0.3 && rouen.line[0][0] > 0.5 && rouen.line[0][0] < 1.5, "{:?}", rouen.line);
        assert_eq!(road_number("N0165"), "N165");
    }

    #[test]
    fn lit_les_etats_et_ignore_les_inconnus() {
        let xml = r#"<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><payloadPublication xsi:type="MeasuredDataPublication">
<siteMeasurements><measurementSiteReference targetClass="MeasurementSiteRecord" id="MQA01.E1" version="1.0"/><measurementTimeDefault>2026-11-10T03:00:00+01:00</measurementTimeDefault>
<measuredValue index="0"><measuredValue><basicData xsi:type="TrafficStatus"><trafficStatus numberOfInputValuesUsed="0"><trafficStatusValue>freeFlow</trafficStatusValue></trafficStatus></basicData></measuredValue></measuredValue></siteMeasurements>
<siteMeasurements><measurementSiteReference targetClass="MeasurementSiteRecord" id="MY269.A1" version="1.0"/><measurementTimeDefault>2026-11-10T03:01:00+01:00</measurementTimeDefault>
<measuredValue index="0"><measuredValue><basicData xsi:type="TrafficStatus"><trafficStatus numberOfInputValuesUsed="0"><trafficStatusValue>congested</trafficStatusValue></trafficStatus></basicData></measuredValue></measuredValue></siteMeasurements>
<siteMeasurements><measurementSiteReference targetClass="MeasurementSiteRecord" id="MGR69.D2" version="1.0"/><measurementTimeDefault>2026-11-10T02:48:00+01:00</measurementTimeDefault>
<measuredValue index="0"><measuredValue><basicData xsi:type="TrafficStatus"><trafficStatus numberOfInputValuesUsed="0"><trafficStatusValue>unknown</trafficStatusValue></trafficStatus></basicData></measuredValue></measuredValue></siteMeasurements>
</payloadPublication></d2LogicalModel>"#;
        let statuses = parse_statuses(xml).unwrap();
        assert_eq!(statuses.len(), 2, "« unknown » est ignoré");
        assert_eq!(statuses["MQA01.E1"].0, 0);
        assert_eq!(statuses["MY269.A1"].0, 2);
        assert_eq!(statuses["MY269.A1"].1, "2026-11-10T03:01:00+01:00".parse::<Timestamp>().unwrap().as_second());
    }

    #[test]
    fn lit_les_vitesses_et_les_debits() {
        let xml = r#"<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><payloadPublication xsi:type="MeasuredDataPublication">
<siteMeasurements><measurementSiteReference targetClass="MeasurementSiteRecord" id="MUM76.h1" version="1.0"/><measurementTimeDefault>2026-11-10T02:48:00.000+01:00</measurementTimeDefault>
<measuredValue index="0"><measuredValue><basicData xsi:type="TrafficFlow"><vehicleFlow numberOfInputValuesUsed="15"><vehicleFlowRate>150</vehicleFlowRate></vehicleFlow></basicData></measuredValue></measuredValue>
<measuredValue index="0"><measuredValue><basicData xsi:type="TrafficSpeed"><averageVehicleSpeed numberOfInputValuesUsed="15"><speed>109.0</speed></averageVehicleSpeed></basicData></measuredValue></measuredValue></siteMeasurements>
<siteMeasurements><measurementSiteReference targetClass="MeasurementSiteRecord" id="MB631.B8" version="1.0"/><measurementTimeDefault>2026-11-10T02:48:00.000+01:00</measurementTimeDefault>
<measuredValue index="0"><measuredValue><basicData xsi:type="TrafficSpeed"><averageVehicleSpeed numberOfInputValuesUsed="0"><speed>0.0</speed></averageVehicleSpeed></basicData></measuredValue></measuredValue></siteMeasurements>
</payloadPublication></d2LogicalModel>"#;
        let measures = parse_measures(xml).unwrap();
        assert_eq!(measures["MUM76.h1"].speed, Some(109.0));
        assert_eq!(measures["MUM76.h1"].flow, Some(150));
        assert_eq!(measures["MB631.B8"].speed, None, "0 km/h = pas de mesure");
    }

    #[test]
    fn lit_la_page_d_index_des_fichiers() {
        let html = r#"<a href="?C=N;O=D">Name</a><a href="/publication/x/">Parent Directory</a><a href="TraficLyon_DataTRT_20261110_030303.xml">a</a><a href="TraficLyon_DataTRT_20261110_030203.xml">b</a>"#;
        assert_eq!(first_xml(html).as_deref(), Some("TraficLyon_DataTRT_20261110_030303.xml"));
        assert_eq!(directories(r#"<a href="../">..</a><a href="TraficLyon/">x</a><a href="ALIENOR/">y</a>"#), vec!["TraficLyon", "ALIENOR"]);
    }

    #[test]
    fn lit_les_troncons_de_rennes_et_ecarte_les_mesures_perimees() {
        let json = r#"{"type":"FeatureCollection","features":[
{"type":"Feature","geometry":{"coordinates":[[-1.780854079268146,48.09248103411798],[-1.780979993719096,48.09245101921883]],"type":"LineString"},"properties":{"gml_id":"v_rva_trafic_fcd.65966_G","id_troncon":"65966_G","denomination":"Rue Nationale","fcd_datetime":"2026-11-09T09:30:00+00:00","fcd_avg_speed":20,"fcd_travel_time":2,"fcd_reliability":57,"fcd_trafic_status":"heavy"}},
{"type":"Feature","geometry":{"coordinates":[[-1.7,48.1],[-1.71,48.11]],"type":"LineString"},"properties":{"id_troncon":"1_D","denomination":"Rue X","fcd_datetime":"2026-11-09T09:30:00+00:00","fcd_avg_speed":0,"fcd_trafic_status":"unknown"}}]}"#;
        let at = "2026-11-09T09:40:00Z".parse::<Timestamp>().unwrap().as_second();
        let sections = parse_rennes(json, at).unwrap();
        assert_eq!(sections.len(), 1, "l'état inconnu est ignoré");
        assert_eq!((sections[0].state, sections[0].speed), (1, Some(20.0)));
        assert_eq!(sections[0].name.as_deref(), Some("Rue Nationale"));
        // Le même jeu, vu le lendemain : tout est périmé.
        assert!(parse_rennes(json, at + 24 * 3600).unwrap().is_empty());
    }
}
