use super::*;
use crate::gtfs_compact::tests::fixture;
use serde_json::json;

/// Le 10 novembre 2026 à 00:50, heure de Paris : 24:50 du jour de service du 9.
const NIGHT: &str = "2026-11-10T00:50:00";

fn schedule(name: &str) -> Schedule {
    let zip = fixture::tisseo_zip_with(name, &[]);
    gtfs_compact::build(&zip.0, fixture::paris("2026-11-10T12:00:00"), false).unwrap()
}

fn dataset(title: &str, slug: &str, licence: &str, resources: Vec<Value>) -> Value {
    json!({"type": "public-transit", "title": title, "slug": slug, "licence": licence, "resources": resources})
}

fn rt(url: &str, features: &[&str], available: bool) -> Value {
    json!({"format": "gtfs-rt", "features": features, "is_available": available, "original_url": url, "url": "https://www.data.gouv.fr/x"})
}

fn gtfs(id: &str) -> Value {
    json!({"format": "GTFS", "is_available": true, "datagouv_id": id, "url": format!("https://www.data.gouv.fr/api/1/datasets/r/{id}")})
}

fn realtime_at(fetched_at: i64) -> Realtime {
    decode_realtime(fixture::TRIP_UPDATES, fetched_at).unwrap()
}

#[test]
fn catalogue_ne_garde_que_les_horaires_sans_positions_ni_cle() {
    let catalog = json!([
        dataset("Réseau urbain Bibus", "bibus", "lov2", vec![rt("https://a.example/vp", &["vehicle_positions"], true), rt("https://a.example/tu", &["trip_updates"], true), gtfs("b1")]),
        dataset("Réseau urbain Naolib", "reseau-de-transports-collectifs-naolib", "lov2", vec![rt("https://proxy.example/naolib-tu", &["trip_updates"], false), gtfs("n1")]),
        dataset("Réseau urbain Tisséo", "tisseo-reseau-transport-urbain-toulousain", "odc-odbl", vec![rt("https://api.tisseo.fr/opendata/gtfsrt/GtfsRt.pb", &["service_alerts", "trip_updates"], true), gtfs("t1"), gtfs("t2"), gtfs("t3")]),
        dataset("Réseau urbain Txik Txak", "txik", "odc-odbl", vec![rt("https://app.example/rt?apiKey=0f64", &["trip_updates"], true), gtfs("k1")]),
        dataset("Réseau européen Eurostar", "eurostar", "lov2", vec![rt("https://e.example/rt", &["trip_updates"], true), gtfs("e1")]),
        dataset("Trains régionaux ZOU !", "zou-trains", "lov2", vec![rt("https://z.example/rt", &["trip_updates"], true), gtfs("z1")]),
        dataset("Réseau urbain Doublon", "doublon", "lov2", vec![rt("https://api.tisseo.fr/opendata/gtfsrt/GtfsRt.pb", &["trip_updates"], true), gtfs("d1")]),
        dataset("Réseau urbain Sans horaires", "sans", "lov2", vec![rt("https://s.example/rt", &["trip_updates"], true)]),
        json!({"type": "carpooling-areas", "title": "Covoiturage", "slug": "c", "resources": []}),
    ]);
    let sources = parse_sources(&catalog).unwrap();
    let names: Vec<&str> = sources.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(
        names,
        ["Tisséo", "Naolib"],
        "Bibus a ses positions, Txik Txak veut une clé, les trains, le doublon et le jeu sans GTFS sont écartés ; les grandes villes passent en premier"
    );
    assert_eq!(sources[0].licence, "odc-odbl");
    assert_eq!(sources[0].gtfs.len(), MAX_GTFS_PER_NETWORK, "au plus deux GTFS par réseau");
    assert_eq!(sources[1].rt_url, "https://proxy.example/naolib-tu", "un flux que le catalogue dit indisponible est tout de même essayé");
    assert!(parse_sources(&json!({"pas": "un tableau"})).is_err());
}

