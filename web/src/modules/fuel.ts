/**
 * Module « Carburants » : le prix dans toutes les stations-service de France
 * (flux officiel du ministère de l'Économie, mis à jour par les stations elles-mêmes).
 *
 * Chaque station est colorée selon son prix par rapport aux autres stations de
 * France, pour le carburant choisi : bleu = moins cher, gris = dans la moyenne,
 * rouge = plus cher. C'est une échelle « divergente » autour du prix médian.
 *
 * Seuls les prix actuels existent : en remontant le temps, la couche montre
 * toujours les prix du moment.
 */
import type { Color } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { formatRelative } from '../ui/format';

const EXPORT_URL =
  'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/exports/json';

const FUELS = [
  { id: 'gazole', label: 'Gazole', short: 'Gazole' },
  { id: 'e10', label: 'SP95-E10', short: 'E10' },
  { id: 'sp98', label: 'SP98', short: 'SP98' },
  { id: 'sp95', label: 'SP95', short: 'SP95' },
  { id: 'e85', label: 'E85 (superéthanol)', short: 'E85' },
  { id: 'gplc', label: 'GPL', short: 'GPL' },
] as const;
type FuelId = (typeof FUELS)[number]['id'];
/** Carburants proposés dans le réglage (le SP95 est rare : il n'apparaît que dans les fiches). */
const SELECTABLE: FuelId[] = ['gazole', 'e10', 'sp98', 'e85', 'gplc'];

/** Un prix plus vieux que ça n'est plus fiable (station fermée, oubli de mise à jour…). */
const MAX_PRICE_AGE_MS = 7 * 24 * 3600_000;

type ApiStation = {
  id: number;
  geom: { lon: number; lat: number } | null;
  cp: string | null;
  ville: string | null;
  adresse: string | null;
  horaires_automate_24_24: string | null;
} & Partial<Record<`${FuelId}_prix`, number | null>> &
  Partial<Record<`${FuelId}_maj`, string | null>>;

interface Station {
  id: number;
  lon: number;
  lat: number;
  city: string;
  address: string;
  postcode: string;
  automat: boolean;
  prices: Partial<Record<FuelId, { price: number; updated: number }>>;
}

interface FuelData {
  stations: Station[];
  byId: Map<number, Station>;
  /** Prix récents de chaque carburant, triés : pour les classes de couleur et le classement. */
  sorted: Record<FuelId, number[]>;
}

/** Cinq classes, par quantiles : 10 % les moins chers, 25 % suivants, 30 % au milieu, 25 %, 10 % les plus chers. */
const CLASS_BOUNDS = [0.1, 0.35, 0.65, 0.9];
const WHITE: [number, number, number] = [255, 255, 255];
const INK: [number, number, number] = [22, 26, 38];
/** `text` : couleur du prix posé sur ce fond (blanc sur les fonds foncés, encre sur les clairs). */
const CLASSES: Array<{ color: [number, number, number]; css: string; text: [number, number, number]; label: string }> = [
  { color: [28, 92, 171], css: '#1c5cab', text: WHITE, label: 'Parmi les 10 % les moins chères' },
  { color: [109, 167, 236], css: '#6da7ec', text: INK, label: 'Moins chère que la moyenne' },
  { color: [210, 208, 201], css: '#d2d0c9', text: INK, label: 'Dans la moyenne' },
  { color: [229, 120, 115], css: '#e57873', text: INK, label: 'Plus chère que la moyenne' },
  { color: [165, 42, 42], css: '#a52a2a', text: WHITE, label: 'Parmi les 10 % les plus chères' },
];
const RING: Color = [22, 26, 38, 210];
/** Les étiquettes de prix apparaissent à partir de ce zoom. */
const LABEL_MIN_ZOOM = 11;
/** Encombrement d'une étiquette à l'écran (avec un peu d'air), en pixels. */
const LABEL_BOX_PX = { width: 74, height: 28 };
/** Seuls caractères des étiquettes : deck.gl ne prépare que ceux-là. */
const LABEL_CHARACTERS = '0123456789, €';
const shortEuros = (price: number) => `${price.toFixed(3).replace('.', ',')} €`;

const euros = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 3 });

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function classOf(price: number, sorted: number[]): number {
  return CLASS_BOUNDS.filter((q) => price > quantile(sorted, q)).length;
}

/** Part des stations plus chères (0 à 1). */
function cheaperThan(price: number, sorted: number[]): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! <= price) low = middle + 1;
    else high = middle;
  }
  return sorted.length > 0 ? (sorted.length - low) / sorted.length : 0;
}

