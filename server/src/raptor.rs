//! Isochrones ferroviaires : « jusqu'où peut-on aller en train depuis cette gare, en partant à telle heure ? ».
//!
//! # L'algorithme : RAPTOR
//!
//! RAPTOR (Round-bAsed Public Transit Optimized Router, Delling, Pajor et Werneck, 2012)
//! répond à « quelle est l'arrivée la plus tôt à chaque gare ? » sans construire de graphe
//! d'événements ni dérouler un Dijkstra. L'idée tient en trois points.
//!
//! 1. **Les lignes (« routes »).** Les circulations qui desservent exactement la même suite
//!    de gares forment une ligne. Sur une ligne, on ne se pose qu'une question : « quel est
//!    le premier train que je peux prendre à cette gare ? ». Les trains d'une ligne sont
//!    rangés par heure de départ, et ne se doublent jamais (sinon on scinde la ligne), si
//!    bien qu'une recherche dichotomique suffit, et que le premier train catchable est aussi
//!    celui qui arrive le plus tôt partout ailleurs.
//! 2. **Les tours.** Le tour `k` calcule les meilleures arrivées en utilisant **au plus `k`
//!    trains**. Pour passer du tour `k-1` au tour `k`, on prend chaque gare dont l'arrivée
//!    vient de s'améliorer au tour précédent, on remonte dans chaque ligne qui y passe (au
//!    premier train possible), et on le suit jusqu'au terminus en notant, à chaque gare,
//!    l'arrivée si elle bat toutes les précédentes. Puis on propage les correspondances à
//!    pied. Quand un tour n'améliore plus rien (ou que le nombre de correspondances voulu est
//!    atteint), c'est fini. Le nombre de trains pris est donc un résultat gratuit, pas un
//!    coût à pénaliser.
//! 3. **Un seul passage sur chaque ligne et chaque tour.** On ne scanne chaque ligne qu'à
//!    partir de sa première gare « marquée » (améliorée au tour précédent) : tout ce qui
//!    précède ne peut pas servir. Au total le coût est borné par (tours × taille du réseau),
//!    de l'ordre de quelques millisecondes pour toute la France.
//!
//! Pour reconstituer l'itinéraire de chaque gare, chaque amélioration garde une étiquette :
//! « arrivé par le train X, monté à la gare Y » ou « arrivé à pied depuis Y ». On remonte
//! ensuite ces étiquettes tour par tour.
//!
//! # Correspondances (le modèle choisi)
//!
//! - **Gares = zones d'arrêt** (`parent_station` du GTFS) : tous les quais d'une gare ne font
//!   qu'une seule gare.
//! - **Correspondance dans la même gare** : 8 minutes minimum entre l'arrivée d'un train et
//!   le départ du suivant (`MIN_CHANGE`). Le `transfers.txt` de la SNCF est vide : ce délai
//!   est donc fixe. L'origine n'a pas ce délai (on est déjà sur le quai).
//! - **Correspondance à pied** entre gares voisines (moins de `WALK_RADIUS_M` à vol d'oiseau) :
//!   3 minutes de marge, plus la distance × 1,3 (détour des rues) à 4,5 km/h. Elle est
//!   unique (on ne chaîne pas deux marches).
//! - **Les gares parisiennes** sont reliées par le métro et le RER, absents de cet horaire :
//!   temps fixes de 20 à 45 minutes de porte à porte, marges comprises (`PARIS_TRANSFERS`).
//!   Nord ↔ Est, voisines, est la plus courte. Même chose entre Lyon Part-Dieu et Perrache
//!   (métro A).
//!
//! # Temps réel
//!
//! Si l'heure de départ est proche de maintenant (de 2 h avant à 6 h après), les retards et
//! suppressions du flux GTFS-RT sont appliqués aux circulations. Un train en retard peut ainsi
//! être pris même si son horaire théorique est passé, et un train supprimé est ignoré. Les
//! arrêts supprimés d'un train maintenu ne sont pas pris en compte (rare). Plus loin dans le
//! temps, ou dans le passé, on utilise l'horaire théorique : le flux n'en dit rien d'utile.

use std::collections::HashMap;

use jiff::Span;
use jiff::civil::Date;

use crate::realtime::Realtime;
use crate::timetable::{Run, Station, Timetable, Trip};

