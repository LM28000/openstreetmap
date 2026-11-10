/**
 * Module « Trains » : les TGV, Intercités et TER de France à leur position à
 * l'instant t, sur les vraies voies, avec leurs retards en temps réel.
 *
 * Le serveur (dossier `server/`) envoie, pour une période de quelques heures, les
 * trains avec leurs arrêts et leurs horaires prévus et réels. Les gares et le tracé
 * des voies entre elles (calculé sur les voies OpenStreetMap) arrivent à part, une
 * fois par version du réseau : ils ne changent pas d'un rafraîchissement à l'autre.
 * Le navigateur calcule lui-même la position de chaque train à chaque image : aucun
 * échange réseau pendant l'animation, et le replay fonctionne comme le direct.
 *
 * Entre deux gares, on suppose une vitesse constante le long du tracé. Si le
 * serveur n'a pas (encore) de tracé pour un tronçon, le train y va en ligne droite.
 */
import type { Color } from '@deck.gl/core';
import { TripsLayer } from '@deck.gl/geo-layers';
import { IconLayer, PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer } from '@deck.gl/layers';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { defineModule, type InfoContent, type InfoTable, type TerrainSampler } from '../core/module';
import { formatTime } from '../ui/format';
import {
  type ApiStation,
  DEG,
  fetchJson,
  latitudeFromMercatorY,
  loadNetwork,
  mercatorY,
  type RailNetwork,
  ServerError,
  type Track,
  trackOf,
} from './railNetwork';
import { buildTrainAtlas, type Nose, type TrainAtlas, type TrainIconSpec } from './trainIcons';
import { HALO, KEY, selectionRing, zoomRamp } from './symbols';
import { OVER_MAP } from '../map/parameters';

// --- Réponse de l'API (voir server/src/api.rs) ---

interface ApiTrain {
  number: string;
  /** Distingue deux circulations de même numéro et de même premier départ (rare). */
  variant?: number;
  /** Indices dans `ApiResponse.categories` et `ApiResponse.lines`. */
  category: number;
  line: number;
  /** Indices des gares du réseau. */
  stations: number[];
  /** Tracé entre chaque gare et la suivante : k > 0 = tracé k-1 du réseau, k < 0 = tracé -k-1 à l'envers, 0 = aucun. */
  tracks: number[];
  /** Horaires prévus, arrivée et départ de chaque arrêt en alternance : le premier en secondes UTC, les suivants en écart. */
  times: number[];
  /** Retards (secondes), dans le même ordre, si le temps réel parle de ce train. */
  delays?: number[];
  skipped?: number[];
  canceled?: boolean;
}

interface ApiResponse {
  from: number;
  to: number;
  realtime: { feedTimestamp: number; fetchedAt: number } | null;
  /** Version du réseau auquel renvoient les indices (`/api/reseau/{version}`). */
  network: string;
  categories: string[];
  lines: string[];
  trains: ApiTrain[];
}

// --- Modèle côté navigateur ---

type Family = 'ter' | 'grande-vitesse' | 'intercites';
type DelayClass = 'inconnu' | 'heure' | 'retard' | 'gros-retard';

/** Une gare : sa position, et tous les passages de trains (pour son tableau d'affichage). */
interface Station {
  /** Identifiant stable d'un chargement à l'autre (nom + position). */
  key: string;
  name: string;
  lon: number;
  lat: number;
  visits: Visit[];
  /** Passages de trains par jour, estimés d'après la période chargée (voir `rankStations`). */
  perDay: number;
  /** Taille du symbole : 0 petite, 1 gare, 2 grande gare. */
  size: StationSize;
}

type StationSize = 0 | 1 | 2;

/** Le passage d'une circulation à une gare. */
interface Visit {
  run: Run;
  /** Indice de l'arrêt dans `run.stations`. */
  stop: number;
}

/** Une circulation : ce qu'il faut pour les fiches et les tableaux, qu'elle roule ou soit supprimée. */
interface Run {
  id: string;
  number: string;
  category: string;
  family: Family;
  line: string;
  /** Arrêts, dans l'ordre (seulement ceux desservis aux extrémités pour un train qui roule). */
  stations: Station[];
  /** Horaires retenus : réels si connus, sinon prévus (secondes UTC). */
  arr: number[];
  dep: number[];
  plannedArr: number[];
  plannedDep: number[];
  realtime: boolean;
  canceled: boolean;
  /** Indices (dans `stations`) des arrêts intermédiaires non desservis. */
  skipped: Set<number>;
}

/** Un train qui roule : une circulation avec son chemin sur les voies. */
interface Train extends Run {
  /** Proportion du trajet faite sur un tracé réel (1 = tout sur les voies). */
  onTracks: number;
  // Chemin complet, un sommet par point de voie, avec l'heure de passage.
  lon: Float64Array;
  my: Float64Array;
  /** Altitude du rail en mètres, NaN si inconnue (tronçon en ligne droite). */
  zRail: Float32Array;
  /** Heure de passage à chaque sommet (secondes UTC). */
  times: Float64Array;
  /** Vitesse estimée en chaque sommet (km/h). */
  speeds: Float32Array;
  /** Vitesse maximale de la ligne sur la portion qui part de chaque sommet (km/h, 0 : inconnue). */
  limits: Float32Array;
  /** Cap (degrés deck.gl) du premier tronçon non nul partant de chaque sommet. */
  angles: Float32Array;
  /** Sommet du chemin où se trouve chaque arrêt. */
  stopVertex: number[];
  /** Pour la traînée : sommets [lon, lat, z] à plat, et horodatages relatifs à `TrainsData.base`. */
  flatPath: Float64Array;
  timestamps: Float32Array;
  head: Head;
}

interface Head {
  train: Train;
  position: [number, number, number];
  /** Le train est entre les sommets `vertex` et `vertex + 1` de son chemin, à la fraction `fraction`. */
  vertex: number;
  fraction: number;
  /** Cap, en degrés dans le sens inverse des aiguilles d'une montre depuis l'est (convention deck.gl). */
  angle: number;
  /** Retard en secondes à cet instant, `null` sans temps réel. */
  delay: number | null;
  delayClass: DelayClass;
  /** Indice de l'arrêt où le train est à quai, sinon `null`. */
  atStop: number | null;
  nextStop: number | null;
  /** Vitesse estimée en km/h (0 à quai). */
  speed: number;
  /** Vitesse maximale de la ligne à cet endroit (km/h, 0 : inconnue). */
  limit: number;
}

interface TrainsData {
  /** Période chargée (secondes UTC). */
  from: number;
  to: number;
  /** Origine des horodatages de la traînée : la précision des flottants GPU l'exige. */
  base: number;
  realtimeAt: number | null;
  stations: Station[];
  /** Les gares moyennes et grandes, qui ont un point central. */
  centred: Station[];
  stationByKey: Map<string, Station>;
  trains: Train[];
  trainById: Map<string, Train>;
  canceled: number;
  /** Chemins calculés de ces trains (partagés avec les chargements précédents, voir `geometryCache`). */
  geometries: TrainGeometry[];
  /** Exagération du relief pour laquelle tous les chemins sont à jour (−1 : à vérifier). */
  exaggeration: number;
  /** Change à chaque recalcul de `flatPath`, pour prévenir deck.gl. */
  pathVersion: number;
}

/** Ce que l'on retient d'un clic : un train ou une gare, retrouvés par identifiant après chaque rechargement. */
type TrainsSelection = { type: 'train'; id: string } | { type: 'gare'; key: string };

// --- Apparence (couleurs vérifiées pour le daltonisme, voir README) ---

const FAMILY_OF: Record<string, Family> = {
  'TGV INOUI': 'grande-vitesse',
  OUIGO: 'grande-vitesse',
  ICE: 'grande-vitesse',
  Lyria: 'grande-vitesse',
  INTERCITES: 'intercites',
  'INTERCITES de nuit': 'intercites',
};

/** Couleur par famille ; les trains à grande vitesse ont aussi un nez profilé et sont plus longs. */
const FAMILY_STYLE: Record<Family, { color: [number, number, number]; css: string; nose: Nose; label: string }> = {
  ter: { color: [42, 120, 214], css: '#2a78d6', nose: 'standard', label: 'TER et trains régionaux' },
  'grande-vitesse': { color: [235, 104, 52], css: '#eb6834', nose: 'profile', label: 'Grande vitesse : TGV INOUI, OUIGO, ICE, Lyria' },
  intercites: { color: [27, 175, 122], css: '#1baf7a', nose: 'standard', label: 'Intercités, de jour et de nuit' },
};
const FAMILY_ORDER: Family[] = ['ter', 'grande-vitesse', 'intercites'];

/** Le retard est une grandeur ordonnée : neutre à l'heure, puis un orange de plus en plus sombre. */
const DELAY_STYLE: Record<DelayClass, { css: string; rgb: [number, number, number]; label: string }> = {
  inconnu: { css: '#8a8f9c', rgb: [138, 143, 156], label: 'Sans information temps réel' },
  heure: { css: '#ffffff', rgb: [255, 255, 255], label: 'À l’heure (moins de 5 min)' },
  retard: { css: '#f0913a', rgb: [240, 145, 58], label: '5 à 14 min de retard' },
  'gros-retard': { css: '#a83a16', rgb: [168, 58, 22], label: '15 min de retard ou plus' },
};
const DELAY_ORDER: DelayClass[] = ['heure', 'retard', 'gros-retard', 'inconnu'];

const familyIcon = (family: Family) => `famille:${family}`;
const delayIcon = (nose: Nose, delay: DelayClass) => `retard:${nose}:${delay}`;