#[test]
fn decode_le_temps_reel_reel_de_tisseo() {
    let realtime = realtime_at(1_794_270_966);
    let updates = &realtime.trips["2294605"];
    assert_eq!(updates.len(), 1);
    let update = &updates[0];
    assert!(update.start_date.is_none() && !update.canceled);
    let stop = &update.stops[0];
    assert_eq!((stop.stop_sequence, stop.stop_id.as_deref()), (Some(24), Some("stop_point:SP_1268")));
    // Le flux donne une heure (juste) et un retard (faux de 24 h) : l'heure prévaut.
    assert_eq!(stop.arrival.unwrap().delay_from(1_794_270_060), Some(-19));
    assert_eq!(stop.arrival.unwrap().delay, Some(-86_419));
    assert!(decode_realtime(b"\xff\xff", 0).is_err());
    assert_eq!(parse_date("20261110").map(|d| d.to_string()).as_deref(), Some("2026-11-10"));
    assert_eq!(parse_date("0"), None);
}

#[test]
fn la_course_de_nuit_est_estimee_d_apres_l_horaire_theorique() {
    let schedule = schedule("nuit");
    let now = fixture::paris(NIGHT);
    let vehicles = estimate(&schedule, None, now);
    assert_eq!(vehicles.len(), 1, "seule la course de nuit (du service d'hier) roule à 00:50");
    let v = &vehicles[0];
    assert_eq!(v.out.id, "2294605");
    let est = v.out.est.as_ref().unwrap();
    assert!(est.theoretical && est.delay.is_none(), "pas de temps réel : horaire théorique");
    assert_eq!(est.to.as_deref(), Some("Aéroconstellation"));

    // 24:50 : un tiers du chemin entre le 7e arrêt (24:49) et le 8e (24:52).
    let trip = schedule.trips.iter().find(|t| &*t.id == "2294605").unwrap();
    let pattern = &schedule.patterns[trip.pattern as usize];
    let along = pattern.dist[6] + (pattern.dist[7] - pattern.dist[6]) / 3.0;
    let expected = schedule.shapes[pattern.shape as usize].point_at(along);
    assert!((v.out.lon - expected.lon).abs() < 2e-5 && (v.out.lat - expected.lat).abs() < 2e-5, "{} {} contre {expected:?}", v.out.lon, v.out.lat);
    assert!((43.4..43.8).contains(&v.out.lat) && (1.2..1.6).contains(&v.out.lon), "on est à Toulouse");
    assert_eq!(est.next.as_deref(), Some(&*schedule.stops[pattern.stop[7] as usize].name));
    assert_eq!(est.next_at, Some(schedule.day_starts[0] + 24 * 3600 + 52 * 60));
    let speed = f64::from(pattern.dist[7] - pattern.dist[6]) / 180.0 * 3.6;
    assert!((f64::from(v.out.speed.unwrap()) - speed).abs() <= 1.0, "{:?} contre {speed}", v.out.speed);
    assert!(v.out.ts == now && v.out.heading.is_some());
}

#[test]
fn la_trajectoire_envoyee_reconstitue_les_positions_futures() {
    let schedule = schedule("trajectoire");
    let now = fixture::paris(NIGHT);
    let vehicles = estimate(&schedule, None, now);
    let v = &vehicles[0];
    let est = v.out.est.as_ref().unwrap();
    assert_eq!(est.path.len(), 2 * (PATH_POINTS - 1));
    let trip = schedule.trips.iter().find(|t| &*t.id == "2294605").unwrap();
    let live = live_times(&schedule, trip, schedule.day_starts[0], None).unwrap();
    let shape = &schedule.shapes[schedule.patterns[trip.pattern as usize].shape as usize];
    let (mut lon, mut lat) = (e5(v.out.lon), e5(v.out.lat));
    for k in 1..PATH_POINTS {
        lon += est.path[2 * (k - 1)];
        lat += est.path[2 * (k - 1) + 1];
        let expected = shape.point_at(place_at(&schedule, trip, &live, now + k as i64 * PATH_STEP_S).along);
        assert_eq!((lon, lat), (e5(expected.lon), e5(expected.lat)), "point {k}");
    }
    assert!(est.path.iter().any(|d| *d != 0), "le tram avance en 64 secondes");
}

