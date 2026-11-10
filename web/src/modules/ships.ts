/**
 * Module « Bateaux » : les navires autour de la France en temps réel, d'après leurs
 * émissions AIS, relayées par le serveur (server/src/ships.rs ; la clé d'aisstream.io
 * reste sur le serveur).
 *
 * Chaque navire est une coque vue de dessus, orientée selon son cap et à la taille de
 * sa longueur réelle vue de près. La couleur dit sa famille (marchandises, passagers,
 * pêche et plaisance) ; la forme dit s'il fait route (proue pointue) ou s'il est à
 * l'arrêt (coque arrondie). Entre deux collectes, les navires en route avancent selon
 * leur vitesse et leur route.
 *
 * Il n'y a pas d'historique : la couche n'existe qu'en direct.
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { formatRelative } from '../ui/format';
import { OVER_MAP } from '../map/parameters';

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

type Family = 'marchandises' | 'passagers' | 'petits' | 'autres';

export interface Ship extends ApiShip {
  family: Family;
  moving: boolean;
  /** Direction affichée (degrés depuis le nord, sens horaire). */
  bearing: number;
  /** Position extrapolée, mise à jour à chaque image. */
  position: [number, number, number];
}

export interface ShipsData {
  ships: Ship[];
  byMmsi: Map<number, Ship>;
  disabled: string | null;
  updatedAt: number;
}

/** Palette validée (sur la mer et sur la terre du fond de carte), et un gris pour le reste. */
const FAMILIES: Record<Family, { color: string; label: string }> = {
  marchandises: { color: '#a3262a', label: 'Marchandises : cargos, porte-conteneurs, citernes' },
  passagers: { color: '#a66b00', label: 'Passagers : ferries, croisières, navettes rapides' },
  petits: { color: '#00897a', label: 'Pêche et plaisance' },
  autres: { color: '#6b7280', label: 'Autres ou type inconnu (remorqueurs, pilotes, services…)' },
};
const FAMILY_ORDER: Family[] = ['marchandises', 'passagers', 'petits', 'autres'];
const OUTLINE = '#161a26';
const ICON = 64;
const ACCENT: Color = [79, 140, 255];
/**
 * Au-delà, une position n'est plus extrapolée (le navire peut avoir changé de route).
 * Le flux ne transmet qu'une partie des émissions : la position d'un navire en route a
 * souvent une à deux minutes, qu'un navire couvre sans changer de cap.
 */
const MAX_EXTRAPOLATION_S = 300;
const LIVE_TOLERANCE_MS = 60_000;
const LABEL_MIN_ZOOM = 11;
/** En dessous, vue de France : icônes plus petites, sinon les ports deviennent des pâtés. */
const FAR_ZOOM = 7;
const KNOT_MS = 1852 / 3600;

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

function familyOf(kind: number | undefined): Family {
  if (kind === undefined) return 'autres';
  if (kind >= 70 && kind <= 89) return 'marchandises';
  if ((kind >= 60 && kind <= 69) || (kind >= 40 && kind <= 49)) return 'passagers';
  if (kind === 30 || kind === 36 || kind === 37) return 'petits';
  return 'autres';
}

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

// --- Icônes : coques vues de dessus, proue vers le haut ---

function hullPath(ctx: CanvasRenderingContext2D, moving: boolean): void {
  const cx = ICON / 2;
  const half = 13;
  ctx.beginPath();
  if (moving) {
    // Proue pointue en haut, poupe carrée en bas.
    ctx.moveTo(cx, 4);
    ctx.quadraticCurveTo(cx + half, 18, cx + half, 30);
    ctx.lineTo(cx + half, 58);
    ctx.lineTo(cx - half, 58);
    ctx.lineTo(cx - half, 30);
    ctx.quadraticCurveTo(cx - half, 18, cx, 4);
  } else {
    // À l'arrêt : coque arrondie aux deux bouts.
    ctx.moveTo(cx - half, 16);
    ctx.arc(cx, 16, half, Math.PI, 0);
    ctx.lineTo(cx + half, 48);
    ctx.arc(cx, 48, half, 0, Math.PI);
    ctx.closePath();
  }
}

interface ShipAtlas {
  atlas: string;
  mapping: Record<string, { x: number; y: number; width: number; height: number; anchorX: number; anchorY: number; mask: boolean }>;
  urls: Map<string, string>;
}

let atlasCache: ShipAtlas | undefined;

function iconKey(family: Family, moving: boolean): string {
  return `${family}-${moving ? 'route' : 'arret'}`;
}

function shipAtlas(): ShipAtlas {
  if (atlasCache) return atlasCache;
  const keys = FAMILY_ORDER.flatMap((family) => [true, false].map((moving) => ({ family, moving })));
  const canvas = document.createElement('canvas');
  canvas.width = keys.length * ICON;
  canvas.height = ICON;
  const ctx = canvas.getContext('2d');
  const mapping: ShipAtlas['mapping'] = {};
  const urls = new Map<string, string>();
  keys.forEach(({ family, moving }, i) => {
    const draw = (c: CanvasRenderingContext2D) => {
      hullPath(c, moving);
      c.fillStyle = FAMILIES[family].color;
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = OUTLINE;
      c.stroke();
    };
    if (ctx) {
      ctx.save();
      ctx.translate(i * ICON, 0);
      draw(ctx);
      ctx.restore();
    }
    const key = iconKey(family, moving);
    mapping[key] = { x: i * ICON, y: 0, width: ICON, height: ICON, anchorX: ICON / 2, anchorY: ICON / 2, mask: false };
    const single = document.createElement('canvas');
    single.width = ICON;
    single.height = ICON;
    const singleCtx = single.getContext('2d');
    if (singleCtx) {
      draw(singleCtx);
      urls.set(key, single.toDataURL());
    }
  });
  atlasCache = { atlas: canvas.toDataURL(), mapping, urls };
  return atlasCache;
}

