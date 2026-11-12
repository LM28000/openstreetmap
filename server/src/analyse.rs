//! Analyse de zone : « que dit-on de cet endroit ? ». `POST /api/analyse` reçoit un contour (GeoJSON) et rend, en une
//! réponse, tout ce que le serveur sait de l'intérieur : habitants, prix, couverture mobile, élections, accidents,
//! monuments, gares.
//!
//! # Le principe : relire les archives de tuiles, au bon zoom
//!
//! Les jeux lourds (population, couverture, prix, élections) n'existent que sous forme d'**archives de tuiles** : des
//! agrégats par carreau, calculés une fois pour chaque zoom (voir `tiles/mod.rs`). Plutôt que de garder une seconde copie
//! en mémoire, l'analyse **relit les tuiles** que le navigateur lirait : on énumère les tuiles que touche la zone, on les
//! décode (`tiles/mvt.rs`, la lecture est le miroir de l'écriture) et on additionne les objets dont le centre est dans le contour.
//!
//! Le **zoom** est le réglage qui borne le coût : plus il est fin, plus les carreaux sont petits (donc le résultat précis)
//! mais plus il y a de tuiles. Pour chaque jeu on prend le zoom **le plus fin** dont le nombre de tuiles reste sous un
//! plafond (96 ; 64 pour la couverture, dont les tuiles sont lourdes). Une zone de 10 km se lit au zoom le plus fin du jeu
//! (carreaux de 200 m) ; une région, quelques zooms plus haut (1 km). La réponse dit quel zoom a servi et la taille des carreaux.
//!
//! # Compter chaque carreau une fois : l'identité d'un carreau
//!
//! Une tuile est découpée avec une marge : un carreau à cheval sur deux tuiles est présent dans les deux, **tronqué**. Les
//! additionner deux fois fausserait les sommes. Chaque carreau est donc rattaché à *une* tuile :
//!
//! 1. le centre du carreau tronqué (moyenne de ses sommets : il reste à l'intérieur du carreau d'origine, qui est convexe) est
//!    reprojeté en LAEA (le repère de toutes les grilles) puis ramené à la grille de `taille` mètres : on retrouve l'**indice
//!    exact du carreau** (`floor(e / taille)`, `floor(n / taille)`) ;
//! 2. le **vrai centre** de ce carreau donne sa tuile « propriétaire » : on ne le compte que dans celle-là ;
//! 3. la règle de la zone est « le centre du carreau est dans le contour » (un carreau est dedans ou dehors, jamais coupé).
//!
//! L'erreur de bord est donc d'au plus un demi-carreau, et sans biais.
//!
//! # Les bureaux de vote : un centroïde par morceaux
//!
//! Un bureau est un polygone, souvent plus grand qu'une tuile : chaque tuile n'en porte qu'un morceau, tronqué à la tuile *plus sa marge*.
//! Pour trouver son centroïde on découpe chaque morceau au carré strict de la tuile (les carrés stricts ne se chevauchent pas : une
//! partition du plan), on calcule l'aire et le centre de chaque bout par la formule du lacet, et on **somme les moments** :
//! `centroïde = Σ aire × centre / Σ aire`. Les trous (anneaux d'orientation inverse) retranchent leur aire d'eux-mêmes. On lit en plus
//! une couronne de tuiles autour de la zone, pour que les bureaux qui débordent ne soient pas vus tronqués.
//!
//! # Prix : des ventes quand on peut, des médianes sinon
//!
//! Une médiane ne s'additionne pas (voir `tiles/dvf.rs`). Pour une petite zone, on relit les **ventes** elles-mêmes (zoom 14, un
//! point chacune) et on en fait un histogramme logarithmique exact. Pour une grande zone, les tuiles de carreaux n'ont que la médiane et les
//! quartiles de chaque carreau : on reconstitue l'histogramme de chaque carreau en y répartissant ses ventes en quatre quarts
//! (entre les quartiles), puis on **fusionne** les histogrammes. C'est une approximation (indiquée dans la réponse : `methode`).
//!
//! # Mémoire et temps
//!
//! Les tuiles sont lues, additionnées et jetées une à une : rien n'est gardé en dehors des sommes (sauf les accumulateurs
//! de bureaux de vote : quelques milliers de lignes). Une seule analyse à la fois (`GATE`), la surface est plafonnée
//! (`MAX_AREA_KM2`) et les quatre jeux de tuiles se lisent en parallèle (un fil chacun).

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value as Json2, json};
use tracing::warn;

use crate::state::AppState;
use crate::tiles::dvf::{BINS, POINTS_FROM, bin_of};
use crate::tiles::dvf_source::{MAX_EURO_M2, MIN_EURO_M2};
use crate::tiles::geom::{self, Bounds, EXTENT};
use crate::tiles::mvt::{ReadFeature, ReadLayer, decode_geometry};
use crate::tiles::proj::{laea_forward, laea_inverse};
use crate::tiles::serve::Archive;
use crate::{accidents, monuments};

/// Surface maximale d'une zone : une grande région (la Nouvelle-Aquitaine fait 84 000 km²).
const MAX_AREA_KM2: f64 = 100_000.0;
/// Sommets maximum d'un contour (un cercle en demande ~96, un polygone dessiné à la main quelques dizaines).
const MAX_VERTICES: usize = 2_000;
/// Nombre maximal de tuiles lues par jeu (voir « Le principe »).
const TILE_CAP: usize = 96;
const COVERAGE_TILE_CAP: usize = 64;
/// Les ventes (zoom 14, tuiles de 1,7 km) sont légères : on en lit plus.
const POINT_TILE_CAP: usize = 192;
/// France métropolitaine : au-delà, les jeux n'ont pas de données (autres repères pour l'outre-mer).
const LON_RANGE: (f64, f64) = (-5.6, 10.0);
const LAT_RANGE: (f64, f64) = (41.0, 51.5);
/// Une analyse à la fois : la mémoire est bornée (quelques Mo par fil de lecture) et le temps aussi.
static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

#[derive(Deserialize)]
pub struct Request {
    /// Un `Polygon` GeoJSON (ou une `Feature` qui en porte un), en lon/lat.
    zone: Json2,
    /// Le scrutin dont on veut les résultats (`elec-p22t1`…). Sans lui : pas de section élections.
    scrutin: Option<String>,
}

