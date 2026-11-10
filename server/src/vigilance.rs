//! Vigilance météo : le niveau de vigilance de chaque département de métropole, par
//! phénomène (vent, pluie-inondation, orages, crues, neige-verglas, canicule, grand froid,
//! avalanches, vagues-submersion), pour aujourd'hui (J) et demain (J1).
//!
//! Source : « Vigilance météorologique » de Météo-France, publiée sur data.gouv.fr
//! (`files.data.gouv.fr/meteofrance/data/vigilance/metropole/`), Licence Ouverte 2.0, sans clé.
//! L'API du portail Météo-France, elle, demande un compte : on ne l'utilise pas. Le dossier
//! contient un sous-dossier par bulletin (`AAAA/MM/JJ/HHMMSS/`), publié quelques secondes après
//! son émission (en général vers 6 h et 16 h, et à chaque mise à jour). On prend le plus récent
//! et son fichier `CDP_CARTE_EXTERNE.json`, qui donne, par département et phénomène, les
//! créneaux de chaque niveau (1 vert, 2 jaune, 3 orange, 4 rouge).
//!
//! Le littoral a ses propres « domaines » (`2910` pour le Finistère…) : leur phénomène,
//! vagues-submersion, est rattaché au département.

use std::collections::BTreeMap;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::state::AppState;

const BASE_URL: &str = "https://files.data.gouv.fr";
const ROOT_PATH: &str = "/meteofrance/data/vigilance/metropole/";
const FILE_NAME: &str = "CDP_CARTE_EXTERNE.json";
const REFRESH_EVERY: Duration = Duration::from_secs(10 * 60);

// --- Le bulletin tel que Météo-France le publie (ce dont on se sert) ---------------------------

#[derive(Deserialize)]
struct Bulletin {
    product: Product,
}

#[derive(Deserialize)]
struct Product {
    update_time: String,
    periods: Vec<InPeriod>,
}

#[derive(Deserialize)]
struct InPeriod {
    echeance: String,
    begin_validity_time: String,
    end_validity_time: String,
    timelaps: Timelaps,
}

#[derive(Deserialize)]
struct Timelaps {
    domain_ids: Vec<Domain>,
}

#[derive(Deserialize)]
struct Domain {
    domain_id: String,
    max_color_id: u8,
    phenomenon_items: Vec<InPhenomenon>,
}

#[derive(Deserialize)]
struct InPhenomenon {
    phenomenon_id: String,
    phenomenon_max_color_id: u8,
    timelaps_items: Vec<Slot>,
}

#[derive(Deserialize)]
struct Slot {
    begin_time: String,
    end_time: String,
    color_id: u8,
}

// --- Ce que sert l'API ---------------------------------------------------------------------

#[derive(Serialize, Debug, PartialEq)]
struct Phenomenon {
    /// 1 vent violent, 2 pluie-inondation, 3 orages, 4 crues, 5 neige-verglas, 6 canicule,
    /// 7 grand froid, 8 avalanches, 9 vagues-submersion.
    id: u8,
    /// Niveau maximal sur la période (2 jaune, 3 orange, 4 rouge : les phénomènes en vert sont omis).
    level: u8,
    /// Créneaux (début, fin en secondes UTC, niveau) au-dessus du vert.
    slots: Vec<(i64, i64, u8)>,
}

