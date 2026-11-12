//! Tests du rapprochement SIRI → GTFS sur un GTFS et un SIRI écrits à la main (aucune clé ni accès réseau).
//! Les formes (identifiants `STIF:StopPoint:Q:…`, `STIF:Line::C01371:`, `IDFM:TN:SNCF:<uuid>`) sont celles relevées sur les
//! vraies réponses de PRIM et le vrai GTFS du 10 novembre 2026.

use super::*;
use crate::gtfs_compact::{self, tests::fixture};
use serde_json::json;

const AGENCY: &str = "agency_id,agency_name,agency_url,agency_timezone\nIDFM:1,IDFM,https://x.example,Europe/Paris\n";
const CALENDAR: &str = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nIDFM:1,1,1,1,1,1,1,1,20260101,20261231\n";
const ROUTES: &str = "route_id,agency_id,route_short_name,route_long_name,route_type,route_color\n\
IDFM:C01371,IDFM:1,1,1,1,FFBE00\n\
IDFM:C01742,IDFM:1,A,A,2,EB2132\n\
IDFM:C01737,IDFM:1,H,H,2,84653D\n\
IDFM:C01745,IDFM:1,TER,TER Centre,2,AAAAAA\n\
IDFM:C00033,IDFM:1,740,740,3,82DC73\n";
const STOPS: &str = "stop_id,stop_name,stop_lat,stop_lon\n\
IDFM:100,Château de Vincennes,48.8441,2.4405\n\
IDFM:101,Berault,48.8452,2.4281\n\
IDFM:102,Saint-Mandé,48.8460,2.4180\n\
IDFM:monomodalStopPlace:200,Paris Saint-Lazare,48.8765,2.3252\n\
IDFM:monomodalStopPlace:201,Nanterre,48.8918,2.2109\n";
const TRIPS: &str = "route_id,service_id,trip_id,trip_headsign\n\
IDFM:C01371,IDFM:1,IDFM:RATP:A,Château de Vincennes\n\
IDFM:C01371,IDFM:1,IDFM:RATP:B,La Défense\n\
IDFM:C01371,IDFM:1,IDFM:RATP:C,Château de Vincennes\n\
IDFM:C01742,IDFM:1,IDFM:TN:SNCF:3e64b3cc-46a7-4968-8df2-6316175a9553,Nanterre\n\
IDFM:C01745,IDFM:1,IDFM:TER:1,Dreux\n";
/// La ligne 1 va vers Vincennes de 100 à 102 (A à 12:00, C à 12:03), et revient de 102 à 100 (B à 12:00).
const STOP_TIMES: &str = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
IDFM:RATP:A,12:00:00,12:00:00,IDFM:102,0\n\
IDFM:RATP:A,12:02:00,12:02:00,IDFM:101,1\n\
IDFM:RATP:A,12:04:00,12:04:00,IDFM:100,2\n\
IDFM:RATP:C,12:03:00,12:03:00,IDFM:102,0\n\
IDFM:RATP:C,12:05:00,12:05:00,IDFM:101,1\n\
IDFM:RATP:C,12:07:00,12:07:00,IDFM:100,2\n\
IDFM:RATP:B,12:00:00,12:00:00,IDFM:100,0\n\
IDFM:RATP:B,12:02:00,12:02:00,IDFM:101,1\n\
IDFM:RATP:B,12:04:00,12:04:00,IDFM:102,2\n\
IDFM:TN:SNCF:3e64b3cc-46a7-4968-8df2-6316175a9553,12:10:00,12:10:00,IDFM:monomodalStopPlace:200,0\n\
IDFM:TN:SNCF:3e64b3cc-46a7-4968-8df2-6316175a9553,12:20:00,12:20:00,IDFM:monomodalStopPlace:201,1\n\
IDFM:TER:1,12:10:00,12:10:00,IDFM:monomodalStopPlace:200,0\n\
IDFM:TER:1,12:20:00,12:20:00,IDFM:monomodalStopPlace:201,1\n";