pub async fn handler(State(state): State<AppState>, Json(request): Json<Request>) -> Response {
    let zone = match Zone::parse(&request.zone) {
        Ok(zone) => zone,
        Err(message) => return (StatusCode::UNPROCESSABLE_ENTITY, message).into_response(),
    };
    let Ok(Ok(_turn)) = tokio::time::timeout(Duration::from_secs(10), GATE.acquire()).await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "une autre analyse est en cours, réessayez").into_response();
    };
    let started = Instant::now();
    let stations = state.timetable();
    let tiles = state.tiles().clone();
    let scrutin = request.scrutin.filter(|s| s.starts_with("elec-"));
    let result = tokio::task::spawn_blocking(move || analyse(&zone, &tiles, &stations.stations, scrutin.as_deref())).await;
    match result {
        Ok(mut out) => {
            out["dureeMs"] = json!(started.elapsed().as_millis() as u64);
            ([(axum::http::header::CACHE_CONTROL, "no-store")], Json(out)).into_response()
        }
        Err(error) => {
            warn!("analyse de zone : {error}");
            (StatusCode::INTERNAL_SERVER_ERROR, "analyse impossible").into_response()
        }
    }
}

/// Toute l'analyse (bloquante : à lancer dans `spawn_blocking`).
fn analyse(zone: &Zone, tiles: &crate::tiles::Registry, stations: &[crate::timetable::Station], scrutin: Option<&str>) -> Json2 {
    let timed = |name: &str, f: &(dyn Fn() -> anyhow::Result<Json2> + Sync)| -> (Json2, u64) {
        let started = Instant::now();
        let value = match f() {
            Ok(v) => v,
            Err(error) => json!({ "erreur": format!("{error:#}") }),
        };
        let _ = name;
        (value, started.elapsed().as_millis() as u64)
    };
    // Les quatre jeux de tuiles se lisent en parallèle : un fil chacun, qui meurt avec sa lecture.
    let ((population, t_pop), (mobile, t_mob), (immobilier, t_dvf), (elections, t_elec)) = std::thread::scope(|scope| {
        let pop = scope.spawn(|| timed("population", &|| population(zone, tiles)));
        let mob = scope.spawn(|| timed("mobile", &|| mobile(zone, tiles)));
        let dvf = scope.spawn(|| timed("immobilier", &|| immobilier(zone, tiles)));
        let elec = scope.spawn(|| match scrutin {
            Some(id) => timed("elections", &|| elections(zone, tiles, id)),
            None => (Json2::Null, 0),
        });
        let join = |h: std::thread::ScopedJoinHandle<(Json2, u64)>| h.join().unwrap_or((json!({ "erreur": "lecture interrompue" }), 0));
        (join(pop), join(mob), join(dvf), join(elec))
    });
    let started = Instant::now();
    let accidents = road_accidents(zone);
    let monuments = historic_monuments(zone);
    let stations = stations_in(zone, stations);
    let t_memory = started.elapsed().as_millis() as u64;
    json!({
        "zone": { "surfaceKm2": (zone.area_km2 * 10.0).round() / 10.0, "centre": zone.centre, "sommets": zone.rings[0].len() },
        "population": population,
        "immobilier": immobilier,
        "mobile": mobile,
        "elections": elections,
        "accidents": accidents,
        "monuments": monuments,
        "gares": stations,
        "dureesMs": { "population": t_pop, "mobile": t_mob, "immobilier": t_dvf, "elections": t_elec, "memoire": t_memory },
    })
}

// ---------------------------------------------------------------------------------------------
// La zone
// ---------------------------------------------------------------------------------------------

/// Le contour : un anneau extérieur et des trous éventuels (lon/lat, non fermés).
#[derive(Debug)]
pub struct Zone {
    rings: Vec<Vec<[f64; 2]>>,
    bounds: Bounds,
    centre: [f64; 2],
    area_km2: f64,
}

impl Zone {
    pub fn parse(geojson: &Json2) -> Result<Zone, String> {
        let geometry = if geojson["type"] == "Feature" { &geojson["geometry"] } else { geojson };
        if geometry["type"] != "Polygon" {
            return Err("la zone doit être un polygone GeoJSON".into());
        }
        let coordinates = geometry["coordinates"].as_array().ok_or("polygone sans coordonnées")?;
        let mut rings: Vec<Vec<[f64; 2]>> = Vec::new();
        for ring in coordinates {
            let mut points: Vec<[f64; 2]> = Vec::new();
            for point in ring.as_array().ok_or("anneau invalide")? {
                let (lon, lat) = (point[0].as_f64(), point[1].as_f64());
                let (Some(lon), Some(lat)) = (lon, lat) else { return Err("coordonnée invalide".into()) };
                if !(LON_RANGE.0..=LON_RANGE.1).contains(&lon) || !(LAT_RANGE.0..=LAT_RANGE.1).contains(&lat) {
                    return Err("la zone doit être en France métropolitaine".into());
                }
                points.push([lon, lat]);
            }
            if points.len() > 1 && points.first() == points.last() {
                points.pop(); // l'anneau GeoJSON est fermé : on ne répète pas le premier sommet
            }
            if points.len() < 3 {
                return Err("un anneau a moins de trois sommets".into());
            }
            rings.push(points);
        }
        if rings.is_empty() || rings.iter().map(Vec::len).sum::<usize>() > MAX_VERTICES {
            return Err(format!("le contour doit avoir entre 3 et {MAX_VERTICES} sommets"));
        }
        let bounds = Bounds::of(rings[0].iter().copied());
        // Aire dans le repère LAEA (équivalent : les aires y sont exactes), anneau extérieur moins les trous.
        let area = |ring: &Vec<[f64; 2]>| {
            let p: Vec<(f64, f64)> = ring.iter().map(|q| laea_forward(q[0], q[1])).collect();
            (0..p.len()).map(|i| p[i].0 * p[(i + 1) % p.len()].1 - p[(i + 1) % p.len()].0 * p[i].1).sum::<f64>().abs() / 2.0
        };
        let area_km2 = (area(&rings[0]) - rings[1..].iter().map(area).sum::<f64>()) / 1e6;
        if area_km2 <= 0.0 {
            return Err("zone de surface nulle".into());
        }
        if area_km2 > MAX_AREA_KM2 {
            return Err(format!("zone trop grande : {:.0} km² (maximum {MAX_AREA_KM2:.0} km², une grande région)", area_km2));
        }
        // Centroïde de l'anneau extérieur (lon/lat plans : suffisant à cette échelle) ; au pire, le centre de l'emprise.
        let ring = &rings[0];
        let (mut a2, mut cx, mut cy) = (0.0, 0.0, 0.0);
        for i in 0..ring.len() {
            let (p, q) = (ring[i], ring[(i + 1) % ring.len()]);
            let cross = p[0] * q[1] - q[0] * p[1];
            a2 += cross;
            cx += (p[0] + q[0]) * cross;
            cy += (p[1] + q[1]) * cross;
        }
        let centre = if a2.abs() > 1e-12 {
            [cx / (3.0 * a2), cy / (3.0 * a2)]
        } else {
            [(bounds.min[0] + bounds.max[0]) / 2.0, (bounds.min[1] + bounds.max[1]) / 2.0]
        };
        Ok(Zone { rings, bounds, centre, area_km2 })
    }

