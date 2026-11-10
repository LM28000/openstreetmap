//! Vélos en libre-service : tous les réseaux à stations de France (Vélib', Vélo'v,
//! VélôToulouse…), au format GBFS, rassemblés en une seule liste.
//!
//! La liste des réseaux vient du catalogue de transport.data.gouv.fr (jeux de données
//! « partage de véhicules » étiquetés `vls`). Pour chaque réseau, le fichier GBFS
//! racine indique où trouver la description des stations (rarement modifiée) et leur
//! état (vélos et places disponibles, mis à jour en continu).

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use jiff::Timestamp;
use serde::Serialize;
use serde_json::Value;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::state::AppState;

const CATALOG_URL: &str = "https://transport.data.gouv.fr/api/datasets";
/// État des stations : chaque minute (les réseaux le mettent à jour à peu près à ce rythme).
const STATUS_EVERY: Duration = Duration::from_secs(60);
/// Catalogue des réseaux et description des stations : quelques fois par jour.
const CATALOG_EVERY: Duration = Duration::from_secs(6 * 3600);
const PARALLEL: usize = 8;

/// Un réseau et ses stations (description fixe).
struct Network {
    name: String,
    status_url: String,
    stations: HashMap<String, StationInfo>,
    /// Types de vélos électriques déclarés par le réseau (GBFS 2.x).
    electric_types: Vec<String>,
}

struct StationInfo {
    name: String,
    lon: f64,
    lat: f64,
    capacity: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StationOut<'a> {
    /// Indice dans `networks`.
    network: usize,
    name: &'a str,
    lon: f64,
    lat: f64,
    capacity: Option<u32>,
    bikes: u32,
    /// Vélos à assistance électrique parmi `bikes`, si le réseau le précise.
    ebikes: Option<u32>,
    docks: u32,
    renting: bool,
    reported_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BikesOut<'a> {
    updated_at: i64,
    networks: Vec<&'a str>,
    stations: Vec<StationOut<'a>>,
}

/// Recharge le catalogue de temps en temps, et l'état des stations chaque minute.
pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let mut networks: Vec<Network> = Vec::new();
    let mut catalog_loaded_at: Option<std::time::Instant> = None;
    loop {
        if catalog_loaded_at.is_none_or(|at| at.elapsed() > CATALOG_EVERY) {
            match load_networks(&http).await {
                Ok(list) if !list.is_empty() => {
                    info!(reseaux = list.len(), stations = list.iter().map(|n| n.stations.len()).sum::<usize>(), "vélos : réseaux chargés");
                    networks = list;
                    catalog_loaded_at = Some(std::time::Instant::now());
                }
                Ok(_) => warn!("vélos : aucun réseau trouvé"),
                Err(error) => warn!("vélos : catalogue indisponible : {error:#}"),
            }
        }
        if !networks.is_empty() {
            match refresh_status(&http, &networks).await {
                Ok(body) => state.set_bikes(body),
                Err(error) => warn!("vélos : état indisponible : {error:#}"),
            }
        }
        tokio::time::sleep(STATUS_EVERY).await;
    }
}

