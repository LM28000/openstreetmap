//! Retards en temps réel (GTFS-RT « TripUpdates ») : interrogation régulière,
//! décodage, application aux horaires, et archivage facultatif des flux bruts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result};
use jiff::Timestamp;
use jiff::civil::Date;
use prost::Message;
use tracing::{info, warn};

use crate::gtfs_rt::{self, FeedMessage};
use crate::state::AppState;
use crate::timetable::Run;

/// Flux temps réel SNCF, relayé par transport.data.gouv.fr.
pub const TRIP_UPDATES_URL: &str = "https://proxy.transport.data.gouv.fr/resource/sncf-gtfs-rt-trip-updates";
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Le dernier état connu du temps réel.
pub struct Realtime {
    /// Heure de production du flux par la SNCF (secondes UTC).
    pub feed_timestamp: i64,
    /// Heure à laquelle on l'a récupéré.
    pub fetched_at: i64,
    /// Par identifiant de trajet (un même trajet peut être annoncé pour plusieurs jours).
    trips: HashMap<String, Vec<TripUpdate>>,
}

struct TripUpdate {
    start_date: Option<Date>,
    canceled: bool,
    stops: Vec<StopUpdate>,
}

struct StopUpdate {
    stop_sequence: Option<u32>,
    stop_id: Option<String>,
    arrival: Option<Event>,
    departure: Option<Event>,
    skipped: bool,
}

#[derive(Clone, Copy)]
struct Event {
    delay: Option<i32>,
    time: Option<i64>,
}

impl Event {
    /// Retard en secondes, que le flux donne une heure prévue ou directement un retard.
    fn delay_from(self, scheduled: i64) -> Option<i64> {
        self.time.map(|time| time - scheduled).or(self.delay.map(i64::from))
    }
}

impl From<gtfs_rt::StopTimeEvent> for Event {
    fn from(event: gtfs_rt::StopTimeEvent) -> Self {
        Self { delay: event.delay, time: event.time }
    }
}

/// Horaires d'une circulation avec le temps réel appliqué (secondes UTC).
pub struct LiveTimes {
    pub arrival: Vec<i64>,
    pub departure: Vec<i64>,
    /// Indices des arrêts non desservis.
    pub skipped: Vec<u32>,
    pub canceled: bool,
}

impl Realtime {
    pub fn trip_count(&self) -> usize {
        self.trips.values().map(Vec::len).sum()
    }

    /// Applique le temps réel à une circulation. `None` si le flux n'en dit rien.
    /// `stop_points` sert à relier les arrêts par identifiant quand le flux ne donne pas leur rang.
    pub fn apply(&self, run: &Run<'_>, stop_points: &[String]) -> Option<LiveTimes> {
        let update = self
            .trips
            .get(&run.trip.id)?
            .iter()
            .find(|u| u.start_date.is_none_or(|date| date == run.date))?;

        let stops = &run.trip.stops;
        let mut arrival: Vec<i64> = Vec::with_capacity(stops.len());
        let mut departure: Vec<i64> = Vec::with_capacity(stops.len());
        let mut skipped = Vec::new();
        // Norme GTFS-RT : un retard annoncé à un arrêt vaut pour les suivants,
        // jusqu'à la prochaine annonce. Avant la première annonce : horaire prévu.
        let mut carried = 0;

        for (i, stop) in stops.iter().enumerate() {
            let scheduled_arrival = run.day_start + i64::from(stop.arrival);
            let scheduled_departure = run.day_start + i64::from(stop.departure);
            let stop_id = stop_points.get(stop.stop_point as usize).map(String::as_str);
            let announced = update.stops.iter().find(|u| match u.stop_sequence {
                Some(sequence) => sequence == stop.stop_sequence,
                None => u.stop_id.is_some() && u.stop_id.as_deref() == stop_id,
            });

            let (arrival_delay, departure_delay) = match announced {
                Some(u) => {
                    if u.skipped {
                        skipped.push(i as u32);
                    }
                    let arrival_delay = u.arrival.and_then(|e| e.delay_from(scheduled_arrival));
                    let departure_delay = u.departure.and_then(|e| e.delay_from(scheduled_departure));
                    let arrival_delay = arrival_delay.or(departure_delay).unwrap_or(carried);
                    let departure_delay = departure_delay.unwrap_or(arrival_delay);
                    carried = departure_delay;
                    (arrival_delay, departure_delay)
                }
                None => (carried, carried),
            };

            // Garde-fous contre les incohérences du flux : un train n'arrive pas avant
            // d'être parti de l'arrêt précédent, et ne repart pas avant d'être arrivé.
            let mut live_arrival = scheduled_arrival + arrival_delay;
            if let Some(&previous_departure) = departure.last() {
                live_arrival = live_arrival.max(previous_departure);
            }
            let live_departure = (scheduled_departure + departure_delay).max(live_arrival);
            arrival.push(live_arrival);
            departure.push(live_departure);
        }

        Some(LiveTimes { arrival, departure, skipped, canceled: update.canceled })
    }
}