    /// Le point est-il dans le contour ? (règle pair-impair : un rayon horizontal vers l'est croise les côtés ; un nombre
    /// impair de croisements = dedans. Les trous se comptent d'eux-mêmes : ils ajoutent un croisement de plus.)
    pub fn contains(&self, lon: f64, lat: f64) -> bool {
        if lon < self.bounds.min[0] || lon > self.bounds.max[0] || lat < self.bounds.min[1] || lat > self.bounds.max[1] {
            return false;
        }
        let mut inside = false;
        for ring in &self.rings {
            let mut j = ring.len() - 1;
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[j]);
                if (a[1] > lat) != (b[1] > lat) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0] {
                    inside = !inside;
                }
                j = i;
            }
        }
        inside
    }

    /// Le rectangle `[x0, x1] × [y0, y1]` (lon/lat) touche-t-il le contour ? Trois façons de se toucher : un sommet du contour
    /// dans le rectangle, un coin du rectangle dans le contour, ou un côté du contour qui traverse le rectangle.
    fn touches(&self, r: [f64; 4]) -> bool {
        let [x0, y0, x1, y1] = r;
        if x1 < self.bounds.min[0] || x0 > self.bounds.max[0] || y1 < self.bounds.min[1] || y0 > self.bounds.max[1] {
            return false;
        }
        if [[x0, y0], [x0, y1], [x1, y0], [x1, y1]].iter().any(|c| self.contains(c[0], c[1])) {
            return true;
        }
        for ring in &self.rings {
            for i in 0..ring.len() {
                let (a, b) = (ring[i], ring[(i + 1) % ring.len()]);
                if segment_touches_rect(a, b, r) {
                    return true;
                }
            }
        }
        false
    }
}

/// Liang-Barsky : le segment `a → b` traverse-t-il le rectangle (sommets dedans compris) ?
fn segment_touches_rect(a: [f64; 2], b: [f64; 2], r: [f64; 4]) -> bool {
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    let d = [b[0] - a[0], b[1] - a[1]];
    for (p, q) in [(-d[0], a[0] - r[0]), (d[0], r[2] - a[0]), (-d[1], a[1] - r[1]), (d[1], r[3] - a[1])] {
        if p == 0.0 {
            if q < 0.0 {
                return false; // parallèle au bord et dehors
            }
        } else {
            let t = q / p;
            if p < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
            if t0 > t1 {
                return false;
            }
        }
    }
    true
}

// ---------------------------------------------------------------------------------------------
// Tuiles : lesquelles lire, à quel zoom
// ---------------------------------------------------------------------------------------------

/// Rectangle lon/lat d'une tuile : `[ouest, sud, est, nord]` (les côtés d'une tuile Web Mercator sont des méridiens et des parallèles).
fn tile_rect(z: u8, x: u32, y: u32) -> [f64; 4] {
    let (west, north) = geom::tile_corner(z, x, y);
    let (east, south) = geom::tile_corner(z, x + 1, y + 1);
    [west, south, east, north]
}

/// Position monde (au zoom `z`) → (lon, lat) : l'inverse de `geom::world`.
fn world_to_lonlat(w: [f64; 2], z: u8) -> (f64, f64) {
    let n = f64::from(1u32 << z) * f64::from(EXTENT);
    let lon = w[0] / n * 360.0 - 180.0;
    let lat = (std::f64::consts::PI * (1.0 - 2.0 * w[1] / n)).sinh().atan().to_degrees();
    (lon, lat)
}

/// Les tuiles du zoom `z` que touche la zone, avec `margin` tuiles de plus autour. `None` s'il y en aurait plus que `cap`.
fn zone_tiles(zone: &Zone, z: u8, margin: u32, cap: usize) -> Option<Vec<(u32, u32)>> {
    let (w0, w1) = (geom::world(zone.bounds.min[0], zone.bounds.max[1], z), geom::world(zone.bounds.max[0], zone.bounds.min[1], z));
    let (x0, y0, x1, y1) = geom::tile_range(&Bounds { min: w0, max: w1 }, z, 0.0);
    // Avant de tester chaque tuile du rectangle englobant (coûteux si la zone est grande et le zoom fin) : un coup d'œil.
    if (x1 - x0 + 1) as usize * (y1 - y0 + 1) as usize > cap * 4 {
        return None;
    }
    let mut touched: BTreeSet<(u32, u32)> = BTreeSet::new();
    for x in x0..=x1 {
        for y in y0..=y1 {
            if zone.touches(tile_rect(z, x, y)) {
                touched.insert((x, y));
            }
        }
    }
    let last = (1u32 << z) - 1;
    let mut all = touched.clone();
    for &(x, y) in &touched {
        for dx in 0..=2 * margin {
            for dy in 0..=2 * margin {
                let (nx, ny) = ((x + dx).checked_sub(margin), (y + dy).checked_sub(margin));
                if let (Some(nx), Some(ny)) = (nx, ny) {
                    if nx <= last && ny <= last {
                        all.insert((nx, ny));
                    }
                }
            }
        }
    }
    (all.len() <= cap).then(|| all.into_iter().collect())
}

