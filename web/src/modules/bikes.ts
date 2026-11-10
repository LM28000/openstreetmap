/**
 * Module « Vélos en libre-service » : les stations de tous les réseaux de France
 * (Vélib', Vélo'v, VélôToulouse…), avec les vélos et les places disponibles.
 *
 * Les flux GBFS des réseaux sont rassemblés par le serveur (server/src/bikes.rs),
 * qui les relit chaque minute.
 *
 * Deux usages, deux modes : « Vélos » pour en trouver un, « Places » pour le rendre.
 * La couleur suit le nombre disponible (une seule teinte, de clair à foncé) ; une
 * station hors service est un simple anneau, pour ne pas reposer sur la couleur.
 */
import type { Color } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { measuredStatus } from '../core/infoStatus';
import { OVER_MAP } from '../map/parameters';
import { HALO, ink, type IconSheet, KEY, packIcons, selectionRing, zoomRamp } from './symbols';

interface ApiStation {
  network: number;
  name: string;
  lon: number;
  lat: number;
  capacity: number | null;
  bikes: number;
  ebikes: number | null;
  docks: number;
  renting: boolean;
  reportedAt: number | null;
}

export interface Station extends Omit<ApiStation, 'network'> {
  /** Identifiant stable d'un chargement à l'autre (réseau + nom + position). */
  key: string;
  network: string;
}

export interface BikesData {
  stations: Station[];
  byKey: Map<string, Station>;
  networks: number;
  bikes: number;
  ebikes: number;
}

type Mode = 'velos' | 'places';
type Level = 'aucun' | 'peu' | 'quelques' | 'beaucoup';

/** Une seule teinte, du clair au foncé (validée), et un gris neutre pour « aucun ». */
const LEVELS: Record<Level, { color: [number, number, number]; css: string; text: [number, number, number] }> = {
  aucun: { color: [207, 205, 198], css: '#cfcdc6', text: [22, 26, 38] },
  peu: { color: [85, 181, 145], css: '#55b591', text: [22, 26, 38] },
  quelques: { color: [31, 125, 97], css: '#1f7d61', text: [255, 255, 255] },
  beaucoup: { color: [10, 69, 53], css: '#0a4535', text: [255, 255, 255] },
};
const LEVEL_ORDER: Level[] = ['beaucoup', 'quelques', 'peu', 'aucun'];
const OUT_OF_SERVICE: Color = [120, 124, 134, 230];
const LABEL_MIN_ZOOM = 14;
/** À partir de ce zoom, chaque station est une jauge ; avant, un simple point. */
const GAUGE_MIN_ZOOM = 12;
const LABEL_BOX_PX = { width: 40, height: 26 };

function count(station: Station, mode: Mode): number {
  return mode === 'velos' ? station.bikes : station.docks;
}

function levelOf(n: number): Level {
  if (n === 0) return 'aucun';
  if (n <= 2) return 'peu';
  if (n <= 5) return 'quelques';
  return 'beaucoup';
}

function legendLabel(level: Level, mode: Mode): string {
  const unit = mode === 'velos' ? 'vélo' : 'place';
  switch (level) {
    case 'aucun':
      return `Aucun${mode === 'places' ? 'e' : ''} ${unit} disponible`;
    case 'peu':
      return `1 ou 2 ${unit}s`;
    case 'quelques':
      return `3 à 5 ${unit}s`;
    case 'beaucoup':
      return `6 ${unit}s ou plus`;
  }
}


// --- Jauge : la part de vélos (ou de places) disponibles, en anneau ---

/** Nombre de crans de la jauge : un cran vaut 1/12 de tour. */
const GAUGE_STEPS = 12;
const GAUGE_SCALE = 1.4;
/** Rayons de la planche (en u) : disque blanc, jauge colorée, trou central. */
const GAUGE_R = { disc: 26, fill: 22, hole: 11 };
const GAUGE_CELL = Math.ceil((2 * (GAUGE_R.disc + 1 + 2.4) + 1) * GAUGE_SCALE);
const gaugeKey = (level: Level, step: number) => `jauge:${level}:${step}`;
const OUT_OF_SERVICE_KEY = 'jauge:hors-service';

