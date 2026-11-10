//! Horaires théoriques SNCF (GTFS) : téléchargement, modèle compact en mémoire,
//! et recherche des trains en circulation sur une plage horaire.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

use anyhow::{Context, Result, bail};
use gtfs_structures::{Gtfs, RouteType};
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use tracing::{info, warn};

use crate::state::AppState;

/// Horaires des TGV, Intercités et TER (jeu « Réseau SNCF TGV, Intercités et TER », licence ODbL).
pub const GTFS_URL: &str = "https://eu.ftp.opendatasoft.com/sncf/plandata/Export_OpenData_SNCF_GTFS_NewTripId.zip";
/// La SNCF republie ses horaires chaque soir : on retélécharge au-delà de cet âge.
const MAX_AGE: Duration = Duration::from_secs(12 * 3600);

pub struct Station {
    pub name: String,
    pub lon: f64,
    pub lat: f64,
}

pub struct StopTime {
    /// Indice dans `Timetable::stations`.
    pub station: u32,
    /// Indice dans `Timetable::stop_points` (pour relier le temps réel).
    pub stop_point: u32,
    pub stop_sequence: u32,
    /// Secondes depuis le début du jour de service (peut dépasser 24 h).
    pub arrival: i32,
    pub departure: i32,
}

pub struct Trip {
    pub id: String,
    /// Numéro du train, par exemple « 6123 ».
    pub number: String,
    /// « TGV INOUI », « Train TER », « OUIGO »…
    pub category: String,
    /// Nom de la ligne, par exemple « Paris - Lyon ».
    pub line: String,
    service: u32,
    pub stops: Vec<StopTime>,
}

pub struct Timetable {
    /// Numéro unique de ce chargement : les tracés calculés pour lui ne valent que pour lui
    /// (les indices de gares changent d'un chargement à l'autre).
    pub id: u64,
    pub stations: Vec<Station>,
    pub stop_points: Vec<String>,
    pub trips: Vec<Trip>,
    pub feed_version: String,
    /// Jours de circulation de chaque service, en jours depuis `base_date`, triés.
    services: Vec<Vec<u16>>,
    base_date: Date,
    tz: TimeZone,
}

/// Une circulation : un trajet, un jour donné.
pub struct Run<'a> {
    pub trip: &'a Trip,
    pub date: Date,
    /// Début du jour de service, en secondes depuis 1970.
    pub day_start: i64,
}

impl Timetable {
    /// Toutes les circulations qui roulent au moins un instant entre `from` et `to` (secondes UTC),
    /// selon les horaires théoriques.
    pub fn runs_between(&self, from: i64, to: i64) -> Vec<Run<'_>> {
        let mut runs = Vec::new();
        // Les horaires dépassent 24 h (« 34:10 ») : un train parti l'avant-veille peut encore rouler.
        let Ok(first_day) = self.local_date(from).checked_sub(jiff::Span::new().days(2)) else {
            return runs;
        };
        let last_day = self.local_date(to);
        for date in first_day.series(jiff::Span::new().days(1)).take_while(|d| *d <= last_day) {
            let Some(offset) = self.day_offset(date) else { continue };
            let Ok(day_start) = self.service_day_start(date) else { continue };
            for trip in &self.trips {
                if self.services[trip.service as usize].binary_search(&offset).is_err() {
                    continue;
                }
                let (Some(first), Some(last)) = (trip.stops.first(), trip.stops.last()) else { continue };
                if day_start + i64::from(last.arrival) >= from && day_start + i64::from(first.departure) <= to {
                    runs.push(Run { trip, date, day_start });
                }
            }
        }
        runs
    }

    pub fn trip_count(&self) -> usize {
        self.trips.len()
    }

    /// Toutes les paires de gares consécutives des horaires, rangées (petit indice, grand indice).
    pub fn station_pairs(&self) -> HashSet<(u32, u32)> {
        let mut pairs = HashSet::new();
        for trip in &self.trips {
            for pair in trip.stops.windows(2) {
                let (a, b) = (pair[0].station, pair[1].station);
                if a != b {
                    pairs.insert((a.min(b), a.max(b)));
                }
            }
        }
        pairs
    }

    fn local_date(&self, seconds: i64) -> Date {
        Timestamp::from_second(seconds).unwrap_or(Timestamp::UNIX_EPOCH).to_zoned(self.tz.clone()).date()
    }

    fn day_offset(&self, date: Date) -> Option<u16> {
        let days = self.base_date.until(date).ok()?.get_days();
        u16::try_from(days).ok()
    }

    /// Norme GTFS : les heures comptent depuis « midi moins 12 h », heure locale.
    /// (Ça ne fait pas toujours minuit : les jours de changement d'heure, c'est 23 h ou 1 h.)
    fn service_day_start(&self, date: Date) -> Result<i64> {
        let noon = date.at(12, 0, 0, 0).to_zoned(self.tz.clone())?;
        Ok(noon.timestamp().as_second() - 12 * 3600)
    }
}

