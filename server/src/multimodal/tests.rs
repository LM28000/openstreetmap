//! Réseau synthétique : deux gares du rail, un car, et un morceau de métro à Paris, dont on connaît les réponses.
//!
//! ```text
//!   R1 ──train 08:00→09:00── R2 · 300 m · C1 ──car 09:30→10:15── C2         (le car n'existe que dans les extras)
//!
//!   X ──train 07:30→08:00── Nord ·· (fixe 40 min) ·· Lyon       (temps fixe entre terminus parisiens)
//!                            M1 ──métro 08:15→08:30── M2          (M1 est à Nord, M2 à Lyon : rattachés par le nom)
//! ```
//! On part le mardi 10 novembre 2026 à 07:00 (heure de Paris).

use std::sync::Arc;

use jiff::civil::date;
use jiff::tz::TimeZone;

use super::*;
use crate::raptor::{self, MODE_ALL, MODE_CAR, MODE_IDF, MODE_TRAIN, Params};
use crate::timetable::{Station, StopTime, Trip};

const R1: u32 = 0;
const R2: u32 = 1;
const X: u32 = 2;
const NORD: u32 = 3;
const LYON: u32 = 4;

const fn hm(h: i32, m: i32) -> i32 {
    h * 3600 + m * 60
}

fn station(code: &str, name: &str, lon: f64, lat: f64) -> Station {
    Station { code: code.into(), name: name.into(), lon, lat }
}

fn rail_trip(number: &str, stops: &[(u32, i32, i32)]) -> Trip {
    Trip {
        id: number.into(),
        number: number.into(),
        category: "TER".into(),
        line: String::new(),
        service: 0,
        stops: stops
            .iter()
            .enumerate()
            .map(|(i, &(station, arrival, departure))| StopTime { station, stop_point: station, stop_sequence: i as u32, arrival, departure })
            .collect(),
    }
}

fn rail() -> Timetable {
    let stations = vec![
        station("R1", "Rail un", 2.0, 48.0),
        station("R2", "Rail deux", 3.0, 48.0),
        station("X", "Quelque part", 1.0, 49.0),
        station("87271007", "Paris Gare du Nord", 2.3549, 48.8801),
        station("87686006", "Paris Gare de Lyon", 2.3736, 48.8443),
    ];
    let trips = vec![
        rail_trip("1", &[(R1, hm(8, 0), hm(8, 0)), (R2, hm(9, 0), hm(9, 0))]),
        rail_trip("2", &[(X, hm(7, 30), hm(7, 30)), (NORD, hm(8, 0), hm(8, 0))]),
    ];
    // Un seul service, tous les jours à partir du lundi 9 novembre.
    Timetable::new(1, stations, Vec::new(), trips, "test".into(), vec![(0..10).collect()], date(2026, 11, 9), TimeZone::get("Europe/Paris").unwrap())
}

fn call(stop: u32, arrival: i32, departure: i32) -> Call {
    Call { stop, arrival, departure }
}

fn stop(name: &str, lon: f64, lat: f64, kind: Kind) -> RawStop {
    RawStop { name: name.into(), lon, lat, kind, rail_code: None }
}

fn line(kind: Kind, label: &str) -> Line {
    Line { kind, label: label.into(), name: String::new(), color: Some("0055C8".into()), text_color: None }
}

fn feed(name: &str, stops: Vec<RawStop>, lines: Vec<Line>, trips: Vec<(u32, Vec<Call>)>) -> Arc<RawFeed> {
    let mut feed = RawFeed::new(name, date(2026, 11, 9));
    feed.stops = stops;
    feed.lines = lines;
    feed.services = vec![(0..10).collect()];
    feed.trips = trips.into_iter().map(|(line, calls)| RawTrip { line, service: 0, headsign: u32::MAX, calls: calls.into() }).collect();
    Arc::new(feed)
}

/// Le car : C1 à 300 m de R2, C2 loin ; départ à 09:30.
fn coach_feed() -> Arc<RawFeed> {
    feed(
        "cars",
        vec![stop("Gare routière", 3.0 + 0.0042, 48.0, Kind::Coach), stop("Plus loin", 3.5, 48.0, Kind::Coach)],
        vec![line(Kind::Coach, "Car test 7")],
        vec![(0, vec![call(0, hm(9, 30), hm(9, 30)), call(1, hm(10, 15), hm(10, 15))])],
    )
}

/// Le métro : M1 près de Nord, M2 près de Lyon, un départ à 08:15.
fn metro_feed() -> Arc<RawFeed> {
    let mut f = (*feed(
        "idf",
        vec![stop("Gare du Nord", 2.3553, 48.8805, Kind::Metro), stop("Gare de Lyon", 2.3733, 48.8440, Kind::Metro)],
        vec![line(Kind::Metro, "Métro 99")],
        vec![(0, vec![call(0, hm(8, 15), hm(8, 15)), call(1, hm(8, 30), hm(8, 30))])],
    ))
    .clone();
    f.match_by_name = true;
    Arc::new(f)
}

