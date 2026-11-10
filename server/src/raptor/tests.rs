//! Réseau synthétique dont on connaît les réponses.
//!
//! ```text
//!   A ──── B ──── C ──── D ·· E (520 m à pied)      F (après D)      G (train hors service)
//!
//!   1001  A 08:00 → B 08:30 → C 09:00
//!   1002  C 09:05 → D 09:35         (raté : on arrive à C à 09:00, il faut 8 min pour changer)
//!   1003  C 09:15 → D 09:45         (la bonne correspondance)
//!   1004  A 08:10 → D 10:30         (direct mais lent : il doit perdre)
//!   1005  A 09:00 → D 09:30         (direct, part plus tard mais arrive bien plus tôt)
//!   1006  D 09:50 → F 10:20
//!   1007  A 08:05 → G 08:50         (service qui ne roule pas ce jour-là)
//!   1008  B 24:20 → H 24:50         (jour de service de la veille : part à 00:20)
//! ```
//! On part le mardi 10 novembre 2026 à 07:30 (heure de Paris), sauf mention contraire.

use jiff::civil::date;
use jiff::tz::TimeZone;

use super::*;
use crate::gtfs_rt::{FeedEntity, FeedHeader, FeedMessage, StopTimeEvent, StopTimeUpdate, TripDescriptor, TripUpdate};
use crate::realtime;
use crate::timetable::StopTime;

const A: u32 = 0;
const B: u32 = 1;
const C: u32 = 2;
const D: u32 = 3;
const E: u32 = 4;
const F: u32 = 5;
const G: u32 = 6;
const H: u32 = 7;

const fn hm(h: i32, m: i32) -> i32 {
    h * 3600 + m * 60
}

fn station(code: &str, lon: f64, lat: f64) -> Station {
    Station { code: code.into(), name: code.into(), lon, lat }
}

fn trip(number: &str, service: u32, stops: &[(u32, i32, i32)]) -> Trip {
    Trip {
        id: number.into(),
        number: number.into(),
        category: "TER".into(),
        line: String::new(),
        service,
        stops: stops
            .iter()
            .enumerate()
            .map(|(i, &(station, arrival, departure))| StopTime {
                station,
                stop_point: station,
                stop_sequence: i as u32,
                arrival,
                departure,
            })
            .collect(),
    }
}

/// Le réseau du schéma ; sans `direct`, les trains 1004 et 1005 n'existent pas.
fn network(direct: bool) -> Timetable {
    let stations = vec![
        station("A", 2.0, 48.0),
        station("B", 2.5, 48.0),
        station("C", 3.0, 48.0),
        station("D", 3.5, 48.0),
        station("E", 3.507, 48.0), // 520 m à l'est de D
        station("F", 4.0, 48.0),
        station("G", 5.0, 49.0),
        station("H", 6.0, 50.0),
    ];
    let mut trips = vec![
        trip("1001", 0, &[(A, hm(8, 0), hm(8, 0)), (B, hm(8, 30), hm(8, 31)), (C, hm(9, 0), hm(9, 1))]),
        trip("1002", 0, &[(C, hm(9, 5), hm(9, 5)), (D, hm(9, 35), hm(9, 35))]),
        trip("1003", 0, &[(C, hm(9, 15), hm(9, 15)), (D, hm(9, 45), hm(9, 45))]),
        trip("1006", 0, &[(D, hm(9, 50), hm(9, 50)), (F, hm(10, 20), hm(10, 20))]),
        trip("1007", 1, &[(A, hm(8, 5), hm(8, 5)), (G, hm(8, 50), hm(8, 50))]),
        trip("1008", 0, &[(B, hm(24, 20), hm(24, 20)), (H, hm(24, 50), hm(24, 50))]),
    ];
    if direct {
        trips.push(trip("1004", 0, &[(A, hm(8, 10), hm(8, 10)), (D, hm(10, 30), hm(10, 30))]));
        trips.push(trip("1005", 0, &[(A, hm(9, 0), hm(9, 0)), (D, hm(9, 30), hm(9, 30))]));
    }
    // Service 0 : tous les jours ; service 1 : seulement le jeudi 12 novembre. Les jours se comptent depuis le lundi 9.
    let services = vec![(0..10).collect(), vec![3]];
    Timetable::new(1, stations, Vec::new(), trips, "test".into(), services, date(2026, 11, 9), TimeZone::get("Europe/Paris").unwrap())
}

