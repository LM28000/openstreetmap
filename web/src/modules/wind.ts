/**
 * Module « Vent » : le vent à 10 m au-dessus de la France, en milliers de particules à traînée.
 *
 * Données : le serveur (`/api/vent`) relève toutes les 6 heures le modèle ARPEGE de Météo-France
 * (via Open-Meteo) sur une grille de 0,5° : 6 h de passé et 24 h de prévision, heure par heure.
 * Le navigateur interpole entre les heures selon l'horloge globale, puis entre les points de la
 * grille : la couche suit donc la frise temporelle, et la valeur de la fiche au clic est celle
 * que suivent les particules.
 *
 * Rendu : une couche personnalisée WebGL de MapLibre (voir `windLayer.ts` pour le choix).
 * Clic : une zone transparente (couche native MapLibre, posée sous toutes les autres) couvre
 * la grille ; elle sert seulement à « attraper » le clic, quand aucun autre objet n'est dessous.
 */
import type { CustomLayerInterface, GeoJSONSource, Map as MapLibreMap, MapMouseEvent, MapTouchEvent } from 'maplibre-gl';
import { ScatterplotLayer } from '@deck.gl/layers';
import { defineModule, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { OVER_MAP } from '../map/parameters';
import { formatDateTime } from '../ui/format';
import {
  beaufort,
  emptyMercatorField,
  interpolateHours,
  opacityForSpeed,
  originName,
  parseWindResponse,
  resampleToMercator,
  sampleGrid,
  speedAndOrigin,
  timeRange,
  type MercatorField,
  type WindData,
} from './windField';
import { WindParticleLayer } from './windLayer';

const LAYER_ID = 'vent-particules';
const ZONE_SOURCE = 'vent-zone';
const ZONE_LAYER = 'vent-zone';
const KMH = 3.6;

/** État partagé par les fonctions du module (une seule couche de vent existe à la fois). */
let particles: WindParticleLayer | undefined;
let mercatorField: MercatorField | undefined;
/** Champ à l'instant affiché, dans la grille du serveur (réutilisé d'une image à l'autre). */
let currentGrid: Float32Array | undefined;
/** Brouillon pour la fiche et le résumé (ne pas toucher à `currentGrid` pendant le dessin). */
let scratch: Float32Array | undefined;
let zonePolygonFor: WindData | undefined;
/** Dernière position du pointeur sur la carte : la fiche au clic en a besoin (le clic natif ne la transmet pas). */
let lastPointer = { lon: 2.5, lat: 46.5 };
let removePointerTracking: (() => void) | undefined;

interface WindSelection {
  lon: number;
  lat: number;
}

async function loadWind(signal: AbortSignal): Promise<WindData> {
  const response = await fetch('/api/vent', { signal });
  if (response.status === 503) throw new Error('le serveur récupère encore le champ de vent');
  if (!response.ok) throw new Error(`le serveur du vent a répondu ${response.status}`);
  return parseWindResponse(await response.json());
}

/** Zone cliquable : un rectangle qui couvre la grille. */
function zoneGeometry(data: WindData): GeoJSON.FeatureCollection {
  const { west, south, step, nx, ny } = data.grid;
  const east = west + (nx - 1) * step;
  const north = south + (ny - 1) * step;
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south],
            ],
          ],
        },
      },
    ],
  };
}

function trackPointer(map: MapLibreMap): () => void {
  const remember = (event: MapMouseEvent | MapTouchEvent) => {
    lastPointer = { lon: event.lngLat.lng, lat: event.lngLat.lat };
  };
  map.on('mousemove', remember);
  map.on('mousedown', remember);
  map.on('touchstart', remember);
  return () => {
    map.off('mousemove', remember);
    map.off('mousedown', remember);
    map.off('touchstart', remember);
  };
}

/** Vent (u, v en m/s) au point, à l'instant t : lu dans la grille du serveur, comme les particules. */
function windAt(data: WindData, time: number, lon: number, lat: number): { u: number; v: number } | null {
  const hour = interpolateHours(data, time / 1000, scratch);
  if (!hour) return null;
  scratch = hour;
  const uv = sampleGrid(data.grid, hour, lon, lat);
  return uv ? { u: uv[0], v: uv[1] } : null;
}

/**
 * Pastille de légende : un petit trait blanc d'opacité donnée sur fond nuit, comme sur la carte
 * (contour sombre translucide autour d'un cœur blanc). Le fond évite que le blanc disparaisse sur le panneau clair.
 */
function legendIcon(opacity: number): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="12" viewBox="0 0 30 12">' +
    '<rect width="30" height="12" rx="6" fill="#1c2b4a"/>' +
    `<path d="M5 6h20" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity="${opacity.toFixed(2)}"/>` +
    '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** Vitesses de la légende (km/h) : l'opacité de leur pastille est celle des particules à cette vitesse. */
const LEGEND_SPEEDS = [
  { kmh: 10, label: 'Faible : environ 10 km/h' },
  { kmh: 25, label: 'Modéré : environ 25 km/h' },
  { kmh: 38, label: 'Fort : environ 40 km/h' },
  { kmh: 60, label: 'Très fort : 60 km/h et plus' },
];

