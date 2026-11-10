/**
 * Module « Bateaux » : les navires autour de la France en temps réel, d'après leurs
 * émissions AIS, relayées par le serveur (server/src/ships.rs ; la clé d'aisstream.io
 * reste sur le serveur).
 *
 * Chaque navire est une coque vue de dessus, choisie selon son type AIS parmi huit (voir
 * shipIcons.ts), orientée selon son cap et dessinée à sa longueur réelle quand l'AIS la
 * donne (la largeur aussi : coque étroite, normale ou large), sinon à la longueur courante
 * de son type. De loin, une taille minimale par taille de navire garde la forme lisible.
 * La couleur dit sa famille (marchandises, passagers, pêche et plaisance) ; un navire en
 * route traîne un sillage d'autant plus long qu'il va vite, un navire à l'arrêt n'en a pas.
 * Entre deux collectes, les navires en route avancent selon leur vitesse et leur route.
 *
 * Les noms sont des étiquettes de carte (texte sombre, halo clair), désencombrées : les plus
 * grands navires d'abord, sans chevauchement entre elles.
 *
 * **Relecture.** Le serveur enregistre les positions qu'il sert (server/src/history/). Quand l'horloge est à plus de
 * deux minutes dans le passé, la couche relit l'enregistrement (core/replay.ts) : chaque navire est placé par
 * interpolation entre ses deux positions enregistrées voisines (un navire qui n'a rien émis depuis longtemps est
 * retiré). Là où rien n'a été enregistré, la couche se masque et dit pourquoi.
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { measuredStatus, replayStatus } from '../core/infoStatus';
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
import { OVER_MAP } from '../map/parameters';
import { orientation } from '../models/mesh';
import { meshLayer, RENDER_SETTING, wants3d } from '../models/meshLayer';
import { modelOf, scaleOf, shipMeshes, SHIP_MODELS, type ShipModel } from '../models/ships';
import {
  BEAM_RATIO,
  CELL,
  HULL_LENGTH,
  NOMINAL_LENGTH,
  SHIP_COLORS,
  SHIP_INFO,
  SHIP_TYPES,
  TYPE_FAMILY,
  beamClassOf,
  hullKey,
  legendHull,
  shipAtlas,
  shipType,
  wakeBandOf,
  wakeKey,
  wakeWidthOf,
  type ShipType,
} from './shipIcons';

interface ApiShip {
  mmsi: number;
  name?: string;
  lon: number;
  lat: number;
  /** Vitesse sur le fond (nœuds) et route sur le fond (degrés). */
  sog?: number;
  cog?: number;
  heading?: number;
  status?: number;
  /** Type AIS (70-79 cargo, 80-89 citerne, 60-69 passagers…). */
  kind?: number;
  destination?: string;
  callSign?: string;
  imo?: number;
  length?: number;
  width?: number;
  draught?: number;
  classB?: boolean;
  /** Réception de la position (secondes UTC). */
  at: number;
}


/** Taille d'affichage : les grands navires ont une taille minimale plus grande, et passent dessus. */
type SizeClass = 'petit' | 'moyen' | 'grand';
const SIZE_CLASSES: readonly SizeClass[] = ['petit', 'moyen', 'grand'];
const SIZE_CLASS: Record<ShipType, SizeClass> = {
  cargo: 'grand',
  tanker: 'grand',
  ferry: 'grand',
  peche: 'moyen',
  voilier: 'moyen',
  service: 'moyen',
  plaisance: 'petit',
  remorqueur: 'petit',
};
/** Longueur minimale à l'écran (pixels) d'une coque quand la longueur réelle serait plus petite. */
const MIN_PX: Record<SizeClass, number> = { petit: 12, moyen: 15, grand: 30 };

