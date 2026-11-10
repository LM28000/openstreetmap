//! Lecture en flux d'un GTFS (zip sur disque) en un `RawFeed` : les seules circulations utiles.
//!
//! Un GTFS régional ou celui d'Île-de-France pèse des centaines de Mo décompressés : on ne le charge jamais
//! en entier. Le zip est lu fichier par fichier, ligne par ligne (même méthode que `gtfs_compact.rs`), et on ne garde que :
//! - les lignes (`routes.txt`) que `FeedSpec::classify` accepte (c'est là que se décide « métro », « car interurbain »…) ;
//! - les circulations de ces lignes dont le calendrier tombe dans la fenêtre de jours voulue ;
//! - leurs passages aux arrêts (`stop_times.txt`), puis les arrêts qu'elles desservent (`stops.txt`).

use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};
use jiff::civil::Date;

use super::{Kind, Line, RawFeed, RawStop, RawTrip};
use crate::gtfs_compact::{Zip, column, field, number, parse_time, required, text, ymd};
use crate::raptor::Call;

/// Une ligne telle que `routes.txt` la donne.
pub struct RouteRow {
    pub short: String,
    pub long: String,
    pub desc: String,
    /// Valeur brute de `route_type` (types étendus compris : 200 = car, 700 = bus…).
    pub route_type: i32,
    pub color: Option<String>,
    pub text_color: Option<String>,
}

pub struct FeedSpec<'a> {
    pub name: &'a str,
    /// Premier jour gardé, et nombre de jours (8 au plus).
    pub first_day: Date,
    pub days: u8,
    /// Décide si une ligne est gardée, et comment on l'affiche.
    pub classify: &'a dyn Fn(&RouteRow) -> Option<Line>,
    /// Remplacer chaque arrêt par sa zone d'arrêt (`parent_station`) : les quais d'une même station n'en font qu'une.
    pub use_parent: bool,
    /// Ne garder que les circulations interurbaines (voir `is_interurban`).
    pub interurban_only: bool,
    /// Ne garder que les passages aux arrêts dont l'identifiant est accepté (le GTFS de la SNCF mêle trains et cars :
    /// la catégorie est dans l'identifiant du quai, « StopPoint:OCECar TER-87471003 »).
    pub keep_stop: Option<&'a dyn Fn(&[u8]) -> bool>,
    pub match_by_name: bool,
}

/// Un passage à un arrêt en cours de lecture : (circulation, rang, arrêt, arrivée, départ, service voulu ?).
type Row = (u32, u32, u32, i32, i32);
const MISSING: i32 = i32::MIN;

/// Jours (parmi ceux de la fenêtre, en bits) où chaque service circule.
fn service_masks(zip: &mut Zip, dates: &[Date]) -> Result<HashMap<Box<[u8]>, u8>> {
    let mut services: HashMap<Box<[u8]>, u8> = HashMap::new();
    let wanted: Vec<i32> = dates.iter().map(|d| ymd(*d)).collect();
    zip.csv("calendar.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let id = required(&headers, "calendar.txt", "service_id")?;
        let weekdays: Vec<usize> = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
            .iter()
            .map(|d| required(&headers, "calendar.txt", d))
            .collect::<Result<_>>()?;
        let (start, end) = (required(&headers, "calendar.txt", "start_date")?, required(&headers, "calendar.txt", "end_date")?);
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let (Some(start), Some(end)) = (number(field(&record, Some(start))), number(field(&record, Some(end)))) else { continue };
            let mut bits = 0u8;
            for (bit, date) in dates.iter().enumerate() {
                let weekday = usize::try_from(date.weekday().to_monday_zero_offset()).unwrap_or(0);
                if (start..=end).contains(&wanted[bit]) && field(&record, Some(weekdays[weekday])) == b"1" {
                    bits |= 1 << bit;
                }
            }
            if bits != 0 {
                *services.entry(field(&record, Some(id)).into()).or_default() |= bits;
            }
        }
        Ok(())
    })?;
    zip.csv("calendar_dates.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let id = required(&headers, "calendar_dates.txt", "service_id")?;
        let date = required(&headers, "calendar_dates.txt", "date")?;
        let kind = required(&headers, "calendar_dates.txt", "exception_type")?;
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let Some(day) = number(field(&record, Some(date))) else { continue };
            let Some(bit) = wanted.iter().position(|w| *w == day) else { continue };
            match field(&record, Some(kind)) {
                b"1" => *services.entry(field(&record, Some(id)).into()).or_default() |= 1 << bit,
                b"2" => {
                    if let Some(bits) = services.get_mut(field(&record, Some(id))) {
                        *bits &= !(1 << bit);
                    }
                }
                _ => {}
            }
        }
        Ok(())
    })?;
    services.retain(|_, bits| *bits != 0);
    Ok(services)
}

