/**
 * Module « Électricité » : production et consommation de chaque région, au quart
 * d'heure (données éCO2mix de RTE, publiées sur la plateforme ODRÉ).
 *
 * Sur chaque région, une colonne empile la production de chaque filière ; un
 * anneau blanc marque la consommation. Colonne plus haute que l'anneau : la région
 * produit plus qu'elle ne consomme et exporte vers ses voisines.
 *
 * L'historique au quart d'heure est disponible : la couche suit la frise temporelle
 * (on voit par exemple le solaire monter puis descendre dans la journée).
 */
import { ColumnLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { formatTime } from '../ui/format';

const EXPORT_URL = 'https://odre.opendatasoft.com/api/explore/v2.1/catalog/datasets/eco2mix-regional-tr/exports/json';
const QUARTER_MS = 15 * 60_000;
const MAX_READING_AGE_MS = 2 * 3600_000;
/** Période chargée avant l'instant affiché (les données temps réel arrivent avec ~30 min de retard). */
const WINDOW_MS = 6 * 3600_000;

/** Filières, dans l'ordre d'empilement (couleurs validées pour des barres empilées, voir README). */
const SOURCES = [
  { key: 'hydraulique', label: 'Hydraulique', color: [42, 120, 214], css: '#2a78d6' },
  { key: 'solaire', label: 'Solaire', color: [235, 104, 52], css: '#eb6834' },
  { key: 'eolien', label: 'Éolien', color: [27, 175, 122], css: '#1baf7a' },
  { key: 'nucleaire', label: 'Nucléaire', color: [237, 161, 0], css: '#eda100' },
  { key: 'thermique', label: 'Thermique (gaz, charbon, fioul)', color: [232, 123, 164], css: '#e87ba4' },
  { key: 'bioenergies', label: 'Bioénergies', color: [0, 131, 0], css: '#008300' },
] as const;
type SourceKey = (typeof SOURCES)[number]['key'];

/** Centre visuel des 12 régions métropolitaines (code INSEE). */
const REGIONS: Record<string, { name: string; lon: number; lat: number }> = {
  '11': { name: 'Île-de-France', lon: 2.5, lat: 48.71 },
  '24': { name: 'Centre-Val de Loire', lon: 1.68, lat: 47.48 },
  '27': { name: 'Bourgogne-Franche-Comté', lon: 4.8, lat: 47.23 },
  '28': { name: 'Normandie', lon: 0.11, lat: 49.12 },
  '32': { name: 'Hauts-de-France', lon: 2.78, lat: 49.97 },
  '44': { name: 'Grand Est', lon: 5.62, lat: 48.69 },
  '52': { name: 'Pays de la Loire', lon: -0.82, lat: 47.47 },
  '53': { name: 'Bretagne', lon: -2.84, lat: 48.18 },
  '75': { name: 'Nouvelle-Aquitaine', lon: 0.2, lat: 45.19 },
  '76': { name: 'Occitanie', lon: 2.14, lat: 43.7 },
  '84': { name: 'Auvergne-Rhône-Alpes', lon: 4.54, lat: 45.51 },
  '93': { name: 'Provence-Alpes-Côte d’Azur', lon: 6.05, lat: 43.96 },
};

/** Hauteur des colonnes : mètres par mégawatt (la plus grosse région produit ~15 000 MW → 300 km). */
const METERS_PER_MW = 20;
const COLUMN_RADIUS_M = 22_000;

interface Reading {
  region: string;
  time: number;
  consumption: number;
  /** Production par filière (MW). */
  production: Record<SourceKey, number>;
  /** Échanges physiques : positif = la région importe. */
  exchanges: number;
}

interface PowerData {
  from: number;
  to: number;
  /** Relevés par région, triés par heure. */
  byRegion: Map<string, Reading[]>;
}

/** Un étage de colonne : une filière d'une région, posée sur les filières du dessous. */
interface Slab {
  reading: Reading;
  lon: number;
  lat: number;
  base: number;
  value: number;
}

type ApiRow = Record<string, string | number | null>;

async function loadPower(signal: AbortSignal, time: number): Promise<PowerData> {
  const from = time - WINDOW_MS;
  const to = time + QUARTER_MS;
  const where = `date_heure >= "${new Date(from).toISOString()}" and date_heure <= "${new Date(to).toISOString()}"`;
  const fields = ['code_insee_region', 'date_heure', 'consommation', 'ech_physiques', ...SOURCES.map((s) => s.key)];
  const url = `${EXPORT_URL}?select=${fields.join(',')}&where=${encodeURIComponent(where)}&order_by=date_heure`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`éCO2mix a répondu ${response.status}`);
  const rows = (await response.json()) as ApiRow[];

  const byRegion = new Map<string, Reading[]>();
  for (const row of rows) {
    const region = String(row.code_insee_region ?? '');
    const consumption = Number(row.consommation);
    // Les dernières valeurs arrivent parfois incomplètes : on ne garde que les relevés avec la consommation.
    if (!REGIONS[region] || row.consommation === null || !Number.isFinite(consumption)) continue;
    const production = Object.fromEntries(SOURCES.map((s) => [s.key, Math.max(0, Number(row[s.key]) || 0)])) as Record<
      SourceKey,
      number
    >;
    const reading: Reading = {
      region,
      time: Date.parse(String(row.date_heure)),
      consumption,
      production,
      exchanges: Number(row.ech_physiques) || 0,
    };
    const list = byRegion.get(region) ?? [];
    list.push(reading);
    byRegion.set(region, list);
  }
  for (const list of byRegion.values()) list.sort((a, b) => a.time - b.time);
  return { from, to, byRegion };
}

