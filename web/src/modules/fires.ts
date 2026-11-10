/**
 * Module « Feux » : les points chauds détectés par satellite (NASA FIRMS, capteurs
 * VIIRS) sur les 7 derniers jours, en France et autour.
 *
 * Un point chaud peut être un incendie, mais aussi un brûlage agricole ou une
 * installation industrielle : la fiche le rappelle. La couleur dit l'âge de la
 * détection à l'instant t (on la voit apparaître en rejouant la semaine), la taille
 * sa puissance radiative.
 */
import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import { plainStatus } from '../core/infoStatus';
import { defineModule } from '../core/module';
import { formatDateTime, formatRelative, formatTime } from '../ui/format';
import { OVER_MAP } from '../map/parameters';
import { HALO, ink, type IconSheet, KEY, packIcons, selectionRing, zoomRamp } from './symbols';

interface Fire {
  lon: number;
  lat: number;
  /** Heure de la détection (secondes UTC). */
  time: number;
  /** Puissance radiative, en mégawatts. */
  frp: number;
  confidence: string;
  satellite: string;
  day: boolean;
  key: string;
}

interface FiresData {
  fires: Fire[];
  byKey: Map<string, Fire>;
}

const HOUR = 3600;
const WINDOW_S = 7 * 24 * HOUR;
/** Âge de la détection, du plus récent (foncé) au plus ancien (clair) : une seule teinte, validée. */
const AGES = [
  { maxAge: 24 * HOUR, color: [94, 15, 8] as [number, number, number], css: '#5e0f08', label: 'Moins de 24 h' },
  { maxAge: 3 * 24 * HOUR, color: [177, 58, 31] as [number, number, number], css: '#b13a1f', label: '1 à 3 jours' },
  { maxAge: WINDOW_S, color: [232, 120, 75] as [number, number, number], css: '#e8784b', label: '3 à 7 jours' },
];
/** À partir de ce zoom, un point chaud est une flamme ; avant, un point (halo clair, contour sombre). */
const FLAME_MIN_ZOOM = 9;
const CONFIDENCE: Record<string, string> = { l: 'faible', n: 'normale', h: 'élevée' };

const ageClass = (age: number) => AGES.findIndex((a) => age <= a.maxAge);


// --- Flamme (tracé de la planche des symboles, en u) ---

const FLAME_SCALE = 1.3;
const FLAME_W = Math.ceil((40 + 2 + 2 * 2.4 + 2) * FLAME_SCALE);
const FLAME_H = Math.ceil((52 + 2 + 2 * 2.4 + 2) * FLAME_SCALE);
const flameKey = (age: number) => `flamme:${age}`;

let flames: IconSheet | undefined;
/** Les flammes sont dessinées au premier usage (il faut un document pour créer un canvas). */
function flameSheet(): IconSheet {
  flames ??= packIcons(
    AGES.map((age, index) => ({
      key: flameKey(index),
      width: FLAME_W,
      height: FLAME_H,
      draw(c: CanvasRenderingContext2D) {
        c.translate(FLAME_W / 2, FLAME_H / 2 + 2 * FLAME_SCALE);
        c.scale(FLAME_SCALE, FLAME_SCALE);
        ink(
          c,
          (k) => {
            k.beginPath();
            k.moveTo(0, -28);
            k.bezierCurveTo(16, -12, 20, 2, 16, 12);
            k.bezierCurveTo(12, 24, -12, 24, -16, 12);
            k.bezierCurveTo(-20, 0, -12, -6, -8, -14);
            k.bezierCurveTo(-4, -4, 2, -6, 0, -28);
          },
          age.css,
          { key: 2 },
        );
      },
    })),
  );
  return flames;
}

/** Les détections visibles à cet instant : gardées d'une minute à l'autre pour que deck.gl ne recalcule rien. */
let visibleCache: { data: FiresData; minute: number; fires: Fire[] } | undefined;
function visibleFires(data: FiresData, t: number, minute: number): Fire[] {
  if (visibleCache?.data !== data || visibleCache.minute !== minute) {
    visibleCache = { data, minute, fires: data.fires.filter((f) => f.time <= t && t - f.time <= WINDOW_S) };
  }
  return visibleCache.fires;
}

/** Taille de la flamme en pixels : plus le feu est puissant, plus elle est grande. */
const flameSize = (f: Fire) => Math.min(34, 15 + Math.sqrt(Math.max(f.frp, 0)) * 1.6);
const dotRadius = (f: Fire) => Math.min(14, 3 + Math.sqrt(Math.max(f.frp, 0)) * 1.2);

async function loadFires(signal: AbortSignal): Promise<FiresData> {
  const response = await fetch('/api/feux', { signal });
  if (response.status === 503) throw new Error('le serveur récupère encore les détections');
  if (!response.ok) throw new Error(`le serveur des feux a répondu ${response.status}`);
  const json = (await response.json()) as { fires: Omit<Fire, 'key'>[] };
  // Les plus récents en dernier : ils sont dessinés par-dessus.
  const fires = json.fires
    .map((f) => ({ ...f, key: `${f.satellite}|${f.time}|${f.lon}|${f.lat}` }))
    .sort((a, b) => a.time - b.time);
  return { fires, byKey: new Map(fires.map((f) => [f.key, f])) };
}

