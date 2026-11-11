//! Publication des tuiles : fabrication en tâche de fond, archives en service, routes `/api/tuiles/…`.
//!
//! # Choix de service : le serveur Rust sert chaque tuile, adresse versionnée
//!
//! Deux voies étaient possibles pour que le site lise une archive PMTiles :
//!
//! 1. servir le fichier `.pmtiles` tel quel (requêtes `Range`) et laisser le navigateur le lire avec le paquet npm
//!    `pmtiles` (protocole `pmtiles://` de MapLibre) ;
//! 2. **lire l'archive côté serveur et servir chaque tuile à `/api/tuiles/{jeu}/{version}/{z}/{x}/{y}`** (retenu).
//!
//! Raisons : le site reste simple (une source `vector` MapLibre ordinaire, aucune dépendance de plus, et le paquet
//! `pmtiles` serait un code de plus à tenir à jour) ; le format de l'archive reste **interne** au serveur (on peut
//! le changer sans toucher au site) ; la `version` dans l'adresse rend chaque tuile *immuable* : cache de navigateur
//! d'un an (`immutable`), cache de n'importe quel intermédiaire, et une nouvelle fabrication change d'adresse, donc
//! aucune tuile périmée ne survit. L'archive se lit en positionné (`pread`), sans verrou ni copie en mémoire : le coût
//! d'une tuile est une lecture de quelques Ko dans le cache de fichiers du système. La tuile part telle que stockée
//! (déjà gzippée : `Content-Encoding: gzip`), sans recompression. Le prix : le serveur est sollicité pour chaque
//! tuile non encore en cache, là où des `Range` pourraient être servis par un CDN ; à notre échelle, c'est négligeable.
//!
//! - `GET /api/tuiles/{jeu}` : fiche du jeu (version, zooms, emprise, crédit, plages de valeurs pour les légendes) ;
//!   `503` avec `{"pret": false}` tant que la première fabrication n'est pas terminée. Jamais en cache.
//! - `GET /api/tuiles/{jeu}/{version}/{z}/{x}/{y}` : une tuile MVT gzippée ; `204` si elle est vide, `404` si la version est périmée.
//!
//! # Fabrication en tâche de fond
//!
//! Au démarrage, pour chaque jeu : si l'archive du millésime courant est dans `DATA_DIR/tuiles/`, elle est servie aussitôt.
//! Sinon, la source est téléchargée et l'archive fabriquée **dans un processus enfant** (`carte-vivante-serveur
//! --construire-tuiles <jeu>`) : toute la mémoire de la fabrication est rendue au système à sa fin, le serveur
//! ne garde que l'archive ouverte. Pendant ce temps, l'ancienne archive (d'un autre millésime) continue d'être servie.
//! Le fichier `DATA_DIR/tuiles/<jeu>.json` (millésime, schéma, nom de l'archive) est écrit en dernier : sans lui, rien n'est publié.
//! Une nouvelle fabrication n'a lieu que si le millésime de la source (`Dataset::source_id`) ou le schéma change.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use super::builder::{self, Options};
use super::pmtiles::Reader;
use super::population::Population;
use super::Dataset;

/// À augmenter si le *format* des archives change (au-delà de ce que `schema_version` d'un jeu couvre).
const FORMAT_VERSION: u32 = 1;

/// Une archive ouverte et sa fiche pour le site.
pub struct Archive {
    reader: Reader,
    version: String,
    sheet: serde_json::Value,
}

struct Served {
    dataset: Arc<dyn Dataset>,
    archive: RwLock<Option<Arc<Archive>>>,
    /// Fabrication en cours ? (pour répondre « en préparation » plutôt que « inconnu »)
    building: std::sync::atomic::AtomicBool,
}

struct Inner {
    sets: Vec<Served>,
    population: Arc<Population>,
}

/// Les jeux de données servis. Se clone à peu de frais (un pointeur).
#[derive(Clone)]
pub struct Registry(Arc<Inner>);