/// Charge les horaires depuis `data_dir`, en les téléchargeant s'ils manquent ou sont trop vieux.
pub async fn load_or_download(http: &reqwest::Client, data_dir: &Path) -> Result<Timetable> {
    let path = gtfs_path(data_dir);
    if needs_download(&path) {
        download(http, &path).await?;
    }
    let path_for_parse = path.clone();
    tokio::task::spawn_blocking(move || build(&path_for_parse))
        .await
        .context("le chargement des horaires a planté")?
        .with_context(|| format!("lecture de {}", path.display()))
}

/// Vérifie toutes les heures si de nouveaux horaires sont disponibles, et les recharge.
pub async fn refresh_forever(http: reqwest::Client, data_dir: PathBuf, state: AppState) {
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
        if !needs_download(&gtfs_path(&data_dir)) {
            continue;
        }
        match load_or_download(&http, &data_dir).await {
            Ok(timetable) => {
                info!(trajets = timetable.trip_count(), version = %timetable.feed_version, "nouveaux horaires chargés");
                state.set_timetable(timetable);
            }
            Err(error) => warn!("mise à jour des horaires impossible : {error:#}"),
        }
    }
}

fn gtfs_path(data_dir: &Path) -> PathBuf {
    data_dir.join("raw/sncf-gtfs/gtfs.zip")
}

fn needs_download(path: &Path) -> bool {
    let age = std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok());
    age.is_none_or(|age| age > MAX_AGE)
}

