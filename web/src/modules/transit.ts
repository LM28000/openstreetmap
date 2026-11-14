/**
 * Module « Bus, trams et métros » : les véhicules des transports urbains en temps réel, partout
 * en France où le réseau publie ses positions (flux GTFS-RT sur transport.data.gouv.fr).
 *
 * Le serveur (server/src/transit.rs) relit les flux de tous les réseaux toutes les 30 secondes.
 * Une position est un point de GPS, pas une trajectoire : plutôt que de prolonger la dernière
 * position (un bus qui s'arrête dépasserait son arrêt, un tram qui tourne couperait le virage),
 * le navigateur **interpole** : chaque véhicule glisse de l'endroit où on le voyait vers sa
 * nouvelle position, en autant de temps que les deux mesures sont espacées. Le prix est un léger
 * retard (au plus une collecte) ; le gain, un mouvement qui suit toujours une trajectoire réelle,
 * sans saut ni dépassement.
 *
 * Deux échelles de lecture, parce que des milliers de véhicules sur une carte de France sont du bruit :
 * - **de loin** (sous le zoom 9) : un rond par réseau, placé au centre de ses véhicules, de surface
 *   proportionnelle à leur nombre, avec le nom des plus gros. On voit où la couche existe et sa densité ;
 * - **de près** (dès le zoom 9) : chaque véhicule, avec le nom court de sa ligne dès le zoom 13.
 *
 * Couleurs : la couleur officielle de la ligne quand le réseau la donne, sinon une couleur par mode
 * (rose, bleu-vert, or : voir MODE_COLORS). La couleur ne distingue jamais les modes à elle seule :
 * c'est la silhouette vue de dessus (bus, rame de tram, voitures de métro), orientée selon le cap, à sa
 * longueur réelle de près et à une taille minimale de loin ; un contour clair ou sombre, selon la
 * luminance de la couleur, garde chaque couleur lisible.
 *
 * **Positions estimées.** Plusieurs grandes villes (Lille, Toulouse, Nantes, Reims, Nancy…) ne publient pas la position
 * de leurs véhicules, mais leurs horaires en temps réel. Le serveur (server/src/estimates.rs) en déduit où ils sont :
 * sur le tracé de la ligne, d'après l'heure prévue à chaque arrêt corrigée du retard annoncé. Ces véhicules s'affichent
 * comme les autres, avec un **contour pointillé**. Au lieu d'une position à rattraper en glissant, le serveur envoie
 * pour chacun sa trajectoire des 64 secondes suivantes (un point toutes les 8 s) : le navigateur y lit la position
 * à l'heure de son horloge. Le mouvement est ainsi continu et sans retard, même si la réponse a une trentaine de
 * secondes. Une position mesurée, elle, ne dit rien de l'avenir : d'où le glissement ci-dessus, avec son léger retard.
 *
 * **Relecture.** Le serveur enregistre les positions qu'il sert, mesurées comme estimées (server/src/history/). Quand
 * l'horloge est à plus de deux minutes dans le passé, la couche relit l'enregistrement (core/replay.ts) : chaque
 * véhicule est placé par interpolation entre ses deux positions enregistrées voisines. Une position estimée reste
 * marquée comme telle (contour pointillé, fiche), avec le prochain arrêt et le retard connus à ce moment-là. Là où rien
 * n'a été enregistré, la couche se masque et dit pourquoi.
 */
import { TRANSIT } from '../design/tokens';
import type { Color } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule, type InfoContent, type InfoFigure, type InfoStatus, type LegendItem } from '../core/module';
import { estimatedStatus, measuredStatus } from '../core/infoStatus';
import {
  isReplayTime,
  loadReplay,
  measure,
  measureAngle,
  newSample,
  prefetchNear,
  replayKey,
  replayLabel,
  sample,
  type DecodedChunk,
} from '../core/replay';
import { declutter, halfZoomBreaks } from '../map/declutter';
import {
  CELL_HEIGHT,
  CELL_METERS,
  FOOT_CELL_METERS,
  bubbleIcon,
  buildFootprintAtlas,
  buildTransitAtlas,
  estimatedLegendIcon,
  legendIcon,
  lengthShare,
  lengthUnits,
  KINDS,
  type Kind,
  type TransitAtlas,
} from './transitIcons';
import { OVER_MAP } from '../map/parameters';
import { meshLayer, RENDER_SETTING, wants3d } from '../models/meshLayer';
import { orientation } from '../models/mesh';
import { TRANSIT_LENGTH, transitMeshes } from '../models/transit';

interface ApiLine {
  network: number;
  id?: string;
  name?: string;
  longName?: string;
  color?: string;
  mode?: 'bus' | 'tram' | 'metro' | 'train' | 'ferry' | 'cable';
}

/** Ce que le serveur sait d'une position estimée d'après les horaires (absent : position mesurée). */
interface ApiEstimate {
  /** Vrai : horaire théorique seulement ; faux ou absent : le flux temps réel du réseau annonce cette circulation. */
  theoretical?: boolean;
  to?: string;
  next?: string;
  /** Heure prévue au prochain arrêt (secondes UTC). */
  nextAt?: number;
  /** Retard à ce prochain arrêt (secondes ; négatif : en avance). */
  delay?: number;
  /** Écarts [dlon, dlat, …] en cent-millièmes de degré, un point toutes les `estStep` secondes après (lon, lat). */
  path: number[];
}

interface ApiVehicle {
  id: string;
  line: number;
  lon: number;
  lat: number;
  heading?: number;
  speed?: number;
  ts: number;
  est?: ApiEstimate;
}

interface ApiTransit {
  updatedAt: number;
  estStep?: number;
  networks: Array<{ name: string; licence: string; vehicles: number }>;
  lines: ApiLine[];
  vehicles: ApiVehicle[];
}

export interface Network {
  index: number;
  name: string;
  licence: string;
  count: number;
  /** Dont positions estimées d'après les horaires. */
  estimated: number;
  /** Centre de ses véhicules : où poser le rond de la vue d'ensemble. */
  lon: number;
  lat: number;
  radius: number;
}

export interface Line {
  network: Network;
  id?: string;
  name?: string;
  longName?: string;
  /** Couleur officielle (`#rrggbb`), si le réseau la donne. */
  officialColor?: string;
  mode?: ApiLine['mode'];
  kind: Kind;
}

/** Position estimée : où est le véhicule à chaque instant de la trajectoire envoyée par le serveur. */
interface Estimate {
  theoretical: boolean;
  to?: string;
  next?: string;
  /** Heure prévue au prochain arrêt (ms). */
  nextAt?: number;
  delayS?: number;
  /** Instant (ms) du premier point de la trajectoire et écart (ms) entre deux points. */
  t0: number;
  stepMs: number;
  /** Longitude et latitude de chaque point : [lon0, lat0, lon1, lat1, …]. */
  xy: Float64Array;
  /** Direction (degrés depuis le nord) du segment de trajectoire où se trouve le véhicule ; absente tant qu'il n'a pas bougé. */
  bearing?: number;
}

export interface Vehicle {
  key: string;
  id: string;
  line: Line;
  /** Dernière position reçue (celle que le véhicule rejoint). */
  lon: number;
  lat: number;
  /** D'où il part : là où il était affiché à l'arrivée de cette position. */
  fromLon: number;
  fromLat: number;
  arrivedAt: number;
  spanMs: number;
  headingDeg?: number;
  /** Direction dessinée (degrés depuis le nord) : le cap annoncé, sinon celle du mouvement. */
  bearing: number;
  speedKmh?: number;
  /** Instant de la mesure (ms). */
  ts: number;
  fill: Color;
  halo: Color;
  /** Vrai quand la position est estimée d'après les horaires (la trajectoire est dans `estimate`). */
  estimate?: Estimate;
  /** Position affichée (recalculée à chaque image) : [lon, lat, altitude]. */
  position: [number, number, number];
  settled: boolean;
  groundVersion: number;
  /** Relecture : indice du véhicule dans le tronçon, et s'il existe à l'instant affiché (absent : toujours là). */
  ro?: number;
  here?: boolean;
}

