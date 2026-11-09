//! Voies ferrées d'OpenStreetMap : téléchargement (API Overpass), graphe des voies,
//! et chemin réel entre deux points (plus court chemin sur les rails, algorithme A*).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use tracing::info;

const OVERPASS_URL: &str = "https://overpass-api.de/api/interpreter";

type BBox = (f64, f64, f64, f64); // sud, ouest, nord, est

/// La France métropolitaine découpée en 6 rectangles, pour des requêtes de taille raisonnable.
const FRANCE_TILES: [BBox; 6] = [
    (41.3, -5.2, 46.2, 0.0),
    (41.3, 0.0, 46.2, 4.8),
    (41.3, 4.8, 46.2, 9.6),
    (46.2, -5.2, 51.15, 0.0),
    (46.2, 0.0, 51.15, 4.8),
    (46.2, 4.8, 51.15, 9.6),
];

/// Zones frontalières où roulent des trains français (TER transfrontaliers, TGV, Léman Express…).
const BORDER_ZONES: [(&str, BBox); 7] = [
    ("suisse", (45.9, 5.8, 47.7, 7.9)),
    ("luxembourg-sarre", (49.0, 5.7, 50.2, 7.3)),
    ("allemagne-sud-ouest", (48.3, 7.3, 50.2, 9.3)),
    ("belgique", (50.3, 2.6, 51.0, 4.5)),
    ("italie", (43.7, 6.6, 45.6, 9.3)),
    ("catalogne", (41.3, 1.9, 42.5, 3.3)),
    ("pays-basque", (43.2, -2.0, 43.4, -1.7)),
];

/// Sans voies de garage, de triage ni embranchements industriels (mais avec les liaisons entre voies).
const FILTERS: &str = r#"["service"!~"^(siding|yard|spur)$"]["usage"!~"^(industrial|military|tourism|test)$"]"#;
const FRANCE_AREA: &str = r#"area["ISO3166-1"="FR"]["admin_level"="2"]->.fr;"#;
const OUTPUT: &str = "->.w;.w out body qt;node(w.w);out skel qt;";

/// Un fichier à télécharger : son nom dans le cache et sa requête Overpass.
struct Download {
    name: String,
    query: String,
}