let gauges: IconSheet | undefined;
/** Les jauges sont dessinées au premier usage (il faut un document pour créer un canvas). */
function gaugeSheet(): IconSheet {
  if (gauges) return gauges;
  const cells: Parameters<typeof packIcons>[0][number][] = [];
  const disc = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    c.arc(0, 0, GAUGE_R.disc, 0, Math.PI * 2);
  };
  const hole = (c: CanvasRenderingContext2D) => {
    c.beginPath();
    c.arc(0, 0, GAUGE_R.hole, 0, Math.PI * 2);
  };
  const frame = (draw: (c: CanvasRenderingContext2D) => void) => (c: CanvasRenderingContext2D) => {
    c.translate(GAUGE_CELL / 2, GAUGE_CELL / 2);
    c.scale(GAUGE_SCALE, GAUGE_SCALE);
    draw(c);
  };
  const add = (key: string, level: Level, step: number) =>
    cells.push({
      key,
      width: GAUGE_CELL,
      height: GAUGE_CELL,
      draw: frame((c) => {
        ink(c, disc, '#ffffff', { key: 2 });
        if (step > 0) {
          c.beginPath();
          c.moveTo(0, 0);
          c.arc(0, 0, GAUGE_R.fill, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * step) / GAUGE_STEPS);
          c.closePath();
          c.fillStyle = LEVELS[level].css;
          c.fill();
        }
        ink(c, hole, '#ffffff', { key: 1.4, noHalo: true });
      }),
    });
  add(gaugeKey('aucun', 0), 'aucun', 0);
  for (const level of ['peu', 'quelques', 'beaucoup'] as const) {
    for (let step = 1; step <= GAUGE_STEPS; step++) add(gaugeKey(level, step), level, step);
  }
  // Hors service : un anneau gris, sans remplissage.
  cells.push({
    key: OUT_OF_SERVICE_KEY,
    width: GAUGE_CELL,
    height: GAUGE_CELL,
    draw: frame((c) => {
      c.beginPath();
      c.arc(0, 0, GAUGE_R.fill, 0, Math.PI * 2);
      c.strokeStyle = 'rgba(255,255,255,0.93)';
      c.lineWidth = 8;
      c.stroke();
      c.strokeStyle = '#787c86';
      c.lineWidth = 3.5;
      c.stroke();
    }),
  });
  gauges = packIcons(cells);
  return gauges;
}

/** Part du compte affiché (vélos ou places) parmi les vélos et les places de la station. */
function share(station: Station, mode: Mode): number {
  const total = station.bikes + station.docks;
  const whole = total > 0 ? total : (station.capacity ?? 0);
  return whole > 0 ? Math.min(1, count(station, mode) / whole) : 0;
}

function gaugeIcon(station: Station, mode: Mode): string {
  if (!station.renting) return OUT_OF_SERVICE_KEY;
  const n = count(station, mode);
  if (n === 0) return gaugeKey('aucun', 0);
  // Au moins un cran dès qu'il y en a un : une station presque vide n'est pas une station vide.
  const step = Math.max(1, Math.round(share(station, mode) * GAUGE_STEPS));
  return gaugeKey(levelOf(n), step);
}

