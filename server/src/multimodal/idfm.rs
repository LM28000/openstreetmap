//! Île-de-France : métro, RER, Transilien et tramways, lus dans le GTFS d'Île-de-France Mobilités
//! (`IDFM-gtfs.zip`, le même fichier que celui des positions estimées de `estimates.rs`).
//!
//! Ce qu'on garde (`route_type` du GTFS) :
//! - `1` métro, `0` tramway (et navettes ORLYVAL et CDG VAL), `6` et `7` câble et funiculaire ;
//! - `2` train : les cinq RER (A à E, exploitant « RER ») et les lignes Transilien (H, J, K, L, N, P, R, U, V).
//!
//! Ce qu'on écarte : les bus (`3`, des centaines de lignes : trop gros et pas interurbain), et les **TER** que le
//! GTFS d'Île-de-France recopie (`route_short_name` = « TER ») : ils sont déjà dans les horaires de la SNCF.
//!
//! Les arrêts sont les *zones d'arrêt* (`parent_station`) : « Gare de Lyon » est une seule zone, tous modes confondus.
//! Le rattachement aux gares SNCF se fait plus tard, par proximité et nom (voir `Extras::build`).

use std::path::Path;

use anyhow::Result;
use jiff::civil::Date;

use super::feed::{FeedSpec, RouteRow, read};
use super::{Kind, Line, RawFeed};

pub const NAME: &str = "Île-de-France Mobilités";

/// Les RER ont une seule lettre de A à E ; les autres trains de la région sont des Transilien.
fn is_rer(short: &str) -> bool {
    matches!(short, "A" | "B" | "C" | "D" | "E")
}

/// Une ligne du GTFS d'Île-de-France : gardée ou non, et comment on l'affiche (voir l'en-tête du module).
pub fn classify(row: &RouteRow) -> Option<Line> {
    let short = row.short.trim();
    let (kind, label) = match row.route_type {
        1 => (Kind::Metro, format!("Métro {short}")),
        0 => {
            // « T3a » → « Tram T3a » ; « ORLYVAL » reste tel quel.
            let is_tram_name = short.starts_with('T') && short[1..].starts_with(|c: char| c.is_ascii_digit());
            (Kind::Tram, if is_tram_name { format!("Tram {short}") } else { short.to_string() })
        }
        6 | 7 => (Kind::Tram, if short.is_empty() { row.long.clone() } else { short.to_string() }),
        2 => {
            if short.eq_ignore_ascii_case("TER") || row.long.to_uppercase().starts_with("TER") {
                return None;
            }
            if is_rer(short) { (Kind::Rer, format!("RER {short}")) } else { (Kind::Transilien, format!("Transilien {short}")) }
        }
        _ => return None,
    };
    Some(Line { kind, label, name: row.long.clone(), color: row.color.clone(), text_color: row.text_color.clone() })
}

/// Lit le GTFS d'Île-de-France pour les `days` jours à partir de `first_day`.
pub fn read_feed(path: &Path, first_day: Date, days: u8) -> Result<RawFeed> {
    read(
        path,
        &FeedSpec {
            name: NAME,
            first_day,
            days,
            classify: &classify,
            use_parent: true,
            interurban_only: false,
            keep_stop: None,
            match_by_name: true,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(short: &str, long: &str, route_type: i32) -> RouteRow {
        RouteRow { short: short.into(), long: long.into(), desc: String::new(), route_type, color: Some("FFBE00".into()), text_color: None }
    }

    #[test]
    fn lignes_d_ile_de_france() {
        let label = |r: RouteRow| classify(&r).map(|l| (l.kind, l.label));
        assert_eq!(label(row("14", "14", 1)), Some((Kind::Metro, "Métro 14".into())));
        assert_eq!(label(row("B", "B", 2)), Some((Kind::Rer, "RER B".into())));
        assert_eq!(label(row("H", "H", 2)), Some((Kind::Transilien, "Transilien H".into())));
        assert_eq!(label(row("T3a", "T3a", 0)), Some((Kind::Tram, "Tram T3a".into())));
        assert_eq!(label(row("ORLYVAL", "ORLYVAL", 0)), Some((Kind::Tram, "ORLYVAL".into())));
        // Les TER recopiés et les bus sont écartés.
        assert_eq!(label(row("TER", "TER Normandie", 2)), None);
        assert_eq!(label(row("4244", "4244", 3)), None);
    }
}
