/**
 * Module « Radar de pluie » : la réflectivité des radars météo (RainViewer), drapée
 * sur le relief par MapLibre et animée par l'horloge globale.
 *
 * Ce que le service permet aujourd'hui (documentation et réponses vérifiées en novembre 2026) :
 * - les 2 dernières heures seulement, une image toutes les 10 minutes ; plus de prévision
 *   immédiate (la liste `nowcast` est toujours vide) ;
 * - des tuiles jusqu'au zoom 7 au plus (au-delà, le serveur renvoie une image vide) ;
 * - un seul schéma de couleurs, « Universal Blue » : le choix de l'adresse est ignoré, et ce
 *   schéma passe du bleu au jaune, au rouge et au rose, ce qui n'est pas une rampe d'une seule teinte ;
 * - 500 requêtes par minute et par adresse IP (300 en rafale), et une mention de la source.
 *
 * Comme les conditions d'utilisation autorisent à « changer les images reçues (par exemple
 * appliquer un autre schéma de couleurs) », on retrouve l'intensité de chaque pixel d'après
 * la table de couleurs publiée (`dBZ`) et on le redessine dans une rampe bleue d'une seule teinte.
 * Cela passe par un protocole MapLibre (`pluie://`) qui télécharge la tuile, la recolore et la rend
 * à MapLibre comme une image : la couche reste une couche raster native, drapée sur le relief.
 *
 * Animation sans clignotement : chaque image du radar a sa source et sa couche (celles de
 * l'image courante, de la précédente et des deux suivantes sont gardées, donc déjà chargées
 * quand l'horloge y arrive), et on fond deux images voisines l'une dans l'autre selon l'instant t.
 */
import { PLUIE } from '../design/tokens';
import { addProtocol, type Map as MapLibreMap, type RasterSourceSpecification } from 'maplibre-gl';
import { defineModule, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { formatTime } from '../ui/format';

const WEATHER_MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
const DEFAULT_HOST = 'https://tilecache.rainviewer.com';
const PROTOCOL = 'pluie';
const ATTRIBUTION = '<a href="https://www.rainviewer.com/" target="_blank" rel="noreferrer">RainViewer</a>';
/** Intervalle entre deux images du radar. */
const FRAME_STEP_S = 600;
/**
 * Une image reste valable un peu plus que son pas : la dernière publiée a déjà 5 à 10 minutes
 * de retard quand elle arrive, et c'est elle qu'on veut voir « maintenant ».
 */
const LAST_FRAME_VALID_S = 900;
/** Zoom maximal du service avec des tuiles de 512 pixels : une image 512 par tuile du zoom 6 est déjà plus fine que le radar. */
const TILE_MAX_ZOOM = 6;
const TILE_SIZE = 512;
/** Images déjà préparées devant l'instant affiché, et gardées derrière. */
const KEEP_AHEAD = 2;
const KEEP_BEHIND = 1;
/** Requêtes de tuiles en même temps : on reste loin de la limite du service (500 par minute). */
const MAX_PARALLEL_FETCHES = 8;

interface Frame {
  /** Heure de l'image (secondes UTC). */
  time: number;
  /** Identifiant de l'image dans le chemin des tuiles. */
  id: string;
}

interface RainData {
  frames: Frame[];
}

/**
 * Rampe d'une seule teinte (bleu), de la pluie faible à la pluie très forte. Chaque pas est plus
 * foncé que le précédent. Valeurs validées avec `validate_palette.js --ordinal` en clair et en sombre.
 */
const RAMP = PLUIE.jour;
/** Réflectivité (dBZ) où chaque pas de la rampe est atteint, d'après la relation de Marshall-Palmer. */
const RAMP_DBZ = [20, 28, 36, 44, 52] as const;
const LEGEND_LABELS = ['Faible (moins de 1 mm/h)', 'Modérée (1 à 3 mm/h)', 'Soutenue (3 à 10 mm/h)', 'Forte (10 à 30 mm/h)', 'Très forte (plus de 30 mm/h)'];
/** Opacité des pixels : discrète pour la bruine, franche pour l'orage. */
const ALPHA_MIN = 0.5;
const ALPHA_MAX = 0.92;

/**
 * Couleurs du schéma « Universal Blue » de RainViewer de 15 à 65 dBZ (table publiée sur
 * rainviewer.com/files/rainviewer_api_colors_table.csv). En dessous de 15 dBZ, le schéma ne dessine
 * qu'un voile gris presque transparent (échos faibles) : on l'ignore.
 */
const UNIVERSAL_BLUE = [
  '88ddee', '6cd1eb', '51c5e8', '36bae5', '1baee2', '00a3e0', '009ad5', '0091ca', '0088bf', '007fb4',
  '0077aa', '0070a3', '00699c', '006295', '005b8e', '005588', '005180', '004e78', '004a70', '004768',
  'ffee00', 'ffe000', 'ffd200', 'ffc500', 'ffb700', 'ffaa00', 'ff9f00', 'ff9500', 'ff8b00', 'ff8100',
  'ff4400', 'f23600', 'e62800', 'd91b00', 'cd0d00', 'c10000', 'a80000', '8f0000', '760000', '5d0000',
  'ffaaff', 'ff9fff', 'ff95ff', 'ff8bff', 'ff81ff', 'ff77ff', 'ff6cff', 'ff62ff', 'ff58ff', 'ff4eff',
  'ffffff',
].map((hex) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] as const);
const MIN_DBZ = 15;

const hexToRgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** Pour chaque dBZ entier de 15 à 65 : la couleur de la rampe, avec son opacité (0-255). */
const RAMP_BY_DBZ: ReadonlyArray<readonly [number, number, number, number]> = UNIVERSAL_BLUE.map((_, index) => {
  const dbz = MIN_DBZ + index;
  const colors = RAMP.map(hexToRgb);
  let step = RAMP_DBZ.findIndex((limit) => dbz < limit);
  if (step === -1) step = RAMP_DBZ.length; // plus fort que le dernier pas
  const lower = Math.max(0, step - 1);
  const upper = Math.min(RAMP.length - 1, step);
  const span = (RAMP_DBZ[upper] ?? 0) - (RAMP_DBZ[lower] ?? 0);
  const t = span > 0 ? Math.min(1, Math.max(0, (dbz - (RAMP_DBZ[lower] ?? 0)) / span)) : 0;
  const mix = (channel: 0 | 1 | 2) => Math.round(colors[lower]![channel] + (colors[upper]![channel] - colors[lower]![channel]) * t);
  const strength = Math.min(1, Math.max(0, (dbz - RAMP_DBZ[0]) / (RAMP_DBZ[RAMP_DBZ.length - 1]! - RAMP_DBZ[0])));
  return [mix(0), mix(1), mix(2), Math.round(255 * (ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * strength))] as const;
});

/** Mémorise, pour chaque couleur d'un pixel, la réflectivité la plus proche dans la table (ou -1 : pas de pluie). */
const dbzOfColor = new Map<number, number>();

function dbzIndex(r: number, g: number, b: number): number {
  const key = (r << 16) | (g << 8) | b;
  const known = dbzOfColor.get(key);
  if (known !== undefined) return known;
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < UNIVERSAL_BLUE.length; index++) {
    const [cr, cg, cb] = UNIVERSAL_BLUE[index]!;
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  dbzOfColor.set(key, best);
  return best;
}

/** Recolore une tuile du radar : même formes, couleurs de la rampe. */
export function recolor(pixels: Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) {
      pixels[i + 3] = 0; // pas d'écho, ou voile très léger
      continue;
    }
    const [r, g, b, a] = RAMP_BY_DBZ[dbzIndex(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)]!;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = a;
  }
}

// --- Téléchargement des tuiles, par le protocole « pluie:// » ---