/// Les jeux de données du serveur : **c'est ici qu'on en ajoute un**.
fn datasets() -> (Vec<Arc<dyn Dataset>>, Arc<Population>) {
    let population = Arc::new(Population::new());
    (vec![population.clone() as Arc<dyn Dataset>], population)
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: String,
    source_id: String,
    schema: u32,
    format: u32,
    archive: String,
    tiles: u64,
    archive_bytes: u64,
    seconds: f32,
}

fn tiles_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("tuiles")
}

/// Empreinte stable (FNV-1a, 64 bits) : `DefaultHasher` ne promet pas la même valeur d'une version de Rust à l'autre.
fn fnv(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3))
}

fn version_of(dataset: &dyn Dataset) -> String {
    format!("{:012x}", fnv(&format!("{}|{}|{}|{}", dataset.id(), dataset.source_id(), dataset.schema_version(), FORMAT_VERSION)) & 0xffff_ffff_ffff)
}

impl Registry {
    pub fn new() -> Registry {
        let (sets, population) = datasets();
        Registry(Arc::new(Inner {
            sets: sets
                .into_iter()
                .map(|dataset| Served { dataset, archive: RwLock::new(None), building: std::sync::atomic::AtomicBool::new(false) })
                .collect(),
            population,
        }))
    }

    /// Le jeu des carreaux de population (la grille des isochrones en vient).
    pub fn population(&self) -> &Arc<Population> {
        &self.0.population
    }

    fn find(&self, id: &str) -> Option<&Served> {
        self.0.sets.iter().find(|s| s.dataset.id() == id)
    }

    /// Lance, pour chaque jeu, la mise en service de l'archive (et sa fabrication si elle manque).
    pub fn spawn(&self, http: reqwest::Client, data_dir: PathBuf) {
        for index in 0..self.0.sets.len() {
            let registry = self.clone();
            let (http, data_dir) = (http.clone(), data_dir.clone());
            tokio::spawn(async move { registry.maintain(index, http, data_dir).await });
        }
    }

    async fn maintain(&self, index: usize, http: reqwest::Client, data_dir: PathBuf) {
        let served = &self.0.sets[index];
        let dataset = served.dataset.clone();
        let id = dataset.id();
        match self.load(served, &data_dir) {
            Ok(true) => return,
            Ok(false) => {}
            Err(error) => warn!(jeu = id, "tuiles : archive existante inutilisable : {error:#}"),
        }
        served.building.store(true, std::sync::atomic::Ordering::Relaxed);
        loop {
            match self.build(&dataset, &http, &data_dir).await {
                Ok(()) => match self.load(served, &data_dir) {
                    Ok(true) => break,
                    Ok(false) => warn!(jeu = id, "tuiles : l'archive fabriquée n'est pas celle attendue"),
                    Err(error) => warn!(jeu = id, "tuiles : archive fabriquée illisible : {error:#}"),
                },
                Err(error) => warn!(jeu = id, "tuiles : fabrication échouée, nouvel essai dans une heure : {error:#}"),
            }
            tokio::time::sleep(Duration::from_secs(3600)).await;
        }
        served.building.store(false, std::sync::atomic::Ordering::Relaxed);
    }

    /// Télécharge la source puis lance la fabrication dans un processus enfant.
    ///
    /// Une seule fabrication à la fois, tous jeux confondus : chacune peut monter à ~150 Mo dans son processus
    /// enfant, et le conteneur partage 1 Go entre le serveur et ses enfants. Les autres jeux attendent leur tour
    /// (leur ancienne archive, s'il y en a une, reste servie).
    async fn build(&self, dataset: &Arc<dyn Dataset>, http: &reqwest::Client, data_dir: &Path) -> Result<()> {
        static ONE_BUILD_AT_A_TIME: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let _turn = ONE_BUILD_AT_A_TIME.acquire().await.context("file d'attente des fabrications")?;
        let source_dir = source_dir(data_dir, dataset.id());
        std::fs::create_dir_all(&source_dir)?;
        dataset.acquire(http, &source_dir).await.context("téléchargement de la source")?;
        let exe = std::env::current_exe().context("chemin de l'exécutable")?;
        let (id, data_dir) = (dataset.id(), data_dir.to_path_buf());
        info!(jeu = id, "tuiles : fabrication lancée (processus enfant)");
        let status = tokio::task::spawn_blocking(move || {
            std::process::Command::new(exe).arg("--construire-tuiles").arg(id).env("DATA_DIR", data_dir).status()
        })
        .await??;
        if !status.success() {
            bail!("le processus de fabrication s'est terminé en erreur ({status})");
        }
        Ok(())
    }

