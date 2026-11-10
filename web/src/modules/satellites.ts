/**
 * Module « Satellites » : stations spatiales, satellites brillants, navigation (GPS,
 * Galileo) et météo, à leur position à l'instant affiché, avec en option les ~9 000
 * satellites Starlink.
 *
 * Les éléments orbitaux viennent de CelesTrak, relevés par le serveur
 * (server/src/satellites.rs) ; le navigateur applique le modèle SGP4 (satellite.js)
 * à l'instant de l'horloge : le replay et l'accéléré fonctionnent sans rien demander de plus.
 * Le détail du calcul et de son coût est dans `orbits.ts`.
 *
 * Altitude : 400 km pour l'ISS, 20 000 km pour le GPS. À l'échelle, la première serait
 * invisible et la seconde hors de l'écran en vue plate. Chaque satellite est donc
 * soulevé au-dessus de sa position au sol d'une hauteur *en pixels* qui croît avec le
 * logarithme de l'altitude (≈ 20 px pour l'ISS, ≈ 55 px pour le GPS), reliée au sol par
 * une tige : l'ordre des altitudes se lit, l'échelle non (la légende le dit). Vue de
 * dessus, la hauteur disparaît et le satellite est exactement à la verticale de son point.
 *
 * Identité : quatre familles, distinguées par la forme et par la couleur (jamais la
 * couleur seule) ; les stations portent en plus leur nom. Un satellite pâle est dans
 * l'ombre de la Terre (donc invisible à l'œil nu).
 */
import type { Color, Position } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { defineModule, type InfoContent } from '../core/module';
import { formatDateTime, formatRelative } from '../ui/format';
import {
  type ApiSatellite,
  OrbitSampler,
  type Positions,
  type Satellite,
  exactAt,
  groundTrack,
  toSatellite,
  visibilityFrom,
} from './orbits';
import { type Shape, ShapeExtension } from './shapeExtension';
import { OVER_MAP } from '../map/parameters';

type Family = 'station' | 'nav' | 'weather' | 'bright';

interface SatSet {
  satellites: Satellite[];
  sampler: OrbitSampler;
  byId: Map<number, Satellite>;
  families: Family[];
  /** Satellites de chaque famille (une couche par famille, donc une forme par famille). */
  members: Record<Family, Satellite[]>;
}

interface SatellitesData extends SatSet {
  /** Heure du dernier relevé des éléments orbitaux par le serveur (ms). */
  updatedAt: number;
}

interface ApiResponse {
  updatedAt: number;
  satellites: ApiSatellite[];
}

const FAMILIES: Record<Family, { label: string; color: string; rgb: Color; size: number; shape: Shape }> = {
  station: { label: 'Station spatiale (ISS, Tiangong)', color: '#e5622f', rgb: [229, 98, 47], size: 30, shape: 'star' },
  nav: { label: 'Navigation (GPS, Galileo)', color: '#2a78d6', rgb: [42, 120, 214], size: 17, shape: 'diamond' },
  weather: { label: 'Météo', color: '#17a574', rgb: [23, 165, 116], size: 17, shape: 'triangle' },
  bright: { label: 'Autre satellite brillant', color: '#d03d9a', rgb: [208, 61, 154], size: 16, shape: 'square' },
};
const FAMILY_ORDER: Family[] = ['station', 'nav', 'weather', 'bright'];
const GROUP_FAMILY: Record<string, Family> = {
  stations: 'station',
  'gps-ops': 'nav',
  galileo: 'nav',
  weather: 'weather',
  visual: 'bright',
};
const STARLINK_COLOR = '#6c7586';
const STARLINK_RGB: Color = [108, 117, 134, 215];
const OUTLINE = '#161a26';
const PARAMETERS = OVER_MAP;
/** Mètres par pixel à l'équateur au zoom 0 (tuiles de 512 px, comme MapLibre). */
const METERS_PER_PIXEL_ZOOM0 = 78_271.517;
const DEG = Math.PI / 180;
/** Au-delà de cette vitesse de l'horloge, Starlink est masqué : les satellites feraient plusieurs tours par seconde. */
const STARLINK_MAX_SPEED = 120;
const STARLINK_REFRESH_MS = 3 * 3_600_000;
const STARLINK_RETRY_MS = 60_000;

