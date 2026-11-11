//! La source du jeu « dvf » : téléchargement des fichiers Etalab et **nettoyage** des mutations.
//!
//! # D'où viennent les données
//!
//! Les « Demandes de valeurs foncières » (DVF) de la DGFiP listent toutes les mutations immobilières à titre onéreux
//! (ventes, échanges…). Etalab les géolocalise et publie un fichier national par an :
//! `https://files.data.gouv.fr/geo-dvf/latest/csv/<année>/full.csv.gz` (100 à 120 Mo compressés, ~4,7 M de lignes par an).
//! L'Alsace, la Moselle (droit local) et Mayotte n'y figurent pas.
//!
//! # Conditions de réutilisation (à respecter, et respectées ici)
//!
//! La licence est la Licence Ouverte 2.0 (mention : « DGFiP, DVF ; Etalab »). La notice de la DGFiP ajoute (art. R112 A-3
//! du Livre des procédures fiscales) que la réutilisation :
//! - « ne doit pas permettre la ré-identification des personnes concernées, de manière indirecte » ;
//! - « ne doit pas permettre l'indexation des données depuis les moteurs de recherche externes ».
//!
//! Ce qu'on en fait :
//! - on ne garde **aucune** adresse, aucun numéro de mutation ni de parcelle : seulement un point, un mois, un prix et une
//!   surface (voir `dvf.rs` : la position est arrondie à ~20 m et la date réduite au mois) ;
//! - les ventes de plusieurs biens, les locaux professionnels, les terrains de plus d'un hectare… sont écartés
//!   (voir ci-dessous), ce qui retire aussi les cas où le prix décrit une personne plus qu'un logement ;
//! - les données ne sont servies que sous forme de tuiles binaires (`/api/tuiles/dvf/…`), jamais en pages HTML, avec
//!   `X-Robots-Tag: noindex` : aucun moteur de recherche ne les indexe ;
//! - le lien de la fiche d'une vente mène à l'explorateur officiel, pas à un moteur de recherche par adresse.
//!
//! # Une vente (mutation) s'étale sur plusieurs lignes
//!
//! Une ligne du fichier = une parcelle × un local. Une maison avec un garage et un jardin sur deux parcelles fait donc
//! 3 ou 4 lignes qui portent **le même prix** (`valeur_fonciere` est celui de toute la mutation, répété). Ne pas
//! regrouper, c'est compter plusieurs fois la même vente, ou rapporter le prix total à la surface d'un seul local.
//! Le fichier est trié par `id_mutation` (on le vérifie : un identifiant qui revient plus loin serait compté deux fois
//! et fait échouer le nettoyage) : on regroupe donc **les lignes consécutives** de même identifiant, en flux.
//!
//! # Règles de nettoyage (une vente est gardée si toutes sont vraies)
//!
//! 1. `nature_mutation` = « Vente » (ni VEFA, ni échange, ni adjudication, ni terrain à bâtir) ;
//! 2. une seule disposition (`numero_disposition`) : sinon le prix est réparti entre des dispositions qu'on ne sait pas séparer ;
//! 3. **exactement un logement** : une seule ligne « Maison » ou « Appartement » (plusieurs : le prix couvre un lot de
//!    biens, on ne peut pas le rapporter à une surface). Les dépendances (cave, garage) peuvent accompagner : leur prix est
//!    dans celui du logement (léger biais vers le haut, accepté) ;
//! 4. aucun local industriel, commercial ou assimilé dans la mutation ;
//! 5. un prix (`valeur_fonciere`) d'au moins 10 000 € (sous ce seuil : ventes symboliques, parts, viager…) ;
//! 6. une surface bâtie réelle de 9 à 400 m² pour un appartement, de 20 à 600 m² pour une maison ;
//! 7. pour une maison, au plus 1 ha de terrain (somme des parcelles distinctes) : au-delà, c'est une propriété agricole ou
//!    d'agrément dont le prix n'est plus un prix de logement ;
//! 8. un prix au m² entre 300 et 30 000 € (les 300 €/m² sont déjà de la ruine rurale, les 30 000 € le haut du marché
//!    de luxe : au-delà, il s'agit presque toujours d'une erreur de saisie : surface oubliée, prix de plusieurs biens) ;
//! 9. des coordonnées, en France métropolitaine (les DOM sont écartés : la grille des carreaux n'y est pas définie).
//!
//! # Fichiers produits
//!
//! Pour chaque année, dans le dossier de la source : `ventes-<année>.csv.gz` (une ligne par vente gardée :
//! `lon,lat,date,type,pièces,surface,prix`, ~25 Mo) et `rapport-<année>.json` (les comptes). Le fichier brut est supprimé
//! une fois nettoyé (un fichier brut fait 100 à 120 Mo : on n'en garde jamais plus d'un à la fois sur le disque).

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use flate2::Compression;
use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

