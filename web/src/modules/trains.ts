/**
 * Module « Trains » : les TGV, Intercités et TER de France à leur position à
 * l'instant t, sur les vraies voies, avec leurs retards en temps réel.
 *
 * Le serveur (dossier `server/`) envoie, pour une période de quelques heures, les
 * trains avec leurs arrêts, leurs horaires prévus et réels, et le tracé des voies
 * entre chaque gare (calculé sur les voies OpenStreetMap). Le navigateur calcule
 * lui-même la position de chaque train à chaque image : aucun échange réseau
 * pendant l'animation, et le replay fonctionne comme le direct.
 *
 * Entre deux gares, on suppose une vitesse constante le long du tracé. Si le
 * serveur n'a pas (encore) de tracé pour un tronçon, le train y va en ligne droite.
 */
import type { Color } from '@deck.gl/core';
import { TripsLayer } from '@deck.gl/geo-layers';
import { IconLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule, type InfoContent, type InfoTable, type TerrainSampler } from '../core/module';
import { formatTime } from '../ui/format';
import { buildTrainAtlas, type Nose, type TrainAtlas, type TrainIconSpec } from './trainIcons';

// --- Réponse de l'API (voir server/src/api.rs) ---

interface ApiStation {
  name: string;
  lon: number;
  lat: number;
}

interface ApiTrain {
  id: string;
  number: string;
  category: string;
  line: string;
  stations: number[];
  /** Tracé entre chaque gare et la suivante : k > 0 = tracks[k-1], k < 0 = tracks[-k-1] à l'envers, 0 = aucun. */
  tracks?: number[];
  arr: number[];
  dep: number[];
  arrRt?: number[];
  depRt?: number[];
  skipped?: number[];
  canceled: boolean;
}

interface ApiResponse {
  from: number;
  to: number;
  realtime: { feedTimestamp: number; fetchedAt: number } | null;
  stations: ApiStation[];
  tracks?: string[];
  trains: ApiTrain[];
}

// --- Modèle côté navigateur ---

/** Un tracé décodé : longitude, latitude, ordonnée Mercator, altitude, distance cumulée. */
interface Track {
  lon: Float64Array;
  lat: Float64Array;
  my: Float64Array;
  /** Altitude du rail en mètres (sans exagération du relief). */
  z: Float32Array;
  /** Distance depuis le début du tracé, en mètres. */
  along: Float64Array;
}

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
}

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
  /** Cap, en degrés dans le sens inverse des aiguilles d'une montre depuis l'est (convention deck.gl). */
  angle: number;
  /** Retard en secondes à cet instant, `null` sans temps réel. */
  delay: number | null;
  delayClass: DelayClass;
  /** Indice de l'arrêt où le train est à quai, sinon `null`. */
  atStop: number | null;
  nextStop: number | null;
  /** Vitesse moyenne estimée sur la portion en cours, en km/h (0 à quai). */
  speed: number;
}