pub(crate) fn config(modes: &[&str]) -> Config {
    Config { key: "clé-de-test".into(), modes: modes.iter().map(|m| m.to_string()).collect(), every: Duration::from_secs(180), memory_limit: 100 << 20, gtfs_url: DEFAULT_GTFS_URL.into() }
}

/// Le GTFS d'Île-de-France de poche, construit pour le 10 novembre 2026 à midi, heure de Paris.
pub(crate) fn schedule(name: &str) -> Schedule {
    let zip = fixture::tisseo_zip_with(
        name,
        &[
            ("agency.txt".into(), AGENCY.into()),
            ("calendar.txt".into(), CALENDAR.into()),
            ("calendar_dates.txt".into(), "service_id,date,exception_type\n".into()),
            ("routes.txt".into(), ROUTES.into()),
            ("stops.txt".into(), STOPS.into()),
            ("trips.txt".into(), TRIPS.into()),
            ("stop_times.txt".into(), STOP_TIMES.into()),
            ("shapes.txt".into(), "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n".into()),
        ],
    );
    let config = config(&["metro", "train"]);
    let mut schedule = gtfs_compact::build_with(&zip.0, fixture::paris("2026-11-10T12:00:00"), &|info| config.keeps(info), None).unwrap();
    decorate(&mut schedule);
    schedule
}

fn utc(local: &str) -> String {
    jiff::Timestamp::from_second(fixture::paris(local)).unwrap().to_string()
}

fn call(stop: &str, expected: &str, aimed: Option<&str>) -> serde_json::Value {
    let mut c = json!({"StopPointRef": {"value": stop}, "ExpectedArrivalTime": utc(expected), "ExpectedDepartureTime": utc(expected), "DepartureStatus": "ON_TIME"});
    if let Some(aimed) = aimed {
        c["AimedArrivalTime"] = json!(utc(aimed));
        c["AimedDepartureTime"] = json!(utc(aimed));
    }
    c
}

fn siri(journeys: Vec<serde_json::Value>) -> Vec<u8> {
    let body = json!({"Siri": {"ServiceDelivery": {"ResponseTimestamp": "2026-11-10T11:00:00Z", "EstimatedTimetableDelivery": [{"EstimatedJourneyVersionFrame": [{"EstimatedVehicleJourney": journeys}]}]}}});
    serde_json::to_vec(&body).unwrap()
}

fn journey(line: &str, reference: &str, destination: Option<&str>, calls: Vec<serde_json::Value>) -> serde_json::Value {
    let mut j = json!({
        "LineRef": {"value": format!("STIF:Line::{line}:")},
        "DatedVehicleJourneyRef": {"value": reference},
        "VehicleMode": ["METRO"],
        "PublishedLineName": [{"value": "1"}],
        "EstimatedCalls": {"EstimatedCall": calls},
    });
    if let Some(d) = destination {
        j["DestinationRef"] = json!({"value": d});
    }
    j
}

#[test]
fn les_references_siri_sont_lues() {
    assert_eq!(stop_code("STIF:StopPoint:Q:22085:"), Some(StopCode { area: false, n: 22085 }));
    assert_eq!(stop_code("STIF:StopArea:SP:43213:"), Some(StopCode { area: true, n: 43213 }));
    assert_eq!(stop_code("STIF:Line::C01371:"), None);
    assert_eq!(stop_code(""), None);
    assert_eq!(gtfs_stop_code("IDFM:22085"), Some(StopCode { area: false, n: 22085 }));
    assert_eq!(gtfs_stop_code("IDFM:monomodalStopPlace:43213"), Some(StopCode { area: true, n: 43213 }));
    assert_eq!(gtfs_stop_code("IDFM:multimodalStopPlace:1"), None);
}

