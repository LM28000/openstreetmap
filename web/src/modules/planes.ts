/**
 * Module « Avions » : le trafic aérien en temps réel au-dessus de la France, d'après
 * les récepteurs ADS-B de la communauté adsb.lol (licence ODbL).
 *
 * Le serveur (server/src/planes.rs) interroge l'API toutes les 10 secondes. Entre deux
 * collectes, le navigateur fait avancer chaque avion selon sa vitesse, son cap et son
 * taux de montée (extrapolation bornée dans le temps), puis fond le petit écart de
 * correction quand une nouvelle position arrive : pas de saut visible.
 *
 * Les avions sont tracés à leur altitude réelle (sans l'exagération du relief), vus de
 * dessus et tournés selon leur cap. La couleur suit l'altitude (une seule teinte, du
 * clair au foncé) ; la forme dit le genre d'appareil (sept silhouettes, choisies d'après le type
 * OACI : A320, B777, ATR 72…) ; un anneau rouge doublé de blanc signale une urgence (squawk 7500,
 * 7600 ou 7700), pour ne jamais reposer sur la couleur seule.
 *
 * Taille : l'envergure réelle de l'appareil en mètres, avec un minimum en pixels pour rester
 * lisible de loin (un peu plus grand pour un A380 que pour un Cessna).
 *
 * **Relecture.** Le serveur enregistre ce qu'il sert (server/src/history/). Quand l'horloge est à plus de
 * deux minutes dans le passé, la couche passe sur l'enregistrement (core/replay.ts) : chaque avion est placé
 * par interpolation entre ses deux points enregistrés voisins, à l'altitude enregistrée (la caméra qui le suit
 * garde donc son altitude). Pas d'extrapolation : le passé se lit entre deux mesures connues. Là où rien n'a
 * été enregistré, la couche se masque et dit pourquoi.
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule, type InfoContent, type InfoFigure, type LegendItem } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
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
import {
  buildPlaneAtlas,
  planeClass,
  planeSizing,
  PLANE_CLASSES,
  PLANE_NAMES,
  ringDataUrl,
  selectionRingDataUrl,
  type PlaneAtlas,
  type PlaneClass,
  type Shape,
} from './planeIcons';
import { OVER_MAP } from '../map/parameters';
import { aircraftMeshes, groundClearance } from '../models/aircraft';
import { orientation } from '../models/mesh';
import { meshLayer, RENDER_SETTING, wants3d } from '../models/meshLayer';

interface ApiPlane {
  hex: string;
  callsign?: string;
  registration?: string;
  type?: string;
  category?: string;
  lon: number;
  lat: number;
  altBaro?: number;
  altGeom?: number;
  speed?: number;
  track?: number;
  climb?: number;
  squawk?: string;
  emergency?: string;
  ground: boolean;
  seenPos: number;
}

type Band = 0 | 1 | 2 | 3 | 4 | 'ground';

export interface Plane {
  hex: string;
  callsign?: string;
  registration?: string;
  type?: string;
  /** Position au moment de l'observation. */
  lon: number;
  lat: number;
  /** Altitude en mètres au-dessus du niveau de la mer (GPS de préférence), `null` si inconnue. */
  altM: number | null;
  altBaroFt?: number;
  speedKt: number;
  track: number;
  climbFpm: number;
  squawk?: string;
  emergency?: string;
  ground: boolean;
  /** Silhouette, d'après le type OACI (ou la catégorie ADS-B à défaut). */
  cls: PlaneClass;
  band: Band;
  /** Clé de l'icône dans l'atlas (silhouette et couleur d'altitude). */
  icon: string;
  alert: boolean;
  /** Instant de l'observation (ms) : celui de la réception, moins l'âge de la position. */
  observedAt: number;
  /** Écart à résorber (en degrés) entre la position affichée avant la nouvelle collecte et la nouvelle. */
  offLon: number;
  offLat: number;
  offAt: number;
  // Position affichée (recalculée à chaque image) et ombre au sol.
  position: [number, number, number];
  shadow: [number, number, number];
  angle: number;
  /** Inclinaison latérale (degrés, positive vers la droite), déduite du virage entre deux collectes. */
  bank: number;
  groundZ: number;
  groundAt: number;
  groundVersion: number;
  /** Relecture : indice de l'avion dans le tronçon, et s'il existe à l'instant affiché (absent : toujours là). */
  ro?: number;
  here?: boolean;
}

/** Ce qui s'ajoute aux données quand la couche relit l'enregistrement au lieu de recevoir le direct. */
export interface PlanesReplay {
  /** Change quand il faut recharger (autre tronçon, ou on entre dans une plage enregistrée). */
  key: string;
  chunk: DecodedChunk | null;
  /** Pourquoi il n'y a rien à montrer (« Pas d'enregistrement avant le 10 nov. à 21 h »). */
  absence: string | null;
  /** Tous les avions du tronçon (présents ou non), et ceux qui existent à l'instant affiché, remis à jour à chaque image. */
  all: Plane[];
  present: Plane[];
}