async function loadBikes(signal: AbortSignal): Promise<BikesData> {
  const response = await fetch('/api/velos', { signal });
  if (response.status === 503) throw new Error('le serveur rassemble encore les réseaux, nouvel essai dans une minute');
  if (!response.ok) throw new Error(`le serveur des vélos a répondu ${response.status}`);
  const json = (await response.json()) as { networks: string[]; stations: ApiStation[] };
  const stations: Station[] = json.stations.map((s) => {
    const network = json.networks[s.network] ?? '';
    return { ...s, network, key: `${network}|${s.name}|${s.lon.toFixed(5)}|${s.lat.toFixed(5)}` };
  });
  return {
    stations,
    byKey: new Map(stations.map((s) => [s.key, s])),
    networks: new Set(stations.map((s) => s.network)).size,
    bikes: stations.reduce((sum, s) => sum + (s.renting ? s.bikes : 0), 0),
    ebikes: stations.reduce((sum, s) => sum + (s.renting ? (s.ebikes ?? 0) : 0), 0),
  };
}

let labelCache: { data: BikesData; mode: Mode; band: number; stations: Station[] } | undefined;

/** Vu de près, une étiquette par case : la station la mieux fournie l'emporte. */
function labelled(data: BikesData, mode: Mode, zoom: number): Station[] {
  const band = zoomBand(zoom);
  if (labelCache?.data !== data || labelCache.mode !== mode || labelCache.band !== band) {
    const candidates = data.stations.filter((s) => s.renting);
    const stations = declutter(candidates, zoom, { lon: (s) => s.lon, lat: (s) => s.lat, rank: (s) => -count(s, mode), box: LABEL_BOX_PX });
    labelCache = { data, mode, band, stations };
  }
  return labelCache.stations;
}

