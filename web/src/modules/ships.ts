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
 * Il n'y a pas d'historique : la couche n'existe qu'en direct.
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { formatRelative } from '../ui/format';
import { OVER_MAP } from '../map/parameters';
import {
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

interface Ship extends ApiShip {
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
}

interface ShipsData {
  ships: Ship[];
  byMmsi: Map<number, Ship>;
  /** Les navires en route (les seuls dont la position change). */
  moving: Ship[];
  /** Par taille, les plus petits d'abord (les grands se dessinent par-dessus). */
  bySize: Record<SizeClass, Ship[]>;
  wakesBySize: Record<SizeClass, Ship[]>;
  /** Les navires qui ont un nom, les plus grands d'abord (ordre de priorité des étiquettes). */
  named: Ship[];
  disabled: string | null;
  updatedAt: number;
}

const OUTLINE_KEY: Color = [20, 26, 38, 255];
const RING_HALO: Color = [255, 255, 255, 240];
/**
 * Au-delà, une position n'est plus extrapolée (le navire peut avoir changé de route).
 * Le flux ne transmet qu'une partie des émissions : la position d'un navire en route a
 * souvent une à deux minutes, qu'un navire couvre sans changer de cap.
 */
const MAX_EXTRAPOLATION_S = 300;
const LIVE_TOLERANCE_MS = 60_000;
const LABEL_MIN_ZOOM = 11;
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
  const ships: Ship[] = json.ships.map((s) => {
    const moving = (s.sog ?? 0) >= 0.5 && s.status !== 1 && s.status !== 5;
    const type = shipType(s.kind);
    const declared = s.length && s.length > 0 ? s.length : undefined;
    // Sans longueur : la longueur courante du type ; un petit émetteur (classe B) est un petit bateau.
    const sizeM = Math.min(Math.max(declared ?? (s.classB ? Math.min(NOMINAL_LENGTH[type], 12) : NOMINAL_LENGTH[type]), 3), 400);
    const beam = beamClassOf(type, declared, s.width);
    const band = moving ? wakeBandOf(s.sog ?? 0) : -1;
    return {
      ...s,
      name: s.name?.trim() || undefined,
      type,
      sizeClass: SIZE_CLASS[type],
      moving,
      bearing: s.heading ?? s.cog ?? 0,
      sizeM,
      hullIcon: hullKey(type, beam),
      wakeIcon: band >= 0 ? wakeKey(wakeWidthOf(type, beam), band) : undefined,
      position: [s.lon, s.lat, 0],
    };
  });
  // Les petits d'abord, les grands par-dessus.
  ships.sort((a, b) => a.sizeM - b.sizeM);
  const bySize: ShipsData['bySize'] = { petit: [], moyen: [], grand: [] };
  const wakesBySize: ShipsData['wakesBySize'] = { petit: [], moyen: [], grand: [] };
  for (const ship of ships) {
    bySize[ship.sizeClass].push(ship);
    if (ship.wakeIcon) wakesBySize[ship.sizeClass].push(ship);
  }
  return {
    ships,
    byMmsi: new Map(ships.map((s) => [s.mmsi, s])),
    moving: ships.filter((s) => s.moving),
    bySize,
    wakesBySize,
    named: ships.filter((s) => s.name).reverse(),
    disabled: json.disabled ?? null,
    updatedAt: json.updatedAt,
  };
}

const isLive = (time: number) => Math.abs(time - Date.now()) <= LIVE_TOLERANCE_MS;

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

let labelCache: { data: ShipsData; band: number; labels: Label[] } | undefined;

/**
 * Les noms qui tiennent, un quart de niveau de zoom à la fois. Du plus grand navire au plus petit, un nom
 * est posé à droite de sa coque s'il ne recouvre aucun nom déjà posé : calcul exact en pixels (la grille de
 * cases de map/declutter.ts laisse se chevaucher deux noms voisins de part et d'autre d'une limite de case).
 */
function placeLabels(data: ShipsData, zoom: number): Label[] {
  const band = Math.floor(zoom * 4) / 4;
  if (labelCache?.data === data && labelCache.band === band) return labelCache.labels;
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
  labelCache = { data, band, labels };
  return labels;
}