fn downloads() -> Vec<Download> {
    let header = "[out:json][timeout:900];";
    let mut list: Vec<Download> = FRANCE_TILES
        .iter()
        .enumerate()
        .map(|(i, (s, w, n, e))| Download {
            name: format!("france-{i}"),
            query: format!(r#"{header}{FRANCE_AREA}way["railway"="rail"]{FILTERS}(area.fr)({s},{w},{n},{e}){OUTPUT}"#),
        })
        .collect();
    // Voies métriques (Saint-Gervais–Chamonix…), de tram et de métro léger (trams-trains en ville).
    list.push(Download {
        name: "france-autres-voies".into(),
        query: format!(r#"{header}{FRANCE_AREA}way["railway"~"^(narrow_gauge|light_rail|tram)$"]{FILTERS}(area.fr){OUTPUT}"#),
    });
    for (zone, (s, w, n, e)) in BORDER_ZONES {
        list.push(Download {
            name: format!("frontiere-{zone}"),
            query: format!(r#"{header}way["railway"~"^(rail|narrow_gauge|light_rail|tram)$"]{FILTERS}({s},{w},{n},{e}){OUTPUT}"#),
        });
    }
    list
}

/// Ouvrage d'art sur un tronçon : l'altitude du sol ne s'y applique pas.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Structure {
    None = 0,
    Tunnel = 1,
    Bridge = 2,
}

/// Le réseau ferré sous forme de graphe : un sommet par point OSM, une arête par
/// portion de voie entre deux points. Stockage « CSR » compact : les voisins du
/// sommet `n` sont `targets[offsets[n]..offsets[n + 1]]`.
pub struct RailGraph {
    pub lon: Vec<f64>,
    pub lat: Vec<f64>,
    offsets: Vec<u32>,
    targets: Vec<u32>,
    lengths: Vec<f32>,
    structures: Vec<Structure>,
    /// Index spatial : sommets par case de grille.
    grid: HashMap<(i32, i32), Vec<u32>>,
    /// Nombre de sommets du réseau connexe de chaque sommet.
    component_size: Vec<u32>,
}

/// Au-delà de cette taille, un réseau connexe fait partie du grand réseau national.
pub const MAIN_NETWORK_NODES: u32 = 50_000;

const GRID_DEG: f64 = 0.005; // environ 500 m

fn cell(lon: f64, lat: f64) -> (i32, i32) {
    ((lon / GRID_DEG).floor() as i32, (lat / GRID_DEG).floor() as i32)
}

/// Distance en mètres (approximation équirectangulaire, précise à quelques mètres près sur quelques dizaines de km).
pub fn distance_m(lon1: f64, lat1: f64, lon2: f64, lat2: f64) -> f64 {
    let mean_lat = ((lat1 + lat2) / 2.0).to_radians();
    let dx = (lon2 - lon1) * mean_lat.cos() * 111_320.0;
    let dy = (lat2 - lat1) * 110_540.0;
    (dx * dx + dy * dy).sqrt()
}

/// Un chemin trouvé sur les rails.
pub struct RailPath {
    pub nodes: Vec<u32>,
    /// Ouvrage de chaque arête (`nodes.len() - 1` valeurs).
    pub structures: Vec<Structure>,
    pub length_m: f64,
}

impl RailGraph {
    pub fn node_count(&self) -> usize {
        self.lon.len()
    }

    /// Sommets proches d'un point : le plus proche, plus ceux à moins de `slack_m` de plus.
    /// Utile aux grandes gares, où plusieurs lignes passent à côté du point de la gare.
    /// Seuls les réseaux connexes d'au moins `min_component` sommets sont retenus.
    pub fn candidates(&self, lon: f64, lat: f64, max_m: f64, slack_m: f64, min_component: u32) -> Vec<(u32, f64)> {
        let (cx, cy) = cell(lon, lat);
        let reach = (max_m / 350.0).ceil() as i32; // une case fait au moins ~350 m de large en France
        let mut found = Vec::new();
        for dx in -reach..=reach {
            for dy in -reach..=reach {
                for &node in self.grid.get(&(cx + dx, cy + dy)).into_iter().flatten() {
                    if self.component_size[node as usize] < min_component {
                        continue;
                    }
                    let d = distance_m(lon, lat, self.lon[node as usize], self.lat[node as usize]);
                    if d <= max_m {
                        found.push((node, d));
                    }
                }
            }
        }
        found.sort_by(|a, b| a.1.total_cmp(&b.1));
        if let Some(&(_, best)) = found.first() {
            found.retain(|&(_, d)| d <= best + slack_m);
            found.truncate(12);
        }
        found
    }

    /// Plus court chemin sur les rails d'un ensemble de départs vers un ensemble d'arrivées
    /// (chaque candidat avec sa distance à la gare). A* : on explore d'abord les sommets
    /// qui semblent mener le plus vite à l'arrivée, à vol d'oiseau.
    pub fn shortest_path(&self, from: &[(u32, f64)], to: &[(u32, f64)], max_length_m: f64, search: &mut Search) -> Option<RailPath> {
        let (&(first_goal, _), _) = to.split_first()?;
        let goal_lon = self.lon[first_goal as usize];
        let goal_lat = self.lat[first_goal as usize];
        let goals: HashMap<u32, f64> = to.iter().copied().collect();
        let heuristic = |n: u32| distance_m(self.lon[n as usize], self.lat[n as usize], goal_lon, goal_lat) * 0.95;

        search.reset(self.node_count());
        let mut heap = BinaryHeap::new();
        for &(node, snap) in from {
            search.relax(node, snap as f32, u32::MAX);
            heap.push(Reverse((OrderedF32((snap + heuristic(node)) as f32), node)));
        }

        let mut visited = 0usize;
        while let Some(Reverse((_, node))) = heap.pop() {
            // Un sommet peut être dans la file plusieurs fois : on ne le traite qu'une.
            if !search.close(node) {
                continue;
            }
            let g = search.cost(node);
            if let Some(&snap) = goals.get(&node) {
                return Some(self.reconstruct(node, g as f64 + snap, search));
            }
            visited += 1;
            // Limite d'exploration, plus large pour les longs trajets sans arrêt (Bordeaux–Paris…).
            if visited > (max_length_m * 8.0).max(400_000.0) as usize || g as f64 > max_length_m {
                return None; // réseau coupé entre les deux gares : on abandonne
            }
            let (start, end) = (self.offsets[node as usize] as usize, self.offsets[node as usize + 1] as usize);
            for e in start..end {
                let next = self.targets[e];
                let candidate = g + self.lengths[e];
                if search.relax(next, candidate, node) {
                    heap.push(Reverse((OrderedF32(candidate + heuristic(next) as f32), next)));
                }
            }
        }
        None
    }

    fn reconstruct(&self, end: u32, length_m: f64, search: &Search) -> RailPath {
        let mut nodes = vec![end];
        let mut node = end;
        while let Some(parent) = search.parent(node) {
            nodes.push(parent);
            node = parent;
        }
        nodes.reverse();
        let structures = nodes.windows(2).map(|pair| self.structure_between(pair[0], pair[1])).collect();
        RailPath { nodes, structures, length_m }
    }

    fn structure_between(&self, a: u32, b: u32) -> Structure {
        let (start, end) = (self.offsets[a as usize] as usize, self.offsets[a as usize + 1] as usize);
        (start..end).find(|&e| self.targets[e] == b).map_or(Structure::None, |e| self.structures[e])
    }
}

/// Mémoire de travail d'A*, réutilisée d'une recherche à l'autre pour éviter
/// d'allouer des millions de cases à chaque fois.
#[derive(Default)]
pub struct Search {
    cost: Vec<f32>,
    parent: Vec<u32>,
    /// Numéro de la recherche qui a écrit `cost` / `parent` : évite de tout remettre à zéro.
    stamp: Vec<u32>,
    /// Numéro de la recherche qui a fini de traiter le sommet.
    closed: Vec<u32>,
    generation: u32,
}

impl Search {
    fn reset(&mut self, size: usize) {
        if self.stamp.len() != size {
            self.cost = vec![0.0; size];
            self.parent = vec![u32::MAX; size];
            self.stamp = vec![0; size];
            self.closed = vec![0; size];
            self.generation = 0;
        }
        self.generation += 1;
    }

    /// Marque le sommet comme traité. Renvoie faux s'il l'était déjà.
    fn close(&mut self, node: u32) -> bool {
        let i = node as usize;
        if self.closed[i] == self.generation {
            return false;
        }
        self.closed[i] = self.generation;
        true
    }

    fn cost(&self, node: u32) -> f32 {
        if self.stamp[node as usize] == self.generation { self.cost[node as usize] } else { f32::INFINITY }
    }

    fn parent(&self, node: u32) -> Option<u32> {
        let parent = self.parent[node as usize];
        (self.stamp[node as usize] == self.generation && parent != u32::MAX).then_some(parent)
    }

    /// Enregistre un meilleur coût pour `node`. Renvoie vrai si c'est une amélioration.
    fn relax(&mut self, node: u32, cost: f32, parent: u32) -> bool {
        if cost < self.cost(node) {
            let i = node as usize;
            self.cost[i] = cost;
            self.parent[i] = parent;
            self.stamp[i] = self.generation;
            true
        } else {
            false
        }
    }
}

/// Un flottant comparable (ordre total), pour la file de priorité d'A*.
#[derive(Clone, Copy, PartialEq)]
struct OrderedF32(f32);
impl Eq for OrderedF32 {}
impl PartialOrd for OrderedF32 {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for OrderedF32 {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        self.0.total_cmp(&other.0)
    }
}

// --- Téléchargement et lecture ---

fn download_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.json"))
}

/// Télécharge les fichiers manquants (quelques minutes la première fois, ensuite rien).
pub async fn ensure_downloaded(http: &reqwest::Client, dir: &Path) -> Result<()> {
    tokio::fs::create_dir_all(dir).await?;
    let list = downloads();
    let total = list.len();
    for (index, download) in list.into_iter().enumerate() {
        let path = download_path(dir, &download.name);
        if tokio::fs::metadata(&path).await.is_ok_and(|m| m.len() > 0) {
            continue;
        }
        info!(fichier = %download.name, numero = index + 1, total, "téléchargement des voies ferrées OSM…");
        let bytes = overpass(http, &download.query).await.with_context(|| format!("voies « {} »", download.name))?;
        let tmp = path.with_extension("json.part");
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::rename(&tmp, &path).await?;
        tokio::time::sleep(Duration::from_secs(5)).await; // politesse envers le service gratuit
    }
    Ok(())
}

/// Overpass est un service gratuit souvent saturé : on réessaie en doublant l'attente
/// à chaque échec (30 s, 1 min, 2 min…), comme il le demande.
async fn overpass(http: &reqwest::Client, query: &str) -> Result<Vec<u8>> {
    let body = format!("data={}", form_encode(query));
    let mut wait = Duration::from_secs(30);
    for attempt in 1..=6 {
        let result = async {
            let response = http
                .post(OVERPASS_URL)
                .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
                .timeout(Duration::from_secs(1_000))
                .body(body.clone())
                .send()
                .await?
                .error_for_status()?;
            let bytes = response.bytes().await?;
            if !bytes.starts_with(b"{") || !bytes.windows(10).take(4_000).any(|w| w == b"\"elements\"") {
                bail!("réponse inattendue (service saturé ?)");
            }
            Ok(bytes.to_vec())
        }
        .await;
        match result {
            Ok(bytes) => return Ok(bytes),
            Err(error) if attempt < 6 => {
                tracing::warn!("Overpass : {error:#} ; nouvel essai dans {} s", wait.as_secs());
                tokio::time::sleep(wait).await;
                wait *= 2;
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("la boucle se termine toujours par un retour")
}

fn form_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[derive(Deserialize)]
struct OverpassResponse {
    elements: Vec<Element>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Node,
    Way,
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
struct Element {
    #[serde(rename = "type")]
    kind: Kind,
    id: i64,
    #[serde(default)]
    lat: f64,
    #[serde(default)]
    lon: f64,
    #[serde(default)]
    nodes: Vec<i64>,
    #[serde(default)]
    tags: Tags,
}

#[derive(Deserialize, Default)]
struct Tags {
    tunnel: Option<String>,
    bridge: Option<String>,
}

impl Tags {
    fn structure(&self) -> Structure {
        let yes = |v: &Option<String>| v.as_deref().is_some_and(|v| v != "no");
        if yes(&self.tunnel) {
            Structure::Tunnel
        } else if yes(&self.bridge) {
            Structure::Bridge
        } else {
            Structure::None
        }
    }
}

/// Lit les morceaux téléchargés et construit le graphe (quelques secondes).
pub fn load(dir: &Path) -> Result<RailGraph> {
    let mut index: HashMap<i64, u32> = HashMap::new();
    let mut lon = Vec::new();
    let mut lat = Vec::new();
    let mut ways: Vec<(Vec<i64>, Structure)> = Vec::new();
    let mut seen_ways = HashSet::new();

    for download in downloads() {
        let path = download_path(dir, &download.name);
        let bytes = std::fs::read(&path).with_context(|| format!("lecture de {}", path.display()))?;
        let response: OverpassResponse = serde_json::from_slice(&bytes).with_context(|| format!("{} illisible", path.display()))?;
        for element in response.elements {
            match element.kind {
                Kind::Node => {
                    index.entry(element.id).or_insert_with(|| {
                        lon.push(element.lon);
                        lat.push(element.lat);
                        (lon.len() - 1) as u32
                    });
                }
                Kind::Way if seen_ways.insert(element.id) => ways.push((element.nodes, element.tags.structure())),
                _ => {}
            }
        }
    }

    // Arêtes dans les deux sens (les voies se parcourent dans les deux sens).
    let mut edges: Vec<(u32, u32, f32, Structure)> = Vec::new();
    for (nodes, structure) in &ways {
        for pair in nodes.windows(2) {
            let (Some(&a), Some(&b)) = (index.get(&pair[0]), index.get(&pair[1])) else { continue };
            if a == b {
                continue;
            }
            let length = distance_m(lon[a as usize], lat[a as usize], lon[b as usize], lat[b as usize]) as f32;
            edges.push((a, b, length, *structure));
            edges.push((b, a, length, *structure));
        }
    }
    edges.sort_unstable_by_key(|e| e.0);

    let mut offsets = vec![0u32; lon.len() + 1];
    for &(a, ..) in &edges {
        offsets[a as usize + 1] += 1;
    }
    for i in 0..lon.len() {
        offsets[i + 1] += offsets[i];
    }
    let targets = edges.iter().map(|e| e.1).collect();
    let lengths = edges.iter().map(|e| e.2).collect();
    let structures = edges.iter().map(|e| e.3).collect();

    // Les gares ne s'accrochent qu'aux grands réseaux connexes : un bout de voie isolé
    // (voie à quai dont les aiguillages sont classés « garage », par exemple) mènerait
    // à une impasse.
    let component_size = component_sizes(lon.len(), &edges);
    let mut grid: HashMap<(i32, i32), Vec<u32>> = HashMap::new();
    let mut isolated = 0;
    for node in 0..lon.len() {
        if offsets[node + 1] == offsets[node] {
            continue;
        }
        if component_size[node] < MIN_COMPONENT_NODES {
            isolated += 1;
            continue;
        }
        grid.entry(cell(lon[node], lat[node])).or_default().push(node as u32);
    }

    info!(points = lon.len(), troncons = ways.len(), points_isoles = isolated, "graphe des voies prêt");
    Ok(RailGraph { lon, lat, offsets, targets, lengths, structures, grid, component_size })
}

/// Taille minimale d'un réseau connexe pour qu'une gare puisse s'y accrocher.
pub const MIN_COMPONENT_NODES: u32 = 100;

/// Pour chaque sommet, le nombre de sommets de son réseau connexe (union-find).
fn component_sizes(count: usize, edges: &[(u32, u32, f32, Structure)]) -> Vec<u32> {
    let mut parent: Vec<u32> = (0..count as u32).collect();
    fn find(parent: &mut [u32], mut node: u32) -> u32 {
        while parent[node as usize] != node {
            let grandparent = parent[parent[node as usize] as usize];
            parent[node as usize] = grandparent; // raccourcit le chemin au passage
            node = grandparent;
        }
        node
    }
    for &(a, b, ..) in edges {
        let (root_a, root_b) = (find(&mut parent, a), find(&mut parent, b));
        if root_a != root_b {
            parent[root_a as usize] = root_b;
        }
    }
    let roots: Vec<u32> = (0..count as u32).map(|n| find(&mut parent, n)).collect();
    let mut sizes = vec![0u32; count];
    for &root in &roots {
        sizes[root as usize] += 1;
    }
    roots.iter().map(|&root| sizes[root as usize]).collect()
}