fn paris(h: i8, m: i8) -> i64 {
    date(2026, 11, 10).at(h, m, 0, 0).to_zoned(TimeZone::get("Europe/Paris").unwrap()).unwrap().timestamp().as_second()
}

fn run<'a>(tt: &'a Timetable, extras: &'a Extras, modes: u8, origin: u32, depart: i64) -> raptor::Isochrone<'a> {
    raptor::isochrone_with(tt, &extras.raptor, modes, None, depart, &Params { origin, depart, max_duration: 600 * 60, max_trips: 5 })
}

fn seconds_to(iso: &raptor::Isochrone, stop: u32) -> Option<i32> {
    iso.reached().into_iter().find(|r| r.station == stop).map(|r| r.seconds)
}

#[test]
fn le_car_prolonge_le_train_par_une_marche() {
    let tt = rail();
    let extras = Extras::build(&tt, &[coach_feed()]);
    let (c1, c2) = (extras.rail_count, extras.rail_count + 1);
    assert_eq!(extras.stops.len(), 2);
    let iso = run(&tt, &extras, MODE_ALL, R1, paris(7, 0));
    // Le train arrive à R2 à 09:00 ; marche de 300 m (au moins 8 min : une correspondance) ; le car part à 09:30 et arrive à 10:15.
    assert_eq!(seconds_to(&iso, R2), Some(2 * 3600));
    assert_eq!(seconds_to(&iso, c2), Some(3 * 3600 + 15 * 60));
    let walk = seconds_to(&iso, c1).unwrap() - seconds_to(&iso, R2).unwrap();
    assert!((8 * 60..9 * 60).contains(&walk), "marche de {walk} s");
    // L'itinéraire : train, marche, car.
    let legs = iso.journey(c2).unwrap();
    assert_eq!(legs.len(), 3);
    assert!(matches!(legs[0], raptor::Leg::Train { trip: 0, .. }));
    assert!(matches!(legs[1], raptor::Leg::Walk { .. }));
    let raptor::Leg::Train { trip, from, to, .. } = legs[2] else { panic!("un car attendu") };
    assert_eq!((from, to), (c1, c2));
    let (line, _) = extras.trip(trip).expect("la circulation est un car");
    assert_eq!(line.label, "Car test 7");
}

#[test]
fn sans_les_cars_ils_n_existent_pas() {
    let tt = rail();
    let extras = Extras::build(&tt, &[coach_feed()]);
    let iso = run(&tt, &extras, MODE_TRAIN | MODE_IDF, R1, paris(7, 0));
    // Ni le car, ni la marche vers sa gare routière.
    assert_eq!(seconds_to(&iso, extras.rail_count), None);
    assert_eq!(seconds_to(&iso, extras.rail_count + 1), None);
    assert_eq!(seconds_to(&iso, R2), Some(2 * 3600));
    // Même chose que l'index du rail seul.
    let rail_only = raptor::isochrone(&tt, None, paris(7, 0), &Params { origin: R1, depart: paris(7, 0), max_duration: 600 * 60, max_trips: 5 });
    assert_eq!(rail_only.reached().len(), iso.reached().len());
}

#[test]
fn le_car_ne_roule_pas_un_jour_hors_calendrier() {
    let tt = rail();
    let mut f = (*coach_feed()).clone();
    f.services = vec![vec![5, 6]]; // samedi et dimanche seulement
    let extras = Extras::build(&tt, &[Arc::new(f)]);
    assert_eq!(seconds_to(&run(&tt, &extras, MODE_ALL, R1, paris(7, 0)), extras.rail_count + 1), None);
}

#[test]
fn le_metro_remplace_les_temps_fixes_entre_terminus() {
    let tt = rail();
    let extras = Extras::build(&tt, &[metro_feed()]);
    // Le métro est rattaché aux gares par le nom : aucun arrêt supplémentaire.
    assert_eq!(extras.stops.len(), 0);
    assert_eq!(extras.stats.merged_into_stations, 2);

    // Avec le métro : train jusqu'à Nord (08:00), correspondance de 8 min (train → métro), métro 08:15 → Lyon 08:30.
    let with = run(&tt, &extras, MODE_ALL, X, paris(7, 30));
    assert_eq!(seconds_to(&with, LYON), Some(60 * 60));
    let legs = with.journey(LYON).unwrap();
    assert_eq!(legs.len(), 2);
    let raptor::Leg::Train { trip, .. } = legs[1] else { panic!("le métro attendu") };
    assert_eq!(extras.trip(trip).unwrap().0.label, "Métro 99");

    // Sans lui (trains et cars seulement) : le temps fixe Nord ↔ Lyon, 40 minutes porte à porte, après l'arrivée à 08:00.
    let without = run(&tt, &extras, MODE_TRAIN | MODE_CAR, X, paris(7, 30));
    assert_eq!(seconds_to(&without, LYON), Some(70 * 60));
    assert!(matches!(without.journey(LYON).unwrap()[1], raptor::Leg::Walk { .. }));

    // L'index du rail seul garde son temps fixe, lui aussi.
    let rail_only = raptor::isochrone(&tt, None, paris(7, 30), &Params { origin: X, depart: paris(7, 30), max_duration: 600 * 60, max_trips: 5 });
    assert_eq!(seconds_to(&rail_only, LYON), Some(70 * 60));
}