/** L'atlas est dessiné au premier usage (il faut un document pour créer un canvas). */
let atlas: TrainAtlas | undefined;
function trainAtlas(): TrainAtlas {
  if (!atlas) {
    const specs: TrainIconSpec[] = FAMILY_ORDER.map((family) => ({
      key: familyIcon(family),
      color: FAMILY_STYLE[family].css,
      nose: FAMILY_STYLE[family].nose,
    }));
    for (const nose of ['standard', 'profile'] as const) {
      for (const delay of DELAY_ORDER) specs.push({ key: delayIcon(nose, delay), color: DELAY_STYLE[delay].css, nose });
    }
    atlas = buildTrainAtlas(specs);
  }
  return atlas;
}

/**
 * Taille des têtes de train : hauteur de l'icône (halo compris) en mètres, bornée en
 * pixels. Le plancher monte avec le zoom : de loin les têtes restent petites pour ne pas
 * se recouvrir, à partir du zoom 8,5 elles ont la taille de la planche des symboles.
 */
const TRAIN_SIZE_M = 900;
const TRAIN_MAX_PX = 16;
const headMinPixels = (zoom: number) => zoomRamp(zoom, 5, 8.5, 9, TRAIN_MAX_PX);
const TRAIL_GREY: Color = [230, 233, 240, 150];
const TRAIL_WIDTH_PX = 4;
/** Longueur de la traînée, en secondes de trajet. */
const TRAIL_SECONDS = 15 * 60;
/** Période chargée autour de l'instant affiché. */
const LOAD_BEFORE_S = 30 * 60;
const LOAD_AFTER_S = 3 * 3600;

const CATEGORY_NAMES: Record<string, string> = {
  'Train TER': 'TER',
  INTERCITES: 'Intercités',
  'INTERCITES de nuit': 'Intercités de nuit',
  TramTrain: 'Tram-train',
};

// --- Géométrie ---

/** Cap d'un tronçon tel qu'il apparaît sur la carte (Web Mercator), en degrés deck.gl. */
function heading(lon1: number, my1: number, lon2: number, my2: number): number {
  return Math.atan2(my2 - my1, (lon2 - lon1) * DEG) / DEG;
}

// --- Chargement ---

async function loadTrains(signal: AbortSignal, time: number): Promise<TrainsData> {
  const t = Math.floor(time / 1000);
  // Deux essais : le réseau peut changer de version entre les deux requêtes (nouveaux horaires, tracés prêts).
  for (let attempt = 0; ; attempt++) {
    const json = await fetchJson<ApiResponse>(`/api/trains?from=${t - LOAD_BEFORE_S}&to=${t + LOAD_AFTER_S}`, signal);
    try {
      return parse(json, await loadNetwork(json.network, signal));
    } catch (error) {
      if (attempt === 0 && error instanceof ServerError && error.status === 404) continue;
      throw error;
    }
  }
}

/** Sommets d'un tronçon entre deux gares : le tracé réel s'il existe, sinon la ligne droite. */
function intervalVertices(
  ref: number,
  track: Track | undefined,
  from: ApiStation,
  to: ApiStation,
): IntervalVertices {
  if (!track || track.lon.length < 2) {
    const dx = (to.lon - from.lon) * Math.cos(from.lat * DEG) * 111_320;
    const dy = (to.lat - from.lat) * 110_540;
    return {
      lon: [from.lon, to.lon],
      lat: [from.lat, to.lat],
      z: [NaN, NaN],
      along: [0, Math.hypot(dx, dy)],
      limits: [0],
      real: false,
    };
  }
  const n = track.lon.length;
  const total = track.along[n - 1]!;
  const order = ref > 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
  return {
    lon: order.map((i) => track.lon[i]!),
    lat: order.map((i) => track.lat[i]!),
    z: order.map((i) => track.z[i]!),
    along: order.map((i) => (ref > 0 ? track.along[i]! : total - track.along[i]!)),
    // Portion k : à l'endroit, celle qui part du point k ; à l'envers, celle qui arrive au point n-1-k.
    limits: Array.from({ length: n - 1 }, (_, k) => (ref > 0 ? track.limit[k]! : track.limit[n - 2 - k]!)),
    real: true,
  };
}

/** Sommets d'un tronçon entre deux gares, avec la vitesse maximale de chaque portion. */
interface IntervalVertices {
  lon: number[];
  lat: number[];
  z: number[];
  /** Distance depuis la première gare, en mètres. */
  along: number[];
  /** Vitesse maximale (km/h, 0 : inconnue) de chaque portion entre deux sommets. */
  limits: number[];
  real: boolean;
}

/** Marche des trains : vitesse maximale du matériel (km/h), accélération et freinage (m/s²). */
const RUNNING: Record<Family, { vmax: number; accel: number; brake: number }> = {
  'grande-vitesse': { vmax: 320, accel: 0.4, brake: 0.5 },
  intercites: { vmax: 200, accel: 0.5, brake: 0.6 },
  ter: { vmax: 160, accel: 0.7, brake: 0.7 },
};
/** Matériels plus lents que leur famille. */
const VMAX_BY_CATEGORY: Record<string, number> = { TramTrain: 100, 'INTERCITES de nuit': 160 };
/** Vitesse supposée là où OSM ne la donne pas. */
const DEFAULT_LIMIT_KMH = 100;
/** Pas de calcul du profil de vitesse. */
const PROFILE_STEP_M = 400;

interface Profiled {
  lon: number[];
  my: number[];
  z: number[];
  times: number[];
  /** Vitesse estimée en chaque sommet (km/h). */
  speeds: number[];
  /** Vitesse maximale de la portion qui part de chaque sommet (km/h, 0 : inconnue). */
  limits: number[];
}

/**
 * Heure de passage en chaque point d'un tronçon entre deux gares, avec un profil de
 * vitesse réaliste : le train accélère au départ, roule à la vitesse permise (celle de
 * la voie, sans dépasser celle du matériel), et freine pour s'arrêter à la gare
 * suivante. Ce profil « au plus vite » est ensuite étiré pour tomber pile sur
 * l'horaire (les horaires comportent toujours une marge).
 *
 * Le calcul se fait tous les 400 m ; on garde les sommets du tracé, plus les points
 * des phases d'accélération et de freinage (là où la vitesse change, l'interpolation
 * linéaire entre sommets ne suffirait pas).
 */
function profileInterval(
  v: IntervalVertices,
  leave: number,
  reach: number,
  running: { vmax: number; accel: number; brake: number },
): Profiled {
  // 1. Points fins : sommets du tracé, plus des points intermédiaires tous les 400 m.
  const lon: number[] = [];
  const my: number[] = [];
  const z: number[] = [];
  const d: number[] = [];
  const cap: number[] = []; // vitesse maximale au point, en m/s
  const limitOut: number[] = []; // vitesse maximale (km/h OSM) de la portion qui part du point
  const original: boolean[] = [];
  const allowed = (limitKmh: number) => Math.min(limitKmh > 0 ? limitKmh : DEFAULT_LIMIT_KMH, running.vmax) / 3.6;
  const n = v.lon.length;
  for (let e = 0; e + 1 < n; e++) {
    const length = v.along[e + 1]! - v.along[e]!;
    const steps = Math.max(1, Math.ceil(length / PROFILE_STEP_M));
    const speed = allowed(v.limits[e] ?? 0);
    const previous = e > 0 ? allowed(v.limits[e - 1] ?? 0) : speed;
    const my0 = mercatorY(v.lat[e]!);
    const my1 = mercatorY(v.lat[e + 1]!);
    for (let q = 0; q < steps; q++) {
      const f = q / steps;
      lon.push(v.lon[e]! + (v.lon[e + 1]! - v.lon[e]!) * f);
      my.push(my0 + (my1 - my0) * f);
      z.push(v.z[e]! + (v.z[e + 1]! - v.z[e]!) * f);
      d.push(v.along[e]! + length * f);
      cap.push(q === 0 ? Math.min(speed, previous) : speed);
      limitOut.push(v.limits[e] ?? 0);
      original.push(q === 0);
    }
  }
  lon.push(v.lon[n - 1]!);
  my.push(mercatorY(v.lat[n - 1]!));
  z.push(v.z[n - 1]!);
  d.push(v.along[n - 1]!);
  cap.push(0);
  limitOut.push(v.limits[n - 2] ?? 0);
  original.push(true);

  // 2. Vitesses : on accélère depuis l'arrêt (passe avant), on freine jusqu'à l'arrêt (passe arrière).
  const m = d.length;
  const speed = new Array<number>(m).fill(0);
  for (let j = 1; j < m - 1; j++) {
    speed[j] = Math.min(cap[j]!, Math.sqrt(speed[j - 1]! ** 2 + 2 * running.accel * (d[j]! - d[j - 1]!)));
  }
  for (let j = m - 2; j >= 0; j--) {
    speed[j] = Math.min(speed[j]!, Math.sqrt(speed[j + 1]! ** 2 + 2 * running.brake * (d[j + 1]! - d[j]!)));
  }

  // 3. Temps « au plus vite », puis étirement pour respecter l'horaire.
  const cumulative = [0];
  for (let j = 1; j < m; j++) {
    const mean = (speed[j - 1]! + speed[j]!) / 2;
    cumulative.push(cumulative[j - 1]! + (mean > 0.01 ? (d[j]! - d[j - 1]!) / mean : 0));
  }
  const fastest = cumulative[m - 1]!;
  const scale = fastest > 0 ? (reach - leave) / fastest : 1;

  // 4. On garde les sommets du tracé et les points où le train accélère ou freine.
  const out: Profiled = { lon: [], my: [], z: [], times: [], speeds: [], limits: [] };
  for (let j = 0; j < m; j++) {
    const cruising = speed[j]! >= cap[j]! - 0.5;
    if (!original[j] && cruising) continue;
    out.lon.push(lon[j]!);
    out.my.push(my[j]!);
    out.z.push(z[j]!);
    out.times.push(fastest > 0 ? leave + cumulative[j]! * scale : j === m - 1 ? reach : leave);
    out.speeds.push(scale > 0 && fastest > 0 ? (speed[j]! / scale) * 3.6 : 0);
    out.limits.push(limitOut[j]!);
  }
  return out;
}