export const wind = defineModule<WindData>({
  id: 'vent',
  name: 'Vent',
  category: 'ciel',
  description: 'Le vent à 10 m d’altitude, en particules : passé récent et prévision de la journée. Cliquer donne le vent du point.',
  attribution: 'Open-Meteo.com (CC BY 4.0), modèle ARPEGE de Météo-France',
  refreshIntervalMs: 30 * 60_000,
  timeStepMs: 60_000,

  load: ({ signal }) => loadWind(signal),

  legend(): LegendItem[] {
    return LEGEND_SPEEDS.map(({ kmh, label }) => ({
      color: '#ffffff',
      label,
      icon: legendIcon(opacityForSpeed(kmh / KMH)),
    }));
  },

  summary({ data, time }) {
    if (!data) return null;
    const hour = interpolateHours(data, time / 1000, scratch);
    if (!hour) {
      const { from, to } = timeRange(data);
      return `Vent masqué : le modèle couvre de ${formatDateTime(from * 1000)} à ${formatDateTime(to * 1000)}`;
    }
    scratch = hour;
    let sum = 0;
    let max = 0;
    const count = hour.length / 2;
    for (let i = 0; i < count; i++) {
      const speed = Math.hypot(hour[2 * i]!, hour[2 * i + 1]!);
      sum += speed;
      max = Math.max(max, speed);
    }
    const kmh = (value: number) => Math.round(value * KMH).toLocaleString('fr-FR');
    return `Vent moyen ${kmh(sum / count)} km/h, pointes à ${kmh(max)} km/h`;
  },

  native: {
    add(map: MapLibreMap) {
      const bottom = map.getStyle().layers[0]?.id;
      // Zone cliquable, tout en bas : les autres couches cliquables (rivières…) passent avant elle.
      map.addSource(ZONE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: ZONE_LAYER, type: 'fill', source: ZONE_SOURCE, paint: { 'fill-color': '#000000', 'fill-opacity': 0.004 } }, bottom);
      zonePolygonFor = undefined;

      particles = new WindParticleLayer(LAYER_ID);
      map.addLayer(particles as CustomLayerInterface, firstSymbolLayerId(map));
      removePointerTracking = trackPointer(map);
      if (import.meta.env.DEV) Object.assign(window, { __vent: { stats: () => particles?.stats() } });
    },

    update(map, { data, time }) {
      if (!particles) return;
      const hour = data ? interpolateHours(data, time / 1000, currentGrid) : null;
      if (!data || !hour) {
        particles.setField(null);
        return;
      }
      currentGrid = hour;
      if (zonePolygonFor !== data) {
        (map.getSource(ZONE_SOURCE) as GeoJSONSource | undefined)?.setData(zoneGeometry(data));
        zonePolygonFor = data;
        mercatorField = undefined; // la grille a peut-être changé
      }
      const isNewField = !mercatorField;
      mercatorField ??= emptyMercatorField(data.grid);
      resampleToMercator(data.grid, hour, mercatorField);
      if (isNewField) particles.setField(mercatorField);
      else particles.touchField();
    },

    remove(map) {
      removePointerTracking?.();
      removePointerTracking = undefined;
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getLayer(ZONE_LAYER)) map.removeLayer(ZONE_LAYER);
      if (map.getSource(ZONE_SOURCE)) map.removeSource(ZONE_SOURCE);
      particles = undefined;
      mercatorField = undefined;
      zonePolygonFor = undefined;
    },

    pickable: {
      layerIds: [ZONE_LAYER],
      toObject: () => ({ ...lastPointer }),
    },
  },

  deckLayers({ selection }) {
    const chosen = selection as WindSelection | null;
    if (!chosen) return [];
    return [
      new ScatterplotLayer<WindSelection>({
        id: 'vent/choisi',
        data: [chosen],
        getPosition: (point) => [point.lon, point.lat],
        radiusUnits: 'pixels',
        getRadius: 9,
        filled: false,
        stroked: true,
        getLineColor: [255, 255, 255],
        lineWidthUnits: 'pixels',
        getLineWidth: 3,
        billboard: true,
        parameters: OVER_MAP,
      }),
      new ScatterplotLayer<WindSelection>({
        id: 'vent/choisi-contour',
        data: [chosen],
        getPosition: (point) => [point.lon, point.lat],
        radiusUnits: 'pixels',
        getRadius: 11,
        filled: false,
        stroked: true,
        getLineColor: [10, 20, 52, 200],
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        billboard: true,
        parameters: OVER_MAP,
      }),
    ];
  },

  select(object) {
    const point = object as WindSelection;
    return { lon: point.lon, lat: point.lat } satisfies WindSelection;
  },

  describe(selection, { data, time }) {
    const point = selection as WindSelection;
    if (!data) return null;
    const uv = windAt(data, time, point.lon, point.lat);
    if (!uv) {
      return {
        title: 'Vent',
        subtitle: formatDateTime(time),
        note: 'Pas de prévision de vent à cet instant : le modèle ne couvre que quelques heures avant et après maintenant.',
      };
    }
    const { speed, from } = speedAndOrigin(uv.u, uv.v);
    const force = beaufort(speed);
    const number = (value: number, digits = 0) => value.toLocaleString('fr-FR', { maximumFractionDigits: digits });
    return {
      title: 'Vent à 10 m',
      subtitle: formatDateTime(time),
      fields: [
        ['Vitesse', `${number(speed * KMH)} km/h (${number(speed, 1)} m/s)`],
        ['Direction', speed < 0.3 ? 'aucune, air calme' : `vent ${originName(from)} (${number(from)}°)`],
        ['Force', `${force.degree} Beaufort : ${force.name}`],
        ['Position', `${number(point.lat, 2)} °N, ${number(point.lon, 2)} °E`],
      ],
      note: 'Vent moyen à 10 m du sol, d’après le modèle ARPEGE de Météo-France. Les rafales et l’effet du relief local (vallées, cols) ne sont pas décrits : la grille est de 0,5° (environ 50 km).',
    };
  },
});
