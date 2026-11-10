/**
 * Module « Feux » : les points chauds détectés par satellite (NASA FIRMS, capteurs
 * VIIRS) sur les 7 derniers jours, en France et autour.
 *
 * Un point chaud peut être un incendie, mais aussi un brûlage agricole ou une
 * installation industrielle : la fiche le rappelle. La couleur dit l'âge de la
 * détection à l'instant t (on la voit apparaître en rejouant la semaine), la taille
 * sa puissance radiative.
 */
import type { Color } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { formatDateTime } from '../ui/format';

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
/** Contour clair : reste visible sur la carte claire comme sous l'ombre de la nuit. */
const RING: Color = [255, 255, 255, 200];
const CONFIDENCE: Record<string, string> = { l: 'faible', n: 'normale', h: 'élevée' };

const ageClass = (age: number) => AGES.findIndex((a) => age <= a.maxAge);

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

  deckLayers({ data, time, selection, terrain }) {
    if (!data) return [];
    const t = time / 1000;
    const minute = Math.floor(t / 60);
    const chosen = selection ? data.byKey.get((selection as { key: string }).key) : undefined;
    const parameters = { depthCompare: 'always', depthWriteEnabled: false } as const;
    const onGround = (f: Fire): [number, number, number] => [f.lon, f.lat, terrain.elevation(f.lon, f.lat)];
    return [
      new ScatterplotLayer<Fire>({
        id: 'feux/detections',
        data: data.fires,
        getPosition: onGround,
        radiusUnits: 'pixels',
        getRadius: (f) => Math.min(14, 3 + Math.sqrt(Math.max(f.frp, 0)) * 1.2),
        // Une détection n'apparaît qu'à partir de son heure, et disparaît après 7 jours.
        getFillColor: (f) => {
          const age = t - f.time;
          if (age < 0 || age > WINDOW_S) return [0, 0, 0, 0];
          return [...AGES[ageClass(age)]!.color, 235];
        },
        getLineColor: (f) => (f.time > t || t - f.time > WINDOW_S ? [0, 0, 0, 0] : RING),
        stroked: true,
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        updateTriggers: { getFillColor: minute, getLineColor: minute, getPosition: terrain.version },
        parameters,
      }),
      chosen &&
        new ScatterplotLayer<Fire>({
          id: 'feux/choisi',
          data: [chosen],
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: 14,
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
    return { key: (object as Fire).key };
  },

  describe(selection, { data }) {
    const fire = data?.byKey.get((selection as { key: string }).key);
    if (!fire) return null;
    return {
      title: 'Point chaud détecté par satellite',
      subtitle: formatDateTime(fire.time * 1000),
      fields: [
        ['Puissance radiative', `${fire.frp.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} MW`],
        ['Fiabilité', CONFIDENCE[fire.confidence] ?? fire.confidence],
        ['Détection', `${fire.day ? 'de jour' : 'de nuit'}, satellite ${fire.satellite}`],
      ],
      note: 'Un point chaud est une zone de 375 m plus chaude que son entourage : un incendie, mais aussi un brûlage agricole, une torchère ou un site industriel.',
      link: {
        href: `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs,7days;@${fire.lon.toFixed(3)},${fire.lat.toFixed(3)},11.0z`,
        label: 'Voir sur la carte FIRMS de la NASA',
      },
    };
  },
});
