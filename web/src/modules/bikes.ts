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
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { formatRelative } from '../ui/format';
import { OVER_MAP } from '../map/parameters';

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

interface Station extends Omit<ApiStation, 'network'> {
  /** Identifiant stable d'un chargement à l'autre (réseau + nom + position). */
  key: string;
  network: string;
}

interface BikesData {
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
const RING: Color = [22, 26, 38, 210];
const OUT_OF_SERVICE: Color = [120, 124, 134, 230];
const LABEL_MIN_ZOOM = 14;
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
  zoomBreaks: halfZoomBreaks(LABEL_MIN_ZOOM),
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

    return [
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
        getLineColor: (s) => (s.renting ? RING : OUT_OF_SERVICE),
        lineWidthUnits: 'pixels',
        getLineWidth: (s) => (s.renting ? 1 : 2),
        billboard: true,
        pickable: true,
        autoHighlight: !showLabels,
        highlightColor: [255, 255, 255, 160],
        updateTriggers: { getFillColor: mode, getPosition: terrain.version },
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
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          background: true,
          getBackgroundColor: (s) => [...LEVELS[levelOf(count(s, mode))].color, 245],
          getBorderColor: [22, 26, 38, 150],
          getBorderWidth: 1,
          backgroundBorderRadius: 9,
          backgroundPadding: [7, 3],
          billboard: true,
          pickable: true,
          updateTriggers: { getText: mode, getColor: mode, getBackgroundColor: mode, getPosition: terrain.version },
          parameters,
        }),
      chosen &&
        new ScatterplotLayer<Station>({
          id: 'velos/choisie',
          data: [chosen],
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: 12,
          filled: false,
          stroked: true,
          getLineColor: [79, 140, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          billboard: true,
          parameters,
        }),
    ];
  },

  select(object) {
    return { key: (object as Station).key };
  },

  describe(selection, { data }) {
    const station = data?.byKey.get((selection as { key: string }).key);
    if (!station) return null;
    const electric = station.ebikes !== null && station.bikes > 0 ? ` (dont ${station.ebikes} électrique${station.ebikes > 1 ? 's' : ''})` : '';
    const fields: Array<[string, string]> = [
      ['État', station.renting ? 'en service' : 'hors service'],
      ['Vélos disponibles', `${station.bikes}${electric}`],
      ['Places libres', String(station.docks)],
    ];
    if (station.capacity) fields.push(['Capacité', `${station.capacity} places`]);
    if (station.reportedAt) fields.push(['Mise à jour', formatRelative(station.reportedAt * 1000)]);
    return { title: station.name || 'Station', subtitle: station.network, fields };
  },
});
