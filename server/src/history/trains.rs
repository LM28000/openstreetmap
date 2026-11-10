//! Relecture de l'archive brute du temps réel SNCF (voir `realtime::archive`) : le flux GTFS-RT de chaque instant.
//!
//! L'archive est rangée par jour UTC : `sncf-trip-updates/AAAA-MM-JJ/HHMMSS.pb.gz`, l'heure du nom étant celle de
//! production du flux (UTC, comme `feed.header.timestamp`). Pour rejouer un instant `t`, on prend la dernière version
//! du flux **qui ne dépasse pas `t`** : ce sont les retards que la SNCF annonçait à ce moment-là, ni plus ni moins.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use prost::Message;

use crate::gtfs_rt::FeedMessage;
use crate::realtime::Realtime;

/// Sous-dossier de l'archive du flux des trains (celui d'`ARCHIVE_DIR`).
pub const ARCHIVE_FOLDER: &str = "sncf-trip-updates";
/// Au-delà de cet écart (s) entre l'instant demandé et la version la plus proche qui le précède, on ne dit rien :
/// ce serait présenter comme connus des retards périmés.
pub const MAX_STALENESS_S: i64 = 20 * 60;
const LISTING_TTL: Duration = Duration::from_secs(60);

pub struct FeedArchive {
    dir: PathBuf,
    listing: Mutex<Option<(Instant, Vec<(i64, PathBuf)>)>>,
}

impl FeedArchive {
    pub fn new(dir: &Path) -> Self {
        Self { dir: dir.join(ARCHIVE_FOLDER), listing: Mutex::new(None) }
    }

    /// Toutes les versions archivées (instant, fichier), de la plus ancienne à la plus récente. Relu au plus une fois par minute.
    pub fn versions(&self) -> Vec<(i64, PathBuf)> {
        let mut cache = self.listing.lock().expect("verrou de l'archive");
        if let Some((at, list)) = cache.as_ref()
            && at.elapsed() < LISTING_TTL
        {
            return list.clone();
        }
        let list = list_versions(&self.dir);
        *cache = Some((Instant::now(), list.clone()));
        list
    }

    /// La dernière version qui ne dépasse pas `at`, si elle est assez récente.
    pub fn latest_before(&self, at: i64) -> Option<(i64, PathBuf)> {
        let versions = self.versions();
        let end = versions.partition_point(|(t, _)| *t <= at);
        let (t, path) = versions.get(end.checked_sub(1)?)?;
        (at - t <= MAX_STALENESS_S).then(|| (*t, path.clone()))
    }

    /// Les plages couvertes : deux versions voisines se rejoignent si elles sont séparées de moins de 5 minutes.
    pub fn coverage(&self) -> Vec<(i64, i64)> {
        super::recorder::merge_spans(self.versions().into_iter().map(|(t, _)| (t, t)).collect(), 300)
    }

    /// Le temps réel tel qu'il était connu à l'instant `at`, avec l'instant de production du flux utilisé.
    pub fn realtime_at(&self, at: i64) -> Result<Option<(i64, Realtime)>> {
        let Some((feed_at, path)) = self.latest_before(at) else { return Ok(None) };
        let bytes = std::fs::read(&path).with_context(|| format!("lecture de {}", path.display()))?;
        let raw = super::codec::gunzip(&bytes)?;
        let feed = FeedMessage::decode(raw.as_slice()).context("flux archivé illisible")?;
        Ok(Some((feed_at, crate::realtime::from_feed(feed, feed_at))))
    }
}

fn list_versions(dir: &Path) -> Vec<(i64, PathBuf)> {
    let mut list = Vec::new();
    let Ok(days) = std::fs::read_dir(dir) else { return list };
    for day in days.flatten() {
        let Some(date) = day.file_name().to_str().and_then(|n| jiff::civil::Date::strptime("%Y-%m-%d", n).ok()) else { continue };
        let Ok(midnight) = date.to_zoned(jiff::tz::TimeZone::UTC) else { continue };
        let Ok(files) = std::fs::read_dir(day.path()) else { continue };
        for file in files.flatten() {
            let name = file.file_name();
            let Some(clock) = name.to_str().and_then(|n| n.strip_suffix(".pb.gz")) else { continue };
            if clock.len() != 6 || !clock.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let number = |range: std::ops::Range<usize>| clock[range].parse::<i64>().unwrap_or(0);
            list.push((midnight.timestamp().as_second() + number(0..2) * 3600 + number(2..4) * 60 + number(4..6), file.path()));
        }
    }
    list.sort_unstable_by_key(|(t, _)| *t);
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dernier_flux_ne_depassant_pas_l_instant() {
        let dir = std::env::temp_dir().join(format!("archive-essai-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let day = dir.join(ARCHIVE_FOLDER).join("2026-11-10");
        std::fs::create_dir_all(&day).unwrap();
        for name in ["070005", "070139", "070312"] {
            std::fs::write(day.join(format!("{name}.pb.gz")), b"").unwrap();
        }
        let archive = FeedArchive::new(&dir);
        let midnight = 1_794_268_800; // 2026-11-10 00:00 UTC
        let at = |h: i64, m: i64, s: i64| midnight + h * 3600 + m * 60 + s;
        assert_eq!(archive.latest_before(at(7, 1, 0)).map(|(t, _)| t), Some(at(7, 0, 5)));
        assert_eq!(archive.latest_before(at(7, 1, 39)).map(|(t, _)| t), Some(at(7, 1, 39)), "l'instant exact compte");
        assert_eq!(archive.latest_before(at(7, 0, 4)), None, "rien avant le premier flux");
        assert_eq!(archive.latest_before(at(7, 40, 0)), None, "trop ancien : on ne dit rien");
        assert_eq!(archive.coverage(), vec![(at(7, 0, 5), at(7, 3, 12))]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