/** Ce qui coûte cher à calculer pour un train : son chemin et son profil de vitesse. */
type TrainGeometry = Pick<
  Train,
  'onTracks' | 'lon' | 'my' | 'zRail' | 'times' | 'speeds' | 'limits' | 'angles' | 'stopVertex' | 'flatPath' | 'timestamps'
> & {
  /** Exagération du relief appliquée à `flatPath` (−1 : jamais calculé). */
  pathExaggeration: number;
};

/**
 * Le temps réel est rechargé chaque minute, mais les tracés ne changent pas et la
 * plupart des trains gardent leurs horaires : on réutilise ce qui a déjà été calculé.
 */
let geometryCache = new Map<string, TrainGeometry>();
/** Origine fixe des horodatages de traînée, pour que les chemins mis en cache restent valables. */
let timeBase: number | undefined;

function stationKey(s: ApiStation): string {
  return `${s.name}|${s.lon.toFixed(4)}|${s.lat.toFixed(4)}`;
}

/** Horaires d'un train : arrivées et départs prévus, et réels si le temps réel en parle. */
function decodeTimes(api: ApiTrain) {
  const count = api.stations.length;
  const plannedArr = new Array<number>(count);
  const plannedDep = new Array<number>(count);
  let t = 0;
  for (let i = 0; i < count; i++) {
    plannedArr[i] = t += api.times[2 * i] ?? 0;
    plannedDep[i] = t += api.times[2 * i + 1] ?? 0;
  }
  const delays = api.delays;
  if (!delays) return { plannedArr, plannedDep, arr: plannedArr, dep: plannedDep };
  return {
    plannedArr,
    plannedDep,
    arr: plannedArr.map((v, i) => v + (delays[2 * i] ?? 0)),
    dep: plannedDep.map((v, i) => v + (delays[2 * i + 1] ?? 0)),
  };
}

function parse(json: ApiResponse, net: RailNetwork): TrainsData {
  const started = performance.now();
  const base = (timeBase ??= json.from);
  const nextGeometryCache = new Map<string, TrainGeometry>();
  const geometries: TrainGeometry[] = [];
  let reused = 0;
  const stations: Station[] = net.stations.map((s) => ({ key: stationKey(s), name: s.name, lon: s.lon, lat: s.lat, visits: [], perDay: 0, size: 0 }));
  const trains: Train[] = [];
  let canceled = 0;

  for (const api of json.trains) {
    const category = json.categories[api.category] ?? '';
    const family = FAMILY_OF[category] ?? 'ter';
    const times = decodeTimes(api);
    // Le numéro et l'heure prévue du premier départ identifient la circulation d'un chargement à l'autre.
    const id = `${api.number}@${times.plannedDep[0] ?? 0}${api.variant ? `#${api.variant}` : ''}`;
    const common = { id, number: api.number, category, family, line: json.lines[api.line] ?? '' };

    if (api.canceled) {
      // Un train supprimé ne roule pas, mais figure (supprimé) dans les tableaux des gares.
      const runStations = api.stations.map((i) => stations[i]).filter((s): s is Station => s !== undefined);
      if (runStations.length !== api.stations.length) continue;
      const run: Run = {
        ...common,
        stations: runStations,
        arr: times.plannedArr,
        dep: times.plannedDep,
        plannedArr: times.plannedArr,
        plannedDep: times.plannedDep,
        realtime: true,
        canceled: true,
        skipped: new Set(),
      };
      runStations.forEach((station, stop) => station.visits.push({ run, stop }));
      canceled++;
      continue;
    }

    const skippedAll = new Set(api.skipped ?? []);
    // Un train peut partir plus loin ou terminer plus tôt que prévu : on garde les arrêts desservis aux extrémités.
    let first = 0;
    while (first < api.stations.length && skippedAll.has(first)) first++;
    let last = api.stations.length - 1;
    while (last > first && skippedAll.has(last)) last--;
    if (last <= first) continue;

    const runStations = api.stations.slice(first, last + 1).map((i) => stations[i]);
    if (runStations.some((s) => s === undefined)) continue;
    const stops = runStations as Station[];
    const slice = (values: number[]) => values.slice(first, last + 1);
    const arr = slice(times.arr);
    const dep = slice(times.dep);

    // Même réseau, même train, mêmes arrêts, mêmes horaires : même chemin qu'au chargement précédent.
    const refs = api.tracks.slice(first, last);
    const key = [net.version, id, first, last, dep.join(','), arr.join(','), refs.join(',')].join('|');
    let geometry = geometryCache.get(key);
    if (geometry) reused++;
    else geometry = computeGeometry(refs, net, stops, dep, arr, family, category, base);
    nextGeometryCache.set(key, geometry);
    geometries.push(geometry);

    const train = {
      ...common,
      stations: stops,
      arr,
      dep,
      plannedArr: slice(times.plannedArr),
      plannedDep: slice(times.plannedDep),
      realtime: api.delays !== undefined,
      canceled: false,
      skipped: new Set([...skippedAll].filter((i) => i > first && i < last).map((i) => i - first)),
      onTracks: geometry.onTracks,
      lon: geometry.lon,
      my: geometry.my,
      zRail: geometry.zRail,
      times: geometry.times,
      speeds: geometry.speeds,
      limits: geometry.limits,
      angles: geometry.angles,
      stopVertex: geometry.stopVertex,
      flatPath: geometry.flatPath,
      timestamps: geometry.timestamps,
    } as Omit<Train, 'head'> as Train;
    train.head = {
      train,
      position: [0, 0, 0],
      vertex: 0,
      fraction: 0,
      angle: 0,
      delay: null,
      delayClass: 'inconnu',
      atStop: null,
      nextStop: null,
      speed: 0,
      limit: 0,
    };
    stops.forEach((station, stop) => station.visits.push({ run: train, stop }));
    trains.push(train);
  }

  geometryCache = nextGeometryCache;
  rankStations(stations, json.from, json.to);
  if (import.meta.env.DEV) {
    const ms = Math.round(performance.now() - started);
    console.info(`[trains] ${trains.length} trains analysés en ${ms} ms (${reused} chemins réutilisés)`);
  }

  return {
    from: json.from,
    to: json.to,
    base,
    realtimeAt: json.realtime?.feedTimestamp ?? null,
    stations,
    centred: stations.filter((s) => s.size > 0),
    stationByKey: new Map(stations.map((s) => [s.key, s])),
    trains,
    trainById: new Map(trains.map((t) => [t.id, t])),
    canceled,
    geometries,
    exaggeration: -1,
    pathVersion: 0,
  };
}

/** Chemin d'un train sur les voies et heure de passage en chaque point (profil de vitesse). */
function computeGeometry(
  refs: number[],
  net: RailNetwork,
  stops: Station[],
  dep: number[],
  arr: number[],
  family: Family,
  category: string,
  base: number,
): TrainGeometry {
  // Chemin complet : pour chaque tronçon, les points de voie avec leur heure de passage,
  // selon un profil de vitesse réaliste (accélération, vitesse de la ligne, freinage).
  const running = { ...RUNNING[family], vmax: VMAX_BY_CATEGORY[category] ?? RUNNING[family].vmax };
  const lon: number[] = [];
  const myList: number[] = [];
  const z: number[] = [];
  const times: number[] = [];
  const speeds: number[] = [];
  const limits: number[] = [];
  const stopVertex = [0];
  let realLength = 0;
  let totalLength = 0;
  for (let i = 0; i + 1 < stops.length; i++) {
    const ref = refs[i] ?? 0;
    const vertices = intervalVertices(ref, trackOf(net, ref), stops[i]!, stops[i + 1]!);
    const leave = dep[i] ?? 0;
    const reach = arr[i + 1] ?? leave;
    const length = vertices.along[vertices.along.length - 1] ?? 0;
    totalLength += length;
    if (vertices.real) realLength += length;
    const profiled = profileInterval(vertices, leave, reach, running);
    for (let k = 0; k < profiled.lon.length; k++) {
      lon.push(profiled.lon[k]!);
      myList.push(profiled.my[k]!);
      z.push(profiled.z[k]!);
      times.push(profiled.times[k]!);
      speeds.push(profiled.speeds[k]!);
      limits.push(profiled.limits[k]!);
    }
    stopVertex.push(lon.length - 1);
  }

  const count = lon.length;
  const my = Float64Array.from(myList);
  const lonArray = Float64Array.from(lon);
  // Cap de chaque sommet : celui du premier tronçon de longueur non nulle qui en part.
  const angles = new Float32Array(count);
  let nextAngle = 0;
  for (let k = count - 1; k >= 0; k--) {
    if (k + 1 < count && (lonArray[k + 1] !== lonArray[k] || my[k + 1] !== my[k])) {
      nextAngle = heading(lonArray[k]!, my[k]!, lonArray[k + 1]!, my[k + 1]!);
    }
    angles[k] = nextAngle;
  }

  return {
    onTracks: totalLength > 0 ? realLength / totalLength : 0,
    lon: lonArray,
    my,
    zRail: Float32Array.from(z),
    times: Float64Array.from(times),
    speeds: Float32Array.from(speeds),
    limits: Float32Array.from(limits),
    angles,
    stopVertex,
    flatPath: new Float64Array(count * 3),
    timestamps: Float32Array.from(times, (t) => t - base),
    pathExaggeration: -1,
  };
}

// --- Calculs à l'instant t ---

/** Altitude affichée d'un sommet : celle du rail × exagération du relief, sinon celle du relief affiché. */
function displayedZ(geometry: TrainGeometry, k: number, terrain: TerrainSampler): number {
  const rail = geometry.zRail[k]!;
  if (terrain.exaggeration === 0) return 0;
  if (!Number.isNaN(rail)) return rail * terrain.exaggeration;
  return terrain.elevation(geometry.lon[k]!, latitudeFromMercatorY(geometry.my[k]!));
}

