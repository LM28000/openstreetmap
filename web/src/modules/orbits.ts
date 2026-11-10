/**
 * Calcul des orbites pour le module « Satellites » : propagation SGP4 (satellite.js),
 * échantillonnage à pas régulier avec interpolation, ombre de la Terre, visibilité.
 *
 * Coût : SGP4 prend environ 1 µs par satellite, mais propager des milliers d'objets
 * à chaque image resterait trop lourd. On calcule donc la position de tous les
 * satellites à des instants espacés de `STEP_MS` (« échantillons »), et on interpole
 * entre deux échantillons à chaque image : quelques opérations par satellite.
 * Les échantillons sont des vecteurs dans le repère lié à la Terre (ECF, en km) :
 * entre deux échantillons proches, interpoler le vecteur puis le ramener au bon rayon
 * donne la position à moins de quelques dizaines de mètres près.
 */
import { ecfToLookAngles, eciToGeodetic, gstime, json2satrec, propagate, type SatRec } from './satelliteCore';
import { subsolarPoint, sunElevation } from './solar';

const DEG = Math.PI / 180;
const EARTH_RADIUS_KM = 6371;
/** Rayon équatorial et carré de l'excentricité de l'ellipsoïde WGS 84. */
const WGS84_A = 6378.137;
const WGS84_E2 = 0.00669437999014;
/** Constante gravitationnelle de la Terre (km³/s²), pour retrouver le demi-grand axe. */
const MU = 398_600.4418;

/** Écart entre deux échantillons de positions. */
export const STEP_MS = 20_000;
/** Temps maximal consacré, à chaque image, à préparer l'échantillon suivant (gros jeux de données). */
const PREFETCH_BUDGET_MS = 1.2;

/** Éléments orbitaux tels que le serveur les sert (`/api/satellites`). */
export interface ApiSatellite {
  name: string;
  id: number;
  intl: string;
  group: string;
  epoch: string;
  meanMotion: number;
  eccentricity: number;
  inclination: number;
  raan: number;
  argOfPericenter: number;
  meanAnomaly: number;
  elementSet: number;
  revolutions: number;
  bstar: number;
  meanMotionDot: number;
  meanMotionDdot: number;
}

export interface Satellite {
  id: number;
  name: string;
  /** Désignation internationale (« 1998-067A »). */
  intl: string;
  group: string;
  /** Date des éléments orbitaux, en ms UTC. */
  epoch: number;
  satrec: SatRec;
  /** Position dans les tableaux de l'échantillonneur. */
  index: number;
  periodMin: number;
  inclination: number;
  eccentricity: number;
  /** Altitudes du périgée et de l'apogée (km), d'après les éléments. */
  perigeeKm: number;
  apogeeKm: number;
}

export function toSatellite(api: ApiSatellite, index: number): Satellite | null {
  const epoch = Date.parse(`${api.epoch}Z`);
  if (!Number.isFinite(epoch) || api.meanMotion <= 0) return null;
  let satrec: SatRec;
  try {
    satrec = json2satrec({
      OBJECT_NAME: api.name,
      OBJECT_ID: api.intl,
      EPOCH: api.epoch,
      MEAN_MOTION: api.meanMotion,
      ECCENTRICITY: api.eccentricity,
      INCLINATION: api.inclination,
      RA_OF_ASC_NODE: api.raan,
      ARG_OF_PERICENTER: api.argOfPericenter,
      MEAN_ANOMALY: api.meanAnomaly,
      EPHEMERIS_TYPE: 0,
      CLASSIFICATION_TYPE: 'U',
      NORAD_CAT_ID: api.id,
      ELEMENT_SET_NO: api.elementSet,
      REV_AT_EPOCH: api.revolutions,
      BSTAR: api.bstar,
      MEAN_MOTION_DOT: api.meanMotionDot,
      MEAN_MOTION_DDOT: api.meanMotionDdot,
    });
  } catch {
    return null; // éléments inutilisables : on ignore ce satellite
  }
  // Troisième loi de Kepler : n (rad/s) → demi-grand axe.
  const n = (api.meanMotion * 2 * Math.PI) / 86_400;
  const semiMajor = Math.cbrt(MU / (n * n));
  return {
    id: api.id,
    name: api.name,
    intl: api.intl,
    group: api.group,
    epoch,
    satrec,
    index,
    periodMin: 1440 / api.meanMotion,
    inclination: api.inclination,
    eccentricity: api.eccentricity,
    perigeeKm: semiMajor * (1 - api.eccentricity) - WGS84_A,
    apogeeKm: semiMajor * (1 + api.eccentricity) - WGS84_A,
  };
}