let tileHost = DEFAULT_HOST;
let running = 0;
const waiting: Array<() => void> = [];
let protocolRegistered = false;
let rateLimitWarned = false;

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL_FETCHES) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function registerProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  // Adresse demandée par MapLibre : pluie://<identifiant>/<z>/<x>/<y>
  addProtocol(PROTOCOL, async (request, abortController) => {
    const match = /^pluie:\/\/([A-Za-z0-9]+)\/(\d+)\/(\d+)\/(\d+)$/.exec(request.url);
    if (!match) throw new Error(`adresse de tuile inattendue : ${request.url}`);
    const [, id, z, x, y] = match;
    // `1_0` : image lissée, sans couleurs spéciales pour la neige ; le « 2 » est le seul schéma proposé.
    const url = `${tileHost}/v2/radar/${id}/${TILE_SIZE}/${z}/${x}/${y}/2/1_0.png`;
    const bitmap = await withSlot(async () => {
      const response = await fetch(url, { signal: abortController.signal });
      if (response.status === 429 && !rateLimitWarned) {
        rateLimitWarned = true;
        console.warn('[radar] RainViewer limite le nombre de requêtes : des tuiles manqueront un moment');
      }
      if (!response.ok) throw new Error(`RainViewer a répondu ${response.status}`);
      return createImageBitmap(await response.blob());
    });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas indisponible');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    recolor(image.data);
    context.putImageData(image, 0, 0);
    // MapLibre accepte une ImageBitmap telle quelle : pas besoin de ré-encoder en PNG.
    return { data: canvas.transferToImageBitmap() };
  });
}

// --- Couches MapLibre ---

const sourceId = (frame: Frame) => `pluie-${frame.id}`;
const layerId = (frame: Frame) => `pluie-${frame.id}`;
const FRAME_LAYER_PREFIX = 'pluie-';

/** Opacité réellement posée sur chaque couche (pour ne pas réécrire le style à chaque image). */
const appliedOpacity = new Map<string, number>();

function frameLayers(map: MapLibreMap): string[] {
  return map
    .getStyle()
    .layers.filter((layer) => layer.id.startsWith(FRAME_LAYER_PREFIX))
    .map((layer) => layer.id);
}

function removeFrame(map: MapLibreMap, id: string): void {
  if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(id)) map.removeSource(id);
  appliedOpacity.delete(id);
}

function addFrame(map: MapLibreMap, frame: Frame): void {
  if (map.getSource(sourceId(frame))) return;
  const source: RasterSourceSpecification = {
    type: 'raster',
    tiles: [`${PROTOCOL}://${frame.id}/{z}/{x}/{y}`],
    tileSize: TILE_SIZE,
    maxzoom: TILE_MAX_ZOOM,
    attribution: ATTRIBUTION,
  };
  map.addSource(sourceId(frame), source);
  // Sous l'ombre de la nuit si elle est là, sinon sous les étiquettes.
  const before = map.getLayer('jour-nuit') ? 'jour-nuit' : firstSymbolLayerId(map);
  map.addLayer(
    {
      id: layerId(frame),
      type: 'raster',
      source: sourceId(frame),
      // Visible mais transparente : MapLibre charge ses tuiles dès maintenant, l'image est prête quand l'horloge arrive.
      paint: { 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
    },
    before,
  );
  appliedOpacity.set(layerId(frame), 0);
}

function setOpacity(map: MapLibreMap, id: string, opacity: number): void {
  const value = Math.round(opacity * 100) / 100;
  if (appliedOpacity.get(id) === value || !map.getLayer(id)) return;
  map.setPaintProperty(id, 'raster-opacity', value);
  appliedOpacity.set(id, value);
}

/** Ce qu'il faut afficher à l'instant t : les deux images voisines et leur fondu, ou rien. */
export interface RainPlan {
  /** Position de l'image la plus ancienne des deux. */
  index: number;
  /** Avancement de `index` vers `index + 1`, de 0 à 1 (0 quand il n'y a pas d'image suivante). */
  mix: number;
}

export function planFor(frames: readonly Frame[], t: number): RainPlan | null {
  const first = frames[0];
  const last = frames[frames.length - 1];
  if (!first || !last || t < first.time || t > last.time + LAST_FRAME_VALID_S) return null;
  let index = 0;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.time <= t) index = i;
  }
  const next = frames[index + 1];
  if (!next) return { index, mix: 0 };
  const gap = next.time - frames[index]!.time;
  // Trou dans la série : on ne fond pas deux images éloignées l'une dans l'autre.
  if (gap > 2 * FRAME_STEP_S) return t - frames[index]!.time <= FRAME_STEP_S ? { index, mix: 0 } : null;
  return { index, mix: (t - frames[index]!.time) / gap };
}

/** Fondu enchaîné sans creux d'opacité : l'image qui part reste pleine jusqu'à mi-chemin, celle qui arrive est pleine dès la mi-chemin. */
export function fadeOpacities(mix: number): { from: number; to: number } {
  return { from: Math.min(1, 2 * (1 - mix)), to: Math.min(1, 2 * mix) };
}