export interface Ship extends ApiShip {
  type: ShipType;
  sizeClass: SizeClass;
  moving: boolean;
  /** Direction affichée (degrés depuis le nord, sens horaire). */
  bearing: number;
  /** Longueur dessinée (mètres) : celle de l'AIS, sinon la longueur courante du type. */
  sizeM: number;
  hullIcon: string;
  /** Sillage selon la vitesse ; absent à l'arrêt. */
  wakeIcon?: string;
  /** Position extrapolée, mise à jour à chaque pas pour les navires en route. */
  position: [number, number, number];
  /** Maquette 3D, et son échelle [longueur, largeur, hauteur] pour les cotes de l'AIS. */
  model: ShipModel;
  scale: [number, number, number];
  /** Altitude de l'eau à cet endroit (m, 0 au large ; fleuves et bassins) : calculée une fois par version du relief. */
  groundZ: number;
  groundVersion: number;
  /** Classe de largeur de la coque (voir shipIcons.ts), nécessaire pour redire le sillage quand la vitesse change. */
  beam: 0 | 1 | 2;
  /** Relecture : indice du navire dans le tronçon, et s'il existe à l'instant affiché (absent : toujours là). */
  ro?: number;
  here?: boolean;
}

/** Ce qui s'ajoute aux données quand la couche relit l'enregistrement. */
export interface ShipsReplay {
  key: string;
  chunk: DecodedChunk | null;
  absence: string | null;
  /** Tous les navires du tronçon, les plus petits d'abord. */
  all: Ship[];
  /** Pas de temps (secondes) de la dernière mise à jour, pour ne pas la refaire à chaque image. */
  stamp: number;
}

export interface ShipsData {
  ships: Ship[];
  byMmsi: Map<number, Ship>;
  /** Les navires en route (les seuls dont la position change). */
  moving: Ship[];
  /** Par taille, les plus petits d'abord (les grands se dessinent par-dessus). */
  bySize: Record<SizeClass, Ship[]>;
  wakesBySize: Record<SizeClass, Ship[]>;
  /** Par maquette 3D. */
  byModel: Record<ShipModel, Ship[]>;
  /** Les navires qui ont un nom, les plus grands d'abord (ordre de priorité des étiquettes). */
  named: Ship[];
  disabled: string | null;
  updatedAt: number;
  replay?: ShipsReplay;
}

const OUTLINE_KEY: Color = [20, 26, 38, 255];
const RING_HALO: Color = [255, 255, 255, 240];
/**
 * Au-delà, une position n'est plus extrapolée (le navire peut avoir changé de route).
 * Le flux ne transmet qu'une partie des émissions : la position d'un navire en route a
 * souvent une à deux minutes, qu'un navire couvre sans changer de cap.
 */
const MAX_EXTRAPOLATION_S = 300;
const LABEL_MIN_ZOOM = 11;
/** En dessous de ce zoom, les maquettes ne seraient qu'une tache : les silhouettes à plat restent. */
const MESH_MIN_ZOOM = 10;
/** Un nom s'affiche dès que la coque fait cette longueur à l'écran (pixels), ou à partir du zoom ci-dessous quel que soit le navire. */
const LABEL_MIN_PX = 24;
const LABEL_ALL_ZOOM = 15;
const LABEL_FONT = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
/** En dessous, vue de France : tailles minimales réduites, sinon les ports deviennent des pâtés. */
const FAR_ZOOM = 7;
const MID_ZOOM = 10;
const KNOT_MS = 1852 / 3600;
/** Un navire rapide file 20 m/s (40 nœuds). */
const FASTEST_MS = 20;