/// Valeur « pas encore atteint ».
const INF: i32 = i32::MAX;
/// Délai minimum entre l'arrivée d'un train et le départ de la correspondance dans la même gare (secondes).
pub const MIN_CHANGE: i32 = 8 * 60;
/// Deux gares plus proches que cela (à vol d'oiseau) sont reliées par une marche.
const WALK_RADIUS_M: f64 = 1200.0;
/// Marge d'une correspondance à pied (sortir, traverser, rentrer), en secondes.
const WALK_BUFFER: f64 = 180.0;
/// Les rues ne vont pas droit : la distance réelle est environ 30 % plus longue.
const WALK_DETOUR: f64 = 1.3;
/// 4,5 km/h.
const WALK_SPEED_MS: f64 = 1.25;
/// Plafond du nombre de trains pris quand le nombre de correspondances est « illimité ».
pub const MAX_ROUNDS: usize = 8;
/// Jours de service qui peuvent compter pour un départ donné : la veille (trains partis avant
/// minuit, dont l'horaire dépasse 24 h), le jour même et le lendemain.
const DAYS: usize = 3;
/// Un train en retard a un horaire théorique plus tôt que son horaire réel : on cherche
/// aussi parmi ceux dont l'horaire prévu était jusqu'à cette durée avant (secondes).
const REALTIME_LOOKBACK: i32 = 3 * 3600;
/// Le temps réel n'est utilisé que pour des départs dans cette fenêtre autour de maintenant (secondes).
const REALTIME_BEFORE: i64 = 2 * 3600;
const REALTIME_AFTER: i64 = 6 * 3600;

/// Terminus parisiens et durées de correspondance entre eux (minutes, porte à porte).
/// Chaque terminus peut avoir plusieurs codes UIC (Montparnasse a un second quai, Vaugirard).
const PARIS_TERMINALS: &[(&str, &[&str])] = &[
    ("nord", &["87271007"]),
    ("est", &["87113001"]),
    ("lyon", &["87686006"]),
    ("bercy", &["87686667"]),
    ("austerlitz", &["87547000"]),
    ("montparnasse", &["87391003", "87391102"]),
    ("saint-lazare", &["87384008"]),
];
/// Durée entre deux terminus parisiens (minutes). Les paires absentes valent `PARIS_DEFAULT_MIN`.
const PARIS_TRANSFERS: &[(&str, &str, i32)] = &[
    ("nord", "est", 20),           // dix minutes à pied
    ("lyon", "bercy", 25),         // à pied ou ligne 14
    ("lyon", "austerlitz", 25),    // pont Charles-de-Gaulle, ou ligne 5
    ("austerlitz", "bercy", 30),
    ("est", "austerlitz", 35),     // ligne 5
    ("montparnasse", "austerlitz", 35), // ligne 6
    ("montparnasse", "bercy", 40), // ligne 6
    ("lyon", "saint-lazare", 35),  // ligne 14
    ("bercy", "saint-lazare", 35), // ligne 14
    ("montparnasse", "saint-lazare", 35), // ligne 12 ou 14
    ("nord", "saint-lazare", 35),  // RER E, ligne 12
    ("est", "saint-lazare", 35),   // RER E
    ("nord", "lyon", 40),          // RER D
];
const PARIS_DEFAULT_MIN: i32 = 45;
/// Correspondances à fixer à la main entre grandes gares d'une même ville (codes UIC, minutes).
const CITY_TRANSFERS: &[(&str, &str, i32)] = &[
    ("87723197", "87722025", 25), // Lyon Part-Dieu ↔ Lyon Perrache : métro A
];

/// Une marche (ou un métro) entre deux gares.
#[derive(Clone, Copy)]
struct Foot {
    to: u32,
    seconds: i32,
}

/// Une ligne : une suite de gares, et tous les trains qui la parcourent, du plus tôt au plus tard.
struct Route {
    /// Début des gares de la ligne dans `Raptor::stops`.
    stops: u32,
    /// Nombre de gares.
    len: u16,
    /// Début des horaires dans `Raptor::times` : (arrivée, départ) à chaque gare, train après train.
    times: u32,
    /// Début des circulations dans `Raptor::trips`, et leur nombre.
    trips: u32,
    trip_count: u32,
}