/// Le zoom le plus fin (entre `min` et `max`) dont le nombre de tuiles tient sous `cap`, et ses tuiles.
fn choose_zoom(zone: &Zone, (min, max): (u8, u8), margin: u32, cap: usize) -> Option<(u8, Vec<(u32, u32)>)> {
    (min..=max).rev().find_map(|z| zone_tiles(zone, z, margin, cap).map(|tiles| (z, tiles)))
}

/// Côté (mètres) des carreaux d'un jeu à un zoom, d'après la liste `tailles` de sa fiche.
fn cell_size(archive: &Archive, z: u8) -> Option<f64> {
    archive.data()["tailles"].as_array()?.iter().find(|pair| pair[0].as_u64() == Some(u64::from(z)))?[1].as_f64()
}

/// Le jeu `id`, ou une erreur lisible.
fn archive_of(tiles: &crate::tiles::Registry, id: &str) -> anyhow::Result<std::sync::Arc<Archive>> {
    tiles.archive(id).ok_or_else(|| anyhow::anyhow!("jeu « {id} » pas encore prêt"))
}

/// La première couche d'une tuile.
fn first_layer(layers: &mut Vec<ReadLayer>) -> Option<ReadLayer> {
    if layers.is_empty() { None } else { Some(layers.swap_remove(0)) }
}

// ---------------------------------------------------------------------------------------------
// Carreaux
// ---------------------------------------------------------------------------------------------

/// Pour chaque carreau **possédé par sa tuile** (voir « Compter chaque carreau une fois ») dont le centre est dans la zone :
/// `visit(couche, objet)`. Rend le nombre de tuiles non vides lues.
fn for_each_cell(
    archive: &Archive,
    zone: &Zone,
    z: u8,
    tiles: &[(u32, u32)],
    size: f64,
    mut visit: impl FnMut(&ReadLayer, &ReadFeature),
) -> anyhow::Result<usize> {
    let mut read = 0;
    for &(tx, ty) in tiles {
        let Some(mut layers) = archive.read(z, tx, ty)? else { continue };
        let Some(layer) = first_layer(&mut layers) else { continue };
        read += 1;
        let origin = [f64::from(tx) * f64::from(EXTENT), f64::from(ty) * f64::from(EXTENT)];
        for feature in &layer.features {
            let rings = decode_geometry(&feature.geometry);
            let Some(ring) = rings.first().filter(|r| r.len() >= 3) else { continue };
            // Centre du carreau (éventuellement tronqué) → indice de grille → vrai centre → tuile propriétaire.
            let n = ring.len() as f64;
            let mean = [ring.iter().map(|p| f64::from(p[0])).sum::<f64>() / n, ring.iter().map(|p| f64::from(p[1])).sum::<f64>() / n];
            let (lon, lat) = world_to_lonlat([origin[0] + mean[0], origin[1] + mean[1]], z);
            let (e, nn) = laea_forward(lon, lat);
            let (ie, in_) = ((e / size).floor(), (nn / size).floor());
            let (clon, clat) = laea_inverse((ie + 0.5) * size, (in_ + 0.5) * size);
            let w = geom::world(clon, clat, z);
            if (w[0] / f64::from(EXTENT)).floor() as u32 != tx || (w[1] / f64::from(EXTENT)).floor() as u32 != ty {
                continue; // un carreau du voisin : il le compte
            }
            if zone.contains(clon, clat) {
                visit(&layer, feature);
            }
        }
    }
    Ok(read)
}

// ---------------------------------------------------------------------------------------------
// Population (INSEE, carreaux de 200 m)
// ---------------------------------------------------------------------------------------------

fn population(zone: &Zone, tiles: &crate::tiles::Registry) -> anyhow::Result<Json2> {
    let archive = archive_of(tiles, "population")?;
    let (z, list) = choose_zoom(zone, archive.zooms(), 0, TILE_CAP).ok_or_else(|| anyhow::anyhow!("zone trop étendue"))?;
    let size = cell_size(&archive, z).unwrap_or(200.0);
    let (mut people, mut households, mut living, mut poor, mut elderly, mut imputed, mut cells) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0u64);
    for_each_cell(&archive, zone, z, &list, size, |layer, f| {
        let get = |name: &str| layer.key(name).map_or(0.0, |k| layer.number(f, k));
        let (pop, men) = (get("pop"), get("men"));
        people += pop;
        households += men;
        // Des moyennes se refont à partir des sommes pondérées : niveau de vie × habitants, part de pauvres × ménages…
        living += get("niv") * pop;
        poor += get("pauv") / 100.0 * men;
        elderly += get("a65") / 100.0 * pop;
        imputed += get("imp") / 100.0 * pop;
        cells += 1;
    })?;
    let ratio = |a: f64, b: f64| if b > 0.0 { a / b } else { 0.0 };
    Ok(json!({
        "zoom": z, "tailleCarreau": size, "tuiles": list.len(), "carreaux": cells,
        "habitants": people.round(),
        "menages": households.round(),
        "densite": (ratio(people, zone.area_km2)).round(),
        "niveauDeVie": ratio(living, people).round(),
        "partPauvres": (1000.0 * ratio(poor, households)).round() / 10.0,
        "part65": (1000.0 * ratio(elderly, people)).round() / 10.0,
        "partImputes": (1000.0 * ratio(imputed, people)).round() / 10.0,
        "millesime": archive.data()["millesime"],
    }))
}

// ---------------------------------------------------------------------------------------------
// Couverture mobile (ARCEP), croisée avec les habitants
// ---------------------------------------------------------------------------------------------