/** Mètres par pixel d'écran au zoom donné (MapLibre : tuiles de 512 px) et à la latitude donnée. */
const metersPerPixel = (zoom: number, lat = 46.5) => (78_271.52 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;

/** Part de la longueur minimale gardée selon le zoom : plus petite de loin, où les navires sont nombreux. */
const minFactor = (zoom: number) => (zoom < FAR_ZOOM ? 0.5 : zoom < MID_ZOOM ? 0.75 : 1);

/** Longueur d'une coque à l'écran (pixels) à un zoom donné. */
const lengthPx = (ship: Ship, zoom: number) => Math.max(ship.sizeM / metersPerPixel(zoom, ship.lat), MIN_PX[ship.sizeClass] * minFactor(zoom));

/**
 * Intervalle entre deux mises à jour de l'affichage. Les navires avancent d'au plus 20 m/s : redessiner
 * plus souvent que tous les pixels et demi est inutile (au zoom 11, 2 s ; de près, 4 images par seconde au plus).
 */
function stepMs(zoom: number): number {
  return Math.min(Math.max((1.5 * metersPerPixel(zoom) * 1000) / FASTEST_MS, 250), 2000);
}

const NAV_STATUS: Record<number, string> = {
  0: 'en route au moteur',
  1: 'au mouillage',
  2: 'non maître de sa manœuvre',
  3: 'manœuvrabilité restreinte',
  4: 'gêné par son tirant d’eau',
  5: 'amarré',
  6: 'échoué',
  7: 'en pêche',
  8: 'en route à la voile',
  14: 'balise de détresse',
};

function typeLabel(kind: number | undefined): string {
  if (kind === undefined) return 'type inconnu';
  const exact: Record<number, string> = {
    30: 'navire de pêche',
    31: 'remorquage',
    32: 'remorquage',
    33: 'dragage',
    34: 'plongée',
    35: 'navire militaire',
    36: 'voilier',
    37: 'plaisance',
    50: 'pilote',
    51: 'recherche et sauvetage',
    52: 'remorqueur',
    53: 'navette portuaire',
    54: 'antipollution',
    55: 'police',
    58: 'transport médical',
  };
  if (exact[kind]) return exact[kind];
  if (kind >= 20 && kind <= 29) return 'navire à effet de sol';
  if (kind >= 40 && kind <= 49) return 'navire à grande vitesse';
  if (kind >= 60 && kind <= 69) return 'navire à passagers';
  if (kind >= 70 && kind <= 79) return 'cargo';
  if (kind >= 80 && kind <= 89) return 'citerne (pétrolier, chimiquier, gazier)';
  return 'autre type';
}

// --- Données ---

async function loadShips(signal: AbortSignal): Promise<ShipsData> {
  const response = await fetch('/api/bateaux', { signal });
  if (response.status === 503) throw new Error('le serveur se connecte au flux AIS, nouvel essai dans un instant');
  if (!response.ok) throw new Error(`le serveur des bateaux a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; disabled?: string; ships: ApiShip[] };
  const ships: Ship[] = json.ships.map(makeShip);
  // Les petits d'abord, les grands par-dessus.
  ships.sort((a, b) => a.sizeM - b.sizeM);
  return {
    ships,
    byMmsi: new Map(ships.map((s) => [s.mmsi, s])),
    ...derivedLists(ships),
    disabled: json.disabled ?? null,
    updatedAt: json.updatedAt,
  };
}

/** Un navire à partir de sa fiche et de sa dernière position : ce qui se déduit de son identité, puis de sa marche. */
function makeShip(s: ApiShip): Ship {
  const type = shipType(s.kind);
  const declared = s.length && s.length > 0 ? s.length : undefined;
  // Sans longueur : la longueur courante du type ; un petit émetteur (classe B) est un petit bateau.
  const sizeM = Math.min(Math.max(declared ?? (s.classB ? Math.min(NOMINAL_LENGTH[type], 12) : NOMINAL_LENGTH[type]), 3), 400);
  const beam = beamClassOf(type, declared, s.width);
  const model = modelOf(type, sizeM);
  // Largeur dessinée : celle de l'AIS, sauf déclaration absurde (comme pour la classe de largeur des silhouettes).
  const ratio = s.width && declared ? s.width / declared / BEAM_RATIO[type] : 0;
  const beamM = ratio >= 0.3 && ratio <= 3 ? s.width! : sizeM * BEAM_RATIO[type];
  const ship: Ship = {
    ...s,
    name: s.name?.trim() || undefined,
    type,
    sizeClass: SIZE_CLASS[type],
    moving: false,
    bearing: 0,
    sizeM,
    hullIcon: hullKey(type, beam),
    wakeIcon: undefined,
    position: [s.lon, s.lat, 0],
    model,
    scale: scaleOf(model, sizeM, beamM),
    groundZ: 0,
    groundVersion: -1,
    beam,
  };
  applyMotion(ship);
  return ship;
}

/** Ce qui se déduit de la vitesse, de la route et du statut : en route ou non, direction dessinée, sillage. */
function applyMotion(ship: Ship): void {
  ship.moving = (ship.sog ?? 0) >= 0.5 && ship.status !== 1 && ship.status !== 5;
  ship.bearing = ship.heading ?? ship.cog ?? 0;
  const band = ship.moving ? wakeBandOf(ship.sog ?? 0) : -1;
  ship.wakeIcon = band >= 0 ? wakeKey(wakeWidthOf(ship.type, ship.beam), band) : undefined;
}

/** Les listes que le dessin parcourt, pour des navires déjà triés du plus petit au plus grand. */
function derivedLists(ships: Ship[]): Pick<ShipsData, 'moving' | 'bySize' | 'wakesBySize' | 'byModel' | 'named'> {
  const bySize: ShipsData['bySize'] = { petit: [], moyen: [], grand: [] };
  const wakesBySize: ShipsData['wakesBySize'] = { petit: [], moyen: [], grand: [] };
  const byModel = Object.fromEntries(SHIP_MODELS.map((m) => [m, [] as Ship[]])) as ShipsData['byModel'];
  for (const ship of ships) {
    byModel[ship.model].push(ship);
    bySize[ship.sizeClass].push(ship);
    if (ship.wakeIcon) wakesBySize[ship.sizeClass].push(ship);
  }
  return { moving: ships.filter((s) => s.moving), bySize, wakesBySize, byModel, named: ships.filter((s) => s.name).reverse() };
}

// --- Relecture ---

let replayCache: { chunk: DecodedChunk; data: ShipsData } | undefined;
const scratch = newSample();

async function loadShipsReplay(time: number): Promise<ShipsData> {
  const state = await loadReplay('bateaux', time);
  const { chunk } = state;
  const empty = (): ShipsData => ({
    ships: [],
    byMmsi: new Map(),
    ...derivedLists([]),
    disabled: null,
    updatedAt: 0,
    replay: { key: state.key, chunk: null, absence: state.absence, all: [], stamp: NaN },
  });
  if (!chunk) return empty();
  if (replayCache?.chunk === chunk) {
    replayCache.data.replay!.key = state.key; // mêmes navires : on garde les objets (et la sélection)
    return replayCache.data;
  }
  const all: Ship[] = [];
  for (let o = 0; o < chunk.count; o++) all.push(replayShip(chunk, o));
  all.sort((a, b) => a.sizeM - b.sizeM);
  const data: ShipsData = {
    ships: [],
    byMmsi: new Map(all.map((s) => [s.mmsi, s])),
    ...derivedLists([]),
    disabled: null,
    updatedAt: chunk.start,
    replay: { key: state.key, chunk, absence: null, all, stamp: NaN },
  };
  replayCache = { chunk, data };
  return data;
}

/** Le navire `o` du tronçon : sa fiche (écrite une fois par tronçon), sans position ; `updateReplay` le place. */
function replayShip(chunk: DecodedChunk, o: number): Ship {
  const [name, destination, callSign] = chunk.strings[o]!;
  const [kind, imo, length, width, draught, classB] = chunk.numbers[o]!;
  const known = (n: number | undefined) => (n ? n - 1 : undefined);
  const ship = makeShip({
    mmsi: Number(chunk.ids[o]),
    name: name || undefined,
    lon: 0,
    lat: 0,
    kind: known(kind),
    destination: destination || undefined,
    callSign: callSign || undefined,
    imo: known(imo),
    length: known(length),
    width: known(width),
    draught: draught ? (draught - 1) / 10 : undefined,
    classB: classB === 2,
    at: 0,
  });
  ship.ro = o;
  ship.here = false;
  return ship;
}

/** Place le navire à l'instant `time` ; faux (et marqué absent) s'il n'existe pas à cet instant. */
function placeReplayShip(chunk: DecodedChunk, ship: Ship, time: number): boolean {
  if (!sample(chunk, ship.ro!, time, scratch)) {
    ship.here = false;
    return false;
  }
  // Mesures : vitesse et route en dixièmes, cap en degrés, statut de navigation (voir server/src/history/sources.rs).
  const sog = measure(chunk, scratch, 0);
  const cog = measureAngle(chunk, scratch, 1, 10);
  const heading = measureAngle(chunk, scratch, 2);
  const status = measure(chunk, scratch, 3, true);
  ship.sog = sog === undefined ? undefined : sog / 10;
  ship.cog = cog;
  ship.heading = heading === undefined ? undefined : Math.round(heading);
  ship.status = status;
  ship.lon = scratch.lon;
  ship.lat = scratch.lat;
  ship.position[0] = scratch.lon;
  ship.position[1] = scratch.lat;
  ship.at = chunk.start + chunk.t[scratch.i]!;
  ship.here = true;
  applyMotion(ship);
  return true;
}

/** Replace un seul navire (fiche, caméra qui le suit) : l'image n'a pas forcément passé par `deckLayers` avant. */
function refreshReplayShip(data: ShipsData, ship: Ship, time: number): boolean {
  return data.replay?.chunk ? placeReplayShip(data.replay.chunk, ship, time) : false;
}

/** Place tous les navires à l'instant `time` et refait les listes du dessin (au plus une fois par pas de temps). */
function updateReplay(data: ShipsData, time: number): void {
  const replay = data.replay!;
  const chunk = replay.chunk;
  if (!chunk) return;
  const stamp = Math.floor(time / 250);
  if (replay.stamp === stamp) return;
  replay.stamp = stamp;
  prefetchNear('bateaux', time);
  const present: Ship[] = [];
  for (const ship of replay.all) if (placeReplayShip(chunk, ship, time)) present.push(ship);
  data.ships = present;
  Object.assign(data, derivedLists(present));
}

/**
 * Faut-il montrer ces données à cet instant ? En direct, l'horloge doit être dans la fenêtre du direct (les deux dernières
 * minutes, ou un peu plus tard : on extrapole) ; en relecture, plus de deux minutes dans le passé.
 */
function shows(data: ShipsData, time: number): boolean {
  return data.replay ? isReplayTime(time) && data.replay.chunk !== null : !isReplayTime(time) && time <= Date.now() + 60_000;
}

/** Position estimée maintenant : la dernière reçue, prolongée selon la vitesse et la route. */
function extrapolate(ship: Ship, now: number): void {
  const seconds = Math.min(Math.max(now / 1000 - ship.at, 0), MAX_EXTRAPOLATION_S);
  const distance = ship.moving && ship.cog !== undefined ? (ship.sog ?? 0) * KNOT_MS * seconds : 0;
  const rad = ((ship.cog ?? 0) * Math.PI) / 180;
  ship.position[0] = ship.lon + (distance * Math.sin(rad)) / (111_320 * Math.cos((ship.lat * Math.PI) / 180));
  ship.position[1] = ship.lat + (distance * Math.cos(rad)) / 110_540;
}

// --- Étiquettes ---

interface Label {
  ship: Ship;
  /** Décalage vers la droite (pixels) : au-delà de la coque. */
  dx: number;
}

let measureContext: CanvasRenderingContext2D | null | undefined;
function textWidth(text: string): number {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
    if (measureContext) measureContext.font = LABEL_FONT;
  }
  return measureContext ? measureContext.measureText(text).width : text.length * 7;
}

let labelCache: { data: ShipsData; band: number; bucket: number; labels: Label[] } | undefined;

/**
 * Les noms qui tiennent, un quart de niveau de zoom à la fois. Du plus grand navire au plus petit, un nom
 * est posé à droite de sa coque s'il ne recouvre aucun nom déjà posé : calcul exact en pixels (la grille de
 * cases de map/declutter.ts laisse se chevaucher deux noms voisins de part et d'autre d'une limite de case).
 */
function placeLabels(data: ShipsData, zoom: number, bucket: number): Label[] {
  const band = Math.floor(zoom * 4) / 4;
  if (labelCache?.data === data && labelCache.band === band && labelCache.bucket === bucket) return labelCache.labels;
  const world = 512 * 2 ** band;
  const CELL_PX = 64;
  const grid = new Map<number, Array<[number, number, number, number]>>();
  const labels: Label[] = [];
  for (const ship of data.named) {
    const px = lengthPx(ship, band);
    if (px < LABEL_MIN_PX && band < LABEL_ALL_ZOOM) continue;
    const sin = Math.sin((ship.lat * Math.PI) / 180);
    const x = ((ship.lon + 180) / 360) * world;
    const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world;
    const dx = px / 2 + 5;
    const box = [x + dx - 3, y - 8, x + dx + textWidth(ship.name ?? '') + 3, y + 8] as [number, number, number, number];
    const x0 = Math.floor(box[0] / CELL_PX);
    const x1 = Math.floor(box[2] / CELL_PX);
    const y0 = Math.floor(box[1] / CELL_PX);
    const y1 = Math.floor(box[3] / CELL_PX);
    let free = true;
    for (let gx = x0; gx <= x1 && free; gx++) {
      for (let gy = y0; gy <= y1 && free; gy++) {
        for (const other of grid.get(gx * 100_003 + gy) ?? []) {
          if (box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]) {
            free = false;
            break;
          }
        }
      }
    }
    if (!free) continue;
    for (let gx = x0; gx <= x1; gx++) {
      for (let gy = y0; gy <= y1; gy++) {
        const key = gx * 100_003 + gy;
        const cell = grid.get(key);
        if (cell) cell.push(box);
        else grid.set(key, [box]);
      }
    }
    labels.push({ ship, dx });
  }
  labelCache = { data, band, bucket, labels };
  return labels;
}

/** Les cellules de l'atlas ont la coque sur 208 px de leurs 256 : la taille d'une icône est celle de sa cellule. */
const CELL_SCALE = CELL / HULL_LENGTH;

/** Zooms où l'affichage change : tailles minimales, puis étiquettes au quart de niveau. */
const ZOOM_BREAKS = [FAR_ZOOM, MID_ZOOM, MESH_MIN_ZOOM, ...Array.from({ length: (17 - LABEL_MIN_ZOOM) * 4 + 1 }, (_, i) => LABEL_MIN_ZOOM + i / 4)];

export const ships = defineModule<ShipsData>({
  id: 'bateaux',
  name: 'Bateaux',
  category: 'transport',
  description: 'Les navires autour de la France, d’après leurs émissions AIS : en direct, ou relus depuis l’enregistrement du serveur quand on remonte la frise.',
  attribution: 'aisstream.io (AIS)',
  refreshIntervalMs: 15_000,
  timeStepMs: (view) => stepMs(view.zoom),
  zoomBreaks: ZOOM_BREAKS,
  settings: [RENDER_SETTING],

  legend() {
    return [
      ...SHIP_TYPES.map((type) => ({ color: SHIP_COLORS[TYPE_FAMILY[type]], label: SHIP_INFO[type], icon: legendHull(type) })),
      {
        color: SHIP_COLORS.marchandises,
        label: 'Sillage : le navire est en route, d’autant plus long qu’il va vite (à l’arrêt ou amarré : pas de sillage)',
        icon: legendHull('cargo', 2),
      },
      { color: 'transparent', label: 'De près, la coque a la longueur et la largeur que le navire déclare (AIS).' },
    ];
  },

  load: ({ signal, time }) => (isReplayTime(time) ? loadShipsReplay(time) : loadShips(signal)),

  // Bascule entre le direct et la relecture, et d'un tronçon à l'autre.
  needsReload: (data, time) => (isReplayTime(time) ? !data.replay || data.replay.key !== replayKey('bateaux', time) : !!data.replay),

  summary({ data, time }) {
    if (!data) return null;
    if (data.disabled) return `Indisponible : ${data.disabled}.`;
    if (data.replay) {
      if (!isReplayTime(time)) return null;
      if (!data.replay.chunk) return data.replay.absence;
      updateReplay(data, time);
      return `${replayLabel(time)} · ${data.ships.length.toLocaleString('fr-FR')} navires, dont ${data.moving.length.toLocaleString('fr-FR')} en route`;
    }
    if (!shows(data, time)) return null;
    return `En direct · ${data.ships.length.toLocaleString('fr-FR')} navires, dont ${data.moving.length.toLocaleString('fr-FR')} en route`;
  },

  deckLayers({ data, time, terrain, selection, view, settings }) {
    if (!data || data.disabled || !shows(data, time)) return [];
    const now = Date.now();
    // Direct : on prolonge la dernière position. Relecture : la position est déjà celle de l'instant (interpolée).
    if (data.replay) updateReplay(data, time);
    else for (const ship of data.moving) extrapolate(ship, now);
    const atlas = shipAtlas();
    const picked = selection ? data.byMmsi.get((selection as { mmsi: number }).mmsi) : undefined;
    const chosen = picked?.here === false ? undefined : picked; // en relecture, un navire absent n'a pas de position à cet instant
    const factor = minFactor(view.zoom);
    const common = {
      iconAtlas: atlas.atlas,
      iconMapping: atlas.mapping,
      getPosition: (s: Ship) => s.position,
      // À plat sur la mer, orienté selon le cap (deck.gl tourne dans le sens trigonométrique).
      getAngle: (s: Ship) => -s.bearing,
      billboard: false,
      sizeUnits: 'meters' as const,
      getSize: (s: Ship) => s.sizeM,
      sizeScale: CELL_SCALE,
      sizeMaxPixels: 20_000,
      updateTriggers: { getPosition: now },
      parameters: OVER_MAP,
    };
    const models = wants3d(settings) && view.zoom >= MESH_MIN_ZOOM;
    const meshes = models ? shipMeshes() : undefined;
    if (meshes) {
      // Altitude de l'eau (fleuves, bassins) : une fois par version du relief, pas à chaque pas.
      for (const ship of data.ships) {
        if (ship.groundVersion !== terrain.version) {
          ship.groundZ = Math.max(0, terrain.elevation(ship.lon, ship.lat));
          ship.groundVersion = terrain.version;
        }
        ship.position[2] = ship.groundZ;
      }
    } else if (data.ships.length && data.ships[0]!.position[2] !== 0) {
      for (const ship of data.ships) ship.position[2] = 0;
    }
    // Même agrandissement de loin que les silhouettes : la maquette entière, hauteur comprise.
    const zoom = view.zoom;
    const sizeTrigger = zoom.toFixed(2);
    const grow = (s: Ship) => Math.max(1, (MIN_PX[s.sizeClass] * factor * metersPerPixel(zoom, s.lat)) / s.sizeM);
    const minPixels = (cls: SizeClass) => MIN_PX[cls] * factor * CELL_SCALE;
    return [
      // Tous les sillages sous toutes les coques.
      ...SIZE_CLASSES.map(
        (cls) =>
          new IconLayer<Ship>({
            ...common,
            id: `bateaux/sillages-${cls}`,
            data: data.wakesBySize[cls],
            getIcon: (s) => s.wakeIcon!,
            sizeMinPixels: minPixels(cls),
          }),
      ),
      ...(meshes
        ? SHIP_MODELS.map((model) =>
            meshLayer<Ship>({
              id: `bateaux/maquettes/${model}`,
              data: data.byModel[model],
              mesh: meshes[model],
              getPosition: (s) => s.position,
              getOrientation: (s) => orientation(s.bearing),
              getScale: (s) => {
                const g = grow(s);
                return [s.scale[0] * g, s.scale[1] * g, s.scale[2] * g];
              },
              getColor: [255, 255, 255, 255],
              pickable: true,
              updateTriggers: { getPosition: [now, terrain.version], getScale: sizeTrigger },
            }),
          )
        : SIZE_CLASSES.map(
            (cls) =>
              new IconLayer<Ship>({
                ...common,
                id: `bateaux/navires-${cls}`,
                data: data.bySize[cls],
                getIcon: (s) => s.hullIcon,
                sizeMinPixels: minPixels(cls),
                pickable: true,
              }),
          )),
      // Sélection : un anneau blanc sous un anneau sombre (jamais une couleur de plus).
      ...(chosen
        ? [RING_HALO, OUTLINE_KEY].map(
            (color, i) =>
              new ScatterplotLayer<Ship>({
                id: `bateaux/choisi-${i}`,
                data: [chosen],
                getPosition: (s) => s.position,
                radiusUnits: 'meters',
                getRadius: (s) => s.sizeM * 0.7,
                radiusMinPixels: MIN_PX[chosen.sizeClass] * factor * 0.7 + 4,
                filled: false,
                stroked: true,
                getLineColor: color,
                lineWidthUnits: 'pixels',
                getLineWidth: i === 0 ? 7 : 2.5,
                billboard: true,
                updateTriggers: { getPosition: now },
                parameters: OVER_MAP,
              }),
          )
        : []),
      view.zoom >= LABEL_MIN_ZOOM &&
        new TextLayer<Label>({
          id: 'bateaux/noms',
          data: placeLabels(data, view.zoom, data.replay ? Math.floor(time / 5000) : 0),
          getPosition: (l) => l.ship.position,
          getText: (l) => l.ship.name ?? '',
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          // Étiquette de carte : texte sombre, halo clair, pas de pavé.
          fontSettings: { sdf: true },
          outlineWidth: 2.4,
          outlineColor: [255, 255, 255, 235],
          getSize: 12,
          getColor: [31, 38, 51],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: (l) => [l.dx, 0],
          billboard: true,
          updateTriggers: { getPosition: now },
          parameters: OVER_MAP,
        }),
    ];
  },

  select(object) {
    return { mmsi: (object as Ship).mmsi };
  },

  describe(selection, { data, time }) {
    const ship = data?.byMmsi.get((selection as { mmsi: number }).mmsi);
    if (!data || !ship || !shows(data, time) || (data.replay && !refreshReplayShip(data, ship, time))) return null;
    const fields: Array<[string, string]> = [
      ['État', ship.status !== undefined ? (NAV_STATUS[ship.status] ?? (ship.moving ? 'en route' : 'à l’arrêt')) : ship.moving ? 'en route' : 'à l’arrêt'],
    ];
    if (ship.destination) fields.push(['Destination annoncée', ship.destination]);
    // La longueur est dans les chiffres clés : ici, seule la largeur reste à dire.
    if (ship.width) fields.push(['Largeur', `${ship.width} m`]);
    if (ship.draught) fields.push(['Tirant d’eau', `${ship.draught.toLocaleString('fr-FR')} m`]);
    if (ship.callSign) fields.push(['Indicatif', ship.callSign]);
    if (ship.imo) fields.push(['N° OMI', String(ship.imo)]);
    fields.push(['MMSI', String(ship.mmsi)]);
    const hasBearing = ship.heading !== undefined || ship.cog !== undefined;
    return {
      kind: `Navire · ${typeLabel(ship.kind).split(' (')[0]}`,
      title: ship.name ?? `Navire ${ship.mmsi}`,
      subtitle: ship.classB ? 'petit émetteur AIS (classe B)' : undefined,
      // La position est celle que le navire a émise, donnée telle quelle (puis prolongée sur la carte).
      // Direct : fraîcheur de la dernière position reçue. Relecture : l'instant rejoué.
      status: data.replay ? replayStatus(time) : measuredStatus(Date.now(), ship.at * 1000),
      // Nœuds : l'unité de la mer, celle que le navire annonce.
      figures: [
        {
          value: ship.sog !== undefined ? ship.sog.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) : '—',
          unit: ship.sog !== undefined ? 'nœuds' : undefined,
          label: 'vitesse',
        },
        { value: hasBearing ? `${Math.round(ship.bearing)}°` : '—', label: 'cap' },
        { value: ship.length ? String(ship.length) : '—', unit: ship.length ? 'm' : undefined, label: 'de long' },
      ],
      fields,
      note: 'Position, cap et destination sont déclarés par le navire lui-même (AIS) ; la destination est saisie à la main par l’équipage.',
      // Page du navire par MMSI : seul lien stable sans IMO (VesselFinder en exige un).
      actions: [{ label: 'MarineTraffic', href: `https://www.marinetraffic.com/fr/ais/details/ships/mmsi:${ship.mmsi}` }],
    };
  },

  focus(selection, { data, time }) {
    const ship = data?.byMmsi.get((selection as { mmsi: number }).mmsi);
    if (!data || !ship || !shows(data, time)) return null;
    if (data.replay) {
      if (!refreshReplayShip(data, ship, time)) return null;
    } else {
      extrapolate(ship, Date.now());
    }
    return { lon: ship.position[0], lat: ship.position[1] };
  },
});