/** Position dans le repère terrestre (km), ou `null` si SGP4 échoue (satellite retombé, éléments absurdes). */
function ecfAt(satrec: SatRec, date: Date, gmst: number): { x: number; y: number; z: number } | null {
  const result = propagate(satrec, date);
  if (!result) return null;
  const { x, y, z } = result.position;
  if (!Number.isFinite(x)) return null;
  const c = Math.cos(gmst);
  const s = Math.sin(gmst);
  return { x: c * x + s * y, y: -s * x + c * y, z };
}

/** Longitude, latitude (degrés) et altitude (km) d'un point du repère terrestre, sans itération. */
export function ecfToLonLatAlt(x: number, y: number, z: number, out: { lon: number; lat: number; alt: number }): void {
  const r = Math.hypot(x, y, z);
  const geocentric = Math.asin(z / r);
  const cos = Math.cos(geocentric);
  // Latitude géodésique d'après la latitude géocentrique, et rayon de l'ellipsoïde à cet endroit.
  out.lat = Math.atan(Math.tan(geocentric) / (1 - WGS84_E2)) / DEG;
  out.lon = Math.atan2(y, x) / DEG;
  out.alt = r - WGS84_A * Math.sqrt((1 - WGS84_E2) / (1 - WGS84_E2 * cos * cos));
}

/** Direction du soleil dans le repère terrestre (vecteur unitaire) à l'instant t. */
export function sunDirection(time: number): [number, number, number] {
  const { lat, lon } = subsolarPoint(time);
  const cosLat = Math.cos(lat * DEG);
  return [cosLat * Math.cos(lon * DEG), cosLat * Math.sin(lon * DEG), Math.sin(lat * DEG)];
}

/** Dans l'ombre de la Terre ? (modèle du cylindre : suffisant pour dire « éclairé » ou non). */
export function inEarthShadow(x: number, y: number, z: number, sun: readonly [number, number, number]): boolean {
  const along = x * sun[0] + y * sun[1] + z * sun[2];
  if (along >= 0) return false; // du côté du soleil
  const perpendicular2 = x * x + y * y + z * z - along * along;
  return perpendicular2 < EARTH_RADIUS_KM * EARTH_RADIUS_KM;
}

/** Positions de tous les satellites à un instant donné (km, repère terrestre), 3 valeurs par satellite. */
interface Sample {
  /** Numéro du pas : l'instant est `step × STEP_MS`. */
  step: number;
  xyz: Float64Array;
  /** 1 si la position est valide. */
  valid: Uint8Array;
  /** Nombre de satellites déjà calculés (l'échantillon suivant se prépare par morceaux). */
  done: number;
}

/** Résultat de l'interpolation à un instant : tableaux réutilisés d'une image à l'autre. */
export interface Positions {
  /** Longitude, latitude (degrés), altitude (km) par satellite. */
  lonLatAlt: Float64Array;
  /** 0 : position inconnue ; 1 : dans l'ombre de la Terre ; 2 : éclairé par le soleil. */
  state: Uint8Array;
  /** Instant auquel ces positions correspondent. */
  time: number;
}

export class OrbitSampler {
  private readonly samples = new Map<number, Sample>();
  private readonly positions: Positions;
  private readonly scratch = { lon: 0, lat: 0, alt: 0 };

  constructor(readonly satellites: readonly Satellite[]) {
    this.positions = {
      lonLatAlt: new Float64Array(satellites.length * 3),
      state: new Uint8Array(satellites.length),
      time: Number.NaN,
    };
  }

