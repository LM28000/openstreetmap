/**
 * Champ de vent : lecture de la réponse du serveur, interpolation entre les heures,
 * ré-échantillonnage en coordonnées Mercator et lecture en un point.
 *
 * Tout ici est du calcul pur (aucune dépendance à la carte ni à WebGL) : le rendu des
 * particules (`windLayer.ts`) et la fiche au clic (`wind.ts`) partagent les mêmes fonctions,
 * donc les particules et la valeur affichée disent la même chose.
 */

/** Géométrie de la grille du serveur : points rangés ligne par ligne, du sud au nord. */
export interface WindGrid {
  west: number;
  south: number;
  step: number;
  nx: number;
  ny: number;
}

export interface WindData {
  /** Heure de la collecte du serveur (secondes UTC). */
  generatedAt: number;
  grid: WindGrid;
  /** Heures des champs (secondes UTC), croissantes. */
  times: number[];
  /** Pour chaque heure : composante vers l'est (`u`) et vers le nord (`v`), en m/s, un point après l'autre. */
  u: Float32Array[];
  v: Float32Array[];
}

/** Ce que le serveur envoie (`GET /api/vent`) : composantes en `unit` m/s, arrondies à l'entier. */
interface WindResponse {
  generatedAt: number;
  grid: WindGrid;
  unit: number;
  times: number[];
  u: number[][];
  v: number[][];
}

export function parseWindResponse(json: WindResponse): WindData {
  const { grid, unit, times } = json;
  const count = grid.nx * grid.ny;
  if (times.length === 0 || json.u.length !== times.length || json.v.length !== times.length) {
    throw new Error('champ de vent incohérent');
  }
  const scale = (hours: number[][]) =>
    hours.map((hour) => {
      if (hour.length !== count) throw new Error('champ de vent incohérent');
      return Float32Array.from(hour, (value) => value * unit);
    });
  return { generatedAt: json.generatedAt, grid, times, u: scale(json.u), v: scale(json.v) };
}

const DEG = Math.PI / 180;

/** Coordonnées Web Mercator normalisées : x de 0 (180° ouest) à 1, y de 0 (nord) à 1. */
export const mercatorX = (lon: number) => (lon + 180) / 360;
export const mercatorY = (lat: number) => 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) / (2 * Math.PI);
export const longitudeOf = (x: number) => x * 360 - 180;
export const latitudeOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG);

/** Fenêtre de temps couverte par les données. */
export function timeRange(data: WindData): { from: number; to: number } {
  return { from: data.times[0]!, to: data.times[data.times.length - 1]! };
}

/**
 * Champ à l'instant t (secondes UTC), interpolé linéairement entre les deux heures voisines.
 * `null` hors de la fenêtre couverte. `out` (2 valeurs par point : u puis v) est réutilisé s'il est fourni.
 */
export function interpolateHours(data: WindData, t: number, out?: Float32Array): Float32Array | null {
  const { times } = data;
  const last = times.length - 1;
  if (t < times[0]! || t > times[last]!) return null;
  let index = 0;
  while (index < last - 1 && times[index + 1]! <= t) index++;
  const span = times[index + 1]! - times[index]!;
  const mix = last === 0 || span <= 0 ? 0 : Math.min(1, (t - times[index]!) / span);
  const count = data.grid.nx * data.grid.ny;
  const result = out && out.length === count * 2 ? out : new Float32Array(count * 2);
  const u0 = data.u[index]!;
  const v0 = data.v[index]!;
  const u1 = data.u[Math.min(index + 1, last)]!;
  const v1 = data.v[Math.min(index + 1, last)]!;
  for (let i = 0; i < count; i++) {
    result[2 * i] = u0[i]! + (u1[i]! - u0[i]!) * mix;
    result[2 * i + 1] = v0[i]! + (v1[i]! - v0[i]!) * mix;
  }
  return result;
}

/**
 * Champ de vent en coordonnées Mercator : une grille régulière en x et en y Mercator, donc
 * lisible directement avec la position d'une particule (sans passer par la latitude) et par
 * un shader (texture à filtrage linéaire).
 */
export interface MercatorField {
  width: number;
  height: number;
  /** Étendue en coordonnées Mercator : `x0`, `x1` (ouest, est) et `y0`, `y1` (nord, sud). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Deux valeurs par point, u puis v (m/s), rangées ligne par ligne du nord au sud. */
  data: Float32Array;
}

/** Résolution verticale du champ Mercator, en multiple de celle de la grille du serveur. */
const ROW_OVERSAMPLING = 2;

export function emptyMercatorField(grid: WindGrid): MercatorField {
  const north = grid.south + (grid.ny - 1) * grid.step;
  const east = grid.west + (grid.nx - 1) * grid.step;
  const height = grid.ny * ROW_OVERSAMPLING;
  return {
    width: grid.nx,
    height,
    x0: mercatorX(grid.west),
    x1: mercatorX(east),
    y0: mercatorY(north),
    y1: mercatorY(grid.south),
    data: new Float32Array(grid.nx * height * 2),
  };
}