/** Ce qui s'ajoute aux données quand la couche relit l'enregistrement. */
export interface TransitReplay {
  key: string;
  chunk: DecodedChunk | null;
  absence: string | null;
  /** Tous les véhicules et tous les réseaux du tronçon (présents ou non). */
  all: Vehicle[];
  allNetworks: Network[];
  /** Pas de temps de la dernière mise à jour, pour ne pas la refaire à chaque image. */
  stamp: number;
}

export interface TransitData {
  vehicles: Vehicle[];
  byKey: Map<string, Vehicle>;
  networks: Network[];
  lineCount: number;
  collectedAt: number;
  /** Incrémenté quand au moins un véhicule a bougé : déclenche le recalcul des positions par deck.gl. */
  motion: number;
  replay?: TransitReplay;
}

export type TransitSelection = { type: 'vehicle'; key: string } | { type: 'network'; name: string };

/** Sous ce zoom : un rond par réseau. À partir de là : chaque véhicule. */
const VEHICLES_FROM_ZOOM = 9;
/** À partir de ce zoom : le nom court de la ligne à côté de chaque véhicule. */
const LABELS_FROM_ZOOM = 13;
/**
 * Maquettes 3D (réglage « Rendu ») à partir de ce zoom ; en dessous, les silhouettes à plat : au zoom 14
 * un bus de 12 m fait moins de deux pixels : il faudrait l'agrandir de dix fois (une rame de métro de 40 m ferait alors 400 m).
 */
const MESH_FROM_ZOOM = 15;
/** Hauteur (m) de la maquette au-dessus du relief CPU : les roues ne doivent pas s'enfoncer dans le relief rendu (maillage plus grossier). */
const MESH_LIFT_M = 0.7;
/** Position estimée en 3D : la maquette est translucide (alpha sur 255), posée sur une empreinte pointillée. */
const GHOST_ALPHA = 125;
const FOOTPRINT_DAY: Color = [22, 26, 38, 235];
const FOOTPRINT_NIGHT: Color = [255, 255, 255, 235];
/** Les positions sont à 4 m au-dessus du relief (pour les icônes à plat) : la maquette retranche cette hauteur. */
const ICON_LIFT_M = 4;
const LABEL_BOX_PX = { width: 46, height: 24 };
const NETWORK_LABEL_BOX_PX = { width: 120, height: 20 };
const NETWORK_LABEL_FROM_ZOOM = 4.5;

/** Un véhicule glisse vers sa nouvelle position en autant de temps que les deux mesures sont espacées, entre ces bornes. */
const MIN_SPAN_MS = 10_000;
const MAX_SPAN_MS = 40_000;
/** Écart (degrés) au-delà duquel un véhicule a « sauté » (fin de service, retour au dépôt) : on ne l'anime pas. */
const MAX_GLIDE_DEG = 0.03;
/**
 * Déplacement (mètres) en dessous duquel on ne lit plus de direction : une position arrondie à 5 décimales (1 m) ou le
 * bruit d'un GPS à l'arrêt donneraient un cap au hasard.
 */
const MIN_MOVE_M = 6;
/** Une position plus vieille que cela (secondes) est affichée estompée. */
const DIM_AFTER_S = 120;
/** Au-delà de cet écart (ms) entre l'horloge du serveur et celle du navigateur, on ne se fie pas à l'heure du serveur pour lire les trajectoires. */
const MAX_CLOCK_SKEW_MS = 60_000;
/** Un retard de moins que cela (secondes) se dit « à l'heure ». */
const ON_TIME_S = 60;
const STALE_AFTER_S = 120;

/**
 * Couleur par mode quand la ligne n'a pas de couleur officielle : une famille de teinte par mode, évitant
 * celles des trains (bleu, orange, vert) et des avions (violet). Palette validée avec validate_palette.js
 * (`--pairs all`) : mode clair sur le fond de la carte et mode sombre sur le panneau (#0f121a), teintes dans
 * les bandes de luminosité, saturation suffisante, écart normal ≥ 22, écart pour les daltoniens 7,6 (avertissement,
 * admis car la forme porte aussi le mode) ; contraste ≥ 3:1 sur les deux fonds.
 */
const MODE_COLORS: Record<Kind, string> = {
  bus: TRANSIT.bus,
  tram: TRANSIT.tram,
  metro: TRANSIT.metro,
  /** Neutre (train, bateau, câble : rares) et mode inconnu : hors de la palette validée, gris sans teinte. */
  other: TRANSIT.autre,
};
const UNKNOWN_MODE_COLOR = TRANSIT.autre;
const OUTLINE_DARK: [number, number, number] = [22, 26, 38];
const OUTLINE_LIGHT: [number, number, number] = [255, 255, 255];
/** Sélection : un anneau blanc sous un anneau sombre, jamais une couleur de plus. */
const RING_HALO: Color = [255, 255, 255, 240];
const RING_KEY: Color = [20, 26, 38, 255];
const BUBBLE_FILL: Color = [232, 236, 244, 235];

const MODE_LABELS: Record<NonNullable<ApiLine['mode']>, string> = {
  bus: 'Bus',
  tram: 'Tramway',
  metro: 'Métro',
  train: 'Train',
  ferry: 'Bateau',
  cable: 'Câble ou funiculaire',
};

const LICENCES: Record<string, string> = {
  lov2: 'Licence Ouverte 2.0',
  'fr-lo': 'Licence Ouverte',
  'odc-odbl': 'ODbL',
};

let footprintCache: TransitAtlas | undefined;
function footprints(): TransitAtlas {
  footprintCache ??= buildFootprintAtlas(TRANSIT_LENGTH);
  return footprintCache;
}

let kindCache: { vehicles: Vehicle[]; byKind: Record<Kind, Vehicle[]>; estimated: Vehicle[] } | undefined;
/** Les véhicules de chaque mode (une couche de maquettes par mode), recalculés quand la liste des véhicules change (chargement, ou pas de relecture). */
function byKind(data: TransitData): { byKind: Record<Kind, Vehicle[]>; estimated: Vehicle[] } {
  if (kindCache?.vehicles !== data.vehicles) {
    const byKind: Record<Kind, Vehicle[]> = { bus: [], tram: [], metro: [], other: [] };
    for (const v of data.vehicles) byKind[v.line.kind].push(v);
    kindCache = { vehicles: data.vehicles, byKind, estimated: data.vehicles.filter((v) => v.estimate) };
  }
  return kindCache;
}

let atlasCache: TransitAtlas | undefined;
function atlas(): TransitAtlas {
  atlasCache ??= buildTransitAtlas();
  return atlasCache;
}

function kindOf(mode: ApiLine['mode']): Kind {
  switch (mode) {
    case 'tram':
      return 'tram';
    case 'metro':
      return 'metro';
    case 'train':
      return 'metro'; // RER, Transilien : rame de voitures accouplées (la maquette du métro), pas un bus articulé
    case 'ferry':
    case 'cable':
      return 'other';
    default:
      return 'bus'; // mode non précisé : la grande majorité des véhicules, mais en gris (voir fillOf)
  }
}

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Luminance relative (0 sombre, 1 clair), pour choisir un contour qui ressorte. */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function colorsOf(line: Line, dim: boolean): { fill: Color; halo: Color; hex: string } {
  // Un train sans couleur de ligne reste gris : il a la maquette du métro, pas sa couleur.
  const hex = line.officialColor ?? (line.mode === 'train' ? MODE_COLORS.other : line.mode ? MODE_COLORS[line.kind] : UNKNOWN_MODE_COLOR);
  const base = rgb(hex);
  const alpha = dim ? 110 : 255;
  return { fill: [...base, alpha], halo: [...(luminance(base) > 0.35 ? OUTLINE_DARK : OUTLINE_LIGHT), dim ? 90 : 235], hex };
}