const withAlpha = (rgb: Color, alpha: number): Color => [rgb[0]!, rgb[1]!, rgb[2]!, alpha];

/** Le groupe « stations » de CelesTrak contient aussi des petits satellites lâchés depuis les stations : seules l'ISS et Tiangong (CSS) en sont. */
const familyOf = (satellite: Satellite): Family =>
  satellite.group === 'stations' && !/^(ISS|CSS) /.test(satellite.name) ? 'bright' : (GROUP_FAMILY[satellite.group] ?? 'bright');

// --- Données ---

function buildSet(list: readonly ApiSatellite[]): SatSet {
  const satellites: Satellite[] = [];
  for (const api of list) {
    const satellite = toSatellite(api, satellites.length);
    if (satellite) satellites.push(satellite);
  }
  const families = satellites.map(familyOf);
  const members: Record<Family, Satellite[]> = { station: [], nav: [], weather: [], bright: [] };
  satellites.forEach((s, i) => members[families[i]!].push(s));
  return {
    satellites,
    sampler: new OrbitSampler(satellites),
    byId: new Map(satellites.map((s) => [s.id, s])),
    families,
    members,
  };
}

async function fetchSatellites(url: string, signal?: AbortSignal): Promise<ApiResponse> {
  const response = await fetch(url, { signal });
  if (response.status === 503) throw new Error('le serveur récupère encore les éléments orbitaux');
  if (!response.ok) throw new Error(`le serveur des satellites a répondu ${response.status}`);
  return (await response.json()) as ApiResponse;
}

// Starlink n'est téléchargé que si on le demande (environ 2 Mo) ; comme la couche est
// redessinée à chaque image, l'arrivée des données se voit dès l'image suivante.
const starlink: { status: 'idle' | 'loading' | 'ready' | 'error'; set?: SatSet; at: number } = { status: 'idle', at: 0 };

function ensureStarlink(): void {
  const now = Date.now();
  const due =
    starlink.status === 'idle' ||
    (starlink.status === 'error' && now - starlink.at > STARLINK_RETRY_MS) ||
    (starlink.status === 'ready' && now - starlink.at > STARLINK_REFRESH_MS);
  if (!due) return;
  const previous = starlink.status === 'ready';
  if (!previous) starlink.status = 'loading';
  starlink.at = now;
  fetchSatellites('/api/satellites/starlink')
    .then((json) => {
      starlink.set = buildSet(json.satellites);
      starlink.status = 'ready';
    })
    .catch((error: unknown) => {
      console.error('[module satellites] Starlink', error);
      starlink.status = previous ? 'ready' : 'error'; // on garde les anciens éléments s'il y en a
    });
}

// --- Vitesse de l'horloge, estimée d'après l'écart entre deux images ---

let speedProbe = { time: 0, real: 0, speed: 1 };

function simulatedSpeed(time: number): number {
  const real = performance.now();
  const elapsed = real - speedProbe.real;
  if (elapsed > 40) {
    const measured = Math.abs(time - speedProbe.time) / elapsed;
    speedProbe = { time, real, speed: Number.isFinite(measured) && speedProbe.time !== 0 ? measured : 1 };
  }
  return speedProbe.speed;
}

// --- Icônes de la légende : les mêmes formes que sur la carte (voir shapeExtension.ts), dessinées une fois ---

const ICON = 64;

function shapePath(ctx: CanvasRenderingContext2D, family: Family): void {
  const c = ICON / 2;
  ctx.beginPath();
  switch (family) {
    case 'station': // étoile à cinq branches
      for (let i = 0; i < 10; i++) {
        const radius = i % 2 === 0 ? 27 : 12;
        const angle = -Math.PI / 2 + (i * Math.PI) / 5;
        ctx.lineTo(c + radius * Math.cos(angle), c + radius * Math.sin(angle));
      }
      break;
    case 'nav': // losange
      ctx.moveTo(c, c - 25);
      ctx.lineTo(c + 22, c);
      ctx.lineTo(c, c + 25);
      ctx.lineTo(c - 22, c);
      break;
    case 'weather': // triangle
      ctx.moveTo(c, c - 24);
      ctx.lineTo(c + 24, c + 19);
      ctx.lineTo(c - 24, c + 19);
      break;
    case 'bright': // carré
      ctx.roundRect(c - 19, c - 19, 38, 38, 5);
      break;
  }
  ctx.closePath();
}