/// Index de recherche des horaires, construit une fois par version des horaires.
pub struct Raptor {
    routes: Vec<Route>,
    /// Gares de toutes les lignes, mises bout à bout.
    stops: Vec<u32>,
    /// Horaires (secondes depuis le début du jour de service), arrivée puis départ, train par train puis gare par gare.
    times: Vec<i32>,
    /// Indice dans `Timetable::trips` de chaque circulation de chaque ligne.
    trips: Vec<u32>,
    /// Pour chaque gare, les lignes qui y passent, et à quelle position : `stop_routes[stop_routes_from[s]..stop_routes_from[s + 1]]`.
    stop_routes_from: Vec<u32>,
    stop_routes: Vec<(u32, u16)>,
    /// Marches à partir de chaque gare, même rangement.
    foot_from: Vec<u32>,
    foot: Vec<Foot>,
}

impl Raptor {
    /// Groupe les trains en lignes et prépare les correspondances à pied.
    pub fn build(stations: &[Station], trips: &[Trip]) -> Self {
        // 1. Les trains qui desservent les mêmes gares dans le même ordre forment une famille.
        let mut families: HashMap<Vec<u32>, Vec<u32>> = HashMap::new();
        for (index, trip) in trips.iter().enumerate() {
            let sequence: Vec<u32> = trip.stops.iter().map(|s| s.station).collect();
            families.entry(sequence).or_default().push(index as u32);
        }
        // Ordre déterministe : les mêmes horaires donnent le même index.
        let mut families: Vec<(Vec<u32>, Vec<u32>)> = families.into_iter().collect();
        families.sort_unstable_by_key(|(_, members)| members[0]);

        let mut raptor = Raptor {
            routes: Vec::new(),
            stops: Vec::new(),
            times: Vec::new(),
            trips: Vec::new(),
            stop_routes_from: Vec::new(),
            stop_routes: Vec::new(),
            foot_from: Vec::new(),
            foot: Vec::new(),
        };

        // 2. Dans chaque famille, on range les trains par heure de départ, puis on les répartit en
        //    lignes où aucun train n'en double un autre (condition pour que « le premier train
        //    possible » soit aussi « le premier arrivé »).
        for (sequence, mut members) in families {
            members.sort_by_key(|&t| trips[t as usize].stops[0].departure);
            let mut lanes: Vec<Vec<u32>> = Vec::new();
            for trip in members {
                let lane = lanes.iter_mut().find(|lane| !overtakes(&trips[trip as usize], &trips[*lane.last().unwrap() as usize]));
                match lane {
                    Some(lane) => lane.push(trip),
                    None => lanes.push(vec![trip]),
                }
            }
            for lane in lanes {
                raptor.routes.push(Route {
                    stops: raptor.stops.len() as u32,
                    len: sequence.len() as u16,
                    times: raptor.times.len() as u32,
                    trips: raptor.trips.len() as u32,
                    trip_count: lane.len() as u32,
                });
                raptor.stops.extend(&sequence);
                for &t in &lane {
                    raptor.trips.push(t);
                    for stop in &trips[t as usize].stops {
                        raptor.times.push(stop.arrival);
                        raptor.times.push(stop.departure);
                    }
                }
            }
        }
        raptor.routes.shrink_to_fit();
        raptor.stops.shrink_to_fit();
        raptor.times.shrink_to_fit();
        raptor.trips.shrink_to_fit();

        // 3. Pour chaque gare, les lignes qui y passent (tableau « compressé par lignes »).
        let mut per_station: Vec<Vec<(u32, u16)>> = vec![Vec::new(); stations.len()];
        for (r, route) in raptor.routes.iter().enumerate() {
            for pos in 0..route.len {
                let station = raptor.stops[(route.stops + u32::from(pos)) as usize];
                per_station[station as usize].push((r as u32, pos));
            }
        }
        for list in &per_station {
            raptor.stop_routes_from.push(raptor.stop_routes.len() as u32);
            raptor.stop_routes.extend(list);
        }
        raptor.stop_routes_from.push(raptor.stop_routes.len() as u32);
        raptor.stop_routes.shrink_to_fit();

        // 4. Les marches.
        let mut feet: Vec<Vec<Foot>> = vec![Vec::new(); stations.len()];
        for (a, b, seconds) in walking_pairs(stations) {
            feet[a as usize].push(Foot { to: b, seconds });
            feet[b as usize].push(Foot { to: a, seconds });
        }
        for list in &feet {
            raptor.foot_from.push(raptor.foot.len() as u32);
            raptor.foot.extend(list);
        }
        raptor.foot_from.push(raptor.foot.len() as u32);
        raptor.foot.shrink_to_fit();
        raptor
    }

