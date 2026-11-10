//! Isochrones multimodales : les cars et les transports d'Île-de-France en plus des trains.
//!
//! # Le principe
//!
//! Le réseau ferré partagé avec la couche des trains (`network.rs`, `/api/reseau/{version}`) ne change pas :
//! il ne contient que les gares SNCF. Tout le reste est un **réseau supplémentaire**, qui n'existe que pour les
//! isochrones, et qui vit ici :
//!
//! - des *arrêts supplémentaires* (`ExtraStop`) : arrêts de cars, stations de métro, de RER, de tramway, qui n'ont
//!   pas de gare SNCF. Ils sont numérotés à la suite des gares : l'arrêt `i` des extras est l'arrêt `S + i` de
//!   l'algorithme, `S` étant le nombre de gares ;
//! - des *lignes* (`Line`) : « Car TER », « Car BreizhGo 7 », « RER B », « Métro 14 », avec leur couleur officielle ;
//! - des *circulations* (`ExtraTrip`), rangées dans l'index RAPTOR (`Raptor`) avec celles du rail.
//!
//! # Les sources
//!
//! Chaque source (cars TER lus dans le GTFS de la SNCF, GTFS d'Île-de-France Mobilités, GTFS des réseaux
//! interurbains régionaux) est lue en flux (`feed.rs`) puis réduite à un `RawFeed` : des arrêts, des lignes
//! et des circulations des seuls jours utiles (hier à dans trois jours). Les `RawFeed` sont gardés en mémoire
//! (quelques dizaines de Mo) ; chaque fois que les horaires du rail changent, l'index est reconstruit à partir
//! d'eux en une ou deux secondes (`Extras::build`), sans relire les zips.
//!
//! # Rattachement aux gares
//!
//! Un arrêt d'une source peut *être* une gare SNCF, et il faut alors qu'ils ne fassent qu'un, pour que les
//! correspondances (8 minutes) fonctionnent : Paris Gare de Lyon, Massy-Palaiseau, Versailles-Chantiers…
//! - par **code UIC** quand la source le donne (les cars TER du GTFS SNCF : `StopArea:OCE87471003`) ;
//! - sinon, pour les métros, RER et Transilien d'Île-de-France, par **proximité et nom** (`match_rail_station`) :
//!   moins de 300 m, et les mots du nom de l'un contenus dans ceux de l'autre (« Montparnasse - Bienvenüe » et
//!   « Paris Montparnasse »), ou moins de 100 m quel que soit le nom.
//!
//! Les arrêts de cars qui portent le même nom à moins de 200 m (les deux quais d'une même gare routière, une même
//! halte desservie par plusieurs réseaux) sont fusionnés : un car y descend, un autre y monte, sans marche.
//! Les autres arrêts proches sont reliés à pied (voir `raptor.rs`).
//!
//! # Ressource des arrêts, versionnée
//!
//! Les arrêts supplémentaires se comptent en dizaines de milliers : trop pour les mettre dans chaque réponse
//! d'isochrone. Ils sont servis à part, sous `GET /api/arrets/{version}` : la version est l'empreinte du contenu, la
//! ressource est donc immuable et le navigateur la garde en cache (comme `/api/reseau/{version}`). Les réponses
//! d'isochrone ne portent que les numéros d'arrêts et la version à charger.

pub mod feed;
mod idfm;
pub mod load;
mod regional;

use std::collections::HashMap;

use axum::body::Bytes;
use jiff::civil::Date;
use serde::Serialize;
use tracing::info;

use crate::raptor::{Call, InStop, InTrip, MODE_CAR, MODE_IDF, Raptor};
use crate::timetable::Timetable;

/// Genre d'un arrêt ou d'une ligne, pour l'affichage (le groupe de modes des requêtes en découle).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Kind {
    Coach,
    Metro,
    Rer,
    Transilien,
    Tram,
}

impl Kind {
    /// Dans l'ordre des numéros de la ressource des arrêts.
    pub const ALL: [Kind; 5] = [Kind::Coach, Kind::Metro, Kind::Rer, Kind::Transilien, Kind::Tram];

