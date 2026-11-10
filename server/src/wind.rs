//! Vent : champ de vent à 10 m sur la France et ses abords, pour l'heure actuelle et
//! quelques heures avant et après.
//!
//! Source : Open-Meteo (https://open-meteo.com), API gratuite sans clé, qui diffuse le modèle
//! ARPEGE Europe de Météo-France (`models=meteofrance_arpege_europe`). On l'interroge sur une
//! grille régulière de points ; le navigateur interpole entre les points et entre les heures.
//!
//! Conditions de l'API gratuite (vérifiées sur https://open-meteo.com/en/pricing) : usage non
//! commercial, attribution CC BY 4.0, et 600 appels par minute, 5 000 par heure, 10 000 par
//! jour, 300 000 par mois. **Chaque point d'une requête compte pour un appel** (l'en-tête
//! `X-RateLimit-Cost` le confirme : 2 points = coût 2). D'où ces choix :
//! - une grille de 0,5° (34 × 22 = 748 points) et non de 0,25° (près de 2 800 points, ce qui
//!   épuiserait à lui seul le quota mensuel avec une collecte toutes les 6 h) ;
//! - une seule collecte toutes les 6 h (4 par jour, soit environ 90 000 appels par mois, un
//!   tiers du quota) : chaque collecte ramène déjà 6 h de passé et 24 h de prévision ;
//! - des requêtes de 100 points espacées de 15 s (400 appels par minute au plus) ;
//! - le champ est gardé sur disque : un redémarrage du serveur ne recommence pas la collecte
//!   tant que le fichier a moins de 6 h ;
//! - après un échec, on garde les anciennes données et on attend de plus en plus longtemps
//!   (15 min, puis le double, jusqu'à 3 h) avant de réessayer.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{info, warn};

use crate::state::AppState;

const API_URL: &str = "https://api.open-meteo.com/v1/forecast";
const MODEL: &str = "meteofrance_arpege_europe";
/// Zone couverte : la France métropolitaine (Corse comprise) et ses abords.
const WEST: f64 = -6.0;
const SOUTH: f64 = 41.0;
const EAST: f64 = 10.5;
const NORTH: f64 = 51.5;
/// Pas de la grille, en degrés (même pas en longitude et en latitude).
const STEP: f64 = 0.5;
const PAST_HOURS: u32 = 6;
const FORECAST_HOURS: u32 = 24;
/// Points par requête : l'adresse reste courte (moins de 2 000 caractères).
const POINTS_PER_REQUEST: usize = 100;
const PAUSE_BETWEEN_REQUESTS: Duration = Duration::from_secs(15);
const REFRESH_EVERY: Duration = Duration::from_secs(6 * 3600);
const FIRST_RETRY: Duration = Duration::from_secs(15 * 60);
const MAX_RETRY: Duration = Duration::from_secs(3 * 3600);
/// Valeurs absentes tolérées dans une collecte, en proportion (au-delà, on garde l'ancienne).
const MAX_MISSING_RATIO: f64 = 0.02;
/// Les composantes du vent sont servies en dixièmes de mètre par seconde.
const UNIT: f64 = 0.1;

/// Géométrie de la grille : points rangés ligne par ligne, du sud au nord et de l'ouest à l'est.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Grid {
    west: f64,
    south: f64,
    step: f64,
    nx: usize,
    ny: usize,
}

impl Grid {
    fn standard() -> Self {
        let count = |from: f64, to: f64| ((to - from) / STEP).round() as usize + 1;
        Self { west: WEST, south: SOUTH, step: STEP, nx: count(WEST, EAST), ny: count(SOUTH, NORTH) }
    }

    fn points(&self) -> Vec<(f64, f64)> {
        let mut points = Vec::with_capacity(self.nx * self.ny);
        for j in 0..self.ny {
            for i in 0..self.nx {
                points.push((self.south + j as f64 * self.step, self.west + i as f64 * self.step));
            }
        }
        points
    }
}

/// Réponse de l'API `/api/vent`.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindField {
    /// Heure de la collecte (secondes UTC).
    generated_at: i64,
    grid: Grid,
    /// Valeur d'une unité des tableaux `u` et `v`, en m/s.
    unit: f64,
    /// Heures (secondes UTC, pleines) des champs servis.
    times: Vec<i64>,
    /// Pour chaque heure, une valeur par point de la grille : composante vers l'est (`u`)
    /// et vers le nord (`v`) du vent, en `unit` m/s.
    u: Vec<Vec<i16>>,
    v: Vec<Vec<i16>>,
}