  /**
   * Positions interpolées à l'instant t. Le même objet est renvoyé d'une image à l'autre
   * (rempli de nouveau seulement si t a changé) : ne pas le conserver.
   */
  at(time: number): Positions {
    if (time === this.positions.time) return this.positions;
    const step = Math.floor(time / STEP_MS);
    const before = this.complete(step);
    const after = this.complete(step + 1);
    this.prefetch(step + 2);
    // On ne garde que les échantillons proches : après un saut dans le temps, les anciens sont inutiles.
    for (const key of this.samples.keys()) if (key < step - 1 || key > step + 3) this.samples.delete(key);

    const f = (time - step * STEP_MS) / STEP_MS;
    const sun = sunDirection(time);
    const { lonLatAlt, state } = this.positions;
    for (let i = 0; i < this.satellites.length; i++) {
      const k = i * 3;
      if (!before.valid[i] || !after.valid[i]) {
        state[i] = 0;
        continue;
      }
      const ax = before.xyz[k]!;
      const ay = before.xyz[k + 1]!;
      const az = before.xyz[k + 2]!;
      const bx = after.xyz[k]!;
      const by = after.xyz[k + 1]!;
      const bz = after.xyz[k + 2]!;
      // Interpolation du vecteur, puis retour au rayon interpolé (la trajectoire est un arc, pas une corde).
      let x = ax + (bx - ax) * f;
      let y = ay + (by - ay) * f;
      let z = az + (bz - az) * f;
      const rA = Math.hypot(ax, ay, az);
      const rB = Math.hypot(bx, by, bz);
      const scale = (rA + (rB - rA) * f) / Math.hypot(x, y, z);
      x *= scale;
      y *= scale;
      z *= scale;
      ecfToLonLatAlt(x, y, z, this.scratch);
      lonLatAlt[k] = this.scratch.lon;
      lonLatAlt[k + 1] = this.scratch.lat;
      lonLatAlt[k + 2] = this.scratch.alt;
      state[i] = inEarthShadow(x, y, z, sun) ? 1 : 2;
    }
    this.positions.time = time;
    return this.positions;
  }

  /** Échantillon entièrement calculé pour ce pas (en bloquant s'il n'était pas prêt). */
  private complete(step: number): Sample {
    const sample = this.sample(step);
    this.fill(sample, Number.POSITIVE_INFINITY);
    return sample;
  }

  /** Avance la préparation de l'échantillon suivant, sans dépasser le budget de temps de l'image. */
  private prefetch(step: number): void {
    const sample = this.sample(step);
    if (sample.done < this.satellites.length) this.fill(sample, PREFETCH_BUDGET_MS);
  }

  private sample(step: number): Sample {
    let sample = this.samples.get(step);
    if (!sample) {
      const n = this.satellites.length;
      sample = { step, xyz: new Float64Array(n * 3), valid: new Uint8Array(n), done: 0 };
      this.samples.set(step, sample);
    }
    return sample;
  }

  private fill(sample: Sample, budgetMs: number): void {
    if (sample.done >= this.satellites.length) return;
    const date = new Date(sample.step * STEP_MS);
    const gmst = gstime(date);
    const started = performance.now();
    while (sample.done < this.satellites.length) {
      const i = sample.done++;
      const position = ecfAt(this.satellites[i]!.satrec, date, gmst);
      if (position) {
        sample.xyz[i * 3] = position.x;
        sample.xyz[i * 3 + 1] = position.y;
        sample.xyz[i * 3 + 2] = position.z;
        sample.valid[i] = 1;
      }
      // Toutes les 256 propagations, on regarde l'heure : mesurer coûte plus cher qu'un calcul.
      if ((i & 255) === 255 && performance.now() - started > budgetMs) break;
    }
  }
}

/** Calcul précis pour un seul satellite (fiche, trace) : pas d'interpolation, géodésie exacte. */
export interface Exact {
  lon: number;
  lat: number;
  altKm: number;
  /** Vitesse sur l'orbite, en km/s (par rapport aux étoiles). */
  speedKmS: number;
  sunlit: boolean;
  ecf: { x: number; y: number; z: number };
}