/// Lit le GTFS `path` (voir l'en-tête du module).
pub fn read(path: &Path, spec: &FeedSpec) -> Result<RawFeed> {
    let mut zip = Zip::open(path)?;
    let dates: Vec<Date> = (0..spec.days.min(8))
        .map(|d| spec.first_day.checked_add(jiff::Span::new().days(i64::from(d))).context("date hors limites"))
        .collect::<Result<_>>()?;
    let masks = service_masks(&mut zip, &dates)?;
    let mut feed = RawFeed::new(spec.name, spec.first_day);
    feed.match_by_name = spec.match_by_name;
    if masks.is_empty() {
        return Ok(feed); // aucun service dans la fenêtre : GTFS périmé ou jours sans circulation
    }

    // 1. Les lignes gardées.
    let mut route_line: HashMap<Box<[u8]>, u32> = HashMap::new();
    zip.csv("routes.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let id = required(&headers, "routes.txt", "route_id")?;
        let (short, long, desc) = (column(&headers, "route_short_name"), column(&headers, "route_long_name"), column(&headers, "route_desc"));
        let (kind, color, text_color) = (column(&headers, "route_type"), column(&headers, "route_color"), column(&headers, "route_text_color"));
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let hex = |c: Option<usize>| Some(text(field(&record, c))).filter(|h| h.len() == 6 && h.chars().all(|c| c.is_ascii_hexdigit()));
            let row = RouteRow {
                short: text(field(&record, short)),
                long: text(field(&record, long)),
                desc: text(field(&record, desc)),
                route_type: number(field(&record, kind)).unwrap_or(-1),
                color: hex(color),
                text_color: hex(text_color),
            };
            if let Some(line) = (spec.classify)(&row) {
                route_line.insert(field(&record, Some(id)).into(), feed.lines.len() as u32);
                feed.lines.push(line);
            }
        }
        Ok(())
    })?
    .context("routes.txt absent")?;

    // 2. Les circulations des lignes gardées qui roulent dans la fenêtre. Calendriers identiques = un seul `services`.
    struct Pending {
        line: u32,
        service: u32,
        headsign: u32,
    }
    let mut pending: Vec<Pending> = Vec::new();
    let mut trip_index: HashMap<Box<[u8]>, u32> = HashMap::new();
    let mut service_of_mask: HashMap<u8, u32> = HashMap::new();
    let mut headsign_index: HashMap<Vec<u8>, u32> = HashMap::new();
    zip.csv("trips.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let (route, service, id) = (required(&headers, "trips.txt", "route_id")?, required(&headers, "trips.txt", "service_id")?, required(&headers, "trips.txt", "trip_id")?);
        let headsign = column(&headers, "trip_headsign");
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let Some(&line) = route_line.get(field(&record, Some(route))) else { continue };
            let Some(&mask) = masks.get(field(&record, Some(service))) else { continue };
            let service = *service_of_mask.entry(mask).or_insert_with(|| {
                let days: Vec<u16> = (0..dates.len() as u16).filter(|bit| mask & (1 << bit) != 0).collect();
                feed.services.push(days);
                (feed.services.len() - 1) as u32
            });
            let sign = field(&record, headsign);
            let headsign = if sign.is_empty() {
                u32::MAX
            } else {
                *headsign_index.entry(sign.to_vec()).or_insert_with(|| {
                    feed.headsigns.push(text(sign).into());
                    (feed.headsigns.len() - 1) as u32
                })
            };
            trip_index.insert(field(&record, Some(id)).into(), pending.len() as u32);
            pending.push(Pending { line, service, headsign });
        }
        Ok(())
    })?
    .context("trips.txt absent")?;

    // 3. Leurs passages aux arrêts.
    let mut stop_index: HashMap<Box<[u8]>, u32> = HashMap::new();
    let mut stop_order: Vec<Box<[u8]>> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();
    // Circulations « à la demande » : (arrêts sur réservation, arrêts en tout).
    let mut on_demand: HashMap<u32, (u32, u32)> = HashMap::new();
    zip.csv("stop_times.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let (trip, stop, seq) = (required(&headers, "stop_times.txt", "trip_id")?, required(&headers, "stop_times.txt", "stop_id")?, required(&headers, "stop_times.txt", "stop_sequence")?);
        let (arrival, departure) = (required(&headers, "stop_times.txt", "arrival_time")?, required(&headers, "stop_times.txt", "departure_time")?);
        let (pickup, drop_off) = (column(&headers, "pickup_type"), column(&headers, "drop_off_type"));
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let Some(&trip) = trip_index.get(field(&record, Some(trip))) else { continue };
            if spec.keep_stop.is_some_and(|keep| !keep(field(&record, Some(stop)))) {
                continue;
            }
            let (pickup, drop_off) = (field(&record, pickup), field(&record, drop_off));
            let seq = number(field(&record, Some(seq))).unwrap_or(0) as u32;
            // Ni montée ni descente : le car passe sans s'arrêter.
            if pickup == b"1" && drop_off == b"1" {
                continue;
            }
            let entry = on_demand.entry(trip).or_default();
            entry.1 += 1;
            if pickup == b"2" || pickup == b"3" {
                entry.0 += 1;
            }
            let stop_bytes = field(&record, Some(stop));
            let stop = *stop_index.entry(stop_bytes.into()).or_insert_with(|| {
                stop_order.push(stop_bytes.into());
                (stop_order.len() - 1) as u32
            });
            let (arrival, departure) = (parse_time(field(&record, Some(arrival))).unwrap_or(MISSING), parse_time(field(&record, Some(departure))).unwrap_or(MISSING));
            rows.push((trip, seq, stop, arrival, departure));
        }
        Ok(())
    })?
    .context("stop_times.txt absent")?;
    rows.sort_unstable_by_key(|r| (r.0, r.1));

    // 4. Les arrêts desservis : nom, position, zone d'arrêt.
    struct StopRow {
        name: String,
        lat: f64,
        lon: f64,
        parent: Option<Box<[u8]>>,
        uic: Option<String>,
    }
    let mut stop_rows: HashMap<u32, StopRow> = HashMap::new();
    let mut wanted_parents: HashMap<Box<[u8]>, StopRow> = HashMap::new();
    for pass in 0..2 {
        // Passe 0 : les arrêts desservis (et leurs zones). Passe 1 : les zones, qui peuvent être n'importe où dans le fichier.
        if pass == 1 && (!spec.use_parent || wanted_parents.is_empty()) {
            break;
        }
        zip.csv("stops.txt", |mut reader| {
            let headers = reader.byte_headers()?.clone();
            let (id, lat, lon) = (required(&headers, "stops.txt", "stop_id")?, required(&headers, "stops.txt", "stop_lat")?, required(&headers, "stops.txt", "stop_lon")?);
            let (name, parent) = (column(&headers, "stop_name"), column(&headers, "parent_station"));
            let mut record = csv::ByteRecord::new();
            while reader.read_byte_record(&mut record)? {
                let id_bytes = field(&record, Some(id));
                let parse = |bytes: &[u8]| std::str::from_utf8(bytes).ok().and_then(|s| s.parse::<f64>().ok());
                let (Some(lat), Some(lon)) = (parse(field(&record, Some(lat))), parse(field(&record, Some(lon)))) else { continue };
                let row = || StopRow {
                    name: text(field(&record, name)),
                    lat,
                    lon,
                    parent: Some(field(&record, parent)).filter(|p| !p.is_empty()).map(Into::into),
                    // Le code UIC d'un arrêt SNCF : « StopArea:OCE87471003 » ou « StopPoint:OCECar TER-87471003 ».
                    uic: uic_of(id_bytes),
                };
                if pass == 0 {
                    if let Some(&i) = stop_index.get(id_bytes) {
                        let row = row();
                        if spec.use_parent && let Some(parent) = &row.parent {
                            wanted_parents.entry(parent.clone()).or_insert_with(|| StopRow { name: String::new(), lat: f64::NAN, lon: f64::NAN, parent: None, uic: None });
                        }
                        stop_rows.insert(i, row);
                    }
                } else if let Some(slot) = wanted_parents.get_mut(id_bytes) {
                    *slot = row();
                }
            }
            Ok(())
        })?
        .context("stops.txt absent")?;
    }

    // 5. Les circulations : heures complètes, arrêts de la source, filtres.
    // Arrêt de la source (ou de sa zone) → indice dans `feed.stops`.
    let mut feed_stop_of: HashMap<Box<[u8]>, u32> = HashMap::new();
    let mut stop_to_feed: Vec<Option<u32>> = vec![None; stop_order.len()];
    let mut at = 0;
    while at < rows.len() {
        let trip = rows[at].0;
        let end = at + rows[at..].iter().take_while(|r| r.0 == trip).count();
        let trip_rows = &rows[at..end];
        at = end;
        let (served, asked) = on_demand.get(&trip).copied().unwrap_or_default();
        if asked > 0 && served * 2 >= asked {
            continue; // « sur réservation » : pas un horaire sur lequel compter
        }
        let Some(times) = complete_times(trip_rows) else { continue };
        let pending = &pending[trip as usize];
        let kind = feed.lines[pending.line as usize].kind;

        // Les arrêts de cette circulation, dans la source.
        let mut calls: Vec<Call> = Vec::with_capacity(trip_rows.len());
        let mut complete = true;
        for (row, &(arrival, departure)) in trip_rows.iter().zip(&times) {
            let feed_stop = match stop_to_feed[row.2 as usize] {
                Some(s) => s,
                None => {
                    let Some(own) = stop_rows.get(&row.2) else {
                        complete = false;
                        break;
                    };
                    let (key, place): (&[u8], &StopRow) = match (&own.parent, spec.use_parent) {
                        (Some(parent), true) if wanted_parents.get(parent).is_some_and(|p| p.lat.is_finite()) => (parent, &wanted_parents[parent]),
                        _ => (&stop_order[row.2 as usize], own),
                    };
                    let index = *feed_stop_of.entry(key.into()).or_insert_with(|| {
                        feed.stops.push(RawStop {
                            name: place.name.clone(),
                            lon: place.lon,
                            lat: place.lat,
                            kind,
                            rail_code: place.uic.clone().or_else(|| own.uic.clone()),
                        });
                        (feed.stops.len() - 1) as u32
                    });
                    stop_to_feed[row.2 as usize] = Some(index);
                    index
                }
            };
            // Le genre d'un arrêt desservi par plusieurs genres de lignes : le plus lourd.
            let stop = &mut feed.stops[feed_stop as usize];
            if kind.rank() < stop.kind.rank() {
                stop.kind = kind;
            }
            calls.push(Call { stop: feed_stop, arrival, departure });
        }
        if !complete || calls.len() < 2 {
            continue;
        }
        if spec.interurban_only && !is_interurban(&calls, &feed.stops) {
            continue;
        }
        feed.trips.push(RawTrip { line: pending.line, service: pending.service, headsign: pending.headsign, calls: calls.into_boxed_slice() });
    }

    // Seules les lignes et arrêts utilisés comptent pour la mémoire : on rend ce qu'on a trop alloué.
    feed.stops.shrink_to_fit();
    feed.trips.shrink_to_fit();
    // Les circulations sans service utile ont déjà été écartées (calendrier vide) ; on retire les arrêts jamais desservis.
    Ok(prune_unused(feed))
}

