/**
 * Module « Séismes » : les tremblements de terre des 7 derniers jours, d'après
 * le Centre sismologique euro-méditerranéen (EMSC).
 *
 * Deux requêtes : tous les séismes autour de la France (même les tout petits),
 * et les séismes de magnitude 4,5 et plus dans le monde, pour la vue globe.
 * Chaque séisme n'apparaît qu'à partir de son heure : en remontant le temps,
 * on le voit disparaître. Ceux de moins de 3 h pulsent.
 */
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Color } from '@deck.gl/core';
import { defineModule } from '../core/module';
import { formatDateTime } from '../ui/format';

interface Quake {
  id: string;
  lon: number;
  lat: number;
  depthKm: number;
  mag: number;
  magType: string;
  /** Heure du séisme, en ms UTC. */
  time: number;
  region: string;
  authority: string;
}

interface EmscFeature {
  id: string;
  properties: {
    lat: number;
    lon: number;
    depth: number;
    mag: number;
    magtype: string;
    time: string;
    flynn_region: string;
    auth: string;
    unid: string;
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WINDOW_MS = 7 * DAY;
const PULSE_MAX_AGE_MS = 3 * HOUR;
const PULSE_PERIOD_MS = 1_800;
const EMSC_URL = 'https://www.seismicportal.eu/fdsnws/event/1/query';
/** Rectangle autour de la France métropolitaine et de la Corse. */
const FRANCE_AREA = { minlat: '40', maxlat: '53', minlon: '-8', maxlon: '12' };

async function fetchEmsc(params: Record<string, string>, signal: AbortSignal): Promise<Quake[]> {
  const query = new URLSearchParams({ format: 'json', orderby: 'time', ...params });
  const response = await fetch(`${EMSC_URL}?${query}`, { signal });
  if (response.status === 204) return []; // norme FDSN : 204 = aucun séisme
  if (!response.ok) throw new Error(`EMSC a répondu ${response.status}`);
  const json = (await response.json()) as { features: EmscFeature[] };
  return json.features.map(({ properties: p }) => ({
    id: p.unid,
    lon: p.lon,
    lat: p.lat,
    depthKm: p.depth,
    mag: p.mag,
    magType: p.magtype,
    time: Date.parse(p.time),
    region: p.flynn_region,
    authority: p.auth,
  }));
}

/** Rayon en pixels : lisible à toutes les échelles, croissant avec la magnitude. */
function radiusPixels(mag: number): number {
  return 2 + Math.pow(1.6, Math.max(0, mag));
}

/** Couleur selon l'âge du séisme à l'instant t : rouge vif s'il est récent, jaune pâle s'il est ancien. */
function colorForAge(age: number): Color {
  if (age < 0) return [0, 0, 0, 0]; // pas encore arrivé à l'instant t
  if (age < HOUR) return [255, 59, 48, 245];
  if (age < DAY) return [255, 140, 0, 225];
  const fade = Math.min(1, (age - DAY) / (WINDOW_MS - DAY));
  return [255, 204, 64, Math.round(210 - fade * 130)];
}

const SMALL_WORDS = new Set(['of', 'the', 'and', 'off', 'near']);

/** « NEAR SOUTH COAST OF FRANCE » → « Near South Coast of France » */
function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.replace(/(^|-)\p{L}/gu, (m) => m.toUpperCase())))
    .join(' ');
}

// Les séismes récents ne changent qu'une fois par minute simulée : on garde le même
// tableau entre deux minutes pour que deck.gl ne recalcule rien inutilement.
let recentCache: { data: Quake[]; minute: number; recent: Quake[] } | undefined;

function recentQuakes(data: Quake[], time: number, minute: number): Quake[] {
  if (recentCache?.data !== data || recentCache.minute !== minute) {
    const recent = data.filter((q) => q.time <= time && time - q.time < PULSE_MAX_AGE_MS);
    recentCache = { data, minute, recent };
  }
  return recentCache.recent;
}

export const earthquakes = defineModule<Quake[]>({
  id: 'seismes',
  name: 'Séismes',
  category: 'environnement',
  description: 'Tremblements de terre des 7 derniers jours : tous autour de la France, les plus forts dans le monde.',
  attribution: 'EMSC',
  visibleByDefault: true,
  refreshIntervalMs: 5 * 60_000,
  timeStepMs: 0, // animé : les séismes récents pulsent
  followsTerrain: true,

  async load({ signal }) {
    const start = new Date(Date.now() - WINDOW_MS).toISOString().slice(0, 19);
    const [france, world] = await Promise.all([
      fetchEmsc({ start, ...FRANCE_AREA, limit: '3000' }, signal),
      fetchEmsc({ start, minmag: '4.5', limit: '1000' }, signal),
    ]);
    const byId = new Map<string, Quake>();
    for (const quake of [...world, ...france]) byId.set(quake.id, quake);
    // Les plus forts en dernier : ils sont dessinés par-dessus.
    return [...byId.values()].sort((a, b) => a.mag - b.mag);
  },

  deckLayers({ data, time, terrain }) {
    if (!data) return [];
    const minute = Math.floor(time / 60_000);
    const phase = (performance.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    // Posés à l'altitude du relief, et dessinés par-dessus : un séisme reste visible
    // même s'il est derrière une montagne.
    const getPosition = (q: Quake): [number, number, number] => [q.lon, q.lat, terrain.elevation(q.lon, q.lat)];
    const parameters = { depthCompare: 'always', depthWriteEnabled: false } as const;

    return [
      new ScatterplotLayer<Quake>({
        id: 'seismes/points',
        data,
        getPosition,
        getRadius: (q) => radiusPixels(q.mag),
        radiusUnits: 'pixels',
        billboard: true, // toujours face à la caméra, lisible en vue inclinée
        getFillColor: (q) => colorForAge(time - q.time),
        getLineColor: (q) => (q.time > time ? [0, 0, 0, 0] : [255, 255, 255, 170]),
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 0.75,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        updateTriggers: { getPosition: terrain.version, getFillColor: minute, getLineColor: minute },
        parameters,
      }),
      new ScatterplotLayer<Quake>({
        id: 'seismes/pulsations',
        data: recentQuakes(data, time, minute),
        getPosition,
        getRadius: (q) => radiusPixels(q.mag),
        radiusUnits: 'pixels',
        billboard: true,
        radiusScale: 1 + phase * 2.5,
        opacity: (1 - phase) * 0.9,
        filled: false,
        stroked: true,
        getLineColor: [255, 69, 58],
        lineWidthUnits: 'pixels',
        getLineWidth: 2,
        updateTriggers: { getPosition: terrain.version },
        parameters,
      }),
    ];
  },

  select(object) {
    return { id: (object as Quake).id };
  },

  describe(selection, { data }) {
    const id = (selection as { id: string }).id;
    const q = data?.find((quake) => quake.id === id);
    if (!q) return null;
    return {
      title: `Séisme de magnitude ${q.mag.toFixed(1)}`,
      subtitle: titleCase(q.region),
      fields: [
        ['Date', formatDateTime(q.time)],
        ['Profondeur', `${Math.round(q.depthKm)} km`],
        ['Magnitude', `${q.mag.toFixed(1)} (${q.magType})`],
        ['Mesuré par', q.authority],
      ],
      link: {
        href: `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(q.id)}`,
        label: 'Fiche détaillée sur le site de l’EMSC',
      },
    };
  },

  focus(selection, { data }) {
    const id = (selection as { id: string }).id;
    const q = data?.find((quake) => quake.id === id);
    return q ? { lon: q.lon, lat: q.lat } : null;
  },
});