/** Ré-échantillonne un champ `interleaved` (u, v par point de la grille du serveur) dans `field`. */
export function resampleToMercator(grid: WindGrid, interleaved: Float32Array, field: MercatorField): void {
  const { nx, ny } = grid;
  for (let row = 0; row < field.height; row++) {
    const y = field.y0 + ((field.y1 - field.y0) * row) / (field.height - 1);
    // Ligne (fractionnaire) de la grille du serveur, comptée du sud.
    const gy = Math.min(ny - 1, Math.max(0, (latitudeOf(y) - grid.south) / grid.step));
    const j0 = Math.min(ny - 2, Math.floor(gy));
    const fy = gy - j0;
    for (let i = 0; i < nx; i++) {
      const a = (j0 * nx + i) * 2;
      const b = ((j0 + 1) * nx + i) * 2;
      const o = (row * nx + i) * 2;
      field.data[o] = interleaved[a]! * (1 - fy) + interleaved[b]! * fy;
      field.data[o + 1] = interleaved[a + 1]! * (1 - fy) + interleaved[b + 1]! * fy;
    }
  }
}

/** Vent (u, v en m/s) au point de coordonnées Mercator (x, y) ; `false` hors de la zone couverte. */
export function sampleMercator(field: MercatorField, x: number, y: number, out: [number, number]): boolean {
  const fx = (x - field.x0) / (field.x1 - field.x0);
  const fy = (y - field.y0) / (field.y1 - field.y0);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return false;
  const gx = fx * (field.width - 1);
  const gy = fy * (field.height - 1);
  const i0 = Math.min(field.width - 2, Math.floor(gx));
  const j0 = Math.min(field.height - 2, Math.floor(gy));
  const tx = gx - i0;
  const ty = gy - j0;
  const d = field.data;
  const w = field.width;
  const a = (j0 * w + i0) * 2;
  const b = a + 2;
  const c = a + w * 2;
  const e = c + 2;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  out[0] = d[a]! * w00 + d[b]! * w10 + d[c]! * w01 + d[e]! * w11;
  out[1] = d[a + 1]! * w00 + d[b + 1]! * w10 + d[c + 1]! * w01 + d[e + 1]! * w11;
  return true;
}

/** Vent (u, v en m/s) en un point, directement dans la grille du serveur (lecture à la maille d'origine). */
export function sampleGrid(grid: WindGrid, interleaved: Float32Array, lon: number, lat: number): [number, number] | null {
  const gx = (lon - grid.west) / grid.step;
  const gy = (lat - grid.south) / grid.step;
  if (gx < 0 || gx > grid.nx - 1 || gy < 0 || gy > grid.ny - 1) return null;
  const i0 = Math.min(grid.nx - 2, Math.floor(gx));
  const j0 = Math.min(grid.ny - 2, Math.floor(gy));
  const tx = gx - i0;
  const ty = gy - j0;
  const at = (i: number, j: number, k: 0 | 1) => interleaved[(j * grid.nx + i) * 2 + k]!;
  const mix = (k: 0 | 1) =>
    at(i0, j0, k) * (1 - tx) * (1 - ty) + at(i0 + 1, j0, k) * tx * (1 - ty) + at(i0, j0 + 1, k) * (1 - tx) * ty + at(i0 + 1, j0 + 1, k) * tx * ty;
  return [mix(0), mix(1)];
}

// --- Vocabulaire du vent ---

/** Vitesse (m/s) et direction d'où il vient (degrés, 0 = nord, 90 = est) d'après ses composantes. */
export function speedAndOrigin(u: number, v: number): { speed: number; from: number } {
  const speed = Math.hypot(u, v);
  const from = (Math.atan2(-u, -v) / DEG + 360) % 360;
  return { speed, from };
}

const POINTS = [
  'nord', 'nord-nord-est', 'nord-est', 'est-nord-est', 'est', 'est-sud-est', 'sud-est', 'sud-sud-est',
  'sud', 'sud-sud-ouest', 'sud-ouest', 'ouest-sud-ouest', 'ouest', 'ouest-nord-ouest', 'nord-ouest', 'nord-nord-ouest',
];

/** « du nord-ouest », « de l'est » : d'où vient le vent, en toutes lettres. */
export function originName(fromDegrees: number): string {
  const name = POINTS[Math.round(fromDegrees / 22.5) % 16]!;
  return /^(est|ouest)/.test(name) ? `de l'${name}` : `du ${name}`;
}

/** Échelle de Beaufort : limites hautes en m/s de chaque degré (de 0 à 11), puis ouragan. */
const BEAUFORT_LIMITS = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
const BEAUFORT_NAMES = [
  'calme', 'très légère brise', 'légère brise', 'petite brise', 'jolie brise', 'bonne brise', 'vent frais',
  'grand frais', 'coup de vent', 'fort coup de vent', 'tempête', 'violente tempête', 'ouragan',
];

export function beaufort(speed: number): { degree: number; name: string } {
  const index = BEAUFORT_LIMITS.findIndex((limit) => speed < limit);
  const degree = index === -1 ? BEAUFORT_LIMITS.length : index;
  return { degree, name: BEAUFORT_NAMES[degree]! };
}

/**
 * Opacité d'une particule selon la vitesse du vent (m/s) : discrète dans le calme, pleine à partir de
 * 17 m/s (60 km/h). Reprend exactement la formule du shader (`windLayer.ts`).
 */
export function opacityForSpeed(speed: number): number {
  const t = Math.min(1, Math.max(0, (speed - 1) / 16));
  return 0.55 + 0.45 * t * t * (3 - 2 * t);
}
