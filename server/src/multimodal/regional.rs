//! Cars interurbains des régions et des départements (BreizhGo, Aléop, liO, Fluo, Rémi, Mobigo, ZOU !, Nomad…),
//! lus dans les GTFS du catalogue de transport.data.gouv.fr. Ils desservent des villes sans gare : Fougères, par exemple,
//! n'est atteinte que par les cars BreizhGo.
//!
//! # Comment on choisit les jeux de données (le catalogue en compte ~800, dont ~140 réseaux de transport)
//!
//! 1. **Le titre.** Les réseaux interurbains se déclarent « Réseau interurbain … » (« Réseau interurbain BreizhGo Car »,
//!    « Réseau interurbain - Gironde (33) »). On garde les jeux de type `public-transit` dont le titre contient
//!    « interurbain ». On écarte les agrégats (« Agrégat des réseaux urbains et interurbains de… » : mêlent tout, et
//!    chaque réseau y a de toute façon son propre jeu), les trains (« Trains régionaux », TER), les bateaux et la
//!    région Île-de-France (traitée à part, `idfm.rs`), les transports à la demande (« TAD ») et les réseaux
//!    scolaires (« Réseau scolaire interurbain ZOU ! »). Le catalogue est lu chaque jour : un nouveau réseau
//!    interurbain est pris sans changer le code.
//! 2. **La ressource.** Les GTFS marqués disponibles (jusqu'à 8 par jeu : Mobigo en publie un par département).
//! 3. **La ligne** (`routes.txt`) : `route_type` 3 (bus), 200 à 209 (car) ou 700 à 799 (bus étendus) ; on écarte les lignes dont
//!    le nom ou la description parle de transport scolaire ou « à la demande ».
//! 4. **La circulation** (`feed::is_interurban`) : les jeux interurbains contiennent des lignes urbaines (une petite
//!    agglomération confiée au même exploitant). On ne garde que les circulations d'au moins 8 km entre premier et
//!    dernier arrêt, avec un arrêt tous les 500 m ou plus. On écarte aussi les passages « sur réservation » (`pickup_type`
//!    2 ou 3 sur la moitié des arrêts) : ils ne sont pas un horaire.
//!
//! Les circulations réservées aux jours d'école ne sont pas distinguées : les calendriers les donnent comme les autres.
//! Sur la fenêtre d'une journée ordinaire, elles restent des cars que n'importe qui peut prendre sur les GTFS « interurbain ».

use std::path::Path;

use anyhow::Result;
use jiff::civil::Date;
use serde_json::Value;

use super::feed::{FeedSpec, RouteRow, read};
use super::{Kind, Line, RawFeed};
use crate::transit::{is_excluded, network_name};

/// Un réseau choisi dans le catalogue.
#[derive(Clone, Debug, PartialEq)]
pub struct Network {
    pub slug: String,
    /// « BreizhGo », « Gironde »… : ce qui suit « Car » dans « Car BreizhGo 7 ».
    pub name: String,
    pub licence: String,
    /// (identifiant de ressource, adresse) de ses GTFS.
    pub resources: Vec<(String, String)>,
}

const MAX_GTFS_PER_NETWORK: usize = 8;