async function loadFuel(signal: AbortSignal): Promise<FuelData> {
  const fields = ['id', 'geom', 'cp', 'ville', 'adresse', 'horaires_automate_24_24'];
  for (const fuel of FUELS) fields.push(`${fuel.id}_prix`, `${fuel.id}_maj`);
  const response = await fetch(`${EXPORT_URL}?select=${fields.join(',')}`, { signal });
  if (!response.ok) throw new Error(`le flux des carburants a répondu ${response.status}`);
  const rows = (await response.json()) as ApiStation[];

  const now = Date.now();
  const stations: Station[] = [];
  for (const row of rows) {
    if (!row.geom) continue;
    const prices: Station['prices'] = {};
    for (const fuel of FUELS) {
      const price = row[`${fuel.id}_prix`];
      const updated = Date.parse(row[`${fuel.id}_maj`] ?? '');
      if (price && Number.isFinite(updated)) prices[fuel.id] = { price, updated };
    }
    stations.push({
      id: row.id,
      lon: row.geom.lon,
      lat: row.geom.lat,
      city: row.ville ?? '',
      address: row.adresse ?? '',
      postcode: row.cp ?? '',
      automat: row.horaires_automate_24_24 === 'Oui',
      prices,
    });
  }

  const sorted = Object.fromEntries(
    FUELS.map((fuel) => [
      fuel.id,
      stations
        .map((s) => s.prices[fuel.id])
        .filter((p): p is { price: number; updated: number } => p !== undefined && now - p.updated < MAX_PRICE_AGE_MS)
        .map((p) => p.price)
        .sort((a, b) => a - b),
    ]),
  ) as Record<FuelId, number[]>;

  return { stations, byId: new Map(stations.map((s) => [s.id, s])), sorted };
}

/** Prix récent d'une station pour un carburant, sinon `undefined`. */
function recentPrice(station: Station, fuel: FuelId): number | undefined {
  const entry = station.prices[fuel];
  return entry && Date.now() - entry.updated < MAX_PRICE_AGE_MS ? entry.price : undefined;
}

const fuelLabel = (id: string) => FUELS.find((f) => f.id === id)?.label ?? id;

/** Étiquettes gardées après désencombrement : la station la moins chère de chaque case l'emporte. */
let labelCache: { data: FuelData; fuel: FuelId; band: number; stations: Station[] } | undefined;

function labelledStations(data: FuelData, priced: Station[], fuel: FuelId, zoom: number): Station[] {
  const band = zoomBand(zoom);
  if (labelCache?.data !== data || labelCache.fuel !== fuel || labelCache.band !== band) {
    const stations = declutter(priced, zoom, {
      lon: (s) => s.lon,
      lat: (s) => s.lat,
      rank: (s) => recentPrice(s, fuel)!,
      box: LABEL_BOX_PX,
    });
    labelCache = { data, fuel, band, stations };
  }
  return labelCache.stations;
}