export const fires = defineModule<FiresData>({
  id: 'feux',
  name: 'Feux',
  category: 'environnement',
  description: 'Points chauds détectés par satellite ces 7 derniers jours : incendies, brûlages, sites industriels.',
  attribution: 'NASA FIRMS (VIIRS)',
  refreshIntervalMs: 30 * 60_000,
  timeStepMs: 60_000, // l'âge des détections change avec l'instant affiché
  followsTerrain: true,
  zoomBreaks: [9, 9.5, 10, 10.5, 11, 11.5, 12],

  legend() {
    return [
      ...AGES.map((a) => ({ color: a.css, label: a.label, size: 'medium' as const })),
      { color: '#b13a1f', label: 'Taille : puissance du feu', size: 'large' as const },
    ];
  },

  load: ({ signal }) => loadFires(signal),

  summary({ data, time }) {
    if (!data) return null;
    const t = time / 1000;
    const visible = data.fires.filter((f) => f.time <= t && t - f.time <= WINDOW_S);
    const recent = visible.filter((f) => t - f.time <= 24 * HOUR).length;
    return `${visible.length.toLocaleString('fr-FR')} détections sur 7 jours · ${recent} ces dernières 24 h`;
  },

  deckLayers({ data, time, selection, terrain, view }) {
    if (!data) return [];
    const t = time / 1000;
    const minute = Math.floor(t / 60);
    const chosen = selection ? data.byKey.get((selection as { key: string }).key) : undefined;
    const parameters = OVER_MAP;
    const onGround = (f: Fire): [number, number, number] => [f.lon, f.lat, terrain.elevation(f.lon, f.lat)];
    const shown = visibleFires(data, t, minute);
    const flaming = view.zoom >= FLAME_MIN_ZOOM;
    const sheet = flaming ? flameSheet() : undefined;
    const scale = zoomRamp(view.zoom, FLAME_MIN_ZOOM, 12, 0.8, 1);
    return [
      // De loin : un point par détection, à la couleur de son âge, avec le halo et le contour du trait commun.
      !flaming &&
        new ScatterplotLayer<Fire>({
          id: 'feux/halo',
          data: shown,
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: (f) => dotRadius(f) + 2.4,
          getFillColor: HALO,
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters,
        }),
      !flaming &&
        new ScatterplotLayer<Fire>({
          id: 'feux/detections',
          data: shown,
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: dotRadius,
          getFillColor: (f) => [...AGES[ageClass(t - f.time)]!.color, 235],
          stroked: true,
          getLineColor: KEY,
          lineWidthUnits: 'pixels',
          getLineWidth: 1.2,
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 140],
          updateTriggers: { getFillColor: minute, getPosition: terrain.version },
          parameters,
        }),
      // De près : une flamme, de la couleur de l'âge et d'autant plus grande que le feu est puissant.
      sheet &&
        new IconLayer<Fire>({
          id: 'feux/flammes',
          data: shown,
          iconAtlas: sheet.atlas,
          iconMapping: sheet.mapping,
          getIcon: (f) => flameKey(ageClass(t - f.time)),
          getPosition: onGround,
          sizeUnits: 'pixels',
          getSize: flameSize,
          sizeScale: scale,
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 140],
          updateTriggers: { getIcon: minute, getPosition: terrain.version },
          parameters,
        }),
      chosen &&
        selectionRing('feux/choisi', [chosen], onGround, flaming ? flameSize(chosen) * 0.62 * scale : dotRadius(chosen) + 7, parameters),
    ];
  },

  select(object) {
    return { key: (object as Fire).key };
  },

  describe(selection, { data }) {
    const fire = data?.byKey.get((selection as { key: string }).key);
    if (!fire) return null;
    return {
      kind: 'Point chaud · satellite',
      title: 'Point chaud détecté',
      subtitle: formatDateTime(fire.time * 1000),
      // Les passages de satellite se succèdent à quelques heures d'écart : ce n'est pas du direct.
      status: plainStatus(`Détecté ${formatRelative(fire.time * 1000)}`),
      figures: [
        { value: fire.frp.toLocaleString('fr-FR', { maximumFractionDigits: 1 }), unit: 'MW', label: 'puissance radiative' },
        { value: formatTime(fire.time * 1000), label: fire.day ? 'détection de jour' : 'détection de nuit' },
        { value: fire.satellite, label: 'satellite' },
      ],
      fields: [['Fiabilité', CONFIDENCE[fire.confidence] ?? fire.confidence]],
      note: 'Un point chaud est une zone de 375 m plus chaude que son entourage : un incendie, mais aussi un brûlage agricole, une torchère ou un site industriel.',
      actions: [
        {
          label: 'Source',
          href: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs,7days;@${fire.lon.toFixed(3)},${fire.lat.toFixed(3)},11.0z`,
        },
      ],
    };
  },
});