fn paris(day: i8, h: i8, m: i8) -> i64 {
    date(2026, 11, day).at(h, m, 0, 0).to_zoned(TimeZone::get("Europe/Paris").unwrap()).unwrap().timestamp().as_second()
}

fn run(timetable: &Timetable, origin: u32, depart: i64, max_minutes: i32, max_trips: usize) -> Isochrone<'_> {
    isochrone(timetable, None, depart, &Params { origin, depart, max_duration: max_minutes * 60, max_trips })
}

fn seconds_to(iso: &Isochrone, station: u32) -> Option<i32> {
    iso.reached().into_iter().find(|r| r.station == station).map(|r| r.seconds)
}

fn transfers_to(iso: &Isochrone, station: u32) -> u8 {
    iso.reached().into_iter().find(|r| r.station == station).unwrap().transfers
}

fn trains_of(timetable: &Timetable, legs: &[Leg]) -> Vec<String> {
    legs.iter()
        .map(|leg| match leg {
            Leg::Train { trip, .. } => timetable.trips[*trip as usize].number.clone(),
            Leg::Walk { .. } => "marche".into(),
        })
        .collect()
}

#[test]
fn le_train_direct_plus_tard_bat_le_direct_lent() {
    let tt = network(true);
    let iso = run(&tt, A, paris(10, 7, 30), 600, 4);
    // Le 1004 (parti à 08:10) arrive à 10:30 ; le 1005 (parti à 09:00) à 09:30 ; par C on arrive à 09:45.
    assert_eq!(seconds_to(&iso, D), Some(2 * 3600));
    assert_eq!(trains_of(&tt, &iso.journey(D).unwrap()), ["1005"]);
    assert_eq!(transfers_to(&iso, D), 0);
}

#[test]
fn correspondance_ratee_puis_prise() {
    // Sans les directs : on arrive à C à 09:00, le 1002 part à 09:05 (trop tôt), le 1003 à 09:15.
    let tt = network(false);
    let iso = run(&tt, A, paris(10, 7, 30), 600, 4);
    assert_eq!(seconds_to(&iso, D), Some(2 * 3600 + 15 * 60));
    let legs = iso.journey(D).unwrap();
    assert_eq!(trains_of(&tt, &legs), ["1001", "1003"]);
    assert_eq!(transfers_to(&iso, D), 1);
    // Les heures de l'itinéraire : monté à A à 08:00, descendu à C à 09:00, remonté à C à 09:15.
    let Leg::Train { departure, arrival, from, to, stops, .. } = legs[0] else { panic!("un train attendu") };
    assert_eq!((from, to, stops), (A, C, 3));
    assert_eq!(departure, paris(10, 8, 0));
    assert_eq!(arrival, paris(10, 9, 0));
    let Leg::Train { departure, .. } = legs[1] else { panic!("un train attendu") };
    assert_eq!(departure, paris(10, 9, 15));
}

#[test]
fn le_nombre_de_correspondances_limite_la_portee() {
    let tt = network(true);
    // Par le 1005 puis le 1006 : F à 10:20, avec une correspondance.
    let two = run(&tt, A, paris(10, 7, 30), 600, 2);
    assert_eq!(seconds_to(&two, F), Some(2 * 3600 + 50 * 60));
    assert_eq!(trains_of(&tt, &two.journey(F).unwrap()), ["1005", "1006"]);
    // Avec un seul train, F est hors de portée mais D reste atteignable.
    let one = run(&tt, A, paris(10, 7, 30), 600, 1);
    assert_eq!(seconds_to(&one, F), None);
    assert!(seconds_to(&one, D).is_some());
}