fn mobile(zone: &Zone, tiles: &crate::tiles::Registry) -> anyhow::Result<Json2> {
    let archive = archive_of(tiles, "couverture")?;
    let (z, list) = choose_zoom(zone, archive.zooms(), 0, COVERAGE_TILE_CAP).ok_or_else(|| anyhow::anyhow!("zone trop étendue"))?;
    let size = cell_size(&archive, z).unwrap_or(250.0);
    // Au plus fin (carreaux de 250 m d'origine), le nombre d'opérateurs est exact : 0, 1, 2 ou plus. Plus gros, un carreau est un
    // mélange : on sait la part de sa surface sans opérateur (`gz`) et le nombre moyen (`gm`), pas la répartition entre 1 et 2+.
    let exact = size <= 250.0;
    let (mut cells, mut area_zero, mut mean_sum) = (0.0f64, 0.0f64, 0.0f64);
    let mut by_count = [0.0f64; 3]; // surface : 0, 1, 2+ (exact seulement)
    let mut people = [0.0f64; 3]; // habitants : 0, 1, 2+ (toujours exact : des sommes de comptes)
    let mut people_total = 0.0;
    for_each_cell(&archive, zone, z, &list, size, |layer, f| {
        let get = |name: &str| layer.key(name).map_or(0.0, |k| layer.number(f, k));
        cells += 1.0;
        area_zero += get("gz") / 100.0;
        mean_sum += get("gm") / 10.0;
        if exact {
            by_count[(get("gm") / 10.0).round().min(2.0) as usize] += 1.0;
        }
        let (hp, h0, h1) = (get("hp"), get("h0"), get("h1"));
        people_total += hp;
        people[0] += h0;
        people[1] += h1;
        people[2] += hp - h0 - h1;
    })?;
    let share = |part: f64, whole: f64| if whole > 0.0 { (1000.0 * part / whole).round() / 10.0 } else { 0.0 };
    let area = if exact {
        json!({ "sans": share(by_count[0], cells), "un": share(by_count[1], cells), "deuxEtPlus": share(by_count[2], cells) })
    } else {
        json!({ "sans": share(area_zero, cells), "un": null, "deuxEtPlus": null })
    };
    Ok(json!({
        "zoom": z, "tailleCarreau": size, "tuiles": list.len(), "carreaux": cells,
        "exact": exact,
        "surface": area,
        "operateursMoyen": if cells > 0.0 { (10.0 * mean_sum / cells).round() / 10.0 } else { 0.0 },
        "habitants": { "sans": people[0], "un": people[1], "deuxEtPlus": people[2].max(0.0), "total": people_total,
            "partSans": share(people[0], people_total), "partUn": share(people[1], people_total), "partDeuxEtPlus": share(people[2].max(0.0), people_total) },
        "trimestre": archive.data()["trimestre"],
    }))
}

// ---------------------------------------------------------------------------------------------
// Prix de l'immobilier (DVF)
// ---------------------------------------------------------------------------------------------

/// Quantile `q` d'un histogramme logarithmique à décomptes réels (la version de `dvf::quantile`, qui lit des entiers).
fn quantile(hist: &[f64; BINS], q: f64) -> f64 {
    let total: f64 = hist.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }
    let target = q * total;
    let mut cumulative = 0.0;
    for (bin, &count) in hist.iter().enumerate() {
        let next = cumulative + count;
        if count > 0.0 && next >= target {
            let inside = ((target - cumulative) / count).clamp(0.0, 1.0);
            return MIN_EURO_M2 * (MAX_EURO_M2 / MIN_EURO_M2).powf((bin as f64 + inside) / BINS as f64);
        }
        cumulative = next;
    }
    MAX_EURO_M2
}

/// Répartit les `n` ventes d'un carreau dans l'histogramme d'après sa médiane et ses quartiles : un quart des ventes dans chacun
/// des quatre intervalles qu'ils délimitent, étalé uniformément (en échelle logarithmique) sur l'intervalle ; les extrémités sont
/// prolongées symétriquement en proportion (un minimum à `q1 × q1 / médiane`). Ainsi la médiane du carreau reste la médiane
/// de son histogramme, ce qu'un simple point par quart ne garantit pas. Sans quartiles (carreaux de 100 et 125 m), toutes les ventes sont mises à la médiane.
fn spread(hist: &mut [f64; BINS], n: f64, median: f64, q1: f64, q3: f64) {
    if n <= 0.0 || median <= 0.0 {
        return;
    }
    if q1 <= 0.0 || q3 <= 0.0 || q1 > median || q3 < median {
        hist[bin_of(median)] += n;
        return;
    }
    let (low, high) = (q1 * (q1 / median), q3 * (q3 / median));
    // Position fractionnaire d'un prix sur l'axe des classes (la partie entière est `bin_of`).
    let position = |price: f64| ((price / MIN_EURO_M2).ln() / (MAX_EURO_M2 / MIN_EURO_M2).ln() * BINS as f64).clamp(0.0, BINS as f64);
    let edges = [low, q1, median, q3, high].map(position);
    for pair in edges.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if b - a < 1e-9 {
            hist[(a as usize).min(BINS - 1)] += n / 4.0;
            continue;
        }
        // Un quart des ventes, étalé uniformément (en logarithme) sur l'intervalle : chaque classe reçoit sa part de recouvrement.
        for bin in (a as usize)..=((b as usize).min(BINS - 1)) {
            let overlap = b.min(bin as f64 + 1.0) - a.max(bin as f64);
            if overlap > 0.0 {
                hist[bin] += n / 4.0 * overlap / (b - a);
            }
        }
    }
}