async fn download(http: &reqwest::Client, path: &Path) -> Result<()> {
    info!("téléchargement des horaires SNCF…");
    let response = http.get(GTFS_URL).send().await?.error_for_status()?;
    let bytes = response.bytes().await?;
    if bytes.len() < 1_000_000 {
        bail!("fichier d'horaires anormalement petit ({} octets)", bytes.len());
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // Écriture dans un fichier temporaire puis renommage : jamais de fichier à moitié écrit.
    let tmp = path.with_extension("zip.part");
    tokio::fs::write(&tmp, &bytes).await?;
    tokio::fs::rename(&tmp, path).await?;
    info!(taille_mo = bytes.len() / 1_000_000, "horaires téléchargés");
    Ok(())
}

/// Lit le GTFS et construit le modèle compact. Les cars (TER ou à réservation) sont
/// écartés : ils ne roulent pas sur des rails.
fn build(path: &Path) -> Result<Timetable> {
    let gtfs = Gtfs::from_path(path)?;
    let tz = TimeZone::get("Europe/Paris")?;
    let base_date = Timestamp::now().to_zoned(tz.clone()).date().checked_sub(jiff::Span::new().days(3))?;

    let mut stations: Vec<Station> = Vec::new();
    let mut station_index = std::collections::HashMap::<String, u32>::new();
    let mut stop_points: Vec<String> = Vec::new();
    let mut stop_point_index = std::collections::HashMap::<String, u32>::new();
    let mut services: Vec<Vec<u16>> = Vec::new();
    let mut service_index = std::collections::HashMap::<String, u32>::new();
    let mut trips = Vec::new();

    // Ordre fixe (celui des identifiants) : à horaires identiques, indices identiques, et
    // donc même réseau, d'un démarrage à l'autre (voir `network.rs`).
    let mut gtfs_trips: Vec<_> = gtfs.trips.values().collect();
    gtfs_trips.sort_unstable_by(|a, b| a.id.cmp(&b.id));
    for trip in gtfs_trips {
        let Ok(route) = gtfs.get_route(&trip.route_id) else { continue };
        if !matches!(route.route_type, RouteType::Rail | RouteType::Tramway) {
            continue;
        }
        let Some(category) = trip.stop_times.first().and_then(|st| category_of(&st.stop.id)) else { continue };
        if category.starts_with("Car") {
            continue;
        }

        let mut stops = Vec::with_capacity(trip.stop_times.len());
        for st in &trip.stop_times {
            let (Some(arrival), Some(departure)) = (
                st.arrival_time.or(st.departure_time),
                st.departure_time.or(st.arrival_time),
            ) else {
                continue;
            };
            // La gare (zone d'arrêt parente) plutôt que le quai : même position, un nom propre.
            let station_stop = st
                .stop
                .parent_station
                .as_deref()
                .and_then(|id| gtfs.stops.get(id))
                .unwrap_or(&st.stop);
            let (Some(lon), Some(lat)) = (station_stop.longitude, station_stop.latitude) else { continue };
            let station = *station_index.entry(station_stop.id.clone()).or_insert_with(|| {
                stations.push(Station { name: station_stop.name.clone().unwrap_or_default(), lon, lat });
                (stations.len() - 1) as u32
            });
            let stop_point = *stop_point_index.entry(st.stop.id.clone()).or_insert_with(|| {
                stop_points.push(st.stop.id.clone());
                (stop_points.len() - 1) as u32
            });
            stops.push(StopTime {
                station,
                stop_point,
                stop_sequence: st.stop_sequence,
                arrival: arrival as i32,
                departure: departure as i32,
            });
        }
        if stops.len() < 2 {
            continue;
        }
        stops.sort_by_key(|s| s.stop_sequence);

        let service = *service_index.entry(trip.service_id.clone()).or_insert_with(|| {
            let mut days = gtfs.trip_days(&trip.service_id, base_date);
            days.sort_unstable();
            days.dedup();
            services.push(days);
            (services.len() - 1) as u32
        });

        trips.push(Trip {
            id: trip.id.clone(),
            number: trip.trip_headsign.clone().or_else(|| trip.trip_short_name.clone()).unwrap_or_default(),
            category: category.to_string(),
            line: route.long_name.clone().or_else(|| route.short_name.clone()).unwrap_or_default(),
            service,
            stops,
        });
    }

    let feed_version = gtfs.feed_info.first().and_then(|f| f.version.clone()).unwrap_or_default();
    info!(trajets = trips.len(), gares = stations.len(), version = %feed_version, "horaires prêts");
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    Ok(Timetable { id, stations, stop_points, trips, feed_version, services, base_date, tz })
}

/// La catégorie est dans l'identifiant du quai : « StopPoint:OCETGV INOUI-87686006 » → « TGV INOUI ».
fn category_of(stop_point_id: &str) -> Option<&str> {
    let rest = stop_point_id.strip_prefix("StopPoint:OCE")?;
    rest.rsplit_once('-').map(|(category, _)| category)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categorie_depuis_identifiant_de_quai() {
        assert_eq!(category_of("StopPoint:OCETGV INOUI-87686006"), Some("TGV INOUI"));
        assert_eq!(category_of("StopPoint:OCETrain TER-87581009"), Some("Train TER"));
        assert_eq!(category_of("StopArea:OCE87686006"), None);
    }
}