/// À augmenter quand les règles de nettoyage changent : les fichiers nettoyés sont alors refaits.
pub const CLEAN_VERSION: u32 = 1;
pub const BASE_URL: &str = "https://files.data.gouv.fr/geo-dvf/latest/csv";

/// Prix au m² plausibles (€) : les bornes des 128 classes de l'histogramme de `dvf.rs` en sont les extrémités.
pub const MIN_EURO_M2: f64 = 300.0;
pub const MAX_EURO_M2: f64 = 30_000.0;

/// Comptes d'une année : ce qui a été lu, gardé, et écarté (et pourquoi).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct YearReport {
    pub annee: u16,
    /// Date de dernière modification du fichier chez Etalab : si elle change, on retélécharge.
    pub derniere_modification: String,
    pub version_nettoyage: u32,
    pub lignes: u64,
    pub mutations: u64,
    pub gardees: u64,
    pub appartements: u64,
    pub maisons: u64,
    /// Mutations écartées, par raison (la somme avec `gardees` fait `mutations`).
    pub ecartees: BTreeMap<String, u64>,
}

/// Un logement vendu, tel qu'écrit dans le fichier nettoyé.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sale {
    pub lon: f64,
    pub lat: f64,
    /// Année, mois (1-12), jour.
    pub date: (u16, u8, u8),
    /// 0 appartement, 1 maison.
    pub kind: u8,
    pub rooms: u8,
    pub surface: u16,
    pub price: u32,
}

impl Sale {
    pub fn euro_m2(&self) -> f64 {
        f64::from(self.price) / f64::from(self.surface)
    }
}

// ---------------------------------------------------------------------------------------------
// Nettoyage d'une année, en flux
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Local {
    None,
    House,
    Flat,
    Outbuilding,
    /// Local industriel, commercial ou assimilé.
    Business,
}

/// Une mutation en cours de lecture : on n'en garde que ce qu'il faut pour décider (pas toutes les lignes).
#[derive(Default)]
struct Pending {
    id: Vec<u8>,
    sale_nature: bool,
    first_disposition: Vec<u8>,
    several_dispositions: bool,
    price: Option<f64>,
    date: String,
    dwellings: u32,
    kind: u8,
    surface: f64,
    rooms: f64,
    lon: f64,
    lat: f64,
    has_coordinates: bool,
    overseas: bool,
    business: bool,
    /// Parcelles distinctes (identifiant, nature de culture) et leur surface : le même terrain est répété sur chaque ligne.
    land: Vec<(Vec<u8>, Vec<u8>, f64)>,
}

/// Les colonnes dont on a besoin, trouvées par leur nom dans l'en-tête.
struct Columns {
    id: usize,
    date: usize,
    disposition: usize,
    nature: usize,
    price: usize,
    department: usize,
    parcel: usize,
    local: usize,
    surface: usize,
    rooms: usize,
    culture: usize,
    land: usize,
    lon: usize,
    lat: usize,
}

impl Columns {
    fn of(headers: &csv::StringRecord) -> Result<Columns> {
        let find = |name: &str| headers.iter().position(|h| h == name).with_context(|| format!("colonne « {name} » absente du fichier DVF"));
        Ok(Columns {
            id: find("id_mutation")?,
            date: find("date_mutation")?,
            disposition: find("numero_disposition")?,
            nature: find("nature_mutation")?,
            price: find("valeur_fonciere")?,
            department: find("code_departement")?,
            parcel: find("id_parcelle")?,
            local: find("type_local")?,
            surface: find("surface_reelle_bati")?,
            rooms: find("nombre_pieces_principales")?,
            culture: find("nature_culture")?,
            land: find("surface_terrain")?,
            lon: find("longitude")?,
            lat: find("latitude")?,
        })
    }
}

