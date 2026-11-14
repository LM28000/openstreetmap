use super::*;
use flate2::read::ZlibDecoder;
use std::io::Read;

/// Relit l'altitude d'un pixel « terrarium ».
fn decode_pixel(rgb: &[u8], i: usize) -> f64 {
    f64::from(rgb[i * 3]) * 256.0 + f64::from(rgb[i * 3 + 1]) + f64::from(rgb[i * 3 + 2]) / 256.0 - 32_768.0
}

fn flat(value: f32) -> Vec<f32> {
    vec![value; SIZE * SIZE]
}

#[test]
fn terrarium_round_trip() {
    let heights: Vec<f32> = (0..SIZE * SIZE).map(|i| -10.0 + i as f32 * 0.0137).collect();
    let rgb = terrarium(&heights);
    for i in [0, 1, 4_095, 100_000, SIZE * SIZE - 1] {
        assert!((decode_pixel(&rgb, i) - f64::from(heights[i])).abs() <= 1.0 / 32.0 + 1e-6, "pixel {i}");
    }
}

#[test]
fn terrarium_known_values() {
    // 0 m : 32 768 = 128 × 256 ; 1 000,5 m : 33 768,5 = 131 × 256 + 232 + 0,5.
    assert_eq!(terrarium(&[0.0]), [128, 0, 0]);
    assert_eq!(terrarium(&[1000.5]), [131, 232, 128]);
    // Sous le niveau de la mer : −2,25 m = 32 765,75.
    assert_eq!(terrarium(&[-2.25]), [127, 253, 192]);
    // Arrondi au 1/16 m : 1 cm de plus ou de moins ne change pas la tuile (le bruit du LiDAR est plus grand).
    assert_eq!(terrarium(&[1000.01]), terrarium(&[1000.0]));
    assert_ne!(terrarium(&[1000.07]), terrarium(&[1000.0]));
}

#[test]
fn bil_is_little_endian_floats() {
    let mut bytes = Vec::new();
    for i in 0..SIZE * SIZE {
        bytes.extend_from_slice(&(i as f32 / 4.0).to_le_bytes());
    }
    let parsed = parse_bil(&bytes).unwrap();
    assert_eq!(parsed[0], 0.0);
    assert_eq!(parsed[7], 1.75);
    assert!(parse_bil(&bytes[..100]).is_err(), "une erreur XML de l'IGN n'est pas un BIL");
}

#[test]
fn tile_bounds_match_web_mercator() {
    let [west, south, east, north] = tile_bounds(0, 0, 0);
    assert!((west + 20_037_508.342_789_244).abs() < 1e-6 && (east - 20_037_508.342_789_244).abs() < 1e-6);
    assert!((south + north).abs() < 1e-6);
    // Chamonix, zoom 14 (relevé dans la requête réelle faite à l'IGN).
    let [west, south, east, north] = tile_bounds(14, 8504, 5833);
    assert!((west - 763_147.3).abs() < 0.1 && (south - 5_767_632.4).abs() < 0.1);
    assert!((east - west - (north - south)).abs() < 1e-6);
}

#[test]
fn complete_tile_is_unchanged() {
    let lidar = flat(1_034.25);
    assert_eq!(blend(&lidar, None), lidar);
    assert_eq!(blend(&lidar, Some(&flat(1_030.0))), lidar);
}

#[test]
fn missing_pixels_fall_back_with_a_feather() {
    // La moitié gauche n'a pas de donnée (−9999), la droite est à 100 m ; le relief ordinaire est à 90 m.
    let mut lidar = flat(100.0);
    for y in 0..SIZE {
        for x in 0..SIZE / 2 {
            lidar[y * SIZE + x] = -9999.0;
        }
    }
    let out = blend(&lidar, Some(&flat(90.0)));
    let row = 10 * SIZE;
    assert_eq!(out[row], 90.0, "sans donnée : relief ordinaire");
    assert_eq!(out[row + SIZE / 2 - 1], 90.0);
    assert_eq!(out[row + SIZE - 1], 100.0, "loin du bord : LiDAR pur");
    // Dans le fondu, l'altitude passe de 90 à 100 sans marche ni dépassement.
    let ramp: Vec<f32> = (SIZE / 2..SIZE / 2 + 12).map(|x| out[row + x]).collect();
    assert!(ramp.windows(2).all(|w| w[1] >= w[0] && w[1] - w[0] < 2.0), "{ramp:?}");
    assert!(ramp.iter().all(|&v| (90.0..=100.0).contains(&v)));
}