    pub fn name(self) -> &'static str {
        match self {
            Kind::Coach => "car",
            Kind::Metro => "metro",
            Kind::Rer => "rer",
            Kind::Transilien => "transilien",
            Kind::Tram => "tram",
        }
    }

    /// Groupe de modes (voir `raptor::MODE_*`).
    pub fn group(self) -> u8 {
        match self {
            Kind::Coach => MODE_CAR,
            _ => MODE_IDF,
        }
    }

    /// Un arrêt desservi par plusieurs genres de lignes garde le plus « lourd » : RER avant métro avant tramway.
    pub(crate) fn rank(self) -> u8 {
        match self {
            Kind::Rer => 0,
            Kind::Transilien => 1,
            Kind::Metro => 2,
            Kind::Tram => 3,
            Kind::Coach => 4,
        }
    }

    fn index(self) -> u8 {
        Self::ALL.iter().position(|k| *k == self).unwrap_or(0) as u8
    }
}

/// Une ligne telle qu'on l'affiche dans la fiche d'itinéraire.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub kind: Kind,
    /// « Car TER », « Car BreizhGo 7 », « RER B », « Métro 14 ».
    pub label: String,
    /// Nom complet de la ligne (« Caen - Granville - Rennes »), s'il y en a un.
    pub name: String,
    /// Couleurs officielles (hexadécimal sans dièse), si le GTFS les donne.
    pub color: Option<String>,
    pub text_color: Option<String>,
}

/// Un arrêt d'une source, avant rattachement aux gares.
#[derive(Clone, Debug)]
pub struct RawStop {
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub kind: Kind,
    /// Code UIC, quand la source dit que cet arrêt est une gare du rail.
    pub rail_code: Option<String>,
}

/// Une circulation d'une source. Les arrêts sont ceux du `RawFeed` (indices locaux).
#[derive(Clone, Debug)]
pub struct RawTrip {
    pub line: u32,
    /// Indice dans `RawFeed::services`.
    pub service: u32,
    /// Indice dans `RawFeed::headsigns`, ou `u32::MAX`.
    pub headsign: u32,
    pub calls: Box<[Call]>,
}

/// Tout ce qu'une source apporte.
#[derive(Clone, Debug)]
pub struct RawFeed {
    pub name: String,
    pub stops: Vec<RawStop>,
    pub lines: Vec<Line>,
    pub headsigns: Vec<Box<str>>,
    /// Jours de circulation de chaque calendrier, en jours depuis `base`, triés.
    pub services: Vec<Vec<u16>>,
    pub base: Date,
    pub trips: Vec<RawTrip>,
    /// Rattacher les arrêts aux gares par proximité et nom (Île-de-France) en plus du code UIC.
    pub match_by_name: bool,
}

impl RawFeed {
    pub fn new(name: &str, base: Date) -> Self {
        Self {
            name: name.to_string(),
            stops: Vec::new(),
            lines: Vec::new(),
            headsigns: Vec::new(),
            services: Vec::new(),
            base,
            trips: Vec::new(),
            match_by_name: false,
        }
    }

    /// Mémoire approximative (octets), pour le budget.
    pub fn bytes(&self) -> usize {
        use std::mem::size_of;
        self.stops.iter().map(|s| size_of::<RawStop>() + s.name.capacity()).sum::<usize>()
            + self.lines.iter().map(|l| size_of::<Line>() + l.label.capacity() + l.name.capacity() + 16).sum::<usize>()
            + self.headsigns.iter().map(|h| h.len() + 16).sum::<usize>()
            + self.services.iter().map(|s| s.capacity() * 2 + 24).sum::<usize>()
            + self.trips.iter().map(|t| size_of::<RawTrip>() + t.calls.len() * size_of::<Call>()).sum::<usize>()
    }
}

/// Un arrêt supplémentaire, tel qu'il est servi à l'API.
#[derive(Clone, Debug)]
pub struct ExtraStop {
    pub name: String,
    pub lon: f64,
    pub lat: f64,
    pub kind: Kind,
}

/// Une circulation supplémentaire : sa ligne et sa destination (le reste est dans l'index RAPTOR).
#[derive(Clone, Copy, Debug)]
pub struct ExtraTrip {
    pub line: u32,
    pub headsign: u32,
}

/// Chiffres du chargement, pour les journaux et `/api/health`.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// Sources : (nom, circulations).
    pub feeds: Vec<(String, usize)>,
    pub stops: usize,
    pub trips: usize,
    pub routes: usize,
    pub merged_into_stations: usize,
    pub memory_bytes: usize,
}

