//! Un GTFS statique sous forme compacte, pour estimer où sont les véhicules d'un réseau urbain.
//!
//! Les GTFS des grands réseaux pèsent des dizaines à des centaines de Mo décompressés
//! (`stop_times.txt` de Nantes : 400 Mo). `gtfs-structures` les chargerait en entier en mémoire,
//! pour des mois de circulations dont on ne veut que celles d'hier soir, d'aujourd'hui et de demain.
//! On lit donc le zip en flux, fichier par fichier, et on ne retient que :
//! - les courses des services actifs ces trois jours (hier : seulement celles qui passent minuit) ;
//! - les arrêts et les tracés (`shapes.txt`) que ces courses utilisent.
//!
//! Compaction : les courses qui desservent les mêmes arrêts, avec le même tracé, partagent un
//! *motif* (arrêts, rang, distance de chaque arrêt le long du tracé). Il ne reste à chaque course
//! que son identifiant, son motif et ses heures, en secondes depuis son premier arrêt sur 16 bits
//! (deux par arrêt : arrivée et départ). Soit environ 4 octets par passage à un arrêt.
//!
//! Le tracé d'un motif vient de `shapes.txt` (les arrêts y sont projetés dans l'ordre) ; faute de
//! tracé, ou si les arrêts n'en sont pas proches, c'est la ligne droite d'un arrêt au suivant.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;

use crate::transit::{RouteInfo, parse_routes};

/// Au-delà, le réseau est trop gros : on se limite à ses tramways et métros (voir `Limits`).
pub const MAX_TRIPS: usize = 120_000;
/// Un arrêt plus loin que cela (m) du tracé : ce n'est pas le bon tracé, on passe en ligne droite.
const MAX_STOP_TO_SHAPE_M: f64 = 300.0;
/// Un arrêt plus proche que cela (m) du tracé est « sur » le tracé : la recherche s'arrête dès qu'on l'a dépassé.
const ON_SHAPE_M: f64 = 40.0;
const NO_HEADSIGN: u32 = u32::MAX;
/// Écart (m) toléré entre un tracé et sa version simplifiée.
const SHAPE_TOLERANCE_M: f64 = 4.0;

pub struct Stop {
    /// Identifiant GTFS : le temps réel s'y réfère.
    pub id: Box<str>,
    pub name: Box<str>,
    pub lon: f64,
    pub lat: f64,
}

/// Un tracé : points et distance cumulée depuis le début (mètres).
pub struct Shape {
    lon: Vec<f32>,
    lat: Vec<f32>,
    dist: Vec<f32>,
}

/// Arrêts desservis dans l'ordre, par un tracé.
pub struct Pattern {
    pub shape: u32,
    pub stop: Box<[u32]>,
    /// `stop_sequence` de chaque arrêt : le temps réel s'y réfère parfois.
    pub seq: Box<[u32]>,
    /// Distance de chaque arrêt le long du tracé (mètres).
    pub dist: Box<[f32]>,
}

pub struct Trip {
    pub id: Box<str>,
    pub route: u32,
    pub pattern: u32,
    pub headsign: u32,
    /// Heure du premier arrêt, en secondes depuis le début du jour de service.
    pub start: i32,
    /// Heure d'arrivée au dernier arrêt, idem.
    pub end: i32,
    /// Bit 0 : hier ; bit 1 : aujourd'hui ; bit 2 : demain.
    pub days: u8,
    /// Position dans `Schedule::times` (deux valeurs par arrêt : arrivée et départ, en secondes après `start`).
    times: u32,
}

pub struct Schedule {
    /// Jour local (dans le fuseau du réseau) pour lequel il a été construit.
    pub built_for: Date,
    pub tz: TimeZone,
    /// Début des jours de service d'hier, d'aujourd'hui et de demain (secondes UTC).
    pub day_starts: [i64; 3],
    pub dates: [Date; 3],
    pub stops: Vec<Stop>,
    pub routes: Vec<RouteInfo>,
    pub route_ids: Vec<Box<str>>,
    pub headsigns: Vec<Box<str>>,
    pub shapes: Vec<Shape>,
    pub patterns: Vec<Pattern>,
    pub trips: Vec<Trip>,
    times: Vec<u16>,
    /// Vrai quand on s'est limité aux tramways et métros parce que le réseau était trop gros.
    pub guided_only: bool,
}

/// Une position le long d'un tracé.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShapePoint {
    pub lon: f64,
    pub lat: f64,
    /// Cap en degrés (0 = nord).
    pub bearing: f64,
}

impl Shape {
    fn from_points(points: &[(f64, f64)]) -> Self {
        let mut shape = Shape { lon: Vec::with_capacity(points.len()), lat: Vec::with_capacity(points.len()), dist: Vec::with_capacity(points.len()) };
        let mut total = 0.0f64;
        for (i, &(lon, lat)) in points.iter().enumerate() {
            if i > 0 {
                total += meters(points[i - 1], (lon, lat));
            }
            shape.lon.push(lon as f32);
            shape.lat.push(lat as f32);
            shape.dist.push(total as f32);
        }
        shape
    }

    pub fn length(&self) -> f32 {
        self.dist.last().copied().unwrap_or(0.0)
    }

    /// Le point situé à `d` mètres du début (borné aux extrémités), et le cap du segment où il tombe.
    pub fn point_at(&self, d: f32) -> ShapePoint {
        let last = self.dist.len() - 1;
        let d = d.clamp(0.0, self.length());
        // Premier point dont la distance dépasse `d` : le segment est (i - 1, i).
        let i = self.dist.partition_point(|x| *x <= d).clamp(1, last.max(1));
        let (a, b) = (i - 1, i.min(last));
        let (pa, pb) = ((f64::from(self.lon[a]), f64::from(self.lat[a])), (f64::from(self.lon[b]), f64::from(self.lat[b])));
        let span = f64::from(self.dist[b] - self.dist[a]);
        let t = if span > 0.0 { (f64::from(d - self.dist[a]) / span).clamp(0.0, 1.0) } else { 0.0 };
        ShapePoint { lon: pa.0 + (pb.0 - pa.0) * t, lat: pa.1 + (pb.1 - pa.1) * t, bearing: bearing(pa, pb) }
    }
}