interface TrainsData {
  /** Période chargée (secondes UTC). */
  from: number;
  to: number;
  /** Origine des horodatages de la traînée : la précision des flottants GPU l'exige. */
  base: number;
  realtimeAt: number | null;
  stations: Station[];
  stationByKey: Map<string, Station>;
  trains: Train[];
  trainById: Map<string, Train>;
  canceled: number;
  /** Exagération du relief appliquée à `flatPath` (−1 : pas encore calculé). */
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
const DELAY_STYLE: Record<DelayClass, { css: string; label: string }> = {
  inconnu: { css: '#8a8f9c', label: 'Sans information temps réel' },
  heure: { css: '#ffffff', label: 'À l’heure (moins de 5 min)' },
  retard: { css: '#f0913a', label: '5 à 14 min de retard' },
  'gros-retard': { css: '#a83a16', label: '15 min de retard ou plus' },
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
 * Taille des trains : hauteur de l'icône en mètres, bornée en pixels pour rester
 * visible vu de loin et ne pas envahir l'écran vu de près.
 */
const TRAIN_SIZE_M = 900;
const TRAIN_MIN_PX = 7;
const TRAIN_MAX_PX = 18;
const TRAIL_GREY: Color = [230, 233, 240, 150];
/** Longueur de la traînée, en secondes de trajet. */
const TRAIL_SECONDS = 15 * 60;
/** Période chargée autour de l'instant affiché. */
const LOAD_BEFORE_S = 30 * 60;
const LOAD_AFTER_S = 3 * 3600;
const DEG = Math.PI / 180;

const CATEGORY_NAMES: Record<string, string> = {
  'Train TER': 'TER',
  INTERCITES: 'Intercités',
  'INTERCITES de nuit': 'Intercités de nuit',
  TramTrain: 'Tram-train',
};

// --- Géométrie ---

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
}

function latitudeFromMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

/** Cap d'un tronçon tel qu'il apparaît sur la carte (Web Mercator), en degrés deck.gl. */
function heading(lon1: number, my1: number, lon2: number, my2: number): number {
  return Math.atan2(my2 - my1, (lon2 - lon1) * DEG) / DEG;
}

/** Décode un tracé « polyline » étendu à l'altitude (voir server/src/api.rs). */
function decodeTrack(encoded: string): Track {
  const values: number[] = [];
  let index = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    values.push(result & 1 ? ~(result >> 1) : result >> 1);
  }
  const count = Math.floor(values.length / 3);
  const track: Track = {
    lon: new Float64Array(count),
    lat: new Float64Array(count),
    my: new Float64Array(count),
    z: new Float32Array(count),
    along: new Float64Array(count),
  };
  let lat = 0;
  let lon = 0;
  let z = 0;
  for (let i = 0; i < count; i++) {
    lat += values[i * 3]!;
    lon += values[i * 3 + 1]!;
    z += values[i * 3 + 2]!;
    track.lat[i] = lat / 1e5;
    track.lon[i] = lon / 1e5;
    track.my[i] = mercatorY(lat / 1e5);
    track.z[i] = z;
    if (i > 0) {
      const dx = (track.lon[i]! - track.lon[i - 1]!) * Math.cos(track.lat[i]! * DEG) * 111_320;
      const dy = (track.lat[i]! - track.lat[i - 1]!) * 110_540;
      track.along[i] = track.along[i - 1]! + Math.hypot(dx, dy);
    }
  }
  return track;
}

// --- Chargement ---