function drawIcon(ctx: CanvasRenderingContext2D, family: Family, color: string, alpha = 1): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  shapePath(ctx, family);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  // Liseré clair à l'intérieur : la forme reste lisible sur la carte claire comme sur la nuit.
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.stroke();
  ctx.restore();
}

interface Icons {
  legend(family: Family): string;
  shadowLegend: string;
  trackLegend: string;
}

let iconsCache: Icons | undefined;

function icons(): Icons {
  if (iconsCache) return iconsCache;
  const legend = new Map<Family, string>();
  for (const family of FAMILY_ORDER) {
    const single = document.createElement('canvas');
    single.width = single.height = ICON;
    const singleContext = single.getContext('2d');
    if (singleContext) drawIcon(singleContext, family, FAMILIES[family].color);
    legend.set(family, single.toDataURL());
  }

  // « Dans l'ombre » : une forme estompée, sans couleur de famille.
  const shadow = document.createElement('canvas');
  shadow.width = shadow.height = ICON;
  const shadowContext = shadow.getContext('2d');
  if (shadowContext) drawIcon(shadowContext, 'bright', '#9ba4b4', 0.42);

  // Trace au sol : un trait plein (futur) prolongé d'un trait pâle (passé).
  const track = document.createElement('canvas');
  track.width = ICON * 2;
  track.height = ICON;
  const trackContext = track.getContext('2d');
  if (trackContext) {
    trackContext.lineCap = 'round';
    trackContext.lineWidth = 9;
    trackContext.strokeStyle = '#eef1f6';
    trackContext.beginPath();
    trackContext.moveTo(8, ICON / 2);
    trackContext.lineTo(ICON - 4, ICON / 2);
    trackContext.stroke();
    trackContext.globalAlpha = 0.4;
    trackContext.beginPath();
    trackContext.moveTo(ICON + 4, ICON / 2);
    trackContext.lineTo(ICON * 2 - 8, ICON / 2);
    trackContext.stroke();
  }

  iconsCache = {
    legend: (family) => legend.get(family) ?? '',
    shadowLegend: shadow.toDataURL(),
    trackLegend: track.toDataURL(),
  };
  return iconsCache;
}

// --- Affichage ---

/**
 * Hauteur d'affichage d'un satellite, en mètres : un nombre de pixels (croissant avec
 * le logarithme de l'altitude) converti à l'échelle de la carte, pour rester lisible à tout zoom.
 */
function liftMeters(altKm: number, lat: number, zoom: number): number {
  const pixels = Math.min(70, Math.max(10, 14 + 9 * Math.log(Math.max(altKm, 200) / 200)));
  return (pixels * METERS_PER_PIXEL_ZOOM0 * Math.max(0.05, Math.cos(lat * DEG))) / 2 ** zoom;
}

/** Position affichée du satellite `index` : au-dessus de son point au sol, ou posé dessus si `ground`. */
function placed(positions: Positions, index: number, zoom: number, target: number[], ground = false): Position {
  const k = index * 3;
  target[0] = positions.lonLatAlt[k]!;
  target[1] = positions.lonLatAlt[k + 1]!;
  target[2] = ground ? 0 : liftMeters(positions.lonLatAlt[k + 2]!, positions.lonLatAlt[k + 1]!, zoom);
  return target as unknown as Position;
}

/** Accesseur deck.gl : écrit dans le tableau `target` fourni, pour ne rien allouer par satellite et par image. */
function positionAccessor(positions: Positions, zoom: number, ground = false) {
  return (satellite: { index: number }): Position => placed(positions, satellite.index, zoom, [0, 0, 0], ground);
}