    /// Ouvre l'archive du millésime courant si elle est là. `Ok(false)` : il faut la fabriquer.
    fn load(&self, served: &Served, data_dir: &Path) -> Result<bool> {
        let dataset = &served.dataset;
        let dir = tiles_dir(data_dir);
        let Ok(text) = std::fs::read_to_string(dir.join(format!("{}.json", dataset.id()))) else { return Ok(false) };
        let manifest: Manifest = serde_json::from_str(&text).context("fiche de fabrication illisible")?;
        // Une autre source ou un autre schéma que ceux du code : l'archive est à refaire, mais l'ancienne reste servie en attendant.
        let current = manifest.version == version_of(dataset.as_ref());
        let path = dir.join(&manifest.archive);
        let reader = Reader::open(&path)?;
        let metadata = reader.metadata()?;
        let header = reader.header();
        let sheet = serde_json::json!({
            "pret": true,
            "jeu": dataset.id(),
            "version": manifest.version,
            "couche": dataset.layer(),
            "minzoom": header.min_zoom,
            "maxzoom": header.max_zoom,
            "emprise": header.bounds,
            "attribution": dataset.attribution(),
            "licence": dataset.license(),
            "champs": dataset.keys(),
            "tuiles": manifest.tiles,
            "octets": manifest.archive_bytes,
            "donnees": metadata["carte_vivante"],
        });
        dataset.load_extras(&dir, &manifest.version)?;
        let archive = Arc::new(Archive { reader, version: manifest.version.clone(), sheet });
        *served.archive.write().expect("verrou de l'archive") = Some(archive);
        info!(jeu = dataset.id(), version = %manifest.version, octets = manifest.archive_bytes, perimee = !current, "tuiles : archive en service");
        if !current {
            return Ok(false);
        }
        // Les archives des millésimes précédents ne servent plus.
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(&format!("{}-", dataset.id())) && !name.contains(&manifest.version) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        Ok(true)
    }
}

impl Default for Registry {
    fn default() -> Self {
        Registry::new()
    }
}

fn source_dir(data_dir: &Path, id: &str) -> PathBuf {
    data_dir.join("sources-tuiles").join(id)
}

// ---------------------------------------------------------------------------------------------
// Processus enfant : `carte-vivante-serveur --construire-tuiles <jeu>`
// ---------------------------------------------------------------------------------------------

/// Si le programme a été lancé pour fabriquer des tuiles, le fait et rend le code de sortie.
pub fn run_build_command(args: &[String]) -> Option<i32> {
    let position = args.iter().position(|a| a == "--construire-tuiles")?;
    let Some(id) = args.get(position + 1) else {
        eprintln!("usage : carte-vivante-serveur --construire-tuiles <jeu>");
        return Some(2);
    };
    let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "../data".into()));
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();
    match build_dataset(id, &data_dir) {
        Ok(()) => Some(0),
        Err(error) => {
            eprintln!("fabrication des tuiles « {id} » échouée : {error:#}");
            Some(1)
        }
    }
}

