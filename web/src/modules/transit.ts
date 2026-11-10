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
 * c'est la forme (rond, carré, losange, triangle) ; un contour clair ou sombre garde chaque couleur lisible.
 *
 * Cette couche n'a de sens qu'en direct : le serveur ne garde pas d'historique des positions.
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { declutter, halfZoomBreaks } from '../map/declutter';
import { bubbleIcon, buildTransitAtlas, legendIcon, type Kind, type TransitAtlas } from './transitIcons';

interface ApiLine {
  network: number;
  id?: string;
  name?: string;
  longName?: string;
  color?: string;
  mode?: 'bus' | 'tram' | 'metro' | 'train' | 'ferry' | 'cable';
}

interface ApiVehicle {
  id: string;
  line: number;
  lon: number;
  lat: number;
  heading?: number;
  speed?: number;
  ts: number;
}

interface ApiTransit {
  updatedAt: number;
  networks: Array<{ name: string; licence: string; vehicles: number }>;
  lines: ApiLine[];
  vehicles: ApiVehicle[];
}

interface Network {
  index: number;
  name: string;
  licence: string;
  count: number;
  /** Centre de ses véhicules : où poser le rond de la vue d'ensemble. */
  lon: number;
  lat: number;
  radius: number;
}

interface Line {
  network: Network;
  id?: string;
  name?: string;
  longName?: string;
  /** Couleur officielle (`#rrggbb`), si le réseau la donne. */
  officialColor?: string;
  mode?: ApiLine['mode'];
  kind: Kind;
}

interface Vehicle {
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
  speedKmh?: number;
  /** Instant de la mesure (ms). */
  ts: number;
  fill: Color;
  halo: Color;
  /** Position affichée (recalculée à chaque image) : [lon, lat, altitude]. */
  position: [number, number, number];
  settled: boolean;
  groundVersion: number;
}

interface TransitData {
  vehicles: Vehicle[];
  byKey: Map<string, Vehicle>;
  networks: Network[];
  lineCount: number;
  collectedAt: number;
  /** Incrémenté quand au moins un véhicule a bougé : déclenche le recalcul des positions par deck.gl. */
  motion: number;
}

type TransitSelection = { type: 'vehicle'; key: string } | { type: 'network'; name: string };

/** Sous ce zoom : un rond par réseau. À partir de là : chaque véhicule. */
const VEHICLES_FROM_ZOOM = 9;
/** À partir de ce zoom : le nom court de la ligne à côté de chaque véhicule. */
const LABELS_FROM_ZOOM = 13;
const LABEL_BOX_PX = { width: 46, height: 24 };
const NETWORK_LABEL_BOX_PX = { width: 120, height: 20 };
const NETWORK_LABEL_FROM_ZOOM = 4.5;

/** Un véhicule glisse vers sa nouvelle position en autant de temps que les deux mesures sont espacées, entre ces bornes. */
const MIN_SPAN_MS = 10_000;
const MAX_SPAN_MS = 40_000;
/** Écart (degrés) au-delà duquel un véhicule a « sauté » (fin de service, retour au dépôt) : on ne l'anime pas. */
const MAX_GLIDE_DEG = 0.03;
/** Une position plus vieille que cela (secondes) est affichée estompée. */
const DIM_AFTER_S = 120;
const LIVE_TOLERANCE_MS = 60_000;
const STALE_AFTER_S = 120;

/**
 * Couleur par mode quand la ligne n'a pas de couleur officielle : une famille de teinte par mode, évitant
 * celles des trains (bleu, orange, vert) et des avions (violet). Palette validée avec validate_palette.js
 * (`--pairs all`) : mode clair sur le fond de la carte et mode sombre sur le panneau (#0f121a), teintes dans
 * les bandes de luminosité, saturation suffisante, écart normal ≥ 22, écart pour les daltoniens 7,6 (avertissement,
 * admis car la forme porte aussi le mode) ; contraste ≥ 3:1 sur les deux fonds.
 */
