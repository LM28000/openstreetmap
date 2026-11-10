//! Trafic routier : les événements en cours sur le réseau routier national non concédé
//! (routes nationales et autoroutes gérées par l'État, soit les DIR : directions
//! interdépartementales des routes), publiés par Bison Futé au format DATEX II.
//!
//! Source : « Évènements routiers - Réseau routier non concédé » sur transport.data.gouv.fr,
//! fichier `Evenementiel-DIR/grt/RRN/content.xml` du serveur Tipi de Bison Futé.
//! Licence Ouverte 2.0, sans clé ni inscription. Le fichier (environ 3 Mo, un instantané de
//! tous les événements) est régénéré à chaque changement ; le serveur le relit toutes les
//! deux minutes, en demandant d'abord s'il a changé (`ETag`).
//!
//! Les autoroutes concédées (APRR, Vinci, Sanef…) n'y figurent pas : elles ne publient pas
//! leurs événements en DATEX II ouvert. Les bouchons ne couvrent donc que le réseau de l'État
//! (nationales, voies rapides urbaines, quelques autoroutes).
//!
//! Un événement DATEX II est une « situation » qui contient un ou plusieurs « enregistrements »
//! (`situationRecord`) ; on garde chaque enregistrement qu'on sait classer, avec sa position
//! (un point, ou un tronçon entre deux points).

use std::time::Duration;

use anyhow::{Context, Result};
use jiff::Timestamp;
use roxmltree::{Document, Node};
use serde::Serialize;
use tracing::{info, warn};

use crate::state::AppState;

const SOURCE_URL: &str = "http://tipi.bison-fute.gouv.fr/bison-fute-ouvert/publicationsDIR/Evenementiel-DIR/grt/RRN/content.xml";
const REFRESH_EVERY: Duration = Duration::from_secs(120);

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Event {
    /// Identifiant de l'enregistrement DATEX II (stable tant que l'événement dure).
    id: String,
    /// `bouchon`, `accident`, `fermeture`, `travaux` ou `danger`.
    kind: &'static str,
    /// Nature précise, en français (« Voie neutralisée », « Chutes de pierres »…).
    label: String,
    /// Gravité de 1 (faible) à 4 (très grave). Pour un bouchon : longueur et type de ralentissement.
    severity: u8,
    lon: f64,
    lat: f64,
    /// Début et fin du tronçon touché, quand l'événement n'est pas un point.
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<[[f64; 2]; 2]>,
    /// Longueur du tronçon, en mètres.
    #[serde(skip_serializing_if = "Option::is_none")]
    length_m: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    road: Option<String>,
    /// Communes de début et de fin (ou la seule commune, pour un point).
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    direction: Option<&'static str>,
    /// Début et fin de validité (secondes UTC) ; sans fin, l'événement dure jusqu'à nouvel ordre.
    #[serde(skip_serializing_if = "Option::is_none")]
    start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end: Option<i64>,
    /// « Uniquement de nuit », « du lundi au vendredi »…
    #[serde(skip_serializing_if = "Option::is_none")]
    period: Option<String>,
    /// Texte libre rédigé par la DIR.
    #[serde(skip_serializing_if = "Option::is_none")]
    comment: Option<String>,
    /// Précision de position (« situé 804 m au nord de Tarascon »).
    #[serde(skip_serializing_if = "Option::is_none")]
    location: Option<String>,
    /// Voies fermées et voies au total.
    #[serde(skip_serializing_if = "Option::is_none")]
    lanes: Option<(u32, u32)>,
    /// Source : la DIR qui a saisi l'événement.
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// Événement annoncé mais pas certain (« probable »).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    uncertain: bool,
    /// Dernière modification (secondes UTC).
    #[serde(skip_serializing_if = "Option::is_none")]
    updated: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Out {
    /// Instant de la collecte (secondes UTC).
    updated_at: i64,
    /// Instant de publication du fichier par Bison Futé (secondes UTC).
    published_at: Option<i64>,
    events: Vec<Event>,
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let mut etag: Option<String> = None;
    loop {
        match fetch(&http, etag.as_deref()).await {
            Ok(Fetched::Unchanged) => {}
            Ok(Fetched::New { xml, etag: new_etag }) => {
                // L'analyse du XML (3 Mo) prend quelques millisecondes : hors du fil des requêtes tout de même.
                match tokio::task::spawn_blocking(move || decode(&xml)).await {
                    Ok(Ok((body, count))) => {
                        info!(evenements = count, "trafic : événements mis à jour");
                        state.set_traffic(body);
                        etag = new_etag;
                    }
                    Ok(Err(error)) => warn!("trafic : flux illisible : {error:#}"),
                    Err(error) => warn!("trafic : tâche interrompue : {error}"),
                }
            }
            Err(error) => warn!("trafic : flux indisponible : {error:#}"),
        }
        tokio::time::sleep(REFRESH_EVERY).await;
    }
}

enum Fetched {
    Unchanged,
    New { xml: String, etag: Option<String> },
}

async fn fetch(http: &reqwest::Client, etag: Option<&str>) -> Result<Fetched> {
    let mut request = http.get(SOURCE_URL).timeout(Duration::from_secs(60));
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request.send().await?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Fetched::Unchanged);
    }
    let response = response.error_for_status()?;
    let etag = response.headers().get(reqwest::header::ETAG).and_then(|v| v.to_str().ok()).map(str::to_string);
    Ok(Fetched::New { xml: response.text().await?, etag })
}