fn number(bytes: &[u8]) -> Option<f64> {
    std::str::from_utf8(bytes).ok()?.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

fn local_of(bytes: &[u8]) -> Local {
    match bytes {
        b"" => Local::None,
        b"Maison" => Local::House,
        b"Appartement" => Local::Flat,
        b if b.starts_with(b"Local") => Local::Business,
        _ => Local::Outbuilding, // « Dépendance » (le mot est accentué : on n'a pas besoin de le comparer en entier)
    }
}

impl Pending {
    fn begin(&mut self, record: &csv::ByteRecord, c: &Columns) {
        *self = Pending::default();
        self.id = record.get(c.id).unwrap_or_default().to_vec();
        self.sale_nature = record.get(c.nature) == Some(b"Vente");
        self.first_disposition = record.get(c.disposition).unwrap_or_default().to_vec();
        self.price = number(record.get(c.price).unwrap_or_default());
        self.date = String::from_utf8_lossy(record.get(c.date).unwrap_or_default()).into_owned();
        self.overseas = record.get(c.department).is_some_and(|d| d.starts_with(b"97") || d.starts_with(b"98"));
    }

    fn add(&mut self, record: &csv::ByteRecord, c: &Columns) {
        if record.get(c.disposition).unwrap_or_default() != self.first_disposition.as_slice() {
            self.several_dispositions = true;
        }
        match local_of(record.get(c.local).unwrap_or_default()) {
            Local::House | Local::Flat => {
                let flat = local_of(record.get(c.local).unwrap_or_default()) == Local::Flat;
                self.dwellings += 1;
                self.kind = u8::from(!flat);
                self.surface = number(record.get(c.surface).unwrap_or_default()).unwrap_or(0.0);
                self.rooms = number(record.get(c.rooms).unwrap_or_default()).unwrap_or(0.0);
                if let (Some(lon), Some(lat)) = (number(record.get(c.lon).unwrap_or_default()), number(record.get(c.lat).unwrap_or_default())) {
                    (self.lon, self.lat, self.has_coordinates) = (lon, lat, true);
                }
            }
            Local::Business => self.business = true,
            _ => {}
        }
        if let Some(area) = number(record.get(c.land).unwrap_or_default()) {
            let key = (record.get(c.parcel).unwrap_or_default().to_vec(), record.get(c.culture).unwrap_or_default().to_vec());
            if !self.land.iter().any(|(p, n, _)| (p, n) == (&key.0, &key.1)) {
                self.land.push((key.0, key.1, area));
            }
        }
    }

    /// Applique les règles : la vente à garder, ou la raison de l'écarter.
    fn judge(&self) -> std::result::Result<Sale, &'static str> {
        if !self.sale_nature {
            return Err("autre nature (VEFA, échange, adjudication…)");
        }
        if self.several_dispositions {
            return Err("plusieurs dispositions");
        }
        match self.dwellings {
            0 => return Err("aucun logement (terrain, local…)"),
            1 => {}
            _ => return Err("plusieurs logements"),
        }
        if self.business {
            return Err("local commercial ou industriel");
        }
        let Some(price) = self.price else { return Err("prix absent") };
        if price < 10_000.0 {
            return Err("prix inférieur à 10 000 €");
        }
        let (min, max) = if self.kind == 0 { (9.0, 400.0) } else { (20.0, 600.0) };
        if !(min..=max).contains(&self.surface) {
            return Err("surface bâtie hors bornes");
        }
        if self.kind == 1 && self.land.iter().map(|l| l.2).sum::<f64>() > 10_000.0 {
            return Err("maison sur plus d'un hectare");
        }
        let euro_m2 = price / self.surface;
        if !(MIN_EURO_M2..=MAX_EURO_M2).contains(&euro_m2) {
            return Err("prix au m² hors bornes (300 à 30 000 €)");
        }
        if self.overseas {
            return Err("outre-mer (hors grille)");
        }
        if !self.has_coordinates || !(-5.5..=10.0).contains(&self.lon) || !(41.0..=51.5).contains(&self.lat) {
            return Err("sans coordonnées ou hors métropole");
        }
        let mut parts = self.date.split('-').map(|p| p.parse::<u16>().unwrap_or(0));
        let (y, m, d) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
        if y < 2000 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return Err("date illisible");
        }
        Ok(Sale {
            lon: self.lon,
            lat: self.lat,
            date: (y, m as u8, d as u8),
            kind: self.kind,
            rooms: self.rooms.clamp(0.0, 20.0) as u8,
            surface: self.surface.round() as u16,
            price: price.round().min(f64::from(u32::MAX)) as u32,
        })
    }
}

