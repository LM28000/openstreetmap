//! Qualité de l'air : l'indice ATMO de chaque commune (ou intercommunalité) de métropole, pour
//! aujourd'hui et les jours déjà prévus, et les épisodes de pollution en cours.
//!
//! Source : Atmo Data (`admindata.atmo-france.org`), qui agrège les flux ouverts des associations
//! agréées de surveillance de la qualité de l'air (AASQA). Données ouvertes ; mention
//! « Atmo France / AASQA ». L'API demande un compte : le serveur lit `ATMO_USERNAME` et
//! `ATMO_PASSWORD`, obtient un jeton JWT (`POST /api/login`) qu'il renouvelle avant son
//! expiration (ou au premier refus 401). Les identifiants ne quittent jamais le serveur.
//!
//! Deux flux servent la couche :
//! - 112, « Indice ATMO » : une ligne par zone et par jour d'échéance (`date_ech`), avec l'indice
//!   global (1 bon à 6 extrêmement mauvais, 7 événement) et les sous-indices de cinq polluants.
//!   L'historique annoncé n'existe pas : seuls aujourd'hui, demain et parfois après-demain sont
//!   publiés, vers 12–14 h ;
//! - 114, « Épisodes de pollution » : constatés la veille et le jour même, prévus le lendemain,
//!   par zone (département, région ou bassin d'air, selon l'association).
//!
//! La réponse est en colonnes (un tableau par champ) : 29 000 zones, ce serait sinon 3 Mo de noms
//! de champs répétés. Les indices d'une zone tiennent dans une chaîne de 6 chiffres par jour
//! (indice, NO2, O3, PM10, PM2.5, SO2), « - » quand le jour n'est pas publié pour elle.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://admindata.atmo-france.org";
const INDEX_FEED: u32 = 112;
const EPISODES_FEED: u32 = 114;
/// Les indices sont publiés une fois par jour : relever toutes les heures suffit à les voir
/// dès leur parution (12–14 h) et à changer de jour à minuit.
const REFRESH_EVERY: Duration = Duration::from_secs(60 * 60);
const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// Marge avant l'expiration du jeton, au-delà de laquelle on se reconnecte.
const TOKEN_MARGIN_S: i64 = 120;
/// Métropole et Corse, avec une marge (sud, ouest, nord, est) : l'outre-mer est hors de la carte.
const AREA: (f64, f64, f64, f64) = (41.0, -5.5, 51.5, 10.0);
/// Nombre de jours gardés au plus (aujourd'hui, demain, après-demain, et hier s'il est encore là).
const MAX_DAYS: usize = 4;

// --- Ce que l'API Atmo renvoie (ce dont on se sert) --------------------------------------------

#[derive(Deserialize)]
struct Collection<T> {
    features: Vec<Feature<T>>,
}

#[derive(Deserialize)]
struct Feature<T> {
    properties: T,
}

#[derive(Deserialize)]
struct IndexRow {
    code_zone: Option<String>,
    lib_zone: Option<String>,
    type_zone: Option<String>,
    source: Option<String>,
    date_ech: String,
    date_maj: Option<String>,
    code_qual: Option<f64>,
    code_no2: Option<f64>,
    code_o3: Option<f64>,
    code_pm10: Option<f64>,
    code_pm25: Option<f64>,
    code_so2: Option<f64>,
    x_wgs84: Option<f64>,
    y_wgs84: Option<f64>,
}

/// Le flux 114 n'a, d'après le catalogue, que ces quatre champs ; le flux 113 (l'année passée) a en
/// plus `date_ech` et `code_zone` : on les prend s'ils sont là.
#[derive(Deserialize)]
struct EpisodeRow {
    etat: Option<String>,
    lib_pol: Option<String>,
    lib_zone: Option<String>,
    date_dif: Option<String>,
    date_ech: Option<String>,
}