// --- Lecture du DATEX II ---------------------------------------------------------------------

/// Premier enfant portant ce nom local (les espaces de noms varient : `ns2:` ou par défaut).
fn child<'a, 'i>(node: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    node.children().find(|c| c.is_element() && c.tag_name().name() == name)
}

/// Texte du premier descendant de ce nom.
fn descendant_text(node: Node, name: &str) -> Option<String> {
    node.descendants().find(|d| d.is_element() && d.tag_name().name() == name).and_then(|d| d.text()).map(|t| t.trim().to_string())
}

fn child_text(node: Node, name: &str) -> Option<String> {
    child(node, name).and_then(|c| c.text()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty())
}

/// Un texte multilingue DATEX II : `<values><value lang="fr">…</value></values>`.
fn multilingual(node: Node) -> Option<String> {
    let values = node.descendants().filter(|d| d.is_element() && d.tag_name().name() == "value");
    let mut first = None;
    for value in values {
        let text = value.text().map(str::trim).filter(|t| !t.is_empty())?;
        if value.attribute("lang").is_some_and(|l| l.eq_ignore_ascii_case("fr")) {
            return Some(text.to_string());
        }
        first.get_or_insert(text);
    }
    first.map(str::to_string)
}

fn parse_time(text: &str) -> Option<i64> {
    text.trim().parse::<Timestamp>().ok().map(|t| t.as_second())
}

fn severity_of(situation: Node) -> u8 {
    match child_text(situation, "overallSeverity").as_deref() {
        Some("highest") => 4,
        Some("high") => 3,
        Some("low" | "lowest") => 1,
        _ => 2,
    }
}

/// Coordonnées d'un point (`pointCoordinates`) et noms associés (commune, route).
struct Place {
    lon: f64,
    lat: f64,
    town: Option<String>,
    link: Option<String>,
}

fn place(point: Node) -> Option<Place> {
    let coordinates = point.descendants().find(|d| d.is_element() && d.tag_name().name() == "pointCoordinates")?;
    let lat = child_text(coordinates, "latitude")?.parse::<f64>().ok()?;
    let lon = child_text(coordinates, "longitude")?.parse::<f64>().ok()?;
    if !(lat.is_finite() && lon.is_finite()) || (lat == 0.0 && lon == 0.0) {
        return None;
    }
    let (mut town, mut link) = (None, None);
    for name in point.children().filter(|c| c.is_element() && c.tag_name().name() == "name") {
        let kind = child_text(name, "tpegOtherPointDescriptorType");
        let text = child(name, "descriptor").and_then(multilingual);
        match kind.as_deref() {
            Some("townName") => town = town.or(text),
            Some("linkName") => link = link.or(text),
            _ => {}
        }
    }
    Some(Place { lon, lat, town, link })
}

/// « A0047 » → « A47 », « N0020 » → « N20 », « D1075 » inchangé.
fn road_number(raw: &str) -> String {
    let split = raw.find(|c: char| c.is_ascii_digit()).unwrap_or(raw.len());
    let (letters, digits) = raw.split_at(split);
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() { raw.to_string() } else { format!("{letters}{digits}") }
}

fn distance_m(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (lat1, lat2) = (a.1.to_radians(), b.1.to_radians());
    let (dlat, dlon) = (lat2 - lat1, (b.0 - a.0).to_radians());
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * 6_371_000.0 * h.sqrt().asin()
}