export const bikes = defineModule<BikesData>({
  id: 'velos',
  name: 'Vélos en libre-service',
  category: 'transport',
  description: 'Vélos et places disponibles dans les stations de tous les réseaux de France.',
  attribution: 'réseaux de vélos (GBFS) via transport.data.gouv.fr',
  refreshIntervalMs: 60_000,
  timeStepMs: 3_600_000, // état du moment : ne dépend pas de l'instant affiché
  zoomBreaks: halfZoomBreaks(GAUGE_MIN_ZOOM),
  followsTerrain: true,

  settings: [
    {
      id: 'mode',
      label: 'Afficher',
      options: [
        { value: 'velos', label: 'Vélos' },
        { value: 'places', label: 'Places' },
      ],
      defaultValue: 'velos',
    },
  ],

  legend(settings) {
    const mode = settings.mode as Mode;
    return [
      ...LEVEL_ORDER.map((level) => ({ color: LEVELS[level].css, label: legendLabel(level, mode), size: 'small' as const })),
      { color: 'transparent', label: 'Station hors service (anneau)', size: 'small' as const },
    ];
  },

  load: ({ signal }) => loadBikes(signal),

  summary({ data }) {
    if (!data) return null;
    const ebikes = data.ebikes > 0 ? ` (dont ${data.ebikes.toLocaleString('fr-FR')} électriques)` : '';
    return `${data.stations.length.toLocaleString('fr-FR')} stations, ${data.networks} réseaux · ${data.bikes.toLocaleString('fr-FR')} vélos disponibles${ebikes}`;
  },

  deckLayers({ data, settings, selection, view, terrain }) {
    if (!data) return [];
    const mode = settings.mode as Mode;
    const onGround = (s: Station): [number, number, number] => [s.lon, s.lat, terrain.elevation(s.lon, s.lat)];
    const chosen = selection ? data.byKey.get((selection as { key: string }).key) : undefined;
    const parameters = OVER_MAP;
    const showLabels = view.zoom >= LABEL_MIN_ZOOM;

    const gaugeLayers = view.zoom >= GAUGE_MIN_ZOOM;
    const gaugeSize = zoomRamp(view.zoom, GAUGE_MIN_ZOOM, 15, 20, 32);
    const sheet = gaugeLayers ? gaugeSheet() : undefined;

    return [
      // De loin : un point par station (couleur du niveau, contour sombre), avec un halo clair dès qu'il se voit.
      !gaugeLayers &&
        view.zoom >= 10 &&
        new ScatterplotLayer<Station>({
          id: 'velos/stations-halo',
          data: data.stations,
          getPosition: onGround,
          radiusUnits: 'meters',
          getRadius: 40,
          radiusMinPixels: 4.2,
          radiusMaxPixels: 11,
          getFillColor: HALO,
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      !gaugeLayers &&
        new ScatterplotLayer<Station>({
          id: 'velos/stations',
          data: data.stations,
          getPosition: onGround,
          radiusUnits: 'meters',
          getRadius: 40,
          radiusMinPixels: 2.5,
          radiusMaxPixels: 9,
          // Hors service : un anneau gris, sans remplissage.
          getFillColor: (s) => (s.renting ? LEVELS[levelOf(count(s, mode))].color : [0, 0, 0, 0]),
          stroked: true,
          getLineColor: (s) => (s.renting ? KEY : OUT_OF_SERVICE),
          lineWidthUnits: 'pixels',
          getLineWidth: (s) => (s.renting ? 1 : 2),
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 160],
          updateTriggers: { getFillColor: mode, getPosition: terrain.version },
          parameters,
        }),
      // De près : la jauge de vélos disponibles.
      sheet &&
        new IconLayer<Station>({
          id: 'velos/jauges',
          data: data.stations,
          iconAtlas: sheet.atlas,
          iconMapping: sheet.mapping,
          getIcon: (s) => gaugeIcon(s, mode),
          getPosition: onGround,
          sizeUnits: 'pixels',
          getSize: gaugeSize,
          billboard: true,
          pickable: true,
          autoHighlight: !showLabels,
          highlightColor: [255, 255, 255, 120],
          updateTriggers: { getIcon: mode, getPosition: terrain.version },
          parameters,
        }),
      showLabels &&
        new TextLayer<Station>({
          id: 'velos/nombres',
          data: labelled(data, mode, view.zoom),
          getPosition: onGround,
          getText: (s) => String(count(s, mode)),
          characterSet: '0123456789',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 12.5,
          getColor: (s) => LEVELS[levelOf(count(s, mode))].text,
          // À droite de la jauge, pour ne pas la cacher.
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: [gaugeSize / 2 + 3, 0],
          background: true,
          getBackgroundColor: (s) => [...LEVELS[levelOf(count(s, mode))].color, 245],
          getBorderColor: [20, 26, 38, 170],
          getBorderWidth: 1,
          backgroundBorderRadius: 9,
          backgroundPadding: [7, 3],
          billboard: true,
          pickable: true,
          updateTriggers: { getText: mode, getColor: mode, getBackgroundColor: mode, getPosition: terrain.version },
          parameters,
        }),
      chosen && selectionRing('velos/choisie', [chosen], onGround, gaugeLayers ? gaugeSize * 0.62 : 12, parameters),
    ];
  },

  select(object) {
    return { key: (object as Station).key };
  },

  describe(selection, { data, time }) {
    const station = data?.byKey.get((selection as { key: string }).key);
    if (!station) return null;
    const electric = station.ebikes !== null && station.bikes > 0 ? station.ebikes : null;
    return {
      kind: 'Station de vélos',
      title: station.name || 'Station',
      subtitle: station.network,
      // Le réseau date son relevé ; à défaut, on dit seulement « en direct ».
      status: measuredStatus(time, station.reportedAt ? station.reportedAt * 1000 : undefined),
      figures: [
        { value: String(station.bikes), label: electric !== null ? `vélos, dont ${electric} élec.` : 'vélos' },
        { value: String(station.docks), label: 'places libres' },
        // Sans capacité déclarée, on laisse la case de côté plutôt que d'inventer un total.
        ...(station.capacity ? [{ value: String(station.capacity), label: 'capacité' }] : []),
      ],
      // Une station hors service n'a plus de vélos à prendre : c'est la seule chose à dire en plus.
      fields: station.renting ? undefined : [['État', 'hors service']],
    };
  },
});