#[test]
fn le_siri_est_lu_en_flux_et_filtre_par_ligne() {
    let body = siri(vec![
        journey("C01371", "RATP-SIV:VehicleJourney::20261110.235.R.C01371:LOC", Some("STIF:StopPoint:Q:100:"), vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:02:30", None)]),
        journey("C00033", "509_KGPVM:VehicleJourney::3853623:LOC", None, vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:02:30", Some("2026-11-10T12:02:00"))]),
        // Tous les appels annulés : rien à garder.
        journey("C01371", "RATP-SIV:VehicleJourney::x:LOC", None, vec![json!({"StopPointRef": {"value": "STIF:StopPoint:Q:101:"}, "ArrivalStatus": "CANCELLED", "ExpectedArrivalTime": utc("2026-11-10T12:03:00")})]),
    ]);
    let all = parse_siri(&body, &|_| true).unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].route, "IDFM:C01371");
    assert_eq!(all[0].short_ref, "20261110.235.R.C01371");
    assert_eq!(all[0].destination, Some(StopCode { area: false, n: 100 }));
    assert_eq!(all[1].short_ref, "3853623");
    let metro = parse_siri(&body, &|route| route == "IDFM:C01371").unwrap();
    assert_eq!(metro.len(), 1);
    // Le même JSON compressé.
    let mut gz = Vec::new();
    {
        let mut encoder = flate2::write::GzEncoder::new(&mut gz, flate2::Compression::fast());
        std::io::Write::write_all(&mut encoder, &body).unwrap();
        encoder.finish().unwrap();
    }
    assert_eq!(parse_siri(&gz, &|_| true).unwrap().len(), 2);
    assert!(parse_siri(b"pas du json", &|_| true).is_err());
}

#[test]
fn les_lignes_gardees_sont_celles_des_modes_choisis_sans_les_ter() {
    let schedule = schedule("modes");
    let mut names: Vec<&str> = schedule.routes.iter().map(|r| r.short.as_deref().unwrap()).collect();
    names.sort_unstable();
    assert_eq!(names, ["1", "A", "H"], "les TER (déjà dans la couche des trains) et les bus (non demandés) sont écartés");
    let rer = schedule.routes.iter().find(|r| r.short.as_deref() == Some("A")).unwrap();
    assert_eq!(rer.long.as_deref(), Some("RER A"));
    assert_eq!(rer.color.as_deref(), Some("eb2132"), "la couleur officielle de la ligne");
}