fn direction_label(tpeg: &str) -> Option<&'static str> {
    Some(match tpeg {
        "bothWays" => "dans les deux sens",
        "northBound" => "vers le nord",
        "southBound" => "vers le sud",
        "eastBound" => "vers l’est",
        "westBound" => "vers l’ouest",
        "northEastBound" => "vers le nord-est",
        "northWestBound" => "vers le nord-ouest",
        "southEastBound" => "vers le sud-est",
        "southWestBound" => "vers le sud-ouest",
        "innerRing" => "sur l’anneau intérieur",
        "outerRing" => "sur l’anneau extérieur",
        "clockwise" => "dans le sens des aiguilles d’une montre",
        "anticlockwise" => "dans le sens inverse des aiguilles d’une montre",
        _ => return None,
    })
}

/// Ce que dit l'enregistrement : la famille, la nature, la gravité. `None` pour les enregistrements
/// qu'on ne montre pas (déviations, limitations de vitesse, consignes générales…).
fn classify(record: Node, situation_severity: u8) -> Option<(&'static str, String, u8)> {
    let xsi_type = record
        .attributes()
        .find(|a| a.name() == "type" && a.namespace().is_some_and(|n| n.contains("XMLSchema-instance")))
        .map(|a| a.value().rsplit(':').next().unwrap_or(a.value()).to_string())?;
    let detail = |element: &str| child_text(record, element);
    let sev = situation_severity;
    Some(match xsi_type.as_str() {
        "AbnormalTraffic" => {
            let queue = detail("queueLength").and_then(|q| q.parse::<f64>().ok()).unwrap_or(0.0);
            let (label, base) = match detail("abnormalTrafficType").as_deref() {
                Some("stationaryTraffic") => ("Trafic à l’arrêt", 4),
                Some("queuingTraffic") => ("Bouchon", 2),
                Some("slowTraffic") => ("Trafic ralenti", 1),
                Some("heavyTraffic") => ("Trafic dense", 1),
                _ => ("Trafic perturbé", 1),
            };
            // Un bouchon de plus de 2 km est important, de plus de 5 km très important.
            let by_length = if queue >= 5000.0 { 4 } else if queue >= 2000.0 { 3 } else { 0 };
            let by_flag = if sev >= 3 && base >= 2 { 3 } else { 0 };
            ("bouchon", label.to_string(), base.max(by_length).max(by_flag))
        }
        "Accident" => ("accident", "Accident".to_string(), sev.max(2)),
        "RoadOrCarriagewayOrLaneManagement" => match detail("roadOrCarriagewayOrLaneManagementType").as_deref()? {
            "roadClosed" | "carriagewayClosures" => ("fermeture", "Route fermée".to_string(), 4),
            "closedPermanentlyForTheWinter" => ("fermeture", "Fermée pour l’hiver".to_string(), 2),
            "intermittentShortTermClosures" => ("fermeture", "Fermetures de courte durée".to_string(), 3),
            "laneClosures" => ("travaux", "Voie neutralisée".to_string(), sev),
            "singleAlternateLineTraffic" => ("travaux", "Circulation alternée".to_string(), sev),
            "contraflow" => ("travaux", "Circulation à contresens".to_string(), sev),
            "narrowLanes" => ("travaux", "Voies rétrécies".to_string(), sev),
            _ => return None,
        },
        "MaintenanceWorks" => {
            let label = match detail("roadMaintenanceType").as_deref() {
                Some("maintenanceWork") => "Travaux d’entretien",
                Some("repairWork") => "Travaux de réparation",
                Some("grassCuttingWork") => "Fauchage",
                Some("roadsideWork") => "Travaux en bordure de route",
                Some("roadMarkingWork") => "Marquage au sol",
                Some("resurfacingWork") => "Réfection de la chaussée",
                Some("bridgeMaintenance") => "Entretien d’un pont",
                Some("treeAndVegetationCuttingWork") => "Élagage",
                Some("installationWork") => "Travaux d’installation",
                _ => "Travaux",
            };
            ("travaux", label.to_string(), sev)
        }
        "ConstructionWorks" => ("travaux", "Chantier".to_string(), sev),
        "GeneralObstruction" => {
            let label = match detail("obstructionType").as_deref() {
                Some("objectOnTheRoad") => "Objet sur la chaussée",
                Some("obstructionOnTheRoad") => "Obstacle sur la chaussée",
                Some("incident") => "Incident",
                Some("rescueAndRecoveryWork") => "Intervention de secours ou de dépannage",
                _ => "Obstacle",
            };
            ("danger", label.to_string(), sev)
        }
        "EnvironmentalObstruction" => {
            let label = match detail("environmentalObstructionType").as_deref() {
                Some("rockfalls") => "Chutes de pierres",
                Some("subsidence") => "Affaissement de la chaussée",
                Some("flooding") => "Inondation",
                Some("mudSlide") => "Coulée de boue",
                Some("snowDrifts") => "Congères",
                Some("fallenTrees") => "Arbres tombés",
                Some("landslip") => "Glissement de terrain",
                Some("avalanches") => "Avalanche",
                _ => "Obstacle naturel",
            };
            ("danger", label.to_string(), sev.max(3))
        }
        "InfrastructureDamageObstruction" => ("danger", "Chaussée dégradée".to_string(), sev),
        "AnimalPresenceObstruction" => ("danger", "Animaux sur la route".to_string(), sev),
        "VehicleObstruction" => {
            let label = match detail("vehicleObstructionType").as_deref() {
                Some("brokenDownVehicle") => "Véhicule en panne",
                Some("abandonedVehicle") => "Véhicule abandonné",
                Some("vehicleOnWrongCarriageway") => "Véhicule à contresens",
                Some("vehicleStuck") => "Véhicule bloqué",
                _ => "Véhicule arrêté",
            };
            ("danger", label.to_string(), sev)
        }
        "WeatherRelatedRoadConditions" => {
            let label = match detail("weatherRelatedRoadConditionType").as_deref() {
                Some("snowOnTheRoad") => "Neige sur la route",
                Some("ice" | "blackIce") => "Verglas",
                Some("slushOnRoad") => "Neige fondue sur la route",
                Some("wetAndIcyRoad") => "Route humide et verglacée",
                Some("surfaceWater") => "Eau sur la chaussée",
                Some("mudOnRoad") => "Boue sur la route",
                _ => "Conditions météo dégradées",
            };
            let impossible = detail("drivingConditionType").as_deref() == Some("impossible");
            ("danger", label.to_string(), if impossible { 4 } else { sev.max(3) })
        }
        "PoorEnvironmentConditions" => ("danger", "Visibilité ou conditions dégradées".to_string(), sev),
        "NonWeatherRelatedRoadConditions" => ("danger", "Chaussée glissante".to_string(), sev),
        _ => return None,
    })
}