/// Interroge le flux toutes les 30 secondes. Si `archive_dir` est donné, chaque
/// nouvelle version du flux y est gardée, compressée, pour pouvoir rejouer le passé.
pub async fn poll_forever(http: reqwest::Client, state: AppState, archive_dir: Option<PathBuf>) {
    let mut last_feed_timestamp = None;
    loop {
        match fetch(&http).await {
            Ok((bytes, feed)) => {
                let realtime = from_feed(feed, Timestamp::now().as_second());
                if last_feed_timestamp != Some(realtime.feed_timestamp) {
                    last_feed_timestamp = Some(realtime.feed_timestamp);
                    info!(trains = realtime.trip_count(), "temps réel mis à jour");
                    if let Some(dir) = &archive_dir
                        && let Err(error) = archive(dir, realtime.feed_timestamp, bytes).await
                    {
                        warn!("archivage du temps réel impossible : {error:#}");
                    }
                }
                state.set_realtime(realtime);
            }
            Err(error) => warn!("temps réel indisponible : {error:#}"),
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

async fn fetch(http: &reqwest::Client) -> Result<(Vec<u8>, FeedMessage)> {
    let bytes = http.get(TRIP_UPDATES_URL).send().await?.error_for_status()?.bytes().await?;
    let feed = FeedMessage::decode(bytes.as_ref()).context("flux GTFS-RT illisible")?;
    Ok((bytes.to_vec(), feed))
}

pub(crate) fn from_feed(feed: FeedMessage, fetched_at: i64) -> Realtime {
    let mut trips: HashMap<String, Vec<TripUpdate>> = HashMap::new();
    for entity in feed.entity {
        if entity.is_deleted == Some(true) {
            continue;
        }
        let Some(update) = entity.trip_update else { continue };
        let Some(trip_id) = update.trip.trip_id else { continue };
        let relationship = update.trip.schedule_relationship.unwrap_or_default();
        let stops = update
            .stop_time_update
            .into_iter()
            .map(|u| StopUpdate {
                stop_sequence: u.stop_sequence,
                stop_id: u.stop_id,
                arrival: u.arrival.map(Event::from),
                departure: u.departure.map(Event::from),
                skipped: u.schedule_relationship == Some(gtfs_rt::STOP_SKIPPED),
            })
            .collect();
        trips.entry(trip_id).or_default().push(TripUpdate {
            start_date: update.trip.start_date.as_deref().and_then(|d| Date::strptime("%Y%m%d", d).ok()),
            canceled: matches!(relationship, gtfs_rt::TRIP_CANCELED | gtfs_rt::TRIP_DELETED),
            stops,
        });
    }
    let feed_timestamp = feed.header.timestamp.and_then(|t| i64::try_from(t).ok()).unwrap_or(fetched_at);
    Realtime { feed_timestamp, fetched_at, trips }
}

/// Range le flux brut dans `dossier/sncf-trip-updates/AAAA-MM-JJ/HHMMSS.pb.gz` (heure UTC).
async fn archive(dir: &Path, feed_timestamp: i64, bytes: Vec<u8>) -> Result<()> {
    let timestamp = Timestamp::from_second(feed_timestamp)?;
    let folder = dir.join("sncf-trip-updates").join(timestamp.strftime("%Y-%m-%d").to_string());
    let path = folder.join(format!("{}.pb.gz", timestamp.strftime("%H%M%S")));
    tokio::task::spawn_blocking(move || -> Result<()> {
        std::fs::create_dir_all(&folder)?;
        let mut gzip = flate2::write::GzEncoder::new(std::fs::File::create(&path)?, flate2::Compression::default());
        std::io::Write::write_all(&mut gzip, &bytes)?;
        gzip.finish()?;
        Ok(())
    })
    .await??;
    Ok(())
}
