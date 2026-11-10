/**
 * Module « Isochrones » : jusqu'où peut-on aller en transports en commun depuis une gare, en partant
 * à l'heure de la carte ?
 *
 * Le serveur (`server/src/raptor.rs`) calcule, avec l'algorithme RAPTOR sur les horaires SNCF (trains,
 * cars TER), ceux des cars interurbains des régions et ceux d'Île-de-France (métro, RER, Transilien,
 * tramway), l'arrivée au plus tôt à chaque arrêt : durée, correspondances. Le navigateur n'en fait que
 * l'affichage :
 *
 * - les gares atteintes, colorées par tranche d'une heure de trajet ;
 * - les arrêts supplémentaires atteints (cars, métro, RER sans gare SNCF), plus petits, cernés selon le
 *   mode, nommés seulement de près ; leur liste vient d'une ressource à part (`/api/arrets/{version}`) ;
 * - une zone lisse (couche raster native, sous les étiquettes) : autour de chaque gare, le temps
 *   qui reste est converti en rayon à `ACCESS_SPEED_KMH` (route, car, vélo), et chaque point de la
 *   carte prend le meilleur temps total, « gare atteinte + trajet jusqu'au point ». C'est une
 *   transformée de distance, calculée sur une grille puis colorée par tranche ;
 * - la gare de départ, et la fiche de chaque gare atteinte avec son itinéraire.
 *
 * La gare de départ est un état à part (`urlState`) : elle vit dans l'adresse (`#depuis=87471003`),
 * pas dans les réglages, qui sont des listes d'options. L'heure de départ est celle de l'horloge :
 * le calcul est refait quand elle s'écarte de `REQUERY_S` de celle du dernier calcul.
 */
import type { Color } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import type { ImageSource, Map as MapLibreMap } from 'maplibre-gl';
import { defineModule, type InfoContent, type InfoTable } from '../core/module';
import { ModuleManager } from '../core/moduleManager';
import { plainStatus, isLiveTime } from '../core/infoStatus';
import { currentNight, firstSymbolLayerId } from '../map/baseMap';
import { OVER_MAP } from '../map/parameters';
import { goTo } from '../search/access';
import { formatTime } from '../ui/format';
import { fetchJson, loadNetwork, type RailNetwork, ServerError } from './railNetwork';
import { HALO, KEY, selectionRing, zoomRamp } from './symbols';

// --- Palette : une seule teinte (framboise), une tranche par heure de trajet ---

/**
 * Jour : le plus proche est le plus foncé, le plus lointain le plus clair (validée avec
 * `validate_palette.js --ordinal` sur le fond clair : ordre monotone, écarts nets, bout clair à 2,2:1).
 */
const DAY_RAMP = ['#5a0a3a', '#86114f', '#ad2368', '#cc4a86', '#e0709f', '#ec8fb2'];
/** Nuit : le proche est le plus clair, le lointain s'estompe (validée de même sur le fond sombre, bout sombre à 2,6:1). */
const NIGHT_RAMP = ['#fbd0de', '#f4a9c3', '#e982ab', '#d95b92', '#c43a7b', '#a9255f'];
const BAND_S = 3600;
const BAND_LABELS = ['Moins d’1 h', '1 à 2 h', '2 à 3 h', '3 à 4 h', '4 à 5 h', '5 h et plus'];
/** Opacité de la zone sur le fond (le fond est plus sombre la nuit : un peu plus dense pour rester lisible). */
const AREA_ALPHA_DAY = 0.6;
const AREA_ALPHA_NIGHT = 0.68;
/**
 * Autour d'un arrêt atteint, la zone s'étend à une vitesse et jusqu'à un rayon qui dépendent du mode : on rejoint une
 * gare en voiture, en car ou à vélo (15 km/h en moyenne, 30 km au plus) ; un arrêt de car, un peu moins loin ; une
 * station de métro, à pied ou à vélo seulement (5 km/h, 2 km).
 */
const ACCESS = {
  rail: { speedKmh: 15, maxKm: 30 },
  car: { speedKmh: 15, maxKm: 15 },
  idf: { speedKmh: 5, maxKm: 2 },
} as const;
/** Écart avec l'heure du dernier calcul au-delà duquel on le refait (secondes). */
const REQUERY_S = 5 * 60;
/** Taille maximale de la grille de la zone, en cases par côté. */
const MAX_GRID = 900;
const MIN_CELL_M = 1000;
const EARTH_R = 6378137;
const MODULE_ID = 'isochrones';

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const DAY_RGB = DAY_RAMP.map(rgb);
const NIGHT_RGB = NIGHT_RAMP.map(rgb);

/** Couleur de la tranche `band` selon la part de nuit du fond (0 jour, 1 nuit). */
function bandColor(band: number, night: number): [number, number, number] {
  const day = DAY_RGB[band]!;
  const dark = NIGHT_RGB[band]!;
  return [0, 1, 2].map((i) => Math.round(day[i]! + (dark[i]! - day[i]!) * night)) as [number, number, number];
}

const bandOf = (seconds: number) => Math.min(DAY_RAMP.length - 1, Math.floor(seconds / BAND_S));

// --- Gare de départ (état partagé avec l'adresse, la recherche et les fiches des gares) ---

let originCode: string | null = null;

/**
 * Choisit la gare de départ et affiche la couche. `at` : où regarder (on recule la carte si elle est trop
 * près pour voir la zone). `null` efface l'isochrone.
 */
export function setIsochroneOrigin(code: string | null, at?: { lon: number; lat: number }): void {
  originCode = code;
  const manager = ModuleManager.current;
  if (!manager || !code) return;
  manager.setVisible(MODULE_ID, true);
  manager.setSelection(MODULE_ID, { type: 'origine' } satisfies IsoSelection);
  if (at) goTo(manager, at.lon, at.lat, 6);
}

export const isochroneOrigin = (): string | null => originCode;

// --- Réponses de l'API (voir server/src/api.rs) ---

interface ApiIsochrone {
  network: string;
  origin: number;
  departure: number;
  realtime: boolean;
  stations: number[];
  seconds: number[];
  transfers: number[];
  /** Version de la ressource des arrêts supplémentaires, `null` quand cars et Île-de-France ne sont pas chargés. */
  extras: string | null;
  /** Modes pris en compte : `train`, `car`, `idf`. */
  modes: string[];
  extraStops: number[];
  extraSeconds: number[];
  extraTransfers: number[];
  /** Habitants à portée des arrêts atteints (carreaux INSEE, voir `server/src/tiles/popgrid.rs`) ; `null` : grille pas prête. */
  population: { total: number; bandMinutes: number; bands: number[] } | null;
}