// --- Ce que sert l'API ---------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq, Default)]
struct Zones {
    name: Vec<String>,
    lon: Vec<f64>,
    lat: Vec<f64>,
    /// Indice de l'association dans `sources`.
    src: Vec<u16>,
    /// 1 pour une intercommunalité (un point au centre d'un territoire plus grand), 0 pour une commune.
    epci: Vec<u8>,
    /// 6 chiffres par jour de `days` : indice global, NO2, O3, PM10, PM2.5, SO2 (« - » : pas publié).
    v: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
struct Episode {
    /// Zone concernée, telle que l'association la nomme (« ILE-DE-FRANCE », « Bassin Grenoblois »…).
    zone: String,
    /// Polluant : « O3 », « NO2 », « PM10 », « PM2.5 », « SO2 » (sinon le libellé d'origine).
    pol: String,
    /// 1 information et recommandation, 2 alerte, 3 alerte sur persistance.
    level: u8,
    day: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Out {
    /// Instant de la collecte (secondes UTC).
    updated_at: i64,
    /// Heure de publication la plus récente des indices (secondes UTC), si elle est connue.
    #[serde(skip_serializing_if = "Option::is_none")]
    issued_at: Option<i64>,
    /// Jours couverts, « AAAA-MM-JJ » (heure de Paris), du plus ancien au plus récent.
    days: Vec<String>,
    sources: Vec<String>,
    zones: Zones,
    episodes: Vec<Episode>,
}

// --- Jeton -------------------------------------------------------------------------------------

struct Session {
    token: String,
    /// Expiration (secondes UTC), lue dans le jeton.
    expires: i64,
}

fn base64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let (mut buffer, mut bits) = (0u32, 0);
    for c in text.bytes().filter(|c| *c != b'=') {
        let value = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// Expiration (`exp`, secondes UTC) d'un jeton JWT, sans vérifier sa signature : le serveur ne
/// s'en sert que pour savoir quand se reconnecter.
fn jwt_expiry(token: &str) -> Option<i64> {
    let payload = base64url_decode(token.split('.').nth(1)?)?;
    serde_json::from_slice::<serde_json::Value>(&payload).ok()?.get("exp")?.as_i64()
}

async fn login(http: &reqwest::Client, username: &str, password: &str) -> Result<Session> {
    #[derive(Deserialize)]
    struct Reply {
        token: String,
    }
    let body = serde_json::to_vec(&serde_json::json!({ "username": username, "password": password }))?;
    let response = http
        .post(format!("{BASE_URL}/api/login"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await?;
    // Le message du serveur peut citer l'identifiant : on n'en reprend que le code.
    let status = response.status();
    if !status.is_success() {
        bail!("connexion refusée (HTTP {status})");
    }
    let token = serde_json::from_slice::<Reply>(&response.bytes().await?).context("réponse de connexion illisible")?.token;
    // Sans date lisible, on suppose le jeton valable une heure.
    let expires = jwt_expiry(&token).unwrap_or_else(|| Timestamp::now().as_second() + 3600);
    Ok(Session { token, expires })
}

// --- Collecte ----------------------------------------------------------------------------------

/// Encode un segment d'adresse : tout sauf les caractères non réservés.
fn encode_segment(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Adresse d'un flux, filtré sur `field >= date`.
fn feed_url(feed: u32, field: &str, since: Date) -> String {
    let filter = serde_json::json!({ field: { "operator": ">=", "value": since.to_string() } });
    format!("{BASE_URL}/api/data/{feed}/{}", encode_segment(&filter.to_string()))
}

struct Collector {
    http: reqwest::Client,
    username: String,
    password: String,
    session: Option<Session>,
}

impl Collector {
    async fn token(&mut self) -> Result<String> {
        let valid = self.session.as_ref().filter(|s| s.expires - TOKEN_MARGIN_S > Timestamp::now().as_second());
        if let Some(session) = valid {
            return Ok(session.token.clone());
        }
        let session = login(&self.http, &self.username, &self.password).await?;
        let token = session.token.clone();
        self.session = Some(session);
        Ok(token)
    }

    /// Corps d'une réponse, avec un nouvel essai après reconnexion si le jeton est refusé (401), et
    /// après une courte pause si l'API répond par une erreur de serveur (elle en a de passagères).
    async fn get(&mut self, url: &str) -> Result<Vec<u8>> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            let token = self.token().await?;
            let response = self.http.get(url).bearer_auth(token).timeout(Duration::from_secs(120)).send().await?;
            let status = response.status();
            if status == reqwest::StatusCode::UNAUTHORIZED && attempt < 3 {
                self.session = None;
            } else if status.is_server_error() && attempt < 3 {
                tokio::time::sleep(Duration::from_secs(3)).await;
            } else {
                return Ok(response.error_for_status()?.bytes().await?.to_vec());
            }
        }
    }

    async fn collect(&mut self) -> Result<(Vec<u8>, usize, usize)> {
        let today = Timestamp::now().to_zoned(TimeZone::get("Europe/Paris")?).date();
        let yesterday = today.yesterday()?;
        let index: Collection<IndexRow> = serde_json::from_slice(&self.get(&feed_url(INDEX_FEED, "date_ech", yesterday)).await?)
            .context("indice ATMO illisible")?;
        // Les épisodes sont un plus : sans eux, l'indice est servi quand même.
        let episodes = match self.get(&feed_url(EPISODES_FEED, "date_dif", yesterday)).await {
            Ok(body) => serde_json::from_slice::<Collection<EpisodeRow>>(&body).context("épisodes illisibles"),
            Err(error) => Err(error),
        };
        let episodes = match episodes {
            Ok(collection) => collection.features.into_iter().map(|f| f.properties).collect(),
            Err(error) => {
                warn!("qualité de l'air : épisodes de pollution indisponibles : {error:#}");
                Vec::new()
            }
        };
        let rows: Vec<IndexRow> = index.features.into_iter().map(|f| f.properties).collect();
        let out = build(rows, episodes, Timestamp::now().as_second());
        if out.zones.name.is_empty() {
            bail!("aucune zone dans l'indice ATMO");
        }
        let counts = (out.zones.name.len(), out.episodes.len());
        Ok((serde_json::to_vec(&out)?, counts.0, counts.1))
    }
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
    let (Some(username), Some(password)) = (var("ATMO_USERNAME"), var("ATMO_PASSWORD")) else {
        info!("qualité de l'air : pas d'identifiants ATMO_USERNAME/ATMO_PASSWORD, couche désactivée");
        state.set_air_disabled("pas d'identifiants Atmo Data configurés sur le serveur");
        return;
    };
    let mut collector = Collector { http, username, password, session: None };
    loop {
        let wait = match collector.collect().await {
            Ok((body, zones, episodes)) => {
                info!(zones, episodes, octets = body.len(), "qualité de l'air : indice mis à jour");
                state.set_air(body);
                REFRESH_EVERY
            }
            Err(error) => {
                warn!("qualité de l'air : données indisponibles : {error:#}");
                RETRY_AFTER
            }
        };
        tokio::time::sleep(wait).await;
    }
}

// --- Mise en forme -----------------------------------------------------------------------------

fn level_char(value: Option<f64>) -> char {
    match value {
        Some(v) if (0.0..=9.0).contains(&v) => char::from(b'0' + v as u8),
        _ => '-',
    }
}

fn pollutant(label: &str) -> String {
    let lower = label.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));
    if has(&["o3", "ozone"]) {
        "O3".into()
    } else if has(&["no2", "azote"]) {
        "NO2".into()
    } else if has(&["2.5", "2,5", "pm25"]) {
        "PM2.5".into()
    } else if has(&["10", "pm10"]) {
        "PM10".into()
    } else if has(&["so2", "soufre"]) {
        "SO2".into()
    } else {
        label.trim().to_string()
    }
}

/// 0 : pas d'épisode (ou état inconnu) ; sinon 1 information, 2 alerte, 3 alerte sur persistance.
fn episode_level(state: &str) -> u8 {
    let upper = state.to_uppercase();
    if upper.contains("PAS DE") {
        0
    } else if upper.contains("PERSISTANCE") {
        3
    } else if upper.contains("ALERTE") {
        2
    } else if upper.contains("INFORMATION") || upper.contains("RECOMMANDATION") {
        1
    } else {
        0
    }
}

fn build(rows: Vec<IndexRow>, episode_rows: Vec<EpisodeRow>, now: i64) -> Out {
    let (south, west, north, east) = AREA;
    let mut days: BTreeSet<String> = rows.iter().map(|r| r.date_ech.clone()).collect();
    // Les plus récents d'abord à garder : au plus MAX_DAYS jours.
    while days.len() > MAX_DAYS {
        days.pop_last();
    }
    let days: Vec<String> = days.into_iter().collect();
    let day_index: HashMap<&str, usize> = days.iter().enumerate().map(|(i, d)| (d.as_str(), i)).collect();

    let mut sources: Vec<String> = Vec::new();
    let mut zones = Zones::default();
    let mut positions: HashMap<(String, String, i64, i64), usize> = HashMap::new();
    let mut issued_at: Option<i64> = None;
    for row in &rows {
        let (Some(&day), Some(lon), Some(lat)) = (day_index.get(row.date_ech.as_str()), row.x_wgs84, row.y_wgs84) else { continue };
        if !(south..=north).contains(&lat) || !(west..=east).contains(&lon) {
            continue;
        }
        // Trois décimales : une centaine de mètres, bien assez pour un point de commune.
        let (lon, lat) = ((lon * 1000.0).round() / 1000.0, (lat * 1000.0).round() / 1000.0);
        let name = row.lib_zone.clone().unwrap_or_default();
        let key = (row.code_zone.clone().unwrap_or_default(), name.clone(), (lon * 1000.0) as i64, (lat * 1000.0) as i64);
        let index = *positions.entry(key).or_insert_with(|| {
            let source = row.source.clone().unwrap_or_default().trim().to_string();
            let src = match sources.iter().position(|s| *s == source) {
                Some(i) => i,
                None => {
                    sources.push(source);
                    sources.len() - 1
                }
            };
            zones.name.push(name);
            zones.lon.push(lon);
            zones.lat.push(lat);
            zones.src.push(src as u16);
            zones.epci.push(u8::from(row.type_zone.as_deref().is_some_and(|t| t.eq_ignore_ascii_case("epci"))));
            zones.v.push("-".repeat(6 * days.len()));
            zones.v.len() - 1
        });
        let values: String = [row.code_qual, row.code_no2, row.code_o3, row.code_pm10, row.code_pm25, row.code_so2].map(level_char).iter().collect();
        zones.v[index].replace_range(day * 6..day * 6 + 6, &values);
        if let Some(at) = row.date_maj.as_deref().and_then(|t| t.parse::<Timestamp>().ok()) {
            issued_at = issued_at.max(Some(at.as_second()));
        }
    }

    // Épisodes : un par (zone, polluant, jour), au niveau le plus élevé.
    let mut episodes: BTreeMap<(String, String, String), u8> = BTreeMap::new();
    for row in episode_rows {
        let level = episode_level(row.etat.as_deref().unwrap_or_default());
        let (Some(zone), Some(pol), Some(day)) = (row.lib_zone, row.lib_pol, row.date_ech.or(row.date_dif)) else { continue };
        if level == 0 {
            continue;
        }
        let entry = episodes.entry((zone.trim().to_string(), pollutant(&pol), day)).or_default();
        *entry = (*entry).max(level);
    }
    let episodes = episodes.into_iter().map(|((zone, pol, day), level)| Episode { zone, pol, level, day }).collect();

    Out { updated_at: now, issued_at, days, sources, zones, episodes }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lignes de l'indice ATMO d'après des réponses réelles (Airparif, Atmo Occitanie, Guyane, Normandie),
    /// aujourd'hui et demain, et une commune de Guyane (hors carte).
    const INDEX: &str = include_str!("testdata/air_indice_extrait.json");
    /// Épisodes : mise en forme du flux 113 (celui du flux 114 est vide en dehors des épisodes).
    const EPISODES: &str = include_str!("testdata/air_episodes_extrait.json");

    fn rows() -> Vec<IndexRow> {
        serde_json::from_str::<Collection<IndexRow>>(INDEX).unwrap().features.into_iter().map(|f| f.properties).collect()
    }

    fn episodes() -> Vec<EpisodeRow> {
        serde_json::from_str::<Collection<EpisodeRow>>(EPISODES).unwrap().features.into_iter().map(|f| f.properties).collect()
    }

    #[test]
    fn regroupe_les_jours_par_zone() {
        let out = build(rows(), Vec::new(), 0);
        assert_eq!(out.days, ["2026-11-10", "2026-11-11"]);
        let i = out.zones.name.iter().position(|n| n == "Saint-Loup-De-Naud").unwrap();
        // Aujourd'hui : bon (1) ; demain : moyen (2), à cause de l'ozone.
        assert_eq!(out.zones.v[i], "111111212111");
        assert_eq!((out.zones.lon[i], out.zones.lat[i]), (3.219, 48.537));
    }

    #[test]
    fn ecarte_l_outre_mer_et_les_zones_sans_position() {
        let out = build(rows(), Vec::new(), 0);
        assert!(!out.zones.name.iter().any(|n| n == "Cayenne"), "la Guyane est hors carte");
        assert!(!out.zones.name.iter().any(|n| n == "Sans position"));
    }

    #[test]
    fn distingue_les_intercommunalites_et_les_associations() {
        let out = build(rows(), Vec::new(), 0);
        let epci = out.zones.name.iter().position(|n| n == "CC du Pays de Test").unwrap();
        assert_eq!(out.zones.epci[epci], 1);
        assert_eq!(out.sources[out.zones.src[epci] as usize], "Atmo-Occitanie");
        // Un jour absent pour une zone : « - ».
        assert_eq!(out.zones.v[epci], "211111------");
    }

    #[test]
    fn retient_la_publication_la_plus_recente() {
        let out = build(rows(), Vec::new(), 0);
        assert_eq!(out.issued_at, Some("2026-11-10T12:09:46Z".parse::<Timestamp>().unwrap().as_second()));
    }

    #[test]
    fn normalise_les_episodes() {
        let out = build(rows(), episodes(), 0);
        // Les « pas de dépassement » et les états vides sont écartés ; « Ozone » et « O3 » deviennent « O3 »
        // (un seul épisode par zone, polluant et jour, au niveau le plus élevé).
        let episode = |zone: &str, pol: &str, level, day: &str| Episode { zone: zone.into(), pol: pol.into(), level, day: day.into() };
        assert_eq!(
            out.episodes,
            vec![
                episode("Bassin Grenoblois", "PM10", 2, "2026-11-11"),
                episode("ILE-DE-FRANCE", "O3", 3, "2026-11-10"),
                episode("ILE-DE-FRANCE", "PM2.5", 1, "2026-11-10"),
            ]
        );
    }

    #[test]
    fn serialise_en_colonnes() {
        let json = serde_json::to_value(build(rows(), Vec::new(), 7)).unwrap();
        assert_eq!(json["updatedAt"], 7);
        assert_eq!(json["zones"]["name"].as_array().unwrap().len(), json["zones"]["v"].as_array().unwrap().len());
    }

    #[test]
    fn lit_l_expiration_du_jeton() {
        // En-tête et signature quelconques ; charge : {"exp":1789000000,"roles":["ROLE_USER"]}.
        let token = "eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE3ODkwMDAwMDAsInJvbGVzIjpbIlJPTEVfVVNFUiJdfQ.c2lnbmF0dXJl";
        assert_eq!(jwt_expiry(token), Some(1_789_000_000));
        assert_eq!(jwt_expiry("pas-un-jeton"), None);
    }

    #[test]
    fn encode_le_filtre_dans_l_adresse() {
        let url = feed_url(112, "date_ech", "2026-11-09".parse().unwrap());
        assert_eq!(
            url,
            "https://admindata.atmo-france.org/api/data/112/%7B%22date_ech%22%3A%7B%22operator%22%3A%22%3E%3D%22%2C%22value%22%3A%222026-11-09%22%7D%7D"
        );
    }
}
