/**
 * Module « Vigilance crues » : le niveau de vigilance des 337 tronçons de rivières
 * surveillés par l'État (Vigicrues), mis à jour au moins deux fois par jour.
 *
 * Les rivières sont dessinées par MapLibre (couche native) : drapées sur le relief,
 * elles suivent exactement celles du fond de carte, même en montagne.
 *
 * La vigilance est un statut officiel (vert, jaune, orange, rouge). Pour ne pas
 * reposer sur la couleur seule (le rouge et le vert se confondent chez les daltoniens),
 * l'épaisseur du trait augmente aussi avec le niveau, et la fiche donne le libellé.
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { defineModule } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { formatDateTime } from '../ui/format';
import { STATUS_COLORS, addSelectionRing, selectionRingIds, selectionRingLayers, setSelectionRingFilter } from './statusColors';

const URL = 'https://www.vigicrues.gouv.fr/services/InfoVigiCru.geojson';
const SOURCE_ID = 'vigicrues';
const CASING_ID = 'vigicrues-contour';
const LINE_ID = 'vigicrues';
const SELECTED_ID = 'vigicrues-choisi';

/** Niveaux officiels, avec la couleur de statut (fixe, jamais réutilisée ailleurs) et le libellé Vigicrues. */
const LEVELS: Record<number, { name: string; color: string; text: string }> = {
  1: { name: 'Vert', color: STATUS_COLORS.vert, text: 'Pas de vigilance particulière requise.' },
  2: {
    name: 'Jaune',
    color: STATUS_COLORS.jaune,
    text: 'Risque de crue ou de montée rapide des eaux n’entraînant pas de dommages significatifs, mais nécessitant une vigilance particulière dans le cas d’activités saisonnières ou exposées.',
  },
  3: {
    name: 'Orange',
    color: STATUS_COLORS.orange,
    text: 'Risque de crue génératrice de débordements importants susceptibles d’avoir un impact significatif sur la vie collective et la sécurité des biens et des personnes.',
  },
  4: {
    name: 'Rouge',
    color: STATUS_COLORS.rouge,
    text: 'Risque de crue majeure. Menace directe et généralisée de la sécurité des personnes et des biens.',
  },
};

interface SectionProperties {
  id: string;
  lbentcru: string;
  NivInfViCr: string | number;
}

/** Le GeoJSON de Vigicrues, réduit à ce qu'on utilise. */
interface SectionCollection {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; properties: SectionProperties; geometry: unknown }>;
  /** Heure du bulletin, « AAAA-MM-JJ HH:MM:SS ». */
  DtHrInfoVigiCru?: string;
}

interface FloodData {
  geojson: SectionCollection;
  /** Heure du bulletin (ms). */
  issuedAt: number;
  byId: Map<string, { name: string; level: number }>;
}

async function loadFloods(signal: AbortSignal): Promise<FloodData> {
  const response = await fetch(URL, { signal });
  if (!response.ok) throw new Error(`Vigicrues a répondu ${response.status}`);
  const geojson = (await response.json()) as SectionCollection;
  // Niveau en nombre (le service le donne parfois en texte), pour les expressions de style MapLibre.
  for (const feature of geojson.features) {
    feature.properties.NivInfViCr = Number(feature.properties.NivInfViCr) || 1;
  }
  const byId = new Map(
    geojson.features.map((f) => [String(f.properties.id), { name: f.properties.lbentcru, level: Number(f.properties.NivInfViCr) }]),
  );
  const issued = Date.parse((geojson.DtHrInfoVigiCru ?? '').replace(' ', 'T'));
  return { geojson, issuedAt: Number.isFinite(issued) ? issued : Date.now(), byId };
}

/** Expression MapLibre : une valeur par niveau de vigilance. */
function byLevel(values: [number, number, number, number]) {
  return ['match', ['get', 'NivInfViCr'], 2, values[1], 3, values[2], 4, values[3], values[0]] as const;
}

let shownData: FloodData | undefined;