#[test]
fn a_l_arret_au_terminus_et_avant_le_depart() {
    let schedule = schedule("arrets");
    let trip = schedule.trips.iter().find(|t| &*t.id == "2294605").unwrap();
    let day = schedule.day_starts[0];
    let live = live_times(&schedule, trip, day, None).unwrap();
    let dist = &schedule.patterns[trip.pattern as usize].dist;
    let at = |h: i64, m: i64, s: i64| day + h * 3600 + m * 60 + s;
    let stopped = place_at(&schedule, trip, &live, at(24, 49, 0));
    assert_eq!((stopped.along, stopped.speed), (dist[6], 0.0), "pile à l'arrêt de 24:49");
    assert_eq!(place_at(&schedule, trip, &live, at(24, 0, 0)).along, dist[0], "avant le départ : au premier arrêt");
    let end = place_at(&schedule, trip, &live, at(25, 22, 0));
    assert_eq!((end.along, end.next.is_none()), (dist[23], true), "après l'arrivée : au terminus");
    // Apparition 20 s avant le départ (24:40), disparition à l'arrivée (25:21).
    assert_eq!(estimate(&schedule, None, at(24, 39, 30)).len(), 0);
    assert_eq!(estimate(&schedule, None, at(24, 39, 45)).len(), 1);
    assert_eq!(estimate(&schedule, None, at(25, 20, 59)).len(), 1);
    assert_eq!(estimate(&schedule, None, at(25, 21, 1)).len(), 0);
}

#[test]
fn le_temps_reel_corrige_l_horaire_et_n_est_pas_applique_au_mauvais_jour() {
    let schedule = schedule("temps-reel");
    let trip = schedule.trips.iter().find(|t| &*t.id == "2294605").unwrap();
    let realtime = realtime_at(0);
    let update = &realtime.trips["2294605"][0];
    // L'annonce n'a pas de `start_date` : elle vaut pour la course d'hier (arrivée prévue 01:21:00, annoncée 01:20:41)…
    let yesterday = live_times(&schedule, trip, schedule.day_starts[0], Some(update)).unwrap();
    assert_eq!(yesterday.arrival[23], 1_794_270_041);
    assert_eq!(yesterday.arrival[23] - yesterday.scheduled_arrival[23], -19);
    assert_eq!(yesterday.arrival[22], yesterday.scheduled_arrival[22], "avant la première annonce : l'horaire prévu");
    // … et pas pour celle d'aujourd'hui (24 h plus tard), que son retard de -24 h rendrait absurde.
    assert!(live_times(&schedule, trip, schedule.day_starts[1], Some(update)).is_none());

    // 01:20:30 : il roule, attendu au terminus à 01:20:41, soit 19 s en avance.
    let now = fixture::paris("2026-11-10T01:20:30");
    let live = estimate(&schedule, Some(&realtime_at(now)), now);
    let est = live[0].out.est.as_ref().unwrap();
    assert!(!est.theoretical, "le flux annonce cette circulation");
    assert_eq!((est.next_at, est.delay), (Some(1_794_270_041), Some(-19)));
    // 01:20:50 : le temps réel dit qu'il est arrivé à 01:20:41, l'horaire théorique ne l'attend qu'à 01:21:00.
    let later = fixture::paris("2026-11-10T01:20:50");
    assert_eq!(estimate(&schedule, Some(&realtime_at(later)), later).len(), 0);
    assert_eq!(estimate(&schedule, None, later).len(), 1);
    // Un temps réel vieux de plus de 10 minutes n'est plus de confiance : horaire théorique.
    let theoretical = estimate(&schedule, Some(&realtime_at(later - RT_MAX_AGE_S - 1)), later);
    assert!(theoretical[0].out.est.as_ref().unwrap().theoretical);
}