/**
 * Dernier relevé de chaque région à l'instant t. Les données « temps réel » arrivent
 * avec environ une heure de retard : on accepte un relevé de moins de deux heures
 * (son heure exacte est affichée).
 */
function readingsAt(data: PowerData, time: number): Reading[] {
  const result: Reading[] = [];
  for (const list of data.byRegion.values()) {
    let found: Reading | undefined;
    for (const reading of list) {
      if (reading.time > time) break;
      found = reading;
    }
    if (found && time - found.time <= MAX_READING_AGE_MS) result.push(found);
  }
  return result;
}

const total = (r: Reading) => SOURCES.reduce((sum, s) => sum + r.production[s.key], 0);
const megawatts = (mw: number) => `${Math.round(mw).toLocaleString('fr-FR')} MW`;
const gigawatts = (mw: number) => `${(mw / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} GW`;

export const power = defineModule<PowerData>({
  id: 'electricite',
  name: 'Électricité',
  category: 'energie',
  description: 'Production par filière et consommation de chaque région, au quart d’heure.',
  attribution: 'RTE éCO2mix via ODRÉ (licence ouverte)',
  refreshIntervalMs: 5 * 60_000,
  timeStepMs: 60_000,

  load: ({ signal, time }) => loadPower(signal, time),

  needsReload(data, time) {
    return time < data.from + QUARTER_MS || time > data.to;
  },

  legend() {
    return [
      ...SOURCES.map((s) => ({ color: s.css, label: s.label })),
      { color: '#ffffff', label: 'Anneau blanc : consommation de la région' },
    ];
  },

  summary({ data, time }) {
    const readings = data ? readingsAt(data, time) : [];
    if (readings.length === 0) return data ? 'pas de données à cet instant' : null;
    const production = readings.reduce((sum, r) => sum + total(r), 0);
    const consumption = readings.reduce((sum, r) => sum + r.consumption, 0);
    const at = Math.max(...readings.map((r) => r.time));
    return `France : production ${gigawatts(production)}, consommation ${gigawatts(consumption)} (${formatTime(at)})`;
  },

  deckLayers({ data, time, selection }) {
    if (!data) return [];
    const readings = readingsAt(data, time);
    const chosen = (selection as { region: string } | null)?.region;
    const layers = [];

    // Un étage par filière : chaque colonne est posée sur la somme des filières du dessous.
    const bases = new Map(readings.map((r) => [r.region, 0]));
    for (const source of SOURCES) {
      const slabs: Slab[] = readings
        .map((reading) => {
          const place = REGIONS[reading.region]!;
          const base = bases.get(reading.region) ?? 0;
          const value = reading.production[source.key];
          bases.set(reading.region, base + value);
          return { reading, lon: place.lon, lat: place.lat, base, value };
        })
        .filter((slab) => slab.value > 0);
      layers.push(
        new ColumnLayer<Slab>({
          id: `electricite/${source.key}`,
          data: slabs,
          getPosition: (s) => [s.lon, s.lat, s.base * METERS_PER_MW],
          getElevation: (s) => s.value * METERS_PER_MW,
          radius: COLUMN_RADIUS_M,
          diskResolution: 32,
          extruded: true,
          getFillColor: (s) => [...source.color, s.reading.region === chosen || !chosen ? 240 : 120],
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 90],
          updateTriggers: { getFillColor: chosen ?? '' },
        }),
      );
    }

    // Anneau de consommation : un disque fin, un peu plus large que la colonne.
    layers.push(
      new ColumnLayer<Slab>({
        id: 'electricite/consommation',
        data: readings.map((reading) => {
          const place = REGIONS[reading.region]!;
          return { reading, lon: place.lon, lat: place.lat, base: reading.consumption, value: 0 };
        }),
        getPosition: (s) => [s.lon, s.lat, s.base * METERS_PER_MW],
        getElevation: 2_000,
        radius: COLUMN_RADIUS_M * 1.35,
        diskResolution: 32,
        extruded: true,
        getFillColor: [255, 255, 255, 235],
        pickable: true,
      }),
    );
    return layers;
  },

  select(object) {
    return { region: (object as Slab).reading.region };
  },

  describe(selection, { data, time }) {
    const code = (selection as { region: string }).region;
    const reading = data ? readingsAt(data, time).find((r) => r.region === code) : undefined;
    const region = REGIONS[code];
    if (!region) return null;
    if (!reading) return { title: region.name, subtitle: 'Électricité · pas de données à cet instant' };
    const production = total(reading);
    const balance = production - reading.consumption;
    return {
      title: region.name,
      subtitle: `Électricité · relevé de ${formatTime(reading.time)}`,
      fields: [
        ['Consommation', megawatts(reading.consumption)],
        ['Production', megawatts(production)],
        [
          'Bilan',
          balance >= 0
            ? `produit ${megawatts(balance)} de plus qu’elle ne consomme`
            : `dépend de ses voisines pour ${megawatts(-balance)}`,
        ],
      ],
      tables: [
        {
          title: 'Production par filière',
          columns: ['Filière', 'Puissance', 'Part'],
          rows: SOURCES.filter((s) => reading.production[s.key] > 0)
            .sort((a, b) => reading.production[b.key] - reading.production[a.key])
            .map((s) => ({
              cells: [
                s.label,
                megawatts(reading.production[s.key]),
                `${Math.round((reading.production[s.key] / Math.max(production, 1)) * 100)} %`,
              ],
            })),
        },
      ],
    };
  },
});