fn build_dataset(id: &str, data_dir: &Path) -> Result<()> {
    let (sets, _) = datasets();
    let dataset = sets.into_iter().find(|d| d.id() == id).with_context(|| format!("jeu inconnu : {id}"))?;
    let dir = tiles_dir(data_dir);
    std::fs::create_dir_all(&dir)?;
    let version = version_of(dataset.as_ref());
    let archive = format!("{id}-{version}.pmtiles");
    let report = builder::build(
        dataset.as_ref(),
        &source_dir(data_dir, id),
        &dir.join(format!("travail-{id}")),
        &dir.join(&archive),
        &Options::default(),
    )?;
    dataset.finish(&dir, &version)?;
    info!(
        jeu = id,
        objets = report.features,
        tuiles = report.tiles,
        uniques = report.unique_tiles,
        archive_mo = report.archive_bytes / 1_048_576,
        plafonnees = report.capped_tiles,
        secondes = report.seconds,
        "tuiles : fabrication terminée"
    );
    // La fiche est écrite en dernier, de façon atomique : le serveur ne voit jamais d'archive à moitié prête.
    let manifest = Manifest {
        version,
        source_id: dataset.source_id(),
        schema: dataset.schema_version(),
        format: FORMAT_VERSION,
        archive,
        tiles: report.tiles,
        archive_bytes: report.archive_bytes,
        seconds: report.seconds,
    };
    let partial = dir.join(format!("{id}.json.partiel"));
    std::fs::write(&partial, serde_json::to_vec_pretty(&manifest)?)?;
    std::fs::rename(&partial, dir.join(format!("{id}.json")))?;
    // La source téléchargée reste dans DATA_DIR (une refabrication ne la retélécharge pas) sauf demande contraire.
    if std::env::var_os("TUILES_EFFACER_SOURCES").is_some() {
        let _ = std::fs::remove_dir_all(source_dir(data_dir, id));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/// Les routes `/api/tuiles/…`, à fusionner dans le routeur de l'API.
pub fn router<S: Clone + Send + Sync + 'static>(registry: Registry) -> Router<S> {
    Router::<Registry>::new()
        .route("/api/tuiles/{jeu}", get(sheet))
        .route("/api/tuiles/{jeu}/{version}/{z}/{x}/{y}", get(tile))
        .with_state(registry)
}

async fn sheet(State(registry): State<Registry>, UrlPath(id): UrlPath<String>) -> Response {
    let Some(served) = registry.find(&id) else { return (StatusCode::NOT_FOUND, "jeu de tuiles inconnu").into_response() };
    let no_cache = [(header::CACHE_CONTROL, "no-cache")];
    match served.archive.read().expect("verrou de l'archive").as_ref() {
        Some(archive) => (no_cache, axum::Json(archive.sheet.clone())).into_response(),
        None => {
            let building = served.building.load(std::sync::atomic::Ordering::Relaxed);
            (StatusCode::SERVICE_UNAVAILABLE, no_cache, axum::Json(serde_json::json!({ "pret": false, "enCours": building }))).into_response()
        }
    }
}

async fn tile(State(registry): State<Registry>, UrlPath((id, version, z, x, y)): UrlPath<(String, String, u8, u32, u32)>) -> Response {
    let Some(served) = registry.find(&id) else { return (StatusCode::NOT_FOUND, "jeu de tuiles inconnu").into_response() };
    let archive = served.archive.read().expect("verrou de l'archive").clone();
    let Some(archive) = archive.filter(|a| a.version == version) else {
        return (StatusCode::NOT_FOUND, "version des tuiles périmée : relire /api/tuiles/").into_response();
    };
    if z > 24 || x >= 1 << z || y >= 1 << z {
        return (StatusCode::BAD_REQUEST, "tuile hors du monde").into_response();
    }
    match archive.reader.tile(z, x, y) {
        Ok(Some(bytes)) => (
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("application/vnd.mapbox-vector-tile")),
                (header::CONTENT_ENCODING, HeaderValue::from_static("gzip")),
                (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=31536000, immutable")),
            ],
            bytes,
        )
            .into_response(),
        // Pas de tuile : le plus souvent la mer ou une zone sans donnée. Vide, mais cachable aussi.
        Ok(None) => (StatusCode::NO_CONTENT, [(header::CACHE_CONTROL, "public, max-age=31536000, immutable")]).into_response(),
        Err(error) => {
            warn!("tuiles : lecture de {id}/{z}/{x}/{y} impossible : {error:#}");
            (StatusCode::INTERNAL_SERVER_ERROR, "lecture de la tuile impossible").into_response()
        }
    }
}
