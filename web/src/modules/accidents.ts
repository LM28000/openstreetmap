/**
 * Module « Accidents de la route » : les accidents corporels de la circulation des cinq dernières
 * années (base annuelle de l'ONISR, Licence Ouverte), collectés par le serveur
 * (server/src/accidents.rs) en colonnes compactes : 275 000 accidents, 5 Mo compressés.
 *
 * Ton sobre : chaque point est un accident où des personnes ont été touchées. On n'affiche que des
 * décomptes de personnes par gravité ; ni l'âge, ni le sexe ne sont collectés ni affichés.
 *
 * - À l'échelle de la France et des régions : une grille de cases d'une dizaine de pixels. La hauteur
 *   de la colonne (ou la surface, en mode « Aplat ») dit le nombre d'accidents ; la teinte dit la part
 *   de ceux qui ont fait un tué ou un blessé hospitalisé (quatre classes de même effectif).
 * - À partir du zoom 12,5 : un point par accident, coloré par la pire issue parmi les personnes
 *   impliquées (indemne, blessé léger, blessé hospitalisé, tué) et d'autant plus gros que l'issue est grave.
 *
 * La gravité est ordinale : une seule teinte (brun ocre), du clair au foncé, validée avec
 * `validate_palette.js --ordinal` en clair et en sombre. La palette de statut (vert, jaune, orange,
 * rouge) n'est pas utilisée : elle dit des états, pas des magnitudes.
 */
import { GridCellLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { OVER_MAP } from '../map/parameters';
import { HALO, KEY, selectionRing } from './symbols';

/** Gravité, de la moins grave à la plus grave. */
const SEVERITIES = [
  { label: 'Indemne', css: '#d6aa62', color: [214, 170, 98] as [number, number, number], radius: 2.2 },
  { label: 'Blessé léger', css: '#b98340', color: [185, 131, 64] as [number, number, number], radius: 2.8 },
  { label: 'Blessé hospitalisé', css: '#9c6224', color: [156, 98, 36] as [number, number, number], radius: 3.6 },
  { label: 'Tué', css: '#80481a', color: [128, 72, 26] as [number, number, number], radius: 5 },
] as const;

export interface AccidentsData {
  years: number[];
  n: number;
  lon: Float32Array;
  lat: Float32Array;
  /** Date et heure locales, `AAAAMMJJhhmm`. */
  ts: Float64Array;
  /** Personnes par gravité (voir `unpack`). */
  cnt: Uint32Array;
  ctx: Uint32Array;
  /** Pire issue de chaque accident : 0 indemne, 1 léger, 2 hospitalisé, 3 tué. */
  sev: Uint8Array;
  year: Uint16Array;
  updatedAt: number;
}

interface Json {
  updatedAt: number;
  years: number[];
  n: number;
  lon: number[];
  lat: number[];
  ts: number[];
  cnt: number[];
  ctx: number[];
}

/** Pire issue d'après les décomptes : tués d'abord. */
function worst(cnt: number): number {
  if (cnt & 63) return 3;
  if ((cnt >> 6) & 63) return 2;
  if ((cnt >> 12) & 63) return 1;
  return 0;
}

async function loadAccidents(signal: AbortSignal): Promise<AccidentsData> {
  const response = await fetch('/api/accidents', { signal });
  if (response.status === 503) throw new Error('le serveur prépare encore la base des accidents (premier téléchargement, quelques minutes)');
  if (!response.ok) throw new Error(`le serveur des accidents a répondu ${response.status}`);
  const json = (await response.json()) as Json;
  const n = json.n;
  const lon = new Float32Array(n);
  const lat = new Float32Array(n);
  const sev = new Uint8Array(n);
  const year = new Uint16Array(n);
  const ts = Float64Array.from(json.ts);
  const cnt = Uint32Array.from(json.cnt);
  for (let i = 0; i < n; i++) {
    lon[i] = json.lon[i]! / 1e4;
    lat[i] = json.lat[i]! / 1e4;
    sev[i] = worst(cnt[i]!);
    year[i] = Math.floor(ts[i]! / 1e8);
  }
  return { years: json.years, n, lon, lat, ts, cnt, ctx: Uint32Array.from(json.ctx), sev, year, updatedAt: json.updatedAt * 1000 };
}

// --- Filtres ---

/** Indices des accidents retenus par les réglages, du moins grave au plus grave (les graves sont dessinés par-dessus). */
function select(data: AccidentsData, settings: Readonly<Record<string, string>>): Uint32Array {
  const years = data.years.length;
  const keepYears = settings.periode === '1' ? 1 : settings.periode === '3' ? 3 : years;
  const firstYear = data.years[Math.max(0, years - keepYears)] ?? 0;
  const minSeverity = settings.gravite === 'mortels' ? 3 : settings.gravite === 'graves' ? 2 : 0;
  const buckets: number[][] = [[], [], [], []];
  for (let i = 0; i < data.n; i++) {
    if (data.year[i]! >= firstYear && data.sev[i]! >= minSeverity) buckets[data.sev[i]!]!.push(i);
  }
  return Uint32Array.from(buckets.flat());
}

let selectCache: { data: AccidentsData; key: string; indices: Uint32Array } | undefined;
function filtered(data: AccidentsData, settings: Readonly<Record<string, string>>): Uint32Array {
  const key = `${settings.periode}|${settings.gravite}`;
  if (selectCache?.data !== data || selectCache.key !== key) selectCache = { data, key, indices: select(data, settings) };
  return selectCache.indices;
}

// --- Vue d'ensemble : grille ---

/** À partir de ce zoom, un point par accident. */
const POINT_ZOOM = 12.5;
/** Taille d'une case de la grille à l'écran, en pixels. */
const CELL_PX = 8;
const COS_LAT = Math.cos((46.5 * Math.PI) / 180);

interface Cell {
  lon: number;
  lat: number;
  z: number;
  n: number;
  /** Accidents ayant fait un tué ou un blessé hospitalisé. */
  grave: number;
}

/** Part de graves d'une case (0 à 1). */
const share = (cell: Cell) => cell.grave / cell.n;

let gridCache: { indices: Uint32Array; band: number; terrain: number; size: number; cells: Cell[]; max: number; limits: number[] } | undefined;
/** Regroupe les accidents en cases carrées d'environ `CELL_PX` pixels, recalculé par demi-niveau de zoom. */
function grid(data: AccidentsData, indices: Uint32Array, zoom: number, terrain: { elevation(lon: number, lat: number): number; version: number }) {
  const band = Math.floor(zoom * 2) / 2;
  if (gridCache?.indices === indices && gridCache.band === band && gridCache.terrain === terrain.version) return gridCache;
  const size = CELL_PX * ((156_543.03 * COS_LAT) / 2 ** band);
  const perDegreeX = 111_320 * COS_LAT;
  const perDegreeY = 110_540;
  const cells = new Map<number, Cell>();
  for (const i of indices) {
    const x = Math.floor((data.lon[i]! * perDegreeX) / size);
    const y = Math.floor((data.lat[i]! * perDegreeY) / size);
    const key = x * 1_000_003 + y;
    let cell = cells.get(key);
    if (!cell) {
      cell = { lon: ((x + 0.5) * size) / perDegreeX, lat: ((y + 0.5) * size) / perDegreeY, z: 0, n: 0, grave: 0 };
      cells.set(key, cell);
    }
    cell.n++;
    if (data.sev[i]! >= 2) cell.grave++;
  }
  const list = [...cells.values()];
  // Les colonnes partent du relief (au plus 4 000 cases : chaque altitude demandée à la carte coûte du temps).
  if (list.length <= 4000) for (const cell of list) cell.z = terrain.elevation(cell.lon, cell.lat);
  // Hauteur : la case « pleine » est la 95e plus chargée (une seule case, Paris, écraserait toutes les autres).
  const counts = list.map((c) => c.n).sort((a, b) => a - b);
  const max = Math.max(1, counts[Math.floor(counts.length * 0.95)] ?? 1);
  // Teinte : quatre classes de même effectif parmi les cases d'au moins 3 accidents (une case de 1 accident
  // serait à 0 % ou à 100 %) ; la part nationale est d'environ 40 %, mais elle varie du simple au double d'une zone à l'autre.
  const shares = list.filter((c) => c.n >= 3).map(share).sort((a, b) => a - b);
  const limits = [0.25, 0.5, 0.75].map((q) => shares[Math.floor(shares.length * q)] ?? 0.4);
  gridCache = { indices, band, terrain: terrain.version, size, cells: list, max, limits };
  return gridCache;
}

// --- Vue de près : points ---

/** Carte (pour connaître la zone regardée) : gardée à l'activation de la couche. */
let mapRef: MapLibreMap | undefined;
/** Dernières données dessinées : `select` y lit l'instant de l'accident cliqué, pour le retrouver après un rechargement. */
let lastData: AccidentsData | undefined;

let pointsCache: { indices: Uint32Array; key: string; list: number[] } | undefined;
/** Accidents dans la zone regardée, élargie de moitié. */
function inView(data: AccidentsData, indices: Uint32Array, version: number): number[] {
  const bounds = mapRef?.getBounds();
  if (!bounds) return [];
  const w = bounds.getWest();
  const e = bounds.getEast();
  const s = bounds.getSouth();
  const nth = bounds.getNorth();
  const padX = (e - w) * 0.5;
  const padY = (nth - s) * 0.5;
  const key = `${(w - padX).toFixed(3)}|${(e + padX).toFixed(3)}|${(s - padY).toFixed(3)}|${(nth + padY).toFixed(3)}|${version}`;
  if (pointsCache?.indices === indices && pointsCache.key === key) return pointsCache.list;
  const kept: number[] = [];
  for (const i of indices) {
    const lon = data.lon[i]!;
    const lat = data.lat[i]!;
    if (lon >= w - padX && lon <= e + padX && lat >= s - padY && lat <= nth + padY) kept.push(i);
  }
  // Un vrai tableau (pas un tableau typé) : deck.gl ne sait renvoyer l'objet cliqué que pour un tableau.
  pointsCache = { indices, key, list: kept };
  return pointsCache.list;
}

// --- Fiche ---

const LIGHT = ['', 'Plein jour', 'Crépuscule ou aube', 'Nuit sans éclairage public', 'Nuit, éclairage public éteint', 'Nuit, éclairage public allumé'];
const WEATHER = ['', 'Normale', 'Pluie légère', 'Pluie forte', 'Neige ou grêle', 'Brouillard ou fumée', 'Vent fort ou tempête', 'Temps éblouissant', 'Temps couvert', 'Autre'];
const ROAD = ['', 'Autoroute', 'Route nationale', 'Route départementale', 'Voie communale', 'Hors réseau public', 'Parc de stationnement', 'Route de métropole urbaine', '', 'Autre'];
const VEHICLES: Array<[bit: number, label: string]> = [
  [1, 'piéton'],
  [2, 'vélo ou trottinette'],
  [4, 'deux ou trois-roues motorisé'],
  [8, 'voiture ou camionnette'],
  [16, 'poids lourd, bus ou car'],
  [32, 'train ou tramway'],
  [64, 'autre véhicule'],
];

function describeWhen(ts: number): string {
  const text = String(Math.round(ts)).padStart(12, '0');
  const [year, month, day, hour, minute] = [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8), text.slice(8, 10), text.slice(10, 12)].map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `${date}, ${hour} h ${String(minute).padStart(2, '0')}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Une ligne du type « 1 tué, 2 blessés hospitalisés ». */
function peopleText(killed: number, hospital: number, light: number, unhurt: number): string {
  const parts = [
    killed && plural(killed, 'tué', 'tués'),
    hospital && plural(hospital, 'blessé hospitalisé', 'blessés hospitalisés'),
    light && plural(light, 'blessé léger', 'blessés légers'),
    unhurt && plural(unhurt, 'indemne', 'indemnes'),
  ].filter(Boolean);
  return parts.join(' · ') || 'aucune personne comptée';
}

export const accidents = defineModule<AccidentsData>({
  id: 'accidents',
  name: 'Accidents de la route',
  category: 'transport',
  description:
    'Les accidents corporels de la circulation des cinq dernières années : vue d’ensemble en colonnes, puis un point par accident selon la pire issue. Des décomptes de personnes seulement.',
  attribution: 'ONISR, bases de données annuelles des accidents corporels de la circulation routière, data.gouv.fr (Licence Ouverte)',
  // Une nouvelle année est publiée une fois par an : relire une fois par jour est largement suffisant.
  refreshIntervalMs: 24 * 3600_000,
  // Pas d'historique : le dessin ne dépend pas de l'instant affiché.
  timeStepMs: 3_600_000,
  zoomBreaks: [5, 6, 7, 8, 9, 10, 11, POINT_ZOOM, 12, 13, 14, 15],
  followsTerrain: true,
  followsView: true,

  settings: [
    {
      id: 'periode',
      label: 'Période',
      options: [
        { value: 'toutes', label: 'Les cinq dernières années' },
        { value: '3', label: 'Les trois dernières années' },
        { value: '1', label: 'La dernière année' },
      ],
      defaultValue: 'toutes',
    },
    {
      id: 'gravite',
      label: 'Gravité',
      options: [
        { value: 'tous', label: 'Tous les accidents' },
        { value: 'graves', label: 'Avec blessés hospitalisés ou tués' },
        { value: 'mortels', label: 'Mortels' },
      ],
      defaultValue: 'tous',
    },
    {
      id: 'forme',
      label: 'Vue d’ensemble',
      options: [
        { value: 'colonnes', label: 'Colonnes 3D' },
        { value: 'aplat', label: 'Aplat' },
      ],
      defaultValue: 'colonnes',
    },
  ],

  legend(): LegendItem[] {
    return [
      ...SEVERITIES.map((s, i) => ({ color: s.css, label: `Pire issue : ${s.label.toLowerCase()}`, size: (['small', 'small', 'medium', 'large'] as const)[i] })),
      { color: SEVERITIES[3].css, label: 'De loin : hauteur = nombre d’accidents, teinte plus foncée = plus d’accidents graves (tués ou hospitalisés)', size: 'medium' },
    ];
  },

  load: ({ signal }) => loadAccidents(signal),

  summary({ data, settings }) {
    if (!data) return null;
    const indices = filtered(data, settings);
    let killed = 0;
    for (const i of indices) if (data.sev[i] === 3) killed++;
    const first = data.years[Math.max(0, data.years.length - (settings.periode === '1' ? 1 : settings.periode === '3' ? 3 : data.years.length))];
    const last = data.years[data.years.length - 1];
    return `${indices.length.toLocaleString('fr-FR')} accidents dont ${killed.toLocaleString('fr-FR')} mortels · ${first === last ? first : `${first}–${last}`}`;
  },

  native: {
    // Aucune couche MapLibre : on garde seulement la carte pour connaître la zone regardée.
    add(map) {
      mapRef = map;
    },
    remove() {
      mapRef = undefined;
    },
  },

  deckLayers({ data, settings, selection, view, terrain }) {
    if (!data) return [];
    lastData = data;
    const indices = filtered(data, settings);
    if (view.zoom < POINT_ZOOM) {
      const { cells, size, max, limits } = grid(data, indices, view.zoom, terrain);
      const shareClass = (cell: Cell) => limits.filter((limit) => share(cell) >= limit).length;
      const columns = settings.forme !== 'aplat';
      // Hauteur : racine du nombre d'accidents, pour que les petites cases restent visibles ; plafonnée à une case et demie de haut.
      const height = (cell: Cell) => Math.min(1, Math.sqrt(cell.n / max));
      return [
        new GridCellLayer<Cell>({
          id: 'accidents/grille',
          data: cells,
          getPosition: (c) => [c.lon, c.lat, c.z],
          cellSize: size,
          coverage: columns ? 0.86 : 1,
          extruded: columns,
          elevationScale: size * 1.6,
          getElevation: height,
          getFillColor: (c) => [...SEVERITIES[shareClass(c)]!.color, columns ? 245 : 170 + Math.round(70 * height(c))],
          // Des colonnes : le test de profondeur remet les plus proches devant. À plat : au-dessus du fond, sans test.
          parameters: columns ? { depthCompare: 'less-equal', depthWriteEnabled: true, cullMode: 'back' } : OVER_MAP,
          material: columns ? { ambient: 0.7, diffuse: 0.5, shininess: 18, specularColor: [50, 50, 50] } : false,
          pickable: false,
          updateTriggers: { getFillColor: [columns, max, limits.join()], getElevation: max, getPosition: terrain.version },
        }),
      ];
    }
    const shown = inView(data, indices, terrain.version);
    const chosen = selection ? (selection as { i: number }).i : undefined;
    const position = (i: number): [number, number, number] => [data.lon[i]!, data.lat[i]!, shown.length <= 12_000 ? terrain.elevation(data.lon[i]!, data.lat[i]!) : 0];
    const scale = 1 + Math.max(0, view.zoom - POINT_ZOOM) * 0.25;
    return [
      new ScatterplotLayer<number>({
        id: 'accidents/halo',
        data: shown,
        getPosition: position,
        getRadius: (i) => SEVERITIES[data.sev[i]!]!.radius + 1.1,
        radiusUnits: 'pixels',
        radiusScale: scale,
        getFillColor: HALO,
        billboard: true,
        updateTriggers: { getPosition: terrain.version },
        parameters: OVER_MAP,
      }),
      new ScatterplotLayer<number>({
        id: 'accidents/points',
        data: shown,
        getPosition: position,
        getRadius: (i) => SEVERITIES[data.sev[i]!]!.radius,
        radiusUnits: 'pixels',
        radiusScale: scale,
        getFillColor: (i) => [...SEVERITIES[data.sev[i]!]!.color, 255],
        stroked: true,
        getLineColor: KEY,
        // Second canal, en plus de la teinte et de la taille : un liseré plus épais pour les tués.
        getLineWidth: (i) => (data.sev[i] === 3 ? 1.6 : 0.8),
        lineWidthUnits: 'pixels',
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 170],
        updateTriggers: { getPosition: terrain.version },
        parameters: OVER_MAP,
      }),
      chosen !== undefined &&
        selectionRing('accidents/choisi', [chosen], position, (i) => (SEVERITIES[data.sev[i]!]!.radius + 6) * scale, OVER_MAP),
    ];
  },

  select(object) {
    // L'indice de l'accident dans les colonnes ; avec son instant, pour le retrouver après un rechargement.
    const i = object as number;
    return { i, ts: lastData?.ts[i] ?? 0 };
  },

  describe(selection, { data }): InfoContent | null {
    const { i, ts } = selection as { i: number; ts: number };
    if (!data || data.ts[i] !== ts) return null;
    const cnt = data.cnt[i]!;
    const ctx = data.ctx[i]!;
    const [killed, hospital, light, unhurt] = [cnt & 63, (cnt >> 6) & 63, (cnt >> 12) & 63, (cnt >> 18) & 63];
    const vehicles = VEHICLES.filter(([bit]) => (ctx >> 12) & bit).map(([, label]) => label);
    const severity = data.sev[i]!;
    const title =
      severity === 3 ? 'Accident mortel' : severity === 2 ? 'Accident avec blessé hospitalisé' : severity === 1 ? 'Accident avec blessé léger' : 'Accident sans blessé';
    return {
      kind: 'Accident corporel de la circulation',
      title,
      subtitle: describeWhen(data.ts[i]!),
      status: plainStatus(`ONISR · ${data.years[0]}–${data.years[data.years.length - 1]}`),
      figures: [
        { value: String(killed), label: killed > 1 ? 'tués' : 'tué' },
        { value: String(hospital), label: hospital > 1 ? 'hospitalisés' : 'hospitalisé' },
        { value: String(light), label: light > 1 ? 'blessés légers' : 'blessé léger' },
      ],
      fields: [
        ['Personnes', peopleText(killed, hospital, light, unhurt)],
        ['Luminosité', LIGHT[ctx & 15] || 'non renseignée'],
        ['Météo', WEATHER[(ctx >> 4) & 15] || 'non renseignée'],
        ['Route', ROAD[(ctx >> 8) & 15] || 'non renseignée'],
        ['Véhicules impliqués', vehicles.length ? vehicles.join(', ') : 'non renseignés'],
      ],
      note: 'Chaque point est un accident où des personnes ont été touchées. La base ne contient que des décomptes : ni identité, ni âge, ni sexe n’y sont affichés.',
      link: { href: 'https://www.data.gouv.fr/datasets/bases-de-donnees-annuelles-des-accidents-corporels-de-la-circulation-routiere-annees-de-2005-a-2024/', label: 'Source : ONISR' },
    };
  },
});