/// Le code UIC (8 chiffres) que porte un identifiant d'arrêt de la SNCF, s'il y en a un.
fn uic_of(id: &[u8]) -> Option<String> {
    let id = std::str::from_utf8(id).ok()?;
    let digits = id.rsplit(['-', ':']).next()?.strip_prefix("OCE").unwrap_or(id.rsplit(['-', ':']).next()?);
    (digits.len() == 8 && digits.chars().all(|c| c.is_ascii_digit())).then(|| digits.to_string())
}

/// Retire les arrêts qu'aucune circulation gardée ne dessert, et renumérote.
fn prune_unused(mut feed: RawFeed) -> RawFeed {
    let mut used = vec![u32::MAX; feed.stops.len()];
    let mut kept: Vec<RawStop> = Vec::new();
    for trip in &mut feed.trips {
        for call in trip.calls.iter_mut() {
            let slot = &mut used[call.stop as usize];
            if *slot == u32::MAX {
                *slot = kept.len() as u32;
                kept.push(feed.stops[call.stop as usize].clone());
            }
            call.stop = *slot;
        }
    }
    feed.stops = kept;
    feed
}

/// Arrivée et départ à chaque arrêt, complets et croissants. Un arrêt sans heure est interpolé entre ses voisins ;
/// une circulation dont les extrémités n'ont pas d'heure, ou qui remonte le temps, est écartée.
fn complete_times(rows: &[Row]) -> Option<Vec<(i32, i32)>> {
    if rows.len() < 2 {
        return None;
    }
    let mut times: Vec<(i32, i32)> = rows
        .iter()
        .map(|r| match (r.3, r.4) {
            (MISSING, d) => (d, d),
            (a, MISSING) => (a, a),
            (a, d) => (a, d.max(a)),
        })
        .collect();
    let known: Vec<usize> = (0..times.len()).filter(|&i| times[i].0 != MISSING).collect();
    if known.first() != Some(&0) || known.last() != Some(&(times.len() - 1)) {
        return None;
    }
    for pair in known.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        for i in a + 1..b {
            let t = times[a].1 + (times[b].0 - times[a].1) * (i - a) as i32 / (b - a) as i32;
            times[i] = (t, t);
        }
    }
    let mut previous = i32::MIN;
    for (arrival, departure) in &mut times {
        // Une heure qui recule d'une minute ou deux (arrondis) est ramenée à la précédente ; plus, c'est une erreur.
        if *arrival < previous {
            if previous - *arrival > 600 {
                return None;
            }
            *arrival = previous;
            *departure = (*departure).max(previous);
        }
        previous = *departure;
    }
    Some(times)
}