let mapRef: MapLibreMap | undefined;

/**
 * Sur le globe, les couches sont dessinées « toujours visibles » (sinon le relief et la
 * hauteur des satellites les cacheraient) : ceux de l'autre côté de la Terre
 * apparaîtraient donc par transparence sur la face visible. On masque ceux dont le
 * point au sol est loin du centre de la vue (cosinus de l'angle sous 0,15, soit à
 * peu près au-delà de l'horizon d'une caméra assez proche).
 */
function behindGlobe(positions: Positions): (index: number) => boolean {
  const center = mapRef?.getCenter();
  if (!center || mapRef?.getProjection()?.type !== 'globe') return () => false;
  const sinLat = Math.sin(center.lat * DEG);
  const cosLat = Math.cos(center.lat * DEG);
  const { lonLatAlt } = positions;
  return (index) => {
    const lat = lonLatAlt[index * 3 + 1]! * DEG;
    const dLon = (lonLatAlt[index * 3]! - center.lng) * DEG;
    return sinLat * Math.sin(lat) + cosLat * Math.cos(lat) * Math.cos(dLon) < 0.15;
  };
}

function mapCenter(): { lon: number; lat: number } | null {
  const center = mapRef?.getCenter();
  return center ? { lon: center.lng, lat: center.lat } : null;
}

/** Cherche un satellite sélectionné dans les deux jeux (courant et Starlink). */
function findSatellite(data: SatellitesData | undefined, id: number): { satellite: Satellite; set: SatSet; family?: Family } | null {
  const core = data?.byId.get(id);
  if (data && core) return { satellite: core, set: data, family: data.families[core.index] };
  const extra = starlink.set?.byId.get(id);
  return extra && starlink.set ? { satellite: extra, set: starlink.set } : null;
}

let trackCache: { id: number; bucket: number; track: ReturnType<typeof groundTrack> } | undefined;

function trackOf(satellite: Satellite, time: number) {
  const bucket = Math.floor(time / 30_000);
  if (trackCache?.id !== satellite.id || trackCache.bucket !== bucket) {
    trackCache = { id: satellite.id, bucket, track: groundTrack(satellite, time) };
  }
  return trackCache.track;
}