/// Nettoie un fichier DVF brut (CSV décompressé) : écrit les ventes gardées dans `out` (CSV) et rend les comptes.
pub fn clean(raw: impl Read, out: &mut impl Write, year: u16) -> Result<YearReport> {
    let mut csv = csv::ReaderBuilder::new().from_reader(raw);
    let columns = Columns::of(csv.headers()?)?;
    let mut report = YearReport { annee: year, version_nettoyage: CLEAN_VERSION, ..Default::default() };
    let mut pending = Pending::default();
    let mut started = false;
    let mut record = csv::ByteRecord::new();
    // Les identifiants déjà vus (huit chiffres en moyenne : ~1,7 M entrées, 40 Mo) servent à vérifier que le fichier est bien
    // trié par mutation ; on ne retient que les 8 derniers octets d'un hachage pour que ce soit léger.
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let finish = |pending: &Pending, report: &mut YearReport, out: &mut dyn Write| -> Result<()> {
        report.mutations += 1;
        match pending.judge() {
            Ok(sale) => {
                report.gardees += 1;
                if sale.kind == 0 { report.appartements += 1 } else { report.maisons += 1 }
                writeln!(out, "{:.6},{:.6},{:04}-{:02}-{:02},{},{},{},{}", sale.lon, sale.lat, sale.date.0, sale.date.1, sale.date.2, sale.kind, sale.rooms, sale.surface, sale.price)?;
            }
            Err(reason) => *report.ecartees.entry(reason.to_string()).or_insert(0) += 1,
        }
        Ok(())
    };
    while csv.read_byte_record(&mut record)? {
        report.lignes += 1;
        let id = record.get(columns.id).unwrap_or_default();
        if !started || id != pending.id.as_slice() {
            if started {
                finish(&pending, &mut report, out)?;
            }
            let hash = id.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3));
            if !seen.insert(hash) {
                bail!("le fichier DVF {year} n'est pas trié par mutation (identifiant {} revu plus loin)", String::from_utf8_lossy(id));
            }
            pending.begin(&record, &columns);
            started = true;
        }
        pending.add(&record, &columns);
    }
    if started {
        finish(&pending, &mut report, out)?;
    }
    Ok(report)
}

// ---------------------------------------------------------------------------------------------
// Lecture des fichiers nettoyés
// ---------------------------------------------------------------------------------------------

pub fn sales_path(dir: &Path, year: u16) -> PathBuf {
    dir.join(format!("ventes-{year}.csv.gz"))
}

pub fn report_path(dir: &Path, year: u16) -> PathBuf {
    dir.join(format!("rapport-{year}.json"))
}

/// Les années dont on a un fichier nettoyé à jour, dans l'ordre.
pub fn cleaned_years(dir: &Path) -> Vec<u16> {
    let mut years: Vec<u16> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix("ventes-")?.strip_suffix(".csv.gz")?.parse().ok())
        .collect();
    years.sort_unstable();
    years
}

pub fn read_report(dir: &Path, year: u16) -> Option<YearReport> {
    serde_json::from_slice(&std::fs::read(report_path(dir, year)).ok()?).ok()
}

/// Lit les ventes nettoyées d'une année, une à une.
pub fn read_sales(dir: &Path, year: u16, mut each: impl FnMut(Sale) -> Result<()>) -> Result<()> {
    let file = File::open(sales_path(dir, year)).with_context(|| format!("ventes {year} absentes"))?;
    for line in std::io::BufRead::lines(BufReader::with_capacity(1 << 16, GzDecoder::new(BufReader::new(file)))) {
        if let Some(sale) = parse_line(&line.context("ventes illisibles")?) {
            each(sale)?;
        }
    }
    Ok(())
}