    /// Mémoire occupée par l'index (octets), pour les journaux.
    pub fn bytes(&self) -> usize {
        use std::mem::size_of;
        self.routes.capacity() * size_of::<Route>()
            + self.stops.capacity() * 4
            + self.times.capacity() * 4
            + self.trips.capacity() * 4
            + self.stop_routes_from.capacity() * 4
            + self.stop_routes.capacity() * size_of::<(u32, u16)>()
            + self.foot_from.capacity() * 4
            + self.foot.capacity() * size_of::<Foot>()
    }

    pub fn route_count(&self) -> usize {
        self.routes.len()
    }

    fn route_stops(&self, route: &Route) -> &[u32] {
        &self.stops[route.stops as usize..route.stops as usize + route.len as usize]
    }

    fn stop_routes_of(&self, station: u32) -> &[(u32, u16)] {
        let (from, to) = (self.stop_routes_from[station as usize], self.stop_routes_from[station as usize + 1]);
        &self.stop_routes[from as usize..to as usize]
    }

    fn foot_of(&self, station: u32) -> &[Foot] {
        let (from, to) = (self.foot_from[station as usize], self.foot_from[station as usize + 1]);
        &self.foot[from as usize..to as usize]
    }

    /// Arrivée (0) ou départ (1) prévus du train `trip` de la ligne à la position `pos`, en secondes depuis le début du jour de service.
    fn scheduled(&self, route: &Route, trip: u32, pos: u16, departure: bool) -> i32 {
        let index = route.times as usize + (trip as usize * route.len as usize + pos as usize) * 2 + usize::from(departure);
        self.times[index]
    }
}

/// `a` double-t-il `b` (qui part avant lui) : arrive-t-il avant lui à une gare, ou part-il avant lui ?
fn overtakes(a: &Trip, b: &Trip) -> bool {
    a.stops.iter().zip(&b.stops).any(|(x, y)| x.arrival < y.arrival || x.departure < y.departure)
}

/// Paires de gares reliées par une marche : (gare, gare, secondes).
fn walking_pairs(stations: &[Station]) -> Vec<(u32, u32, i32)> {
    let mut pairs: HashMap<(u32, u32), i32> = HashMap::new();

    // Gares proches : balayage par latitude croissante, pour ne comparer que les voisines.
    let mut by_lat: Vec<u32> = (0..stations.len() as u32).collect();
    by_lat.sort_by(|&a, &b| stations[a as usize].lat.total_cmp(&stations[b as usize].lat));
    let max_dlat = WALK_RADIUS_M / 111_000.0;
    for (i, &a) in by_lat.iter().enumerate() {
        let sa = &stations[a as usize];
        for &b in &by_lat[i + 1..] {
            let sb = &stations[b as usize];
            if sb.lat - sa.lat > max_dlat {
                break;
            }
            let meters = distance_m(sa, sb);
            if meters <= WALK_RADIUS_M {
                let seconds = (WALK_BUFFER + meters * WALK_DETOUR / WALK_SPEED_MS).round() as i32;
                // Jamais plus court qu'une correspondance dans la même gare.
                pairs.insert((a.min(b), a.max(b)), seconds.max(MIN_CHANGE));
            }
        }
    }

    // Les temps fixes (métro, RER) remplacent la marche : ils sont plus réalistes.
    let by_code: HashMap<&str, u32> = stations.iter().enumerate().map(|(i, s)| (s.code.as_str(), i as u32)).collect();
    let terminal_of = |code: &str| PARIS_TERMINALS.iter().position(|(_, codes)| codes.contains(&code));
    let paris: Vec<(usize, u32)> = stations.iter().enumerate().filter_map(|(i, s)| Some((terminal_of(&s.code)?, i as u32))).collect();
    for (x, &(ta, a)) in paris.iter().enumerate() {
        for &(tb, b) in &paris[x + 1..] {
            if ta == tb {
                continue; // deux quais d'un même terminus : la marche suffit
            }
            let (na, nb) = (PARIS_TERMINALS[ta].0, PARIS_TERMINALS[tb].0);
            let minutes = PARIS_TRANSFERS
                .iter()
                .find(|(p, q, _)| (*p == na && *q == nb) || (*p == nb && *q == na))
                .map_or(PARIS_DEFAULT_MIN, |t| t.2);
            pairs.insert((a.min(b), a.max(b)), minutes * 60);
        }
    }
    for &(ca, cb, minutes) in CITY_TRANSFERS {
        if let (Some(&a), Some(&b)) = (by_code.get(ca), by_code.get(cb)) {
            pairs.insert((a.min(b), a.max(b)), minutes * 60);
        }
    }
    let mut out: Vec<_> = pairs.into_iter().map(|((a, b), s)| (a, b, s)).collect();
    out.sort_unstable();
    out
}