/// Un enregistrement avec une position : le tronçon (début, fin) ou le point.
struct Geometry {
    start: Place,
    end: Option<Place>,
    direction: Option<&'static str>,
}

fn geometry(record: Node) -> Option<Geometry> {
    let group = child(record, "groupOfLocations")?;
    if let Some(linear) = group.descendants().find(|d| d.is_element() && d.tag_name().name() == "tpegLinearLocation") {
        let direction = child_text(linear, "tpegDirection").as_deref().and_then(direction_label);
        let from = child(linear, "from").and_then(place);
        let to = child(linear, "to").and_then(place);
        return match (from, to) {
            (Some(from), Some(to)) => Some(Geometry { start: from, end: Some(to), direction }),
            (Some(only), None) | (None, Some(only)) => Some(Geometry { start: only, end: None, direction }),
            (None, None) => None,
        };
    }
    let point = group.descendants().find(|d| d.is_element() && d.tag_name().name() == "tpegPointLocation")?;
    let direction = child_text(point, "tpegDirection").as_deref().and_then(direction_label);
    let place = child(point, "point").and_then(place)?;
    Some(Geometry { start: place, end: None, direction })
}

fn event_from(record: Node, situation: Node, situation_severity: u8) -> Option<Event> {
    let (kind, label, severity) = classify(record, situation_severity)?;
    // Les enregistrements suspendus ou annulés ne sont plus d'actualité.
    let validity = child(record, "validity");
    if validity.and_then(|v| child_text(v, "validityStatus")).as_deref() == Some("suspended") {
        return None;
    }
    let geometry = geometry(record)?;
    let id = record.attribute("id").or_else(|| situation.attribute("id"))?.to_string();

    let specification = validity.and_then(|v| child(v, "validityTimeSpecification"));
    let start = specification.and_then(|s| child_text(s, "overallStartTime")).as_deref().and_then(parse_time);
    let end = specification.and_then(|s| child_text(s, "overallEndTime")).as_deref().and_then(parse_time);
    let period = specification.and_then(|s| child(s, "validPeriod")).and_then(|p| child(p, "periodName")).and_then(multilingual);

    // Commentaires : « description » est le texte de la DIR ; « locationDescriptor » mélange la position
    // précise et le nom du district, qu'on met à part dans la source.
    let (mut comments, mut locations) = (Vec::new(), Vec::new());
    for public in record.children().filter(|c| c.is_element() && c.tag_name().name() == "generalPublicComment") {
        let (Some(text), Some(kind)) = (child(public, "comment").and_then(multilingual), child_text(public, "commentType")) else { continue };
        match kind.as_str() {
            "description" => comments.push(text),
            "locationDescriptor" if !text.starts_with("DIR ") => locations.push(text),
            _ => {}
        }
    }
    let source = record
        .descendants()
        .find(|d| d.is_element() && d.tag_name().name() == "sourceIdentification")
        .and_then(|d| d.text())
        .map(|s| s.rsplit('/').next().unwrap_or(s).trim().to_string())
        .filter(|s| !s.is_empty());

    let impact = child(record, "impact");
    let lanes = impact.and_then(|i| {
        let restricted = child_text(i, "numberOfLanesRestricted")?.parse().ok()?;
        let total = child_text(i, "originalNumberOfLanes")?.parse().ok()?;
        (total > 0).then_some((restricted, total))
    });

    // La route : le nom de lien du point (« A47 »), sinon le numéro de l'élément linéaire (« A0047 »).
    let road = geometry
        .start
        .link
        .clone()
        .or_else(|| geometry.end.as_ref().and_then(|e| e.link.clone()))
        .or_else(|| descendant_text(record, "roadNumber").map(|n| road_number(&n)))
        .or_else(|| child(record, "groupOfLocations").and_then(|g| g.descendants().find(|d| d.is_element() && d.tag_name().name() == "roadName")).and_then(multilingual));

    let (lon, lat, line, length) = match &geometry.end {
        Some(end) => {
            let length = distance_m((geometry.start.lon, geometry.start.lat), (end.lon, end.lat));
            (
                (geometry.start.lon + end.lon) / 2.0,
                (geometry.start.lat + end.lat) / 2.0,
                Some([[geometry.start.lon, geometry.start.lat], [end.lon, end.lat]]),
                Some(length.round() as u32),
            )
        }
        None => (geometry.start.lon, geometry.start.lat, None, None),
    };
    // Pour un bouchon, la longueur annoncée de la file vaut mieux que la distance entre ses deux repères.
    let length_m = if kind == "bouchon" { child_text(record, "queueLength").and_then(|q| q.parse::<f64>().ok()).map(|q| q.round() as u32).or(length) } else { length };

    Some(Event {
        id,
        kind,
        label,
        severity,
        lon,
        lat,
        line,
        length_m,
        road,
        from: geometry.start.town,
        to: geometry.end.and_then(|e| e.town),
        direction: geometry.direction,
        start,
        end,
        period,
        comment: (!comments.is_empty()).then(|| comments.join(" · ")),
        location: locations.into_iter().next(),
        lanes,
        source,
        uncertain: matches!(child_text(record, "probabilityOfOccurrence").as_deref(), Some("probable" | "riskOf")),
        updated: child_text(record, "situationRecordVersionTime").as_deref().and_then(parse_time),
    })
}