pub fn parse_line(line: &str) -> Option<Sale> {
    let mut f = line.split(',');
    let (lon, lat) = (f.next()?.parse().ok()?, f.next()?.parse().ok()?);
    let mut d = f.next()?.split('-');
    let date = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    Some(Sale { lon, lat, date, kind: f.next()?.parse().ok()?, rooms: f.next()?.parse().ok()?, surface: f.next()?.parse().ok()?, price: f.next()?.parse().ok()? })
}

// ---------------------------------------------------------------------------------------------
// Téléchargement
// ---------------------------------------------------------------------------------------------

/// Années publiées chez Etalab, d'après l'index du dossier `latest/csv/`.
async fn published_years(http: &reqwest::Client) -> Result<Vec<u16>> {
    let text = http.get(format!("{BASE_URL}/")).send().await?.error_for_status()?.text().await?;
    let mut years: Vec<u16> = text
        .match_indices("/csv/")
        .filter_map(|(at, _)| text.get(at + 5..at + 9)?.parse::<u16>().ok())
        .filter(|y| (2014..2100).contains(y))
        .collect();
    years.sort_unstable();
    years.dedup();
    Ok(years)
}

/// Les années à utiliser : les 5 dernières années **complètes** publiées (donc avant l'année courante), plus l'année
/// courante si elle est publiée (elle est partielle).
pub fn choose_years(published: &[u16], current_year: u16) -> Vec<u16> {
    let mut complete: Vec<u16> = published.iter().copied().filter(|y| *y < current_year).collect();
    let skip = complete.len().saturating_sub(5);
    let mut years = complete.split_off(skip);
    if published.contains(&current_year) {
        years.push(current_year);
    }
    years
}