/// Distance à vol d'oiseau en mètres (approximation plane, très suffisante à cette échelle).
fn distance_m(a: &Station, b: &Station) -> f64 {
    let dx = (a.lon - b.lon) * ((a.lat + b.lat) / 2.0).to_radians().cos() * 111_320.0;
    let dy = (a.lat - b.lat) * 110_540.0;
    dx.hypot(dy)
}

// ---------------------------------------------------------------------------------------------
// Requête
// ---------------------------------------------------------------------------------------------

pub struct Params {
    /// Indice de la gare de départ.
    pub origin: u32,
    /// Heure de départ (secondes UTC depuis 1970).
    pub depart: i64,
    /// Durée maximale du trajet (secondes).
    pub max_duration: i32,
    /// Nombre maximal de trains pris (correspondances + 1), au plus `MAX_ROUNDS`.
    pub max_trips: usize,
}

/// Comment on est arrivé à une gare à un tour donné.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Label {
    None,
    /// La gare de départ : on y est déjà, sans délai de correspondance.
    Origin,
    /// À pied (ou en métro) depuis une gare atteinte au même tour.
    Foot { from: u32 },
    /// En train : circulation `trip` (rang dans la ligne) de la ligne `route`, monté à la position
    /// `board`, descendu à `alight`, pendant le jour de service `day`.
    Transit { route: u32, trip: u32, day: u8, board: u16, alight: u16 },
}

/// Une étape d'un itinéraire.
#[derive(Debug, Clone, PartialEq)]
pub enum Leg {
    Train {
        /// Indice dans `Timetable::trips`.
        trip: u32,
        from: u32,
        to: u32,
        /// Heures de départ et d'arrivée (secondes UTC).
        departure: i64,
        arrival: i64,
        /// Nombre d'arrêts desservis entre les deux (extrémités comprises).
        stops: u16,
    },
    Walk {
        from: u32,
        to: u32,
        departure: i64,
        arrival: i64,
    },
}

/// Tout ce qu'il faut pour lire les horaires d'un jour de service : décalage, calendrier et temps réel.
struct Schedule<'a> {
    timetable: &'a Timetable,
    /// Début de chaque jour de service considéré, en secondes après l'heure de départ (négatif pour la veille).
    offsets: [i32; DAYS],
    /// Pour chaque service, les jours (parmi `DAYS`) où il circule, en bits.
    active: Vec<u8>,
    /// Horaires réels des circulations que le temps réel concerne (en secondes après l'heure de départ,
    /// arrivée puis départ à chaque gare), ou `None` si elles sont supprimées.
    live: HashMap<(u32, u8), Option<Vec<i32>>>,
}