/// Le réseau supplémentaire et l'index RAPTOR qui réunit rail et extras.
pub struct Extras {
    /// Les horaires du rail pour lesquels l'index a été construit : les indices de gares n'ont de sens que pour eux.
    pub timetable_id: u64,
    /// Nombre de gares du rail : l'arrêt supplémentaire `i` est l'arrêt `rail_count + i` de l'index.
    pub rail_count: u32,
    /// Nombre de circulations du rail : la circulation supplémentaire `i` porte l'identifiant `rail_trips + i`.
    pub rail_trips: u32,
    pub stops: Vec<ExtraStop>,
    pub lines: Vec<Line>,
    pub headsigns: Vec<Box<str>>,
    pub trips: Vec<ExtraTrip>,
    pub raptor: Raptor,
    /// Empreinte de la ressource des arrêts, et son contenu prêt à servir.
    pub version: String,
    pub body: Bytes,
    pub stats: Stats,
}

impl Extras {
    /// Réunit les sources et les horaires du rail dans un même index RAPTOR.
    pub fn build(timetable: &Timetable, feeds: &[std::sync::Arc<RawFeed>]) -> Self {
        let rail_count = timetable.stations.len() as u32;
        let rail_by_code: HashMap<&str, u32> = timetable.stations.iter().enumerate().map(|(i, s)| (s.code.as_str(), i as u32)).collect();
        let rail_grid = RailGrid::new(timetable);

        let mut stops: Vec<ExtraStop> = Vec::new();
        // Fusion des arrêts de cars de même nom voisins : (nom normalisé, case de 200 m).
        let mut coach_cells: HashMap<(String, i32, i32), u32> = HashMap::new();
        let mut lines: Vec<Line> = Vec::new();
        let mut headsigns: Vec<Box<str>> = Vec::new();
        let mut trips: Vec<ExtraTrip> = Vec::new();
        let mut services: Vec<Vec<u16>> = Vec::new();
        let mut service_index: HashMap<Vec<u16>, u32> = HashMap::new();
        let mut calls_of_trips: Vec<(u32, u32, u8, Vec<Call>)> = Vec::new();
        let mut merged = 0usize;
        let mut idf_present = false;
        let rail_services = timetable.service_count() as u32;

        for feed in feeds {
            // Arrêts de la source → arrêts de l'index.
            let mut map: Vec<u32> = Vec::with_capacity(feed.stops.len());
            for stop in &feed.stops {
                let by_code = stop.rail_code.as_deref().and_then(|code| rail_by_code.get(code).copied());
                let matched = by_code.or_else(|| {
                    if feed.match_by_name && matches!(stop.kind, Kind::Rer | Kind::Transilien | Kind::Metro) {
                        match_rail_station(stop, timetable, &rail_grid)
                    } else {
                        None
                    }
                });
                if let Some(station) = matched {
                    merged += 1;
                    map.push(station);
                    continue;
                }
                let new_stop = |stops: &mut Vec<ExtraStop>| {
                    stops.push(ExtraStop { name: stop.name.clone(), lon: stop.lon, lat: stop.lat, kind: stop.kind });
                    rail_count + (stops.len() - 1) as u32
                };
                let index = if stop.kind == Kind::Coach {
                    let key = (normalize(&stop.name), (stop.lat / 0.0018).floor() as i32, (stop.lon / 0.0026).floor() as i32);
                    *coach_cells.entry(key).or_insert_with(|| new_stop(&mut stops))
                } else {
                    new_stop(&mut stops)
                };
                map.push(index);
            }
            idf_present |= feed.stops.iter().any(|s| s.kind.group() == MODE_IDF);

            // Lignes, destinations et calendriers de la source → ceux de l'index.
            let line_offset = lines.len() as u32;
            lines.extend(feed.lines.iter().cloned());
            let headsign_offset = headsigns.len() as u32;
            headsigns.extend(feed.headsigns.iter().cloned());
            let shift = timetable_base_shift(timetable, feed.base);
            let service_map: Vec<u32> = feed
                .services
                .iter()
                .map(|days| {
                    let shifted: Vec<u16> = days.iter().filter_map(|&d| u16::try_from(i32::from(d) + shift).ok()).collect();
                    *service_index.entry(shifted.clone()).or_insert_with(|| {
                        services.push(shifted);
                        rail_services + (services.len() - 1) as u32
                    })
                })
                .collect();

            for trip in &feed.trips {
                let mut calls: Vec<Call> = Vec::with_capacity(trip.calls.len());
                for call in trip.calls.iter() {
                    let stop = map[call.stop as usize];
                    // Deux arrêts voisins fusionnés en un seul : on ne descend pas pour remonter.
                    match calls.last_mut() {
                        Some(last) if last.stop == stop => last.departure = last.departure.max(call.departure),
                        _ => calls.push(Call { stop, arrival: call.arrival, departure: call.departure }),
                    }
                }
                if calls.len() < 2 {
                    continue;
                }
                let line = &feed.lines[trip.line as usize];
                trips.push(ExtraTrip {
                    line: line_offset + trip.line,
                    headsign: if trip.headsign == u32::MAX { u32::MAX } else { headsign_offset + trip.headsign },
                });
                calls_of_trips.push((service_map[trip.service as usize], timetable.trips.len() as u32 + trips.len() as u32 - 1, line.kind.group(), calls));
            }
        }

        let in_stops: Vec<InStop> = timetable
            .stations
            .iter()
            .map(|s| InStop { lon: s.lon, lat: s.lat, group: 0, code: &s.code })
            .chain(stops.iter().map(|s| InStop { lon: s.lon, lat: s.lat, group: s.kind.group(), code: "" }))
            .collect();
        let rail_calls: Vec<Vec<Call>> = timetable
            .trips
            .iter()
            .map(|t| t.stops.iter().map(|s| Call { stop: s.station, arrival: s.arrival, departure: s.departure }).collect())
            .collect();
        let in_trips: Vec<InTrip> = timetable
            .trips
            .iter()
            .zip(&rail_calls)
            .enumerate()
            .map(|(id, (t, calls))| InTrip { id: id as u32, service: t.service, mode: crate::raptor::MODE_TRAIN, calls })
            .chain(calls_of_trips.iter().map(|(service, id, mode, calls)| InTrip { id: *id, service: *service, mode: *mode, calls }))
            .collect();
        let raptor = Raptor::build_multi(&in_stops, &in_trips, rail_services, services, idf_present);

        let (version, body) = stops_resource(&stops);
        let mut extras = Self {
            timetable_id: timetable.id,
            rail_count,
            rail_trips: timetable.trips.len() as u32,
            stops,
            lines,
            headsigns,
            trips,
            raptor,
            version,
            body,
            stats: Stats::default(),
        };
        extras.stats = Stats {
            feeds: feeds.iter().map(|f| (f.name.clone(), f.trips.len())).collect(),
            stops: extras.stops.len(),
            trips: extras.trips.len(),
            routes: extras.raptor.route_count(),
            merged_into_stations: merged,
            memory_bytes: extras.bytes() + feeds.iter().map(|f| f.bytes()).sum::<usize>(),
        };
        info!(
            arrets = extras.stops.len(),
            circulations = extras.trips.len(),
            lignes = extras.raptor.route_count(),
            rattaches_aux_gares = merged,
            memoire_mo = extras.stats.memory_bytes >> 20,
            "isochrones multimodales : index prêt"
        );
        extras
    }