/** Calcule les sommets de la traînée des nouveaux chemins, ou de tous si l'exagération du relief a changé. */
function refreshPaths(data: TrainsData, terrain: TerrainSampler): void {
  if (data.exaggeration === terrain.exaggeration) return;
  for (const geometry of data.geometries) {
    if (geometry.pathExaggeration === terrain.exaggeration) continue;
    for (let k = 0; k < geometry.lon.length; k++) {
      geometry.flatPath[k * 3] = geometry.lon[k]!;
      geometry.flatPath[k * 3 + 1] = latitudeFromMercatorY(geometry.my[k]!);
      geometry.flatPath[k * 3 + 2] = displayedZ(geometry, k, terrain);
    }
    geometry.pathExaggeration = terrain.exaggeration;
  }
  data.exaggeration = terrain.exaggeration;
  data.pathVersion++;
}

function isRunning(train: Train, t: number): boolean {
  return t >= (train.dep[0] ?? Infinity) && t <= (train.arr[train.arr.length - 1] ?? -Infinity);
}

/** Dernier sommet dont l'heure de passage est ≤ t (recherche dichotomique). */
function vertexBefore(times: Float64Array, t: number): number {
  let low = 0;
  let high = times.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (times[middle]! <= t) low = middle;
    else high = middle - 1;
  }
  return low;
}

/**
 * Met à jour la position du train à l'instant t (secondes). Renvoie faux s'il ne roule pas.
 *
 * L'interpolation entre deux sommets se fait en Web Mercator, comme le tracé de la
 * traînée par deck.gl : le train reste exactement au bout de sa traînée.
 */
function updateHead(train: Train, t: number): boolean {
  if (!isRunning(train, t)) return false;
  const { times, head } = train;
  const k = Math.min(vertexBefore(times, t), times.length - 2);
  const t0 = times[k]!;
  const t1 = times[k + 1]!;
  const f = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  const flat = train.flatPath;
  head.position[0] = train.lon[k]! + (train.lon[k + 1]! - train.lon[k]!) * f;
  head.position[1] = latitudeFromMercatorY(train.my[k]! + (train.my[k + 1]! - train.my[k]!) * f);
  head.position[2] = flat[k * 3 + 2]! + (flat[(k + 1) * 3 + 2]! - flat[k * 3 + 2]!) * f;
  head.vertex = k;
  head.fraction = f;
  head.angle = train.angles[k]!;
  // Vitesse estimée (profil de marche) et vitesse maximale de la ligne à cet endroit.
  head.speed = train.speeds[k]! + (train.speeds[k + 1]! - train.speeds[k]!) * f;
  head.limit = train.limits[k]!;

  // Arrêt en cours ou prochain, et retard à cet instant (pour la fiche et la couleur).
  const { arr, dep } = train;
  for (let i = 0; i < arr.length; i++) {
    const departure = dep[i] ?? 0;
    if (t > departure) continue;
    const arrival = arr[i] ?? departure;
    const atStation = t >= arrival || i === 0;
    const isLast = i === arr.length - 1;
    head.atStop = atStation ? i : null;
    head.nextStop = atStation ? (isLast ? null : i + 1) : i;
    head.delay = !train.realtime
      ? null
      : atStation && !isLast
        ? departure - (train.plannedDep[i] ?? departure)
        : arrival - (train.plannedArr[i] ?? arrival);
    break;
  }
  head.delayClass = classify(head.delay);
  return true;
}

function classify(delay: number | null): DelayClass {
  if (delay === null) return 'inconnu';
  if (delay < 5 * 60) return 'heure';
  if (delay < 15 * 60) return 'retard';
  return 'gros-retard';
}

function delayText(delay: number | null): string {
  if (delay === null) return 'pas d’information temps réel';
  const minutes = Math.round(delay / 60);
  if (minutes === 0) return 'à l’heure';
  return minutes > 0 ? `+${minutes} min` : `${-minutes} min d’avance`;
}

const hhmm = (seconds: number | undefined) => (seconds === undefined ? '?' : formatTime(seconds * 1000));
const displayCategory = (category: string) => CATEGORY_NAMES[category] ?? category;

// --- Taille des gares selon le trafic ---

/** Trains par jour à partir desquels une gare passe de petite à moyenne, puis à grande. */
const STATION_MEDIUM_PER_DAY = 20;
const STATION_BIG_PER_DAY = 200;

/**
 * Part du trafic d'une journée type à chaque heure locale (en %), pour passer de
 * quelques heures de circulation chargées à un nombre de trains par jour : à 8 h on voit
 * beaucoup plus de passages qu'à 3 h, et la taille d'une gare ne doit pas dépendre de
 * l'heure du chargement.
 */
const HOURLY_SHARE = [0.4, 0.2, 0.2, 0.3, 1.5, 4, 7, 8, 7, 5.5, 4.5, 4.5, 5, 5, 4.5, 5, 6, 7.5, 8, 6.5, 4.5, 3, 2, 1.2];
const HOURLY_TOTAL = HOURLY_SHARE.reduce((total, v) => total + v, 0);
const parisHour = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', hourCycle: 'h23' });

/** Fraction d'une journée de trafic couverte par la période [from, to] (secondes UTC). */
function shareOfDay(from: number, to: number): number {
  const step = 300;
  let share = 0;
  for (let s = from; s < to; s += step) {
    share += (HOURLY_SHARE[Number.parseInt(parisHour.format(s * 1000), 10) % 24] ?? 0) * (step / 3600);
  }
  return share / HOURLY_TOTAL;
}

/** Estime les passages par jour de chaque gare, et en déduit la taille de son symbole. */
function rankStations(stations: Station[], from: number, to: number): void {
  // Plancher : une période de nuit ne compte que quelques trains, l'estimation serait du bruit.
  const share = Math.max(0.06, shareOfDay(from, to));
  for (const station of stations) {
    let count = 0;
    for (const { run, stop } of station.visits) {
      if (run.canceled) continue;
      const at = run.arr[stop] ?? run.dep[stop] ?? 0;
      if (at >= from && at <= to) count++;
    }
    station.perDay = Math.round(count / share);
    station.size = station.perDay >= STATION_BIG_PER_DAY ? 2 : station.perDay >= STATION_MEDIUM_PER_DAY ? 1 : 0;
  }
}

/** Rayon (pixels) des trois tailles de gares, leur contour, et le rapport du point central. */
const STATION_RADIUS_PX = [3.6, 5.8, 8.2] as const;
const STATION_LINE_PX = [1.3, 1.6, 2] as const;
const STATION_DOT_RATIO = 0.45;
/** Épaisseur du halo clair autour du contour d'une gare. */
const STATION_HALO_PX = 1.8;

// --- Rames de près ---

/**
 * À partir de ce zoom, chaque train visible est dessiné voiture par voiture sur sa
 * vraie longueur, le long de ses voies, à la place de sa tête. En dessous, un train de
 * 200 m ne ferait que quelques pixels.
 */
const CARS_ZOOM = 13;
/** Largeur d'une rame : exagérée à 11 pixels d'écran (un vrai train fait 3 m), sans descendre sous sa largeur réelle. */
const CAR_WIDTH_PX = 11;
const CAR_WIDTH_MIN_M = 3;
/** Jour entre deux voitures, et entre deux rames accouplées (mètres). */
const CAR_GAP_M = 1.1;
const COUPLING_GAP_M = 1.5;
/** Deux trains de même famille et de même terminus à moins de cette distance sont accouplés (mètres). */
const COUPLING_DISTANCE_M = 30;
const EARTH_RADIUS_M = 6_378_137;
/** Taille d'un pixel d'écran au zoom 0, en mètres à l'équateur (tuiles de 512 pixels). */
const METERS_PER_PIXEL_Z0 = (2 * Math.PI * EARTH_RADIUS_M) / 512;

/** Contour d'un polygone : sommets [lon, lat, z]. */
type Polygon = Array<[number, number, number]>;

type CapKind = 'pointu' | 'rond' | 'carre';

/** Composition d'un train : longueur de chaque voiture (mètres), forme du nez et de la queue. */
interface Consist {
  cars: readonly number[];
  nose: CapKind;
  tail: CapKind;
}

const repeat = (n: number, length: number) => Array<number>(n).fill(length);
const CONSISTS = {
  /** Rame TGV : deux motrices et huit remorques, 200 m. */
  highSpeed: { cars: [22, ...repeat(8, 19), 22], nose: 'pointu', tail: 'pointu' },
  /** Automotrice TER : quatre caisses, 80 m. */
  regional: { cars: [21, 19, 19, 21], nose: 'rond', tail: 'rond' },
  /** Tram-train : trois caisses courtes, 42 m. */
  tramTrain: { cars: [14, 14, 14], nose: 'rond', tail: 'rond' },
  /** Intercités : une locomotive et six voitures, 173 m. */
  intercity: { cars: [17, ...repeat(6, 26)], nose: 'rond', tail: 'carre' },
  /** Intercités de nuit : plus de voitures (couchettes, wagons-lits), 225 m. */
  night: { cars: [17, ...repeat(8, 26)], nose: 'rond', tail: 'carre' },
} satisfies Record<string, Consist>;

function consistOf(train: Train): Consist {
  if (train.family === 'grande-vitesse') return CONSISTS.highSpeed;
  if (train.family === 'intercites') return train.category.includes('nuit') ? CONSISTS.night : CONSISTS.intercity;
  return train.category === 'TramTrain' ? CONSISTS.tramTrain : CONSISTS.regional;
}

const sum = (values: readonly number[]) => values.reduce((total, v) => total + v, 0);

/** Une rame dessinée : son chemin, ses voitures, ses extrémités. */
interface Rame {
  train: Train;
  /** Mètres par « pixel » de largeur : une rame de 11 pixels de large mesure `11 × pixelM` mètres. */
  pixelM: number;
  color: [number, number, number];
  /** Chemin de toute la rame (sommets lon, lat, z à plat). */
  path: Float64Array;
  /** Voitures : sommets à plat. */
  cars: Float64Array[];
  /** Polygones du nez et de la queue : contour clair, contour sombre, couleur. */
  caps: Array<{ halo: Polygon; key: Polygon; fill: Polygon }>;
}