/** Texte lisible (noir ou blanc) sur une couleur de ligne. */
function textColorOn(fill: Color): Color {
  return luminance([fill[0]!, fill[1]!, fill[2]!]) > 0.35 ? [22, 26, 38] : [255, 255, 255];
}

let previous: TransitData | undefined;

/** La trajectoire d'un véhicule estimé : points absolus (le serveur envoie des écarts). */
function estimateOf(v: ApiVehicle, e: ApiEstimate, receivedAt: number, stepMs: number): Estimate {
  const xy = new Float64Array(2 + e.path.length);
  xy[0] = v.lon;
  xy[1] = v.lat;
  // Les écarts sont en cent-millièmes de degré, comme les coordonnées arrondies à 5 décimales du serveur.
  for (let i = 0; i < e.path.length; i += 2) {
    xy[i + 2] = xy[i]! + e.path[i]! / 1e5;
    xy[i + 3] = xy[i + 1]! + e.path[i + 1]! / 1e5;
  }
  // La trajectoire part de l'heure du serveur ; si son horloge est décalée de la nôtre, on la fait partir de la réception.
  const serverMs = v.ts * 1000;
  return {
    theoretical: e.theoretical === true,
    to: e.to,
    next: e.next,
    nextAt: e.nextAt === undefined ? undefined : e.nextAt * 1000,
    delayS: e.delay,
    t0: Math.abs(receivedAt - serverMs) < MAX_CLOCK_SKEW_MS ? serverMs : receivedAt,
    stepMs,
    xy,
  };
}

/** Cap (degrés depuis le nord) et longueur (mètres) du déplacement de (lon0, lat0) à (lon1, lat1). */
function moveFrom(lon0: number, lat0: number, lon1: number, lat1: number): { bearing: number; meters: number } {
  const dx = (lon1 - lon0) * Math.cos((((lat0 + lat1) / 2) * Math.PI) / 180);
  const dy = lat1 - lat0;
  return { bearing: ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360, meters: Math.hypot(dx, dy) * 111_320 };
}

/**
 * Écrit dans `out` la position de la trajectoire à l'instant `time` ; vrai si la trajectoire est finie (le véhicule s'y arrête).
 * Met aussi à jour `e.bearing`, la direction du segment parcouru : le véhicule regarde où il va, y compris dans les virages
 * (le cap envoyé par le serveur est celui du seul premier segment). À l'arrêt, le dernier cap est conservé.
 */
function atTime(e: Estimate, time: number, out: [number, number, number]): boolean {
  const last = e.xy.length / 2 - 1;
  const u = Math.min(Math.max((time - e.t0) / e.stepMs, 0), last);
  const i = Math.min(Math.floor(u), Math.max(last - 1, 0));
  const f = u - i;
  const next = Math.min(i + 1, last);
  out[0] = e.xy[2 * i]! + (e.xy[2 * next]! - e.xy[2 * i]!) * f;
  out[1] = e.xy[2 * i + 1]! + (e.xy[2 * next + 1]! - e.xy[2 * i + 1]!) * f;
  if (next > i) {
    const move = moveFrom(e.xy[2 * i]!, e.xy[2 * i + 1]!, e.xy[2 * next]!, e.xy[2 * next + 1]!);
    if (move.meters >= MIN_MOVE_M) e.bearing = move.bearing;
  }
  return u >= last;
}

/** Direction d'un véhicule sans cap annoncé : celle de sa trajectoire estimée ; 0 si on ne sait pas. */
function pathBearing(v: Vehicle): number {
  const xy = v.estimate?.xy;
  if (!xy) return 0;
  for (let i = 2; i + 1 < xy.length; i += 2) {
    const dx = (xy[i]! - xy[0]!) * Math.cos((xy[1]! * Math.PI) / 180);
    const dy = xy[i + 1]! - xy[1]!;
    if (Math.abs(dx) + Math.abs(dy) > 1e-6) return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  }
  return 0;
}

/** Réseaux dont au moins trois véhicules annoncent un cap et dont tous ces caps valent exactement 0 : le champ n'est pas renseigné. */
function fakeHeadingNetworks(json: ApiTransit, lines: Line[]): Set<number> {
  const counts = new Map<number, { all: number; zero: number }>();
  for (const v of json.vehicles) {
    if (v.est || v.heading === undefined) continue;
    const index = lines[v.line]!.network.index;
    const c = counts.get(index) ?? { all: 0, zero: 0 };
    c.all++;
    if (v.heading === 0) c.zero++;
    counts.set(index, c);
  }
  return new Set([...counts].filter(([, c]) => c.all >= 3 && c.zero === c.all).map(([index]) => index));
}

async function loadTransit(signal: AbortSignal): Promise<TransitData> {
  const response = await fetch('/api/transports', { signal });
  if (response.status === 503) throw new Error('le serveur n’a pas encore reçu les positions, nouvel essai dans quelques secondes');
  if (!response.ok) throw new Error(`le serveur des transports a répondu ${response.status}`);
  const json = (await response.json()) as ApiTransit;
  const receivedAt = Date.now();

  const networks: Network[] = json.networks.map((n, index) => ({ index, name: n.name, licence: n.licence, count: n.vehicles, estimated: 0, lon: 0, lat: 0, radius: 0 }));
  const stepMs = (json.estStep ?? 8) * 1000;
  const lines: Line[] = json.lines.map((l) => ({
    network: networks[l.network]!,
    id: l.id,
    name: l.name,
    longName: l.longName,
    officialColor: l.color ? `#${l.color}` : undefined,
    mode: l.mode,
    kind: kindOf(l.mode),
  }));

  // Certains réseaux écrivent 0 dans le cap de tous leurs véhicules (« non renseigné ») : ils regarderaient tous vers le nord.
  const zeroOnly = fakeHeadingNetworks(json, lines);

  const sums = networks.map(() => ({ lon: 0, lat: 0 }));
  const list: Vehicle[] = json.vehicles.map((v) => {
    const line = lines[v.line]!;
    const heading = !v.est && zeroOnly.has(line.network.index) ? undefined : v.heading;
    const sum = sums[line.network.index]!;
    sum.lon += v.lon;
    sum.lat += v.lat;
    if (v.est) line.network.estimated++;
    const ageS = receivedAt / 1000 - v.ts;
    const { fill, halo } = colorsOf(line, !v.est && ageS > DIM_AFTER_S);
    const key = `${line.network.name}|${v.id}`;
    const vehicle: Vehicle = {
      key,
      id: v.id,
      line,
      lon: v.lon,
      lat: v.lat,
      fromLon: v.lon,
      fromLat: v.lat,
      arrivedAt: receivedAt,
      spanMs: MIN_SPAN_MS,
      headingDeg: heading,
      bearing: heading ?? 0,
      speedKmh: v.speed,
      ts: v.ts * 1000,
      fill,
      halo,
      estimate: v.est && estimateOf(v, v.est, receivedAt, stepMs),
      position: [v.lon, v.lat, 0],
      // Une position estimée se lit sur sa trajectoire, à chaque image, jusqu'à la fin de celle-ci.
      settled: !v.est,
      groundVersion: -1,
    };
    const old = vehicle.estimate ? undefined : previous?.byKey.get(key);
    // Sans cap annoncé : celui qu'on lui voyait, sinon celui de sa trajectoire estimée.
    if (heading === undefined) vehicle.bearing = old?.bearing ?? pathBearing(vehicle);
    // Continuité : le véhicule part de là où on le voit, et non de sa position précédente.
    if (old && !old.estimate) {
      if (old.ts === vehicle.ts) {
        // Pas de nouvelle mesure : le mouvement en cours se poursuit.
        Object.assign(vehicle, { fromLon: old.fromLon, fromLat: old.fromLat, arrivedAt: old.arrivedAt, spanMs: old.spanMs, settled: old.settled, bearing: old.bearing });
        vehicle.position = old.position;
        vehicle.groundVersion = old.groundVersion;
      } else {
        const shownLon = old.position[0];
        const shownLat = old.position[1];
        if (Math.abs(shownLon - v.lon) < MAX_GLIDE_DEG && Math.abs(shownLat - v.lat) < MAX_GLIDE_DEG && (shownLon !== v.lon || shownLat !== v.lat)) {
          vehicle.fromLon = shownLon;
          vehicle.fromLat = shownLat;
          // Il glisse en ligne droite de là où on le voit à la nouvelle position : son corps suit cette direction (un cap
          // annoncé qui s'en écarte le ferait avancer en crabe). Un déplacement trop court ne dit rien : on garde le cap d'avant.
          const glide = moveFrom(shownLon, shownLat, v.lon, v.lat);
          if (glide.meters >= MIN_MOVE_M) vehicle.bearing = glide.bearing;
          else vehicle.bearing = old.bearing;
          vehicle.spanMs = Math.min(Math.max((vehicle.ts - old.ts) || MIN_SPAN_MS, MIN_SPAN_MS), MAX_SPAN_MS);
          vehicle.settled = false;
          vehicle.position = [shownLon, shownLat, old.position[2]];
          vehicle.groundVersion = old.groundVersion;
        }
      }
    }
    return vehicle;
  });

  networks.forEach((n, i) => {
    const sum = sums[i]!;
    n.lon = sum.lon / Math.max(n.count, 1);
    n.lat = sum.lat / Math.max(n.count, 1);
    // Surface proportionnelle au nombre de véhicules (rayon en pixels), bornée pour rester lisible.
    n.radius = Math.min(10 + 2.2 * Math.sqrt(n.count), 34);
  });

  const data: TransitData = {
    vehicles: list,
    byKey: new Map(list.map((v) => [v.key, v])),
    networks,
    lineCount: lines.length,
    collectedAt: json.updatedAt * 1000,
    motion: 0,
  };
  previous = data;
  return data;
}