const nf = (digits = 0) => new Intl.NumberFormat('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const km = nf(0);
const oneDecimal = nf(1);
const twoDecimals = nf(2);

function formatDuration(minutes: number): string {
  if (minutes < 120) return `${oneDecimal.format(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(Math.round(minutes - hours * 60)).padStart(2, '0')} min`;
}

function formatCoordinates(lat: number, lon: number): string {
  return `${oneDecimal.format(Math.abs(lat))}° ${lat >= 0 ? 'N' : 'S'}, ${oneDecimal.format(Math.abs(lon))}° ${lon >= 0 ? 'E' : 'O'}`;
}

/** Visibilité de l'ISS (ou d'un satellite choisi) depuis le centre de la carte, en une phrase. */
function visibilitySentence(satellite: Satellite, time: number, nakedEye = true): string | null {
  const observer = mapCenter();
  const visibility = observer ? visibilityFrom(observer, satellite, time) : null;
  if (!visibility) return null;
  const height = `${Math.round(visibility.elevation)}° de hauteur`;
  if (visibility.elevation <= 0) return 'sous l’horizon';
  // Les satellites de navigation et de météo sont bien trop faibles pour être vus sans instrument.
  if (!nakedEye) return `au-dessus de l’horizon (${height}), trop faible pour l’œil nu`;
  if (visibility.visible) return `visible à l’œil nu (${height})`;
  if (!visibility.sunlit) return `au-dessus de l’horizon (${height}), mais dans l’ombre de la Terre`;
  return `au-dessus de l’horizon (${height}), mais le ciel est trop clair`;
}

const ISS_ID = 25544;

export const satellites = defineModule<SatellitesData>({
  id: 'satellites',
  name: 'Satellites',
  category: 'ciel',
  description:
    'Stations spatiales, satellites brillants, GPS, Galileo et météo à leur position calculée pour l’instant affiché. Altitudes comprimées : l’ordre se lit, pas l’échelle.',
  attribution: 'CelesTrak (éléments orbitaux), modèle SGP4',
  refreshIntervalMs: 3_600_000,
  timeStepMs: 0, // animé : les satellites avancent à chaque image

  settings: [
    {
      id: 'starlink',
      label: 'Starlink',
      options: [
        { value: 'non', label: 'Sans Starlink' },
        { value: 'oui', label: 'Avec Starlink' },
      ],
      defaultValue: 'non',
    },
  ],

  native: {
    // Pas de couche MapLibre : on garde seulement la carte, pour connaître son centre (visibilité de l'ISS).
    add(map) {
      mapRef = map;
    },
    remove() {
      mapRef = undefined;
    },
  },

  legend(settings) {
    const { legend, shadowLegend, trackLegend } = icons();
    return [
      ...FAMILY_ORDER.map((family) => ({
        color: FAMILIES[family].color,
        label: FAMILIES[family].label,
        icon: legend(family),
      })),
      ...(settings.starlink === 'oui' ? [{ color: STARLINK_COLOR, label: 'Starlink (petits points)', size: 'small' as const }] : []),
      { color: '#9ba4b4', label: 'Estompé : dans l’ombre de la Terre', icon: shadowLegend },
      { color: '#eef1f6', label: 'Trace au sol de la sélection : futur plein, passé pâle', icon: trackLegend },
    ];
  },

  async load({ signal }) {
    const json = await fetchSatellites('/api/satellites', signal);
    return { ...buildSet(json.satellites), updatedAt: json.updatedAt * 1000 };
  },

  summary({ data, time, settings }) {
    if (!data) return null;
    const parts = [`${data.satellites.length.toLocaleString('fr-FR')} satellites`];
    if (settings.starlink === 'oui') {
      parts[0] += starlink.set
        ? ` + ${starlink.set.satellites.length.toLocaleString('fr-FR')} Starlink`
        : starlink.status === 'error'
          ? ' (Starlink indisponible)'
          : ' (Starlink : chargement…)';
    }
    const iss = data.byId.get(ISS_ID);
    const sentence = iss ? visibilitySentence(iss, time) : null;
    if (sentence) parts.push(`ISS depuis le centre de la carte : ${sentence}`);
    return parts.join(' · ');
  },

  deckLayers({ data, time, settings, selection, view }) {
    if (!data) return [];
    const zoom = view.zoom;
    const positions = data.sampler.at(time);
    const { satellites: list, families } = data;
    const position = positionAccessor(positions, zoom);
    const hidden = behindGlobe(positions);
    const center = mapRef?.getCenter();
    // Le centre de la vue compte aussi : sur le globe, il décide de ce qui est de l'autre côté.
    const trigger = `${positions.time}:${Math.round(zoom * 20)}:${center ? `${center.lng.toFixed(1)},${center.lat.toFixed(1)}` : ''}`;
    const chosenId = (selection as { id: number } | null)?.id;
    const chosen = chosenId === undefined ? null : findSatellite(data, chosenId);

    const layers = [];

    // Starlink : points gris, sans étiquette ni tige.
    const showStarlink = settings.starlink === 'oui' && simulatedSpeed(time) <= STARLINK_MAX_SPEED;
    if (settings.starlink === 'oui') ensureStarlink();
    if (showStarlink && starlink.set) {
      const set = starlink.set;
      const extra = set.sampler.at(time);
      const extraHidden = behindGlobe(extra);
      layers.push(
        new ScatterplotLayer<Satellite>({
          id: 'satellites/starlink',
          data: set.satellites,
          getPosition: positionAccessor(extra, zoom) as never,
          getRadius: (s) => (extra.state[s.index] === 0 || extraHidden(s.index) ? 0 : 1.7),
          radiusUnits: 'pixels',
          getFillColor: STARLINK_RGB,
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: trigger, getRadius: trigger },
          parameters: PARAMETERS,
        }),
      );
    }

    // Trace au sol de l'objet sélectionné : demi-orbite passée (pâle) et à venir (pleine).
    if (chosen) {
      const track = trackOf(chosen.satellite, time);
      const color = chosen.family ? FAMILIES[chosen.family].rgb : STARLINK_RGB;
      layers.push(
        new PathLayer<Array<[number, number]>>({
          id: 'satellites/trace-passee',
          data: track.past,
          getPath: (d) => d,
          getColor: withAlpha(color, 110),
          widthUnits: 'pixels',
          getWidth: 2.5,
          capRounded: true,
          jointRounded: true,
          parameters: PARAMETERS,
        }),
        new PathLayer<Array<[number, number]>>({
          id: 'satellites/trace-contour',
          data: track.future,
          getPath: (d) => d,
          getColor: [22, 26, 38, 170],
          widthUnits: 'pixels',
          getWidth: 6,
          capRounded: true,
          jointRounded: true,
          parameters: PARAMETERS,
        }),
        new PathLayer<Array<[number, number]>>({
          id: 'satellites/trace-future',
          data: track.future,
          getPath: (d) => d,
          getColor: withAlpha(color, 255),
          widthUnits: 'pixels',
          getWidth: 3,
          capRounded: true,
          jointRounded: true,
          parameters: PARAMETERS,
        }),
      );
    }

    // Tiges : relient chaque satellite à son point au sol (invisibles vu de dessus).
    layers.push(
      new PathLayer<Satellite>({
        id: 'satellites/tiges',
        data: list,
        getPath: (s) => [placed(positions, s.index, zoom, [0, 0, 0], true), placed(positions, s.index, zoom, [0, 0, 0])] as Position[],
        getColor: (s) => (positions.state[s.index] === 0 || hidden(s.index) ? [0, 0, 0, 0] : [22, 26, 38, 110]),
        widthUnits: 'pixels',
        getWidth: 1,
        updateTriggers: { getPath: trigger, getColor: trigger },
        parameters: PARAMETERS,
      }),
    );

    // Un contour sombre un peu plus grand sous chaque forme, pour qu'elle reste lisible sur la carte claire comme sur la nuit.
    for (const family of FAMILY_ORDER) {
      const { rgb, size, shape } = FAMILIES[family];
      const members = data.members[family];
      const radius = (s: Satellite) => (positions.state[s.index] === 0 || hidden(s.index) ? 0 : size / 2);
      const extensions = [new ShapeExtension({ shape })];
      layers.push(
        new ScatterplotLayer<Satellite>({
          id: `satellites/contour-${family}`,
          data: members,
          getPosition: position as never,
          getRadius: (s) => radius(s) + 2.4,
          radiusUnits: 'pixels',
          getFillColor: (s) => [22, 26, 38, positions.state[s.index] === 1 ? 120 : 235],
          billboard: true,
          extensions,
          updateTriggers: { getPosition: trigger, getRadius: trigger, getFillColor: trigger },
          parameters: PARAMETERS,
        }),
        new ScatterplotLayer<Satellite>({
          id: `satellites/${family}`,
          data: members,
          getPosition: position as never,
          getRadius: radius,
          radiusUnits: 'pixels',
          // Dans l'ombre de la Terre : estompé.
          getFillColor: (s) => withAlpha(rgb, positions.state[s.index] === 1 ? 140 : 255),
          billboard: true,
          pickable: true,
          extensions,
          updateTriggers: { getPosition: trigger, getRadius: trigger, getFillColor: trigger },
          parameters: PARAMETERS,
        }),
      );
    }

    // Étiquettes : les stations, et l'objet sélectionné. Peu nombreuses : pas besoin de désencombrer.
    const labelled = list.filter((_, i) => families[i] === 'station' && positions.state[i] !== 0);
    if (chosen?.set === data && !labelled.includes(chosen.satellite)) labelled.push(chosen.satellite);
    if (labelled.length > 0) {
      layers.push(
        new TextLayer<Satellite>({
          id: 'satellites/noms',
          data: labelled,
          getPosition: (s) => placed(positions, s.index, zoom, [0, 0, 0]),
          getText: (s) => s.name,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          characterSet: 'auto',
          getSize: 12.5,
          getColor: [255, 255, 255, 255],
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: (s) => [(FAMILIES[families[s.index]!].size >> 1) + 6, 0],
          background: true,
          getBackgroundColor: [22, 26, 38, 215],
          backgroundPadding: [6, 3],
          backgroundBorderRadius: 6,
          billboard: true,
          updateTriggers: { getPosition: trigger },
          parameters: PARAMETERS,
        }),
      );
    }

    // Anneau autour de l'objet sélectionné (deux traits : sombre dessous, clair dessus).
    if (chosen) {
      const index = chosen.satellite.index;
      const set = chosen.set === data ? positions : starlink.set?.sampler.at(time);
      if (set && set.state[index] !== 0 && !behindGlobe(set)(index)) {
        const at = placed(set, index, zoom, [0, 0, 0]);
        for (const [id, radius, color, width] of [
          ['satellites/choisi-ombre', 15, [22, 26, 38, 230], 6],
          ['satellites/choisi', 15, [255, 255, 255, 255], 2.5],
        ] as const) {
          layers.push(
            new ScatterplotLayer<Position>({
              id,
              data: [at],
              getPosition: (d) => d,
              getRadius: radius,
              radiusUnits: 'pixels',
              filled: false,
              stroked: true,
              getLineColor: color as unknown as Color,
              lineWidthUnits: 'pixels',
              getLineWidth: width,
              billboard: true,
              parameters: PARAMETERS,
            }),
          );
        }
      }
    }
    return layers;
  },

  select(object) {
    return { id: (object as Satellite).id };
  },

  describe(selection, { data, time }) {
    const found = findSatellite(data, (selection as { id: number }).id);
    if (!found) return null;
    const { satellite, family } = found;
    const exact = exactAt(satellite, time);
    const fields: InfoContent['fields'] = [
      ['N° NORAD', String(satellite.id)],
      ['Désignation internationale', satellite.intl],
    ];
    if (exact) {
      fields.push(
        ['Altitude', `${km.format(exact.altKm)} km`],
        ['Vitesse', `${twoDecimals.format(exact.speedKmS)} km/s (${km.format(exact.speedKmS * 3600)} km/h)`],
      );
    } else {
      fields.push(['Position', 'indisponible à cet instant (le modèle ne converge plus)']);
    }
    fields.push(
      ['Période', formatDuration(satellite.periodMin)],
      ['Inclinaison', `${oneDecimal.format(satellite.inclination)}°`],
      ['Orbite', `${km.format(satellite.perigeeKm)} × ${km.format(satellite.apogeeKm)} km (périgée × apogée)`],
    );
    if (exact) {
      fields.push(
        ['Au-dessus de', formatCoordinates(exact.lat, exact.lon)],
        ['Éclairage', exact.sunlit ? 'éclairé par le soleil' : 'dans l’ombre de la Terre'],
      );
      const visibility = visibilitySentence(satellite, time, family === 'station' || family === 'bright');
      if (visibility) fields.push(['Depuis le centre de la carte', visibility]);
    }
    fields.push(['Éléments orbitaux', `${formatDateTime(satellite.epoch)} (${formatRelative(satellite.epoch)})`]);

    const gap = Math.abs(time - satellite.epoch);
    return {
      title: satellite.name,
      subtitle: family ? FAMILIES[family].label : 'Constellation Starlink',
      fields,
      note:
        gap > 3 * 86_400_000
          ? 'Les éléments orbitaux sont éloignés de l’instant affiché : la position est approximative, avec une erreur de plusieurs kilomètres qui grandit avec le temps.'
          : 'Altitude affichée comprimée sur la carte. Les éléments orbitaux sont renouvelés par CelesTrak toutes les deux heures.',
    };
  },

  focus(selection, { data, time }) {
    const found = findSatellite(data, (selection as { id: number }).id);
    const exact = found ? exactAt(found.satellite, time) : null;
    return exact ? { lon: exact.lon, lat: exact.lat } : null;
  },
});