#[test]
fn missing_pixels_without_base_are_sea_level() {
    let mut lidar = flat(50.0);
    lidar[0] = -9999.0;
    let out = blend(&lidar, None);
    assert_eq!(out[0], 0.0);
    assert_eq!(out[SIZE * SIZE - 1], 50.0);
}

#[test]
fn resampling_artefacts_at_the_edge_are_rejected() {
    // Un pixel mêlé à du sans-donnée par l'IGN : 1 500 m devient 925 m (au-dessus du seuil de sans-donnée).
    let mut lidar = flat(1_500.0);
    lidar[SIZE * 5 + 5] = 925.0;
    let out = blend(&lidar, Some(&flat(1_500.0)));
    assert!(out[SIZE * 5 + 5] > 1_490.0, "le pixel douteux ne doit pas creuser le relief : {}", out[SIZE * 5 + 5]);
}

#[test]
fn distance_is_zero_on_invalid_and_grows_away() {
    let mut valid = vec![true; SIZE * SIZE];
    valid[100 * SIZE + 100] = false;
    let d = distance_to_invalid(&valid);
    assert_eq!(d[100 * SIZE + 100], 0.0);
    assert_eq!(d[100 * SIZE + 103], 3.0);
    assert!((d[103 * SIZE + 103] - 3.0 * std::f32::consts::SQRT_2).abs() < 1e-4);
}

#[test]
fn png_is_valid_and_decodes_to_the_same_pixels() {
    let heights: Vec<f32> = (0..SIZE * SIZE).map(|i| 1_000.0 + (i % SIZE) as f32 * 0.37 + (i / SIZE) as f32 * 0.11).collect();
    let rgb = terrarium(&heights);
    let png = encode_png(&rgb).unwrap();
    assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    // Parcourt les blocs : IHDR, IDAT, IEND, avec leur somme de contrôle.
    let (mut pos, mut idat, mut kinds) = (8, Vec::new(), Vec::new());
    while pos < png.len() {
        let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
        let kind = &png[pos + 4..pos + 8];
        let data = &png[pos + 8..pos + 8 + len];
        let mut crc = flate2::Crc::new();
        crc.update(kind);
        crc.update(data);
        assert_eq!(u32::from_be_bytes(png[pos + 8 + len..pos + 12 + len].try_into().unwrap()), crc.sum());
        kinds.push(String::from_utf8_lossy(kind).into_owned());
        if kind == b"IHDR" {
            assert_eq!(u32::from_be_bytes(data[..4].try_into().unwrap()) as usize, SIZE);
            assert_eq!(&data[8..], &[8, 2, 0, 0, 0]);
        }
        if kind == b"IDAT" {
            idat.extend_from_slice(data);
        }
        pos += 12 + len;
    }
    assert_eq!(kinds, ["IHDR", "IDAT", "IEND"]);
    let mut raw = Vec::new();
    ZlibDecoder::new(&idat[..]).read_to_end(&mut raw).unwrap();
    assert_eq!(raw.len(), (SIZE * 3 + 1) * SIZE);
    // Défiltre « Sub » et compare à l'image d'origine.
    for (y, line) in raw.chunks_exact(SIZE * 3 + 1).enumerate() {
        assert_eq!(line[0], 1);
        let mut prev = [0u8; 3];
        for x in 0..SIZE {
            for c in 0..3 {
                prev[c] = line[1 + x * 3 + c].wrapping_add(prev[c]);
                assert_eq!(prev[c], rgb[(y * SIZE + x) * 3 + c]);
            }
        }
    }
}

#[test]
fn prune_removes_expired_then_oldest() {
    let dir = std::env::temp_dir().join(format!("vigie-relief-lidar-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("14/1")).unwrap();
    for (i, name) in ["a", "b", "c"].iter().enumerate() {
        let path = dir.join(format!("14/1/{name}.png"));
        std::fs::write(&path, vec![0u8; 1000]).unwrap();
        let file = std::fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(1000 * (3 - i as u64))).unwrap();
    }
    // Un fichier expiré (plus de 30 jours).
    let old = dir.join("14/1/old.png");
    std::fs::write(&old, vec![0u8; 1000]).unwrap();
    std::fs::File::options().write(true).open(&old).unwrap().set_modified(SystemTime::now() - TILE_TTL - Duration::from_secs(10)).unwrap();
    assert_eq!(dir_size(&dir), 4000);
    // Plafond de 2 000 octets : l'expiré part, puis le plus ancien (a).
    let left = prune_dir(&dir, 2000);
    assert_eq!(left, 2000);
    assert!(!old.exists() && !dir.join("14/1/a.png").exists());
    assert!(dir.join("14/1/b.png").exists() && dir.join("14/1/c.png").exists());
    let _ = std::fs::remove_dir_all(&dir);
}