/// S'assure que le dossier contient les ventes nettoyées des bonnes années, à jour chez Etalab.
pub async fn acquire(http: &reqwest::Client, dir: &Path, current_year: u16) -> Result<()> {
    let published = published_years(http).await.context("index des années DVF")?;
    let years = choose_years(&published, current_year);
    if years.is_empty() {
        bail!("aucune année DVF publiée");
    }
    for year in &years {
        let url = format!("{BASE_URL}/{year}/full.csv.gz");
        let head = http.head(&url).send().await?.error_for_status()?;
        let modified = head.headers().get(reqwest::header::LAST_MODIFIED).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if read_report(dir, *year).is_some_and(|r| r.version_nettoyage == CLEAN_VERSION && r.derniere_modification == modified)
            && sales_path(dir, *year).exists()
        {
            continue;
        }
        let raw = dir.join(format!("brut-{year}.csv.gz"));
        info!(annee = year, "dvf : téléchargement");
        let mut response = http.get(&url).timeout(std::time::Duration::from_secs(3600)).send().await?.error_for_status()?;
        let mut file = BufWriter::new(File::create(&raw)?);
        let mut bytes = 0u64;
        while let Some(chunk) = response.chunk().await? {
            file.write_all(&chunk)?;
            bytes += chunk.len() as u64;
        }
        file.flush()?;
        drop(file);
        if bytes < 1_000_000 {
            bail!("fichier DVF {year} suspect ({bytes} octets)");
        }
        let (dir2, raw2, year2, modified2) = (dir.to_path_buf(), raw.clone(), *year, modified);
        // Le nettoyage est du calcul pur (~30 s par an) : hors du moteur asynchrone.
        let report = tokio::task::spawn_blocking(move || -> Result<YearReport> {
            let partial = dir2.join(format!("ventes-{year2}.csv.gz.partiel"));
            let mut out = GzEncoder::new(BufWriter::new(File::create(&partial)?), Compression::new(6));
            let mut report = clean(GzDecoder::new(BufReader::new(File::open(&raw2)?)), &mut out, year2)?;
            out.finish()?.flush()?;
            report.derniere_modification = modified2;
            std::fs::rename(&partial, sales_path(&dir2, year2))?;
            std::fs::write(report_path(&dir2, year2), serde_json::to_vec_pretty(&report)?)?;
            Ok(report)
        })
        .await??;
        let _ = std::fs::remove_file(&raw);
        info!(annee = year, mo = bytes / 1_048_576, mutations = report.mutations, gardees = report.gardees, "dvf : année nettoyée");
    }
    // Les années qui ne sont plus retenues (trop vieilles) sont supprimées.
    for old in cleaned_years(dir).into_iter().filter(|y| !years.contains(y)) {
        warn!(annee = old, "dvf : année obsolète supprimée");
        let _ = std::fs::remove_file(sales_path(dir, old));
        let _ = std::fs::remove_file(report_path(dir, old));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "id_mutation,date_mutation,numero_disposition,nature_mutation,valeur_fonciere,adresse_numero,adresse_suffixe,adresse_nom_voie,adresse_code_voie,code_postal,code_commune,nom_commune,code_departement,ancien_code_commune,ancien_nom_commune,id_parcelle,ancien_id_parcelle,numero_volume,lot1_numero,lot1_surface_carrez,lot2_numero,lot2_surface_carrez,lot3_numero,lot3_surface_carrez,lot4_numero,lot4_surface_carrez,lot5_numero,lot5_surface_carrez,nombre_lots,code_type_local,type_local,surface_reelle_bati,nombre_pieces_principales,code_nature_culture,nature_culture,code_nature_culture_speciale,nature_culture_speciale,surface_terrain,longitude,latitude";

    /// Une ligne : (mutation, disposition, nature, prix, département, parcelle, type, surface, pièces, culture, terrain, lon, lat).
    #[allow(clippy::too_many_arguments)]
    fn row(id: &str, disp: &str, nature: &str, price: &str, dep: &str, parcel: &str, local: &str, surface: &str, rooms: &str, culture: &str, land: &str, lon: &str, lat: &str) -> String {
        format!("{id},2024-03-15,{disp},{nature},{price},,,RUE,,75001,75101,Paris,{dep},,,{parcel},,,,,,,,,,,,,0,,{local},{surface},{rooms},,{culture},,,{land},{lon},{lat}")
    }

    fn run(rows: &[String]) -> (YearReport, String) {
        let mut text = HEADER.to_string();
        for r in rows {
            text.push('\n');
            text.push_str(r);
        }
        let mut out = Vec::new();
        let report = clean(text.as_bytes(), &mut out, 2024).unwrap();
        (report, String::from_utf8(out).unwrap())
    }

    #[test]
    fn une_vente_a_plusieurs_lignes_ne_compte_qu_une_fois() {
        // Un appartement de 50 m² à 300 000 € avec une cave : deux lignes, même prix. 6 000 €/m², pas 12 000.
        let (report, out) = run(&[
            row("A-1", "000001", "Vente", "300000", "75", "P1", "Appartement", "50", "2", "", "", "2.35", "48.85"),
            row("A-1", "000001", "Vente", "300000", "75", "P1", "Dépendance", "", "0", "", "", "2.35", "48.85"),
        ]);
        assert_eq!((report.lignes, report.mutations, report.gardees, report.appartements), (2, 1, 1, 1));
        assert_eq!(out.trim(), "2.350000,48.850000,2024-03-15,0,2,50,300000");
    }

    #[test]
    fn les_ventes_de_plusieurs_biens_ou_mixtes_sont_ecartees() {
        let (report, out) = run(&[
            // Deux appartements dans la même vente.
            row("B-1", "000001", "Vente", "500000", "75", "P1", "Appartement", "40", "2", "", "", "2.35", "48.85"),
            row("B-1", "000001", "Vente", "500000", "75", "P1", "Appartement", "45", "2", "", "", "2.35", "48.85"),
            // Un appartement avec un local commercial.
            row("B-2", "000001", "Vente", "500000", "75", "P2", "Appartement", "40", "2", "", "", "2.35", "48.85"),
            row("B-2", "000001", "Vente", "500000", "75", "P2", "Local industriel. commercial ou assimilé", "60", "0", "", "", "2.35", "48.85"),
            // VEFA.
            row("B-3", "000001", "Vente en l'état futur d'achèvement", "300000", "75", "P3", "Appartement", "50", "2", "", "", "2.35", "48.85"),
            // Deux dispositions.
            row("B-4", "000001", "Vente", "300000", "75", "P4", "Appartement", "50", "2", "", "", "2.35", "48.85"),
            row("B-4", "000002", "Vente", "300000", "75", "P4", "", "", "", "S", "100", "2.35", "48.85"),
        ]);
        assert_eq!(report.gardees, 0, "{out}");
        assert_eq!(report.mutations, 4);
        assert_eq!(report.ecartees["plusieurs logements"], 1);
        assert_eq!(report.ecartees["local commercial ou industriel"], 1);
        assert_eq!(report.ecartees["plusieurs dispositions"], 1);
    }

    #[test]
    fn les_valeurs_aberrantes_sont_ecartees() {
        let (report, out) = run(&[
            row("C-1", "000001", "Vente", "5000", "75", "P1", "Appartement", "50", "2", "", "", "2.35", "48.85"), // prix dérisoire
            row("C-2", "000001", "Vente", "900000", "75", "P2", "Appartement", "20", "1", "", "", "2.35", "48.85"), // 45 000 €/m²
            row("C-3", "000001", "Vente", "50000", "75", "P3", "Maison", "200", "6", "", "", "2.35", "48.85"), // 250 €/m²
            row("C-4", "000001", "Vente", "150000", "01", "P4", "Maison", "100", "5", "S", "15000", "5.3", "46.3"), // 1,5 ha
            row("C-5", "000001", "Vente", "150000", "971", "P5", "Maison", "100", "5", "", "300", "-61.5", "16.2"), // Guadeloupe
            row("C-6", "000001", "Vente", "150000", "01", "P6", "Maison", "100", "5", "", "300", "", ""), // sans coordonnées
            row("C-7", "000001", "Vente", "150000", "01", "P7", "Maison", "100", "5", "S", "300", "5.3", "46.3"), // bon
        ]);
        assert_eq!(report.mutations, 7);
        assert_eq!((report.gardees, report.maisons), (1, 1), "{out}");
        assert!(out.starts_with("5.300000,46.300000"));
    }

    #[test]
    fn le_terrain_repete_sur_plusieurs_lignes_n_est_compte_qu_une_fois() {
        // Une maison de 9 000 m² de terrain, répétés sur deux lignes (maison + dépendance) : 9 000, pas 18 000.
        let (report, _) = run(&[
            row("D-1", "000001", "Vente", "200000", "01", "P1", "Maison", "100", "5", "S", "9000", "5.3", "46.3"),
            row("D-1", "000001", "Vente", "200000", "01", "P1", "Dépendance", "", "0", "S", "9000", "5.3", "46.3"),
        ]);
        assert_eq!(report.gardees, 1);
    }

    #[test]
    fn un_identifiant_qui_revient_est_refuse() {
        let mut text = HEADER.to_string();
        for id in ["E-1", "E-2", "E-1"] {
            text.push('\n');
            text.push_str(&row(id, "000001", "Vente", "300000", "75", "P1", "Appartement", "50", "2", "", "", "2.35", "48.85"));
        }
        assert!(clean(text.as_bytes(), &mut Vec::new(), 2024).is_err());
    }

    #[test]
    fn choix_des_annees() {
        // Fin 2026 : 2021-2025 publiées, 2026 pas encore.
        assert_eq!(choose_years(&[2021, 2022, 2023, 2024, 2025], 2026), vec![2021, 2022, 2023, 2024, 2025]);
        // Si l'année courante est publiée (partielle), elle s'ajoute ; les 5 années complètes restent les 5 dernières.
        assert_eq!(choose_years(&[2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], 2026), vec![2021, 2022, 2023, 2024, 2025, 2026]);
    }

    #[test]
    fn aller_retour_d_une_ligne() {
        let sale = parse_line("2.350000,48.850000,2024-03-15,1,5,120,350000").unwrap();
        assert_eq!((sale.kind, sale.rooms, sale.surface, sale.price, sale.date), (1, 5, 120, 350_000, (2024, 3, 15)));
        assert!((sale.euro_m2() - 2916.67).abs() < 0.01);
    }
}