#[test]
fn la_duree_maximale_coupe() {
    let tt = network(true);
    let iso = run(&tt, A, paris(10, 7, 30), 100, 4); // 1 h 40
    assert_eq!(seconds_to(&iso, C), Some(90 * 60)); // C par le 1001 à 09:00
    assert_eq!(seconds_to(&iso, D), None); // 09:30 : 2 h
    assert_eq!(seconds_to(&iso, A), Some(0));
}

#[test]
fn la_marche_relie_les_gares_voisines() {
    let tt = network(true);
    let iso = run(&tt, A, paris(10, 7, 30), 600, 4);
    // D à 09:30 puis marche : 3 min + 520 m × 1,3 à 4,5 km/h (≈ 9 min), sans compter un train de plus.
    let walk = seconds_to(&iso, E).unwrap() - seconds_to(&iso, D).unwrap();
    assert!((11 * 60..13 * 60).contains(&walk), "marche de {walk} s");
    assert_eq!(trains_of(&tt, &iso.journey(E).unwrap()), ["1005", "marche"]);
    assert_eq!(transfers_to(&iso, E), 0);
}

#[test]
fn un_service_hors_calendrier_ne_roule_pas() {
    let tt = network(true);
    let iso = run(&tt, A, paris(10, 7, 30), 600, 4);
    assert_eq!(seconds_to(&iso, G), None); // le 1007 ne roule que le jeudi
    // Le jeudi 12, il roule : 08:05 → 08:50 en partant à 07:30.
    let thursday = run(&tt, A, paris(12, 7, 30), 600, 4);
    assert_eq!(seconds_to(&thursday, G), Some(80 * 60));
}

#[test]
fn un_train_de_la_veille_passe_minuit() {
    let tt = network(true);
    // Le 1008 est du jour de service du 9 (« 24:20 » = 00:20 le 10) : on le prend en partant à 00:00 le 10.
    let iso = run(&tt, B, paris(10, 0, 0), 120, 2);
    assert_eq!(seconds_to(&iso, H), Some(50 * 60));
    // À 07:30 le même jour, il est parti depuis longtemps ; celui de la nuit suivante est trop loin (14 h).
    assert_eq!(seconds_to(&run(&tt, B, paris(10, 7, 30), 600, 2), H), None);
    // Le lendemain à 00:00, il repart (service du 10).
    assert_eq!(seconds_to(&run(&tt, B, paris(11, 0, 0), 120, 2), H), Some(50 * 60));
}

#[test]
fn le_changement_exige_huit_minutes_mais_pas_au_depart() {
    let tt = network(false);
    // Parti de C pile à 09:05 : on prend le 1002 sans délai (on est déjà sur le quai).
    let iso = run(&tt, C, paris(10, 9, 5), 120, 2);
    assert_eq!(seconds_to(&iso, D), Some(30 * 60));
}

/// Un flux GTFS-RT où chaque circulation citée a `delay` secondes de retard dès son premier arrêt, ou est supprimée (`None`).
fn feed(updates: &[(&str, Option<i32>)], at: i64) -> realtime::Realtime {
    let entity = updates
        .iter()
        .map(|&(trip, delay)| FeedEntity {
            id: trip.into(),
            is_deleted: None,
            vehicle: None,
            trip_update: Some(TripUpdate {
                trip: TripDescriptor {
                    trip_id: Some(trip.into()),
                    start_date: None,
                    schedule_relationship: delay.is_none().then_some(crate::gtfs_rt::TRIP_CANCELED),
                    route_id: None,
                },
                stop_time_update: delay
                    .map(|delay| {
                        vec![StopTimeUpdate {
                            stop_sequence: Some(0),
                            arrival: Some(StopTimeEvent { delay: Some(delay), time: None }),
                            departure: Some(StopTimeEvent { delay: Some(delay), time: None }),
                            stop_id: None,
                            schedule_relationship: None,
                        }]
                    })
                    .unwrap_or_default(),
                timestamp: None,
            }),
        })
        .collect();
    realtime::from_feed(FeedMessage { header: FeedHeader { gtfs_realtime_version: "2.0".into(), timestamp: Some(at as u64) }, entity }, at)
}