async function loadTrains(signal: AbortSignal, time: number): Promise<TrainsData> {
  const t = Math.floor(time / 1000);
  let response: Response;
  try {
    response = await fetch(`/api/trains?from=${t - LOAD_BEFORE_S}&to=${t + LOAD_AFTER_S}`, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('serveur des trains injoignable (lancer « cargo run » dans server/)');
  }
  if (!response.ok) throw new Error(`le serveur des trains a répondu ${response.status}`);
  return parse((await response.json()) as ApiResponse);
}

/** Sommets d'un tronçon entre deux gares : le tracé réel s'il existe, sinon la ligne droite. */
function intervalVertices(
  ref: number,
  tracks: Track[],
  from: ApiStation,
  to: ApiStation,
): { lon: number[]; lat: number[]; z: number[]; along: number[]; real: boolean } {
  const track = ref !== 0 ? tracks[Math.abs(ref) - 1] : undefined;
  if (!track || track.lon.length < 2) {
    const dx = (to.lon - from.lon) * Math.cos(from.lat * DEG) * 111_320;
    const dy = (to.lat - from.lat) * 110_540;
    return { lon: [from.lon, to.lon], lat: [from.lat, to.lat], z: [NaN, NaN], along: [0, Math.hypot(dx, dy)], real: false };
  }
  const n = track.lon.length;
  const total = track.along[n - 1]!;
  const order = ref > 0 ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
  return {
    lon: order.map((i) => track.lon[i]!),
    lat: order.map((i) => track.lat[i]!),
    z: order.map((i) => track.z[i]!),
    along: order.map((i) => (ref > 0 ? track.along[i]! : total - track.along[i]!)),
    real: true,
  };
}

function stationKey(s: ApiStation): string {
  return `${s.name}|${s.lon.toFixed(4)}|${s.lat.toFixed(4)}`;
}

function parse(json: ApiResponse): TrainsData {
  const tracks = (json.tracks ?? []).map(decodeTrack);
  const stations: Station[] = json.stations.map((s) => ({ key: stationKey(s), name: s.name, lon: s.lon, lat: s.lat, visits: [] }));
  const trains: Train[] = [];
  let canceled = 0;

  for (const api of json.trains) {
    const family = FAMILY_OF[api.category] ?? 'ter';
    const common = { id: api.id, number: api.number, category: api.category, family, line: api.line };

    if (api.canceled) {
      // Un train supprimé ne roule pas, mais figure (supprimé) dans les tableaux des gares.
      const runStations = api.stations.map((i) => stations[i]).filter((s): s is Station => s !== undefined);
      if (runStations.length !== api.stations.length) continue;
      const run: Run = {
        ...common,
        stations: runStations,
        arr: api.arr,
        dep: api.dep,
        plannedArr: api.arr,
        plannedDep: api.dep,
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
    const arr = slice(api.arrRt ?? api.arr);
    const dep = slice(api.depRt ?? api.dep);

    // Chemin complet : pour chaque tronçon, les points de voie avec leur heure de passage
    // (vitesse constante le long du tracé entre deux gares).
    const lon: number[] = [];
    const lat: number[] = [];
    const z: number[] = [];
    const times: number[] = [];
    const stopVertex = [0];
    let realLength = 0;
    let totalLength = 0;
    for (let i = 0; i + 1 < stops.length; i++) {
      const ref = api.tracks?.[first + i] ?? 0;
      const vertices = intervalVertices(ref, tracks, stops[i]!, stops[i + 1]!);
      const leave = dep[i] ?? 0;
      const reach = arr[i + 1] ?? leave;
      const length = vertices.along[vertices.along.length - 1] ?? 0;
      totalLength += length;
      if (vertices.real) realLength += length;
      vertices.lon.forEach((value, k) => {
        lon.push(value);
        lat.push(vertices.lat[k]!);
        z.push(vertices.z[k]!);
        times.push(length > 0 ? leave + ((reach - leave) * vertices.along[k]!) / length : k === 0 ? leave : reach);
      });
      stopVertex.push(lon.length - 1);
    }

    const count = lon.length;
    const my = Float64Array.from(lat, mercatorY);
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

    const train = {
      ...common,
      stations: stops,
      arr,
      dep,
      plannedArr: slice(api.arr),
      plannedDep: slice(api.dep),
      realtime: api.arrRt !== undefined,
      canceled: false,
      skipped: new Set([...skippedAll].filter((i) => i > first && i < last).map((i) => i - first)),
      onTracks: totalLength > 0 ? realLength / totalLength : 0,
      lon: lonArray,
      my,
      zRail: Float32Array.from(z),
      times: Float64Array.from(times),
      angles,
      stopVertex,
      flatPath: new Float64Array(count * 3),
      timestamps: Float32Array.from(times, (t) => t - json.from),
    } as Omit<Train, 'head'> as Train;
    train.head = {
      train,
      position: [0, 0, 0],
      angle: 0,
      delay: null,
      delayClass: 'inconnu',
      atStop: null,
      nextStop: null,
      speed: 0,
    };
    stops.forEach((station, stop) => station.visits.push({ run: train, stop }));
    trains.push(train);
  }

  return {
    from: json.from,
    to: json.to,
    base: json.from,
    realtimeAt: json.realtime?.feedTimestamp ?? null,
    stations,
    stationByKey: new Map(stations.map((s) => [s.key, s])),
    trains,
    trainById: new Map(trains.map((t) => [t.id, t])),
    canceled,
    exaggeration: -1,
    pathVersion: 0,
  };
}

// --- Calculs à l'instant t ---

/** Altitude affichée d'un sommet : celle du rail × exagération du relief, sinon celle du relief affiché. */
function displayedZ(train: Train, k: number, terrain: TerrainSampler): number {
  const rail = train.zRail[k]!;
  if (terrain.exaggeration === 0) return 0;
  if (!Number.isNaN(rail)) return rail * terrain.exaggeration;
  return terrain.elevation(train.lon[k]!, latitudeFromMercatorY(train.my[k]!));
}

/** Recalcule les sommets de la traînée quand l'exagération du relief change (activation, désactivation). */
function refreshPaths(data: TrainsData, terrain: TerrainSampler): void {
  if (data.exaggeration === terrain.exaggeration) return;
  for (const train of data.trains) {
    for (let k = 0; k < train.lon.length; k++) {
      train.flatPath[k * 3] = train.lon[k]!;
      train.flatPath[k * 3 + 1] = latitudeFromMercatorY(train.my[k]!);
      train.flatPath[k * 3 + 2] = displayedZ(train, k, terrain);
    }
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
  head.angle = train.angles[k]!;
  // Vitesse moyenne sur la portion en cours (nulle à quai : les deux sommets coïncident).
  const lat0 = latitudeFromMercatorY(train.my[k]!);
  const lat1 = latitudeFromMercatorY(train.my[k + 1]!);
  const meters = Math.hypot((train.lon[k + 1]! - train.lon[k]!) * Math.cos(lat0 * DEG) * 111_320, (lat1 - lat0) * 110_540);
  head.speed = t1 > t0 ? (meters / (t1 - t0)) * 3.6 : 0;

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

// --- Sélection : trajet, arrêts, tableaux d'affichage ---

/** Les gares apparaissent à partir de ce zoom (avant, elles encombreraient la carte). */
const STATION_MIN_ZOOM = 8.5;
const BOARD_ROWS = 10;
const RING: Color = [22, 26, 38, 220];
const ACCENT: Color = [79, 140, 255];
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
    fields.push(['Vitesse', head.atStop !== null ? 'à quai' : `≈ ${Math.round(head.speed)} km/h (moyenne estimée)`]);
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
    const parameters = { depthCompare: 'always', depthWriteEnabled: false } as const;
    const iconOf = (head: Head) =>
      byDelay ? delayIcon(FAMILY_STYLE[head.train.family].nose, head.delayClass) : familyIcon(head.train.family);

    const markers = chosenTrain ? stopMarkers(chosenTrain, data.pathVersion) : [];
    const passedStops = chosenTrain ? markers.filter((m) => (chosenTrain.dep[m.index] ?? 0) < t).length : 0;
    // Étiquettes : tous les arrêts vu de près, seulement départ, terminus et prochain arrêt vu de loin.
    const nextStop = chosenTrain?.head.nextStop ?? null;
    const labels = view.zoom >= 8 ? markers : markers.filter((_, i) => i === 0 || i === markers.length - 1 || i === nextStop);

    return [
      new TripsLayer<Train>({
        id: 'trains/traines',
        data: data.trains,
        getPath: (train) => train.flatPath,
        positionFormat: 'XYZ',
        getTimestamps: (train) => train.timestamps,
        // En mode « retard », seules les têtes sont colorées : la traînée reste neutre.
        getColor: (train) => (byDelay ? TRAIL_GREY : [...FAMILY_STYLE[train.family].color, 200]),
        currentTime: t - data.base,
        trailLength: TRAIL_SECONDS,
        fadeTrail: true,
        widthUnits: 'pixels',
        getWidth: 3,
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getPath: data.pathVersion, getColor: byDelay },
        parameters,
      }),
      chosenTrain && routeLayers(chosenTrain, t, parameters),
      view.zoom >= STATION_MIN_ZOOM &&
        new ScatterplotLayer<Station>({
          id: 'trains/gares',
          data: data.stations,
          getPosition: (s) => [s.lon, s.lat, terrain.elevation(s.lon, s.lat)],
          radiusUnits: 'meters',
          getRadius: 70,
          radiusMinPixels: 3,
          radiusMaxPixels: 7,
          getFillColor: [255, 255, 255],
          stroked: true,
          getLineColor: RING,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [79, 140, 255, 200],
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      chosenStation &&
        new ScatterplotLayer<Station>({
          id: 'trains/gare-choisie',
          data: [chosenStation],
          getPosition: (s) => [s.lon, s.lat, terrain.elevation(s.lon, s.lat)],
          radiusUnits: 'pixels',
          getRadius: 11,
          filled: false,
          stroked: true,
          getLineColor: ACCENT,
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          billboard: true,
          parameters,
        }),
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
        sizeMinPixels: TRAIN_MIN_PX,
        sizeMaxPixels: TRAIN_MAX_PX,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        parameters,
      }),
      chosenTrain &&
        isRunning(chosenTrain, t) &&
        new IconLayer<Head>({
          id: 'trains/selection/train',
          data: [chosenTrain.head],
          iconAtlas: icons.atlas,
          iconMapping: icons.mapping,
          getIcon: iconOf,
          getPosition: (head) => head.position,
          getAngle: (head) => head.angle,
          billboard: false,
          sizeUnits: 'meters',
          getSize: TRAIN_SIZE_M * 1.6,
          sizeMinPixels: TRAIN_MIN_PX * 1.7,
          sizeMaxPixels: TRAIN_MAX_PX * 1.4,
          pickable: true,
          parameters,
        }),
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
    const picked = object as Partial<Head & StopMarker & Station>;
    if (picked.train) return { type: 'train', id: picked.train.id } satisfies TrainsSelection;
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