export const floods = defineModule<FloodData>({
  id: 'vigicrues',
  name: 'Vigilance crues',
  category: 'environnement',
  description: 'Niveau de vigilance des rivières surveillées, de vert à rouge.',
  attribution: 'Vigicrues (Service central d’hydrométéorologie)',
  refreshIntervalMs: 30 * 60_000,
  timeStepMs: 3_600_000, // bulletin du moment : ne dépend pas de l'instant affiché

  load: ({ signal }) => loadFloods(signal),

  legend() {
    return [4, 3, 2, 1].map((level) => ({
      color: LEVELS[level]!.color,
      label: `Vigilance ${LEVELS[level]!.name.toLowerCase()}`,
      size: level >= 3 ? ('large' as const) : level === 2 ? ('medium' as const) : ('small' as const),
    }));
  },

  summary({ data }) {
    if (!data) return null;
    const counts = [2, 3, 4].map((level) => [...data.byId.values()].filter((s) => s.level === level).length);
    const alerts = [
      counts[2] ? `${counts[2]} en rouge` : '',
      counts[1] ? `${counts[1]} en orange` : '',
      counts[0] ? `${counts[0]} en jaune` : '',
    ].filter(Boolean);
    return `${data.byId.size} tronçons · ${alerts.length ? alerts.join(', ') : 'tous en vert'} · bulletin de ${formatDateTime(data.issuedAt)}`;
  },

  native: {
    add(map: MapLibreMap) {
      shownData = undefined;
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const before = firstSymbolLayerId(map);
      // Contour sombre puis trait coloré : lisible sur la carte claire comme sur la carte de nuit.
      map.addLayer(
        {
          id: CASING_ID,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#161a26',
            'line-opacity': byLevel([0.35, 0.8, 0.85, 0.9]) as never,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, byLevel([2, 4, 5.5, 7]), 10, byLevel([3.5, 7, 9, 11])] as never,
          },
        },
        before,
      );
      map.addLayer(
        {
          id: LINE_ID,
          type: 'line',
          source: SOURCE_ID,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': ['match', ['get', 'NivInfViCr'], 2, LEVELS[2]!.color, 3, LEVELS[3]!.color, 4, LEVELS[4]!.color, LEVELS[1]!.color] as never,
            // Le vert reste discret : on remarque d'abord ce qui demande de la vigilance.
            'line-opacity': byLevel([0.55, 1, 1, 1]) as never,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, byLevel([1, 2.5, 3.5, 5]), 10, byLevel([2, 4.5, 6.5, 8.5])] as never,
          },
        },
        before,
      );
      // Le tronçon choisi est entouré d'un anneau blanc cerné de sombre, sans teinte.
      addSelectionRing(map, selectionRingLayers(SELECTED_ID, SOURCE_ID, ['==', ['get', 'id'], ''], [[5, 2], [10, 4]], 3), before);
    },
    update(map, { data, selection }) {
      if (data && data !== shownData) {
        (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(data.geojson as Parameters<GeoJSONSource['setData']>[0]);
        shownData = data;
      }
      const id = (selection as { id: string } | null)?.id ?? '';
      setSelectionRingFilter(map, SELECTED_ID, ['==', ['get', 'id'], id]);
    },
    remove(map) {
      for (const id of [...selectionRingIds(SELECTED_ID), LINE_ID, CASING_ID]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      shownData = undefined;
    },
    pickable: {
      layerIds: [LINE_ID, CASING_ID],
      toObject: (feature) => ({ id: String(feature.properties?.id ?? '') }),
    },
  },

  select(object) {
    const id = (object as { id: string }).id;
    return id ? { id } : null;
  },

  describe(selection, { data }) {
    const section = data?.byId.get((selection as { id: string }).id);
    if (!section || !data) return null;
    const level = LEVELS[section.level] ?? LEVELS[1]!;
    return {
      title: section.name,
      subtitle: `Vigilance crues · bulletin de ${formatDateTime(data.issuedAt)}`,
      fields: [['Niveau', `Vigilance ${level.name.toLowerCase()}`]],
      note: level.text,
      link: { href: 'https://www.vigicrues.gouv.fr/', label: 'Carte et prévisions sur Vigicrues' },
    };
  },
});