/// Les heures d'un point, telles que l'API les renvoie (valeurs absentes = `None`).
#[derive(Debug)]
struct Series {
    times: Vec<i64>,
    speed: Vec<Option<f64>>,
    direction: Vec<Option<f64>>,
}

pub async fn poll_forever(http: reqwest::Client, data_dir: PathBuf, state: AppState) {
    let cache = data_dir.join("vent").join("champ.json");
    let mut wait = Duration::ZERO;
    if let Some((body, generated_at)) = read_cache(&cache).await {
        let age = (Timestamp::now().as_second() - generated_at).max(0) as u64;
        info!(age_min = age / 60, "vent : champ relu depuis le disque");
        state.set_wind(body);
        wait = REFRESH_EVERY.saturating_sub(Duration::from_secs(age));
    }
    let mut retry = FIRST_RETRY;
    loop {
        tokio::time::sleep(wait).await;
        match collect(&http).await {
            Ok(field) => {
                let body = match serde_json::to_vec(&field) {
                    Ok(body) => body,
                    Err(error) => {
                        warn!("vent : champ non sérialisable : {error}");
                        continue;
                    }
                };
                if let Err(error) = write_cache(&cache, &body).await {
                    warn!("vent : champ non enregistré sur disque : {error:#}");
                }
                info!(
                    points = field.grid.nx * field.grid.ny,
                    heures = field.times.len(),
                    octets = body.len(),
                    "vent : champ collecté"
                );
                state.set_wind(body);
                retry = FIRST_RETRY;
                wait = REFRESH_EVERY;
            }
            Err(error) => {
                warn!("vent : collecte échouée, nouvel essai dans {} min : {error:#}", retry.as_secs() / 60);
                wait = retry;
                retry = (retry * 2).min(MAX_RETRY);
            }
        }
    }
}

/// Le fichier du disque, s'il est lisible : la réponse prête à servir et son heure de collecte.
async fn read_cache(path: &Path) -> Option<(Vec<u8>, i64)> {
    let body = tokio::fs::read(path).await.ok()?;
    let field: WindField = serde_json::from_slice(&body).ok()?;
    let nx_ny = field.grid.nx * field.grid.ny;
    let consistent = !field.times.is_empty()
        && field.u.len() == field.times.len()
        && field.v.len() == field.times.len()
        && field.u.iter().chain(&field.v).all(|hour| hour.len() == nx_ny);
    consistent.then_some((body, field.generated_at))
}

/// Écriture atomique : on n'a jamais un fichier à moitié écrit après un arrêt brutal.
async fn write_cache(path: &Path, body: &[u8]) -> Result<()> {
    let dir = path.parent().context("dossier du cache")?;
    tokio::fs::create_dir_all(dir).await?;
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, body).await?;
    tokio::fs::rename(&temporary, path).await?;
    Ok(())
}

/// Interroge l'API point par point (par paquets) et assemble le champ.
async fn collect(http: &reqwest::Client) -> Result<WindField> {
    let grid = Grid::standard();
    let points = grid.points();
    let mut all: Vec<Series> = Vec::with_capacity(points.len());
    for (index, chunk) in points.chunks(POINTS_PER_REQUEST).enumerate() {
        if index > 0 {
            tokio::time::sleep(PAUSE_BETWEEN_REQUESTS).await;
        }
        let latitudes = chunk.iter().map(|p| format!("{:.2}", p.0)).collect::<Vec<_>>().join(",");
        let longitudes = chunk.iter().map(|p| format!("{:.2}", p.1)).collect::<Vec<_>>().join(",");
        // Nombres et noms sans caractère à échapper : on écrit l'adresse à la main.
        let url = format!(
            "{API_URL}?latitude={latitudes}&longitude={longitudes}&hourly=wind_speed_10m,wind_direction_10m\
             &wind_speed_unit=ms&models={MODEL}&timezone=GMT&timeformat=unixtime\
             &past_hours={PAST_HOURS}&forecast_hours={FORECAST_HOURS}"
        );
        let response = http
            .get(url)
            .timeout(Duration::from_secs(60))
            .send()
            .await
            .context("requête Open-Meteo")?;
        let status = response.status();
        if !status.is_success() {
            let detail = response.text().await.unwrap_or_default();
            bail!("Open-Meteo a répondu {status} : {}", detail.chars().take(200).collect::<String>());
        }
        let json: Value = serde_json::from_slice(&response.bytes().await?).context("réponse Open-Meteo illisible")?;
        all.extend(parse_response(&json, chunk.len())?);
    }
    assemble(grid, &all, Timestamp::now().as_second())
}