export function exactAt(satellite: Satellite, time: number): Exact | null {
  const date = new Date(time);
  const result = propagate(satellite.satrec, date);
  if (!result || !Number.isFinite(result.position.x)) return null;
  const gmst = gstime(date);
  const geodetic = eciToGeodetic(result.position, gmst);
  const c = Math.cos(gmst);
  const s = Math.sin(gmst);
  const { x, y, z } = result.position;
  const ecf = { x: c * x + s * y, y: -s * x + c * y, z };
  const { x: vx, y: vy, z: vz } = result.velocity;
  return {
    lon: geodetic.longitude / DEG,
    lat: geodetic.latitude / DEG,
    altKm: geodetic.height,
    speedKmS: Math.hypot(vx, vy, vz),
    sunlit: !inEarthShadow(ecf.x, ecf.y, ecf.z, sunDirection(time)),
    ecf,
  };
}

export interface Visibility {
  /** Hauteur du satellite au-dessus de l'horizon de l'observateur, en degrés. */
  elevation: number;
  /** Hauteur du soleil pour l'observateur, en degrés. */
  sunElevation: number;
  sunlit: boolean;
  /** Au-dessus de l'horizon, éclairé, et ciel assez sombre : à voir à l'œil nu. */
  visible: boolean;
}

/** Ciel assez sombre pour voir un satellite : soleil à plus de 6° sous l'horizon (fin du crépuscule civil). */
const DARK_SKY_SUN_ELEVATION = -6;

export function visibilityFrom(
  observer: { lon: number; lat: number },
  satellite: Satellite,
  time: number,
): Visibility | null {
  const exact = exactAt(satellite, time);
  if (!exact) return null;
  const look = ecfToLookAngles(
    { longitude: observer.lon * DEG, latitude: observer.lat * DEG, height: 0 },
    { x: exact.ecf.x, y: exact.ecf.y, z: exact.ecf.z },
  );
  const elevation = look.elevation / DEG;
  const sun = sunElevation(observer.lat, observer.lon, time);
  return {
    elevation,
    sunElevation: sun,
    sunlit: exact.sunlit,
    visible: elevation > 0 && exact.sunlit && sun < DARK_SKY_SUN_ELEVATION,
  };
}

export interface GroundTrack {
  /** Trace déjà parcourue, en segments (coupés au passage de la ligne de changement de date). */
  past: Array<Array<[number, number]>>;
  future: Array<Array<[number, number]>>;
}

/** Points de la trace de chaque côté de l'instant t. */
const TRACK_POINTS = 150;
/** Demi-orbite de chaque côté, au plus 12 h (orbites très longues). */
const MAX_TRACK_SPAN_MS = 12 * 3_600_000;

/** Trace au sol sur environ une orbite : une demi-orbite passée, une demi-orbite à venir. */
export function groundTrack(satellite: Satellite, time: number): GroundTrack {
  const half = Math.min(MAX_TRACK_SPAN_MS, (satellite.periodMin * 60_000) / 2);
  const step = half / TRACK_POINTS;
  const point = (t: number): [number, number] | null => {
    const date = new Date(t);
    const ecf = ecfAt(satellite.satrec, date, gstime(date));
    if (!ecf) return null;
    const out = { lon: 0, lat: 0, alt: 0 };
    ecfToLonLatAlt(ecf.x, ecf.y, ecf.z, out);
    return [out.lon, out.lat];
  };
  const build = (from: number, to: number): Array<Array<[number, number]>> => {
    const segments: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];
    let previous: [number, number] | null = null;
    for (let t = from; t <= to + 1; t += step) {
      const p = point(t);
      if (!p) continue;
      if (previous && Math.abs(p[0] - previous[0]) > 180) {
        // Passage de la ligne de changement de date : on termine chaque morceau au bord, pour ne pas laisser de trou.
        const east = previous[0] > 0;
        const share = ((east ? 180 : -180) - previous[0]) / (p[0] + (east ? 360 : -360) - previous[0]);
        const crossingLat = previous[1] + (p[1] - previous[1]) * share;
        current.push([east ? 180 : -180, crossingLat]);
        segments.push(current);
        current = [[east ? -180 : 180, crossingLat]];
      }
      current.push(p);
      previous = p;
    }
    if (current.length > 1) segments.push(current);
    return segments;
  };
  return { past: build(time - half, time), future: build(time, time + half) };
}