export const fuel = defineModule<FuelData>({
  id: 'carburants',
  name: 'Carburants',
  category: 'energie',
  description: 'Prix actuels dans les 9 800 stations-service, comparés au reste de la France.',
  attribution: 'prix-carburants.gouv.fr (licence ouverte)',
  refreshIntervalMs: 10 * 60_000,
  timeStepMs: 3_600_000, // pas d'historique : le dessin ne dépend pas de l'instant affiché
  zoomBreaks: halfZoomBreaks(LABEL_MIN_ZOOM),
  followsTerrain: true, // posées sur le relief, sinon elles glissent sur les bords de l'écran

  settings: [
    {
      id: 'carburant',
      label: 'Carburant',
      options: SELECTABLE.map((id) => ({ value: id, label: FUELS.find((f) => f.id === id)!.short })),
      defaultValue: 'gazole',
    },
  ],

  legend(settings, data) {
    const sorted = data?.sorted[settings.carburant as FuelId] ?? [];
    const bounds = CLASS_BOUNDS.map((q) => quantile(sorted, q));
    const range = (i: number) => {
      if (sorted.length === 0) return '';
      if (i === 0) return ` (jusqu’à ${euros.format(bounds[0]!)})`;
      if (i === CLASSES.length - 1) return ` (plus de ${euros.format(bounds[i - 1]!)})`;
      return ` (${euros.format(bounds[i - 1]!)} à ${euros.format(bounds[i]!)})`;
    };
    return CLASSES.map((c, i) => ({ color: c.css, label: `${c.label}${range(i)}`, size: 'small' as const }));
  },

  load: ({ signal }) => loadFuel(signal),

  summary({ data, settings }) {
    const sorted = data?.sorted[settings.carburant as FuelId];
    if (!sorted?.length) return null;
    return `${sorted.length.toLocaleString('fr-FR')} stations · ${fuelLabel(settings.carburant ?? '')} médian ${euros.format(quantile(sorted, 0.5))}`;
  },

  deckLayers({ data, settings, selection, view, terrain }) {
    if (!data) return [];
    const fuelId = settings.carburant as FuelId;
    const sorted = data.sorted[fuelId];
    const priced = data.stations.filter((s) => recentPrice(s, fuelId) !== undefined);
    const chosen = selection ? data.byId.get((selection as { id: number }).id) : undefined;
    const onGround = (s: Station): [number, number, number] => [s.lon, s.lat, terrain.elevation(s.lon, s.lat)];
    return [
      new ScatterplotLayer<Station>({
        id: 'carburants/stations',
        data: priced,
        getPosition: onGround,
        radiusUnits: 'meters',
        getRadius: 250,
        radiusMinPixels: 2.5,
        radiusMaxPixels: 8,
        getFillColor: (s) => CLASSES[classOf(recentPrice(s, fuelId)!, sorted)]!.color,
        stroked: true,
        getLineColor: RING,
        lineWidthUnits: 'pixels',
        getLineWidth: 1,
        billboard: true,
        pickable: true,
        // Vu de près, le point est sous son étiquette : la surbrillance perturberait le clic sur l'étiquette.
        autoHighlight: view.zoom < LABEL_MIN_ZOOM,
        highlightColor: [255, 255, 255, 160],
        updateTriggers: { getFillColor: fuelId, getPosition: terrain.version },
        parameters: { depthCompare: 'always', depthWriteEnabled: false },
      }),
      // Vu de près, une étiquette de prix à la couleur de la classe, à la place du point.
      view.zoom >= LABEL_MIN_ZOOM &&
        new TextLayer<Station>({
          id: 'carburants/prix',
          data: labelledStations(data, priced, fuelId, view.zoom),
          getPosition: onGround,
          getText: (s) => shortEuros(recentPrice(s, fuelId)!),
          characterSet: LABEL_CHARACTERS,
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 12.5,
          getColor: (s) => CLASSES[classOf(recentPrice(s, fuelId)!, sorted)]!.text,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          background: true,
          getBackgroundColor: (s) => [...CLASSES[classOf(recentPrice(s, fuelId)!, sorted)]!.color, 245],
          getBorderColor: [22, 26, 38, 150],
          getBorderWidth: 1,
          backgroundBorderRadius: 9,
          backgroundPadding: [7, 3],
          billboard: true,
          pickable: true,
          updateTriggers: { getText: fuelId, getColor: fuelId, getBackgroundColor: fuelId, getPosition: terrain.version },
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
        }),
      chosen &&
        new ScatterplotLayer<Station>({
          id: 'carburants/choisie',
          data: [chosen],
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: 11,
          filled: false,
          stroked: true,
          getLineColor: [79, 140, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          billboard: true,
          parameters: { depthCompare: 'always', depthWriteEnabled: false },
        }),
    ];
  },

  select(object) {
    return { id: (object as Station).id };
  },

  describe(selection, { data, settings }) {
    const station = data?.byId.get((selection as { id: number }).id);
    if (!station || !data) return null;
    const fuelId = settings.carburant as FuelId;
    const fields: Array<[string, string]> = [];
    const price = recentPrice(station, fuelId);
    if (price !== undefined) {
      const share = Math.round(cheaperThan(price, data.sorted[fuelId]) * 100);
      fields.push([
        `${fuelLabel(fuelId)} en France`,
        share >= 50 ? `moins cher que ${share} % des stations` : `plus cher que ${100 - share} % des stations`,
      ]);
    }
    fields.push(['Automate 24 h/24', station.automat ? 'oui' : 'non']);
    return {
      title: station.city ? `Station-service · ${station.city}` : 'Station-service',
      subtitle: [station.address, station.postcode].filter(Boolean).join(', '),
      fields,
      tables: [
        {
          title: 'Prix',
          columns: ['Carburant', 'Prix', 'Mis à jour'],
          empty: 'Aucun prix publié.',
          rows: FUELS.filter((f) => station.prices[f.id]).map((f) => {
            const entry = station.prices[f.id]!;
            const old = Date.now() - entry.updated >= MAX_PRICE_AGE_MS;
            return {
              cells: [f.label, euros.format(entry.price), formatRelative(entry.updated)],
              tone: f.id === fuelId ? 'current' : old ? 'muted' : undefined,
            };
          }),
        },
      ],
    };
  },
});