/// Une circulation « interurbaine » : de quoi écarter les lignes urbaines que les jeux de données interurbains contiennent.
/// - **au moins 8 km** à vol d'oiseau entre le premier et le dernier arrêt (un bus urbain tourne dans la ville) ;
/// - arrêts espacés d'**au moins 500 m en moyenne** (un bus urbain s'arrête tous les 300 à 400 m).
pub(crate) fn is_interurban(calls: &[Call], stops: &[RawStop]) -> bool {
    let (Some(first), Some(last)) = (calls.first(), calls.last()) else { return false };
    let place = |c: &Call| (stops[c.stop as usize].lon, stops[c.stop as usize].lat);
    if super::meters(place(first), place(last)) < 8_000.0 {
        return false;
    }
    let path: f64 = calls.windows(2).map(|w| super::meters(place(&w[0]), place(&w[1]))).sum();
    path / (calls.len() - 1) as f64 >= 500.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_uic_des_identifiants_sncf() {
        assert_eq!(uic_of(b"StopArea:OCE87471003").as_deref(), Some("87471003"));
        assert_eq!(uic_of(b"StopPoint:OCECar TER-87471003").as_deref(), Some("87471003"));
        assert_eq!(uic_of(b"IDFM:monomodal:12345"), None);
        assert_eq!(uic_of(b"87471003").as_deref(), Some("87471003"));
    }

    fn row(trip: u32, seq: u32, arrival: i32, departure: i32) -> Row {
        (trip, seq, seq, arrival, departure)
    }

    #[test]
    fn heures_manquantes_interpolees_et_retours_en_arriere_refuses() {
        let rows = [row(0, 0, 100, 100), row(0, 1, MISSING, MISSING), row(0, 2, 300, 310)];
        assert_eq!(complete_times(&rows), Some(vec![(100, 100), (200, 200), (300, 310)]));
        // Sans heure au premier arrêt : écartée.
        assert_eq!(complete_times(&[row(0, 0, MISSING, MISSING), row(0, 1, 5, 5)]), None);
        // Une heure qui recule de plus de dix minutes : écartée ; de quelques secondes : ramenée.
        assert_eq!(complete_times(&[row(0, 0, 5000, 5000), row(0, 1, 100, 100)]), None);
        assert_eq!(complete_times(&[row(0, 0, 100, 100), row(0, 1, 90, 90)]), Some(vec![(100, 100), (100, 100)]));
    }

    fn stop(lon: f64, lat: f64) -> RawStop {
        RawStop { name: String::new(), lon, lat, kind: Kind::Coach, rail_code: None }
    }

    #[test]
    fn interurbain_selon_la_distance_et_l_espacement() {
        let call = |stop: u32| Call { stop, arrival: 0, departure: 0 };
        // Une ligne de 20 km à 5 arrêts (4 km d'écart) : interurbaine.
        let long: Vec<RawStop> = (0..5).map(|i| stop(1.0 + f64::from(i) * 0.05, 48.0)).collect();
        assert!(is_interurban(&(0..5).map(call).collect::<Vec<_>>(), &long));
        // Une ligne de 3 km : trop courte, urbaine.
        let short: Vec<RawStop> = (0..5).map(|i| stop(1.0 + f64::from(i) * 0.01, 48.0)).collect();
        assert!(!is_interurban(&(0..5).map(call).collect::<Vec<_>>(), &short));
        // 10 km mais un arrêt tous les 200 m : urbaine.
        let dense: Vec<RawStop> = (0..50).map(|i| stop(1.0 + f64::from(i) * 0.0027, 48.0)).collect();
        assert!(!is_interurban(&(0..50).map(call).collect::<Vec<_>>(), &dense));
    }
}