#[test]
fn les_correspondances_entre_metros_sont_plus_courtes_que_celles_des_trains() {
    // Deux métros qui se suivent à un arrêt supplémentaire : 4 minutes suffisent.
    let tt = rail();
    let stops = vec![
        stop("Un", 5.0, 45.0, Kind::Metro),
        stop("Deux", 5.1, 45.0, Kind::Metro),
        stop("Trois", 5.2, 45.0, Kind::Metro),
    ];
    let lines = vec![line(Kind::Metro, "Métro 1"), line(Kind::Metro, "Métro 2")];
    let f = feed(
        "metro",
        stops,
        lines,
        vec![
            (0, vec![call(0, hm(8, 0), hm(8, 0)), call(1, hm(8, 10), hm(8, 10))]),
            (1, vec![call(1, hm(8, 15), hm(8, 15)), call(2, hm(8, 25), hm(8, 25))]), // 5 min après : assez en métro
        ],
    );
    let extras = Extras::build(&tt, &[f]);
    let origin = extras.rail_count;
    let iso = run(&tt, &extras, MODE_ALL, origin, paris(7, 55));
    assert_eq!(seconds_to(&iso, origin + 2), Some(30 * 60));
}

#[test]
fn les_arrets_de_cars_de_meme_nom_voisins_sont_fusionnes() {
    let tt = rail();
    let f = feed(
        "cars",
        vec![
            stop("Fougères Gare routière", 1.2000, 48.3500, Kind::Coach),
            stop("Fougères - Gare Routière", 1.2005, 48.3502, Kind::Coach), // l'autre quai, 40 m plus loin
            stop("Rennes", 1.6800, 48.1100, Kind::Coach),
        ],
        vec![line(Kind::Coach, "Car 1")],
        vec![
            (0, vec![call(0, hm(8, 0), hm(8, 0)), call(2, hm(9, 0), hm(9, 0))]),
            (0, vec![call(2, hm(10, 0), hm(10, 0)), call(1, hm(11, 0), hm(11, 0))]),
        ],
    );
    let extras = Extras::build(&tt, &[f]);
    assert_eq!(extras.stops.len(), 2);
    // Le car du retour arrive à l'arrêt où part celui de l'aller.
    let iso = run(&tt, &extras, MODE_ALL, extras.rail_count, paris(7, 55));
    assert!(seconds_to(&iso, extras.rail_count + 1).is_some());
}

#[test]
fn rattachement_par_code_uic() {
    let tt = rail();
    let mut near = stop("Peu importe", 3.0, 48.0, Kind::Coach);
    near.rail_code = Some("R2".into());
    let f = feed(
        "cars",
        vec![near, stop("Ailleurs", 3.5, 48.0, Kind::Coach)],
        vec![line(Kind::Coach, "Car TER")],
        vec![(0, vec![call(0, hm(9, 30), hm(9, 30)), call(1, hm(10, 0), hm(10, 0))])],
    );
    let extras = Extras::build(&tt, &[f]);
    // Le premier arrêt est la gare R2 elle-même : un seul arrêt supplémentaire, et la correspondance se fait sans marche.
    assert_eq!(extras.stops.len(), 1);
    let iso = run(&tt, &extras, MODE_ALL, R1, paris(7, 0));
    assert_eq!(seconds_to(&iso, extras.rail_count), Some(3 * 3600));
}

#[test]
fn noms_comparables() {
    assert_eq!(name_words("Montparnasse - Bienvenüe"), ["montparnasse", "bienvenue"]);
    assert_eq!(name_words("Paris Montparnasse"), ["montparnasse"]);
    assert_eq!(name_words("Gare de l'Est"), ["est"]);
    assert_eq!(name_words("St-Denis"), ["saint", "denis"]);
    assert_eq!(name_words("Massy - Palaiseau"), ["massy", "palaiseau"]);
}

#[test]
fn la_ressource_des_arrets_est_stable_et_versionnee() {
    let tt = rail();
    let a = Extras::build(&tt, &[coach_feed()]);
    let b = Extras::build(&tt, &[coach_feed()]);
    assert_eq!(a.version, b.version);
    assert!(std::str::from_utf8(&a.body).unwrap().contains("Gare routière"));
    let more = feed(
        "autres cars",
        vec![stop("Un autre arrêt", 4.0, 47.0, Kind::Coach), stop("Et un autre", 4.1, 47.0, Kind::Coach)],
        vec![line(Kind::Coach, "Car 2")],
        vec![(0, vec![call(0, hm(8, 0), hm(8, 0)), call(1, hm(8, 10), hm(8, 10))])],
    );
    let other = Extras::build(&tt, &[coach_feed(), more]);
    assert_ne!(a.version, other.version);
}