/** Voiture d'une rame, pour la couche des voitures. */
interface CarPath {
  rame: Rame;
  path: Float64Array;
}

/** Polyligne du corps de la rame, de la tête vers l'arrière (tampon réutilisé d'une image à l'autre). */
const body = { x: [] as number[], y: [] as number[], lat: [] as number[], z: [] as number[], d: [] as number[], n: 0 };

function pushBody(x: number, y: number, lat: number, z: number, d: number): void {
  const i = body.n++;
  body.x[i] = x;
  body.y[i] = y;
  body.lat[i] = lat;
  body.z[i] = z;
  body.d[i] = d;
}

/**
 * Remplit `body` : le chemin du train depuis sa tête jusqu'à `needM` mètres derrière,
 * en suivant les sommets de la voie (donc les courbes et les aiguillages). Si le chemin
 * connu s'arrête avant (le train vient de quitter son terminus), il se prolonge en ligne
 * droite, dans l'axe du premier tronçon.
 *
 * Les distances se calculent dans le plan Web Mercator, comme l'affichage : un mètre
 * y vaut 1 / (rayon de la Terre × cos latitude).
 */
function collectBody(train: Train, head: Head, needM: number, metersPerUnit: number): void {
  body.n = 0;
  const k = head.vertex;
  const f = head.fraction;
  const flat = train.flatPath;
  let x = head.position[0] * DEG;
  let y = train.my[k]! + (train.my[k + 1]! - train.my[k]!) * f;
  let lat = head.position[1];
  let z = head.position[2];
  pushBody(x, y, lat, z, 0);
  let d = 0;
  // Le sommet k est derrière la tête, sauf si elle est exactement dessus.
  for (let i = f > 0 ? k : k - 1; i >= 0 && d < needM; i--) {
    const vx = train.lon[i]! * DEG;
    const vy = train.my[i]!;
    const length = Math.hypot(vx - x, vy - y) * metersPerUnit;
    if (length < 1e-3) continue;
    d += length;
    x = vx;
    y = vy;
    lat = flat[i * 3 + 1]!;
    z = flat[i * 3 + 2]!;
    pushBody(x, y, lat, z, d);
  }
  if (d < needM) {
    // Fin du chemin connu : prolongement droit, à l'opposé du sens de marche.
    const angle = train.angles[0]! * DEG;
    const units = (needM - d) / metersPerUnit;
    const ex = x - Math.cos(angle) * units;
    const ey = y - Math.sin(angle) * units;
    pushBody(ex, ey, lat + ((ey - y) * Math.cos(lat * DEG)) / DEG, z, needM);
  }
}

/** Point du corps à l'abscisse curviligne `s` (mètres) : écrit dans `out` [x, y, lat, z]. */
function bodyAt(s: number, out: number[]): void {
  let i = 0;
  while (i + 2 < body.n && body.d[i + 1]! < s) i++;
  const d0 = body.d[i]!;
  const d1 = body.d[i + 1]!;
  const t = d1 > d0 ? Math.min(1, Math.max(0, (s - d0) / (d1 - d0))) : 0;
  out[0] = body.x[i]! + (body.x[i + 1]! - body.x[i]!) * t;
  out[1] = body.y[i]! + (body.y[i + 1]! - body.y[i]!) * t;
  out[2] = body.lat[i]! + (body.lat[i + 1]! - body.lat[i]!) * t;
  out[3] = body.z[i]! + (body.z[i + 1]! - body.z[i]!) * t;
}

const scratchA = [0, 0, 0, 0];
const scratchB = [0, 0, 0, 0];

/** Ajoute à `out` les sommets (lon, lat, z) du corps entre les abscisses a et b. */
function pushSlice(out: number[], a: number, b: number): void {
  bodyAt(a, scratchA);
  out.push(scratchA[0]! / DEG, scratchA[2]!, scratchA[3]!);
  for (let i = 0; i < body.n; i++) {
    const d = body.d[i]!;
    if (d > a && d < b) out.push(body.x[i]! / DEG, body.lat[i]!, body.z[i]!);
  }
  bodyAt(b, scratchA);
  out.push(scratchA[0]! / DEG, scratchA[2]!, scratchA[3]!);
}

/**
 * Polygone d'une extrémité de rame : `p` est le bout du corps, `q` un point à l'intérieur.
 * Les dimensions sont en mètres ; le tracé se fait dans le plan Mercator (qui conserve les
 * angles) puis revient en longitude et latitude. Même forme que sur la planche : un nez
 * pointu (grande vitesse), arrondi, ou presque carré.
 */
function capPolygon(
  p: number[],
  q: number[],
  kind: CapKind,
  halfWidth: number,
  length: number,
  overlap: number,
  metersPerUnit: number,
): Polygon {
  let ux = p[0]! - q[0]!;
  let uy = p[1]! - q[1]!;
  const norm = Math.hypot(ux, uy) || 1;
  ux /= norm;
  uy /= norm;
  const nx = -uy;
  const ny = ux;
  const unit = 1 / metersPerUnit;
  const hw = halfWidth * unit;
  const len = length * unit;
  const back = overlap * unit;
  const bend = kind === 'pointu' ? 0.7 : 1.25;
  const tip = kind === 'pointu' ? 1 : 0.55;
  const cosLat = Math.cos(p[2]! * DEG);
  const px = p[0]!;
  const py = p[1]!;
  const out: Polygon = [];
  const add = (x: number, y: number) => out.push([x / DEG, p[2]! + ((y - py) * cosLat) / DEG, p[3]!]);
  add(px + nx * hw - ux * back, py + ny * hw - uy * back);
  add(px + nx * hw, py + ny * hw);
  // Deux courbes quadratiques : du flanc gauche à la pointe, puis de la pointe au flanc droit.
  const steps = 6;
  const quad = (ax: number, ay: number, cx: number, cy: number, bx: number, by: number) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const m = 1 - t;
      add(m * m * ax + 2 * m * t * cx + t * t * bx, m * m * ay + 2 * m * t * cy + t * t * by);
    }
  };
  const tx = px + ux * len * tip;
  const ty = py + uy * len * tip;
  quad(px + nx * hw, py + ny * hw, px + nx * hw + ux * len * bend, py + ny * hw + uy * len * bend, tx, ty);
  quad(tx, ty, px - nx * hw + ux * len * bend, py - ny * hw + uy * len * bend, px - nx * hw, py - ny * hw);
  add(px - nx * hw - ux * back, py - ny * hw - uy * back);
  return out;
}

/** Largeur des traits d'une rame, en « pixels » (convertis en mètres par `rame.pixelM`). */
const RAME_PX = {
  select: CAR_WIDTH_PX + 13,
  selectCore: CAR_WIDTH_PX + 9,
  halo: CAR_WIDTH_PX + 4,
  key: CAR_WIDTH_PX + 1.75,
  car: CAR_WIDTH_PX,
  shine: CAR_WIDTH_PX * 0.28,
};

/** Mètres par pixel d'écran au zoom donné, à la latitude donnée. */
const metersPerPixel = (zoom: number, lat: number) => (METERS_PER_PIXEL_Z0 * Math.cos(lat * DEG)) / 2 ** zoom;

/** Place des rames : décalage derrière la tête (mètres) et accouplement avec les rames précédentes. */
interface Slot {
  head: Head;
  start: number;
  /** Une rame accouplée devant la nôtre. */
  hasLeader: boolean;
  /** Une rame accouplée derrière la nôtre. */
  hasFollower: boolean;
}

/**
 * Deux trains de même famille et de même terminus au même endroit sont deux rames
 * accouplées : la seconde est dessinée derrière la première.
 */
function placeSlots(heads: readonly Head[]): Slot[] {
  const slots: Slot[] = [];
  for (const head of heads) {
    const { train } = head;
    const lat = head.position[1];
    const terminus = train.stations[train.stations.length - 1];
    const slot: Slot = { head, start: 0, hasLeader: false, hasFollower: false };
    for (const other of slots) {
      const o = other.head.train;
      if (o.family !== train.family || o.stations[o.stations.length - 1] !== terminus) continue;
      const dx = (other.head.position[0] - head.position[0]) * Math.cos(lat * DEG) * 111_320;
      const dy = (other.head.position[1] - head.position[1]) * 110_540;
      if (Math.hypot(dx, dy) > COUPLING_DISTANCE_M) continue;
      slot.start = Math.max(slot.start, other.start + sum(consistOf(o).cars) + COUPLING_GAP_M);
      slot.hasLeader = true;
      other.hasFollower = true;
    }
    slots.push(slot);
  }
  return slots;
}