fn immobilier(zone: &Zone, tiles: &crate::tiles::Registry) -> anyhow::Result<Json2> {
    let archive = archive_of(tiles, "dvf")?;
    let (min, max) = archive.zooms();
    // Groupes : appartements et maisons, sur 5 ans et sur 12 mois.
    let mut groups: [[f64; BINS]; 4] = [[0.0; BINS]; 4]; // 0 appt 5 ans, 1 maison 5 ans, 2 appt 12 mois, 3 maison 12 mois
    let mut counts = [0.0f64; 4];
    let (method, z, size, tile_count);
    if let Some(list) = zone_tiles(zone, POINTS_FROM.min(max), 0, POINT_TILE_CAP).filter(|_| max >= POINTS_FROM) {
        // Les ventes elles-mêmes : l'histogramme est exact (à la classe près, 3,7 %).
        let label = archive.data()["moisReference"].as_str().unwrap_or("2000-01");
        let newest = label.split_once('-').and_then(|(y, m)| Some((y.parse::<u32>().ok()? - 2000) * 12 + m.parse::<u32>().ok()? - 1)).unwrap_or(0);
        for &(tx, ty) in &list {
            let Some(mut layers) = archive.read(POINTS_FROM, tx, ty)? else { continue };
            let Some(layer) = first_layer(&mut layers) else { continue };
            let (Some(k_mo), Some(k_ty), Some(k_em)) = (layer.key("mo"), layer.key("ty"), layer.key("em")) else { continue };
            let origin = [f64::from(tx) * f64::from(EXTENT), f64::from(ty) * f64::from(EXTENT)];
            for feature in &layer.features {
                let Some(p) = decode_geometry(&feature.geometry).first().and_then(|r| r.first().copied()) else { continue };
                let (lon, lat) = world_to_lonlat([origin[0] + f64::from(p[0]), origin[1] + f64::from(p[1])], POINTS_FROM);
                if !zone.contains(lon, lat) {
                    continue;
                }
                let kind = usize::from(layer.number(feature, k_ty) > 0.5);
                let age = newest.saturating_sub(layer.number(feature, k_mo) as u32);
                let bin = bin_of(layer.number(feature, k_em));
                groups[kind][bin] += 1.0;
                counts[kind] += 1.0;
                if age < 12 {
                    groups[2 + kind][bin] += 1.0;
                    counts[2 + kind] += 1.0;
                }
            }
        }
        (method, z, size, tile_count) = ("ventes", POINTS_FROM, 0.0, list.len());
    } else {
        // Les carreaux : médianes et quartiles de chacun, fusionnés en histogramme.
        let (zoom, list) = choose_zoom(zone, (min, POINTS_FROM.saturating_sub(1).max(min)), 0, TILE_CAP).ok_or_else(|| anyhow::anyhow!("zone trop étendue"))?;
        let cell = cell_size(&archive, zoom).unwrap_or(1000.0);
        for_each_cell(&archive, zone, zoom, &list, cell, |layer, f| {
            let get = |name: &str| layer.key(name).map_or(0.0, |k| layer.number(f, k));
            for (group, (n, p, l, h)) in [("a5", 0), ("m5", 1), ("a1", 2), ("m1", 3)].map(|(suffix, i)| {
                (i, (format!("n{suffix}"), format!("p{suffix}"), format!("l{suffix}"), format!("h{suffix}")))
            }) {
                let count = get(&n);
                counts[group] += count;
                spread(&mut groups[group], count, get(&p), get(&l), get(&h));
            }
        })?;
        (method, z, size, tile_count) = ("carreaux", zoom, cell, list.len());
    }
    let summary = |i: usize| {
        json!({ "ventes": counts[i], "mediane": quantile(&groups[i], 0.5).round(), "q1": quantile(&groups[i], 0.25).round(), "q3": quantile(&groups[i], 0.75).round() })
    };
    Ok(json!({
        "methode": method, "zoom": z, "tailleCarreau": size, "tuiles": tile_count,
        "appartements": summary(0), "maisons": summary(1),
        "appartements12mois": summary(2), "maisons12mois": summary(3),
        "moisReference": archive.data()["moisReference"], "debut5ans": archive.data()["debut5ans"],
    }))
}

// ---------------------------------------------------------------------------------------------
// Élections : les bureaux de vote dont le centroïde est dans la zone
// ---------------------------------------------------------------------------------------------

/// Les moments d'un polygone morcelé en tuiles : `Σ aire`, `Σ aire × x`, `Σ aire × y` (positions monde du zoom de lecture).
#[derive(Default)]
struct Pieces {
    area: f64,
    mx: f64,
    my: f64,
    /// Inscrits, votants, exprimés, puis les voix de chaque colonne (lus à la première rencontre).
    values: Vec<f64>,
}

/// Ajoute à `pieces` les moments du morceau `rings` (coordonnées locales de la tuile, d'origine `origin`), **découpé au carré strict
/// de la tuile** pour que deux tuiles voisines ne comptent jamais la même surface.
fn add_pieces(pieces: &mut Pieces, rings: &[Vec<[i32; 2]>], origin: [f64; 2]) {
    let core = f64::from(EXTENT);
    for ring in rings {
        let local: Vec<[f64; 2]> = ring.iter().map(|p| [f64::from(p[0]), f64::from(p[1])]).collect();
        let clipped = geom::clip_ring(&local, [0.0, 0.0], [core, core]);
        if clipped.len() < 3 {
            continue;
        }
        // Formule du lacet : aire signée et centre de ce bout (l'orientation distingue l'extérieur des trous : les signes s'annulent bien).
        let (mut a2, mut cx, mut cy) = (0.0, 0.0, 0.0);
        for i in 0..clipped.len() {
            let (p, q) = (clipped[i], clipped[(i + 1) % clipped.len()]);
            let cross = p[0] * q[1] - q[0] * p[1];
            a2 += cross;
            cx += (p[0] + q[0]) * cross;
            cy += (p[1] + q[1]) * cross;
        }
        if a2.abs() < 1e-9 {
            continue;
        }
        let area = a2 / 2.0;
        pieces.area += area;
        pieces.mx += area * (cx / (3.0 * a2) + origin[0]);
        pieces.my += area * (cy / (3.0 * a2) + origin[1]);
    }
}