/** Genre d'un arrêt supplémentaire (voir `server/src/multimodal.rs`). */
type StopKind = 'car' | 'metro' | 'rer' | 'transilien' | 'tram';

/** Les arrêts supplémentaires, en colonnes (`/api/arrets/{version}`). */
interface ExtraStops {
  version: string;
  kinds: string[];
  names: string[];
  lon: number[];
  lat: number[];
  kind: number[];
}

type ApiLeg =
  | { type: 'train'; number: string; category: string; line: string; from: number; to: number; departure: number; arrival: number; stops: number }
  | {
      type: 'transit';
      mode: StopKind;
      /** « Car TER », « Car BreizhGo 7 », « RER B », « Métro 14 ». */
      label: string;
      line: string;
      headsign: string | null;
      color: string | null;
      textColor: string | null;
      from: number;
      to: number;
      departure: number;
      arrival: number;
      stops: number;
    }
  | { type: 'walk'; from: number; to: number; departure: number; arrival: number };

interface ApiJourney {
  network: string;
  /** Les indices de départ et d'arrivée au-delà sont des arrêts supplémentaires (indice − `stationCount`). */
  stationCount: number;
  extras: string | null;
  realtime: boolean;
  legs: ApiLeg[];
}

// --- Modèle côté navigateur ---

/** Une gare atteinte, ou un arrêt supplémentaire (`kind` renseigné : car, métro, RER…). */
export interface Reached {
  /** Indice dans le réseau ferré, ou dans la ressource des arrêts supplémentaires. */
  index: number;
  /** Code UIC de la gare ; « x12 » pour l'arrêt supplémentaire 12 (c'est ce que le serveur attend pour son itinéraire). */
  code: string;
  kind?: StopKind;
  name: string;
  lon: number;
  lat: number;
  /** Durée du trajet (secondes). */
  seconds: number;
  transfers: number;
  band: number;
}

interface Grid {
  /** Coins en Mercator (mètres). */
  west: number;
  south: number;
  /** Taille d'une case (mètres Mercator). */
  cell: number;
  width: number;
  height: number;
  /** Meilleur temps total de chaque case (secondes), `Infinity` hors de portée ; rangée du haut d'abord. */
  seconds: Float32Array;
}

export interface IsochroneData {
  /** Ce pour quoi ces données ont été calculées. */
  query: { code: string | null; departure: number; maxMinutes: number; transfers: string; modes: string };
  network?: RailNetwork;
  /** Arrêts supplémentaires de cette version, si le serveur en a pour cette requête. */
  extras?: ExtraStops;
  origin?: Reached;
  /** Gares atteintes (sans la gare de départ). */
  reached: Reached[];
  /** Arrêts supplémentaires atteints : cars, métro, RER, tramway. */
  extraReached: Reached[];
  byCode: Map<string, Reached>;
  /** Le serveur a-t-il pris en compte les cars et Île-de-France demandés ? (Faux tant qu'ils se chargent.) */
  multimodal: boolean;
  realtime: boolean;
  /** Habitants atteints dans la durée demandée, au total et par tranche de temps. */
  population?: { total: number; bandMinutes: number; bands: number[] };
  grid?: Grid;
  /** Image de la zone déjà colorée pour une part de nuit (voir `native.update`). */
  rendered?: { night: number; url: string; coordinates: Coordinates };
}

type Coordinates = [[number, number], [number, number], [number, number], [number, number]];
type IsoSelection = { type: 'gare'; code: string } | { type: 'origine' };

const EMPTY: IsochroneData = {
  query: { code: null, departure: 0, maxMinutes: 0, transfers: '', modes: '' },
  reached: [],
  extraReached: [],
  byCode: new Map(),
  multimodal: false,
  realtime: false,
};

// --- Chargement ---

/** Dernière fois qu'on a retenté un calcul multimodal pendant que le serveur chargeait ses réseaux. */
let lastMultimodalCheck = 0;

const maxMinutesOf = (settings: Readonly<Record<string, string>>) => Number(settings.duree) || 180;

/** Réglage « Transports pris en compte » → paramètre `modes` de l'API (le train est toujours de la partie). */
const MODES_PARAM: Record<string, string> = { trains: 'train', cars: 'train,car', tout: 'train,car,idf' };
const modesOf = (settings: Readonly<Record<string, string>>) => (settings.modes && MODES_PARAM[settings.modes] ? settings.modes : 'tout');

/** Arrêts supplémentaires par version : la ressource est immuable, un seul téléchargement pour tous les calculs. */
const extraStopsCache = new Map<string, Promise<ExtraStops>>();

function loadExtraStops(version: string, signal: AbortSignal): Promise<ExtraStops> {
  let promise = extraStopsCache.get(version);
  if (!promise) {
    promise = fetchJson<Omit<ExtraStops, 'version'>>(`/api/arrets/${version}`, new AbortController().signal).then((api) => ({ ...api, version }));
    extraStopsCache.set(version, promise);
    promise.catch(() => extraStopsCache.delete(version));
    if (extraStopsCache.size > 3) extraStopsCache.delete(extraStopsCache.keys().next().value as string);
  }
  const shared = promise;
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    shared.then(resolve, reject);
  });
}