/** Dessine les rames des trains visibles, voiture par voiture le long de leur chemin. */
function buildRames(heads: readonly Head[], zoom: number, colorOf: (head: Head) => [number, number, number]): Rame[] {
  const rames: Rame[] = [];
  const values: number[] = [];
  const spans: Array<{ rame: Rame; from: number; to: number; car: number | null }> = [];

  for (const { head, start, hasLeader, hasFollower } of placeSlots(heads)) {
    const { train } = head;
    const consist = consistOf(train);
    const lat = head.position[1];
    const mpp = metersPerPixel(zoom, lat);
    const metersPerUnit = EARTH_RADIUS_M * Math.cos(lat * DEG);
    const pixelM = Math.max(CAR_WIDTH_MIN_M, CAR_WIDTH_PX * mpp) / CAR_WIDTH_PX;
    const total = sum(consist.cars);

    collectBody(train, head, start + total + 6, metersPerUnit);
    const rame: Rame = { train, pixelM, color: colorOf(head), path: new Float64Array(0), cars: [], caps: [] };

    // Chemin de la rame, puis chaque voiture ; un jour les sépare tant qu'elles mesurent plusieurs pixels.
    const at = values.length;
    pushSlice(values, start, start + total);
    spans.push({ rame, from: at, to: values.length, car: null });
    const gap = consist.cars[0]! / mpp >= 6 ? CAR_GAP_M : 0;
    let s = start;
    for (const length of consist.cars) {
      const from = values.length;
      pushSlice(values, s + gap / 2, s + length - gap / 2);
      spans.push({ rame, from, to: values.length, car: rame.cars.length });
      rame.cars.push(new Float64Array(0));
      s += length;
    }

    // Nez et queue : le bout du corps et un point un peu à l'intérieur donnent la direction.
    // Entre deux rames accouplées, les bouts sont plats pour qu'elles se touchent.
    const inside = Math.min(Math.max(2, 3 * mpp), total / 4);
    const ends: Array<[number, number, CapKind]> = [
      [start, start + inside, hasLeader ? 'carre' : consist.nose],
      [start + total, start + total - inside, hasFollower ? 'carre' : consist.tail],
    ];
    const width = CAR_WIDTH_PX * pixelM;
    for (const [sp, sq, kind] of ends) {
      bodyAt(sp, scratchA);
      bodyAt(sq, scratchB);
      const length = kind === 'pointu' ? width * 1.5 : kind === 'rond' ? width * 0.6 : width * 0.2;
      const half = (CAR_WIDTH_PX / 2) * pixelM;
      const outer = ((CAR_WIDTH_PX + 1.75) / 2) * pixelM;
      rame.caps.push({
        halo: capPolygon(scratchA, scratchB, kind, outer + 1.5 * pixelM, length + 1.5 * pixelM, pixelM, metersPerUnit),
        key: capPolygon(scratchA, scratchB, kind, outer, length + 0.9 * pixelM, pixelM, metersPerUnit),
        fill: capPolygon(scratchA, scratchB, kind, half, length, pixelM, metersPerUnit),
      });
    }
    rames.push(rame);
  }

  // Les sommets de toutes les rames dans un seul tampon : chaque chemin en est une tranche.
  const buffer = Float64Array.from(values);
  for (const span of spans) {
    const view = buffer.subarray(span.from, span.to);
    if (span.car === null) span.rame.path = view;
    else span.rame.cars[span.car] = view;
  }
  return rames;
}

/** Fenêtre de la carte, élargie de la longueur d'une rame : les trains hors de vue ne sont pas calculés. */
let mapRef: MapLibreMap | undefined;
const VIEW_PADDING_DEG = 0.012;