fn elections(zone: &Zone, tiles: &crate::tiles::Registry, id: &str) -> anyhow::Result<Json2> {
    let archive = archive_of(tiles, id)?;
    // Une couronne d'une tuile autour de la zone : les bureaux voisins qui débordent y sont vus en entier (voir l'en-tête).
    let (z, list) = choose_zoom(zone, archive.zooms(), 1, TILE_CAP).ok_or_else(|| anyhow::anyhow!("zone trop étendue"))?;
    // Niveau lu à ce zoom (voir `elections.rs`) : département, commune, bureau (+ communes de repli).
    let wanted: i64 = if z <= 7 { 0 } else if z <= 10 { 1 } else { 2 };
    let mut found: HashMap<String, Pieces> = HashMap::new();
    let mut fallback: HashMap<String, Pieces> = HashMap::new();
    let mut communes_with_stations: HashSet<String> = HashSet::new();
    let mut columns = 0;
    for &(tx, ty) in &list {
        let Some(mut layers) = archive.read(z, tx, ty)? else { continue };
        let Some(layer) = first_layer(&mut layers) else { continue };
        let (Some(k_niv), Some(k_code), Some(k_i), Some(k_v), Some(k_x)) =
            (layer.key("niv"), layer.key("code"), layer.key("i"), layer.key("v"), layer.key("x"))
        else {
            continue;
        };
        let voices: Vec<u32> = (0..).map_while(|c| layer.key(&format!("c{c}"))).collect();
        columns = voices.len();
        let origin = [f64::from(tx) * f64::from(EXTENT), f64::from(ty) * f64::from(EXTENT)];
        for feature in &layer.features {
            let level = layer.number(feature, k_niv) as i64;
            let into = if level == wanted {
                &mut found
            } else if level == 3 && wanted == 2 {
                &mut fallback
            } else {
                continue;
            };
            let Some(code) = layer.text(feature, k_code) else { continue };
            let entry = into.entry(code.to_string()).or_default();
            if entry.values.is_empty() {
                entry.values = [k_i, k_v, k_x].into_iter().chain(voices.iter().copied()).map(|k| layer.number(feature, k)).collect();
                if level == 2 {
                    communes_with_stations.insert(code.split('_').next().unwrap_or(code).to_string());
                }
            }
            add_pieces(entry, &decode_geometry(&feature.geometry), origin);
        }
    }
    // Les communes de repli portent les totaux de **toute** la commune : on ne les prend que si aucun de leurs bureaux n'a de contour.
    fallback.retain(|code, _| !communes_with_stations.contains(code));
    let mut sums = vec![0.0f64; 3 + columns];
    let mut objects = 0u64;
    for pieces in found.values().chain(fallback.values()) {
        if pieces.area.abs() < 1e-9 {
            continue;
        }
        let (lon, lat) = world_to_lonlat([pieces.mx / pieces.area, pieces.my / pieces.area], z);
        if zone.contains(lon, lat) {
            objects += 1;
            for (sum, value) in sums.iter_mut().zip(&pieces.values) {
                *sum += value;
            }
        }
    }
    let level_name = ["département", "commune", "bureau de vote"][wanted as usize];
    Ok(json!({
        "scrutin": id, "zoom": z, "niveau": level_name,
        "tuiles": list.len(), "objets": objects,
        "inscrits": sums[0], "votants": sums[1], "exprimes": sums[2],
        "voix": &sums[3..],
    }))
}

// ---------------------------------------------------------------------------------------------
// Ce qui est en mémoire : accidents, monuments, gares
// ---------------------------------------------------------------------------------------------

fn road_accidents(zone: &Zone) -> Json2 {
    let Some(index) = accidents::index() else { return json!({ "erreur": "accidents pas encore collectés" }) };
    let (mut total, mut fatal) = (0u32, 0u32);
    let mut persons = [0u32; 4]; // tués, hospitalisés, blessés légers, indemnes
    let mut by_year: std::collections::BTreeMap<u16, [u32; 2]> = std::collections::BTreeMap::new();
    for &(lon, lat, year, cnt) in &index.points {
        let (lon, lat) = (f64::from(lon) / 1e4, f64::from(lat) / 1e4);
        if !zone.contains(lon, lat) {
            continue;
        }
        total += 1;
        let people = [cnt & 63, (cnt >> 6) & 63, (cnt >> 12) & 63, (cnt >> 18) & 63];
        for (sum, n) in persons.iter_mut().zip(people) {
            *sum += n;
        }
        fatal += u32::from(people[0] > 0);
        let entry = by_year.entry(year).or_default();
        entry[0] += 1;
        entry[1] += people[0];
    }
    json!({
        "annees": index.years, "accidents": total, "accidentsMortels": fatal,
        "tues": persons[0], "hospitalises": persons[1], "blessesLegers": persons[2], "indemnes": persons[3],
        "parAnnee": by_year.iter().map(|(y, v)| json!({ "annee": y, "accidents": v[0], "tues": v[1] })).collect::<Vec<_>>(),
    })
}

fn historic_monuments(zone: &Zone) -> Json2 {
    let Some(index) = monuments::index() else { return json!({ "erreur": "monuments pas encore chargés" }) };
    // Protection (voir `monuments::protection`) : 0 inscrit, 1 classé, 2 inscrit en partie, 3 classé en partie.
    let (mut total, mut classed) = (0u32, 0u32);
    for &(lon, lat, _, protection) in &index.points {
        if zone.contains(f64::from(lon), f64::from(lat)) {
            total += 1;
            classed += u32::from(protection == 1 || protection == 3);
        }
    }
    json!({ "total": total, "classes": classed, "inscrits": total - classed })
}

/// Distance à vol d'oiseau (km, formule de haversine).
fn haversine_km(a: [f64; 2], b: [f64; 2]) -> f64 {
    let (la1, la2) = (a[1].to_radians(), b[1].to_radians());
    let h = ((la2 - la1) / 2.0).sin().powi(2) + la1.cos() * la2.cos() * ((b[0] - a[0]).to_radians() / 2.0).sin().powi(2);
    12_742.0 * h.sqrt().asin()
}