const MODE_COLORS: Record<Kind, string> = {
  bus: '#d9548f',
  tram: '#0a93a6',
  metro: '#b98a00',
  /** Neutre (train, bateau, câble : rares) et mode inconnu : hors de la palette validée, gris sans teinte. */
  other: '#8b92a1',
};
const UNKNOWN_MODE_COLOR = '#8b92a1';
const OUTLINE_DARK: [number, number, number] = [22, 26, 38];
const OUTLINE_LIGHT: [number, number, number] = [255, 255, 255];
const SELECTION_COLOR: Color = [79, 140, 255];
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
  const hex = line.officialColor ?? (line.mode ? MODE_COLORS[line.kind] : UNKNOWN_MODE_COLOR);
  const base = rgb(hex);
  const alpha = dim ? 110 : 255;
  return { fill: [...base, alpha], halo: [...(luminance(base) > 0.35 ? OUTLINE_DARK : OUTLINE_LIGHT), dim ? 90 : 235], hex };
}

/** Texte lisible (noir ou blanc) sur une couleur de ligne. */
function textColorOn(fill: Color): Color {
  return luminance([fill[0]!, fill[1]!, fill[2]!]) > 0.35 ? [22, 26, 38] : [255, 255, 255];
}

let previous: TransitData | undefined;