impl Schedule<'_> {
    fn raptor(&self) -> &Raptor {
        &self.timetable.raptor
    }

    /// Heure (secondes après le départ) d'arrivée ou de départ de la circulation à la position `pos`.
    fn time(&self, route: &Route, trip: u32, day: u8, pos: u16, departure: bool) -> i32 {
        if !self.live.is_empty() {
            let id = self.raptor().trips[(route.trips + trip) as usize];
            if let Some(Some(times)) = self.live.get(&(id, day)) {
                return times[pos as usize * 2 + usize::from(departure)];
            }
        }
        self.offsets[day as usize] + self.raptor().scheduled(route, trip, pos, departure)
    }

    fn is_active(&self, route: &Route, trip: u32, day: u8) -> bool {
        let id = self.raptor().trips[(route.trips + trip) as usize];
        if self.active[self.timetable.trips[id as usize].service as usize] & (1 << day) == 0 {
            return false;
        }
        // Un train supprimé par le temps réel ne circule pas.
        !matches!(self.live.get(&(id, day)), Some(None))
    }

    /// Premier train de la ligne qu'on peut prendre à la position `pos` en y étant prêt à `ready` :
    /// (rang, jour de service, heure de départ).
    fn earliest_trip(&self, route: &Route, pos: u16, ready: i32) -> Option<(u32, u8, i32)> {
        // Avec le temps réel, un train dont l'horaire prévu est passé peut encore partir.
        let slack = if self.live.is_empty() { 0 } else { REALTIME_LOOKBACK };
        let mut best: Option<(u32, u8, i32)> = None;
        for day in 0..DAYS as u8 {
            let shift = self.offsets[day as usize];
            // Recherche dichotomique : les départs prévus à cette gare croissent avec le rang du train.
            let first = partition(route.trip_count, |trip| {
                self.raptor().scheduled(route, trip, pos, true).saturating_add(shift) < ready.saturating_sub(slack)
            });
            for trip in first..route.trip_count {
                let planned = shift + self.raptor().scheduled(route, trip, pos, true);
                if best.is_some_and(|(_, _, b)| planned > b) {
                    break; // les suivants partent plus tard que ce qu'on a déjà
                }
                if !self.is_active(route, trip, day) {
                    continue;
                }
                let actual = self.time(route, trip, day, pos, true);
                if actual >= ready && best.is_none_or(|(_, _, b)| actual < b) {
                    best = Some((trip, day, actual));
                    if slack == 0 {
                        break; // sans retards, le premier train catchable est le meilleur de ce jour
                    }
                }
            }
        }
        best
    }
}

/// Premier indice de `0..n` pour lequel `before` est faux (`before` doit être vrai puis faux).
fn partition(n: u32, before: impl Fn(u32) -> bool) -> u32 {
    let (mut lo, mut hi) = (0, n);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if before(mid) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Résultat d'une requête : les arrivées au plus tôt, et de quoi reconstituer chaque itinéraire.
pub struct Isochrone<'a> {
    schedule: Schedule<'a>,
    depart: i64,
    origin: u32,
    /// Meilleure arrivée à chaque gare (secondes après le départ), `INF` si inatteignable.
    best: Vec<i32>,
    /// Tour (nombre de trains) qui a fourni cette meilleure arrivée.
    best_round: Vec<u8>,
    /// Arrivées et étiquettes par tour : `arrival[k][s]` n'est renseigné que si le tour `k` a amélioré la gare `s`.
    arrival: Vec<Vec<i32>>,
    labels: Vec<Vec<Label>>,
    /// Le temps réel a-t-il été appliqué ?
    pub realtime: bool,
}

/// Une gare atteinte.
pub struct Reached {
    pub station: u32,
    /// Durée du trajet (secondes).
    pub seconds: i32,
    /// Nombre de correspondances (trains pris moins un).
    pub transfers: u8,
}