/// Décode une réponse d'Open-Meteo : une liste d'objets, ou un objet seul quand il n'y avait qu'un point.
fn parse_response(json: &Value, expected: usize) -> Result<Vec<Series>> {
    let items: Vec<&Value> = match json {
        Value::Array(items) => items.iter().collect(),
        object => vec![object],
    };
    ensure!(items.len() == expected, "{} points reçus au lieu de {expected}", items.len());
    items
        .into_iter()
        .map(|item| {
            let hourly = &item["hourly"];
            let times = hourly["time"]
                .as_array()
                .context("heures absentes")?
                .iter()
                .map(|t| t.as_i64().context("heure illisible"))
                .collect::<Result<Vec<_>>>()?;
            let count = times.len();
            let values = |key: &str| -> Result<Vec<Option<f64>>> {
                let list = hourly[key].as_array().with_context(|| format!("{key} absent"))?;
                ensure!(list.len() == count, "{key} : {} valeurs pour {count} heures", list.len());
                Ok(list.iter().map(Value::as_f64).collect())
            };
            Ok(Series { speed: values("wind_speed_10m")?, direction: values("wind_direction_10m")?, times })
        })
        .collect()
}

/// Composantes (vers l'est, vers le nord) d'un vent donné par sa vitesse et la direction d'où il souffle.
fn components(speed: f64, from_degrees: f64) -> (f64, f64) {
    let angle = from_degrees.to_radians();
    (-speed * angle.sin(), -speed * angle.cos())
}

fn quantize(value: f64) -> i16 {
    (value / UNIT).round().clamp(f64::from(i16::MIN), f64::from(i16::MAX)) as i16
}