const knots = (sog: number) =>
  `${sog.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} nœuds (${Math.round(sog * 1.852).toLocaleString('fr-FR')} km/h)`;

/** Les cellules de l'atlas ont la coque sur 208 px de leurs 256 : la taille d'une icône est celle de sa cellule. */
const CELL_SCALE = CELL / HULL_LENGTH;

/** Zooms où l'affichage change : tailles minimales, puis étiquettes au quart de niveau. */
const ZOOM_BREAKS = [FAR_ZOOM, MID_ZOOM, ...Array.from({ length: (17 - LABEL_MIN_ZOOM) * 4 + 1 }, (_, i) => LABEL_MIN_ZOOM + i / 4)];

export const ships = defineModule<ShipsData>({
  id: 'bateaux',
  name: 'Bateaux',
  category: 'transport',
  description: 'Les navires autour de la France en temps réel, d’après leurs émissions AIS.',
  attribution: 'aisstream.io (AIS)',
  refreshIntervalMs: 15_000,
  timeStepMs: (view) => stepMs(view.zoom),
  zoomBreaks: ZOOM_BREAKS,

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

  load: ({ signal }) => loadShips(signal),

  summary({ data, time }) {
    if (!data) return null;
    if (data.disabled) return `Indisponible : ${data.disabled}.`;
    if (!isLive(time)) return 'Hors direct : les bateaux ne sont affichés qu’en temps réel (pas d’historique). Revenez au direct.';
    return `${data.ships.length.toLocaleString('fr-FR')} navires, dont ${data.moving.length.toLocaleString('fr-FR')} en route`;
  },

  deckLayers({ data, time, selection, view }) {
    if (!data || data.disabled || !isLive(time)) return [];
    const now = Date.now();
    for (const ship of data.moving) extrapolate(ship, now);
    const atlas = shipAtlas();
    const chosen = selection ? data.byMmsi.get((selection as { mmsi: number }).mmsi) : undefined;
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
      ...SIZE_CLASSES.map(
        (cls) =>
          new IconLayer<Ship>({
            ...common,
            id: `bateaux/navires-${cls}`,
            data: data.bySize[cls],
            getIcon: (s) => s.hullIcon,
            sizeMinPixels: minPixels(cls),
            pickable: true,
          }),
      ),
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
          data: placeLabels(data, view.zoom),
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
    if (!ship || !isLive(time)) return null;
    const fields: Array<[string, string]> = [
      ['État', ship.status !== undefined ? (NAV_STATUS[ship.status] ?? (ship.moving ? 'en route' : 'à l’arrêt')) : ship.moving ? 'en route' : 'à l’arrêt'],
    ];
    if (ship.sog !== undefined) fields.push(['Vitesse', knots(ship.sog)]);
    if (ship.heading !== undefined || ship.cog !== undefined) fields.push(['Cap', `${Math.round(ship.bearing)}°`]);
    if (ship.destination) fields.push(['Destination annoncée', ship.destination]);
    if (ship.length) fields.push(['Dimensions', `${ship.length} m${ship.width ? ` × ${ship.width} m` : ''}`]);
    if (ship.draught) fields.push(['Tirant d’eau', `${ship.draught.toLocaleString('fr-FR')} m`]);
    if (ship.callSign) fields.push(['Indicatif', ship.callSign]);
    if (ship.imo) fields.push(['N° OMI', String(ship.imo)]);
    fields.push(['MMSI', String(ship.mmsi)], ['Position reçue', formatRelative(ship.at * 1000)]);
    return {
      title: ship.name ?? `Navire ${ship.mmsi}`,
      subtitle: `${typeLabel(ship.kind)}${ship.classB ? ' · petit émetteur AIS (classe B)' : ''}`,
      fields,
      note: 'Position, cap et destination sont déclarés par le navire lui-même (AIS) ; la destination est saisie à la main par l’équipage.',
      link: { href: `https://www.marinetraffic.com/fr/ais/details/ships/mmsi:${ship.mmsi}`, label: 'Voir sur MarineTraffic' },
    };
  },

  focus(selection, { data, time }) {
    const ship = data?.byMmsi.get((selection as { mmsi: number }).mmsi);
    if (!ship || !isLive(time)) return null;
    extrapolate(ship, Date.now());
    return { lon: ship.position[0], lat: ship.position[1] };
  },
});