async function loadRain(signal: AbortSignal): Promise<RainData> {
  const response = await fetch(WEATHER_MAPS_URL, { signal });
  if (!response.ok) throw new Error(`RainViewer a répondu ${response.status}`);
  const json = (await response.json()) as {
    host?: string;
    radar?: { past?: Array<{ time: number; path: string }>; nowcast?: Array<{ time: number; path: string }> };
  };
  // On ne télécharge que sur le domaine de RainViewer, quoi que dise la réponse.
  if (json.host && /^https:\/\/[a-z0-9.-]*\.rainviewer\.com$/.test(json.host)) tileHost = json.host;
  // Le passé, et la prévision immédiate quand le service en fournit (ce n'est plus le cas aujourd'hui).
  const raw = [...(json.radar?.past ?? []), ...(json.radar?.nowcast ?? [])];
  const frames = raw
    .map((item) => ({ time: item.time, id: item.path.split('/').pop() ?? '' }))
    .filter((frame) => /^[A-Za-z0-9]+$/.test(frame.id))
    .sort((a, b) => a.time - b.time);
  if (frames.length === 0) throw new Error('RainViewer ne publie aucune image pour le moment');
  return { frames };
}

export const rain = defineModule<RainData>({
  id: 'pluie',
  name: 'Radar de pluie',
  category: 'ciel',
  description: 'Où il pleut : les radars météo des 2 dernières heures, une image toutes les 10 minutes.',
  attribution: 'RainViewer (rainviewer.com), radars météo ; recoloré ici',
  refreshIntervalMs: 5 * 60_000,
  // Le fondu entre deux images progresse de 1 % toutes les 6 secondes simulées : fluide à toutes les vitesses.
  timeStepMs: 5_000,

  load: ({ signal }) => loadRain(signal),

  legend(): LegendItem[] {
    return RAMP.map((color, i) => ({ color, label: LEGEND_LABELS[i] ?? '', size: 'medium' as const }));
  },

  summary({ data, time }) {
    const frames = data?.frames;
    if (!frames?.length) return null;
    const t = time / 1000;
    const plan = planFor(frames, t);
    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    if (!plan) {
      const window = `de ${formatTime(first.time * 1000)} à ${formatTime((last.time + FRAME_STEP_S) * 1000)}`;
      return `Radar masqué : il ne couvre que les 2 dernières heures (${window})`;
    }
    const shown = frames[plan.mix >= 0.5 ? Math.min(plan.index + 1, frames.length - 1) : plan.index]!;
    return `Image de ${formatTime(shown.time * 1000)} · pas de prévision de pluie disponible`;
  },

  native: {
    add() {
      registerProtocol();
    },

    update(map, { data, time }) {
      const frames = data?.frames ?? [];
      const plan = planFor(frames, time / 1000);
      if (!plan) {
        // Hors de la fenêtre : on retire tout (aucune requête inutile).
        for (const id of frameLayers(map)) removeFrame(map, id);
        return;
      }
      const wanted = new Set<string>();
      for (let i = Math.max(0, plan.index - KEEP_BEHIND); i <= Math.min(frames.length - 1, plan.index + 1 + KEEP_AHEAD); i++) {
        const frame = frames[i]!;
        wanted.add(layerId(frame));
        addFrame(map, frame);
      }
      // Les images qui ne sont plus dans la fenêtre (ou qui ont quitté la liste du service) sont retirées.
      for (const id of frameLayers(map)) if (!wanted.has(id)) removeFrame(map, id);

      // Toutes les images préparées sont transparentes, sauf les deux qui se fondent l'une dans l'autre.
      const targets = new Map<string, number>([...wanted].map((id) => [id, 0]));
      const to = frames[plan.index + 1];
      const { from: fromOpacity, to: toOpacity } = fadeOpacities(plan.mix);
      targets.set(layerId(frames[plan.index]!), fromOpacity);
      if (to && plan.mix > 0) targets.set(layerId(to), toOpacity);
      for (const [id, opacity] of targets) setOpacity(map, id, opacity);
    },

    remove(map) {
      for (const id of frameLayers(map)) removeFrame(map, id);
    },
  },
});