#[test]
fn le_metro_est_rapproche_par_ses_arrets_et_son_sens() {
    let schedule = schedule("metro");
    let now = fixture::paris("2026-11-10T12:01:00");
    // Vers Vincennes (102 → 101 → 100) : la course A (12:02, 12:04) plutôt que C (12:05, 12:07) ou que B (sens inverse).
    let toward = journey("C01371", "RATP-SIV:VehicleJourney::20261110.1.R.C01371:LOC", Some("STIF:StopPoint:Q:100:"), vec![call("STIF:StopPoint:Q:100:", "2026-11-10T12:04:35", None), call("STIF:StopPoint:Q:101:", "2026-11-10T12:02:30", None)]);
    // Un seul arrêt annoncé, vers La Défense (terminus 102) : seule B convient.
    let back = journey("C01371", "RATP-SIV:VehicleJourney::20261110.2.A.C01371:LOC", Some("STIF:StopPoint:Q:102:"), vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:02:10", None)]);
    let journeys = parse_siri(&siri(vec![toward, back]), &|_| true).unwrap();
    let (realtime, stats) = match_journeys(&schedule, &journeys, now);
    assert_eq!((stats.by_id, stats.by_stops, stats.unmatched), (0, 2, 0));
    let a = &realtime.trips["IDFM:RATP:A"][0];
    assert_eq!(a.start_date.unwrap().to_string(), "2026-11-10");
    assert!(!a.delay_known, "sans heure théorique dans le SIRI, le retard n'est pas affiché");
    assert_eq!(a.stops.len(), 2);
    let at_101 = a.stops.iter().find(|s| s.stop_sequence == Some(1)).unwrap();
    assert_eq!(at_101.arrival.unwrap().time, Some(fixture::paris("2026-11-10T12:02:30")));
    assert!(realtime.trips.contains_key("IDFM:RATP:B") && !realtime.trips.contains_key("IDFM:RATP:C"));
}

#[test]
fn une_course_n_est_donnee_qu_a_un_vehicule() {
    let schedule = schedule("claim");
    let now = fixture::paris("2026-11-10T12:01:00");
    // Deux véhicules annoncés à 101 à 12:02:20 et 12:04:30 : A (12:02) et C (12:05), pas deux fois A.
    let first = journey("C01371", "RATP-SIV:VehicleJourney::1:LOC", Some("STIF:StopPoint:Q:100:"), vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:02:20", None), call("STIF:StopPoint:Q:100:", "2026-11-10T12:04:20", None)]);
    let second = journey("C01371", "RATP-SIV:VehicleJourney::2:LOC", Some("STIF:StopPoint:Q:100:"), vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:04:30", None), call("STIF:StopPoint:Q:100:", "2026-11-10T12:06:30", None)]);
    let journeys = parse_siri(&siri(vec![second, first]), &|_| true).unwrap();
    let (realtime, stats) = match_journeys(&schedule, &journeys, now);
    assert_eq!(stats.by_stops, 2);
    assert!(realtime.trips.contains_key("IDFM:RATP:A") && realtime.trips.contains_key("IDFM:RATP:C"));
}

#[test]
fn un_vehicule_loin_de_tout_horaire_n_est_pas_rapproche() {
    let schedule = schedule("loin");
    // 40 minutes plus tard que n'importe quelle course.
    let late = journey("C01371", "RATP-SIV:VehicleJourney::3:LOC", None, vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:40:00", None)]);
    let (realtime, stats) = match_journeys(&schedule, &parse_siri(&siri(vec![late]), &|_| true).unwrap(), fixture::paris("2026-11-10T12:01:00"));
    assert_eq!((stats.by_stops, stats.unmatched), (0, 1));
    assert!(realtime.trips.is_empty());
}

#[test]
fn le_rer_est_rapproche_par_identifiant_et_son_retard_est_exact() {
    let schedule = schedule("rer");
    let now = fixture::paris("2026-11-10T12:05:00");
    let uuid = "3e64b3cc-46a7-4968-8df2-6316175a9553";
    // La gare est annoncée par sa zone d'arrêt (`StopArea:SP`), avec l'heure théorique : 2 minutes de retard.
    let train = journey("C01742", &format!("SNCF_MAGENTA_PRD:VehicleJourney::{uuid}:LOC"), None, vec![call("STIF:StopArea:SP:200:", "2026-11-10T12:12:00", Some("2026-11-10T12:10:00")), call("STIF:StopArea:SP:201:", "2026-11-10T12:23:00", Some("2026-11-10T12:20:00"))]);
    // Même identifiant mais sur une autre ligne : ce n'est pas cette course.
    let other_line = journey("C01737", &format!("SNCF_MAGENTA_PRD:VehicleJourney::{uuid}:LOC"), None, vec![call("STIF:StopArea:SP:200:", "2026-11-10T12:12:00", Some("2026-11-10T12:10:00"))]);
    let journeys = parse_siri(&siri(vec![train, other_line]), &|_| true).unwrap();
    let (realtime, stats) = match_journeys(&schedule, &journeys, now);
    assert_eq!(stats.by_id, 1);
    let update = &realtime.trips[&format!("IDFM:TN:SNCF:{uuid}")][0];
    assert!(update.delay_known);
    assert_eq!(update.stops.iter().map(|s| s.departure.unwrap().delay).collect::<Vec<_>>(), [Some(120), Some(180)]);
}

// ───────────────────────── Bus ─────────────────────────

const BUS_CALENDAR: &str = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nIDFM:1,1,1,1,1,1,1,1,20260101,20261231\nIDFM:2,0,0,0,0,0,0,0,20260101,20261231\n";
/// Le service `IDFM:2` ne roule que le mercredi 11 novembre 2026, lendemain de la date des tests.
const BUS_CALENDAR_DATES: &str = "service_id,date,exception_type\nIDFM:2,20261111,1\n";
const BUS_TRIPS: &str = "route_id,service_id,trip_id,trip_headsign\n\
IDFM:C00033,IDFM:1,IDFM:BUS:1,Gare\n\
IDFM:C00033,IDFM:1,IDFM:BUS:2,Gare\n\
IDFM:C00033,IDFM:1,IDFM:BUS:3,Gare\n\
IDFM:C00033,IDFM:2,IDFM:BUS:DEMAIN,Gare\n";
/// Trois bus de la ligne 740 passent à 12:00, 12:10 et 12:20 à l'arrêt 100, puis 3 et 6 minutes plus tard aux deux suivants ; un quatrième ne roule que demain.
const BUS_STOP_TIMES: &str = "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n\
IDFM:BUS:1,12:00:00,12:00:00,IDFM:100,0\nIDFM:BUS:1,12:03:00,12:03:00,IDFM:101,1\nIDFM:BUS:1,12:06:00,12:06:00,IDFM:102,2\n\
IDFM:BUS:2,12:10:00,12:10:00,IDFM:100,0\nIDFM:BUS:2,12:13:00,12:13:00,IDFM:101,1\nIDFM:BUS:2,12:16:00,12:16:00,IDFM:102,2\n\
IDFM:BUS:3,12:20:00,12:20:00,IDFM:100,0\nIDFM:BUS:3,12:23:00,12:23:00,IDFM:101,1\nIDFM:BUS:3,12:26:00,12:26:00,IDFM:102,2\n\
IDFM:BUS:DEMAIN,07:00:00,07:00:00,IDFM:100,0\nIDFM:BUS:DEMAIN,07:03:00,07:03:00,IDFM:101,1\nIDFM:BUS:DEMAIN,07:06:00,07:06:00,IDFM:102,2\n";

fn bus_schedule(name: &str, all_days: bool) -> Schedule {
    let zip = fixture::tisseo_zip_with(
        name,
        &[
            ("agency.txt".into(), AGENCY.into()),
            ("calendar.txt".into(), BUS_CALENDAR.into()),
            ("calendar_dates.txt".into(), BUS_CALENDAR_DATES.into()),
            ("routes.txt".into(), ROUTES.into()),
            ("stops.txt".into(), STOPS.into()),
            ("trips.txt".into(), BUS_TRIPS.into()),
            ("stop_times.txt".into(), BUS_STOP_TIMES.into()),
            ("shapes.txt".into(), "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n".into()),
        ],
    );
    let config = config(&["bus"]);
    gtfs_compact::build_days(&zip.0, fixture::paris("2026-11-10T12:00:00"), &|info| config.keeps(info), &|info| if all_days { gtfs_compact::ALL_DAYS } else { config.service_days(info) }, None).unwrap()
}

#[test]
fn les_bus_ne_gardent_pas_les_courses_qui_ne_roulent_que_demain() {
    let all = bus_schedule("bus-tous", true);
    assert_eq!(all.trip_count(), 4, "tous les jours : la course de demain est là");
    let today = bus_schedule("bus-aujourdhui", false);
    assert_eq!(today.trip_count(), 3, "sans « demain » : seules les courses d'aujourd'hui");
    assert!(today.trips.iter().all(|t| !t.id.contains("DEMAIN")));
    assert!(today.approx_bytes() < all.approx_bytes());
    // Le métro, lui, garde les trois jours.
    let both = config(&["metro", "bus"]);
    let metro = schedule("jours-metro");
    assert!(metro.routes.iter().all(|r| both.service_days(r) == crate::gtfs_compact::ALL_DAYS));
    assert!(all.routes.iter().all(|r| both.service_days(r) == 0b011));
}

#[test]
fn des_bus_qui_se_suivent_a_dix_minutes_sont_chacun_rapproches_de_leur_course() {
    let schedule = bus_schedule("bus-suite", false);
    let now = fixture::paris("2026-11-10T12:08:00");
    // Un SIRI de bus (quais `StopPoint:Q`, heures théoriques données) : le 1er avec 6 minutes de retard (il est à l'heure du 2e !), le 2e avec 1 minute, le 3e à l'heure.
    let first = journey("C00033", "509_KGPVM:VehicleJourney::3853623:LOC", Some("STIF:StopPoint:Q:102:"), vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:09:00", Some("2026-11-10T12:03:00")), call("STIF:StopPoint:Q:102:", "2026-11-10T12:12:00", Some("2026-11-10T12:06:00"))]);
    let second = journey("C00033", "509_KGPVM:VehicleJourney::3853624:LOC", Some("STIF:StopPoint:Q:102:"), vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:14:00", Some("2026-11-10T12:13:00")), call("STIF:StopPoint:Q:102:", "2026-11-10T12:17:00", Some("2026-11-10T12:16:00"))]);
    let third = journey("C00033", "509_KGPVM:VehicleJourney::3853625:LOC", Some("STIF:StopPoint:Q:102:"), vec![call("STIF:StopPoint:Q:100:", "2026-11-10T12:20:00", Some("2026-11-10T12:20:00")), call("STIF:StopPoint:Q:101:", "2026-11-10T12:23:00", Some("2026-11-10T12:23:00"))]);
    let journeys = parse_siri(&siri(vec![third, second, first]), &|route| route == "IDFM:C00033").unwrap();
    let (realtime, stats) = match_journeys(&schedule, &journeys, now);
    assert_eq!((stats.journeys, stats.by_stops, stats.unmatched), (3, 3, 0));
    // Chacun a la course dont l'heure *théorique* est la sienne, quel que soit son retard : 6 minutes de retard ne font pas du 1er le 2e.
    let delay_at = |trip: &str, sequence: u32| realtime.trips[trip][0].stops.iter().find(|s| s.stop_sequence == Some(sequence)).unwrap().arrival.unwrap().delay;
    assert_eq!(delay_at("IDFM:BUS:1", 1), Some(360));
    assert_eq!(delay_at("IDFM:BUS:2", 1), Some(60));
    assert_eq!(delay_at("IDFM:BUS:3", 1), Some(0));
    assert!(realtime.trips.values().all(|updates| updates[0].delay_known));
}

#[test]
fn un_bus_sans_heure_theorique_est_rapproche_par_ses_heures_prevues() {
    let schedule = bus_schedule("bus-sans-theorique", false);
    let now = fixture::paris("2026-11-10T12:08:00");
    // Sans heure théorique, le retard est confondu avec l'écart d'horaire : 1 minute de retard reste attribuable à la bonne course (écart de 4 minutes toléré).
    let bus = journey("C00033", "509_KGPVM:VehicleJourney::inconnu:LOC", Some("STIF:StopPoint:Q:102:"), vec![call("STIF:StopPoint:Q:101:", "2026-11-10T12:14:00", None), call("STIF:StopPoint:Q:102:", "2026-11-10T12:17:00", None)]);
    let (realtime, stats) = match_journeys(&schedule, &parse_siri(&siri(vec![bus]), &|_| true).unwrap(), now);
    assert_eq!(stats.by_stops, 1);
    assert!(realtime.trips.contains_key("IDFM:BUS:2"));
    assert!(!realtime.trips["IDFM:BUS:2"][0].delay_known, "sans heure théorique : pas de retard affiché");
}
