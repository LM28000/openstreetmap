//! Mesures sur le vrai GTFS d'Île-de-France (ignorées par défaut : elles demandent le zip de 114 Mo et du temps).
//!
//! ```text
//! IDFM_ZIP=/chemin/IDFM-gtfs.zip IDFM_MODES=metro,tram,train,cable,bus \
//!   cargo test --release --no-run   # puis lancer le binaire de test avec : mesure_gtfs_idfm --ignored --nocapture
//! ```
//!
//! Chaque lancement est un processus à part, pour que `ps` et `/usr/bin/time -l` donnent la mémoire de ce mode seul.
//! La mesure de rapprochement n'a pas besoin de la clé PRIM : elle fabrique, d'après le GTFS lui-même, ce que le SIRI annoncerait
//! (les prochains arrêts de chaque course en cours, avec des retards pseudo-aléatoires), en cachant l'identifiant de la course, puis
//! vérifie que `match_journeys` la retrouve. La vérité est connue : on mesure donc le taux de bonnes attributions et de mauvaises.

use std::time::Instant;

use super::*;
use crate::gtfs_compact;

/// Mémoire résidente de ce processus, en Mo (`ps`, macOS et Linux).
fn rss_mb() -> f64 {
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().unwrap_or(0.0) / 1024.0
}

/// Pseudo-hasard déterministe (xorshift) : les mesures se rejouent à l'identique.
fn next(state: &mut u64) -> u64 {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state
}

#[test]
#[ignore = "mesure sur le vrai GTFS d'IDFM (IDFM_ZIP) : voir l'en-tête du fichier"]
fn mesure_gtfs_idfm() {
    let zip = std::path::PathBuf::from(std::env::var("IDFM_ZIP").expect("IDFM_ZIP : chemin du zip d'IDFM"));
    let modes: Vec<String> = std::env::var("IDFM_MODES").unwrap_or_else(|_| "metro,tram,train,cable".into()).split(',').map(|m| m.trim().to_string()).collect();
    let now = Timestamp::now().as_second();
    let config = Config { key: "mesure".into(), modes: modes.clone(), every: Duration::from_secs(180), memory_limit: 100 << 20, gtfs_url: DEFAULT_GTFS_URL.into() };

    let before = rss_mb();
    let started = Instant::now();
    let mut schedule = gtfs_compact::build_days(&zip, now, &|info| config.keeps(info), &|info| if std::env::var_os("IDFM_TOUS_LES_JOURS").is_some() { gtfs_compact::ALL_DAYS } else { config.service_days(info) }, None).expect("GTFS illisible");
    decorate(&mut schedule);
    let build_s = started.elapsed().as_secs_f32();
    let after = rss_mb();
    println!("MODES {modes:?}");
    println!(
        "HORAIRES courses={} motifs={} arrêts={} points_de_tracé={} lignes={} estimé_Mo={:.1} construction_s={build_s:.1}",
        schedule.trip_count(),
        schedule.patterns.len(),
        schedule.stops.len(),
        schedule.shape_points(),
        schedule.routes.len(),
        schedule.approx_bytes() as f64 / 1_048_576.0
    );
    println!("MEMOIRE avant={before:.0} Mo, après construction={after:.0} Mo (rss de ce processus, y compris ce que l'allocateur n'a pas rendu)");

    let per_day: Vec<usize> = (0..3).map(|d| schedule.trips.iter().filter(|t| t.days & (1 << d) != 0).count()).collect();
    println!("COURSES_PAR_JOUR hier={} aujourd'hui={} demain={}", per_day[0], per_day[1], per_day[2]);
    if std::env::var_os("IDFM_SANS_RAPPROCHEMENT").is_some() {
        return;
    }

    // ── Rapprochement : toutes les courses en cours à 8 h 30 (heure locale d'aujourd'hui).
    let at = schedule.day_starts[1] + 8 * 3600 + 1800;
    let index = Index::new(&schedule);
    let mut state = 0x9E37_79B9_7F4A_7C15u64;
    for (label, with_aimed) in [("avec heure théorique", true), ("sans heure théorique", false)] {
        let mut journeys: Vec<Journey> = Vec::new();
        let mut truth: Vec<String> = Vec::new();
        for (t, trip) in schedule.trips.iter().enumerate() {
            let day = 1;
            if trip.days & (1 << day) == 0 {
                continue;
            }
            let pattern = &schedule.patterns[trip.pattern as usize];
            let times: Vec<i64> = (0..pattern.stop.len()).map(|i| schedule.day_starts[day] + i64::from(schedule.times_of(trip, i).0)).collect();
            let Some(first) = times.iter().position(|&x| x >= at) else { continue };
            if first > 0 && times[0] > at || times[times.len() - 1] < at {
                continue;
            }
            // Le retard du véhicule : de -1 à +5 minutes, le même à tous ses arrêts.
            let delay = (next(&mut state) % 360) as i64 - 60;
            let calls: Vec<Call> = (first..pattern.stop.len().min(first + 6))
                .filter_map(|i| {
                    let code = index.code_of_stop[pattern.stop[i] as usize]?;
                    let aimed = times[i];
                    Some(Call { stop: code, quay: None, aimed_arrival: with_aimed.then_some(aimed), aimed_departure: with_aimed.then_some(aimed), arrival: Some(aimed + delay), departure: Some(aimed + delay) })
                })
                .collect();
            if calls.is_empty() {
                continue;
            }
            let last = index.code_of_stop[*pattern.stop.last().unwrap() as usize];
            // L'identifiant de circulation est volontairement faux : seul le rapprochement par arrêts et heures est mesuré.
            journeys.push(Journey { route: schedule.route_ids[trip.route as usize].to_string(), short_ref: format!("inconnu-{t}"), destination: last, calls });
            truth.push(trip.id.to_string());
        }
        let started = Instant::now();
        let (realtime, stats) = match_journeys(&schedule, &journeys, now);
        let ms = started.elapsed().as_millis();
        // Une circulation est bien attribuée quand sa course attendue reçoit une mise à jour ; les mises à jour d'autres courses sont des erreurs.
        let truth_set: HashSet<&String> = truth.iter().collect();
        let right = truth.iter().filter(|id| realtime.trips.contains_key(*id)).count();
        let wrong = realtime.trips.keys().filter(|id| !truth_set.contains(id)).count();
        println!(
            "RAPPROCHEMENT ({label}) circulations={} attribuées={} bonnes={right} ({:.1} %) mauvaises={wrong} sans_course={} ms={ms}",
            journeys.len(),
            stats.by_stops + stats.by_id,
            100.0 * right as f64 / journeys.len().max(1) as f64,
            stats.unmatched
        );
    }
    println!("MEMOIRE fin={:.0} Mo", rss_mb());
}
