/**
 * Module « Vigilance météo » : le niveau de vigilance de Météo-France pour chaque
 * département de métropole, aujourd'hui et demain (le serveur relève le bulletin le
 * plus récent, server/src/vigilance.rs).
 *
 * Chaque département prend la couleur de son niveau maximal (vert, jaune, orange, rouge :
 * les mêmes couleurs de statut que les crues). Comme la couleur ne suffit pas (daltonisme),
 * le niveau est doublé de deux autres signes : une trame (rien, hachures espacées, hachures
 * serrées, hachures croisées) et l'épaisseur du contour.
 *
 * Le bulletin couvre deux jours (J, le jour de son émission, et J1) : la couche suit l'horloge et
 * montre le jour qui contient l'instant affiché. Hors de ces deux jours, rien n'est coloré.
 *
 * Les contours des départements viennent d'IGN Admin Express (Licence Ouverte), via
 * gregoiredavid/france-geojson, réduits à 3 décimales et embarqués (src/data/).
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { defineModule } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { formatDateTime } from '../ui/format';
import departements from '../data/departements.json';

interface ApiSlot extends Array<number> {
  0: number;
  1: number;
  2: number;
}
interface ApiPhenomenon {
  id: number;
  level: number;
  slots: ApiSlot[];
}
interface ApiPeriod {
  max: number;
  phenomena: ApiPhenomenon[];
}
interface AlertsData {
  issuedAt: number;
  periods: Array<{ name: string; begin: number; end: number }>;
  departments: Record<string, ApiPeriod[]>;
}

const SOURCE_ID = 'vigilance-meteo';
const FILL_ID = 'vigilance-meteo-fond';
const PATTERN_ID = 'vigilance-meteo-trame';
const LINE_ID = 'vigilance-meteo-contour';
const SELECTED_ID = 'vigilance-meteo-choisi';

/** Mêmes couleurs de statut que `floods.ts`. */
const LEVELS: Record<number, { name: string; color: string; text: string }> = {
  1: { name: 'verte', color: '#0ca30c', text: 'Pas de vigilance particulière.' },
  2: {
    name: 'jaune',
    color: '#fab219',
    text: 'Soyez attentif. Si vous pratiquez des activités sensibles au risque météorologique ou exposées aux conditions météorologiques, des phénomènes habituels dans la région mais occasionnellement dangereux sont prévus.',
  },
  3: {
    name: 'orange',
    color: '#ec835a',
    text: 'Soyez très vigilant. Des phénomènes dangereux sont prévus. Tenez-vous au courant de l’évolution de la situation et suivez les conseils de sécurité émis par les pouvoirs publics.',
  },
  4: {
    name: 'rouge',
    color: '#d03b3b',
    text: 'Une vigilance absolue s’impose. Des phénomènes dangereux d’intensité exceptionnelle sont prévus. Tenez-vous régulièrement au courant de l’évolution de la situation et respectez impérativement les consignes de sécurité émises par les pouvoirs publics.',
  },
};

const PHENOMENA: Record<number, string> = {
  1: 'Vent violent',
  2: 'Pluie-inondation',
  3: 'Orages',
  4: 'Crues',
  5: 'Neige-verglas',
  6: 'Canicule',
  7: 'Grand froid',
  8: 'Avalanches',
  9: 'Vagues-submersion',
};

const INK = '#161a26';
const DAY_MS = 24 * 3600_000;

/** Trames : la même information que la couleur, pour ceux qui ne la distinguent pas. */
type Pattern = 'none' | 'sparse' | 'dense' | 'cross';
const PATTERN_OF: Record<number, Pattern> = { 1: 'none', 2: 'sparse', 3: 'dense', 4: 'cross' };

/** Dessine une tuile de trame (pas de 12 ou 6 pixels) : hachures « / », ou croisées. */
function drawPattern(ctx: CanvasRenderingContext2D, size: number, pattern: Pattern): void {
  ctx.strokeStyle = INK;
  ctx.lineCap = 'butt';
  ctx.lineWidth = pattern === 'sparse' ? 1.6 : 1.8;
  ctx.globalAlpha = pattern === 'cross' ? 0.7 : pattern === 'dense' ? 0.6 : 0.5;
  const slash = () => {
    // Trois segments pour que les hachures se raccordent d'une tuile à l'autre.
    ctx.beginPath();
    for (const offset of [-size, 0, size]) {
      ctx.moveTo(offset, size);
      ctx.lineTo(offset + size, 0);
    }
    ctx.stroke();
  };
  slash();
  if (pattern === 'cross') {
    ctx.save();
    ctx.translate(size, 0);
    ctx.scale(-1, 1);
    slash();
    ctx.restore();
  }
}

function patternImage(pattern: Pattern): ImageData | null {
  const size = pattern === 'sparse' ? 14 : 8;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  drawPattern(ctx, size, pattern);
  return ctx.getImageData(0, 0, size, size);
}