// --- Relecture ---

let replayCache: { chunk: DecodedChunk; data: TransitData } | undefined;
const scratch = newSample();

async function loadTransitReplay(time: number): Promise<TransitData> {
  const state = await loadReplay('transports', time);
  const { chunk } = state;
  if (!chunk) {
    return {
      vehicles: [],
      byKey: new Map(),
      networks: [],
      lineCount: 0,
      collectedAt: 0,
      motion: 0,
      replay: { key: state.key, chunk: null, absence: state.absence, all: [], allNetworks: [], stamp: NaN },
    };
  }
  if (replayCache?.chunk === chunk) {
    replayCache.data.replay!.key = state.key; // mêmes véhicules : on garde les objets (et la sélection)
    return replayCache.data;
  }
  const { all, networks, lineCount } = replayVehicles(chunk);
  const data: TransitData = {
    vehicles: [],
    byKey: new Map(all.map((v) => [v.key, v])),
    networks: [],
    lineCount,
    collectedAt: chunk.fetchedAt,
    motion: 0,
    replay: { key: state.key, chunk, absence: null, all, allNetworks: networks, stamp: NaN },
  };
  replayCache = { chunk, data };
  return data;
}

/**
 * Les lignes, les réseaux et les véhicules d'un tronçon. Table 0 : une ligne par entrée, « réseau, licence, id, nom, nom
 * long, couleur, mode » séparés par des tabulations ; identité d'un véhicule : [terminus], [ligne + 1, nature] avec
 * nature 1 = position relevée, 2 = estimée d'après le temps réel, 3 = estimée d'après l'horaire théorique.
 */
function replayVehicles(chunk: DecodedChunk): { all: Vehicle[]; networks: Network[]; lineCount: number } {
  const networks = new Map<string, Network>();
  const network = (name: string, licence: string): Network => {
    let n = networks.get(name);
    if (!n) {
      n = { index: networks.size, name, licence, count: 0, estimated: 0, lon: 0, lat: 0, radius: 0 };
      networks.set(name, n);
    }
    return n;
  };
  const lines: Line[] = chunk.tables[0]!.map((descriptor) => {
    const [net = '', licence = '', id, name, longName, color, mode] = descriptor.split('\t');
    const m = (mode || undefined) as ApiLine['mode'];
    return {
      network: network(net, licence),
      id: id || undefined,
      name: name || undefined,
      longName: longName || undefined,
      officialColor: color ? `#${color}` : undefined,
      mode: m,
      kind: kindOf(m),
    };
  });
  const unknown: Line = { network: network('Réseau inconnu', ''), kind: 'bus' };
  const all: Vehicle[] = [];
  for (let o = 0; o < chunk.count; o++) {
    const [lineNumber = 0, nature = 1] = chunk.numbers[o]!;
    const line = lines[lineNumber - 1] ?? unknown;
    const id = chunk.ids[o]!;
    const { fill, halo } = colorsOf(line, false);
    all.push({
      key: `${line.network.name}|${id}`,
      id,
      line,
      lon: 0,
      lat: 0,
      fromLon: 0,
      fromLat: 0,
      arrivedAt: 0,
      spanMs: MIN_SPAN_MS,
      bearing: 0,
      ts: 0,
      fill,
      halo,
      estimate:
        nature >= 2
          ? { theoretical: nature === 3, to: chunk.strings[o]![0] || undefined, t0: 0, stepMs: 1, xy: new Float64Array(0) }
          : undefined,
      position: [0, 0, 0],
      settled: true,
      groundVersion: -1,
      ro: o,
      here: false,
    });
  }
  return { all, networks: [...networks.values()], lineCount: lines.length };
}

/** Place le véhicule à l'instant `time` ; faux (et marqué absent) s'il n'existe pas à cet instant. */
function placeReplayVehicle(chunk: DecodedChunk, v: Vehicle, time: number): boolean {
  if (!sample(chunk, v.ro!, time, scratch)) {
    v.here = false;
    return false;
  }
  // Mesures : cap (°), vitesse (km/h), retard (s), prochain arrêt (indice dans la table 1), heure d'arrivée à cet arrêt (s UTC).
  const heading = measureAngle(chunk, scratch, 0);
  const speed = measure(chunk, scratch, 1);
  v.headingDeg = heading === undefined ? undefined : Math.round(heading);
  v.speedKmh = speed === undefined ? undefined : Math.round(speed);
  // Le véhicule va en ligne droite entre les deux points enregistrés : son corps suit ce sens. Le cap annoncé ne sert qu'à
  // l'arrêt (déplacement trop court pour dire quoi que ce soit), et à défaut le dernier cap est conservé.
  const move =
    scratch.j >= 0 && !scratch.held
      ? moveFrom(chunk.lon[scratch.i]! / 1e5, chunk.lat[scratch.i]! / 1e5, chunk.lon[scratch.j]! / 1e5, chunk.lat[scratch.j]! / 1e5)
      : undefined;
  if (move && move.meters >= MIN_MOVE_M) v.bearing = move.bearing;
  else if (heading !== undefined && heading !== 0) v.bearing = heading;
  v.lon = scratch.lon;
  v.lat = scratch.lat;
  v.position[0] = scratch.lon;
  v.position[1] = scratch.lat;
  v.ts = (chunk.start + chunk.t[scratch.i]!) * 1000;
  const e = v.estimate;
  if (e) {
    e.delayS = measure(chunk, scratch, 2, true);
    const stop = measure(chunk, scratch, 3, true);
    e.next = stop === undefined ? undefined : chunk.tables[1]![stop];
    const nextAt = measure(chunk, scratch, 4, true);
    e.nextAt = nextAt === undefined ? undefined : nextAt * 1000;
  }
  v.here = true;
  return true;
}