export interface PlanesData {
  /** Direct : les avions de la dernière collecte. Relecture : un avion par objet du tronçon (tous, présents ou non). */
  planes: Plane[];
  byHex: Map<string, Plane>;
  /** Instant de la collecte du serveur (ms). */
  collectedAt: number;
  replay?: PlanesReplay;
}

export interface PlanesSelection {
  hex: string;
}

const FT = 0.3048;
const KT = 0.514444;
/** Au-delà, on ne prolonge plus la trajectoire d'un avion dont on n'a plus de nouvelles. */
const MAX_EXTRAPOLATION_S = 40;
/** Durée sur laquelle on résorbe l'écart entre l'ancienne trajectoire et la nouvelle position. */
const SMOOTHING_MS = 5_000;
/** Écart maximal, en degrés, qu'on lisse (au-delà, l'avion a manœuvré : on le laisse sauter). */
const MAX_SMOOTHED_DEG = 0.15;
/** Écart toléré entre l'instant affiché et le présent pour considérer qu'on est « en direct ». */
const STALE_AFTER_S = 60;
const LABEL_MIN_ZOOM = 7.5;
const LABEL_BOX_PX = { width: 88, height: 30 };
const SHADOW_REFRESH_MS = 2_000;

/**
 * Altitude (m) → teinte : une seule, du clair (bas) au foncé (haut). Rampe ordinale validée avec
 * validate_palette.js (--ordinal) : écarts de luminosité réguliers, extrémité claire à 2,09:1 sur le
 * fond clair de la carte, extrémité foncée à 2,02:1 sur le panneau sombre de la légende.
 */
const BAND_COLORS = ['#aca8ff', '#918be5', '#7670c7', '#5d55a9', '#463b8d'] as const;
const GROUND_COLOR = '#cfcdc6';
const BAND_LABELS = ['Moins de 1 000 m', '1 000 à 3 000 m', '3 000 à 6 000 m', '6 000 à 9 000 m', '9 000 m et plus'] as const;
const ALERT_COLOR: Color = [229, 72, 77];
const ALERT_CSS = '#e5484d';
const WHITE: Color = [255, 255, 255, 240];
const INK: Color = [20, 26, 38, 235];
/** Mètres par pixel à l'équateur au zoom 0 (tuiles de 512 px, comme MapLibre). */
const METERS_PER_PIXEL_ZOOM0 = 78_271.517;
/** Rayon des anneaux d'état, en fraction de l'envergure affichée. */
const RING_RADIUS = 0.72;