#[test]
fn le_temps_reel_retarde_ou_supprime_un_train() {
    let tt = network(true);
    let depart = paris(10, 7, 30);
    let params = Params { origin: A, depart, max_duration: 600 * 60, max_trips: 4 };

    // Le 1005 a 25 minutes de retard : il arrive à D à 09:55, après le 1003 (09:45). Du coup la
    // correspondance vers le 1006 (09:50) n'existe plus, et F devient inatteignable.
    let delayed = feed(&[("1005", Some(25 * 60))], depart);
    let iso = isochrone(&tt, Some(&delayed), depart, &params);
    assert!(iso.realtime);
    assert_eq!(seconds_to(&iso, D), Some(2 * 3600 + 15 * 60));
    assert_eq!(seconds_to(&iso, F), None);

    // Un train supprimé est ignoré.
    let canceled = feed(&[("1005", None)], depart);
    assert_eq!(seconds_to(&isochrone(&tt, Some(&canceled), depart, &params), D), Some(2 * 3600 + 15 * 60));

    // Un train dont l'horaire prévu est passé, mais retardé : parti de A à 09:30, le 1005 (prévu à 09:00)
    // est retardé de 40 min, donc part à 09:40 et arrive à D à 10:10.
    let late = paris(10, 9, 30);
    let params = Params { origin: A, depart: late, max_duration: 240 * 60, max_trips: 4 };
    let rt = feed(&[("1005", Some(40 * 60))], late);
    assert_eq!(seconds_to(&isochrone(&tt, Some(&rt), late, &params), D), Some(40 * 60));
    // Sans temps réel, il est déjà parti.
    assert_eq!(seconds_to(&isochrone(&tt, None, late, &params), D), None);

    // Hors de la fenêtre « autour de maintenant », le temps réel est ignoré.
    let far = isochrone(&tt, Some(&delayed), depart, &Params { depart: depart - 24 * 3600, ..params });
    assert!(!far.realtime);
}

#[test]
fn les_terminus_parisiens_sont_relies_par_des_temps_fixes() {
    // Nord et Est sont à 500 m : sans règle particulière, la marche ferait une douzaine de minutes.
    let stations = vec![
        station("87271007", 2.3549, 48.8801),
        station("87113001", 2.3584, 48.8767),
        station("87391003", 2.3205, 48.8412),
        station("87391102", 2.3205, 48.8412), // second quai de Montparnasse
        station("87723197", 4.8594, 45.7606),
        station("87722025", 4.8258, 45.7485),
    ];
    let pairs = walking_pairs(&stations);
    let seconds = |a: u32, b: u32| pairs.iter().find(|p| (p.0, p.1) == (a.min(b), a.max(b))).map(|p| p.2);
    assert_eq!(seconds(0, 1), Some(20 * 60)); // Nord ↔ Est
    assert_eq!(seconds(0, 2), Some(45 * 60)); // Nord ↔ Montparnasse : pas dans le tableau, valeur par défaut
    assert_eq!(seconds(1, 2), Some(45 * 60));
    assert_eq!(seconds(2, 3), Some(MIN_CHANGE)); // deux quais d'une même gare : marche courte, pas moins qu'un changement
    assert_eq!(seconds(4, 5), Some(25 * 60)); // Part-Dieu ↔ Perrache
}