/** Replace un seul véhicule (fiche, caméra qui le suit). */
function refreshReplayVehicle(data: TransitData, v: Vehicle, time: number): boolean {
  return data.replay?.chunk ? placeReplayVehicle(data.replay.chunk, v, time) : false;
}

/**
 * Place tous les véhicules à l'instant `time`, refait la liste de ceux qui existent et le rond de chaque réseau
 * (nombre, centre). Au plus une fois par pas de temps.
 */
function updateReplay(data: TransitData, time: number): void {
  const replay = data.replay!;
  const chunk = replay.chunk;
  if (!chunk) return;
  const stamp = Math.floor(time / 200);
  if (replay.stamp === stamp) return;
  replay.stamp = stamp;
  prefetchNear('transports', time);
  for (const n of replay.allNetworks) {
    n.count = 0;
    n.estimated = 0;
    n.lon = 0;
    n.lat = 0;
  }
  const present: Vehicle[] = [];
  for (const v of replay.all) {
    if (!placeReplayVehicle(chunk, v, time)) continue;
    present.push(v);
    const n = v.line.network;
    n.count++;
    n.lon += v.lon;
    n.lat += v.lat;
    if (v.estimate) n.estimated++;
  }
  for (const n of replay.allNetworks) {
    n.lon /= Math.max(n.count, 1);
    n.lat /= Math.max(n.count, 1);
    n.radius = Math.min(10 + 2.2 * Math.sqrt(n.count), 34);
  }
  data.vehicles = present;
  data.networks = replay.allNetworks.filter((n) => n.count > 0);
  data.motion++;
}

/**
 * Faut-il montrer ces données à cet instant ? En direct, l'horloge doit être dans la fenêtre du direct (les deux dernières
 * minutes, ou un peu plus tard) ; en relecture, plus de deux minutes dans le passé.
 */
function shows(data: TransitData, time: number): boolean {
  return data.replay ? isReplayTime(time) && data.replay.chunk !== null : !isReplayTime(time) && time <= Date.now() + 60_000;
}

/** Place chaque véhicule à l'instant `time` ; renvoie vrai si au moins un a bougé. */
function place(data: TransitData, time: number, terrain: { elevation(lon: number, lat: number): number; version: number }, bounds: readonly [number, number, number, number]): boolean {
  let moved = false;
  // Seuls les véhicules de la vue (avec une marge) sont posés sur le relief : les autres le seront en y entrant.
  const [west, south, east, north] = bounds;
  const margin = Math.max(east - west, north - south) * 0.5;
  for (const v of data.vehicles) {
    const needsGround =
      v.groundVersion !== terrain.version &&
      v.lon >= west - margin && v.lon <= east + margin && v.lat >= south - margin && v.lat <= north + margin;
    if (v.settled && !needsGround) continue;
    if (v.estimate) {
      v.settled = atTime(v.estimate, time, v.position);
      if (v.estimate.bearing !== undefined) v.bearing = v.estimate.bearing;
    } else if (!v.settled) {
      const p = Math.min(Math.max((time - v.arrivedAt) / v.spanMs, 0), 1);
      v.position[0] = v.fromLon + (v.lon - v.fromLon) * p;
      v.position[1] = v.fromLat + (v.lat - v.fromLat) * p;
      if (p >= 1) v.settled = true;
    } else {
      v.position[0] = v.lon;
      v.position[1] = v.lat;
    }
    if (needsGround) {
      v.position[2] = terrain.elevation(v.position[0], v.position[1]) + ICON_LIFT_M;
      v.groundVersion = terrain.version;
    }
    moved = true;
  }
  return moved;
}

/**
 * Intervalle entre deux mises à jour de l'affichage. Redessiner la carte entière coûte plusieurs millisecondes :
 * on ne le fait que si un véhicule peut avoir bougé d'environ un pixel et demi. Un bus fait 17 m/s au plus (60 km/h) ;
 * au zoom 11 (52 m par pixel) une mise à jour toutes les 2 s suffit, dès le zoom 14 il en faut une toutes les 0,6 s, et jamais plus de deux par seconde (au-delà, le coût de redessiner la carte dépasse le gain de fluidité).
 */
function glideStepMs(zoom: number): number {
  const metersPerPixel = (156_543 * Math.cos((46.5 * Math.PI) / 180)) / 2 ** zoom;
  return Math.min(Math.max((1.5 * metersPerPixel * 1000) / 17, 500), 2000);
}

/** Seuils tous les quarts de zoom : la taille des maquettes suit l'échelle (agrandissement minimal en pixels), qui n'est recalculée qu'à ces seuils. */
function quarterZoomBreaks(from: number): number[] {
  return Array.from({ length: Math.round((18 - from) * 4) + 1 }, (_, i) => from + i / 4);
}

const nf = (n: number, digits = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });

/** Heure locale (« 14:32 »). */
function clockText(ms: number): string {
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

/** Fiche d'un véhicule dont la position est estimée : dit d'où vient l'estimation, avec le prochain arrêt et le retard si on les connaît. */
function describeEstimated(v: Vehicle, e: Estimate, line: Line, fields: Array<[string, string]>): InfoContent {
  if (e.theoretical) fields.push(['Retard', 'inconnu : pas de temps réel pour cette circulation']);
  fields.push(['Licence des données', LICENCES[line.network.licence] ?? line.network.licence]);
  // Le retard (s'il est connu) passe en premier : c'est le chiffre que la poignée du téléphone montre.
  const figures: InfoFigure[] = [];
  if (!e.theoretical && e.delayS !== undefined) {
    const minutes = Math.round(e.delayS / 60);
    const late = Math.abs(e.delayS) >= ON_TIME_S && minutes !== 0;
    figures.push({
      value: late ? `${minutes > 0 ? '+' : '−'}${Math.abs(minutes)}` : '0',
      unit: 'min',
      label: !late ? 'à l’heure' : minutes > 0 ? 'de retard' : 'd’avance',
    });
  }
  if (v.speedKmh !== undefined) figures.push({ value: nf(v.speedKmh), unit: 'km/h', label: 'vitesse estimée' });
  if (e.next) figures.push({ value: e.nextAt === undefined ? '—' : clockText(e.nextAt), label: e.next });
  return {
    kind: kindLabel(line),
    title: lineTitle(line),
    subtitle: e.to ? `vers ${e.to}` : line.longName,
    status: estimatedStatus(
      e.theoretical ? 'Position estimée d’après l’horaire théorique' : 'Position estimée d’après les horaires en temps réel',
    ),
    figures,
    fields,
    note: `Ce réseau ne publie pas la position de ses véhicules, seulement ses horaires. La carte place le véhicule sur le tracé de sa ligne ${
      e.theoretical
        ? 'd’après l’heure prévue à chaque arrêt (horaire théorique : le réseau n’annonce aucun écart pour cette circulation)'
        : 'd’après l’heure prévue à chaque arrêt, corrigée du retard annoncé en temps réel'
    }, à vitesse régulière d’un arrêt au suivant. La position réelle peut différer de quelques centaines de mètres.`,
  };
}

/** Pastille de relecture : l'instant rejoué, et que la position est estimée d'après les horaires, s'il y a lieu. */
function replayState(time: number, estimated: boolean): InfoStatus {
  return { tone: 'replay', text: `${replayLabel(time)}${estimated ? ' · position estimée' : ''}` };
}

/** « Bus · Tisséo » : le mode puis le réseau, au-dessus du titre de la fiche. */
function kindLabel(line: Line): string {
  return `${line.mode ? MODE_LABELS[line.mode] : 'Transport en commun'} · ${line.network.name}`;
}

function lineTitle(line: Line): string {
  // « RER A », « Transilien H » (donnés par le serveur) disent mieux que « Ligne A ».
  if (line.mode === 'train' && line.longName && line.longName.length <= 16) return line.longName;
  if (line.name) return `Ligne ${line.name}`;
  if (line.id) return `Ligne ${line.id}`;
  return 'Ligne inconnue';
}

let labelCache: { data: TransitData; band: number; bucket: number; vehicles: Vehicle[] } | undefined;
let networkLabelCache: { data: TransitData; band: number; bucket: number; networks: Network[] } | undefined;
let densityCache: { data: TransitData; bucket: number; byLabel: Vehicle[] } | undefined;

/**
 * Étiquettes de ligne dès le zoom 13, une par case : on préfère les véhicules en mouvement.
 * `bucket` : en relecture, les véhicules bougent et apparaissent, le choix est refait toutes les 5 s (0 en direct).
 */
function labelled(data: TransitData, zoom: number, bucket: number): Vehicle[] {
  const band = Math.floor(zoom * 2) / 2;
  if (labelCache?.data !== data || labelCache.band !== band || labelCache.bucket !== bucket) {
    if (densityCache?.data !== data || densityCache.bucket !== bucket) {
      densityCache = { data, bucket, byLabel: data.vehicles.filter((v) => v.line.name) };
    }
    const kept = declutter(densityCache.byLabel, zoom, {
      lon: (v) => v.lon,
      lat: (v) => v.lat,
      rank: (v) => -(v.speedKmh ?? 0),
      box: LABEL_BOX_PX,
    });
    labelCache = { data, band, bucket, vehicles: kept };
  }
  return labelCache.vehicles;
}

function labelledNetworks(data: TransitData, zoom: number, bucket: number): Network[] {
  const band = Math.floor(zoom * 2) / 2;
  if (networkLabelCache?.data !== data || networkLabelCache.band !== band || networkLabelCache.bucket !== bucket) {
    const kept = declutter(data.networks, zoom, { lon: (n) => n.lon, lat: (n) => n.lat, rank: (n) => -n.count, box: NETWORK_LABEL_BOX_PX });
    networkLabelCache = { data, band, bucket, networks: kept };
  }
  return networkLabelCache.networks;
}

/** Longueur minimale à l'écran d'un bus (pixels) : les autres modes en gardent la proportion réelle. */
function busMinPx(zoom: number): number {
  if (zoom < 11) return 10;
  if (zoom < 13) return 14;
  return 18;
}

/** Longueur minimale à l'écran d'un véhicule de ce mode (pixels) ; `real` : d'après les longueurs des maquettes 3D, sinon des silhouettes. */
const minLengthPx = (kind: Kind, zoom: number, real = false) =>
  real ? (busMinPx(zoom) * TRANSIT_LENGTH[kind]) / TRANSIT_LENGTH.bus : (busMinPx(zoom) * lengthUnits(kind)) / lengthUnits('bus');

export const transit = defineModule<TransitData>({
  id: 'transports',
  name: 'Bus, trams et métros',
  category: 'transport',
  description:
    'Véhicules des transports urbains : leur position quand le réseau la publie, sinon estimée d’après ses horaires en temps réel (contour pointillé). Un rond par réseau de loin, chaque véhicule de près. En direct, ou relus depuis l’enregistrement du serveur quand on remonte la frise.',
  attribution:
    'Réseaux de transport (positions, horaires et horaires en temps réel), via transport.data.gouv.fr (Licence Ouverte 2.0 ou ODbL selon le réseau, citée dans la fiche) ; Île-de-France : Île-de-France Mobilités, plateforme PRIM (ODbL). Positions estimées par la carte d’après ces horaires',
  refreshIntervalMs: 30_000,
  timeStepMs: (view) => glideStepMs(view.zoom),
  zoomBreaks: [...halfZoomBreaks(NETWORK_LABEL_FROM_ZOOM, VEHICLES_FROM_ZOOM), 11, ...halfZoomBreaks(LABELS_FROM_ZOOM), ...quarterZoomBreaks(MESH_FROM_ZOOM)].sort((a, b) => a - b),
  followsTerrain: true,
  settings: [RENDER_SETTING],

  legend(): LegendItem[] {
    return [
      { color: MODE_COLORS.bus, icon: legendIcon('bus', MODE_COLORS.bus), label: 'Bus (une caisse)' },
      { color: MODE_COLORS.tram, icon: legendIcon('tram', MODE_COLORS.tram), label: 'Tramway (rame articulée de trois éléments)' },
      { color: MODE_COLORS.metro, icon: legendIcon('metro', MODE_COLORS.metro), label: 'Métro, RER et Transilien (voitures accouplées)' },
      { color: MODE_COLORS.other, icon: legendIcon('other', MODE_COLORS.other), label: 'Bateau, câble (deux éléments, gris)' },
      { color: UNKNOWN_MODE_COLOR, icon: legendIcon('bus', UNKNOWN_MODE_COLOR), label: 'Mode inconnu (bus gris)' },
      {
        color: 'transparent',
        icon: estimatedLegendIcon('bus', MODE_COLORS.bus),
        label:
          'Contour pointillé : position estimée d’après les horaires du réseau, qui ne publie pas ses positions (mêmes silhouettes et mêmes couleurs). En maquette 3D : véhicule translucide sur une empreinte pointillée',
      },
      { color: 'transparent', label: 'Dès le zoom 15, réglage « Rendu » : maquettes 3D de taille réelle (bus de 12 m, tramway de 34 m, rame de métro de 40 m) ou silhouettes à plat. Le véhicule pointe dans le sens de sa marche ; de près, il a sa longueur réelle. Le numéro de la ligne s’affiche à côté, dès le zoom 13.' },
      { color: 'transparent', icon: bubbleIcon(), label: 'Vue d’ensemble : un rond par réseau, plus gros avec le nombre de véhicules' },
      { color: 'transparent', label: 'La couleur est celle de la ligne quand le réseau la donne ; sinon celle du mode (ci-dessus).' },
    ];
  },

  load: ({ signal, time }) => (isReplayTime(time) ? loadTransitReplay(time) : loadTransit(signal)),

  // Bascule entre le direct et la relecture, et d'un tronçon à l'autre.
  needsReload: (data, time) => (isReplayTime(time) ? !data.replay || data.replay.key !== replayKey('transports', time) : !!data.replay),

  summary({ data, time }) {
    if (!data) return null;
    if (data.replay && !isReplayTime(time)) return null;
    if (data.replay?.chunk === null) return data.replay.absence;
    if (!data.replay && !shows(data, time)) return null;
    if (data.replay) updateReplay(data, time);
    const prefix = data.replay ? replayLabel(time) : 'En direct';
    const stale = !data.replay && Math.round((Date.now() - data.collectedAt) / 1000) > STALE_AFTER_S ? ' · serveur sans nouvelles depuis plus de 2 minutes' : '';
    if (data.vehicles.length === 0) {
      return data.replay
        ? `${prefix} · aucun véhicule enregistré à cet instant (la nuit, beaucoup de réseaux sont à l’arrêt)`
        : `${prefix} · aucun véhicule en circulation dans les flux pour l’instant (la nuit, beaucoup de réseaux sont à l’arrêt).${stale}`;
    }
    const n = data.vehicles.length;
    const m = data.networks.length;
    const e = data.vehicles.filter((v) => v.estimate).length;
    const estimated = e > 0 ? `, dont ${nf(e)} position${e > 1 ? 's' : ''} estimée${e > 1 ? 's' : ''} d’après les horaires` : '';
    return `${prefix} · ${nf(n)} véhicule${n > 1 ? 's' : ''} sur ${nf(m)} réseau${m > 1 ? 'x' : ''}${estimated}${stale}`;
  },

  deckLayers({ data, time, terrain, selection, view, settings, night }) {
    if (!data || !shows(data, time)) return [];
    if (data.replay) updateReplay(data, time);
    const parameters = OVER_MAP;
    const chosen = selection as TransitSelection | null;
    const fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';

    // Vue d'ensemble : un rond par réseau.
    if (view.zoom < VEHICLES_FROM_ZOOM) {
      const selectedNet = chosen?.type === 'network' ? data.networks.find((n) => n.name === chosen.name) : undefined;
      return [
        new ScatterplotLayer<Network>({
          id: 'transports/reseaux',
          data: data.networks,
          getPosition: (n) => [n.lon, n.lat, 0],
          radiusUnits: 'pixels',
          getRadius: (n) => n.radius,
          getFillColor: BUBBLE_FILL,
          stroked: true,
          getLineColor: [22, 26, 38, 235],
          getLineWidth: 1.5,
          lineWidthUnits: 'pixels',
          pickable: true,
          billboard: true,
          parameters,
        }),
        ...(selectedNet
          ? [RING_HALO, RING_KEY].map(
              (color, i) =>
                new ScatterplotLayer<Network>({
                  id: `transports/reseau-choisi-${i}`,
                  data: [selectedNet],
                  getPosition: (n) => [n.lon, n.lat, 0],
                  radiusUnits: 'pixels',
                  getRadius: (n) => n.radius + 4,
                  filled: false,
                  stroked: true,
                  getLineColor: color,
                  lineWidthUnits: 'pixels',
                  getLineWidth: i === 0 ? 7 : 2.5,
                  billboard: true,
                  parameters,
                }),
            )
          : []),
        new TextLayer<Network>({
          id: 'transports/reseaux-nombres',
          data: data.networks,
          getPosition: (n) => [n.lon, n.lat, 0],
          getText: (n) => String(n.count),
          characterSet: 'auto',
          fontFamily,
          fontWeight: 700,
          getSize: 12,
          getColor: [22, 26, 38],
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          billboard: true,
          parameters,
        }),
        view.zoom >= NETWORK_LABEL_FROM_ZOOM &&
          new TextLayer<Network>({
            id: 'transports/reseaux-noms',
            data: labelledNetworks(data, view.zoom, data.replay ? Math.floor(time / 5000) : 0),
            getPosition: (n) => [n.lon, n.lat, 0],
            getText: (n) => n.name,
            characterSet: 'auto',
            fontFamily,
            fontWeight: 600,
            getSize: 11.5,
            getColor: [255, 255, 255],
            getTextAnchor: 'start',
            getAlignmentBaseline: 'center',
            getPixelOffset: (n) => [n.radius + 5, 0],
            background: true,
            getBackgroundColor: [15, 18, 26, 215],
            backgroundPadding: [5, 2],
            backgroundBorderRadius: 4,
            billboard: true,
            parameters,
          }),
      ];
    }

    // De près : chaque véhicule, posé sur le relief et glissant vers sa nouvelle position.
    if (data.replay) {
      // Relecture : les positions sont déjà celles de l'instant ; reste à les poser sur le relief (une fois par version du relief).
      const [west, south, east, north] = view.bounds();
      const margin = Math.max(east - west, north - south) * 0.5;
      for (const v of data.vehicles) {
        if (v.groundVersion === terrain.version) continue;
        const [lon, lat] = v.position;
        if (lon! < west - margin || lon! > east + margin || lat! < south - margin || lat! > north + margin) continue;
        v.position[2] = terrain.elevation(v.position[0], v.position[1]) + ICON_LIFT_M;
        v.groundVersion = terrain.version;
      }
    } else if (place(data, time, terrain, view.bounds())) {
      data.motion++;
    }
    const icons = atlas();
    const pickedVehicle = chosen?.type === 'vehicle' ? data.byKey.get(chosen.key) : undefined;
    const picked = pickedVehicle?.here === false ? undefined : pickedVehicle; // en relecture, un véhicule absent n'a pas de position à cet instant
    const common = {
      data: data.vehicles,
      iconAtlas: icons.atlas,
      iconMapping: icons.mapping,
      getPosition: (v: Vehicle) => v.position,
      // À plat sur la chaussée, orienté selon le cap (deck.gl tourne dans le sens trigonométrique).
      getAngle: (v: Vehicle) => -v.bearing,
      billboard: false,
      // La taille d'une icône est celle de sa cellule : la même pour tous les modes (même échelle d'atlas),
      // à la longueur réelle de près ; de loin, une longueur minimale (celle d'un bus, les autres en proportion).
      sizeUnits: 'meters' as const,
      getSize: CELL_METERS,
      sizeMinPixels: (busMinPx(view.zoom) * CELL_HEIGHT) / (lengthUnits('bus') * 5),
      sizeMaxPixels: 20_000,
      parameters,
    };
    const moving = { getPosition: [data.motion, terrain.version], getAngle: data.motion };
    const models = wants3d(settings) && view.zoom >= MESH_FROM_ZOOM;
    // Maquettes : taille réelle de près ; de loin, la même longueur minimale à l'écran que les silhouettes.
    const metersPerPixel = (lat: number) => (156_543 * Math.cos((lat * Math.PI) / 180)) / 2 ** view.zoom;
    const grow = (v: Vehicle) => {
      const length = TRANSIT_LENGTH[v.line.kind];
      return Math.max(1, minLengthPx(v.line.kind, view.zoom, true) / (length / metersPerPixel(v.position[1])));
    };
    const sizeTrigger = view.zoom.toFixed(2);
    const meshes = models ? transitMeshes() : undefined;
    const kinds = models ? byKind(data) : undefined;
    const footIcons = models ? footprints() : undefined;
    const ghost = (v: Vehicle): Color => (v.estimate ? [v.fill[0]!, v.fill[1]!, v.fill[2]!, GHOST_ALPHA] : v.fill);
    // Distance de l'étiquette au véhicule : au-delà de sa demi-longueur (à ce niveau de zoom).
    const meters = (156_543 * Math.cos((46.5 * Math.PI) / 180)) / 2 ** (Math.floor(view.zoom * 2) / 2) / 2;
    const badgeOffset = models
      ? Math.max(minLengthPx('bus', view.zoom, true) * 0.5, (TRANSIT_LENGTH.bus * 0.5) / meters) + 6
      : Math.max(minLengthPx('bus', view.zoom) * 0.5, (CELL_METERS * lengthShare('bus') * 0.5) / meters) + 6;
    return [
      // Position estimée en 3D : une empreinte pointillée au sol, sous la maquette translucide.
      models &&
        footIcons &&
        new IconLayer<Vehicle>({
          id: 'transports/empreintes',
          data: kinds?.estimated ?? [],
          iconAtlas: footIcons.atlas,
          iconMapping: footIcons.mapping,
          getIcon: (v) => v.line.kind,
          getPosition: (v) => [v.position[0], v.position[1], v.position[2] - ICON_LIFT_M + MESH_LIFT_M * grow(v) * 0.5],
          getAngle: (v) => -v.bearing,
          // Trait sombre sur le fond clair du jour, clair sur le fond sombre de la nuit.
          getColor: night > 0.5 ? FOOTPRINT_NIGHT : FOOTPRINT_DAY,
          getSize: (v) => FOOT_CELL_METERS * grow(v),
          sizeUnits: 'meters',
          sizeMinPixels: 0,
          sizeMaxPixels: 20_000,
          billboard: false,
          parameters: { depthCompare: 'less-equal', depthWriteEnabled: false, cullMode: 'none' },
          updateTriggers: { getPosition: [data.motion, terrain.version, sizeTrigger], getAngle: data.motion, getSize: sizeTrigger },
        }),
      ...(meshes && kinds
        ? KINDS.map((kind) =>
            meshLayer<Vehicle>({
              id: `transports/maquettes/${kind}`,
              data: kinds.byKind[kind],
              mesh: meshes[kind],
              getPosition: (v) => v.position,
              getOrientation: (v) => orientation(v.bearing),
              getScale: (v) => {
                const g = grow(v);
                return [g, g, g];
              },
              // La position est à ICON_LIFT_M du relief (icônes à plat) : on la ramène à la hauteur voulue, qui grandit avec la maquette.
              getTranslation: (v) => [0, 0, MESH_LIFT_M * grow(v) - ICON_LIFT_M],
              getColor: ghost,
              pickable: true,
              updateTriggers: {
                getPosition: [data.motion, terrain.version],
                getOrientation: data.motion,
                getScale: sizeTrigger,
                getTranslation: sizeTrigger,
                getColor: data.collectedAt,
              },
            }),
          )
        : []),
      !models &&
      new IconLayer<Vehicle>({
        ...common,
        id: 'transports/contours',
        // Contour pointillé pour une position estimée d'après les horaires ; plein pour une position mesurée.
        getIcon: (v) => `${v.line.kind}-${v.estimate ? 'halo-est' : 'halo'}`,
        getColor: (v) => v.halo,
        updateTriggers: moving,
      }),
      !models &&
      new IconLayer<Vehicle>({
        ...common,
        id: 'transports/vehicules',
        getIcon: (v) => `${v.line.kind}-fill`,
        getColor: (v) => v.fill,
        pickable: true,
        updateTriggers: moving,
      }),
      ...(picked
        ? [RING_HALO, RING_KEY].map(
            (color, i) =>
              new ScatterplotLayer<Vehicle>({
                id: `transports/choisi-${i}`,
                data: [picked],
                getPosition: (v) => v.position,
                radiusUnits: 'meters',
                getRadius: models ? TRANSIT_LENGTH[picked.line.kind] * 0.6 : CELL_METERS * lengthShare(picked.line.kind) * 0.6,
                radiusMinPixels: minLengthPx(picked.line.kind, view.zoom, models) * 0.6 + 4,
                filled: false,
                stroked: true,
                getLineColor: color,
                lineWidthUnits: 'pixels',
                getLineWidth: i === 0 ? 7 : 2.5,
                billboard: true,
                updateTriggers: { getPosition: data.motion },
                parameters,
              }),
          )
        : []),
      view.zoom >= LABELS_FROM_ZOOM &&
        new TextLayer<Vehicle>({
          id: 'transports/lignes',
          data: labelled(data, view.zoom, data.replay ? Math.floor(time / 5000) : 0),
          getPosition: (v) => v.position,
          getText: (v) => v.line.name ?? '',
          characterSet: 'auto',
          fontFamily,
          fontWeight: 700,
          getSize: 11.5,
          getColor: (v) => textColorOn(v.fill),
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          // Le badge est accroché au véhicule, en haut à droite.
          getPixelOffset: [badgeOffset, -badgeOffset * 0.8],
          background: true,
          getBackgroundColor: (v) => [v.fill[0]!, v.fill[1]!, v.fill[2]!, 235],
          backgroundPadding: [6, 3],
          backgroundBorderRadius: 6,
          // Liseré qui s'adapte à la couleur de la ligne (clair sur une ligne sombre, sombre sur une ligne claire).
          getBorderColor: (v) => v.halo,
          getBorderWidth: 2,
          billboard: true,
          updateTriggers: { getPosition: [data.motion, terrain.version] },
          parameters,
        }),
    ];
  },

  select(object) {
    const o = object as Vehicle | Network;
    return ('key' in o ? { type: 'vehicle', key: o.key } : { type: 'network', name: o.name }) satisfies TransitSelection;
  },

  describe(selection, { data, time }): InfoContent | null {
    if (!data || !shows(data, time)) return null;
    const sel = selection as TransitSelection;
    if (sel.type === 'network') {
      const net = data.networks.find((n) => n.name === sel.name);
      if (!net) return null;
      const lines = new Set(data.vehicles.filter((v) => v.line.network === net).map((v) => v.line.id ?? '?')).size;
      return {
        kind: 'Réseau de transport',
        title: net.name,
        // Tout estimé : le réseau ne publie aucune position. Sinon au moins une est reçue, la pastille le dit.
        status: data.replay
          ? replayState(time, net.estimated === net.count)
          : net.estimated === net.count
            ? estimatedStatus('Positions estimées d’après les horaires')
            : measuredStatus(Date.now(), data.collectedAt),
        figures: [
          { value: nf(net.count), label: 'véhicules en circulation' },
          { value: nf(lines), label: 'lignes en service' },
          ...(net.estimated > 0 ? [{ value: nf(net.estimated), label: 'positions estimées' }] : []),
        ],
        fields: [['Licence des données', LICENCES[net.licence] ?? net.licence]],
        note:
          net.estimated > 0
            ? `Rond de la vue d’ensemble, placé au centre des véhicules du réseau. ${net.estimated === net.count ? 'Ce réseau ne publie pas la position de ses véhicules' : 'Une partie de ses véhicules est estimée'} : la carte les place d’après ses horaires en temps réel. Zoomez pour voir chaque véhicule.`
            : 'Rond de la vue d’ensemble, placé au centre des véhicules du réseau. Zoomez pour voir chaque véhicule.',
      };
    }
    const v = data.byKey.get(sel.key);
    if (!v || (data.replay && !refreshReplayVehicle(data, v, time))) return null;
    const line = v.line;
    // Le réseau et le mode sont dans `kind`, la direction dans le sous-titre : les champs gardent le reste.
    const fields: Array<[string, string]> = [];
    if (!line.name && !line.id) fields.push(['Ligne', 'inconnue (le flux ne la précise pas)']);
    if (v.estimate) {
      const card = describeEstimated(v, v.estimate, line, fields);
      return data.replay ? { ...card, status: replayState(time, true) } : card;
    }
    fields.push(['Véhicule', v.id]);
    fields.push(['Licence des données', LICENCES[line.network.licence] ?? line.network.licence]);
    const figures: InfoFigure[] = [];
    if (v.speedKmh !== undefined) figures.push({ value: nf(v.speedKmh), unit: 'km/h', label: 'vitesse' });
    if (v.headingDeg !== undefined) figures.push({ value: `${nf(v.headingDeg)}°`, label: 'cap' });
    return {
      kind: kindLabel(line),
      title: lineTitle(line),
      subtitle: line.longName,
      status: data.replay ? replayState(time, false) : measuredStatus(Date.now(), v.ts),
      figures,
      fields,
      note: data.replay
        ? 'Position GPS publiée par le réseau et enregistrée par le serveur toutes les 30 secondes environ ; entre deux mesures, la position est interpolée.'
        : 'Position GPS publiée par le réseau, relue toutes les 30 secondes ; le véhicule glisse d’une position à la suivante, avec un léger retard.',
    };
  },

  focus(selection, { data, time }) {
    const sel = selection as TransitSelection;
    if (!data || !shows(data, time)) return null;
    if (sel.type === 'network') {
      const net = data.networks.find((n) => n.name === sel.name);
      return net ? { lon: net.lon, lat: net.lat } : null;
    }
    const v = data.byKey.get(sel.key);
    if (!v || (data.replay && !refreshReplayVehicle(data, v, time))) return null;
    return { lon: v.position[0], lat: v.position[1] };
  },
});