/** « #rrggbb » → couleur deck.gl. */
function hexColor(hex: string): Color {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const EMERGENCY_SQUAWKS: Record<string, string> = {
  '7500': 'détournement (intervention illicite)',
  '7600': 'panne de radio',
  '7700': 'urgence générale',
};
const EMERGENCY_STATES = new Set(['general', 'nordo', 'unlawful', 'downed']);

let atlasCache: PlaneAtlas | undefined;
function atlas(): PlaneAtlas {
  atlasCache ??= buildPlaneAtlas([
    ...PLANE_CLASSES.flatMap((cls) => BAND_COLORS.map((color, band) => ({ key: `${cls}-${band}`, cls, color }))),
    ...PLANE_CLASSES.map((cls) => ({ key: `${cls}-ground`, cls, color: GROUND_COLOR })),
  ]);
  return atlasCache;
}

let shadowMappingCache: PlaneAtlas['mapping'] | undefined;
/**
 * Les mêmes cases de l'atlas, lues comme des masques : l'ombre prend la forme de l'icône (halo
 * compris) mais une couleur unie, sombre. Lue en couleurs, elle montrerait le halo blanc et
 * deviendrait un fantôme clair sur le fond de nuit.
 */
function shadowMapping(): PlaneAtlas['mapping'] {
  shadowMappingCache ??= Object.fromEntries(Object.entries(atlas().mapping).map(([key, cell]) => [key, { ...cell, mask: true }]));
  return shadowMappingCache;
}

function bandOf(altM: number | null, ground: boolean): Band {
  if (ground || altM === null) return 'ground';
  if (altM < 1000) return 0;
  if (altM < 3000) return 1;
  if (altM < 6000) return 2;
  if (altM < 9000) return 3;
  return 4;
}

/** Indice de silhouette d'après la catégorie ADS-B, à défaut d'après la vitesse : sert quand le type OACI manque. */
function shapeOf(category: string | undefined, speedKt: number): Shape {
  switch (category) {
    case 'A7':
      return 'heli';
    case 'A1':
    case 'A2':
    case 'B1': // planeur
    case 'B4': // ultra-léger
      return 'light';
    case 'A3':
    case 'A4':
    case 'A5':
    case 'A6':
      return 'jet';
    default:
      return speedKt >= 200 ? 'jet' : 'light';
  }
}

function isAlert(squawk: string | undefined, emergency: string | undefined): boolean {
  return (squawk !== undefined && squawk in EMERGENCY_SQUAWKS) || (emergency !== undefined && EMERGENCY_STATES.has(emergency));
}

/** Position d'un avion à l'instant t : sa dernière observation prolongée, plus l'écart en cours de résorption. */
function extrapolate(plane: Plane, time: number): { lon: number; lat: number; altM: number | null } {
  const seconds = Math.min(Math.max((time - plane.observedAt) / 1000, 0), MAX_EXTRAPOLATION_S);
  const metres = plane.speedKt * KT * seconds;
  const radians = (plane.track * Math.PI) / 180;
  const cosLat = Math.cos((plane.lat * Math.PI) / 180);
  const smoothing = Math.max(0, 1 - (time - plane.offAt) / SMOOTHING_MS);
  return {
    lon: plane.lon + (metres * Math.sin(radians)) / (111_320 * cosLat) + plane.offLon * smoothing,
    lat: plane.lat + (metres * Math.cos(radians)) / 110_540 + plane.offLat * smoothing,
    altM: plane.altM === null || plane.ground ? plane.altM : Math.max(0, plane.altM + plane.climbFpm * FT * (seconds / 60)),
  };
}

let previous: PlanesData | undefined;

const G = 9.81;
/** Au-delà, l'écart de cap vient d'un trou dans les données plutôt que d'un virage. */
const MAX_TURN_DEG_S = 6;

/**
 * Inclinaison d'un virage coordonné, d'après le changement de cap entre deux observations :
 * tan(inclinaison) = vitesse × taux de virage / g. Bornée à 30° (un avion de ligne vire à 25° au plus).
 */
function bankAngle(before: Plane, after: Plane): number {
  if (after.ground || after.speedKt < 60) return 0;
  const dt = (after.observedAt - before.observedAt) / 1000;
  if (dt < 3) return before.bank;
  return bankFromRate(after.speedKt, (((after.track - before.track + 540) % 360) - 180) / dt);
}

/** Inclinaison (degrés) d'un avion de vitesse `speedKt` qui tourne de `rate` degrés par seconde. */
function bankFromRate(speedKt: number, rate: number): number {
  if (Math.abs(rate) > MAX_TURN_DEG_S) return 0;
  const bank = (Math.atan((speedKt * KT * rate * Math.PI) / 180 / G) * 180) / Math.PI;
  return Math.max(-30, Math.min(30, bank));
}

/** Assiette (degrés, positive en montée) d'après le taux de montée et la vitesse ; bornée à ±15°. */
function climbAngle(plane: Plane): number {
  if (plane.ground || plane.speedKt < 30) return 0;
  const angle = (Math.atan((plane.climbFpm * FT) / 60 / (plane.speedKt * KT)) * 180) / Math.PI;
  return Math.max(-15, Math.min(15, angle));
}

/** En dessous de ce zoom, les maquettes ne seraient qu'une tache : on garde les silhouettes à plat. */
const MESH_MIN_ZOOM = 6.5;

/**
 * Angle d'icône (degrés, sens trigonométrique depuis la droite de l'écran) d'un avion de cap
 * `track`. Les icônes font toujours face à la caméra (à plat, elles s'écrasent en une ligne
 * quand la carte est très inclinée) : leur angle est celui du cap tel qu'on le voit à
 * l'écran, compte tenu du cap et de l'inclinaison de la carte.
 */
function screenAngle(track: number, bearing: number, pitch: number): number {
  const rad = Math.PI / 180;
  const east = Math.sin(track * rad);
  const north = Math.cos(track * rad);
  const b = bearing * rad;
  // Rotation de la carte (le cap de la carte est en haut de l'écran), puis raccourci dû à l'inclinaison.
  const x = east * Math.cos(b) - north * Math.sin(b);
  const up = (east * Math.sin(b) + north * Math.cos(b)) * Math.cos(pitch * rad);
  return Math.atan2(up, x) / rad;
}

/** Mètres par pixel d'écran à cette latitude et à ce zoom (tuiles de 512 px, comme MapLibre). */
function metersPerPixel(lat: number, zoom: number): number {
  return (METERS_PER_PIXEL_ZOOM0 * Math.max(0.05, Math.cos((lat * Math.PI) / 180))) / 2 ** zoom;
}

/**
 * Part du minimum en pixels conservée selon le zoom : de loin, une centaine d'avions de 15 à 32 px
 * ne feraient qu'une tache ; on les rapetisse (sans les perdre de vue) jusqu'à retrouver la taille
 * pleine au zoom 6,5. Interpolation linéaire : 40 % au zoom 2, 60 % au zoom 4, 100 % à 6,5.
 */
const MINIMUM_SHARE: ReadonlyArray<[zoom: number, share: number]> = [
  [2, 0.4],
  [4, 0.6],
  [6.5, 1],
];

function minimumShare(zoom: number): number {
  if (zoom <= MINIMUM_SHARE[0]![0]) return MINIMUM_SHARE[0]![1];
  for (let i = 1; i < MINIMUM_SHARE.length; i++) {
    const [z1, s1] = MINIMUM_SHARE[i]!;
    const [z0, s0] = MINIMUM_SHARE[i - 1]!;
    if (zoom <= z1) return s0 + ((s1 - s0) * (zoom - z0)) / (z1 - z0);
  }
  return 1;
}

const SIZING = Object.fromEntries(PLANE_CLASSES.map((cls) => [cls, planeSizing(cls)])) as Record<PlaneClass, ReturnType<typeof planeSizing>>;

/**
 * Taille d'un avion à l'écran : son envergure réelle, mais pas moins que le minimum en pixels de sa
 * silhouette. Rend la taille de l'icône (case entière de l'atlas) et l'envergure affichée, en mètres.
 */
function displayed(plane: Plane, zoom: number): { cellMeters: number; spanMeters: number } {
  const { cellMeters, spanMeters, minSpanPx } = SIZING[plane.cls];
  const grow = Math.max(1, (minSpanPx * minimumShare(zoom) * metersPerPixel(plane.lat, zoom)) / spanMeters);
  return { cellMeters: cellMeters * grow, spanMeters: spanMeters * grow };
}

async function loadPlanes(signal: AbortSignal): Promise<PlanesData> {
  const response = await fetch('/api/avions', { signal });
  if (response.status === 503) throw new Error('le serveur n’a pas encore reçu les positions, nouvel essai dans quelques secondes');
  if (!response.ok) throw new Error(`le serveur des avions a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; planes: ApiPlane[] };
  const receivedAt = Date.now();
  // L'âge de la collecte vient de l'horloge du serveur : on le borne pour qu'un décalage d'horloge ne fausse pas tout.
  const collectionAgeS = Math.min(Math.max(receivedAt / 1000 - json.updatedAt, 0), 15);

  const list: Plane[] = json.planes.map((p) => {
    const altBaroM = p.altBaro === undefined ? undefined : p.altBaro * FT;
    const altM = p.altGeom !== undefined ? p.altGeom * FT : (altBaroM ?? null);
    const speedKt = p.speed ?? 0;
    const band = bandOf(altM, p.ground);
    const cls = planeClass(p.type, shapeOf(p.category, speedKt));
    return {
      hex: p.hex,
      callsign: p.callsign,
      registration: p.registration,
      type: p.type,
      lon: p.lon,
      lat: p.lat,
      altM,
      altBaroFt: p.altBaro,
      speedKt,
      track: p.track ?? 0,
      climbFpm: p.climb ?? 0,
      squawk: p.squawk,
      emergency: p.emergency,
      ground: p.ground,
      cls,
      band,
      icon: `${cls}-${band}`,
      alert: isAlert(p.squawk, p.emergency),
      observedAt: receivedAt - (collectionAgeS + p.seenPos) * 1000,
      offLon: 0,
      offLat: 0,
      offAt: receivedAt,
      position: [p.lon, p.lat, 0],
      shadow: [p.lon, p.lat, 0],
      angle: 90 - (p.track ?? 0),
      bank: 0,
      groundZ: 0,
      groundAt: 0,
      groundVersion: -1,
    };
  });

  // Lissage : l'avion était affiché à tel endroit juste avant l'arrivée de la collecte, il doit y rester
  // puis rejoindre peu à peu la position fraîche, au lieu de sauter.
  if (previous) {
    for (const plane of list) {
      const old = previous.byHex.get(plane.hex);
      if (!old) continue;
      plane.bank = bankAngle(old, plane);
      const before = extrapolate(old, receivedAt);
      const after = extrapolate(plane, receivedAt);
      const dLon = before.lon - after.lon;
      const dLat = before.lat - after.lat;
      if (Math.abs(dLon) < MAX_SMOOTHED_DEG && Math.abs(dLat) < MAX_SMOOTHED_DEG) {
        plane.offLon = dLon;
        plane.offLat = dLat;
      }
    }
  }
  const data: PlanesData = { planes: list, byHex: new Map(list.map((p) => [p.hex, p])), collectedAt: json.updatedAt * 1000 };
  previous = data;
  return data;
}

// --- Relecture ---

let replayCache: { chunk: DecodedChunk; data: PlanesData } | undefined;
const scratch = newSample();

async function loadPlanesReplay(time: number): Promise<PlanesData> {
  const state = await loadReplay('avions', time);
  const { chunk } = state;
  if (!chunk) {
    return { planes: [], byHex: new Map(), collectedAt: 0, replay: { key: state.key, chunk: null, absence: state.absence, all: [], present: [] } };
  }
  if (replayCache?.chunk === chunk) {
    replayCache.data.replay!.key = state.key; // mêmes avions : on garde les objets (et la sélection)
    return replayCache.data;
  }
  const list: Plane[] = [];
  for (let o = 0; o < chunk.count; o++) list.push(replayPlane(chunk, o));
  const data: PlanesData = {
    planes: list,
    byHex: new Map(list.map((p) => [p.hex, p])),
    collectedAt: chunk.fetchedAt,
    replay: { key: state.key, chunk, absence: null, all: list, present: [] },
  };
  replayCache = { chunk, data };
  return data;
}

/** L'avion `o` du tronçon : son identité (écrite une fois par tronçon), sans position, que `placeReplayPlane` renseigne. */
function replayPlane(chunk: DecodedChunk, o: number): Plane {
  const [callsign, registration, type, category, squawk, emergency] = chunk.strings[o]!.map((text) => text || undefined);
  const first = chunk.first[o]!;
  const speed = chunk.mask[first]! & 4 ? chunk.cols[2]![first]! : 0;
  const cls = planeClass(type, shapeOf(category, speed));
  return {
    hex: chunk.ids[o]!,
    callsign,
    registration,
    type,
    lon: 0,
    lat: 0,
    altM: null,
    speedKt: 0,
    track: 0,
    climbFpm: 0,
    squawk,
    emergency,
    ground: false,
    cls,
    band: 'ground',
    icon: `${cls}-ground`,
    alert: isAlert(squawk, emergency),
    observedAt: 0,
    offLon: 0,
    offLat: 0,
    offAt: 0,
    position: [0, 0, 0],
    shadow: [0, 0, 0],
    angle: 0,
    bank: 0,
    groundZ: 0,
    groundAt: 0,
    groundVersion: -1,
    ro: o,
    here: false,
  };
}

/**
 * Place l'avion à l'instant `time` par interpolation de l'enregistrement. Rend faux (et le marque absent) s'il n'existe pas
 * à cet instant. `observedAt = time` : l'extrapolation du direct n'ajoute alors rien, la position est déjà celle de l'instant.
 */
function placeReplayPlane(chunk: DecodedChunk, plane: Plane, time: number): boolean {
  if (!sample(chunk, plane.ro!, time, scratch)) {
    plane.here = false;
    return false;
  }
  // Mesures : altitudes en paliers de 25 ft, montée en paliers de 64 ft/min (voir server/src/history/sources.rs).
  const baro = measure(chunk, scratch, 0);
  const geom = measure(chunk, scratch, 1);
  plane.ground = measure(chunk, scratch, 5, true) === 1;
  plane.altBaroFt = baro === undefined ? undefined : baro * 25;
  plane.altM = geom !== undefined ? geom * 25 * FT : baro !== undefined ? baro * 25 * FT : null;
  plane.speedKt = measure(chunk, scratch, 2) ?? 0;
  plane.track = measureAngle(chunk, scratch, 3) ?? 0;
  plane.climbFpm = (measure(chunk, scratch, 4) ?? 0) * 64;
  plane.lon = scratch.lon;
  plane.lat = scratch.lat;
  plane.observedAt = time;
  plane.angle = 90 - plane.track;
  const band = bandOf(plane.altM, plane.ground);
  if (band !== plane.band) {
    plane.band = band;
    plane.icon = `${plane.cls}-${band}`;
  }
  // Inclinaison d'après le virage entre les deux points enregistrés qui encadrent l'instant.
  plane.bank = 0;
  if (scratch.j >= 0 && !plane.ground && plane.speedKt >= 60 && chunk.mask[scratch.i]! & 8 && chunk.mask[scratch.j]! & 8) {
    const dt = chunk.t[scratch.j]! - chunk.t[scratch.i]!;
    if (dt >= 3) plane.bank = bankFromRate(plane.speedKt, (((chunk.cols[3]![scratch.j]! - chunk.cols[3]![scratch.i]! + 540) % 360) - 180) / dt);
  }
  plane.here = true;
  return true;
}

/** Replace un seul avion (fiche, caméra qui le suit) : l'image n'a pas forcément passé par `deckLayers` avant. */
function refreshReplayPlane(data: PlanesData, plane: Plane, time: number): boolean {
  return data.replay?.chunk ? placeReplayPlane(data.replay.chunk, plane, time) : false;
}

/** Remet à jour les avions existant à l'instant `time` et rend leur liste. */
function updateReplay(replay: PlanesReplay, time: number): Plane[] {
  const chunk = replay.chunk;
  replay.present.length = 0;
  if (!chunk) return replay.present;
  prefetchNear('avions', time);
  for (const plane of replay.all) if (placeReplayPlane(chunk, plane, time)) replay.present.push(plane);
  return replay.present;
}

/**
 * Faut-il montrer ces données à cet instant ? En direct, l'horloge doit être dans la fenêtre du direct (les deux dernières
 * minutes, ou un peu plus tard : on extrapole) ; en relecture, plus de deux minutes dans le passé.
 */
function shows(data: PlanesData, time: number): boolean {
  return data.replay ? isReplayTime(time) && data.replay.chunk !== null : !isReplayTime(time) && time <= Date.now() + 60_000;
}

let labelCache: { data: PlanesData; band: number; bucket: number; planes: Plane[] } | undefined;

/**
 * Vu de près, une étiquette par case : l'avion le plus haut (les mieux identifiés d'abord) l'emporte.
 * En relecture, les avions bougent et apparaissent : on refait le choix toutes les 5 s (`bucket`).
 */
function labelled(data: PlanesData, zoom: number, source: Plane[], bucket: number): Plane[] {
  const band = zoomBand(zoom);
  if (labelCache?.data !== data || labelCache.band !== band || labelCache.bucket !== bucket) {
    const candidates = source.filter((p) => p.callsign);
    const kept = declutter(candidates, zoom, { lon: (p) => p.lon, lat: (p) => p.lat, rank: (p) => -(p.altM ?? 0), box: LABEL_BOX_PX });
    labelCache = { data, band, bucket, planes: kept };
  }
  return labelCache.planes;
}

function flightLevel(altBaroFt: number): string {
  return `FL${String(Math.round(altBaroFt / 100)).padStart(3, '0')}`;
}

const nf = (n: number, digits = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });

/** Taux de montée pour la fiche : mètres par seconde, pieds par minute entre parenthèses. */
function describeClimb(fpm: number): string {
  if (Math.abs(fpm) < 100) return 'en palier';
  const mps = Math.abs(fpm * FT) / 60;
  return `${fpm > 0 ? 'monte' : 'descend'} à ${nf(mps, 1)} m/s (${nf(Math.abs(fpm))} ft/min)`;
}

export const planes = defineModule<PlanesData>({
  id: 'avions',
  name: 'Avions',
  category: 'transport',
  description: 'Trafic aérien au-dessus de la France : position, altitude, cap, vitesse. En direct, ou relu depuis l’enregistrement du serveur quand on remonte la frise.',
  attribution: 'adsb.lol (récepteurs ADS-B de la communauté, licence ODbL)',
  refreshIntervalMs: 10_000,
  timeStepMs: 0, // les avions avancent à chaque image
  zoomBreaks: [...halfZoomBreaks(LABEL_MIN_ZOOM), MESH_MIN_ZOOM].sort((a, b) => a - b),
  followsTerrain: true,
  settings: [RENDER_SETTING],

  legend(): LegendItem[] {
    const icons = atlas();
    const items: LegendItem[] = BAND_COLORS.map((color, band) => ({ color, label: BAND_LABELS[band]!, size: 'small' }));
    items.push({ color: GROUND_COLOR, label: 'Au sol (ou altitude inconnue)', size: 'small' });
    items.push({ color: 'transparent', icon: ringDataUrl(ALERT_CSS), label: 'Urgence (anneau rouge) : squawk 7500, 7600, 7700' });
    items.push({ color: 'transparent', icon: selectionRingDataUrl(), label: 'Avion sélectionné (anneau blanc)' });
    // Une ligne par silhouette, à la couleur de la croisière moyenne : la forme dit le type d'appareil.
    for (const cls of PLANE_CLASSES) {
      const { name, examples } = PLANE_NAMES[cls];
      items.push({ color: 'transparent', icon: icons.dataUrl(`${cls}-2`), label: `${name} (${examples})` });
    }
    return items;
  },

  load: ({ signal, time }) => (isReplayTime(time) ? loadPlanesReplay(time) : loadPlanes(signal)),

  // Bascule entre le direct et la relecture, et d'un tronçon à l'autre.
  needsReload: (data, time) => (isReplayTime(time) ? !data.replay || data.replay.key !== replayKey('avions', time) : !!data.replay),

  summary({ data, time }) {
    if (!data) return null;
    if (data.replay) {
      if (!isReplayTime(time)) return null;
      if (!data.replay.chunk) return data.replay.absence;
      const here = updateReplay(data.replay, time);
      const flying = here.filter((p) => !p.ground).length;
      const onGround = here.length - flying;
      const alerts = here.filter((p) => !p.ground && p.alert).length;
      const parts = [`${nf(flying)} avion${flying > 1 ? 's' : ''} en vol`];
      if (onGround > 0) parts.push(`${nf(onGround)} au sol`);
      if (alerts > 0) parts.push(`${nf(alerts)} en urgence`);
      return `${replayLabel(time)} · ${parts.join(', ')}`;
    }
    if (!shows(data, time)) return null;
    const flying = data.planes.filter((p) => !p.ground);
    const alerts = flying.filter((p) => p.alert).length;
    const onGround = data.planes.length - flying.length;
    const age = Math.round((Date.now() - data.collectedAt) / 1000);
    const parts = [`${nf(flying.length)} avion${flying.length > 1 ? 's' : ''} en vol`];
    if (onGround > 0) parts.push(`${nf(onGround)} au sol`);
    if (alerts > 0) parts.push(`${nf(alerts)} en urgence`);
    const stale = age > STALE_AFTER_S ? ` · positions vieilles de ${nf(age)} s : serveur sans nouvelles` : '';
    return `En direct · ${parts.join(', ')}${stale}`;
  },

  deckLayers({ data, time, terrain, selection, view, settings }) {
    if (!data || !shows(data, time)) return [];
    const parameters = OVER_MAP;
    const icons = atlas();
    const now = Date.now();

    // Position de chaque avion à cet instant, à son altitude réelle (sans exagération du relief).
    // En relecture, `observedAt` vaut l'instant affiché : `extrapolate` rend la position interpolée telle quelle.
    const shown: Plane[] = [];
    for (const plane of data.replay ? updateReplay(data.replay, time) : data.planes) {
      const at = extrapolate(plane, time);
      if (now - plane.groundAt > SHADOW_REFRESH_MS || plane.groundVersion !== terrain.version) {
        plane.groundZ = terrain.elevation(at.lon, at.lat);
        plane.groundAt = now;
        plane.groundVersion = terrain.version;
      }
      const z = plane.altM === null || plane.ground ? plane.groundZ + 2 : at.altM!;
      plane.position[0] = at.lon;
      plane.position[1] = at.lat;
      plane.position[2] = z;
      plane.shadow[0] = at.lon;
      plane.shadow[1] = at.lat;
      plane.shadow[2] = plane.groundZ;
      shown.push(plane);
    }
    const chosen = selection ? data.byHex.get((selection as PlanesSelection).hex) : undefined;
    const alerts = shown.filter((p) => p.alert);
    const flying = shown.filter((p) => !p.ground && p.altM !== null);
    const showLabels = view.zoom >= LABEL_MIN_ZOOM;
    const { bearing, pitch, zoom } = view;
    // Les tailles dépendent de l'échelle (mètres réels, avec un minimum en pixels) : on les recalcule quand le zoom change.
    const sizeTrigger = zoom.toFixed(2);
    const iconSize = (p: Plane) => displayed(p, zoom).cellMeters;
    const models = wants3d(settings) && zoom >= MESH_MIN_ZOOM;
    const meshes = models ? aircraftMeshes() : undefined;
    const grow = (p: Plane) => displayed(p, zoom).spanMeters / SIZING[p.cls].spanMeters;
    const bandColor = (p: Plane): Color => hexColor(p.band === 'ground' ? GROUND_COLOR : BAND_COLORS[p.band]);
    const ringRadius = (p: Plane) => RING_RADIUS * displayed(p, zoom).spanMeters;

    return [
      // Ombre au sol : donne la hauteur quand la caméra est inclinée (confondue avec l'avion en vue de dessus).
      new IconLayer<Plane>({
        id: 'avions/ombres',
        data: flying,
        iconAtlas: icons.atlas,
        iconMapping: shadowMapping(),
        getIcon: (p) => p.icon,
        getPosition: (p) => p.shadow,
        getAngle: (p) => p.angle,
        getColor: [0, 0, 0, 56],
        billboard: false,
        sizeUnits: 'meters',
        getSize: iconSize,
        updateTriggers: { getSize: sizeTrigger },
        parameters,
      }),
      chosen &&
        !chosen.ground &&
        // Hauteur de l'avion choisi : un trait blanc cerné de sombre, jamais bleu.
        [
          ['avions/hauteur-contour', INK, 4],
          ['avions/hauteur', WHITE, 1.8],
        ].map(
          ([id, color, width]) =>
            new LineLayer<Plane>({
              id: id as string,
              data: [chosen],
              getSourcePosition: (p) => p.shadow,
              getTargetPosition: (p) => p.position,
              getColor: color as Color,
              getWidth: width as number,
              widthUnits: 'pixels',
              parameters,
            }),
        ),
      meshes &&
        PLANE_CLASSES.map((cls) =>
          meshLayer<Plane>({
            id: `avions/maquettes/${cls}`,
            data: shown.filter((p) => p.cls === cls),
            mesh: meshes[cls],
            getPosition: (p) => p.position,
            getOrientation: (p) => orientation(p.track, climbAngle(p), p.bank),
            getScale: (p) => {
              const g = grow(p);
              return [g, g, g];
            },
            // Au sol, l'avion repose sur son train ; agrandi de loin, il ne doit pas non plus s'enfoncer dans le relief.
            getTranslation: (p) => [0, 0, Math.max(0, p.groundZ + groundClearance(p.cls) * grow(p) - p.position[2])],
            getColor: bandColor,
            pickable: true,
            updateTriggers: { getScale: sizeTrigger, getTranslation: [sizeTrigger, time] },
          }),
        ),
      !meshes &&
      new IconLayer<Plane>({
        id: 'avions/positions',
        data: shown,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: (p) => p.icon,
        getPosition: (p) => p.position,
        getAngle: (p) => screenAngle(p.track, bearing, pitch),
        // Face à la caméra, à l'altitude de l'avion, pointant vers son cap tel qu'on le voit.
        billboard: true,
        sizeUnits: 'meters',
        getSize: iconSize,
        pickable: true,
        updateTriggers: { getSize: sizeTrigger },
        parameters,
      }),
      alerts.length > 0 &&
        // Urgence : anneau rouge doublé de blanc (le blanc dessous), pour se lire sur toute carte.
        [
          ['avions/urgences-blanc', WHITE, 4.5],
          ['avions/urgences', ALERT_COLOR, 2.5],
        ].map(
          ([id, color, width]) =>
            new ScatterplotLayer<Plane>({
              id: id as string,
              data: alerts,
              getPosition: (p) => p.position,
              radiusUnits: 'meters',
              getRadius: ringRadius,
              radiusMinPixels: 9,
              filled: false,
              stroked: true,
              getLineColor: color as Color,
              lineWidthUnits: 'pixels',
              getLineWidth: width as number,
              billboard: true,
              updateTriggers: { getRadius: sizeTrigger },
              parameters,
            }),
        ),
      chosen &&
        // Sélection : anneau blanc cerné de sombre.
        [
          ['avions/choisi-blanc', WHITE, 4.5],
          ['avions/choisi', INK, 1.8],
        ].map(
          ([id, color, width]) =>
            new ScatterplotLayer<Plane>({
              id: id as string,
              data: [chosen],
              getPosition: (p) => p.position,
              radiusUnits: 'meters',
              getRadius: ringRadius,
              radiusMinPixels: 9,
              filled: false,
              stroked: true,
              getLineColor: color as Color,
              lineWidthUnits: 'pixels',
              getLineWidth: width as number,
              billboard: true,
              updateTriggers: { getRadius: sizeTrigger },
              parameters,
            }),
        ),
      showLabels &&
        new TextLayer<Plane>({
          id: 'avions/indicatifs',
          data: labelled(data, view.zoom, data.replay ? shown : data.planes, data.replay ? Math.floor(time / 5000) : 0).filter((p) => !p.ground && p.here !== false),
          getPosition: (p) => p.position,
          getText: (p) => p.callsign ?? '',
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 11.5,
          getColor: [255, 255, 255],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          // À droite de l'anneau d'état, qui grandit avec l'avion de près.
          getPixelOffset: (p) => [Math.max(18, ringRadius(p) / metersPerPixel(p.lat, zoom) + 6), 0],
          background: true,
          getBackgroundColor: [15, 18, 26, 215],
          backgroundPadding: [5, 2],
          backgroundBorderRadius: 4,
          billboard: true,
          updateTriggers: { getPixelOffset: sizeTrigger },
          parameters,
        }),
    ].flat();
  },

  select(object) {
    return { hex: (object as Plane).hex } satisfies PlanesSelection;
  },

  describe(selection, { data, time }): InfoContent | null {
    const plane = data?.byHex.get((selection as PlanesSelection).hex);
    if (!data || !plane || !shows(data, time) || (data.replay && !refreshReplayPlane(data, plane, time))) return null;
    const at = extrapolate(plane, time);
    const fields: Array<[string, string]> = [];
    if (plane.registration) fields.push(['Immatriculation', plane.registration]);
    if (plane.type) fields.push(['Type', plane.type]);
    // Altitude, vitesse et cap sont dans les chiffres clés ; restent la montée et les identifiants.
    if (!plane.ground) fields.push(['Montée', describeClimb(plane.climbFpm)]);
    if (plane.squawk) fields.push(['Squawk', plane.squawk]);
    if (plane.emergency) fields.push(['Urgence déclarée', plane.emergency]);
    fields.push(['Code OACI', plane.hex.toUpperCase()]);

    const figures: InfoFigure[] = [
      plane.ground
        ? { value: '0', unit: 'm', label: 'au sol' }
        : at.altM !== null
          ? { value: nf(at.altM), unit: 'm', label: plane.altBaroFt !== undefined ? `altitude · ${flightLevel(plane.altBaroFt)}` : 'altitude' }
          : { value: '—', label: 'altitude' },
      { value: nf(plane.speedKt * 1.852), unit: 'km/h', label: 'vitesse sol' },
      plane.ground ? { value: '—', label: 'cap' } : { value: `${nf(plane.track)}°`, label: 'cap' },
    ];
    // Direct : fraîcheur de la dernière position reçue. Relecture : l'instant rejoué (la mesure est interpolée).
    const measured = data.replay ? replayStatus(time) : measuredStatus(Date.now(), plane.observedAt);
    // Une urgence passe devant : c'est ce qu'on veut voir en premier, la fraîcheur de la position suit.
    const status = plane.alert ? { ...measured, text: `Urgence · ${measured.text}` } : measured;

    const meaning = plane.squawk ? EMERGENCY_SQUAWKS[plane.squawk] : undefined;
    const alert = meaning
      ? `Code de détresse ${plane.squawk} : ${meaning}. Il s’agit du code affiché sur le transpondeur ; il arrive qu’il soit réglé par erreur ou pour un exercice.`
      : plane.alert
        ? `L’appareil signale une urgence (${plane.emergency}).`
        : undefined;
    return {
      kind: plane.cls === 'heli' ? PLANE_NAMES.heli.name : `Avion · ${PLANE_NAMES[plane.cls].name}`,
      title: plane.callsign ?? plane.registration ?? plane.hex.toUpperCase(),
      status,
      figures,
      fields,
      note: alert,
      actions: [{ label: 'globe.adsb.lol', href: `https://globe.adsb.lol/?icao=${plane.hex}` }],
    };
  },

  focus(selection, { data, time }) {
    const plane = data?.byHex.get((selection as PlanesSelection).hex);
    if (!data || !plane || !shows(data, time) || (data.replay && !refreshReplayPlane(data, plane, time))) return null;
    const at = extrapolate(plane, time);
    // En vol, la caméra vise l'avion lui-même (là où il est dessiné) : de près, on tourne autour de la maquette.
    // En relecture, l'altitude est celle de l'enregistrement.
    return plane.ground || at.altM === null ? { lon: at.lon, lat: at.lat } : { lon: at.lon, lat: at.lat, alt: data.replay ? at.altM : plane.position[2] };
  },
});