async function loadTransit(signal: AbortSignal): Promise<TransitData> {
  const response = await fetch('/api/transports', { signal });
  if (response.status === 503) throw new Error('le serveur n’a pas encore reçu les positions, nouvel essai dans quelques secondes');
  if (!response.ok) throw new Error(`le serveur des transports a répondu ${response.status}`);
  const json = (await response.json()) as ApiTransit;
  const receivedAt = Date.now();

  const networks: Network[] = json.networks.map((n, index) => ({ index, name: n.name, licence: n.licence, count: n.vehicles, lon: 0, lat: 0, radius: 0 }));
  const lines: Line[] = json.lines.map((l) => ({
    network: networks[l.network]!,
    id: l.id,
    name: l.name,
    longName: l.longName,
    officialColor: l.color ? `#${l.color}` : undefined,
    mode: l.mode,
    kind: kindOf(l.mode),
  }));

  const sums = networks.map(() => ({ lon: 0, lat: 0 }));
  const list: Vehicle[] = json.vehicles.map((v) => {
    const line = lines[v.line]!;
    const sum = sums[line.network.index]!;
    sum.lon += v.lon;
    sum.lat += v.lat;
    const ageS = receivedAt / 1000 - v.ts;
    const { fill, halo } = colorsOf(line, ageS > DIM_AFTER_S);
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
      headingDeg: v.heading,
      speedKmh: v.speed,
      ts: v.ts * 1000,
      fill,
      halo,
      position: [v.lon, v.lat, 0],
      settled: true,
      groundVersion: -1,
    };
    // Continuité : le véhicule part de là où on le voyait, et non de sa position précédente.
    const old = previous?.byKey.get(key);
    if (old) {
      if (old.ts === vehicle.ts) {
        // Pas de nouvelle mesure : le mouvement en cours se poursuit.
        Object.assign(vehicle, { fromLon: old.fromLon, fromLat: old.fromLat, arrivedAt: old.arrivedAt, spanMs: old.spanMs, settled: old.settled });
        vehicle.position = old.position;
        vehicle.groundVersion = old.groundVersion;
      } else {
        const shownLon = old.position[0];
        const shownLat = old.position[1];
        if (Math.abs(shownLon - v.lon) < MAX_GLIDE_DEG && Math.abs(shownLat - v.lat) < MAX_GLIDE_DEG && (shownLon !== v.lon || shownLat !== v.lat)) {
          vehicle.fromLon = shownLon;
          vehicle.fromLat = shownLat;
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

/** Vrai quand l'instant affiché est le présent : les positions n'ont pas d'historique. */
function isLive(time: number): boolean {
  return Math.abs(time - Date.now()) <= LIVE_TOLERANCE_MS;
}

/** Place chaque véhicule à l'instant `time` ; renvoie vrai si au moins un a bougé. */
function place(data: TransitData, time: number, terrain: { elevation(lon: number, lat: number): number; version: number }): boolean {
  let moved = false;
  for (const v of data.vehicles) {
    const needsGround = v.groundVersion !== terrain.version;
    if (v.settled && !needsGround) continue;
    if (!v.settled) {
      const p = Math.min(Math.max((time - v.arrivedAt) / v.spanMs, 0), 1);
      v.position[0] = v.fromLon + (v.lon - v.fromLon) * p;
      v.position[1] = v.fromLat + (v.lat - v.fromLat) * p;
      if (p >= 1) v.settled = true;
    } else {
      v.position[0] = v.lon;
      v.position[1] = v.lat;
    }
    if (needsGround) {
      v.position[2] = terrain.elevation(v.position[0], v.position[1]) + 4;
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

const nf = (n: number, digits = 0) => n.toLocaleString('fr-FR', { maximumFractionDigits: digits });

function ageText(ts: number, time: number): string {
  const s = Math.max(0, Math.round((time - ts) / 1000));
  if (s < 5) return 'à l’instant';
  if (s < 90) return `il y a ${s} s`;
  return `il y a ${Math.round(s / 60)} min`;
}

function lineTitle(line: Line): string {
  if (line.name) return `Ligne ${line.name}`;
  if (line.id) return `Ligne ${line.id}`;
  return 'Ligne inconnue';
}

let labelCache: { data: TransitData; band: number; vehicles: Vehicle[] } | undefined;
let networkLabelCache: { data: TransitData; band: number; networks: Network[] } | undefined;
let densityCache: { data: TransitData; byLabel: Vehicle[] } | undefined;

/** Étiquettes de ligne dès le zoom 13, une par case : on préfère les véhicules en mouvement. */
function labelled(data: TransitData, zoom: number): Vehicle[] {
  const band = Math.floor(zoom * 2) / 2;
  if (labelCache?.data !== data || labelCache.band !== band) {
    if (densityCache?.data !== data) densityCache = { data, byLabel: data.vehicles.filter((v) => v.line.name) };
    const kept = declutter(densityCache.byLabel, zoom, {
      lon: (v) => v.lon,
      lat: (v) => v.lat,
      rank: (v) => -(v.speedKmh ?? 0),
      box: LABEL_BOX_PX,
    });
    labelCache = { data, band, vehicles: kept };
  }
  return labelCache.vehicles;
}

function labelledNetworks(data: TransitData, zoom: number): Network[] {
  const band = Math.floor(zoom * 2) / 2;
  if (networkLabelCache?.data !== data || networkLabelCache.band !== band) {
    const kept = declutter(data.networks, zoom, { lon: (n) => n.lon, lat: (n) => n.lat, rank: (n) => -n.count, box: NETWORK_LABEL_BOX_PX });
    networkLabelCache = { data, band, networks: kept };
  }
  return networkLabelCache.networks;
}

function vehicleSize(zoom: number): number {
  if (zoom < 11) return 9;
  if (zoom < 13) return 12;
  return 16;
}

export const transit = defineModule<TransitData>({
  id: 'transports',
  name: 'Bus, trams et métros',
  category: 'transport',
  description:
    'Véhicules des transports urbains en temps réel, dans les villes dont le réseau publie ses positions. Un rond par réseau de loin, chaque véhicule de près. En direct seulement.',
  attribution: 'Réseaux de transport, via transport.data.gouv.fr (Licence Ouverte 2.0 ou ODbL selon le réseau)',
  refreshIntervalMs: 30_000,
  timeStepMs: (view) => glideStepMs(view.zoom),
  zoomBreaks: [...halfZoomBreaks(NETWORK_LABEL_FROM_ZOOM, VEHICLES_FROM_ZOOM), ...halfZoomBreaks(LABELS_FROM_ZOOM)],
  followsTerrain: true,

  legend(): LegendItem[] {
    return [
      { color: MODE_COLORS.bus, icon: legendIcon('bus', MODE_COLORS.bus), label: 'Bus (rond)' },
      { color: MODE_COLORS.tram, icon: legendIcon('tram', MODE_COLORS.tram), label: 'Tramway (carré)' },
      { color: MODE_COLORS.metro, icon: legendIcon('metro', MODE_COLORS.metro), label: 'Métro (losange)' },
      { color: MODE_COLORS.other, icon: legendIcon('other', MODE_COLORS.other), label: 'Train, bateau, câble (triangle)' },
      { color: UNKNOWN_MODE_COLOR, icon: legendIcon('bus', UNKNOWN_MODE_COLOR), label: 'Mode inconnu (rond gris)' },
      { color: 'transparent', icon: bubbleIcon(), label: 'Vue d’ensemble : un rond par réseau, plus gros avec le nombre de véhicules' },
      { color: 'transparent', label: 'La couleur est celle de la ligne quand le réseau la donne ; sinon celle du mode (ci-dessus).' },
    ];
  },

  load: ({ signal }) => loadTransit(signal),

  summary({ data, time }) {
    if (!isLive(time)) return 'Hors direct : les véhicules ne sont affichés qu’en temps réel (pas d’historique). Revenez au direct.';
    if (!data) return null;
    const stale = Math.round((Date.now() - data.collectedAt) / 1000) > STALE_AFTER_S ? ' · serveur sans nouvelles depuis plus de 2 minutes' : '';
    if (data.vehicles.length === 0) return `Aucun véhicule en circulation dans les flux pour l’instant (la nuit, beaucoup de réseaux sont à l’arrêt).${stale}`;
    const n = data.vehicles.length;
    const m = data.networks.length;
    return `${nf(n)} véhicule${n > 1 ? 's' : ''} sur ${nf(m)} réseau${m > 1 ? 'x' : ''}${stale}`;
  },

  deckLayers({ data, time, terrain, selection, view }) {
    if (!data || !isLive(time)) return [];
    const parameters = { depthCompare: 'always', depthWriteEnabled: false } as const;
    const chosen = selection as TransitSelection | null;
    const fontFamily = 'system-ui, -apple-system, "Segoe UI", sans-serif';

    // Vue d'ensemble : un rond par réseau.
    if (view.zoom < VEHICLES_FROM_ZOOM) {
      const selectedName = chosen?.type === 'network' ? chosen.name : undefined;
      return [
        new ScatterplotLayer<Network>({
          id: 'transports/reseaux',
          data: data.networks,
          getPosition: (n) => [n.lon, n.lat, 0],
          radiusUnits: 'pixels',
          getRadius: (n) => n.radius,
          getFillColor: BUBBLE_FILL,
          stroked: true,
          getLineColor: (n) => (n.name === selectedName ? SELECTION_COLOR : [22, 26, 38, 235]),
          getLineWidth: (n) => (n.name === selectedName ? 3 : 1.5),
          lineWidthUnits: 'pixels',
          updateTriggers: { getLineColor: selectedName, getLineWidth: selectedName },
          pickable: true,
          billboard: true,
          parameters,
        }),
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
            data: labelledNetworks(data, view.zoom),
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
    if (place(data, time, terrain)) data.motion++;
    const icons = atlas();
    const size = vehicleSize(view.zoom);
    const picked = chosen?.type === 'vehicle' ? data.byKey.get(chosen.key) : undefined;
    const common = {
      data: data.vehicles,
      iconAtlas: icons.atlas,
      iconMapping: icons.mapping,
      getPosition: (v: Vehicle) => v.position,
      sizeUnits: 'pixels' as const,
      getSize: size,
      billboard: true,
      parameters,
    };
    return [
      new IconLayer<Vehicle>({
        ...common,
        id: 'transports/contours',
        getIcon: (v) => `${v.line.kind}-halo`,
        getColor: (v) => v.halo,
        updateTriggers: { getPosition: [data.motion, terrain.version] },
      }),
      new IconLayer<Vehicle>({
        ...common,
        id: 'transports/vehicules',
        getIcon: (v) => `${v.line.kind}-fill`,
        getColor: (v) => v.fill,
        pickable: true,
        updateTriggers: { getPosition: [data.motion, terrain.version] },
      }),
      picked &&
        new ScatterplotLayer<Vehicle>({
          id: 'transports/choisi',
          data: [picked],
          getPosition: (v) => v.position,
          radiusUnits: 'pixels',
          getRadius: size * 0.95 + 5,
          filled: false,
          stroked: true,
          getLineColor: SELECTION_COLOR,
          lineWidthUnits: 'pixels',
          getLineWidth: 2.5,
          billboard: true,
          updateTriggers: { getPosition: data.motion },
          parameters,
        }),
      view.zoom >= LABELS_FROM_ZOOM &&
        new TextLayer<Vehicle>({
          id: 'transports/lignes',
          data: labelled(data, view.zoom),
          getPosition: (v) => v.position,
          getText: (v) => v.line.name ?? '',
          characterSet: 'auto',
          fontFamily,
          fontWeight: 700,
          getSize: 11.5,
          getColor: (v) => textColorOn(v.fill),
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: [size * 0.9 + 4, 0],
          background: true,
          getBackgroundColor: (v) => [v.fill[0]!, v.fill[1]!, v.fill[2]!, 235],
          backgroundPadding: [5, 2],
          backgroundBorderRadius: 4,
          getBorderColor: (v) => v.halo,
          getBorderWidth: 1,
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
    if (!data || !isLive(time)) return null;
    const sel = selection as TransitSelection;
    if (sel.type === 'network') {
      const net = data.networks.find((n) => n.name === sel.name);
      if (!net) return null;
      const lines = new Set(data.vehicles.filter((v) => v.line.network === net).map((v) => v.line.id ?? '?')).size;
      return {
        title: net.name,
        subtitle: 'Réseau de transport',
        fields: [
          ['Véhicules en circulation', nf(net.count)],
          ['Lignes en service', nf(lines)],
          ['Licence des données', LICENCES[net.licence] ?? net.licence],
        ],
        note: 'Rond de la vue d’ensemble, placé au centre des véhicules du réseau. Zoomez pour voir chaque véhicule.',
      };
    }
    const v = data.byKey.get(sel.key);
    if (!v) return null;
    const line = v.line;
    const fields: Array<[string, string]> = [['Réseau', line.network.name]];
    fields.push(['Ligne', [line.name ?? line.id, line.longName].filter(Boolean).join(' · ') || 'inconnue (le flux ne la précise pas)']);
    fields.push(['Mode', line.mode ? MODE_LABELS[line.mode] : 'non précisé']);
    fields.push(['Véhicule', v.id]);
    if (v.speedKmh !== undefined) fields.push(['Vitesse', `${nf(v.speedKmh)} km/h`]);
    if (v.headingDeg !== undefined) fields.push(['Cap', `${nf(v.headingDeg)}°`]);
    fields.push(['Position relevée', ageText(v.ts, time)]);
    fields.push(['Licence des données', LICENCES[line.network.licence] ?? line.network.licence]);
    return {
      title: lineTitle(line),
      subtitle: `${line.network.name} · véhicule ${v.id}`,
      fields,
      note: 'Position GPS publiée par le réseau, relue toutes les 30 secondes ; le véhicule glisse d’une position à la suivante, avec un léger retard.',
    };
  },

  focus(selection, { data, time }) {
    const sel = selection as TransitSelection;
    if (!data || !isLive(time)) return null;
    if (sel.type === 'network') {
      const net = data.networks.find((n) => n.name === sel.name);
      return net ? { lon: net.lon, lat: net.lat } : null;
    }
    const v = data.byKey.get(sel.key);
    return v ? { lon: v.position[0], lat: v.position[1] } : null;
  },
});