/// Distance approchée en mètres (plan local) : exacte à mieux que 0,5 % à l'échelle d'une ville.
fn meters(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = local_offset(a, b);
    dx.hypot(dy)
}

/// Écart (est, nord) en mètres de `a` à `b`.
fn local_offset(a: (f64, f64), b: (f64, f64)) -> (f64, f64) {
    let kx = 111_320.0 * ((a.1 + b.1) / 2.0).to_radians().cos();
    ((b.0 - a.0) * kx, (b.1 - a.1) * 110_540.0)
}

fn bearing(a: (f64, f64), b: (f64, f64)) -> f64 {
    let (dx, dy) = local_offset(a, b);
    if dx == 0.0 && dy == 0.0 {
        return 0.0;
    }
    dx.atan2(dy).to_degrees().rem_euclid(360.0)
}

/// Douglas-Peucker : retire les points qui s'écartent de moins de `tolerance_m` de la ligne qui les entoure. Les tracés des
/// GTFS ont un point tous les 2 à 5 mètres ; à l'échelle d'un véhicule de 10 mètres cela ne se voit pas, et la mémoire
/// (surtout pour les réseaux interurbains) est divisée par trois à cinq.
fn simplify(points: &[(f64, f64)], tolerance_m: f64) -> Vec<(f64, f64)> {
    let n = points.len();
    if n < 3 {
        return points.to_vec();
    }
    let xy: Vec<(f64, f64)> = points.iter().map(|p| local_offset(points[0], *p)).collect();
    let mut keep = vec![false; n];
    (keep[0], keep[n - 1]) = (true, true);
    let mut pending = vec![(0usize, n - 1)];
    while let Some((a, b)) = pending.pop() {
        let (dx, dy) = (xy[b].0 - xy[a].0, xy[b].1 - xy[a].1);
        let len2 = dx * dx + dy * dy;
        let mut farthest = (0.0, a);
        for (i, p) in xy.iter().enumerate().take(b).skip(a + 1) {
            let (px, py) = (p.0 - xy[a].0, p.1 - xy[a].1);
            let t = if len2 > 0.0 { ((px * dx + py * dy) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let off = (px - dx * t).hypot(py - dy * t);
            if off > farthest.0 {
                farthest = (off, i);
            }
        }
        if farthest.0 > tolerance_m {
            keep[farthest.1] = true;
            pending.push((a, farthest.1));
            pending.push((farthest.1, b));
        }
    }
    points.iter().zip(&keep).filter(|(_, k)| **k).map(|(p, _)| *p).collect()
}

/// Distance le long de `shape` de chaque arrêt, dans l'ordre (jamais en arrière). `None` si un arrêt est loin du tracé.
fn project_stops(shape: &Shape, stops: &[(f64, f64)]) -> Option<Vec<f32>> {
    let n = shape.dist.len();
    if n < 2 {
        return None;
    }
    let mut out = Vec::with_capacity(stops.len());
    let (mut from, mut previous) = (0usize, 0.0f32);
    for &stop in stops {
        // (distance au tracé, segment, distance le long du tracé)
        let mut best: Option<(f64, usize, f32)> = None;
        for seg in from..n - 1 {
            let a = (f64::from(shape.lon[seg]), f64::from(shape.lat[seg]));
            let b = (f64::from(shape.lon[seg + 1]), f64::from(shape.lat[seg + 1]));
            let (bx, by) = local_offset(a, b);
            let (px, py) = local_offset(a, stop);
            let len2 = bx * bx + by * by;
            let t = if len2 > 0.0 { ((px * bx + py * by) / len2).clamp(0.0, 1.0) } else { 0.0 };
            let off = (px - bx * t).hypot(py - by * t);
            let along = shape.dist[seg] + (t * len2.sqrt()) as f32;
            if best.is_none_or(|(d, ..)| off < d) {
                best = Some((off, seg, along));
            }
            // Un arrêt « sur » le tracé est le premier endroit où l'on passe à côté : on ne cherche pas plus loin
            // (un tracé qui repasse près du même arrêt, en boucle, ne doit pas le lui voler).
            if let Some((d, _, at)) = best
                && d < ON_SHAPE_M
                && shape.dist[seg + 1] - at > 300.0
            {
                break;
            }
        }
        let (off, seg, along) = best?;
        if off > MAX_STOP_TO_SHAPE_M {
            return None;
        }
        let along = along.max(previous);
        out.push(along);
        previous = along;
        from = seg;
    }
    Some(out)
}

impl Schedule {
    /// Heures théoriques (secondes depuis le début du jour de service) d'arrivée et de départ à l'arrêt `i`.
    pub fn times_of(&self, trip: &Trip, i: usize) -> (i32, i32) {
        let at = trip.times as usize + 2 * i;
        (trip.start + i32::from(self.times[at]), trip.start + i32::from(self.times[at + 1]))
    }

    /// Mémoire occupée, approximativement (octets).
    pub fn approx_bytes(&self) -> usize {
        use std::mem::size_of;
        let trips: usize = self.trips.iter().map(|t| size_of::<Trip>() + t.id.len()).sum();
        let patterns: usize = self.patterns.iter().map(|p| size_of::<Pattern>() + p.stop.len() * 12).sum();
        let shapes: usize = self.shapes.iter().map(|s| size_of::<Shape>() + s.dist.len() * 12).sum();
        let stops: usize = self.stops.iter().map(|s| size_of::<Stop>() + s.id.len() + s.name.len()).sum();
        let strings: usize = self.headsigns.iter().chain(&self.route_ids).map(|s| 16 + s.len()).sum();
        trips + self.times.len() * 2 + patterns + shapes + stops + strings + self.routes.len() * size_of::<RouteInfo>() * 2
    }

    /// Nombre de points de tracé gardés (pour mesurer la simplification).
    pub fn shape_points(&self) -> usize {
        self.shapes.iter().map(|s| s.dist.len()).sum()
    }

    pub fn trip_count(&self) -> usize {
        self.trips.len()
    }
}

// ───────────────────────── Lecture du zip ─────────────────────────

struct Zip {
    archive: zip::ZipArchive<BufReader<File>>,
    /// Nom du fichier (sans dossier) → rang dans le zip.
    index: HashMap<String, usize>,
}

impl Zip {
    fn open(path: &Path) -> Result<Self> {
        let archive = zip::ZipArchive::new(BufReader::with_capacity(1 << 20, File::open(path).with_context(|| format!("ouverture de {}", path.display()))?)).context("zip illisible")?;
        let index = archive.file_names().enumerate().map(|(i, name)| (name.rsplit('/').next().unwrap_or(name).to_string(), i)).collect();
        Ok(Self { archive, index })
    }

    /// Lit un fichier du zip en CSV ; `None` s'il n'y est pas.
    fn csv<T>(&mut self, name: &str, read: impl FnOnce(csv::Reader<&mut dyn Read>) -> Result<T>) -> Result<Option<T>> {
        let Some(&i) = self.index.get(name) else { return Ok(None) };
        let mut file = self.archive.by_index(i).with_context(|| format!("{name} illisible"))?;
        let reader = csv::ReaderBuilder::new().flexible(true).from_reader(&mut file as &mut dyn Read);
        read(reader).with_context(|| format!("lecture de {name}")).map(Some)
    }

    fn text(&mut self, name: &str) -> Result<Option<String>> {
        let Some(&i) = self.index.get(name) else { return Ok(None) };
        let mut text = Vec::new();
        self.archive.by_index(i)?.take(8 << 20).read_to_end(&mut text)?;
        Ok(Some(String::from_utf8_lossy(&text).into_owned()))
    }
}

fn column(headers: &csv::ByteRecord, name: &str) -> Option<usize> {
    headers.iter().position(|h| h.trim_ascii() == name.as_bytes())
}

fn required(headers: &csv::ByteRecord, file: &str, name: &str) -> Result<usize> {
    column(headers, name).with_context(|| format!("colonne {name} absente de {file}"))
}

fn field(record: &csv::ByteRecord, column: Option<usize>) -> &[u8] {
    column.and_then(|c| record.get(c)).map_or(&[][..], <[u8]>::trim_ascii)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn number(bytes: &[u8]) -> Option<i32> {
    if bytes.is_empty() || bytes.len() > 9 {
        return None;
    }
    bytes.iter().try_fold(0i32, |n, c| c.is_ascii_digit().then(|| n * 10 + i32::from(c - b'0')))
}

/// « 25:03:00 » → secondes depuis minuit (les horaires GTFS dépassent 24 h pour les courses de nuit).
pub fn parse_time(bytes: &[u8]) -> Option<i32> {
    let mut parts = bytes.trim_ascii().split(|c| *c == b':');
    let hours = number(parts.next()?)?;
    let minutes = number(parts.next()?)?;
    let seconds = parts.next().map_or(Some(0), number)?;
    (minutes < 60 && seconds < 60).then_some(hours * 3600 + minutes * 60 + seconds)
}

fn ymd(date: Date) -> i32 {
    i32::from(date.year()) * 10_000 + i32::from(date.month()) * 100 + i32::from(date.day())
}

/// Début du jour de service : midi moins douze heures (la norme GTFS, qui évite les erreurs des jours de changement d'heure).
fn service_day_start(date: Date, tz: &TimeZone) -> Result<i64> {
    Ok(date.at(12, 0, 0, 0).to_zoned(tz.clone())?.timestamp().as_second() - 12 * 3600)
}

/// Fuseau du réseau : celui de sa première agence (les outre-mer n'ont pas l'heure de Paris).
fn network_zone(zip: &mut Zip) -> TimeZone {
    let name = zip
        .csv("agency.txt", |mut reader| {
            let headers = reader.byte_headers()?.clone();
            let column = column(&headers, "agency_timezone");
            Ok(match reader.byte_records().next() {
                Some(record) => text(field(&record?, column)),
                None => String::new(),
            })
        })
        .ok()
        .flatten()
        .unwrap_or_default();
    TimeZone::get(&name).or_else(|_| TimeZone::get("Europe/Paris")).unwrap_or(TimeZone::UTC)
}

/// Services actifs hier, aujourd'hui et demain : service → bits (voir `Trip::days`).
fn active_services(zip: &mut Zip, dates: [Date; 3]) -> Result<HashMap<String, u8>> {
    let mut services: HashMap<String, u8> = HashMap::new();
    let wanted: [i32; 3] = dates.map(ymd);
    zip.csv("calendar.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let id = required(&headers, "calendar.txt", "service_id")?;
        let days: Vec<usize> = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].iter().map(|d| required(&headers, "calendar.txt", d)).collect::<Result<_>>()?;
        let (start, end) = (required(&headers, "calendar.txt", "start_date")?, required(&headers, "calendar.txt", "end_date")?);
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let (Some(start), Some(end)) = (number(field(&record, Some(start))), number(field(&record, Some(end)))) else { continue };
            let mut bits = 0u8;
            for (bit, date) in dates.iter().enumerate() {
                let weekday = usize::try_from(date.weekday().to_monday_zero_offset()).unwrap_or(0);
                if (start..=end).contains(&wanted[bit]) && field(&record, Some(days[weekday])) == b"1" {
                    bits |= 1 << bit;
                }
            }
            if bits != 0 {
                *services.entry(text(field(&record, Some(id)))).or_default() |= bits;
            }
        }
        Ok(())
    })?;
    zip.csv("calendar_dates.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let (id, date, kind) = (required(&headers, "calendar_dates.txt", "service_id")?, required(&headers, "calendar_dates.txt", "date")?, required(&headers, "calendar_dates.txt", "exception_type")?);
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let Some(day) = number(field(&record, Some(date))) else { continue };
            let Some(bit) = wanted.iter().position(|w| *w == day) else { continue };
            let service = text(field(&record, Some(id)));
            match field(&record, Some(kind)) {
                b"1" => *services.entry(service).or_default() |= 1 << bit,
                b"2" => {
                    if let Some(bits) = services.get_mut(&service) {
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

/// Une course en cours de lecture.
struct RawTrip {
    id: Box<str>,
    route: u32,
    days: u8,
    headsign: Option<String>,
    shape: Option<Vec<u8>>,
}

/// Un passage à un arrêt : (course, rang, arrêt, arrivée, départ) ; une heure manquante vaut `MISSING`.
type Row = (u32, u32, u32, i32, i32);
const MISSING: i32 = i32::MIN;
/// Un point d'un tracé en cours de lecture : (rang, longitude, latitude).
type ShapeVertex = (u32, f32, f32);
/// Ce qui distingue un motif : (tracé, arrêts, rang des arrêts).
type PatternKey = (Option<u32>, Vec<u32>, Vec<u32>);

/// Construit le modèle compact d'un GTFS (zip sur disque) pour les trois jours autour de l'instant `now` (secondes UTC).
/// `guided_only` : ne garder que les tramways, métros, trains et câbles (réseau trop gros).
pub fn build(path: &Path, now: i64, guided_only: bool) -> Result<Schedule> {
    let keep = |info: &RouteInfo| !guided_only || matches!(info.mode, Some("tram" | "metro" | "train" | "cable"));
    let mut schedule = build_with(path, now, &keep, (!guided_only).then_some(MAX_TRIPS))?;
    schedule.guided_only = guided_only;
    Ok(schedule)
}

/// Comme `build`, avec le choix des lignes gardées (`keep`) et un plafond de courses facultatif (`max_trips` : au-delà,
/// l'erreur « trop de courses »).
pub fn build_with(path: &Path, now: i64, keep: &dyn Fn(&RouteInfo) -> bool, max_trips: Option<usize>) -> Result<Schedule> {
    let mut zip = Zip::open(path)?;
    let tz = network_zone(&mut zip);
    let today = Timestamp::from_second(now)?.to_zoned(tz.clone()).date();
    let dates = [today.yesterday()?, today, today.tomorrow()?];
    let day_starts = [service_day_start(dates[0], &tz)?, service_day_start(dates[1], &tz)?, service_day_start(dates[2], &tz)?];
    let services = active_services(&mut zip, dates)?;
    if services.is_empty() {
        bail!("aucun service actif hier, aujourd'hui ou demain (GTFS périmé ?)");
    }

    // Lignes.
    let routes_text = zip.text("routes.txt")?.context("routes.txt absent")?;
    let route_table = parse_routes(&routes_text);
    let mut routes = Vec::new();
    let mut route_ids: Vec<Box<str>> = Vec::new();
    let mut route_index: HashMap<String, u32> = HashMap::new();
    for (id, info) in route_table {
        if !keep(&info) {
            continue;
        }
        route_index.insert(id.clone(), routes.len() as u32);
        route_ids.push(id.into());
        routes.push(info);
    }

    // Courses des services actifs.
    let mut raw_trips: Vec<RawTrip> = Vec::new();
    let mut trip_index: HashMap<Box<[u8]>, u32> = HashMap::new();
    let too_many = zip
        .csv("trips.txt", |mut reader| {
            let headers = reader.byte_headers()?.clone();
            let (route, service, id) = (required(&headers, "trips.txt", "route_id")?, required(&headers, "trips.txt", "service_id")?, required(&headers, "trips.txt", "trip_id")?);
            let (headsign, shape) = (column(&headers, "trip_headsign"), column(&headers, "shape_id"));
            let mut record = csv::ByteRecord::new();
            while reader.read_byte_record(&mut record)? {
                let Some(&days) = std::str::from_utf8(field(&record, Some(service))).ok().and_then(|s| services.get(s)) else { continue };
                let Some(&route) = std::str::from_utf8(field(&record, Some(route))).ok().and_then(|r| route_index.get(r)) else { continue };
                if max_trips.is_some_and(|max| raw_trips.len() >= max) {
                    return Ok(true);
                }
                let id_bytes = field(&record, Some(id));
                let shape = Some(field(&record, shape)).filter(|s| !s.is_empty()).map(<[u8]>::to_vec);
                let headsign = Some(text(field(&record, headsign))).filter(|s| !s.is_empty());
                trip_index.insert(id_bytes.into(), raw_trips.len() as u32);
                raw_trips.push(RawTrip { id: text(id_bytes).into(), route, days, headsign, shape });
            }
            Ok(false)
        })?
        .context("trips.txt absent")?;
    if too_many {
        bail!("trop de courses");
    }

    // Passages aux arrêts des seules courses retenues.
    let mut stop_index: HashMap<Box<[u8]>, u32> = HashMap::new();
    let mut stop_order: Vec<Box<[u8]>> = Vec::new();
    let mut rows: Vec<Row> = Vec::new();
    zip.csv("stop_times.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let (trip, stop, seq) = (required(&headers, "stop_times.txt", "trip_id")?, required(&headers, "stop_times.txt", "stop_id")?, required(&headers, "stop_times.txt", "stop_sequence")?);
        let (arrival, departure) = (required(&headers, "stop_times.txt", "arrival_time")?, required(&headers, "stop_times.txt", "departure_time")?);
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let Some(&trip) = trip_index.get(field(&record, Some(trip))) else { continue };
            let stop_bytes = field(&record, Some(stop));
            let stop = *stop_index.entry(stop_bytes.into()).or_insert_with(|| {
                stop_order.push(stop_bytes.into());
                (stop_order.len() - 1) as u32
            });
            let seq = number(field(&record, Some(seq))).unwrap_or(0) as u32;
            let (arrival, departure) = (parse_time(field(&record, Some(arrival))).unwrap_or(MISSING), parse_time(field(&record, Some(departure))).unwrap_or(MISSING));
            rows.push((trip, seq, stop, arrival, departure));
        }
        Ok(())
    })?
    .context("stop_times.txt absent")?;
    rows.sort_unstable_by_key(|r| (r.0, r.1));

    // Arrêts utilisés.
    let mut stops: Vec<Stop> = stop_order.iter().map(|id| Stop { id: text(id).into(), name: "".into(), lon: f64::NAN, lat: f64::NAN }).collect();
    zip.csv("stops.txt", |mut reader| {
        let headers = reader.byte_headers()?.clone();
        let (id, lat, lon) = (required(&headers, "stops.txt", "stop_id")?, required(&headers, "stops.txt", "stop_lat")?, required(&headers, "stops.txt", "stop_lon")?);
        let name = column(&headers, "stop_name");
        let mut record = csv::ByteRecord::new();
        while reader.read_byte_record(&mut record)? {
            let Some(&i) = stop_index.get(field(&record, Some(id))) else { continue };
            let parse = |bytes: &[u8]| std::str::from_utf8(bytes).ok().and_then(|s| s.parse::<f64>().ok());
            if let (Some(lat), Some(lon)) = (parse(field(&record, Some(lat))), parse(field(&record, Some(lon)))) {
                let stop = &mut stops[i as usize];
                (stop.lat, stop.lon, stop.name) = (lat, lon, text(field(&record, name)).into());
            }
        }
        Ok(())
    })?
    .context("stops.txt absent")?;

    // Heures complètes et croissantes de chaque course ; celles qu'on ne sait pas lire sont écartées.
    struct Built {
        raw: u32,
        rows: std::ops::Range<usize>,
        times: Vec<(i32, i32)>,
    }
    let mut built: Vec<Built> = Vec::new();
    let mut at = 0;
    while at < rows.len() {
        let raw = rows[at].0;
        let end = at + rows[at..].iter().take_while(|r| r.0 == raw).count();
        if let Some(times) = complete_times(&rows[at..end]).filter(|_| rows[at..end].len() >= 2 && rows[at..end].iter().all(|r| stops[r.2 as usize].lat.is_finite())) {
            built.push(Built { raw, rows: at..end, times });
        }
        at = end;
    }

    // Tracés des courses restantes.
    // Points de chaque tracé voulu : (rang, longitude, latitude).
    let mut wanted_shapes: HashMap<Box<[u8]>, Vec<ShapeVertex>> = HashMap::new();
    for b in &built {
        if let Some(shape) = &raw_trips[b.raw as usize].shape {
            wanted_shapes.entry(shape.as_slice().into()).or_default();
        }
    }
    if !wanted_shapes.is_empty() {
        zip.csv("shapes.txt", |mut reader| {
            let headers = reader.byte_headers()?.clone();
            let (id, lat, lon, seq) = (required(&headers, "shapes.txt", "shape_id")?, required(&headers, "shapes.txt", "shape_pt_lat")?, required(&headers, "shapes.txt", "shape_pt_lon")?, required(&headers, "shapes.txt", "shape_pt_sequence")?);
            let mut record = csv::ByteRecord::new();
            while reader.read_byte_record(&mut record)? {
                let Some(points) = wanted_shapes.get_mut(field(&record, Some(id))) else { continue };
                let parse = |bytes: &[u8]| std::str::from_utf8(bytes).ok().and_then(|s| s.parse::<f32>().ok());
                if let (Some(lat), Some(lon), Some(seq)) = (parse(field(&record, Some(lat))), parse(field(&record, Some(lon))), number(field(&record, Some(seq)))) {
                    points.push((seq as u32, lon, lat));
                }
            }
            Ok(())
        })?;
    }
    let mut shape_by_id: HashMap<Box<[u8]>, u32> = HashMap::new();
    let mut shapes: Vec<Shape> = Vec::new();
    for (id, mut points) in wanted_shapes {
        if points.len() < 2 {
            continue;
        }
        points.sort_unstable_by_key(|p| p.0);
        let line: Vec<(f64, f64)> = points.iter().map(|p| (f64::from(p.1), f64::from(p.2))).collect();
        shape_by_id.insert(id, shapes.len() as u32);
        shapes.push(Shape::from_points(&simplify(&line, SHAPE_TOLERANCE_M)));
    }

    // Motifs et courses.
    let mut headsign_index: HashMap<String, u32> = HashMap::new();
    let mut headsigns: Vec<Box<str>> = Vec::new();
    let mut pattern_index: HashMap<PatternKey, u32> = HashMap::new();
    let mut patterns: Vec<Pattern> = Vec::new();
    let mut trips: Vec<Trip> = Vec::with_capacity(built.len());
    let mut times: Vec<u16> = Vec::new();
    for b in &built {
        let raw = &raw_trips[b.raw as usize];
        let (start, end) = (b.times[0].0, b.times[b.times.len() - 1].0);
        // Hier ne compte que si la course passe minuit.
        let mut days = raw.days;
        if i64::from(end) + day_starts[0] <= day_starts[1] {
            days &= !1;
        }
        if days == 0 || end - start > i32::from(u16::MAX) {
            continue;
        }
        let rows = &rows[b.rows.clone()];
        let shape = raw.shape.as_deref().and_then(|s| shape_by_id.get(s)).copied();
        let key = (shape, rows.iter().map(|r| r.2).collect::<Vec<_>>(), rows.iter().map(|r| r.1).collect::<Vec<_>>());
        let pattern = match pattern_index.get(&key) {
            Some(&p) => p,
            None => {
                let coords: Vec<(f64, f64)> = rows.iter().map(|r| (stops[r.2 as usize].lon, stops[r.2 as usize].lat)).collect();
                let projected = shape.and_then(|s| project_stops(&shapes[s as usize], &coords).map(|d| (s, d)));
                let (shape_id, dist) = projected.unwrap_or_else(|| {
                    // Pas de tracé (ou un tracé qui ne passe pas par les arrêts) : la ligne droite d'un arrêt au suivant.
                    let line = Shape::from_points(&coords);
                    let dist = line.dist.clone();
                    shapes.push(line);
                    ((shapes.len() - 1) as u32, dist)
                });
                patterns.push(Pattern { shape: shape_id, stop: key.1.clone().into(), seq: key.2.clone().into(), dist: dist.into() });
                pattern_index.insert(key, (patterns.len() - 1) as u32);
                (patterns.len() - 1) as u32
            }
        };
        let headsign = raw.headsign.as_ref().map_or(NO_HEADSIGN, |h| {
            *headsign_index.entry(h.clone()).or_insert_with(|| {
                headsigns.push(h.as_str().into());
                (headsigns.len() - 1) as u32
            })
        });
        let offset = times.len() as u32;
        for &(arrival, departure) in &b.times {
            times.push((arrival - start) as u16);
            times.push((departure - start) as u16);
        }
        trips.push(Trip { id: raw.id.clone(), route: raw.route, pattern, headsign, start, end, days, times: offset });
    }

    // Seuls les arrêts desservis sont gardés, renumérotés.
    let mut used = vec![u32::MAX; stops.len()];
    let mut kept_stops: Vec<Stop> = Vec::new();
    for pattern in &mut patterns {
        for stop in pattern.stop.iter_mut() {
            if used[*stop as usize] == u32::MAX {
                used[*stop as usize] = kept_stops.len() as u32;
                kept_stops.push(Stop { id: stops[*stop as usize].id.clone(), name: stops[*stop as usize].name.clone(), lon: stops[*stop as usize].lon, lat: stops[*stop as usize].lat });
            }
            *stop = used[*stop as usize];
        }
    }
    trips.shrink_to_fit();
    times.shrink_to_fit();
    patterns.shrink_to_fit();
    shapes.shrink_to_fit();

    Ok(Schedule { built_for: today, tz, day_starts, dates, stops: kept_stops, routes, route_ids, headsigns, shapes, patterns, trips, times, guided_only: false })
}

/// Arrivée et départ à chaque arrêt, complets et croissants : une heure absente (arrêt non horodaté) est interpolée
/// entre ses voisines ; une course dont les extrémités n'ont pas d'heure est écartée.
fn complete_times(rows: &[Row]) -> Option<Vec<(i32, i32)>> {
    let mut times: Vec<(i32, i32)> = rows
        .iter()
        .map(|r| match (r.3, r.4) {
            (MISSING, d) => (d, d),
            (a, MISSING) => (a, a),
            (a, d) => (a, d),
        })
        .collect();
    let known = |t: &(i32, i32)| t.0 != MISSING;
    let mut i = 0;
    while i < times.len() {
        if known(&times[i]) {
            i += 1;
            continue;
        }
        let before = i.checked_sub(1).filter(|p| known(&times[*p]))?;
        let after = (i..times.len()).find(|q| known(&times[*q]))?;
        let (from, to) = (times[before].1, times[after].0);
        let span = (after - before) as i32;
        for (k, slot) in times.iter_mut().enumerate().take(after).skip(i) {
            let t = from + (to - from) * (k - before) as i32 / span;
            *slot = (t, t);
        }
        i = after;
    }
    // Un véhicule n'arrive pas avant d'être parti de l'arrêt précédent.
    let mut previous = times[0].1.max(times[0].0);
    times[0] = (times[0].0.min(previous), previous);
    for time in times.iter_mut().skip(1) {
        let arrival = time.0.max(previous);
        let departure = time.1.max(arrival);
        *time = (arrival, departure);
        previous = departure;
    }
    previous = times[0].0;
    (previous >= 0).then_some(times)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn heures_gtfs() {
        assert_eq!(parse_time(b"07:01:30"), Some(25_290));
        assert_eq!(parse_time(b" 25:03:00 "), Some(90_180), "les courses de nuit dépassent 24 h");
        assert_eq!(parse_time(b"7:05"), Some(25_500));
        assert_eq!(parse_time(b""), None);
        assert_eq!(parse_time(b"12:99:00"), None);
    }

    #[test]
    fn heures_manquantes_interpolees() {
        let row = |stop: u32, a: i32, d: i32| (0u32, stop, stop, a, d);
        let rows = [row(1, MISSING, 3600), row(2, MISSING, MISSING), row(3, MISSING, MISSING), row(4, 4800, 4860), row(5, 4800, 5000)];
        let times = complete_times(&rows).unwrap();
        assert_eq!(times[0], (3600, 3600));
        assert_eq!(times[1], (3600 + 1200 / 3, 3600 + 1200 / 3), "interpolé entre le départ de 1 et l'arrivée de 4");
        assert_eq!(times[2].0, 3600 + 2 * 1200 / 3);
        assert_eq!(times[3], (4800, 4860));
        assert_eq!(times[4], (4860, 5000), "arrivée ramenée au départ précédent : jamais en arrière");
        assert!(complete_times(&[row(1, MISSING, MISSING), row(2, 100, 100)]).is_none(), "première heure inconnue : course écartée");
    }

    #[test]
    fn point_sur_un_trace() {
        // Un angle droit : 1 km vers l'est puis 1 km vers le nord (à peu près), vers Toulouse.
        let (lon0, lat0): (f64, f64) = (1.4, 43.6);
        let east = lon0 + 1000.0 / (111_320.0 * lat0.to_radians().cos());
        let north = lat0 + 1000.0 / 110_540.0;
        let shape = Shape::from_points(&[(lon0, lat0), (east, lat0), (east, north)]);
        assert!((shape.length() - 2000.0).abs() < 5.0, "{}", shape.length());
        let start = shape.point_at(0.0);
        assert!((start.lon - lon0).abs() < 1e-6 && (start.bearing - 90.0).abs() < 0.5);
        let middle = shape.point_at(1500.0);
        assert!((middle.lon - east).abs() < 1e-5 && (middle.lat - (lat0 + 500.0 / 110_540.0)).abs() < 1e-4, "{middle:?}");
        assert!(middle.bearing < 1.0 || middle.bearing > 359.0, "vers le nord : {}", middle.bearing);
        let beyond = shape.point_at(99_999.0);
        assert!((beyond.lat - north).abs() < 1e-6, "borné à la fin du tracé");
    }

    #[test]
    fn la_simplification_garde_les_virages_et_pas_les_points_alignes() {
        // 1 km vers l'est avec un point tous les 5 m (et un écart de 1 m de bruit), puis 1 km vers le nord.
        let kx = 111_320.0 * 43.6f64.to_radians().cos();
        let mut line: Vec<(f64, f64)> = (0..=200).map(|i| (1.4 + f64::from(i) * 5.0 / kx, 43.6 + if i % 2 == 0 { 1.0 } else { 0.0 } / 110_540.0)).collect();
        let corner = *line.last().unwrap();
        line.extend((1..=200).map(|i| (corner.0, corner.1 + f64::from(i) * 5.0 / 110_540.0)));
        let simple = simplify(&line, 4.0);
        assert_eq!(simple.len(), 3, "début, virage, fin : {simple:?}");
        assert_eq!((simple[0], simple[1], simple[2]), (line[0], corner, *line.last().unwrap()));
        // Un tracé qui revient sur ses pas (terminus en cul-de-sac) garde sa pointe.
        let spur = [(1.4, 43.6), (1.401, 43.6), (1.4, 43.6)];
        assert_eq!(simplify(&spur, 4.0).len(), 3);
        assert_eq!(simplify(&spur[..2], 4.0).len(), 2);
    }

    #[test]
    fn arrets_projetes_dans_l_ordre_meme_en_boucle() {
        // Un aller-retour sur la même rue : l'arrêt de départ et celui d'arrivée sont au même endroit.
        let step = 0.001;
        let line: Vec<(f64, f64)> = (0..=10).map(|i| (1.4 + f64::from(i) * step, 43.6)).chain((0..=10).rev().skip(1).map(|i| (1.4 + f64::from(i) * step, 43.6))).collect();
        let shape = Shape::from_points(&line);
        let stops = [(1.4, 43.6), (1.405, 43.6001), (1.41, 43.6), (1.405, 43.6001), (1.4, 43.6)];
        let d = project_stops(&shape, &stops).unwrap();
        assert!(d.windows(2).all(|w| w[0] <= w[1]), "jamais en arrière : {d:?}");
        assert!(d[1] < d[2] && d[2] <= d[3] && d[3] < d[4], "l'aller puis le retour : {d:?}");
        assert!(d[4] > shape.length() * 0.95, "le dernier arrêt est au bout du retour : {d:?}");
        // Un arrêt à 2 km du tracé : ce n'est pas le bon tracé.
        assert!(project_stops(&shape, &[(1.4, 43.6), (1.405, 43.62)]).is_none());
    }

    #[test]
    fn construit_le_modele_compact_d_un_extrait_reel_de_tisseo() {
        let zip = fixture::tisseo_zip_with("compact", &[]);
        let now = fixture::paris("2026-11-10T22:30:00");
        let schedule = build(&zip.0, now, false).unwrap();
        assert_eq!(schedule.built_for.to_string(), "2026-11-10");
        assert_eq!(schedule.dates.map(|d| d.to_string()), ["2026-11-09", "2026-11-10", "2026-11-11"]);
        assert_eq!(schedule.trip_count(), 2);
        assert_eq!(schedule.shapes.len(), 2, "un tracé par ligne : les arrêts sont sur le tracé, pas de ligne droite de secours");

        let tram = schedule.trips.iter().find(|t| &*t.id == "2294719").unwrap();
        assert_eq!((tram.start, tram.end), (22 * 3600 + 26 * 60, 23 * 3600 + 9 * 60));
        assert_eq!(tram.days, 0b011 & !1, "hier : écarté, la course finit avant minuit");
        assert_eq!(&*schedule.headsigns[tram.headsign as usize], "Palais de Justice");
        assert_eq!(schedule.routes[tram.route as usize].short.as_deref(), Some("T1"));
        assert_eq!(schedule.routes[tram.route as usize].mode, Some("tram"));
        assert_eq!(schedule.times_of(tram, 1), (22 * 3600 + 27 * 60, 22 * 3600 + 27 * 60));

        // La course de nuit passe minuit : hier compte.
        let night = schedule.trips.iter().find(|t| &*t.id == "2294605").unwrap();
        assert_eq!(night.days, 0b011);
        assert_eq!(night.end, 25 * 3600 + 21 * 60);
        // Les distances des arrêts le long du tracé suivent celles du GTFS (`shape_dist_traveled`), à quelques pourcents près.
        let pattern = &schedule.patterns[night.pattern as usize];
        assert_eq!(pattern.stop.len(), 24);
        assert!(pattern.dist.windows(2).all(|w| w[0] <= w[1]));
        let total = f64::from(pattern.dist[23]);
        assert!((total - 13_790.0).abs() < 13_790.0 * 0.04, "{total}");
        assert_eq!(&*schedule.stops[pattern.stop[0] as usize].id, "stop_point:SP_1889");
        assert!(schedule.approx_bytes() > 2_000 && schedule.shape_points() < 530, "{} octets, {} points", schedule.approx_bytes(), schedule.shape_points());
    }

    #[test]
    fn les_courses_au_meme_motif_partagent_leurs_arrets() {
        // Une troisième course identique à la première, dix minutes plus tard.
        let extra: Vec<(String, String)> = {
            let stop_times: String = fixture::STOP_TIMES.lines().filter(|l| l.starts_with("2294719,")).map(|l| shift_trip(l, "9999999", 600)).collect::<Vec<_>>().join("\n");
            vec![
                ("stop_times.txt".into(), format!("{}\n{stop_times}\n", fixture::STOP_TIMES.trim_end())),
                ("trips.txt".into(), format!("{}line:68,1585082,9999999,1,Palais de Justice,15527\n", fixture::TRIPS)),
            ]
        };
        let zip = fixture::tisseo_zip_with("partage", &extra);
        let schedule = build(&zip.0, fixture::paris("2026-11-10T22:30:00"), false).unwrap();
        assert_eq!(schedule.trip_count(), 3);
        assert_eq!(schedule.patterns.len(), 2, "deux motifs pour trois courses");
        let a = schedule.trips.iter().find(|t| &*t.id == "2294719").unwrap();
        let b = schedule.trips.iter().find(|t| &*t.id == "9999999").unwrap();
        assert_eq!(a.pattern, b.pattern);
        assert_eq!(b.start - a.start, 600);
    }

    /// Décale d'`secs` les heures d'une ligne de `stop_times.txt` et change son identifiant de course.
    fn shift_trip(line: &str, new_id: &str, secs: i32) -> String {
        let mut fields: Vec<String> = line.split(',').map(str::to_string).collect();
        fields[0] = new_id.to_string();
        for i in [1, 2] {
            let t = parse_time(fields[i].as_bytes()).unwrap() + secs;
            fields[i] = format!("{:02}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60);
        }
        fields.join(",")
    }

    #[test]
    fn un_gtfs_sans_service_ce_jour_est_refuse() {
        let zip = fixture::tisseo_zip_with("perime", &[]);
        let error = build(&zip.0, fixture::paris("2027-03-01T12:00:00"), false).err().unwrap();
        assert!(format!("{error:#}").contains("aucun service actif"), "{error:#}");
    }

    #[test]
    fn sans_trace_les_arrets_sont_relies_en_ligne_droite() {
        let trips_without_shape = fixture::TRIPS.replace("15527", "").replace("15524", "");
        let zip = fixture::tisseo_zip_with("droite", &[("trips.txt".into(), trips_without_shape)]);
        let schedule = build(&zip.0, fixture::paris("2026-11-10T22:30:00"), false).unwrap();
        let tram = schedule.trips.iter().find(|t| &*t.id == "2294719").unwrap();
        let pattern = &schedule.patterns[tram.pattern as usize];
        let shape = &schedule.shapes[pattern.shape as usize];
        assert_eq!(shape.dist.len(), 25, "un point par arrêt");
        let first = &schedule.stops[pattern.stop[0] as usize];
        let at_start = shape.point_at(0.0);
        assert!((at_start.lon - first.lon).abs() < 1e-5 && (at_start.lat - first.lat).abs() < 1e-5);
        assert!((pattern.dist[24] - shape.length()).abs() < 1.0, "le dernier arrêt est au bout");
    }

    /// Extraits réels du GTFS Tisséo du 9 novembre 2026 : deux courses de la ligne T1 (une de jour, une de nuit qui passe minuit), leur tracé
    /// (un point sur trois), leurs arrêts et leurs jours de circulation.
    pub(crate) mod fixture {
        use std::io::Write;
        use std::path::PathBuf;

        pub const TRIPS: &str = include_str!("fixtures/tisseo/trips.txt");
        pub const STOP_TIMES: &str = include_str!("fixtures/tisseo/stop_times.txt");
        /// Le temps réel du même jour : une annonce (circulation 2294605, au dernier arrêt).
        pub const TRIP_UPDATES: &[u8] = include_bytes!("fixtures/tisseo/tisseo-trip-updates.pb");

        /// Fichier temporaire effacé à la fin du test.
        pub struct TempZip(pub PathBuf);

        impl Drop for TempZip {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }

        /// Le zip de l'extrait, dont on peut remplacer des fichiers (nom, contenu).
        pub fn tisseo_zip_with(name: &str, replace: &[(String, String)]) -> TempZip {
            let mut files: Vec<(String, String)> = vec![
                ("agency.txt".into(), include_str!("fixtures/tisseo/agency.txt").into()),
                ("calendar_dates.txt".into(), include_str!("fixtures/tisseo/calendar_dates.txt").into()),
                ("routes.txt".into(), include_str!("fixtures/tisseo/routes.txt").into()),
                ("shapes.txt".into(), include_str!("fixtures/tisseo/shapes.txt").into()),
                ("stop_times.txt".into(), STOP_TIMES.into()),
                ("stops.txt".into(), include_str!("fixtures/tisseo/stops.txt").into()),
                ("trips.txt".into(), TRIPS.into()),
            ];
            for (file, content) in replace {
                files.retain(|(n, _)| n != file);
                files.push((file.clone(), content.clone()));
            }
            let path = std::env::temp_dir().join(format!("carte-vivante-test-{}-{name}.zip", std::process::id()));
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            for (file, content) in files {
                // Les vrais GTFS sont parfois dans un dossier : on s'en assure pour un fichier.
                let stored = if file == "routes.txt" { format!("gtfs/{file}") } else { file };
                writer.start_file(stored, zip::write::SimpleFileOptions::default()).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
            TempZip(path)
        }

        /// Un instant en heure de Paris (« 2026-11-10T22:30:00 »), en secondes UTC.
        pub fn paris(local: &str) -> i64 {
            local.parse::<jiff::civil::DateTime>().unwrap().to_zoned(jiff::tz::TimeZone::get("Europe/Paris").unwrap()).unwrap().timestamp().as_second()
        }
    }
}