    /// Mémoire de l'index et des tables (octets), sans les sources.
    pub fn bytes(&self) -> usize {
        use std::mem::size_of;
        self.raptor.bytes()
            + self.stops.iter().map(|s| size_of::<ExtraStop>() + s.name.capacity()).sum::<usize>()
            + self.lines.iter().map(|l| size_of::<Line>() + l.label.capacity() + l.name.capacity() + 16).sum::<usize>()
            + self.headsigns.iter().map(|h| h.len() + 16).sum::<usize>()
            + self.trips.capacity() * size_of::<ExtraTrip>()
            + self.body.len()
    }

    /// La ligne et la destination d'une circulation d'identifiant `id` (en dehors du rail).
    pub fn trip(&self, id: u32) -> Option<(&Line, Option<&str>)> {
        let trip = self.trips.get(id.checked_sub(self.rail_trips)? as usize)?;
        let headsign = self.headsigns.get(trip.headsign as usize).map(|h| &**h).filter(|h| !h.is_empty());
        Some((&self.lines[trip.line as usize], headsign))
    }

    /// Le genre d'un arrêt de l'index : `None` pour une gare du rail.
    pub fn stop(&self, index: u32) -> Option<&ExtraStop> {
        self.stops.get(index.checked_sub(self.rail_count)? as usize)
    }
}

/// Décalage, en jours, entre le début des horaires du rail et celui d'une source.
fn timetable_base_shift(timetable: &Timetable, base: Date) -> i32 {
    timetable.base_date().until(base).map_or(0, |span| span.get_days())
}

/// Ressource des arrêts supplémentaires : colonnes plutôt que lignes, pour peser peu.
#[derive(Serialize)]
struct StopsOut<'a> {
    /// Noms des genres : le numéro d'un arrêt est son rang ici.
    kinds: Vec<&'static str>,
    names: Vec<&'a str>,
    lon: Vec<f64>,
    lat: Vec<f64>,
    kind: Vec<u8>,
}