/** Pastille de légende : la couleur du niveau avec sa trame et son contour. */
const swatchCache = new Map<number, string>();
function swatch(level: number): string {
  const cached = swatchCache.get(level);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 28;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = LEVELS[level]!.color;
  ctx.globalAlpha = 0.85;
  ctx.fillRect(2, 2, 24, 24);
  ctx.globalAlpha = 1;
  const pattern = PATTERN_OF[level]!;
  if (pattern !== 'none') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(2, 2, 24, 24);
    ctx.clip();
    const tile = document.createElement('canvas');
    tile.width = tile.height = pattern === 'sparse' ? 14 : 8;
    const tileCtx = tile.getContext('2d');
    if (tileCtx) {
      drawPattern(tileCtx, tile.width, pattern);
      ctx.fillStyle = ctx.createPattern(tile, 'repeat') ?? INK;
      ctx.fillRect(2, 2, 24, 24);
    }
    ctx.restore();
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = [0, 1, 2, 3.5, 5][level]!;
  ctx.strokeRect(2, 2, 24, 24);
  const url = canvas.toDataURL();
  swatchCache.set(level, url);
  return url;
}

async function loadAlerts(signal: AbortSignal): Promise<AlertsData> {
  const response = await fetch('/api/vigilance', { signal });
  if (response.status === 503) throw new Error('le serveur récupère encore le bulletin de vigilance');
  if (!response.ok) throw new Error(`le serveur de la vigilance a répondu ${response.status}`);
  return (await response.json()) as AlertsData;
}

/** Période du bulletin qui couvre l'instant (0 = aujourd'hui, 1 = demain), sinon -1. */
function periodAt(data: AlertsData, time: number): number {
  for (let i = 0; i < data.periods.length; i++) {
    const { begin, end } = data.periods[i]!;
    // « Aujourd'hui » couvre toute la journée qui finit à `end`, pas seulement depuis l'émission du bulletin.
    const from = i === 0 ? end * 1000 - DAY_MS : begin * 1000;
    if (time >= from && time < end * 1000) return i;
  }
  return -1;
}

function levelOf(data: AlertsData, code: string, period: number): number {
  return data.departments[code]?.[period]?.max ?? 1;
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });
/** Le jour couvert par une période (« mardi 10 novembre »), d'après son milieu : le bulletin parle de J et J1, pas de dates. */
const dayName = (data: AlertsData, period: number): string => dayFormat.format(data.periods[period]!.end * 1000 - DAY_MS / 2);

const slotFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const hourFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

/** « 9 nov., 22:00 à 10 nov., 06:00 » (resserré si c'est le même jour). */
function slotText(slots: ApiSlot[]): string {
  const [first] = [...slots].sort((a, b) => a[0] - b[0]);
  const last = [...slots].sort((a, b) => b[1] - a[1])[0];
  if (!first || !last) return '';
  const begin = first[0] * 1000;
  const end = last[1] * 1000;
  const sameDay = slotFormat.format(begin).split(',')[0] === slotFormat.format(end).split(',')[0];
  return sameDay ? `${slotFormat.format(begin)} à ${hourFormat.format(end)}` : `${slotFormat.format(begin)} à ${slotFormat.format(end)}`;
}

let shown: { data: AlertsData; period: number } | undefined;

function colored(data: AlertsData, period: number) {
  return {
    type: 'FeatureCollection' as const,
    features: (departements as unknown as { features: Array<{ type: 'Feature'; properties: { code: string; nom: string }; geometry: unknown }> }).features.map(
      (f) => ({ ...f, properties: { ...f.properties, level: period < 0 ? 0 : levelOf(data, f.properties.code, period) } }),
    ),
  };
}

const byLevel = (values: [number, number, number, number], none = 0) => ['match', ['get', 'level'], 1, values[0], 2, values[1], 3, values[2], 4, values[3], none] as never;