// --- Données ---

async function loadShips(signal: AbortSignal): Promise<ShipsData> {
  const response = await fetch('/api/bateaux', { signal });
  if (response.status === 503) throw new Error('le serveur se connecte au flux AIS, nouvel essai dans un instant');
  if (!response.ok) throw new Error(`le serveur des bateaux a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; disabled?: string; ships: ApiShip[] };
  const ships: Ship[] = json.ships.map((s) => {
    const moving = (s.sog ?? 0) >= 0.5 && s.status !== 1 && s.status !== 5;
    return {
      ...s,
      name: s.name?.trim() || undefined,
      family: familyOf(s.kind),
      moving,
      bearing: s.heading ?? s.cog ?? 0,
      position: [s.lon, s.lat, 0],
    };
  });
  // Les petits d'abord, les grands par-dessus.
  ships.sort((a, b) => (a.length ?? 0) - (b.length ?? 0));
  return { ships, byMmsi: new Map(ships.map((s) => [s.mmsi, s])), disabled: json.disabled ?? null, updatedAt: json.updatedAt };
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

let labelCache: { data: ShipsData; band: number; ships: Ship[] } | undefined;

/** Vu de près, un nom par case : le plus grand navire l'emporte. */
function labelled(data: ShipsData, zoom: number): Ship[] {
  const band = zoomBand(zoom);
  if (labelCache?.data !== data || labelCache.band !== band) {
    const named = data.ships.filter((s) => s.name);
    const ships = declutter(named, zoom, { lon: (s) => s.lon, lat: (s) => s.lat, rank: (s) => -(s.length ?? 0), box: { width: 120, height: 26 } });
    labelCache = { data, band, ships };
  }
  return labelCache.ships;
}

const knots = (sog: number) =>
  `${sog.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} nœuds (${Math.round(sog * 1.852).toLocaleString('fr-FR')} km/h)`;

export const ships = defineModule<ShipsData>({
  id: 'bateaux',
  name: 'Bateaux',
  category: 'transport',
  description: 'Les navires autour de la France en temps réel, d’après leurs émissions AIS.',
  attribution: 'aisstream.io (AIS)',
  refreshIntervalMs: 15_000,
  timeStepMs: 0, // les navires en route avancent à chaque image
  zoomBreaks: [FAR_ZOOM, ...halfZoomBreaks(LABEL_MIN_ZOOM)],

  legend() {
    const icons = shipAtlas();
    return [
      ...FAMILY_ORDER.map((f) => ({ color: FAMILIES[f].color, label: FAMILIES[f].label, icon: icons.urls.get(iconKey(f, true)) })),
      { color: FAMILIES.autres.color, label: 'Coque arrondie : à l’arrêt (amarré, au mouillage)', icon: icons.urls.get(iconKey('autres', false)) },
    ];
  },

  load: ({ signal }) => loadShips(signal),

  summary({ data, time }) {
    if (!data) return null;
    if (data.disabled) return `Indisponible : ${data.disabled}.`;
    if (!isLive(time)) return 'Hors direct : les bateaux ne sont affichés qu’en temps réel (pas d’historique). Revenez au direct.';
    const moving = data.ships.filter((s) => s.moving).length;
    return `${data.ships.length.toLocaleString('fr-FR')} navires, dont ${moving.toLocaleString('fr-FR')} en route`;
  },

  deckLayers({ data, time, selection, view }) {
    if (!data || data.disabled || !isLive(time)) return [];
    const now = Date.now();
    for (const ship of data.ships) extrapolate(ship, now);
    const icons = shipAtlas();
    const chosen = selection ? data.byMmsi.get((selection as { mmsi: number }).mmsi) : undefined;
    const parameters = OVER_MAP;
    return [
      new IconLayer<Ship>({
        id: 'bateaux/navires',
        data: data.ships,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: (s) => iconKey(s.family, s.moving),
        getPosition: (s) => s.position,
        // À plat sur la mer, orienté selon le cap (deck.gl tourne dans le sens trigonométrique).
        getAngle: (s) => -s.bearing,
        billboard: false,
        sizeUnits: 'meters',
        // La coque occupe 54 des 64 pixels de l'icône.
        getSize: (s) => Math.max(s.length ?? (s.classB ? 12 : 40), 10) * (ICON / 54),
        // Assez grand de loin pour voir la forme et la couleur, à l'échelle de près.
        sizeMinPixels: view.zoom < FAR_ZOOM ? 10 : 16,
        sizeMaxPixels: 90,
        pickable: true,
        updateTriggers: { getPosition: now },
        parameters,
      }),
      view.zoom >= LABEL_MIN_ZOOM &&
        new TextLayer<Ship>({
          id: 'bateaux/noms',
          data: labelled(data, view.zoom),
          getPosition: (s) => s.position,
          getText: (s) => s.name ?? '',
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 11.5,
          getColor: [255, 255, 255],
          getPixelOffset: [0, -16],
          background: true,
          getBackgroundColor: [15, 18, 26, 215],
          backgroundPadding: [5, 2],
          billboard: true,
          updateTriggers: { getPosition: now },
          parameters,
        }),
      chosen &&
        new ScatterplotLayer<Ship>({
          id: 'bateaux/choisi',
          data: [chosen],
          getPosition: (s) => s.position,
          radiusUnits: 'pixels',
          getRadius: 16,
          filled: false,
          stroked: true,
          getLineColor: ACCENT,
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          billboard: true,
          updateTriggers: { getPosition: now },
          parameters,
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