function inView(head: Head, bounds: { west: number; east: number; south: number; north: number } | null): boolean {
  if (!bounds) return true;
  const [lon, lat] = head.position;
  return lon >= bounds.west && lon <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

function viewBounds(): { west: number; east: number; south: number; north: number } | null {
  if (!mapRef) return null;
  const bounds = mapRef.getBounds();
  return {
    west: bounds.getWest() - VIEW_PADDING_DEG,
    east: bounds.getEast() + VIEW_PADDING_DEG,
    south: bounds.getSouth() - VIEW_PADDING_DEG,
    north: bounds.getNorth() + VIEW_PADDING_DEG,
  };
}

/** Couches des rames : halo, contour, voitures, reflets, extrémités (dans l'ordre de dessin). */
function rameLayers(rames: readonly Rame[], chosen: Train | undefined, parameters: object) {
  const cars: CarPath[] = rames.flatMap((rame) => rame.cars.map((path) => ({ rame, path })));
  const chosenRame = chosen ? rames.filter((rame) => rame.train === chosen) : [];
  const pathCommon = {
    positionFormat: 'XYZ' as const,
    _pathType: 'open' as const,
    widthUnits: 'meters' as const,
    jointRounded: true,
    capRounded: false,
    parameters,
  };
  const polygons = (id: string, pick: 'halo' | 'key' | 'fill', color: Color, pickable = false) =>
    new SolidPolygonLayer<{ rame: Rame; polygon: Polygon }>({
      id,
      data: rames.flatMap((rame) => rame.caps.map((cap) => ({ rame, polygon: cap[pick] }))),
      getPolygon: (d) => d.polygon,
      getFillColor: pickable ? (d) => [...d.rame.color, 255] as Color : color,
      filled: true,
      extruded: false,
      pickable,
      parameters,
    });
  return [
    // Sélection : un anneau blanc et sombre tout autour de la rame, comme pour les points.
    chosenRame.length > 0 &&
      new PathLayer<Rame>({
        ...pathCommon,
        id: 'trains/rames/choix-blanc',
        data: chosenRame,
        getPath: (d) => d.path,
        getColor: [255, 255, 255, 245],
        getWidth: (d) => RAME_PX.select * d.pixelM,
        capRounded: true,
      }),
    chosenRame.length > 0 &&
      new PathLayer<Rame>({
        ...pathCommon,
        id: 'trains/rames/choix-sombre',
        data: chosenRame,
        getPath: (d) => d.path,
        getColor: KEY,
        getWidth: (d) => RAME_PX.selectCore * d.pixelM,
        capRounded: true,
      }),
    new PathLayer<Rame>({
      ...pathCommon,
      id: 'trains/rames/halo',
      data: rames as Rame[],
      getPath: (d) => d.path,
      getColor: HALO,
      getWidth: (d) => RAME_PX.halo * d.pixelM,
    }),
    polygons('trains/rames/halo-bouts', 'halo', HALO),
    new PathLayer<Rame>({
      ...pathCommon,
      id: 'trains/rames/contour',
      data: rames as Rame[],
      getPath: (d) => d.path,
      getColor: KEY,
      getWidth: (d) => RAME_PX.key * d.pixelM,
    }),
    polygons('trains/rames/contour-bouts', 'key', KEY),
    new PathLayer<CarPath>({
      ...pathCommon,
      id: 'trains/rames/voitures',
      data: cars,
      getPath: (d) => d.path,
      getColor: (d) => [...d.rame.color, 255] as Color,
      getWidth: (d) => RAME_PX.car * d.rame.pixelM,
      pickable: true,
    }),
    new PathLayer<CarPath>({
      ...pathCommon,
      id: 'trains/rames/reflets',
      data: cars,
      getPath: (d) => d.path,
      getColor: [255, 255, 255, 102],
      getWidth: (d) => RAME_PX.shine * d.rame.pixelM,
    }),
    polygons('trains/rames/bouts', 'fill', KEY, true),
  ];
}

// --- Traînées ---

/**
 * Une traînée ne montre que le dernier quart d'heure : on n'envoie donc à la carte
 * graphique que la portion des chemins proche de l'instant affiché, et non les trajets
 * entiers (dix fois moins de sommets à l'heure de pointe). Sans cela, chaque
 * rafraîchissement du temps réel figeait l'animation ~150 ms, le temps de renvoyer
 * 1,5 million de sommets.
 *
 * La fenêtre couvre la traînée et un peu d'avance ; elle est recalculée quand
 * l'instant affiché en sort, et s'allonge quand le temps défile vite (pour ne pas la
 * recalculer à chaque image). Les sommets sont passés à deck.gl déjà à plat (format
 * binaire), sans qu'il ait à parcourir les trains un par un.
 */
interface TrailWindow {
  data: TrainsData;
  pathVersion: number;
  byDelay: boolean;
  /** Instants couverts (secondes UTC). */
  from: number;
  to: number;
  binary: {
    length: number;
    startIndices: Uint32Array;
    attributes: {
      getPath: { value: Float64Array; size: 3 };
      getTimestamps: { value: Float32Array; size: 1 };
      getColor: { value: Uint8Array; size: 4 };
    };
  };
}

const TRAIL_AHEAD_MIN_S = 10 * 60;
const TRAIL_AHEAD_MAX_S = 4 * 3600;
/** Secondes réelles que doit durer une fenêtre, quelle que soit la vitesse du temps. */
const TRAIL_WINDOW_REAL_S = 20;

let trailWindow: TrailWindow | undefined;
/** Vitesse de défilement du temps observée (secondes affichées par seconde réelle). */
const pace = { t: Number.NaN, real: 0, rate: 1 };

function observePace(t: number): number {
  const real = performance.now() / 1000;
  const elapsed = real - pace.real;
  const advanced = Math.abs(t - pace.t);
  // Les sauts (frise, retour au direct) ne disent rien de la vitesse : on les ignore.
  if (elapsed > 0 && elapsed < 1 && advanced < 3600) {
    const rate = Math.min(advanced / elapsed, 50_000);
    pace.rate += (rate - pace.rate) * Math.min(1, elapsed / 2);
  }
  pace.t = t;
  pace.real = real;
  return pace.rate;
}

function trails(data: TrainsData, t: number, byDelay: boolean): TrailWindow['binary'] {
  const rate = observePace(t);
  const current = trailWindow;
  if (
    current?.data === data &&
    current.pathVersion === data.pathVersion &&
    current.byDelay === byDelay &&
    t - TRAIL_SECONDS >= current.from &&
    t <= current.to
  ) {
    return current.binary;
  }

  const ahead = Math.min(TRAIL_AHEAD_MAX_S, Math.max(TRAIL_AHEAD_MIN_S, rate * TRAIL_WINDOW_REAL_S));
  const from = t - TRAIL_SECONDS - 60;
  const to = t + ahead;
  // 1. Portion de chaque chemin dans la fenêtre (un sommet de marge de chaque côté).
  const ranges: Array<[Train, number, number]> = [];
  let vertices = 0;
  for (const train of data.trains) {
    const { times } = train;
    const n = times.length;
    if (n < 2 || times[n - 1]! < from || times[0]! > to) continue;
    const first = vertexBefore(times, from);
    const last = Math.min(n - 1, vertexBefore(times, to) + 1);
    if (last <= first) continue;
    ranges.push([train, first, last]);
    vertices += last - first + 1;
  }
  // 2. Recopie à plat.
  const startIndices = new Uint32Array(ranges.length);
  const positions = new Float64Array(vertices * 3);
  const timestamps = new Float32Array(vertices);
  const colors = new Uint8Array(vertices * 4);
  let offset = 0;
  ranges.forEach(([train, first, last], i) => {
    const count = last - first + 1;
    startIndices[i] = offset;
    positions.set(train.flatPath.subarray(first * 3, (last + 1) * 3), offset * 3);
    timestamps.set(train.timestamps.subarray(first, last + 1), offset);
    // En mode « retard », seules les têtes sont colorées : la traînée reste neutre.
    const color = byDelay ? TRAIL_GREY : [...FAMILY_STYLE[train.family].color, 200];
    for (let k = offset; k < offset + count; k++) colors.set(color as number[], k * 4);
    offset += count;
  });

  const binary = {
    length: ranges.length,
    startIndices,
    attributes: {
      getPath: { value: positions, size: 3 as const },
      getTimestamps: { value: timestamps, size: 1 as const },
      getColor: { value: colors, size: 4 as const },
    },
  };
  trailWindow = { data, pathVersion: data.pathVersion, byDelay, from, to, binary };
  return binary;
}

// --- Sélection : trajet, arrêts, tableaux d'affichage ---

/** Les gares apparaissent à partir de ce zoom (avant, elles encombreraient la carte). */
const STATION_MIN_ZOOM = 8.5;
const BOARD_ROWS = 10;
const RING: Color = [22, 26, 38, 220];
const PASSED_GREY: Color = [150, 156, 170, 235];

/** Un arrêt du train sélectionné, avec son étiquette. */
interface StopMarker {
  station: Station;
  index: number;
  position: [number, number, number];
  label: string;
}

function selectedTrain(data: TrainsData | undefined, selection: unknown): Train | undefined {
  const chosen = selection as TrainsSelection | null;
  return chosen?.type === 'train' ? data?.trainById.get(chosen.id) : undefined;
}

function selectedStation(data: TrainsData | undefined, selection: unknown): Station | undefined {
  const chosen = selection as TrainsSelection | null;
  return chosen?.type === 'gare' ? data?.stationByKey.get(chosen.key) : undefined;
}

/** État d'un passage : supprimé, arrêt supprimé, retard, ou « — » sans temps réel. */
function statusText(run: Run, stop: number, actual: number | undefined, planned: number | undefined) {
  if (run.canceled) return { text: 'supprimé', alert: true };
  if (run.skipped.has(stop)) return { text: 'arrêt supprimé', alert: true };
  if (!run.realtime || actual === undefined || planned === undefined) return { text: '—', alert: false };
  return { text: delayText(actual - planned), alert: false };
}

/** Tableau des départs (ou arrivées) d'une gare à partir de l'instant t, comme sur les écrans en gare. */
function boardTable(station: Station, t: number, departures: boolean): InfoTable {
  const entries = station.visits
    .filter(({ run, stop }) => (departures ? stop < run.stations.length - 1 : stop > 0))
    .map((visit) => {
      const { run, stop } = visit;
      const actual = (departures ? run.dep[stop] : run.arr[stop]) ?? 0;
      const planned = departures ? run.plannedDep[stop] : run.plannedArr[stop];
      return { visit, actual, planned };
    })
    .filter((entry) => entry.actual >= t - 60)
    .sort((a, b) => a.actual - b.actual)
    .slice(0, BOARD_ROWS);

  return {
    title: departures ? 'Départs' : 'Arrivées',
    columns: ['Heure', 'Train', departures ? 'Destination' : 'Provenance', 'État'],
    empty: departures ? 'Aucun départ dans les prochaines heures.' : 'Aucune arrivée dans les prochaines heures.',
    rows: entries.map(({ visit: { run, stop }, actual, planned }) => {
      const status = statusText(run, stop, actual, planned);
      const other = departures ? run.stations[run.stations.length - 1] : run.stations[0];
      const atStation = !run.canceled && (run.arr[stop] ?? Infinity) <= t && t <= (run.dep[stop] ?? -Infinity);
      return {
        cells: [hhmm(planned), `${displayCategory(run.category)} ${run.number}`, other?.name ?? '?', status.text],
        tone: status.alert ? 'alert' : atStation ? 'current' : undefined,
        select: run.canceled ? undefined : ({ type: 'train', id: run.id } satisfies TrainsSelection),
      };
    }),
  };
}

/** Liste des arrêts d'un train, l'arrêt en cours (ou le prochain) mis en évidence. */
function stopsTable(train: Train, t: number): InfoTable {
  const last = train.stations.length - 1;
  const { head } = train;
  return {
    title: 'Arrêts',
    columns: ['Heure', 'Gare', 'Retard'],
    rows: train.stations.map((station, i) => {
      const planned = i === 0 ? train.plannedDep[0] : train.plannedArr[i];
      const actual = i === 0 ? train.dep[0] : train.arr[i];
      const leaves = (i === last ? train.arr[i] : train.dep[i]) ?? 0;
      const status = statusText(train, i, actual, planned);
      const running = isRunning(train, t);
      const current = running && (head.atStop === i || (head.atStop === null && head.nextStop === i));
      return {
        cells: [hhmm(planned), station.name, status.text],
        tone: status.alert ? 'alert' : current ? 'current' : leaves < t ? 'muted' : undefined,
        select: { type: 'gare', key: station.key } satisfies TrainsSelection,
      };
    }),
  };
}

function describeTrain(train: Train, t: number): InfoContent {
  const running = updateHead(train, t);
  const { head } = train;
  const last = train.stations.length - 1;
  const origin = train.stations[0]!;
  const terminus = train.stations[last]!;
  const fields: Array<[string, string]> = [];

  if (!running) {
    const departure = train.dep[0] ?? 0;
    fields.push(['État', t < departure ? `départ à ${hhmm(departure)}` : `arrivé à ${hhmm(train.arr[last])}`]);
  } else {
    fields.push(['Retard', delayText(head.delay)]);
    fields.push(['Vitesse', head.atStop !== null ? 'à quai' : `≈ ${Math.round(head.speed)} km/h (estimée)`]);
    if (head.atStop === null && head.limit > 0) fields.push(['Vitesse autorisée', `${head.limit} km/h`]);
    if (head.atStop !== null && head.atStop < last) {
      fields.push(['À quai', `${train.stations[head.atStop]!.name}, départ ${hhmm(train.dep[head.atStop])}`]);
    } else if (head.nextStop !== null) {
      fields.push(['Prochain arrêt', `${train.stations[head.nextStop]!.name}, ${hhmm(train.arr[head.nextStop])}`]);
    }
  }
  if (train.line) fields.push(['Ligne', train.line]);
  if (!train.realtime) fields.push(['Source', 'horaire théorique']);
  if (train.onTracks < 0.99) fields.push(['Tracé', `${Math.round(train.onTracks * 100)} % sur les voies réelles`]);

  return {
    title: `${displayCategory(train.category)} ${train.number}`,
    subtitle: `${origin.name} → ${terminus.name}`,
    fields,
    tables: [stopsTable(train, t)],
  };
}

function describeStation(station: Station, t: number): InfoContent {
  return {
    title: station.name,
    subtitle: 'Gare · tableau d’affichage',
    tables: [boardTable(station, t, true), boardTable(station, t, false)],
  };
}

/** Arrêts du train sélectionné (gardés d'une image à l'autre tant que rien ne change). */
let markerCache: { train: Train; pathVersion: number; markers: StopMarker[] } | undefined;

function stopMarkers(train: Train, pathVersion: number): StopMarker[] {
  if (markerCache?.train !== train || markerCache.pathVersion !== pathVersion) {
    const markers = train.stations.map((station, index) => {
      const k = train.stopVertex[index] ?? 0;
      const planned = index === 0 ? train.plannedDep[0] : train.plannedArr[index];
      const actual = index === 0 ? train.dep[0] : train.arr[index];
      const delay = train.realtime && actual !== undefined && planned !== undefined ? Math.round((actual - planned) / 60) : 0;
      const suffix = train.skipped.has(index) ? ' · supprimé' : delay > 0 ? ` +${delay}` : '';
      return {
        station,
        index,
        position: [train.flatPath[k * 3]!, train.flatPath[k * 3 + 1]!, train.flatPath[k * 3 + 2]!] as [number, number, number],
        label: `${station.name} · ${hhmm(planned)}${suffix}`,
      };
    });
    markerCache = { train, pathVersion, markers };
  }
  return markerCache.markers;
}

/** Le trajet entier du train sélectionné : un contour sombre, la partie faite en gris, le reste en couleur. */
function routeLayers(train: Train, t: number, parameters: object) {
  const path = train.flatPath;
  const vertexCount = train.lon.length;
  let passed: Float64Array;
  let remaining: Float64Array;
  if (t <= (train.dep[0] ?? 0)) {
    passed = new Float64Array(0);
    remaining = path;
  } else if (t >= (train.arr[train.arr.length - 1] ?? 0)) {
    passed = path;
    remaining = new Float64Array(0);
  } else {
    const k = Math.min(vertexBefore(train.times, t), vertexCount - 2) + 1;
    const here = train.head.position;
    passed = new Float64Array(k * 3 + 3);
    passed.set(path.subarray(0, k * 3));
    passed.set(here, k * 3);
    remaining = new Float64Array((vertexCount - k) * 3 + 3);
    remaining.set(here);
    remaining.set(path.subarray(k * 3), 3);
  }
  const common = {
    getPath: (d: { path: Float64Array }) => d.path,
    positionFormat: 'XYZ' as const,
    widthUnits: 'pixels' as const,
    capRounded: true,
    jointRounded: true,
    parameters,
  };
  return [
    new PathLayer({ ...common, id: 'trains/selection/contour', data: [{ path }], getColor: RING, getWidth: 8 }),
    new PathLayer({ ...common, id: 'trains/selection/fait', data: [{ path: passed }], getColor: PASSED_GREY, getWidth: 4.5 }),
    new PathLayer({
      ...common,
      id: 'trains/selection/reste',
      data: [{ path: remaining }],
      getColor: [...FAMILY_STYLE[train.family].color, 255],
      getWidth: 4.5,
    }),
  ];
}

// --- Module ---

export const trains = defineModule<TrainsData>({
  id: 'trains',
  name: 'Trains',
  category: 'transport',
  description: 'TGV, Intercités et TER en circulation, avec leurs retards en temps réel.',
  attribution: 'SNCF (horaires et temps réel), voies © OpenStreetMap — ODbL',
  visibleByDefault: true,
  refreshIntervalMs: 60_000, // le temps réel SNCF change environ chaque minute
  timeStepMs: 0, // animé : les trains bougent à chaque image
  followsTerrain: true,
  // Pas de couche native : on garde seulement la carte, pour ne calculer de près que les trains dans la vue.
  native: {
    add(map) {
      mapRef = map;
    },
    remove() {
      mapRef = undefined;
    },
  },

  settings: [
    {
      id: 'couleur',
      label: 'Couleur',
      options: [
        { value: 'type', label: 'Par type' },
        { value: 'retard', label: 'Par retard' },
      ],
      defaultValue: 'type',
    },
  ],

  legend(settings) {
    const icons = trainAtlas();
    return settings.couleur === 'retard'
      ? DELAY_ORDER.map((c) => ({
          color: DELAY_STYLE[c].css,
          label: DELAY_STYLE[c].label,
          icon: icons.dataUrl(delayIcon('standard', c)),
        }))
      : FAMILY_ORDER.map((f) => ({
          color: FAMILY_STYLE[f].css,
          label: FAMILY_STYLE[f].label,
          icon: icons.dataUrl(familyIcon(f)),
        }));
  },

  load: ({ signal, time }) => loadTrains(signal, time),

  needsReload(data, time) {
    const t = time / 1000;
    return t < data.from + 5 * 60 || t > data.to - 30 * 60;
  },

  summary({ data, time }) {
    if (!data) return null;
    const t = time / 1000;
    const running = data.trains.filter((train) => isRunning(train, t)).length;
    const live = data.realtimeAt ? ` · temps réel de ${hhmm(data.realtimeAt)}` : ' · horaires théoriques';
    return `${running.toLocaleString('fr-FR')} trains en circulation${live}`;
  },

  deckLayers({ data, time, terrain, settings, selection, view }) {
    if (!data) return [];
    refreshPaths(data, terrain);
    const t = time / 1000;
    const byDelay = settings.couleur === 'retard';
    const heads = data.trains.filter((train) => updateHead(train, t)).map((train) => train.head);
    const icons = trainAtlas();
    const chosenTrain = selectedTrain(data, selection);
    const chosenStation = selectedStation(data, selection);
    // Toujours dessinés par-dessus le relief (les trains de montagne resteraient sinon cachés).
    const parameters = OVER_MAP;
    const iconOf = (head: Head) =>
      byDelay ? delayIcon(FAMILY_STYLE[head.train.family].nose, head.delayClass) : familyIcon(head.train.family);
    const colorOf = (head: Head) => (byDelay ? DELAY_STYLE[head.delayClass].rgb : FAMILY_STYLE[head.train.family].color);
    const close = view.zoom >= CARS_ZOOM;

    const markers = chosenTrain ? stopMarkers(chosenTrain, data.pathVersion) : [];
    const passedStops = chosenTrain ? markers.filter((m) => (chosenTrain.dep[m.index] ?? 0) < t).length : 0;
    // Étiquettes : tous les arrêts vu de près, seulement départ, terminus et prochain arrêt vu de loin.
    const nextStop = chosenTrain?.head.nextStop ?? null;
    const labels = view.zoom >= 8 ? markers : markers.filter((_, i) => i === 0 || i === markers.length - 1 || i === nextStop);

    // Gares : leur taille dit leur trafic, la grande a un anneau et un point central.
    const stationScale = zoomRamp(view.zoom, STATION_MIN_ZOOM, 12, 0.75, 1);
    const stationPosition = (s: Station): [number, number, number] => [s.lon, s.lat, terrain.elevation(s.lon, s.lat)];
    const stationRadius = (s: Station) => STATION_RADIUS_PX[s.size];

    // De près, la rame entière à la place de la tête, pour les seuls trains dans la vue.
    const bounds = close ? viewBounds() : null;
    const rames = close ? buildRames(heads.filter((head) => inView(head, bounds)), view.zoom, colorOf) : [];
    // De loin, l'anneau de sélection suit la taille de la tête.
    const headPixels = Math.min(TRAIN_MAX_PX, Math.max(headMinPixels(view.zoom), TRAIN_SIZE_M / metersPerPixel(view.zoom, chosenTrain?.head.position[1] ?? 46)));

    return [
      new TripsLayer({
        id: 'trains/traines',
        // Données binaires : les accesseurs sont remplacés par les tableaux de `attributes`.
        data: trails(data, t, byDelay),
        _pathType: 'open',
        positionFormat: 'XYZ',
        currentTime: t - data.base,
        trailLength: TRAIL_SECONDS,
        fadeTrail: true,
        widthUnits: 'pixels',
        getWidth: TRAIL_WIDTH_PX,
        capRounded: true,
        jointRounded: true,
        parameters,
      }),
      chosenTrain && routeLayers(chosenTrain, t, parameters),
      view.zoom >= STATION_MIN_ZOOM &&
        new ScatterplotLayer<Station>({
          id: 'trains/gares-halo',
          data: data.stations,
          getPosition: stationPosition,
          radiusUnits: 'pixels',
          getRadius: (s) => stationRadius(s) + STATION_LINE_PX[s.size] / 2 + STATION_HALO_PX,
          radiusScale: stationScale,
          getFillColor: HALO,
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      view.zoom >= STATION_MIN_ZOOM &&
        new ScatterplotLayer<Station>({
          id: 'trains/gares',
          data: data.stations,
          getPosition: stationPosition,
          radiusUnits: 'pixels',
          getRadius: stationRadius,
          radiusScale: stationScale,
          getFillColor: [255, 255, 255],
          stroked: true,
          getLineColor: KEY,
          lineWidthUnits: 'pixels',
          getLineWidth: (s) => STATION_LINE_PX[s.size],
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [20, 26, 38, 150],
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      view.zoom >= STATION_MIN_ZOOM &&
        new ScatterplotLayer<Station>({
          id: 'trains/gares-centre',
          data: data.centred,
          getPosition: stationPosition,
          radiusUnits: 'pixels',
          getRadius: (s) => stationRadius(s) * STATION_DOT_RATIO,
          radiusScale: stationScale,
          getFillColor: KEY,
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      chosenStation &&
        selectionRing(
          'trains/gare-choisie',
          [chosenStation],
          stationPosition,
          (s) => (stationRadius(s) + 5) * stationScale + 2,
          parameters,
        ),
      chosenTrain &&
        new ScatterplotLayer<StopMarker>({
          id: 'trains/selection/arrets',
          data: markers,
          getPosition: (m) => m.position,
          radiusUnits: 'pixels',
          getRadius: (m) => (chosenTrain.skipped.has(m.index) ? 3.5 : 5),
          getFillColor: (m) => (m.index < passedStops ? PASSED_GREY : [255, 255, 255]),
          stroked: true,
          getLineColor: RING,
          lineWidthUnits: 'pixels',
          getLineWidth: 2,
          billboard: true,
          pickable: true,
          updateTriggers: { getFillColor: passedStops },
          parameters,
        }),
      close
        ? rameLayers(rames, chosenTrain, parameters)
        : [
            new IconLayer<Head>({
              id: 'trains/positions',
              data: heads,
              iconAtlas: icons.atlas,
              iconMapping: icons.mapping,
              getIcon: iconOf,
              getPosition: (head) => head.position,
              getAngle: (head) => head.angle,
              // À plat sur la carte : le train tourne avec elle et suit son sens de marche.
              billboard: false,
              sizeUnits: 'meters',
              getSize: TRAIN_SIZE_M,
              sizeMinPixels: headMinPixels(view.zoom),
              sizeMaxPixels: TRAIN_MAX_PX,
              pickable: true,
              autoHighlight: true,
              highlightColor: [255, 255, 255, 110],
              parameters,
            }),
            chosenTrain &&
              isRunning(chosenTrain, t) &&
              selectionRing(
                'trains/selection/tete',
                [chosenTrain.head],
                (head) => head.position,
                headPixels * 0.95 + 2,
                parameters,
              ),
          ],
      chosenTrain &&
        new TextLayer<StopMarker>({
          id: 'trains/selection/noms',
          data: labels,
          getPosition: (m) => m.position,
          getText: (m) => m.label,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 12,
          getColor: (m) => (m.index < passedStops ? [190, 195, 205] : [255, 255, 255]),
          getPixelOffset: [0, -16],
          background: true,
          getBackgroundColor: [15, 18, 26, 225],
          backgroundPadding: [5, 3],
          billboard: true,
          updateTriggers: { getColor: passedStops },
          parameters,
        }),
    ];
  },

  select(object) {
    const picked = object as Partial<Head & StopMarker & Station & { rame: Rame }>;
    // Une tête, une voiture ou un bout de rame : le même train.
    const train = picked.train ?? picked.rame?.train;
    if (train) return { type: 'train', id: train.id } satisfies TrainsSelection;
    if (picked.station) return { type: 'gare', key: picked.station.key } satisfies TrainsSelection;
    if (typeof picked.key === 'string') return { type: 'gare', key: picked.key } satisfies TrainsSelection;
    return null;
  },

  describe(selection, { data, time }) {
    const t = time / 1000;
    const train = selectedTrain(data, selection);
    if (train) return describeTrain(train, t);
    const station = selectedStation(data, selection);
    return station ? describeStation(station, t) : null;
  },

  focus(selection, { data, time }) {
    const train = selectedTrain(data, selection);
    if (train) {
      if (!updateHead(train, time / 1000)) return null;
      return { lon: train.head.position[0], lat: train.head.position[1] };
    }
    return null; // une gare ne bouge pas : rien à suivre
  },
});