/// Réseaux à stations du catalogue, avec la description de leurs stations.
async fn load_networks(http: &reqwest::Client) -> Result<Vec<Network>> {
    let catalog = get_json(http, CATALOG_URL).await?;
    let mut roots: Vec<(String, String)> = Vec::new();
    for dataset in catalog.as_array().context("catalogue inattendu")? {
        let is_bike_sharing = dataset["type"] == "vehicles-sharing"
            && dataset["tags"].as_array().is_some_and(|tags| tags.iter().any(|t| t == "vls"));
        if !is_bike_sharing {
            continue;
        }
        let title = dataset["title"].as_str().unwrap_or_default();
        let name = title.strip_prefix("VLS ").unwrap_or(title).to_string();
        for resource in dataset["resources"].as_array().into_iter().flatten() {
            if resource["format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("gbfs"))
                && let Some(url) = resource["url"].as_str().or(resource["original_url"].as_str())
                && !roots.iter().any(|(_, u)| u == url)
            {
                roots.push((name.clone(), url.to_string()));
            }
        }
    }

    let mut tasks = JoinSet::new();
    let mut networks = Vec::new();
    let mut queue = roots.into_iter();
    loop {
        while tasks.len() < PARALLEL {
            let Some((name, url)) = queue.next() else { break };
            let http = http.clone();
            tasks.spawn(async move { load_network(&http, name.clone(), &url).await.with_context(|| name) });
        }
        match tasks.join_next().await {
            Some(Ok(Ok(Some(network)))) => networks.push(network),
            Some(Ok(Ok(None))) => {}
            Some(Ok(Err(error))) => warn!("vélos : réseau ignoré : {error:#}"),
            Some(Err(error)) => warn!("vélos : tâche interrompue : {error}"),
            None => break,
        }
    }
    // Un même réseau peut être publié deux fois (deux jeux de données) : on garde le premier.
    let mut seen = std::collections::HashSet::new();
    networks.retain(|n| seen.insert(n.status_url.clone()));
    Ok(networks)
}

async fn get_json(http: &reqwest::Client, url: &str) -> Result<Value> {
    let response = http.get(url).timeout(Duration::from_secs(30)).send().await?.error_for_status()?;
    Ok(serde_json::from_slice(&response.bytes().await?)?)
}

/// Lit le fichier GBFS racine d'un réseau. `None` s'il n'a pas de stations (vélos en libre circulation).
async fn load_network(http: &reqwest::Client, name: String, root_url: &str) -> Result<Option<Network>> {
    let root = get_json(http, root_url).await?;
    // GBFS 1.x/2.x : flux rangés par langue ; on prend le français, sinon la première langue.
    let by_language = &root["data"];
    let feeds = by_language["fr"]["feeds"]
        .as_array()
        .or_else(|| by_language.as_object().and_then(|langs| langs.values().find_map(|l| l["feeds"].as_array())))
        .or_else(|| by_language["feeds"].as_array())
        .context("flux GBFS introuvables")?;
    let url_of = |feed: &str| {
        feeds.iter().find(|f| f["name"] == feed).and_then(|f| f["url"].as_str()).map(str::to_string)
    };
    let (Some(info_url), Some(status_url)) = (url_of("station_information"), url_of("station_status")) else {
        return Ok(None);
    };

    let info = get_json(http, &info_url).await?;
    let mut stations = HashMap::new();
    for station in info["data"]["stations"].as_array().into_iter().flatten() {
        let (Some(id), Some(lat), Some(lon)) = (station_id(station), station["lat"].as_f64(), station["lon"].as_f64()) else {
            continue;
        };
        stations.insert(
            id,
            StationInfo {
                name: text(&station["name"]),
                lon,
                lat,
                capacity: station["capacity"].as_u64().map(|c| c as u32),
            },
        );
    }

    // GBFS 2.x : les types de véhicules disent lesquels sont électriques.
    let mut electric_types = Vec::new();
    if let Some(types_url) = url_of("vehicle_types")
        && let Ok(types) = get_json(http, &types_url).await
    {
        for vehicle in types["data"]["vehicle_types"].as_array().into_iter().flatten() {
            let propulsion = vehicle["propulsion_type"].as_str().unwrap_or_default();
            if propulsion.starts_with("electric")
                && let Some(id) = vehicle["vehicle_type_id"].as_str()
            {
                electric_types.push(id.to_string());
            }
        }
    }
    Ok(Some(Network { name, status_url, stations, electric_types }))
}

/// L'identifiant d'une station est un texte ou un nombre selon les réseaux.
fn station_id(station: &Value) -> Option<String> {
    match &station["station_id"] {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Un nom est un texte (GBFS 2.x) ou une liste de traductions (GBFS 3).
fn text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items.first().and_then(|i| i["text"].as_str()).unwrap_or_default().to_string(),
        _ => String::new(),
    }
}

/// Récupère l'état de toutes les stations et prépare la réponse de l'API.
async fn refresh_status(http: &reqwest::Client, networks: &[Network]) -> Result<Vec<u8>> {
    let mut tasks = JoinSet::new();
    for (index, network) in networks.iter().enumerate() {
        let (http, url) = (http.clone(), network.status_url.clone());
        tasks.spawn(async move { (index, get_json(&http, &url).await) });
    }
    let mut statuses: Vec<Option<Value>> = vec![None; networks.len()];
    while let Some(joined) = tasks.join_next().await {
        if let Ok((index, Ok(status))) = joined {
            statuses[index] = Some(status);
        }
    }

    let mut stations = Vec::new();
    for (index, (network, status)) in networks.iter().zip(&statuses).enumerate() {
        let Some(status) = status else { continue };
        for entry in status["data"]["stations"].as_array().into_iter().flatten() {
            let Some(info) = station_id(entry).and_then(|id| network.stations.get(&id)) else { continue };
            let count = |key: &str| entry[key].as_u64().map(|v| v as u32);
            stations.push(StationOut {
                network: index,
                name: &info.name,
                lon: info.lon,
                lat: info.lat,
                capacity: info.capacity,
                bikes: count("num_bikes_available").or_else(|| count("num_vehicles_available")).unwrap_or(0),
                ebikes: electric_bikes(entry, &network.electric_types),
                docks: count("num_docks_available").unwrap_or(0),
                renting: entry["is_renting"].as_bool().or_else(|| entry["is_renting"].as_u64().map(|v| v == 1)).unwrap_or(true),
                reported_at: entry["last_reported"].as_i64(),
            });
        }
    }
    let body = serde_json::to_vec(&BikesOut {
        updated_at: Timestamp::now().as_second(),
        networks: networks.iter().map(|n| n.name.as_str()).collect(),
        stations,
    })?;
    Ok(body)
}

/// Vélos électriques : liste par type (Vélib') ou types de véhicules GBFS 2.x.
fn electric_bikes(entry: &Value, electric_types: &[String]) -> Option<u32> {
    if let Some(types) = entry["num_bikes_available_types"].as_array() {
        return Some(types.iter().filter_map(|t| t["ebike"].as_u64()).sum::<u64>() as u32);
    }
    let available = entry["vehicle_types_available"].as_array()?;
    if electric_types.is_empty() {
        return None;
    }
    let electric = available
        .iter()
        .filter(|t| t["vehicle_type_id"].as_str().is_some_and(|id| electric_types.iter().any(|e| e == id)))
        .filter_map(|t| t["count"].as_u64())
        .sum::<u64>();
    Some(electric as u32)
}