/// Range les séries de tous les points en un champ par heure.
fn assemble(grid: Grid, series: &[Series], now: i64) -> Result<WindField> {
    ensure!(series.len() == grid.nx * grid.ny, "{} points au lieu de {}", series.len(), grid.nx * grid.ny);
    let times = series.first().map(|s| s.times.clone()).context("aucun point")?;
    ensure!(!times.is_empty(), "aucune heure");
    ensure!(series.iter().all(|s| s.times == times), "les points ne partagent pas les mêmes heures");

    let mut missing = 0usize;
    let mut u = vec![Vec::with_capacity(series.len()); times.len()];
    let mut v = vec![Vec::with_capacity(series.len()); times.len()];
    for point in series {
        for hour in 0..times.len() {
            let (cu, cv) = match (point.speed[hour], point.direction[hour]) {
                (Some(speed), Some(direction)) => components(speed, direction),
                _ => {
                    missing += 1;
                    (0.0, 0.0)
                }
            };
            u[hour].push(quantize(cu));
            v[hour].push(quantize(cv));
        }
    }
    let total = series.len() * times.len();
    ensure!((missing as f64) <= MAX_MISSING_RATIO * total as f64, "{missing} valeurs absentes sur {total}");
    Ok(WindField { generated_at: now, grid, unit: UNIT, times, u, v })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(times: &[i64], speed: &[Option<f64>], direction: &[Option<f64>]) -> Value {
        serde_json::json!({ "hourly": { "time": times, "wind_speed_10m": speed, "wind_direction_10m": direction } })
    }

    #[test]
    fn grille_de_la_france() {
        let grid = Grid::standard();
        assert_eq!((grid.nx, grid.ny), (34, 22));
        let points = grid.points();
        assert_eq!(points.len(), 748);
        // Ordre : ligne par ligne, du sud au nord, de l'ouest à l'est.
        assert_eq!(points[0], (41.0, -6.0));
        assert_eq!(points[1], (41.0, -5.5));
        assert_eq!(points[34], (41.5, -6.0));
        assert_eq!(points[747], (51.5, 10.5));
    }

    #[test]
    fn le_vent_vient_de_la_direction_indiquee() {
        // Vent d'ouest (270°) : il souffle vers l'est.
        let (u, v) = components(10.0, 270.0);
        assert!((u - 10.0).abs() < 1e-9 && v.abs() < 1e-9);
        // Vent du nord (0°) : il souffle vers le sud.
        let (u, v) = components(5.0, 0.0);
        assert!(u.abs() < 1e-9 && (v + 5.0).abs() < 1e-9);
        // Vent du sud-est (135°) : il souffle vers le nord-ouest.
        let (u, v) = components(10.0, 135.0);
        assert!(u < 0.0 && v > 0.0 && (u + v).abs() < 1e-9);
    }

    #[test]
    fn reponse_a_plusieurs_points() {
        let json = serde_json::json!([
            point(&[100, 200], &[Some(3.0), None], &[Some(90.0), Some(0.0)]),
            point(&[100, 200], &[Some(1.0), Some(2.0)], &[Some(180.0), Some(270.0)]),
        ]);
        let series = parse_response(&json, 2).unwrap();
        assert_eq!(series.len(), 2);
        assert_eq!(series[0].times, vec![100, 200]);
        assert_eq!(series[0].speed, vec![Some(3.0), None]);
        assert_eq!(series[1].direction, vec![Some(180.0), Some(270.0)]);
    }

    #[test]
    fn reponse_a_un_seul_point() {
        // Avec une seule position, l'API renvoie un objet et non une liste.
        let json = point(&[100], &[Some(4.0)], &[Some(45.0)]);
        assert_eq!(parse_response(&json, 1).unwrap().len(), 1);
    }

    #[test]
    fn reponse_incomplete_refusee() {
        let json = serde_json::json!([point(&[100], &[Some(1.0)], &[Some(1.0)])]);
        assert!(parse_response(&json, 2).is_err());
        let bad = serde_json::json!({ "hourly": { "time": [1, 2], "wind_speed_10m": [1.0], "wind_direction_10m": [1.0, 2.0] } });
        assert!(parse_response(&bad, 1).is_err());
        assert!(parse_response(&serde_json::json!({ "error": true, "reason": "Limit" }), 1).is_err());
    }

    fn small_grid() -> Grid {
        Grid { west: 0.0, south: 0.0, step: 0.5, nx: 2, ny: 1 }
    }

    #[test]
    fn assemblage_en_dixiemes_de_metre_par_seconde() {
        let series = vec![
            Series { times: vec![100, 200], speed: vec![Some(10.0), Some(0.0)], direction: vec![Some(270.0), Some(0.0)] },
            Series { times: vec![100, 200], speed: vec![Some(5.0), Some(2.5)], direction: vec![Some(0.0), Some(90.0)] },
        ];
        let field = assemble(small_grid(), &series, 1234).unwrap();
        assert_eq!(field.times, vec![100, 200]);
        assert_eq!(field.generated_at, 1234);
        // Heure 100 : point 0 vers l'est à 10 m/s, point 1 vers le sud à 5 m/s.
        assert_eq!(field.u[0], vec![100, 0]);
        assert_eq!(field.v[0], vec![0, -50]);
        // Heure 200 : calme, puis vent d'est de 2,5 m/s (vers l'ouest).
        assert_eq!(field.u[1], vec![0, -25]);
        assert_eq!(field.v[1], vec![0, 0]);
    }

    #[test]
    fn assemblage_refuse_les_trous_et_les_heures_differentes() {
        let ok = |t: i64| Series { times: vec![t], speed: vec![Some(1.0)], direction: vec![Some(0.0)] };
        assert!(assemble(small_grid(), &[ok(100), ok(200)], 0).is_err());
        assert!(assemble(small_grid(), &[ok(100)], 0).is_err());
        let hole = Series { times: vec![100], speed: vec![None], direction: vec![None] };
        assert!(assemble(small_grid(), &[ok(100), hole], 0).is_err());
    }

    #[test]
    fn la_reponse_se_relit() {
        let series = vec![
            Series { times: vec![100], speed: vec![Some(3.0)], direction: vec![Some(180.0)] },
            Series { times: vec![100], speed: vec![Some(3.0)], direction: vec![Some(180.0)] },
        ];
        let field = assemble(small_grid(), &series, 55).unwrap();
        let body = serde_json::to_vec(&field).unwrap();
        let directory = std::env::temp_dir().join(format!("vent-test-{}", std::process::id()));
        let path = directory.join("champ.json");
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        runtime.block_on(async {
            write_cache(&path, &body).await.unwrap();
            let (read, generated_at) = read_cache(&path).await.unwrap();
            assert_eq!(read, body);
            assert_eq!(generated_at, 55);
            // Un fichier tronqué ou incohérent est ignoré.
            tokio::fs::write(&path, &body[..body.len() / 2]).await.unwrap();
            assert!(read_cache(&path).await.is_none());
        });
        let _ = std::fs::remove_dir_all(&directory);
    }
}