/// Calcule les arrivées au plus tôt depuis `params.origin`, avec RAPTOR.
pub fn isochrone<'a>(timetable: &'a Timetable, realtime: Option<&Realtime>, now: i64, params: &Params) -> Isochrone<'a> {
    let raptor = &timetable.raptor;
    let station_count = timetable.stations.len();
    let max_trips = params.max_trips.clamp(1, MAX_ROUNDS);
    let bound = params.max_duration;

    let use_realtime = realtime.is_some() && params.depart >= now - REALTIME_BEFORE && params.depart <= now + REALTIME_AFTER;
    let schedule = build_schedule(timetable, realtime.filter(|_| use_realtime), params.depart);

    let mut best = vec![INF; station_count];
    let mut best_round = vec![0u8; station_count];
    let mut arrival: Vec<Vec<i32>> = vec![vec![INF; station_count]; max_trips + 1];
    let mut labels: Vec<Vec<Label>> = vec![vec![Label::None; station_count]; max_trips + 1];

    // Tour 0 : on est à la gare de départ, à l'heure de départ, et on peut marcher.
    let origin = params.origin as usize;
    best[origin] = 0;
    arrival[0][origin] = 0;
    labels[0][origin] = Label::Origin;
    let mut marked = vec![params.origin];
    relax_feet(raptor, &mut best, &mut best_round, &mut arrival[0], &mut labels[0], 0, &[params.origin], &mut marked, bound);

    // Plus petite position marquée de chaque ligne ce tour-ci (`u16::MAX` : ligne non concernée).
    let mut earliest_pos = vec![u16::MAX; raptor.routes.len()];
    let mut touched_routes: Vec<u32> = Vec::new();

    for round in 1..=max_trips {
        // 1. Les lignes qui passent par une gare améliorée au tour précédent, et d'où les scanner.
        touched_routes.clear();
        for &station in &marked {
            for &(route, pos) in raptor.stop_routes_of(station) {
                let slot = &mut earliest_pos[route as usize];
                if *slot == u16::MAX {
                    touched_routes.push(route);
                }
                *slot = (*slot).min(pos);
            }
        }
        let mut improved: Vec<u32> = Vec::new();
        let (previous, current) = arrival.split_at_mut(round);
        let previous_arrival = &previous[round - 1];
        let current_arrival = &mut current[0];
        let (previous_labels, current_labels) = labels.split_at_mut(round);
        let previous_labels = &previous_labels[round - 1];
        let current_labels = &mut current_labels[0];

        // 2. On suit, sur chaque ligne, le train pris le plus tôt possible.
        for &r in &touched_routes {
            let route = &raptor.routes[r as usize];
            let first = std::mem::replace(&mut earliest_pos[r as usize], u16::MAX);
            let stops = raptor.route_stops(route);
            // Le train qu'on est en train de suivre : (rang, jour, position de montée).
            let mut riding: Option<(u32, u8, u16)> = None;

            for pos in first..route.len {
                let station = stops[pos as usize];

                // a. Si on est dans un train, on arrive ici à l'heure du train : est-ce un progrès ?
                if let Some((trip, day, board)) = riding {
                    let at = schedule.time(route, trip, day, pos, false);
                    if at < best[station as usize] && at <= bound {
                        best[station as usize] = at;
                        best_round[station as usize] = round as u8;
                        current_arrival[station as usize] = at;
                        current_labels[station as usize] = Label::Transit { route: r, trip, day, board, alight: pos };
                        improved.push(station);
                    }
                }

                // b. Si on était ici au tour précédent, peut-on monter dans un train plus tôt que celui qu'on suit ?
                if pos + 1 < route.len {
                    let there = previous_arrival[station as usize];
                    if there != INF {
                        // Arrivé en train, il faut le temps de changer ; arrivé à pied (ou au départ), non.
                        let wait = if matches!(previous_labels[station as usize], Label::Transit { .. }) { MIN_CHANGE } else { 0 };
                        let ready = there + wait;
                        let riding_departure = riding.map(|(trip, day, _)| schedule.time(route, trip, day, pos, true));
                        if riding_departure.is_none_or(|d| ready < d)
                            && let Some((trip, day, departure)) = schedule.earliest_trip(route, pos, ready)
                            && riding_departure.is_none_or(|d| departure < d)
                        {
                            riding = Some((trip, day, pos));
                        }
                    }
                }
            }
        }

        // 3. Les marches, depuis les gares améliorées en train à ce tour (pas de marche enchaînée).
        improved.sort_unstable();
        improved.dedup();
        let mut next_marked = improved.clone();
        relax_feet(raptor, &mut best, &mut best_round, current_arrival, current_labels, round as u8, &improved, &mut next_marked, bound);
        next_marked.sort_unstable();
        next_marked.dedup();
        marked = next_marked;
        if marked.is_empty() {
            break;
        }
    }

    Isochrone { schedule, depart: params.depart, origin: params.origin, best, best_round, arrival, labels, realtime: use_realtime }
}

/// Propage les marches depuis `sources` : une gare voisine est améliorée si on y arrive plus tôt qu'avant.
#[allow(clippy::too_many_arguments)]
fn relax_feet(
    raptor: &Raptor,
    best: &mut [i32],
    best_round: &mut [u8],
    arrival: &mut [i32],
    labels: &mut [Label],
    round: u8,
    sources: &[u32],
    marked: &mut Vec<u32>,
    bound: i32,
) {
    for &from in sources {
        let start = arrival[from as usize];
        for foot in raptor.foot_of(from) {
            let at = start.saturating_add(foot.seconds);
            if at < best[foot.to as usize] && at <= bound {
                best[foot.to as usize] = at;
                best_round[foot.to as usize] = round;
                arrival[foot.to as usize] = at;
                labels[foot.to as usize] = Label::Foot { from };
                marked.push(foot.to);
            }
        }
    }
}