/// Le XML complet → la réponse JSON de l'API et le nombre d'événements.
fn decode(xml: &str) -> Result<(Vec<u8>, usize)> {
    let events_and_time = parse(xml)?;
    let count = events_and_time.1.len();
    let body = serde_json::to_vec(&Out { updated_at: Timestamp::now().as_second(), published_at: events_and_time.0, events: events_and_time.1 })?;
    Ok((body, count))
}

fn parse(xml: &str) -> Result<(Option<i64>, Vec<Event>)> {
    // Le fichier déclare une DTD vide dans certaines versions : on l'autorise, sans l'interpréter.
    let options = roxmltree::ParsingOptions { allow_dtd: true, ..Default::default() };
    let document = Document::parse_with_options(xml, options).context("XML invalide")?;
    let published = document
        .descendants()
        .find(|d| d.is_element() && d.tag_name().name() == "publicationTime")
        .and_then(|d| d.text())
        .and_then(parse_time);
    let mut events = Vec::new();
    for situation in document.descendants().filter(|d| d.is_element() && d.tag_name().name() == "situation") {
        let severity = severity_of(situation);
        for record in situation.children().filter(|c| c.is_element() && c.tag_name().name() == "situationRecord") {
            if let Some(event) = event_from(record, situation, severity) {
                events.push(event);
            }
        }
    }
    if events.is_empty() && !xml.contains("situation") {
        anyhow::bail!("aucune situation dans le fichier : le format a changé");
    }
    Ok((published, events))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extraits réels du fichier de Bison Futé (novembre 2026), réduits à quelques enregistrements :
    /// un bouchon sur l'A47, un accident sur l'A630, une route fermée (N20) et des travaux (N100).
    const SAMPLE: &str = include_str!("testdata/trafic_extrait.xml");

    fn events() -> Vec<Event> {
        parse(SAMPLE).unwrap().1
    }

    fn find<'a>(events: &'a [Event], id: &str) -> &'a Event {
        events.iter().find(|e| e.id == id).unwrap_or_else(|| panic!("événement {id} absent"))
    }

    #[test]
    fn lit_un_bouchon_avec_sa_longueur() {
        let events = events();
        let jam = find(&events, "261109-000155-1");
        assert_eq!(jam.kind, "bouchon");
        assert_eq!(jam.label, "Bouchon");
        // Une file de 3 220 m : bouchon important (3).
        assert_eq!(jam.severity, 3);
        assert_eq!(jam.length_m, Some(3220));
        assert_eq!(jam.road.as_deref(), Some("A47"));
        assert_eq!((jam.from.as_deref(), jam.to.as_deref()), (Some("Givors"), Some("Ternay")));
        assert_eq!(jam.line, Some([[4.7400455, 45.581696], [4.7786126, 45.589035]]));
        assert_eq!(jam.lanes, Some((5, 5)));
        assert_eq!(jam.source.as_deref(), Some("DIR Centre-Est"));
        assert_eq!(jam.start, Some("2026-11-09T06:28:17.274+01:00".parse::<Timestamp>().unwrap().as_second()));
        assert_eq!(jam.direction, Some("vers l’est"));
    }

    #[test]
    fn lit_un_accident_en_un_point() {
        let events = events();
        let accident = find(&events, "261109-002405-102");
        assert_eq!(accident.kind, "accident");
        assert_eq!(accident.line, None);
        assert_eq!(accident.road.as_deref(), Some("A630"));
        assert_eq!((accident.lon, accident.lat), (-0.55748504, 44.883904));
        assert_eq!(accident.location.as_deref(), Some("situé 694 m à l'est de Bordeaux - Lac"));
        assert_eq!(accident.from.as_deref(), Some("Bordeaux"));
    }

    #[test]
    fn lit_une_fermeture_avec_ses_dates_et_sa_periode() {
        let events = events();
        let closure = find(&events, "260122-001843-2");
        assert_eq!(closure.kind, "fermeture");
        assert_eq!(closure.severity, 4);
        assert_eq!(closure.road.as_deref(), Some("N20"));
        assert_eq!(closure.period.as_deref(), Some("Uniquement de nuit"));
        assert_eq!(closure.end, Some("2026-11-20T06:00:00+01:00".parse::<Timestamp>().unwrap().as_second()));
        assert!(closure.uncertain, "« probable » : pas encore certain");
    }

    #[test]
    fn lit_des_travaux_et_ignore_les_consignes() {
        let events = events();
        let works = find(&events, "260303-001546-1");
        assert_eq!(works.kind, "travaux");
        assert_eq!(works.label, "Travaux de réparation");
        assert_eq!(works.comment.as_deref(), Some("Raccordement fibre optique"));
        // L'extrait contient aussi une limitation de vitesse et une déviation : elles ne sont pas montrées.
        assert!(events.iter().all(|e| e.id != "260131-000090-112"), "une limitation de vitesse n'est pas un événement à afficher");
        assert!(events.iter().all(|e| e.id != "260122-001843-3"), "une déviation non plus");
        // Des chutes de pierres, dans la même situation que la limitation : un danger.
        assert_eq!(find(&events, "260131-000090-1").kind, "danger");
    }

    #[test]
    fn convertit_les_numeros_de_route() {
        assert_eq!(road_number("A0047"), "A47");
        assert_eq!(road_number("N0020"), "N20");
        assert_eq!(road_number("D1075"), "D1075");
        assert_eq!(road_number("N0000"), "N0000");
    }

    #[test]
    fn refuse_un_fichier_qui_n_est_pas_du_datex() {
        assert!(parse("<html><body>Maintenance</body></html>").is_err());
    }
}