fn stations_in(zone: &Zone, stations: &[crate::timetable::Station]) -> Json2 {
    let inside: Vec<&crate::timetable::Station> = stations.iter().filter(|s| zone.contains(s.lon, s.lat)).collect();
    let nearest = stations
        .iter()
        .map(|s| (haversine_km(zone.centre, [s.lon, s.lat]), s))
        .min_by(|a, b| a.0.total_cmp(&b.0));
    json!({
        "dans": inside.len(),
        "liste": inside.iter().take(12).map(|s| json!({ "nom": s.name, "lon": s.lon, "lat": s.lat })).collect::<Vec<_>>(),
        "plusProche": nearest.map(|(km, s)| json!({ "nom": s.name, "distanceKm": (km * 10.0).round() / 10.0, "lon": s.lon, "lat": s.lat, "dedans": zone.contains(s.lon, s.lat) })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(lon: f64, lat: f64, half: f64) -> Json2 {
        json!({ "type": "Polygon", "coordinates": [[[lon - half, lat - half], [lon + half, lat - half], [lon + half, lat + half], [lon - half, lat + half], [lon - half, lat - half]]] })
    }

    #[test]
    fn une_zone_se_lit_et_se_mesure() {
        // Un carré de 0,1° autour de Lyon : ~7,8 km (0,1° de longitude à 45,76° N) sur 11,1 km, ~86 km².
        let zone = Zone::parse(&square(4.83, 45.76, 0.05)).unwrap();
        assert!((zone.area_km2 - 86.5).abs() < 2.0, "{}", zone.area_km2);
        assert!(zone.contains(4.83, 45.76));
        assert!(!zone.contains(4.9, 45.76));
        assert!((zone.centre[0] - 4.83).abs() < 1e-9 && (zone.centre[1] - 45.76).abs() < 1e-9);
        // Une Feature GeoJSON est acceptée telle quelle.
        let feature = json!({ "type": "Feature", "properties": {}, "geometry": square(4.83, 45.76, 0.05) });
        assert!(Zone::parse(&feature).is_ok());
    }

    #[test]
    fn les_zones_invalides_sont_refusees() {
        assert!(Zone::parse(&json!({ "type": "Point", "coordinates": [2, 48] })).is_err());
        assert!(Zone::parse(&square(-60.0, 15.0, 0.1)).is_err(), "hors métropole");
        assert!(Zone::parse(&square(2.0, 47.0, 2.5)).unwrap_err().contains("trop grande"));
        assert!(Zone::parse(&json!({ "type": "Polygon", "coordinates": [[[2, 48], [2.1, 48]]] })).is_err());
    }

    #[test]
    fn un_trou_est_dehors() {
        let mut zone = Zone::parse(&square(2.0, 48.0, 0.2)).unwrap();
        // Ajoute un trou carré au milieu : `contains` doit alors dire « dehors » au centre et « dedans » dans l'anneau.
        zone.rings.push(vec![[1.95, 47.95], [2.05, 47.95], [2.05, 48.05], [1.95, 48.05]]);
        assert!(!zone.contains(2.0, 48.0));
        assert!(zone.contains(2.15, 48.0));
    }

    #[test]
    fn les_tuiles_touchees_suivent_le_contour() {
        let zone = Zone::parse(&square(4.83, 45.76, 0.05)).unwrap();
        let tiles = zone_tiles(&zone, 12, 0, 96).unwrap();
        // Une tuile de zoom 12 fait ~6,8 km sur 9,8 km à cette latitude : 2 ou 3 de large, 2 ou 3 de haut.
        assert!((4..=9).contains(&tiles.len()), "{}", tiles.len());
        assert!(zone_tiles(&zone, 12, 1, 96).unwrap().len() > tiles.len());
        // Un zoom trop fin pour le plafond est refusé, le choix du zoom redescend.
        assert!(zone_tiles(&zone, 17, 0, 96).is_none());
        let (z, _) = choose_zoom(&zone, (4, 17), 0, 96).unwrap();
        assert!((13..=15).contains(&z), "{z}");
    }

    #[test]
    fn le_rectangle_et_le_segment() {
        let r = [0.0, 0.0, 1.0, 1.0];
        assert!(segment_touches_rect([-1.0, 0.5], [2.0, 0.5], r), "traverse sans sommet dedans");
        assert!(!segment_touches_rect([-1.0, 2.0], [2.0, 2.0], r));
        assert!(segment_touches_rect([0.5, 0.5], [0.6, 0.6], r), "entièrement dedans");
    }

    #[test]
    fn histogramme_fusionne_et_quantiles() {
        // 100 ventes à 3 000 €/m² : la médiane est lue à la classe près (3,7 %).
        let mut hist = [0.0; BINS];
        hist[bin_of(3000.0)] += 100.0;
        let median = quantile(&hist, 0.5);
        assert!((median / 3000.0 - 1.0).abs() < 0.04, "{median}");
        // Un carreau décrit par ses quartiles (2 000 / 3 000 / 4 500) : sa médiane se retrouve.
        let mut hist = [0.0; BINS];
        spread(&mut hist, 40.0, 3000.0, 2000.0, 4500.0);
        assert!((quantile(&hist, 0.5) / 3000.0 - 1.0).abs() < 0.12);
        assert!((hist.iter().sum::<f64>() - 40.0).abs() < 1e-9);
        // Deux carreaux très différents : la médiane est celle des ventes, pas la moyenne des médianes (3 000 et 9 000).
        let mut hist = [0.0; BINS];
        spread(&mut hist, 90.0, 3000.0, 0.0, 0.0);
        spread(&mut hist, 10.0, 9000.0, 0.0, 0.0);
        assert!(quantile(&hist, 0.5) < 3300.0);
    }

    #[test]
    fn les_moments_d_un_polygone_coupe_en_deux_tuiles() {
        // Un carré de 1000 unités de côté, de x = 3596 à 4596 (monde) et de y = 100 à 1100, à cheval sur deux tuiles voisines
        // (bord à x = 4096). Chaque tuile en porte un morceau avec sa marge de 64 unités : celui de gauche va jusqu'à x = 4160,
        // celui de droite commence à x = -64 (monde 4032). Le centroïde reconstitué est le centre du carré, l'aire est conservée
        // (sans le découpage au carré strict, la bande de marge serait comptée deux fois).
        let mut pieces = Pieces::default();
        let west = vec![[3596, 100], [4160, 100], [4160, 1100], [3596, 1100]];
        let east = vec![[-64, 100], [500, 100], [500, 1100], [-64, 1100]];
        add_pieces(&mut pieces, &[west], [0.0, 0.0]);
        add_pieces(&mut pieces, &[east], [4096.0, 0.0]);
        assert!((pieces.area.abs() - 1_000_000.0).abs() < 1.0, "{}", pieces.area);
        let (cx, cy) = (pieces.mx / pieces.area, pieces.my / pieces.area);
        assert!((cx - 4096.0).abs() < 1.0, "{cx}");
        assert!((cy - 600.0).abs() < 1.0, "{cy}");
    }
}