async function loadIsochrone(signal: AbortSignal, time: number, settings: Readonly<Record<string, string>>): Promise<IsochroneData> {
  const code = originCode;
  const maxMinutes = maxMinutesOf(settings);
  const transfers = settings.correspondances ?? '2';
  const modes = modesOf(settings);
  const departure = Math.floor(time / 60_000) * 60;
  const query = { code, departure, maxMinutes, transfers, modes };
  if (!code) return { ...EMPTY, query };

  const limit = transfers === 'illimite' ? '' : `&correspondances=${transfers}`;
  const json = await fetchJson<ApiIsochrone>(
    `/api/isochrone?depuis=${encodeURIComponent(code)}&depart=${departure}&max=${maxMinutes}${limit}&modes=${MODES_PARAM[modes]}`,
    signal,
  );
  // Le réseau (ou les arrêts) a pu changer de version entre l'envoi de la réponse et le téléchargement : on redemande une fois.
  let network: RailNetwork;
  let extras: ExtraStops | undefined;
  try {
    network = await loadNetwork(json.network, signal);
    if (json.extras) extras = await loadExtraStops(json.extras, signal);
  } catch (error) {
    if (error instanceof ServerError && error.status === 404) return loadIsochrone(signal, time, settings);
    throw error;
  }

  const reached: Reached[] = [];
  const extraReached: Reached[] = [];
  const byCode = new Map<string, Reached>();
  let origin: Reached | undefined;
  json.stations.forEach((index, i) => {
    const station = network.stations[index];
    if (!station?.code) return;
    const seconds = json.seconds[i] ?? 0;
    const item: Reached = { index, code: station.code, name: cleanName(station.name), lon: station.lon, lat: station.lat, seconds, transfers: json.transfers[i] ?? 0, band: bandOf(seconds) };
    byCode.set(item.code, item);
    if (index === json.origin) origin = item;
    else reached.push(item);
  });
  if (extras) {
    json.extraStops.forEach((index, i) => {
      const name = extras.names[index];
      if (name === undefined) return;
      const seconds = json.extraSeconds[i] ?? 0;
      const item: Reached = {
        index,
        code: `x${index}`,
        kind: (extras.kinds[extras.kind[index] ?? 0] ?? 'car') as StopKind,
        name,
        lon: extras.lon[index] ?? 0,
        lat: extras.lat[index] ?? 0,
        seconds,
        transfers: json.extraTransfers[i] ?? 0,
        band: bandOf(seconds),
      };
      byCode.set(item.code, item);
      extraReached.push(item);
    });
  }
  const grid = buildGrid(origin ? [origin, ...reached, ...extraReached] : [...reached, ...extraReached], maxMinutes * 60);
  // « Multimodal » : on a demandé plus que des trains et le serveur l'a fait (il charge les cars et Île-de-France en tâche de fond).
  const multimodal = json.extras !== null;
  return { query, network, extras, origin, reached, extraReached, byCode, multimodal, realtime: json.realtime, population: json.population ?? undefined, grid };
}

// --- La zone lisse : transformée de distance sur une grille ---

const mercatorX = (lon: number) => (lon * Math.PI * EARTH_R) / 180;
const mercatorY = (lat: number) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const lonFromX = (x: number) => (x / EARTH_R) * (180 / Math.PI);
const latFromY = (y: number) => (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) * (180 / Math.PI);

/** Vitesse et rayon d'accès autour d'un arrêt atteint : voir `ACCESS`. */
function accessOf(s: Reached) {
  if (!s.kind) return ACCESS.rail;
  return s.kind === 'car' ? ACCESS.car : ACCESS.idf;
}

/**
 * Pour chaque case : min sur les gares de (temps pour atteindre la gare + distance / vitesse d'accès).
 * Chaque gare ne remplit que le disque où il reste du temps (durée maximale moins son temps), donc le
 * coût est de l'ordre du nombre de gares × la surface d'un disque, quelques millions d'opérations.
 */
function buildGrid(stations: readonly Reached[], maxSeconds: number): Grid | undefined {
  if (stations.length === 0) return undefined;
  // Rayon au sol de chaque arrêt, et son équivalent en Mercator (qui agrandit les distances de 1 / cos(latitude)).
  const items = stations
    .filter((s) => s.seconds < maxSeconds)
    .map((s) => {
      const stretch = 1 / Math.cos((s.lat * Math.PI) / 180);
      const access = accessOf(s);
      const speed = (access.speedKmh * 1000) / 3600; // m/s
      return { s, x: mercatorX(s.lon), y: mercatorY(s.lat), stretch, speed, radius: Math.min((maxSeconds - s.seconds) * speed, access.maxKm * 1000) };
    });
  if (items.length === 0) return undefined;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const { x, y, stretch, radius } of items) {
    west = Math.min(west, x - radius * stretch);
    east = Math.max(east, x + radius * stretch);
    south = Math.min(south, y - radius * stretch);
    north = Math.max(north, y + radius * stretch);
  }
  // Pas plus de 85° de latitude (limite de Mercator), et une grille de taille raisonnable.
  const limit = mercatorY(84);
  south = Math.max(south, -limit);
  north = Math.min(north, limit);
  const cell = Math.max(MIN_CELL_M, Math.max(east - west, north - south) / MAX_GRID);
  const width = Math.ceil((east - west) / cell);
  const height = Math.ceil((north - south) / cell);
  const seconds = new Float32Array(width * height).fill(Infinity);

  for (const { s, x, y, stretch, speed, radius } of items) {
    const reach = radius * stretch; // rayon en mètres Mercator
    const col0 = Math.max(0, Math.floor((x - reach - west) / cell));
    const col1 = Math.min(width - 1, Math.ceil((x + reach - west) / cell));
    const row0 = Math.max(0, Math.floor((north - (y + reach)) / cell));
    const row1 = Math.min(height - 1, Math.ceil((north - (y - reach)) / cell));
    for (let row = row0; row <= row1; row++) {
      const dy = north - (row + 0.5) * cell - y;
      for (let col = col0; col <= col1; col++) {
        const dx = west + (col + 0.5) * cell - x;
        const total = s.seconds + (Math.hypot(dx, dy) / stretch) / speed;
        const at = row * width + col;
        if (total < seconds[at]!) seconds[at] = total;
      }
    }
  }
  return { west, south, cell, width, height, seconds };
}