#[derive(Serialize, Debug, PartialEq, Default)]
struct DepartmentPeriod {
    /// Niveau maximal sur la période, tous phénomènes confondus (1 à 4).
    max: u8,
    phenomena: Vec<Phenomenon>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PeriodOut {
    name: String,
    begin: i64,
    end: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Out {
    /// Heure d'émission du bulletin (secondes UTC).
    issued_at: i64,
    /// Instant de la collecte (secondes UTC).
    updated_at: i64,
    periods: Vec<PeriodOut>,
    /// Par code de département (« 05 », « 2A »), une entrée par période, dans l'ordre de `periods`.
    departments: BTreeMap<String, Vec<DepartmentPeriod>>,
}

fn time(text: &str) -> Result<i64> {
    Ok(text.parse::<Timestamp>().with_context(|| format!("date invalide : {text}"))?.as_second())
}

/// Un domaine « département » (deux caractères) ou « littoral » (quatre caractères, `XX10`).
fn department_of(domain_id: &str) -> Option<(&str, bool)> {
    match domain_id.len() {
        2 => Some((domain_id, false)),
        4 if domain_id.ends_with("10") => Some((&domain_id[..2], true)),
        _ => None,
    }
}

fn convert(bulletin: &Bulletin) -> Result<Out> {
    let product = &bulletin.product;
    let mut periods = Vec::new();
    let mut departments: BTreeMap<String, Vec<DepartmentPeriod>> = BTreeMap::new();
    for period in &product.periods {
        periods.push(PeriodOut { name: period.echeance.clone(), begin: time(&period.begin_validity_time)?, end: time(&period.end_validity_time)? });
        let index = periods.len() - 1;
        for domain in &period.timelaps.domain_ids {
            // « FRA » est la synthèse nationale.
            let Some((code, coastal)) = department_of(&domain.domain_id) else { continue };
            let entries = departments.entry(code.to_string()).or_default();
            while entries.len() <= index {
                entries.push(DepartmentPeriod { max: 1, phenomena: Vec::new() });
            }
            let entry = &mut entries[index];
            entry.max = entry.max.max(domain.max_color_id);
            for item in &domain.phenomenon_items {
                // Le niveau du phénomène sur toute la période, même quand la liste de créneaux est vide
                // (les crues n'en ont pas : leur niveau vient de Vigicrues).
                if item.phenomenon_max_color_id < 2 {
                    continue;
                }
                let id: u8 = item.phenomenon_id.parse().with_context(|| format!("phénomène {}", item.phenomenon_id))?;
                let mut slots = Vec::new();
                for slot in item.timelaps_items.iter().filter(|s| s.color_id >= 2) {
                    slots.push((time(&slot.begin_time)?, time(&slot.end_time)?, slot.color_id));
                }
                // Un département et son littoral ne partagent pas de phénomène, sauf par erreur : on garde le plus haut.
                match entry.phenomena.iter_mut().find(|p| p.id == id) {
                    Some(existing) => {
                        existing.level = existing.level.max(item.phenomenon_max_color_id);
                        existing.slots.extend(slots);
                    }
                    None => entry.phenomena.push(Phenomenon { id, level: item.phenomenon_max_color_id, slots }),
                }
            }
            let _ = coastal;
            entry.phenomena.sort_by(|a, b| b.level.cmp(&a.level).then(a.id.cmp(&b.id)));
        }
    }
    Ok(Out { issued_at: time(&product.update_time)?, updated_at: Timestamp::now().as_second(), periods, departments })
}

/// Sous-dossiers (noms seulement) d'une page d'index Apache/nginx, du plus récent au plus ancien.
fn list_directories(html: &str, parent_path: &str) -> Vec<String> {
    let mut names: Vec<String> = html
        .split("href=\"")
        .skip(1)
        .filter_map(|part| part.split('"').next())
        .filter_map(|href| href.strip_prefix(parent_path))
        .filter(|rest| rest.ends_with('/') && rest.trim_end_matches('/').chars().all(|c| c.is_ascii_digit()) && rest.len() > 1)
        .map(|rest| rest.trim_end_matches('/').to_string())
        .collect();
    names.sort();
    names.reverse();
    names
}

async fn get_text(http: &reqwest::Client, url: &str) -> Result<String> {
    Ok(http.get(url).timeout(Duration::from_secs(30)).send().await?.error_for_status()?.text().await?)
}

/// Descend année → mois → jour → heure en prenant toujours le plus récent ; si un niveau est vide
/// (jour sans bulletin encore), essaie le précédent. Renvoie le chemin du dossier du bulletin.
async fn latest_bulletin(http: &reqwest::Client) -> Result<String> {
    let mut path = ROOT_PATH.to_string();
    // Pile de dossiers à essayer, le plus récent en dernier.
    let mut stack: Vec<(String, usize)> = vec![(path.clone(), 0)];
    let mut requests = 0;
    while let Some((current, depth)) = stack.pop() {
        requests += 1;
        if requests > 24 {
            bail!("aucun bulletin trouvé après 24 requêtes");
        }
        if depth == 4 {
            // Dossier d'un bulletin : il doit contenir le fichier cherché.
            let url = format!("{BASE_URL}{current}{FILE_NAME}");
            if http.head(&url).timeout(Duration::from_secs(30)).send().await.is_ok_and(|r| r.status().is_success()) {
                path = current;
                return Ok(path);
            }
            continue;
        }
        let html = get_text(http, &format!("{BASE_URL}{current}")).await?;
        // Les plus anciens d'abord dans la pile : le plus récent en est dépilé le premier.
        for name in list_directories(&html, &current).into_iter().rev() {
            stack.push((format!("{current}{name}/"), depth + 1));
        }
    }
    bail!("aucun bulletin de vigilance trouvé")
}

pub async fn poll_forever(http: reqwest::Client, state: AppState) {
    let mut last_path = String::new();
    loop {
        match refresh(&http, &last_path).await {
            Ok(Some((path, body, count))) => {
                info!(bulletin = %path, departements = count, "vigilance : bulletin mis à jour");
                state.set_vigilance(body);
                last_path = path;
            }
            Ok(None) => {}
            Err(error) => warn!("vigilance : bulletin indisponible : {error:#}"),
        }
        tokio::time::sleep(REFRESH_EVERY).await;
    }
}

async fn refresh(http: &reqwest::Client, last_path: &str) -> Result<Option<(String, Vec<u8>, usize)>> {
    let path = latest_bulletin(http).await?;
    if path == last_path {
        return Ok(None);
    }
    let text = get_text(http, &format!("{BASE_URL}{path}{FILE_NAME}")).await?;
    let bulletin: Bulletin = serde_json::from_str(&text).context("bulletin illisible")?;
    let out = convert(&bulletin)?;
    let count = out.departments.len();
    if count < 90 {
        bail!("seulement {count} départements dans le bulletin : format inattendu");
    }
    Ok(Some((path, serde_json::to_vec(&out)?, count)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Extrait réel du bulletin du 2 novembre 2023 à 22 h 17 (tempête Ciarán) : quelques départements.
    const SAMPLE: &str = include_str!("testdata/vigilance_extrait.json");

    fn out() -> Out {
        convert(&serde_json::from_str(SAMPLE).unwrap()).unwrap()
    }

    #[test]
    fn lit_les_periodes_et_les_niveaux() {
        let out = out();
        assert_eq!(out.periods.len(), 2);
        assert_eq!(out.periods[0].name, "J");
        assert_eq!(out.issued_at, "2023-11-02T21:17:26Z".parse::<Timestamp>().unwrap().as_second());
        // La Corse-du-Sud : orange à J, avec ses phénomènes classés du plus haut au plus bas.
        let corse = &out.departments["2A"][0];
        assert_eq!(corse.max, 3);
        assert!(corse.phenomena.iter().all(|p| p.level >= 2), "les phénomènes en vert sont omis");
        assert_eq!(corse.phenomena[0].level, 3);
    }

    #[test]
    fn rattache_le_littoral_au_departement() {
        let out = out();
        let corse = &out.departments["2A"][0];
        // Vagues-submersion (9) vient du domaine « 2A10 », orange.
        let waves = corse.phenomena.iter().find(|p| p.id == 9).expect("vagues-submersion");
        assert_eq!(waves.level, 3);
        assert!(!out.departments.contains_key("2A10"), "pas de département fantôme pour le littoral");
        assert!(!out.departments.contains_key("FRA"), "la synthèse nationale n'est pas un département");
    }

    #[test]
    fn un_departement_sans_alerte_est_vert() {
        let out = out();
        assert_eq!(out.departments["75"][0].max, 1);
        assert!(out.departments["75"][0].phenomena.is_empty());
    }

    #[test]
    fn trouve_les_sous_dossiers_du_plus_recent_au_plus_ancien() {
        let html = r#"<a href="../">..</a><a href="/meteofrance/data/vigilance/metropole/2026/11/08/">8</a>
            <a href="/meteofrance/data/vigilance/metropole/2026/11/09/">9</a><a href="/meteofrance/data/vigilance/metropole/2026/11/09/150004/CDP.json">x</a>"#;
        assert_eq!(list_directories(html, "/meteofrance/data/vigilance/metropole/2026/11/"), vec!["09", "08"]);
    }
}