#[test]
fn une_course_annulee_n_est_pas_affichee() {
    let schedule = schedule("annulee");
    let now = fixture::paris(NIGHT);
    let mut realtime = realtime_at(now);
    realtime.trips.get_mut("2294605").unwrap()[0].canceled = true;
    assert!(estimate(&schedule, Some(&realtime), now).is_empty());
}

#[test]
fn le_tram_de_jour_a_sa_place_sur_la_reponse() {
    let slot = Arc::new(Slot {
        source: Source { slug: "tisseo".into(), name: "Tisséo".into(), licence: "odc-odbl".into(), rt_url: String::new(), gtfs: vec![] },
        schedules: RwLock::new(vec![Arc::new(schedule("reponse"))]),
        realtime: RwLock::default(),
        attempt: Mutex::default(),
        idle: Mutex::default(),
        built_at: Mutex::default(),
    });
    let now = fixture::paris("2026-11-10T22:30:00");
    let out = assemble(std::slice::from_ref(&slot), now, false);
    assert_eq!((out.networks.len(), out.lines.len(), out.vehicles.len()), (1, 1, 1));
    assert_eq!(out.est_step, Some(PATH_STEP_S));
    let json = serde_json::to_value(&out).unwrap();
    assert_eq!(json["networks"][0]["name"], "Tisséo");
    assert_eq!(json["networks"][0]["licence"], "odc-odbl");
    assert_eq!((json["lines"][0]["name"].as_str(), json["lines"][0]["color"].as_str(), json["lines"][0]["mode"].as_str()), (Some("T1"), Some("004687"), Some("tram")));
    let v = &json["vehicles"][0];
    assert_eq!(v["id"], "2294719");
    assert_eq!(v["est"]["theoretical"], true);
    assert_eq!(v["est"]["to"], "Palais de Justice");
    assert_eq!(v["est"]["path"].as_array().unwrap().len(), 16);
    // 22:30 : entre le 3e arrêt (22:29) et le 4e (22:31), en route.
    assert_eq!(v["speed"].as_u64().map(|s| s > 5 && s < 70), Some(true), "{v}");
    // Le tram n'est plus là à 23:30, après son terminus (23:09).
    assert!(assemble(&[slot], fixture::paris("2026-11-10T23:30:00"), false).vehicles.is_empty());
}

#[test]
fn le_cache_ne_garde_que_les_gtfs_du_catalogue() {
    let dir = std::env::temp_dir().join(format!("transit-estimates-test-{}", std::process::id()));
    let cache = cache_dir(&dir);
    std::fs::create_dir_all(&cache).unwrap();
    for name in ["res-1.zip", "ancienne-version.zip", "res-2.zip.part"] {
        std::fs::write(cache.join(name), b"zip").unwrap();
    }
    let source = Source { slug: "a".into(), name: "A".into(), licence: String::new(), rt_url: String::new(), gtfs: vec![("res-1".into(), "https://x.example".into())] };
    prune_cache(&dir, &[source]);
    let mut left: Vec<String> = std::fs::read_dir(&cache).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    left.sort();
    assert_eq!(dir_size(&cache, &cache.join("res-1.zip")), 0, "le fichier qu'on remplace ne compte pas dans le plafond");
    std::fs::remove_dir_all(&dir).unwrap();
    assert_eq!(left, ["res-1.zip"], "les anciennes versions et les restes de téléchargement sont effacés");
    assert_eq!(cache_path(Path::new("/d"), "a/../b").file_name().and_then(|n| n.to_str()), Some("a____b.zip"), "nom de fichier sûr");
}