/** Colorie la grille : une couleur par tranche, un liseré plus sombre entre deux tranches. */
function paintGrid(grid: Grid, maxSeconds: number, night: number): { url: string; coordinates: Coordinates } | undefined {
  const canvas = document.createElement('canvas');
  canvas.width = grid.width;
  canvas.height = grid.height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const image = context.createImageData(grid.width, grid.height);
  const alpha = Math.round(255 * (AREA_ALPHA_DAY + (AREA_ALPHA_NIGHT - AREA_ALPHA_DAY) * night));
  const colors = DAY_RAMP.map((_, band) => bandColor(band, night));
  const bandAt = (col: number, row: number): number => {
    if (col >= grid.width || row >= grid.height) return -1;
    const value = grid.seconds[row * grid.width + col]!;
    return value <= maxSeconds ? bandOf(value) : -1;
  };
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const band = bandAt(col, row);
      if (band < 0) continue;
      let [r, g, b] = colors[band]!;
      // Bord entre deux tranches : un trait plus sombre le jour, plus clair la nuit (celui qui se voit sur le fond).
      if (bandAt(col + 1, row) > band || bandAt(col, row + 1) > band || bandAt(col + 1, row) === -1 || bandAt(col, row + 1) === -1) {
        const k = night > 0.5 ? 1.25 : 0.72;
        r = Math.min(255, r * k);
        g = Math.min(255, g * k);
        b = Math.min(255, b * k);
      }
      const at = (row * grid.width + col) * 4;
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = alpha;
    }
  }
  context.putImageData(image, 0, 0);
  const east = grid.west + grid.width * grid.cell;
  const north = grid.south + grid.height * grid.cell;
  const [w, e, s, n] = [lonFromX(grid.west), lonFromX(east), latFromY(grid.south), latFromY(north)];
  return {
    url: canvas.toDataURL('image/png'),
    coordinates: [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ],
  };
}

// --- Mise en forme ---

/** « Paris Gare de Lyon Hall 1 - 2 » → « Paris Gare de Lyon » : les halls sont des détails de quai. */
const cleanName = (name: string) => name.replace(/ Hall \d.*$/, '');

/** « 45 min », « 3 h 05 ». */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

const hhmm = (seconds: number) => formatTime(seconds * 1000);