fn stops_resource(stops: &[ExtraStop]) -> (String, Bytes) {
    // Cinq décimales : un mètre.
    let round5 = |x: f64| (x * 1e5).round() / 1e5;
    let out = StopsOut {
        kinds: Kind::ALL.iter().map(|k| k.name()).collect(),
        names: stops.iter().map(|s| s.name.as_str()).collect(),
        lon: stops.iter().map(|s| round5(s.lon)).collect(),
        lat: stops.iter().map(|s| round5(s.lat)).collect(),
        kind: stops.iter().map(|s| s.kind.index()).collect(),
    };
    let body = serde_json::to_vec(&out).expect("les arrêts se sérialisent toujours");
    let version = format!("{:016x}", crate::network::fnv1a(&body));
    (version, Bytes::from(body))
}

// ---------------------------------------------------------------------------------------------
// Rattachement des arrêts aux gares
// ---------------------------------------------------------------------------------------------

/// Un nom comparable : minuscules sans accents, sans les mots creux (« gare », « de », « paris »…), « st » développé.
pub fn name_words(name: &str) -> Vec<String> {
    let folded: String = name
        .chars()
        .flat_map(char::to_lowercase)
        .map(|c| match c {
            'à' | 'â' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'î' | 'ï' => 'i',
            'ô' | 'ö' => 'o',
            'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'œ' => 'o',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect();
    const SKIP: [&str; 14] = ["gare", "de", "du", "des", "la", "le", "les", "l", "d", "paris", "sncf", "rer", "et", "en"];
    folded
        .split_whitespace()
        .filter(|w| !SKIP.contains(w))
        .map(|w| match w {
            "st" => "saint".to_string(),
            "ste" => "sainte".to_string(),
            other => other.to_string(),
        })
        .collect()
}

fn normalize(name: &str) -> String {
    name_words(name).join(" ")
}

/// Les gares du rail rangées par cases d'environ 400 m, pour chercher les voisines d'un arrêt.
struct RailGrid {
    cells: HashMap<(i32, i32), Vec<u32>>,
}

const GRID_LAT: f64 = 0.004;
const GRID_LON: f64 = 0.006;

impl RailGrid {
    fn new(timetable: &Timetable) -> Self {
        let mut cells: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
        for (i, s) in timetable.stations.iter().enumerate() {
            cells.entry(((s.lat / GRID_LAT).floor() as i32, (s.lon / GRID_LON).floor() as i32)).or_default().push(i as u32);
        }
        Self { cells }
    }

    fn near(&self, lon: f64, lat: f64) -> impl Iterator<Item = u32> + '_ {
        let (cy, cx) = ((lat / GRID_LAT).floor() as i32, (lon / GRID_LON).floor() as i32);
        (cy - 1..=cy + 1).flat_map(move |y| (cx - 1..=cx + 1).map(move |x| (y, x))).flat_map(|key| self.cells.get(&key).into_iter().flatten().copied())
    }
}

/// Distance à vol d'oiseau (m).
fn meters(a: (f64, f64), b: (f64, f64)) -> f64 {
    let dx = (a.0 - b.0) * ((a.1 + b.1) / 2.0).to_radians().cos() * 111_320.0;
    let dy = (a.1 - b.1) * 110_540.0;
    dx.hypot(dy)
}

/// Distance sous laquelle un arrêt peut être une gare, avec un nom compatible ; et sous laquelle il l'est quel que soit son nom.
const MATCH_RADIUS_M: f64 = 300.0;
const MATCH_SAME_PLACE_M: f64 = 100.0;

/// La gare du rail que désigne cet arrêt, s'il y en a une (voir l'en-tête du module).
fn match_rail_station(stop: &RawStop, timetable: &Timetable, grid: &RailGrid) -> Option<u32> {
    let words = name_words(&stop.name);
    let mut best: Option<(f64, u32)> = None;
    for candidate in grid.near(stop.lon, stop.lat) {
        let station = &timetable.stations[candidate as usize];
        let distance = meters((stop.lon, stop.lat), (station.lon, station.lat));
        if distance > MATCH_RADIUS_M || best.is_some_and(|(d, _)| d <= distance) {
            continue;
        }
        let other = name_words(&station.name);
        let (small, large) = if words.len() <= other.len() { (&words, &other) } else { (&other, &words) };
        let compatible = !small.is_empty() && small.iter().all(|w| large.contains(w));
        if compatible || distance <= MATCH_SAME_PLACE_M {
            best = Some((distance, candidate));
        }
    }
    best.map(|(_, station)| station)
}

#[cfg(test)]
mod tests;
