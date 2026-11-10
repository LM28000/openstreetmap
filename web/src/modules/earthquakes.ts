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
import { plainStatus } from '../core/infoStatus';
import { defineModule } from '../core/module';
import { formatDateTime, formatRelative, formatTime } from '../ui/format';
import { OVER_MAP } from '../map/parameters';
import { selectionRing } from './symbols';

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

/**
 * Ondes : un anneau autour des séismes de magnitude 3 et plus, deux à partir de 4,5, trois
 * à partir de 6. Plus le séisme est fort, plus il rayonne loin.
 */
const WAVE_MAGNITUDES = [3, 4.5, 6];

/** Rayon (pixels) de la k-ième onde : au-delà du disque, d'un écart qui croît avec lui sans dépasser 12 px. */
const waveRadius = (mag: number, k: number) => radiusPixels(mag) + Math.min(radiusPixels(mag) * 1.1, 12) * k;

/** Couleur d'un trait ou d'un halo qui suit l'opacité du disque (un séisme ancien s'estompe, un futur est absent). */
function withAlpha(rgb: [number, number, number], age: number, factor = 1): Color {
  const alpha = colorForAge(age)[3] ?? 0;
  return [...rgb, Math.round(alpha * factor)] as Color;
}

/** Les séismes qui ont `k` ondes ou plus (calculé une fois par chargement). */
let waveCache: { data: Quake[]; sets: Quake[][] } | undefined;
function wavesOf(data: Quake[]): Quake[][] {
  if (waveCache?.data !== data) {
    waveCache = { data, sets: WAVE_MAGNITUDES.map((min) => data.filter((q) => q.mag >= min)) };
  }
  return waveCache.sets;
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

  deckLayers({ data, time, terrain, selection }) {
    if (!data) return [];
    const minute = Math.floor(time / 60_000);
    const phase = (performance.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
    // Posés à l'altitude du relief, et dessinés par-dessus : un séisme reste visible
    // même s'il est derrière une montagne.
    const getPosition = (q: Quake): [number, number, number] => [q.lon, q.lat, terrain.elevation(q.lon, q.lat)];
    const parameters = OVER_MAP;
    const chosenId = (selection as { id: string } | null)?.id;
    const chosen = chosenId ? data.find((q) => q.id === chosenId) : undefined;
    const triggers = { getPosition: terrain.version, getFillColor: minute, getLineColor: minute };

    return [
      // Ondes : des anneaux de la couleur du séisme, d'autant plus nombreux que la magnitude est forte.
      ...wavesOf(data).map(
        (quakes, i) =>
          new ScatterplotLayer<Quake>({
            id: `seismes/onde-${i + 1}`,
            data: quakes,
            getPosition,
            getRadius: (q) => waveRadius(q.mag, i + 1),
            radiusUnits: 'pixels',
            billboard: true,
            filled: false,
            stroked: true,
            getLineColor: (q) => {
              const c = colorForAge(time - q.time);
              return [c[0], c[1], c[2], Math.round((c[3] ?? 0) * 0.55)] as Color;
            },
            lineWidthUnits: 'pixels',
            getLineWidth: 2,
            updateTriggers: triggers,
            parameters,
          }),
      ),
      // Halo clair sous le disque, puis le disque lui-même, cerné d'un contour sombre.
      new ScatterplotLayer<Quake>({
        id: 'seismes/halo',
        data,
        getPosition,
        getRadius: (q) => radiusPixels(q.mag) + 2.6,
        radiusUnits: 'pixels',
        billboard: true,
        getFillColor: (q) => withAlpha([255, 255, 255], time - q.time, 0.95),
        updateTriggers: triggers,
        parameters,
      }),
      new ScatterplotLayer<Quake>({
        id: 'seismes/points',
        data,
        getPosition,
        getRadius: (q) => radiusPixels(q.mag),
        radiusUnits: 'pixels',
        billboard: true, // toujours face à la caméra, lisible en vue inclinée
        getFillColor: (q) => colorForAge(time - q.time),
        getLineColor: (q) => withAlpha([20, 26, 38], time - q.time),
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1.5,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        updateTriggers: triggers,
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
      chosen &&
        selectionRing('seismes/choisi', [chosen], getPosition, (q) => waveRadius(q.mag, WAVE_MAGNITUDES.filter((m) => q.mag >= m).length) + 6, parameters),
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
      kind: 'Séisme',
      title: titleCase(q.region),
      subtitle: formatDateTime(q.time),
      // Catalogue de l'EMSC, relu à intervalles réguliers : un séisme d'hier n'est pas du direct.
      status: plainStatus(`Survenu ${formatRelative(q.time)}`),
      figures: [
        { value: q.mag.toFixed(1).replace('.', ','), label: `magnitude (${q.magType})` },
        { value: String(Math.round(q.depthKm)), unit: 'km', label: 'profondeur' },
        { value: formatTime(q.time), label: 'heure locale' },
      ],
      fields: [['Mesuré par', q.authority]],
      actions: [
        {
          label: 'Source',
          href: `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(q.id)}`,
        },
      ],
    };
  },

  focus(selection, { data }) {
    const id = (selection as { id: string }).id;
    const q = data?.find((quake) => quake.id === id);
    return q ? { lon: q.lon, lat: q.lat } : null;
  },
});