/** Durée maximale réglée, en clair : « 45 min », « 3 h », « 3 h 15 ». */
function limitLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** « 1,2 million d’habitants », « 227 000 habitants » : arrondi à ce que le calcul permet de dire (carreaux de 200 m, marche à vol d'oiseau). */
export function formatInhabitants(n: number): string {
  if (n >= 1e6) {
    const millions = n / 1e6;
    const text = millions.toLocaleString('fr-FR', { maximumFractionDigits: millions >= 10 ? 0 : 1 });
    return `${text} million${millions >= 2 ? 's' : ''} d’habitants`;
  }
  const rounded = n >= 10_000 ? Math.round(n / 1000) * 1000 : Math.round(n / 100) * 100;
  return `${rounded.toLocaleString('fr-FR')} habitant${rounded >= 2 ? 's' : ''}`;
}

/** Habitants atteints par tranche de temps de trajet, en chiffres simples : « 1 h à 1 h 30 : 125 000 · cumul 353 000 ». */
function populationFields(population: NonNullable<IsochroneData['population']>): Array<[string, string]> {
  const step = population.bandMinutes;
  let cumulative = 0;
  const round = (n: number) => (Math.round(n / (n >= 10_000 ? 1000 : 100)) * (n >= 10_000 ? 1000 : 100)).toLocaleString('fr-FR');
  return population.bands.map((count, i): [string, string] => {
    cumulative += count;
    const label = i === 0 ? `Moins de ${limitLabel(step)}` : `${limitLabel(i * step)} à ${limitLabel((i + 1) * step)}`;
    return [label, `${round(count)} · cumul ${round(cumulative)}`];
  });
}

/** Dimanche de Pâques (algorithme de Meeus), pour les fériés mobiles. */
function easter(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

/**
 * Jour à service réduit pour un départ (secondes UTC) : jour férié en France ou dimanche. Les trains
 * y sont deux fois moins nombreux (le 11 novembre 2026 : 5 900 courses contre 11 000 un jeudi),
 * ce qui change beaucoup la zone atteinte : on le dit plutôt que de laisser croire à un manque de données.
 */
function reducedServiceDay(departure: number): string | null {
  const date = new Date(departure * 1000);
  const y = date.getFullYear();
  const key = `${date.getMonth() + 1}-${date.getDate()}`;
  const fixed: Record<string, string> = {
    '1-1': 'Jour de l’an', '5-1': 'Fête du travail', '5-8': 'Victoire 1945', '7-14': 'Fête nationale',
    '8-15': 'Assomption', '11-1': 'Toussaint', '11-11': 'Armistice', '12-25': 'Noël',
  };
  if (fixed[key]) return `${fixed[key]}, jour férié`;
  const e = easter(y);
  const shifted = (days: number) => new Date(y, e.getMonth(), e.getDate() + days);
  for (const [days, name] of [[1, 'Lundi de Pâques'], [39, 'Ascension'], [50, 'Lundi de Pentecôte']] as const) {
    const d = shifted(days);
    if (d.getMonth() === date.getMonth() && d.getDate() === date.getDate()) return `${name}, jour férié`;
  }
  return date.getDay() === 0 ? 'Dimanche' : null;
}

/** Bornes et pas du curseur de durée (minutes). */
const DURATION_RANGE = { min: 30, max: 480, step: 15 };

/** Allonge ou raccourcit la durée maximale (depuis la fiche de la gare de départ). */
function nudgeDuration(current: number, delta: number): void {
  const next = Math.min(DURATION_RANGE.max, Math.max(DURATION_RANGE.min, current + delta));
  if (next !== current) ModuleManager.current?.setSetting(MODULE_ID, 'duree', String(next));
}

const CATEGORY_NAMES: Record<string, string> = {
  'Train TER': 'TER',
  INTERCITES: 'Intercités',
  'INTERCITES de nuit': 'Intercités de nuit',
  TramTrain: 'Tram-train',
};

// --- Itinéraires (chargés à la demande, pour la gare ou l'arrêt dont on ouvre la fiche) ---

type JourneyState = ApiJourney | 'chargement' | 'erreur';
const journeys = new Map<string, JourneyState>();

function journeyOf(data: IsochroneData, station: Reached): JourneyState {
  const { query } = data;
  const key = `${query.code}|${query.departure}|${query.maxMinutes}|${query.transfers}|${query.modes}|${station.code}|${data.network?.version}|${data.extras?.version}`;
  const known = journeys.get(key);
  if (known) return known;
  journeys.set(key, 'chargement');
  if (journeys.size > 60) journeys.delete(journeys.keys().next().value as string);
  const limit = query.transfers === 'illimite' ? '' : `&correspondances=${query.transfers}`;
  const url = `/api/isochrone/trajet?depuis=${query.code}&depart=${query.departure}&max=${query.maxMinutes}${limit}&modes=${MODES_PARAM[query.modes]}&vers=${station.code}`;
  fetchJson<ApiJourney>(url, new AbortController().signal).then(
    (journey) => journeys.set(key, journey),
    () => journeys.set(key, 'erreur'),
  ).finally(() => ModuleManager.current?.refresh(MODULE_ID));
  return 'chargement';
}

/** Genre d'un arrêt supplémentaire, pour la fiche. */
const STOP_KIND_NAMES: Record<StopKind, string> = {
  car: 'Arrêt de car',
  metro: 'Station de métro',
  rer: 'Station de RER',
  transilien: 'Gare Transilien',
  tram: 'Arrêt de tramway',
};

function journeyTable(data: IsochroneData, state: JourneyState): InfoTable {
  const empty = state === 'erreur' ? 'Itinéraire indisponible.' : 'Calcul de l’itinéraire…';
  const stations = data.network?.stations ?? [];
  const rows: InfoTable['rows'] = [];
  if (state !== 'chargement' && state !== 'erreur') {
    // Les indices au-delà du nombre de gares sont des arrêts supplémentaires.
    const name = (index: number) =>
      index < state.stationCount ? cleanName(stations[index]?.name ?? '?') : (data.extras?.names[index - state.stationCount] ?? '?');
    const both = (leg: ApiLeg) => `${name(leg.from)} → ${name(leg.to)}`;
    state.legs.forEach((leg, i) => {
      const previous = state.legs[i - 1];
      if (previous && leg.departure - previous.arrival >= 60) {
        rows.push({ cells: ['', `Correspondance à ${name(leg.from)} · ${Math.round((leg.departure - previous.arrival) / 60)} min d’attente`, ''], tone: 'muted' });
      }
      if (leg.type === 'train') {
        const category = CATEGORY_NAMES[leg.category] ?? leg.category;
        rows.push({ cells: [hhmm(leg.departure), `${category} ${leg.number} · ${both(leg)}`, hhmm(leg.arrival)] });
      } else if (leg.type === 'transit') {
        // « Car BreizhGo 7 » ou « RER B » en pastille aux couleurs officielles, puis la destination et le parcours.
        // Les RER et Transilien n'ont souvent pour destination qu'un code de mission (« ZVAL ») : on le tait.
        const towards = leg.headsign && !/^[A-Z0-9]{3,5}$/.test(leg.headsign) ? `vers ${leg.headsign} · ` : '';
        rows.push({
          cells: [hhmm(leg.departure), `${towards}${both(leg)}`, hhmm(leg.arrival)],
          badge: { text: leg.label, color: leg.color ?? undefined, textColor: leg.textColor ?? undefined },
        });
      } else {
        const railToRail = leg.from < state.stationCount && leg.to < state.stationCount;
        const how = railToRail && leg.arrival - leg.departure >= 15 * 60 ? 'à pied ou en métro' : 'à pied';
        rows.push({ cells: [hhmm(leg.departure), `Changement (${how}) · ${both(leg)}`, hhmm(leg.arrival)], tone: 'muted' });
      }
    });
  }
  return { title: 'Itinéraire', columns: ['Départ', 'Étape', 'Arrivée'], rows, empty };
}

function describeReached(data: IsochroneData, station: Reached, time: number): InfoContent {
  const origin = data.origin;
  const journey = journeyOf(data, station);
  const realtime = data.realtime && isLiveTime(time);
  const arrival = data.query.departure + station.seconds;
  // Le temps compté depuis l'heure de la frise inclut l'attente du premier départ : une fois
  // l'itinéraire connu, on montre le temps passé en transport et l'attente à part.
  const legs = journey !== 'chargement' && journey !== 'erreur' ? journey.legs : undefined;
  const firstDeparture = legs?.[0]?.departure;
  const wait = firstDeparture === undefined ? 0 : firstDeparture - data.query.departure;
  const onTrain = legs?.every((leg) => leg.type !== 'transit') ?? true;
  const fields: Array<[string, string]> =
    firstDeparture !== undefined && wait >= 5 * 60 ? [[onTrain ? 'Attente du premier train' : 'Attente du premier départ', `${formatDuration(wait)} (départ à ${hhmm(firstDeparture)})`]] : [];
  const extra = station.kind !== undefined;
  return {
    kind: extra ? `${STOP_KIND_NAMES[station.kind!]} · isochrone` : 'Gare · isochrone',
    title: station.name,
    subtitle: origin ? `depuis ${origin.name}, en partant à ${hhmm(data.query.departure)}` : undefined,
    status: realtime ? { tone: 'live', text: 'Retards en direct pris en compte' } : { tone: 'scheduled', text: 'Horaires théoriques' },
    fields,
    figures: [
      firstDeparture !== undefined
        ? { value: formatDuration(arrival - firstDeparture), label: onTrain ? 'en train' : 'en transport' }
        : { value: formatDuration(station.seconds), label: `depuis ${hhmm(data.query.departure)}` },
      { value: String(station.transfers), label: station.transfers > 1 ? 'correspondances' : 'correspondance' },
      { value: hhmm(arrival), label: 'arrivée' },
    ],
    tables: [journeyTable(data, journey)],
    note: noteFor(data.query.modes),
    // On ne part que d'une gare du réseau ferré : c'est ce que l'API accepte comme origine.
    actions: extra ? undefined : [{ label: 'Partir d’ici', onClick: () => setIsochroneOrigin(station.code, station) }],
  };
}

/** Ce que le calcul prend en compte, selon le réglage des modes (pour le bas des fiches). */
function noteFor(modes: string): string {
  const change = 'Les correspondances comptent 4 à 8 min au minimum (selon le mode), et les arrêts voisins sont reliés à pied.';
  if (modes === 'trains') {
    return `Meilleur trajet de la journée en train (TGV, Intercités, TER). ${change} Les gares parisiennes sont reliées par le métro ou le RER (20 à 45 min).`;
  }
  if (modes === 'cars') return `Meilleur trajet de la journée en train (TGV, Intercités, TER) et en car (cars TER et réseaux régionaux). ${change}`;
  return `Meilleur trajet de la journée en train, en car (cars TER et réseaux régionaux) et dans les transports d’Île-de-France (métro, RER, Transilien, tramway). ${change}`;
}

function describeOrigin(data: IsochroneData): InfoContent | null {
  const origin = data.origin;
  if (!origin) return null;
  const inside = data.reached.length;
  const stops = data.extraReached.length;
  const subject = data.query.modes === 'trains' ? 'en train' : 'en transports';
  return {
    kind: 'Gare de départ',
    title: origin.name,
    subtitle: `jusqu’où ${subject}, en partant à ${hhmm(data.query.departure)}`,
    status: plainStatus(`${limitLabel(data.query.maxMinutes)} au plus, ${data.query.transfers === 'illimite' ? 'correspondances libres' : `${data.query.transfers} correspondance${data.query.transfers === '1' ? '' : 's'} au plus`}`),
    figures: [
      { value: String(inside), label: 'gares atteintes' },
      ...(stops > 0 ? [{ value: stops.toLocaleString('fr-FR'), label: 'arrêts de car, métro…' }] : []),
      { value: formatDuration(Math.max(0, ...data.reached.map((s) => s.seconds), ...data.extraReached.map((s) => s.seconds))), label: 'la plus lointaine' },
    ],
    fields: data.population ? populationFields(data.population) : undefined,
    note: [
      reducedServiceDay(data.query.departure) &&
        `${reducedServiceDay(data.query.departure)} : service réduit, environ deux fois moins de trains qu’un jour de semaine.`,
      data.population &&
        'Habitants : carreaux de 200 m (INSEE) à portée à pied d’un arrêt atteint dans la durée demandée (4,5 km/h, détour de 30 %, 1,2 km d’une gare, 1 km d’un car ou métro). Sans bus urbains ni vélo : un minimum.',
      'L’heure de départ est celle de la frise : faites-la glisser pour voir la zone changer. La zone colorée étend chaque gare atteinte jusqu’à 30 km autour d’elle à 15 km/h (route ou vélo), chaque arrêt de car jusqu’à 15 km, et chaque station de métro ou de RER jusqu’à 2 km à pied.',
    ]
      .filter(Boolean)
      .join(' '),
    // La durée se règle aussi d'ici, là où l'on regarde (le curseur complet est dans les réglages de la couche).
    actions: [
      { label: '− 30 min', onClick: () => nudgeDuration(data.query.maxMinutes, -30) },
      { label: '+ 30 min', onClick: () => nudgeDuration(data.query.maxMinutes, 30) },
      { label: 'Effacer', onClick: () => clearOrigin() },
    ],
  };
}

function clearOrigin(): void {
  originCode = null;
  ModuleManager.current?.setSelection(null, null);
}

// --- Carte : couche native de la zone ---

const AREA_SOURCE = 'isochrones-zone';
const AREA_LAYER = 'isochrones-zone';
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WORLD_CORNERS: Coordinates = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
];

let mapRef: MapLibreMap | undefined;

function showArea(map: MapLibreMap, data: IsochroneData | undefined, night: number, visible: boolean): void {
  const source = map.getSource(AREA_SOURCE) as ImageSource | undefined;
  if (!source) return;
  if (!data?.grid || !visible) {
    if (map.getLayer(AREA_LAYER)) map.setPaintProperty(AREA_LAYER, 'raster-opacity', 0);
    return;
  }
  // Une image par version de données et par huitième de nuit (la palette change avec le fond).
  if (data.rendered?.night !== night) {
    const painted = paintGrid(data.grid, data.query.maxMinutes * 60, night);
    if (!painted) return;
    data.rendered = { night, ...painted };
    source.updateImage({ url: painted.url, coordinates: painted.coordinates });
  }
  map.setPaintProperty(AREA_LAYER, 'raster-opacity', 1);
}

/** Étiquettes désencombrées (recalculées par demi-niveau de zoom et à chaque nouveau calcul). */
let labelCache: { data: IsochroneData; band: number; extras: boolean; bounds: string; labelled: Reached[]; extraLabelled: Reached[] } | undefined;

function labelsFor(data: IsochroneData, zoom: number, showExtras: boolean): { labelled: Reached[]; extraLabelled: Reached[] } {
  if (zoom < 7) return { labelled: [], extraLabelled: [] };
  const band = zoomBand(zoom);
  const extras = showExtras && zoom >= EXTRA_LABEL_ZOOM;
  const b = mapRef?.getBounds();
  const bounds = b ? [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((v) => v.toFixed(2)).join() : '';
  if (labelCache && labelCache.data === data && labelCache.band === band && labelCache.extras === extras && labelCache.bounds === bounds) return labelCache;
  const origin = data.origin!;
  const candidates = [origin, ...data.reached.filter((s) => inView(mapRef, s)), ...(extras ? data.extraReached.filter((s) => inView(mapRef, s)) : [])];
  // Les gares n'ont pas de `kind` ; les arrêts de cars et d'Île-de-France en ont un.
  const isExtra = (s: Reached) => s.kind !== undefined;
  const kept = declutter(candidates, zoom, {
    lon: (s) => s.lon,
    lat: (s) => s.lat,
    rank: (s) => (s === origin ? -1 : (isExtra(s) ? 1e7 : 0) + s.seconds),
    box: LABEL_BOX_PX,
  }).filter((s) => s !== origin);
  labelCache = {
    data,
    band,
    extras,
    bounds,
    labelled: kept.filter((s) => !isExtra(s)).slice(0, 150),
    extraLabelled: kept.filter(isExtra).slice(0, 120),
  };
  return labelCache;
}

/** Place d'une étiquette « Nom · 1 h 08 » à l'écran, avec un peu d'air (pixels). */
const LABEL_BOX_PX = { width: 150, height: 26 };

/** Dernière image posée sur la source : pour ne la remettre que si les données ont changé. */
let shownData: IsochroneData | undefined;

// --- Module ---

/** Contour des arrêts supplémentaires selon le mode : car (ambre), métro, RER, tram (bleu). Le remplissage reste la rampe framboise. */
const EXTRA_STROKE: Record<'car' | 'idf', Color> = { car: [255, 196, 64, 255], idf: [96, 176, 255, 255] };
const rgb_css = (c: Color) => `rgb(${c[0]},${c[1]},${c[2]})`;
/** Les arrêts supplémentaires n'apparaissent qu'à partir de ce zoom, et leur nom de plus près encore. */
const EXTRA_MIN_ZOOM = 6.5;
const EXTRA_LABEL_ZOOM = 9.5;

const labelFont = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function inView(map: MapLibreMap | undefined, station: Reached): boolean {
  if (!map) return true;
  const b = map.getBounds();
  return station.lon >= b.getWest() && station.lon <= b.getEast() && station.lat >= b.getSouth() && station.lat <= b.getNorth();
}

export const isochrones = defineModule<IsochroneData>({
  id: MODULE_ID,
  name: 'Isochrones',
  category: 'transport',
  description: 'Jusqu’où peut-on aller en train, en car et en métro depuis une gare, en partant à l’heure de la frise ?',
  attribution:
    'SNCF (horaires, cars TER et temps réel) — ODbL ; Île-de-France Mobilités (métro, RER, Transilien, tramway) — ODbL ; cars interurbains des régions et départements (transport.data.gouv.fr) — licences ouvertes de chaque réseau ; calcul RAPTOR sur le serveur',
  // Au-dessus des trains : les gares atteintes doivent rester cliquables ; la zone, elle, est une couche de fond.
  drawOrder: 2,
  timeStepMs: 3_600_000, // le calcul ne dépend pas de l'instant à chaque image : voir `needsReload`
  followsView: true,
  // Seuils des repères (5, 6,5, 9,5), puis chaque demi-niveau pour le désencombrement des étiquettes.
  zoomBreaks: [5, 6.5, ...halfZoomBreaks(7, 16)],

  urlState: {
    param: 'depuis',
    read: () => originCode,
    write: (value) => {
      originCode = value;
    },
  },

  settings: [
    {
      id: 'duree',
      label: 'Durée maximale',
      // Curseur au quart d'heure, de 30 min à 8 h ; les valeurs rondes servent à la recherche.
      range: { ...DURATION_RANGE, format: limitLabel },
      options: [
        { value: '120', label: '2 h' },
        { value: '180', label: '3 h' },
        { value: '240', label: '4 h' },
        { value: '360', label: '6 h' },
      ],
      defaultValue: '180',
    },
    {
      id: 'correspondances',
      label: 'Correspondances',
      options: [
        { value: '0', label: 'Aucune' },
        { value: '1', label: '1 au plus' },
        { value: '2', label: '2 au plus' },
        { value: 'illimite', label: 'Sans limite' },
      ],
      defaultValue: '2',
    },
    {
      id: 'modes',
      label: 'Transports pris en compte',
      options: [
        { value: 'trains', label: 'Trains seulement' },
        { value: 'cars', label: 'Trains et cars' },
        { value: 'tout', label: 'Tous les transports (Île-de-France comprise)' },
      ],
      defaultValue: 'tout',
    },
    {
      id: 'affichage',
      label: 'Affichage',
      options: [
        { value: 'zone', label: 'Zone et gares' },
        { value: 'gares', label: 'Gares seulement' },
      ],
      defaultValue: 'zone',
    },
  ],

  legend(settings) {
    const max = maxMinutesOf(settings) * 60;
    const night = currentNight();
    const bands = BAND_LABELS.map((label, band) => ({ color: `rgb(${bandColor(band, night).join(',')})`, label, band }))
      .filter(({ band }) => band * BAND_S < max)
      .map(({ color, label }) => ({ color, label }));
    // Le contour des petits ronds dit le mode des arrêts qui ne sont pas des gares.
    const modes = modesOf(settings);
    if (modes !== 'trains') bands.push({ color: rgb_css(EXTRA_STROKE.car), label: 'Arrêt de car (contour)' });
    if (modes === 'tout') bands.push({ color: rgb_css(EXTRA_STROKE.idf), label: 'Métro, RER, tram (contour)' });
    return bands;
  },

  load: ({ signal, time, settings }) => loadIsochrone(signal, time, settings),

  needsReload(data, time, settings) {
    const { query } = data;
    if (query.code !== originCode) return true;
    if (!originCode) return false;
    if (query.maxMinutes !== maxMinutesOf(settings) || query.transfers !== (settings.correspondances ?? '2') || query.modes !== modesOf(settings)) return true;
    // Cars et Île-de-France se chargent en tâche de fond : on refait le calcul quand ils arrivent (une fois, au retour du serveur).
    if (!data.multimodal && query.modes !== 'trains' && Date.now() - lastMultimodalCheck > 30_000) {
      lastMultimodalCheck = Date.now();
      return true;
    }
    return Math.abs(time / 1000 - query.departure) >= REQUERY_S;
  },

  summary({ data }) {
    if (!originCode) return 'Cliquez une gare, puis « Jusqu’où en train ? », ou cherchez « depuis Rennes »';
    if (!data?.origin || data.query.code !== originCode) return 'calcul en cours…';
    const n = data.reached.length;
    const stops = data.extraReached.length;
    const limit = limitLabel(data.query.maxMinutes);
    const reduced = reducedServiceDay(data.query.departure);
    const warning = reduced ? ` · ${reduced} : moins de trains` : '';
    const more = stops > 0 ? ` et ${stops.toLocaleString('fr-FR')} arrêt${stops > 1 ? 's' : ''}` : '';
    const loading = !data.multimodal && data.query.modes !== 'trains' ? ' · cars et Île-de-France en cours de chargement' : '';
    const people = data.population ? ` · ${formatInhabitants(data.population.total)} à moins de ${limit}` : '';
    return `Depuis ${data.origin.name} à ${hhmm(data.query.departure)} : ${n.toLocaleString('fr-FR')} gare${n > 1 ? 's' : ''}${more} en moins de ${limit}${people}${warning}${loading}`;
  },

  native: {
    add(map) {
      mapRef = map;
      shownData = undefined;
      map.addSource(AREA_SOURCE, { type: 'image', url: BLANK, coordinates: WORLD_CORNERS });
      map.addLayer(
        {
          id: AREA_LAYER,
          type: 'raster',
          source: AREA_SOURCE,
          paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        },
        firstSymbolLayerId(map),
      );
    },
    update(map, { data, night, settings }) {
      const wanted = data && data.query.code === originCode ? data : undefined;
      if (wanted !== shownData) {
        shownData = wanted;
        if (wanted) wanted.rendered = undefined; // forcer la pose de l'image
      }
      showArea(map, wanted, Math.round(night * 8) / 8, settings.affichage !== 'gares');
    },
    remove(map) {
      if (map.getLayer(AREA_LAYER)) map.removeLayer(AREA_LAYER);
      if (map.getSource(AREA_SOURCE)) map.removeSource(AREA_SOURCE);
      mapRef = undefined;
      shownData = undefined;
    },
  },

  deckLayers({ data, view, night, selection }) {
    if (!data || data.query.code !== originCode || !data.origin) return [];
    const choice = selection as IsoSelection | null;
    const chosen = choice?.type === 'gare' ? data.byCode.get(choice.code) : undefined;
    const parameters = OVER_MAP;
    const radius = zoomRamp(view.zoom, 4, 9, 2.4, 6);
    const position = (s: Reached): [number, number, number] => [s.lon, s.lat, 0];
    const color = (s: Reached): Color => [...bandColor(s.band, night), 255];
    const origin = data.origin;
    // Les arrêts de cars et de métro : plus petits que les gares, cernés selon le mode, et nommés de près seulement.
    const showExtras = data.extraReached.length > 0 && view.zoom >= EXTRA_MIN_ZOOM;
    const extraRadius = radius * 0.68;
    const extraStroke = (s: Reached): Color => (s.kind === 'car' ? EXTRA_STROKE.car : EXTRA_STROKE.idf);
    // Les durées s'écrivent à côté des points quand on est assez près, sans se chevaucher : une
    // étiquette par case, la gare de départ d'abord (elle a la sienne), puis les gares, puis les
    // arrêts de cars et de métro, et dans chaque groupe la plus proche en temps.
    const { labelled, extraLabelled } = labelsFor(data, view.zoom, showExtras);

    return [
      showExtras &&
        new ScatterplotLayer<Reached>({
          id: 'isochrones/arrets',
          data: data.extraReached,
          getPosition: position,
          radiusUnits: 'pixels',
          getRadius: extraRadius,
          getFillColor: color,
          stroked: true,
          getLineColor: extraStroke,
          lineWidthUnits: 'pixels',
          getLineWidth: view.zoom < 9 ? 1.2 : 1.8,
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 140],
          updateTriggers: { getRadius: extraRadius, getFillColor: night, getLineWidth: view.zoom < 9 },
          parameters,
        }),
      showExtras &&
        extraLabelled.length > 0 &&
        new TextLayer<Reached>({
          id: 'isochrones/arrets-noms',
          data: extraLabelled,
          getPosition: position,
          getText: (s) => `${s.name} · ${formatDuration(s.seconds)}`,
          characterSet: 'auto',
          fontFamily: labelFont,
          fontWeight: 500,
          getSize: 10.5,
          getColor: [255, 255, 255],
          getPixelOffset: [0, -11],
          background: true,
          getBackgroundColor: [15, 18, 26, 205],
          backgroundPadding: [3, 2],
          billboard: true,
          parameters,
        }),
      new ScatterplotLayer<Reached>({
        id: 'isochrones/gares-halo',
        data: data.reached,
        getPosition: position,
        radiusUnits: 'pixels',
        getRadius: radius + 2.5,
        getFillColor: HALO,
        billboard: true,
        updateTriggers: { getRadius: radius },
        parameters,
      }),
      new ScatterplotLayer<Reached>({
        id: 'isochrones/gares',
        data: data.reached,
        getPosition: position,
        radiusUnits: 'pixels',
        getRadius: radius,
        getFillColor: color,
        stroked: true,
        getLineColor: KEY,
        lineWidthUnits: 'pixels',
        getLineWidth: view.zoom < 7 ? 1 : 1.5,
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        updateTriggers: { getRadius: radius, getFillColor: night, getLineWidth: view.zoom < 7 },
        parameters,
      }),
      view.zoom >= 7 &&
        new TextLayer<Reached>({
          id: 'isochrones/durees',
          data: labelled,
          getPosition: position,
          getText: (s) => `${s.name} · ${formatDuration(s.seconds)}`,
          characterSet: 'auto',
          fontFamily: labelFont,
          fontWeight: 600,
          getSize: 11.5,
          getColor: [255, 255, 255],
          getPixelOffset: [0, -14],
          background: true,
          getBackgroundColor: [15, 18, 26, 215],
          backgroundPadding: [4, 2],
          billboard: true,
          parameters,
        }),
      chosen && selectionRing('isochrones/choisie', [chosen], position, radius + 5, parameters),
      // La gare de départ : un grand repère blanc cerné de sombre, avec un point au centre.
      new ScatterplotLayer<Reached>({
        id: 'isochrones/origine-halo',
        data: [origin],
        getPosition: position,
        radiusUnits: 'pixels',
        getRadius: 14,
        getFillColor: HALO,
        billboard: true,
        parameters,
      }),
      new ScatterplotLayer<Reached>({
        id: 'isochrones/origine',
        data: [origin],
        getPosition: position,
        radiusUnits: 'pixels',
        getRadius: 10.5,
        getFillColor: [255, 255, 255],
        stroked: true,
        getLineColor: KEY,
        lineWidthUnits: 'pixels',
        getLineWidth: 3,
        billboard: true,
        pickable: true,
        parameters,
      }),
      new ScatterplotLayer<Reached>({
        id: 'isochrones/origine-centre',
        data: [origin],
        getPosition: position,
        radiusUnits: 'pixels',
        getRadius: 4.5,
        getFillColor: KEY,
        billboard: true,
        parameters,
      }),
      new TextLayer<Reached>({
        id: 'isochrones/origine-nom',
        data: [origin],
        getPosition: position,
        getText: (s) => `Départ · ${s.name}`,
        characterSet: 'auto',
        fontFamily: labelFont,
        fontWeight: 700,
        getSize: 13,
        getColor: [255, 255, 255],
        getPixelOffset: [0, -26],
        background: true,
        getBackgroundColor: [15, 18, 26, 235],
        backgroundPadding: [6, 3],
        billboard: true,
        parameters,
      }),
    ];
  },

  select(object) {
    const picked = object as Partial<Reached>;
    if (typeof picked.code !== 'string') return null;
    return picked.code === originCode ? ({ type: 'origine' } satisfies IsoSelection) : ({ type: 'gare', code: picked.code } satisfies IsoSelection);
  },

  describe(selection, { data, time }) {
    if (!data || data.query.code !== originCode) return null;
    const choice = selection as IsoSelection | null;
    if (choice?.type === 'origine') return describeOrigin(data);
    const station = choice?.type === 'gare' ? data.byCode.get(choice.code) : undefined;
    return station ? describeReached(data, station, time) : null;
  },
});
