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
 * clair au foncé) ; la forme dit le genre d'appareil ; un anneau rouge signale une
 * urgence (squawk 7500, 7600 ou 7700), pour ne jamais reposer sur la couleur seule.
 *
 * Cette couche n'a de sens qu'en direct : quand on rejoue le passé sur la frise, elle
 * se masque et le résumé l'explique (le serveur ne garde pas d'historique des avions).
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, LineLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { formatRelative } from '../ui/format';
import { buildPlaneAtlas, ringDataUrl, type PlaneAtlas, type Shape } from './planeIcons';

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

interface Plane {
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
  shape: Shape;
  band: Band;
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
  groundZ: number;
  groundAt: number;
  groundVersion: number;
}

interface PlanesData {
  planes: Plane[];
  byHex: Map<string, Plane>;
  /** Instant de la collecte du serveur (ms). */
  collectedAt: number;
}

interface PlanesSelection {
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
const LIVE_TOLERANCE_MS = 60_000;
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
const SELECTION_COLOR: Color = [79, 140, 255];
const SHAPES: readonly Shape[] = ['jet', 'light', 'heli'];
const SHAPE_SCALE: Record<Shape, number> = { jet: 1, light: 0.8, heli: 0.8 };

const EMERGENCY_SQUAWKS: Record<string, string> = {
  '7500': 'détournement (intervention illicite)',
  '7600': 'panne de radio',
  '7700': 'urgence générale',
};
const EMERGENCY_STATES = new Set(['general', 'nordo', 'unlawful', 'downed']);

let atlasCache: PlaneAtlas | undefined;
function atlas(): PlaneAtlas {
  atlasCache ??= buildPlaneAtlas([
    ...SHAPES.flatMap((shape) => BAND_COLORS.map((color, band) => ({ key: `${shape}-${band}`, shape, color }))),
    ...SHAPES.map((shape) => ({ key: `${shape}-ground`, shape, color: GROUND_COLOR })),
  ]);
  return atlasCache;
}

function bandOf(altM: number | null, ground: boolean): Band {
  if (ground || altM === null) return 'ground';
  if (altM < 1000) return 0;
  if (altM < 3000) return 1;
  if (altM < 6000) return 2;
  if (altM < 9000) return 3;
  return 4;
}

/** Forme de l'icône d'après la catégorie ADS-B, à défaut d'après la vitesse. */
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
      shape: shapeOf(p.category, speedKt),
      band,
      alert: isAlert(p.squawk, p.emergency),
      observedAt: receivedAt - (collectionAgeS + p.seenPos) * 1000,
      offLon: 0,
      offLat: 0,
      offAt: receivedAt,
      position: [p.lon, p.lat, 0],
      shadow: [p.lon, p.lat, 0],
      angle: 90 - (p.track ?? 0),
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

/** Vrai quand l'instant affiché est le présent : les avions n'existent pas dans le passé. */
function isLive(time: number): boolean {
  return Math.abs(time - Date.now()) <= LIVE_TOLERANCE_MS;
}

let labelCache: { data: PlanesData; band: number; planes: Plane[] } | undefined;

/** Vu de près, une étiquette par case : l'avion le plus haut (les mieux identifiés d'abord) l'emporte. */
function labelled(data: PlanesData, zoom: number): Plane[] {
  const band = zoomBand(zoom);
  if (labelCache?.data !== data || labelCache.band !== band) {
    const candidates = data.planes.filter((p) => p.callsign);
    const kept = declutter(candidates, zoom, { lon: (p) => p.lon, lat: (p) => p.lat, rank: (p) => -(p.altM ?? 0), box: LABEL_BOX_PX });
    labelCache = { data, band, planes: kept };
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
  description: 'Trafic aérien en temps réel au-dessus de la France : position, altitude, cap, vitesse. En direct seulement.',
  attribution: 'adsb.lol (récepteurs ADS-B de la communauté, licence ODbL)',
  refreshIntervalMs: 10_000,
  timeStepMs: 0, // les avions avancent à chaque image
  zoomBreaks: halfZoomBreaks(LABEL_MIN_ZOOM),
  followsTerrain: true,

  legend(): LegendItem[] {
    const icons = atlas();
    const items: LegendItem[] = BAND_COLORS.map((color, band) => ({ color, label: BAND_LABELS[band]!, size: 'small' }));
    items.push({ color: GROUND_COLOR, label: 'Au sol (ou altitude inconnue)', size: 'small' });
    items.push({ color: 'transparent', icon: ringDataUrl(ALERT_CSS), label: 'Urgence (anneau rouge) : squawk 7500, 7600, 7700' });
    items.push({ color: 'transparent', icon: icons.dataUrl('jet-2'), label: 'Avion de ligne ou jet' });
    items.push({ color: 'transparent', icon: icons.dataUrl('light-2'), label: 'Avion léger ou planeur' });
    items.push({ color: 'transparent', icon: icons.dataUrl('heli-2'), label: 'Hélicoptère' });
    return items;
  },

  load: ({ signal }) => loadPlanes(signal),

  summary({ data, time }) {
    if (!isLive(time)) return 'Hors direct : les avions ne sont affichés qu’en temps réel (pas d’historique). Revenez au direct.';
    if (!data) return null;
    const flying = data.planes.filter((p) => !p.ground);
    const alerts = flying.filter((p) => p.alert).length;
    const onGround = data.planes.length - flying.length;
    const age = Math.round((Date.now() - data.collectedAt) / 1000);
    const parts = [`${nf(flying.length)} avion${flying.length > 1 ? 's' : ''} en vol`];
    if (onGround > 0) parts.push(`${nf(onGround)} au sol`);
    if (alerts > 0) parts.push(`${alerts} en urgence`);
    const stale = age > STALE_AFTER_S ? ` · positions vieilles de ${nf(age)} s : serveur sans nouvelles` : '';
    return parts.join(', ') + stale;
  },

  deckLayers({ data, time, terrain, selection, view }) {
    if (!data || !isLive(time)) return [];
    const parameters = { depthCompare: 'always', depthWriteEnabled: false } as const;
    const icons = atlas();
    const now = Date.now();

    // Position de chaque avion à cet instant, à son altitude réelle (sans exagération du relief).
    const shown: Plane[] = [];
    for (const plane of data.planes) {
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
    const iconOf = (p: Plane) => `${p.shape}-${p.band}`;
    const showLabels = view.zoom >= LABEL_MIN_ZOOM;
    const { bearing, pitch } = view;

    return [
      // Ombre au sol : donne la hauteur quand la caméra est inclinée (confondue avec l'avion en vue de dessus).
      new IconLayer<Plane>({
        id: 'avions/ombres',
        data: flying,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: iconOf,
        getPosition: (p) => p.shadow,
        getAngle: (p) => p.angle,
        getColor: [0, 0, 0, 70],
        billboard: false,
        sizeUnits: 'meters',
        getSize: (p) => 3000 * SHAPE_SCALE[p.shape],
        sizeMinPixels: 12,
        sizeMaxPixels: 26,
        parameters,
      }),
      chosen &&
        !chosen.ground &&
        new LineLayer<Plane>({
          id: 'avions/hauteur',
          data: [chosen],
          getSourcePosition: (p) => p.shadow,
          getTargetPosition: (p) => p.position,
          getColor: [...SELECTION_COLOR, 200],
          getWidth: 1.5,
          widthUnits: 'pixels',
          parameters,
        }),
      new IconLayer<Plane>({
        id: 'avions/positions',
        data: shown,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: iconOf,
        getPosition: (p) => p.position,
        getAngle: (p) => screenAngle(p.track, bearing, pitch),
        // Face à la caméra, à l'altitude de l'avion, pointant vers son cap tel qu'on le voit.
        billboard: true,
        sizeUnits: 'meters',
        getSize: (p) => 3000 * SHAPE_SCALE[p.shape],
        sizeMinPixels: 16,
        sizeMaxPixels: 32,
        pickable: true,
        parameters,
      }),
      alerts.length > 0 &&
        new ScatterplotLayer<Plane>({
          id: 'avions/urgences',
          data: alerts,
          getPosition: (p) => p.position,
          radiusUnits: 'pixels',
          getRadius: 20,
          filled: false,
          stroked: true,
          getLineColor: ALERT_COLOR,
          lineWidthUnits: 'pixels',
          getLineWidth: 4,
          billboard: true,
          parameters,
        }),
      chosen &&
        new ScatterplotLayer<Plane>({
          id: 'avions/choisi',
          data: [chosen],
          getPosition: (p) => p.position,
          radiusUnits: 'pixels',
          getRadius: 17,
          filled: false,
          stroked: true,
          getLineColor: SELECTION_COLOR,
          lineWidthUnits: 'pixels',
          getLineWidth: 2.5,
          billboard: true,
          parameters,
        }),
      showLabels &&
        new TextLayer<Plane>({
          id: 'avions/indicatifs',
          data: labelled(data, view.zoom).filter((p) => !p.ground),
          getPosition: (p) => p.position,
          getText: (p) => p.callsign ?? '',
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 11.5,
          getColor: [255, 255, 255],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: [14, 0],
          background: true,
          getBackgroundColor: [15, 18, 26, 215],
          backgroundPadding: [5, 2],
          backgroundBorderRadius: 4,
          billboard: true,
          parameters,
        }),
    ];
  },

  select(object) {
    return { hex: (object as Plane).hex } satisfies PlanesSelection;
  },

  describe(selection, { data, time }): InfoContent | null {
    const plane = data?.byHex.get((selection as PlanesSelection).hex);
    if (!plane || !isLive(time)) return null;
    const at = extrapolate(plane, time);
    const fields: Array<[string, string]> = [];
    if (plane.registration) fields.push(['Immatriculation', plane.registration]);
    if (plane.type) fields.push(['Type', plane.type]);
    if (plane.ground) {
      fields.push(['Altitude', 'au sol']);
    } else if (at.altM !== null) {
      const level = plane.altBaroFt !== undefined ? ` · ${flightLevel(plane.altBaroFt)}` : '';
      fields.push(['Altitude', `${nf(at.altM)} m (${nf(at.altM / FT)} ft)${level}`]);
    }
    if (plane.speedKt > 0 || !plane.ground) fields.push(['Vitesse sol', `${nf(plane.speedKt * 1.852)} km/h (${nf(plane.speedKt)} nœuds)`]);
    if (!plane.ground) {
      fields.push(['Cap', `${nf(plane.track)}°`]);
      fields.push(['Montée', describeClimb(plane.climbFpm)]);
    }
    if (plane.squawk) fields.push(['Squawk', plane.squawk]);
    if (plane.emergency) fields.push(['Urgence déclarée', plane.emergency]);
    fields.push(['Position vue', formatRelative(plane.observedAt, time)]);

    const meaning = plane.squawk ? EMERGENCY_SQUAWKS[plane.squawk] : undefined;
    const alert = meaning
      ? `Code de détresse ${plane.squawk} : ${meaning}. Il s’agit du code affiché sur le transpondeur ; il arrive qu’il soit réglé par erreur ou pour un exercice.`
      : plane.alert
        ? `L’appareil signale une urgence (${plane.emergency}).`
        : undefined;
    return {
      title: plane.callsign ?? plane.registration ?? plane.hex.toUpperCase(),
      subtitle: `ICAO ${plane.hex.toUpperCase()}`,
      fields,
      note: alert,
      link: { href: `https://globe.adsb.lol/?icao=${plane.hex}`, label: 'Suivre sur globe.adsb.lol' },
    };
  },

  focus(selection, { data, time }) {
    const plane = data?.byHex.get((selection as PlanesSelection).hex);
    if (!plane || !isLive(time)) return null;
    const at = extrapolate(plane, time);
    return { lon: at.lon, lat: at.lat };
  },
});