export const weatherAlerts = defineModule<AlertsData>({
  id: 'vigilance-meteo',
  name: 'Vigilance météo',
  category: 'environnement',
  description: 'Niveau de vigilance de Météo-France pour chaque département, aujourd’hui et demain, de vert à rouge.',
  attribution: 'Météo-France (Licence Ouverte), contours IGN Admin Express',
  refreshIntervalMs: 10 * 60_000,
  timeStepMs: 60_000,

  load: ({ signal }) => loadAlerts(signal),

  legend() {
    return [4, 3, 2, 1].map((level) => ({
      color: LEVELS[level]!.color,
      icon: swatch(level),
      label: `Vigilance ${LEVELS[level]!.name}${level === 1 ? '' : level === 4 ? ' (hachures croisées)' : level === 3 ? ' (hachures serrées)' : ' (hachures espacées)'}`,
    }));
  },

  summary({ data, time }) {
    if (!data) return null;
    const period = periodAt(data, time);
    if (period < 0) return 'Le bulletin couvre deux jours seulement : celui de son émission et le suivant';
    const counts = [2, 3, 4].map((level) => Object.keys(data.departments).filter((code) => levelOf(data, code, period) === level).length);
    const alerts = [counts[2] ? `${counts[2]} en rouge` : '', counts[1] ? `${counts[1]} en orange` : '', counts[0] ? `${counts[0]} en jaune` : ''].filter(Boolean);
    return `${dayName(data, period)} : ${alerts.length ? alerts.join(', ') : 'tous les départements en vert'} · bulletin de ${formatDateTime(data.issuedAt * 1000)}`;
  },

  native: {
    add(map: MapLibreMap) {
      shown = undefined;
      for (const [level, pattern] of [[2, 'sparse'], [3, 'dense'], [4, 'cross']] as const) {
        const image = patternImage(pattern);
        const name = `${PATTERN_ID}-${level}`;
        if (image && !map.hasImage(name)) map.addImage(name, image, { pixelRatio: 2 });
      }
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const before = firstSymbolLayerId(map);
      map.addLayer(
        {
          id: FILL_ID,
          type: 'fill',
          source: SOURCE_ID,
          paint: {
            'fill-color': ['match', ['get', 'level'], 2, LEVELS[2]!.color, 3, LEVELS[3]!.color, 4, LEVELS[4]!.color, LEVELS[1]!.color] as never,
            // Le vert est presque transparent : on voit d'abord ce qui demande de la vigilance.
            'fill-opacity': byLevel([0.1, 0.45, 0.55, 0.65], 0),
          },
        },
        before,
      );
      map.addLayer(
        {
          id: PATTERN_ID,
          type: 'fill',
          source: SOURCE_ID,
          filter: ['>=', ['get', 'level'], 2],
          paint: {
            'fill-pattern': ['match', ['get', 'level'], 2, `${PATTERN_ID}-2`, 3, `${PATTERN_ID}-3`, `${PATTERN_ID}-4`] as never,
          },
        },
        before,
      );
      map.addLayer(
        {
          id: LINE_ID,
          type: 'line',
          source: SOURCE_ID,
          filter: ['>=', ['get', 'level'], 1],
          layout: { 'line-join': 'round' },
          paint: {
            'line-color': INK,
            'line-opacity': byLevel([0.35, 0.8, 0.9, 0.95], 0),
            'line-width': ['interpolate', ['linear'], ['zoom'], 4, byLevel([0.4, 1, 1.8, 2.8]), 9, byLevel([0.8, 2, 3.4, 5.2])] as never,
          },
        },
        before,
      );
      map.addLayer(
        {
          id: SELECTED_ID,
          type: 'line',
          source: SOURCE_ID,
          filter: ['==', ['get', 'code'], ''],
          paint: { 'line-color': '#4f8cff', 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3, 9, 6] },
        },
        before,
      );
    },
    update(map, { data, time, selection }) {
      if (data) {
        const period = periodAt(data, time);
        if (!shown || shown.data !== data || shown.period !== period) {
          (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(colored(data, period) as unknown as Parameters<GeoJSONSource['setData']>[0]);
          shown = { data, period };
        }
      }
      const code = (selection as { code: string } | null)?.code ?? '';
      if (map.getLayer(SELECTED_ID)) map.setFilter(SELECTED_ID, ['==', ['get', 'code'], code]);
    },
    remove(map) {
      for (const id of [SELECTED_ID, LINE_ID, PATTERN_ID, FILL_ID]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      for (const level of [2, 3, 4]) if (map.hasImage(`${PATTERN_ID}-${level}`)) map.removeImage(`${PATTERN_ID}-${level}`);
      shown = undefined;
    },
    pickable: {
      layerIds: [FILL_ID],
      toObject: (feature) => ({ code: String(feature.properties?.code ?? '') }),
    },
  },

  select(object) {
    const code = (object as { code: string }).code;
    return code ? { code } : null;
  },

  describe(selection, { data, time }) {
    const code = (selection as { code: string }).code;
    const feature = (departements as unknown as { features: Array<{ properties: { code: string; nom: string } }> }).features.find((f) => f.properties.code === code);
    if (!data || !feature) return null;
    const period = periodAt(data, time);
    const title = `${feature.properties.nom} (${code})`;
    if (period < 0) {
      return { title, subtitle: 'Vigilance météo', note: 'Le bulletin de Météo-France ne couvre que deux jours (celui de son émission et le suivant) : aucune information pour cet instant.' };
    }
    const entry = data.departments[code]?.[period];
    const level = entry?.max ?? 1;
    return {
      title,
      subtitle: `Vigilance météo · ${dayName(data, period)} · bulletin de ${formatDateTime(data.issuedAt * 1000)}`,
      fields: [['Niveau maximal', `Vigilance ${LEVELS[level]!.name}`]],
      tables: [
        {
          title: 'Phénomènes en vigilance jaune ou plus',
          columns: ['Phénomène', 'Niveau', 'Créneau'],
          empty: 'Aucun phénomène : tous sont en vert.',
          rows: (entry?.phenomena ?? []).map((p) => ({
            cells: [PHENOMENA[p.id] ?? `Phénomène ${p.id}`, LEVELS[p.level]!.name, slotText(p.slots)],
            tone: p.level >= 3 ? ('alert' as const) : undefined,
          })),
        },
      ],
      note: LEVELS[level]!.text,
      link: { href: 'https://vigilance.meteofrance.fr/', label: 'Carte et bulletins sur Météo-France' },
    };
  },
});