/// Prépare la lecture des horaires pour un départ : jours de service concernés, calendriers, temps réel.
fn build_schedule<'a>(timetable: &'a Timetable, realtime: Option<&Realtime>, depart: i64) -> Schedule<'a> {
    let today = timetable.local_date(depart);
    let dates: [Option<Date>; DAYS] = std::array::from_fn(|day| today.checked_add(Span::new().days(day as i64 - 1)).ok());
    let mut offsets = [0i32; DAYS];
    for (day, date) in dates.iter().enumerate() {
        if let Some(start) = date.and_then(|d| timetable.service_day_start(d).ok()) {
            offsets[day] = (start - depart).clamp(-10 * 86_400, 10 * 86_400) as i32;
        }
    }
    let active: Vec<u8> = (0..timetable.service_count() as u32)
        .map(|service| {
            dates.iter().enumerate().fold(0u8, |mask, (day, date)| {
                if date.is_some_and(|d| timetable.service_runs_on(service, d)) { mask | (1 << day) } else { mask }
            })
        })
        .collect();

    // Temps réel : horaires corrigés de toutes les circulations du jour qu'il concerne.
    let mut live = HashMap::new();
    if let Some(realtime) = realtime {
        for (id, trip) in timetable.trips.iter().enumerate() {
            for day in 0..DAYS {
                let (Some(date), true) = (dates[day], active[trip.service as usize] & (1 << day) != 0) else { continue };
                let run = Run { trip, date, day_start: depart + i64::from(offsets[day]) };
                let Some(times) = realtime.apply(&run, &timetable.stop_points) else { continue };
                if times.canceled {
                    live.insert((id as u32, day as u8), None);
                    continue;
                }
                let relative: Vec<i32> = times
                    .arrival
                    .iter()
                    .zip(&times.departure)
                    .flat_map(|(&a, &d)| [(a - depart) as i32, (d - depart) as i32])
                    .collect();
                live.insert((id as u32, day as u8), Some(relative));
            }
        }
    }
    Schedule { timetable, offsets, active, live }
}

impl Isochrone<'_> {
    /// Toutes les gares atteintes (la gare de départ comprise, à 0 s).
    pub fn reached(&self) -> Vec<Reached> {
        self.best
            .iter()
            .enumerate()
            .filter(|&(_, &seconds)| seconds != INF)
            .map(|(station, &seconds)| Reached {
                station: station as u32,
                seconds,
                transfers: self.best_round[station].saturating_sub(1),
            })
            .collect()
    }

    /// Le meilleur itinéraire jusqu'à `station` : on remonte les étiquettes, tour après tour.
    pub fn journey(&self, station: u32) -> Option<Vec<Leg>> {
        if self.best.get(station as usize).is_none_or(|&b| b == INF) {
            return None;
        }
        let raptor = self.schedule.raptor();
        let mut legs = Vec::new();
        let mut round = self.best_round[station as usize] as usize;
        let mut at = station;
        loop {
            match self.labels[round][at as usize] {
                Label::Origin => break,
                Label::Foot { from } => {
                    legs.push(Leg::Walk {
                        from,
                        to: at,
                        departure: self.depart + i64::from(self.arrival[round][from as usize]),
                        arrival: self.depart + i64::from(self.arrival[round][at as usize]),
                    });
                    at = from;
                }
                Label::Transit { route, trip, day, board, alight } => {
                    let route = &raptor.routes[route as usize];
                    let stops = raptor.route_stops(route);
                    legs.push(Leg::Train {
                        trip: raptor.trips[(route.trips + trip) as usize],
                        from: stops[board as usize],
                        to: at,
                        departure: self.depart + i64::from(self.schedule.time(route, trip, day, board, true)),
                        arrival: self.depart + i64::from(self.schedule.time(route, trip, day, alight, false)),
                        stops: alight - board + 1,
                    });
                    at = stops[board as usize];
                    round -= 1;
                }
                Label::None => return None, // ne devrait pas arriver : une étiquette manque
            }
        }
        debug_assert!(at == self.origin);
        legs.reverse();
        Some(legs)
    }
}

#[cfg(test)]
mod tests;