/// Les réseaux interurbains du catalogue (voir l'en-tête du module).
pub fn select(catalog: &Value) -> Vec<Network> {
    let mut networks = Vec::new();
    for dataset in catalog.as_array().map(Vec::as_slice).unwrap_or_default() {
        let title = dataset["title"].as_str().unwrap_or_default();
        let lower = title.to_lowercase();
        if dataset["type"] != "public-transit" || !lower.contains("interurbain") || is_excluded(title) {
            continue;
        }
        let rejected = ["scolaire interurbain", "train", " ter ", "maritime", "bacs", "île-de-france", "ile-de-france", "bateau", "tad ", "à la demande", "finist"];
        if rejected.iter().any(|word| lower.contains(word)) {
            continue;
        }
        let resources: Vec<(String, String)> = dataset["resources"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter(|r| r["format"].as_str().is_some_and(|f| f.eq_ignore_ascii_case("gtfs")) && r["is_available"].as_bool().unwrap_or(false))
            .filter_map(|r| Some((r["datagouv_id"].as_str()?.to_string(), r["url"].as_str()?.to_string())))
            .take(MAX_GTFS_PER_NETWORK)
            .collect();
        if resources.is_empty() {
            continue;
        }
        networks.push(Network {
            slug: dataset["slug"].as_str().unwrap_or(title).to_string(),
            name: short_name(title),
            licence: dataset["licence"].as_str().unwrap_or_default().to_string(),
            resources,
        });
    }
    networks
}

/// « Réseau interurbain - Gironde (33) » → « Gironde » ; « Réseau interurbain BreizhGo Car » → « BreizhGo ».
fn short_name(title: &str) -> String {
    let name = network_name(title);
    let name = name.trim_start_matches(['-', ' ']);
    // « (33) », « (expérimentation) » : parenthèses finales.
    let name = match (name.rfind(" ("), name.ends_with(')')) {
        (Some(at), true) => &name[..at],
        _ => name,
    };
    // Le mot « Car » est déjà dans « Car BreizhGo 7 ».
    let words: Vec<&str> = name.split_whitespace().filter(|w| !matches!(w.to_lowercase().as_str(), "car" | "cars")).collect();
    if words.is_empty() { name.to_string() } else { words.join(" ") }
}

/// Une ligne de car interurbain : gardée si c'est un car (ou un bus) qui n'est ni scolaire ni à la demande.
pub fn classify(network: &str) -> impl Fn(&RouteRow) -> Option<Line> + '_ {
    move |row| {
        let is_bus = matches!(row.route_type, 3 | 200..=209 | 700..=799);
        let text = format!("{} {} {}", row.short, row.long, row.desc).to_lowercase();
        if !is_bus || text.contains("scolaire") || text.contains("à la demande") || text.contains("a la demande") || text.split_whitespace().any(|w| w == "tad") {
            return None;
        }
        let short = row.short.trim();
        let label = if short.is_empty() { format!("Car {network}") } else { format!("Car {network} {short}") };
        Some(Line { kind: Kind::Coach, label, name: row.long.clone(), color: row.color.clone(), text_color: row.text_color.clone() })
    }
}

/// Lit un GTFS de réseau interurbain.
pub fn read_feed(path: &Path, network: &str, first_day: Date, days: u8) -> Result<RawFeed> {
    let classify = classify(network);
    read(
        path,
        &FeedSpec { name: network, first_day, days, classify: &classify, use_parent: true, interurban_only: true, keep_stop: None, match_by_name: false },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dataset(title: &str, kind: &str) -> Value {
        json!({
            "title": title, "type": kind, "slug": title.to_lowercase().replace(' ', "-"), "licence": "odc-odbl",
            "resources": [{ "format": "GTFS", "is_available": true, "datagouv_id": "id-1", "url": "https://exemple.fr/gtfs.zip" }],
        })
    }

    #[test]
    fn le_catalogue_ne_garde_que_les_reseaux_interurbains() {
        let catalog = json!([
            dataset("Réseau interurbain BreizhGo Car", "public-transit"),
            dataset("Réseau interurbain - Gironde (33)", "public-transit"),
            dataset("Réseau urbain TCL", "public-transit"),
            dataset("Agrégat des réseaux urbains et interurbains de Bretagne", "public-transit"),
            dataset("Réseau scolaire interurbain ZOU !", "public-transit"),
            dataset("Réseau interurbain BreizhGo Bateaux", "public-transit"),
            dataset("Réseaux urbains et interurbains d'Île-de-France Mobilités (IDFM)", "public-transit"),
            dataset("Réseau interurbain Fluo Grand-Est - Bas-Rhin (67)", "public-transit"),
            dataset("Réseau interurbain exemple", "bike-sharing"),
        ]);
        let names: Vec<String> = select(&catalog).into_iter().map(|n| n.name).collect();
        assert_eq!(names, ["BreizhGo", "Gironde", "Fluo Grand-Est - Bas-Rhin"]);
    }

    fn row(short: &str, long: &str, route_type: i32) -> RouteRow {
        RouteRow { short: short.into(), long: long.into(), desc: String::new(), route_type, color: Some("BF005F".into()), text_color: None }
    }

    #[test]
    fn les_lignes_scolaires_et_les_non_cars_sont_ecartees() {
        let classify = classify("BreizhGo");
        assert_eq!(classify(&row("7", "Rennes - Fougères", 3)).map(|l| l.label), Some("Car BreizhGo 7".into()));
        assert_eq!(classify(&row("", "Rennes - Fougères", 200)).map(|l| l.label), Some("Car BreizhGo".into()));
        assert!(classify(&row("S12", "Ligne scolaire Fougères", 3)).is_none());
        assert!(classify(&row("T1", "Transport à la demande", 3)).is_none());
        assert!(classify(&row("TER", "Rennes - Brest", 2)).is_none());
        assert!(classify(&row("B", "Bateau", 4)).is_none());
    }
}
