/**
 * Fond de carte calme : le style OpenFreeMap « Liberty », repeint pour que les couches de
 * données ressortent, avec une palette de jour et une palette de nuit.
 *
 * Liberty est fait pour lire une carte seule : routes jaunes et orange (qui se confondent avec
 * les TGV), eau saturée, beaucoup de libellés. Ici :
 *  - les routes passent au gris chaud clair, d'autant plus foncé que la route est importante ;
 *  - l'eau devient bleu-gris, la végétation s'éteint ;
 *  - les libellés sont plus discrets et bien moins nombreux aux petits zooms ;
 *  - chaque couleur a une version de nuit, et l'on passe de l'une à l'autre par l'état global
 *    `nuit` (0 = jour, 1 = nuit) du style : un seul réglage repeint toute la carte, sans toucher
 *    aux couches une par une (voir `setNight` dans baseMap.ts).
 *
 * On part du style chargé et l'on retouche ses couches, plutôt que d'en maintenir une copie
 * complète : le fond garde les mises à jour de Liberty (tuiles, bâtiments 3D, sprites).
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

/** Nom de l'état global du style qui porte la nuit (0 = jour, 1 = nuit). */
export const NIGHT_STATE = 'nuit';

type Expr = unknown;

/** De jour à nuit, selon l'état global. */
const duo = (day: string | number, night: string | number): Expr => [
  'interpolate',
  ['linear'],
  ['number', ['global-state', NIGHT_STATE], 0],
  0,
  day,
  1,
  night,
];
const duoNumber = duo;

/**
 * Vu de très loin (continent, globe), la nuit est dessinée par le voile du module « Jour et nuit »
 * (la ligne du crépuscule) : le fond ne passe donc à sa palette de nuit qu'à partir de ce zoom,
 * en fondu sur un zoom et demi, pour que les deux ne s'additionnent pas.
 */
export const NIGHT_FADE_FROM_ZOOM = 3.5;
export const NIGHT_FADE_TO_ZOOM = 5;

const color = (day: string, night: string): Expr => [
  'interpolate',
  ['linear'],
  ['zoom'],
  NIGHT_FADE_FROM_ZOOM,
  day,
  NIGHT_FADE_TO_ZOOM,
  duo(day, night),
];

type Colors = Record<string, [string, string]>;

// --- Terrain, eau, bâtiments ---------------------------------------------------------------

const FIXED: Record<string, Colors> = {
  background: { 'background-color': ['#f3f1ec', '#12161d'] },
  park: { 'fill-color': ['#dde8d1', '#17231e'], 'fill-outline-color': ['#cfdfc3', '#1b2a23'] },
  park_outline: { 'line-color': ['#d3e3c7', '#1b2a23'] },
  landuse_residential: { 'fill-color': ['rgba(232,229,222,0.7)', 'rgba(26,31,40,0.7)'] },
  landcover_wood: { 'fill-color': ['hsla(100,24%,76%,0.6)', 'hsla(140,20%,13%,0.75)'] },
  landcover_grass: { 'fill-color': ['#d4e1c6', '#18241e'] },
  landcover_ice: { 'fill-color': ['#e6ecee', '#222a33'] },
  landcover_sand: { 'fill-color': ['#f0e9d3', '#23221b'] },
  landuse_pitch: { 'fill-color': ['#dfe5d3', '#1b2620'] },
  landuse_track: { 'fill-color': ['#dfe5d3', '#1b2620'] },
  landuse_cemetery: { 'fill-color': ['#d9e1cd', '#1b2520'] },
  landuse_hospital: { 'fill-color': ['#eee3e5', '#211d23'] },
  landuse_school: { 'fill-color': ['#ebecdb', '#1d2122'] },
  aeroway_fill: { 'fill-color': ['#e6e4df', '#222831'] },
  aeroway_runway: { 'line-color': ['#e4e0d9', '#2d333d'] },
  aeroway_taxiway: { 'line-color': ['#e4e0d9', '#2d333d'] },
  // L'eau : bleu-gris, pour que la pluie et les bateaux (bleus plus vifs) s'en détachent.
  water: { 'fill-color': ['#b5c9d8', '#0b1824'] },
  waterway_tunnel: { 'line-color': ['#a9bece', '#102334'] },
  waterway_river: { 'line-color': ['#a9bece', '#102334'] },
  waterway_other: { 'line-color': ['#a9bece', '#102334'] },
  building: {
    'fill-color': ['#e5e1da', '#232933'],
    'fill-outline-color': ['#d5d0c7', '#2e3540'],
  },
  'building-3d': { 'fill-extrusion-color': ['#e3dfd8', '#3a4350'] },
  boundary_3: { 'line-color': ['#c7c2ba', '#2b313b'] },
  boundary_2: { 'line-color': ['#a29d95', '#4a5260'] },
  boundary_disputed: { 'line-color': ['#a29d95', '#4a5260'] },
};

// --- Routes : gris chaud clair, d'autant plus foncé que la route compte -------------------

/** Remplissage et contour de chaque classe de route, jour puis nuit. */
const ROADS: Record<'motorway' | 'major' | 'secondary' | 'minor' | 'rail', { fill: [string, string]; casing: [string, string] }> = {
  motorway: { fill: ['#d6cdbd', '#454b56'], casing: ['#b6ab99', '#0e1116'] },
  major: { fill: ['#e0d9cd', '#394048'], casing: ['#c0b8a9', '#10141a'] },
  secondary: { fill: ['#ebe6dd', '#2e343d'], casing: ['#cdc6ba', '#10141a'] },
  minor: { fill: ['#fbfaf7', '#242a33'], casing: ['#dcd7ce', '#10141a'] },
  rail: { fill: ['#cfcac2', '#2c323c'], casing: ['#cfcac2', '#2c323c'] },
};

function roadClass(id: string): keyof typeof ROADS | null {
  if (!/^(tunnel|road|bridge)_/.test(id)) return null;
  if (/rail/.test(id)) return 'rail';
  if (/motorway_link/.test(id)) return 'major';
  if (/motorway/.test(id)) return 'motorway';
  if (/trunk_primary/.test(id)) return 'major';
  if (/secondary_tertiary|_link/.test(id)) return 'secondary';
  if (/minor|street|service_track|path_pedestrian/.test(id)) return 'minor';
  return null;
}

// --- Libellés : plus discrets, et moins nombreux ---------------------------------------------

/** Texte et halo (jour, nuit). Le halo reprend la couleur du fond pour ne pas former de taches. */
const HALO: [string, string] = ['rgba(243,241,236,0.85)', 'rgba(14,18,25,0.85)'];
const LABELS: Record<string, { text: [string, string]; halo?: [string, string] }> = {
  label_country_1: { text: ['#6a655d', '#8b94a3'] },
  label_country_2: { text: ['#6a655d', '#8b94a3'] },
  label_country_3: { text: ['#6a655d', '#8b94a3'] },
  label_state: { text: ['#8d887f', '#656e7d'] },
  label_city_capital: { text: ['#3d3a35', '#b4bccb'] },
  label_city: { text: ['#3d3a35', '#b4bccb'] },
  label_town: { text: ['#58544d', '#97a0af'] },
  label_village: { text: ['#6d6962', '#838c9b'] },
  label_other: { text: ['#6d6962', '#838c9b'] },
  water_name_point_label: { text: ['#6f879b', '#587288'], halo: ['rgba(181,201,216,0.7)', 'rgba(11,24,36,0.8)'] },
  water_name_line_label: { text: ['#6f879b', '#587288'], halo: ['rgba(181,201,216,0.7)', 'rgba(11,24,36,0.8)'] },
  waterway_line_label: { text: ['#7f97aa', '#4f677d'], halo: ['rgba(243,241,236,0.7)', 'rgba(14,18,25,0.8)'] },
  poi_r20: { text: ['#85807a', '#778092'] },
  poi_r7: { text: ['#85807a', '#778092'] },
  poi_r1: { text: ['#85807a', '#778092'] },
  poi_transit: { text: ['#657d90', '#7890a4'] },
  airport: { text: ['#85807a', '#778092'] },
  'highway-name-path': { text: ['#a39e96', '#6b7483'] },
  'highway-name-minor': { text: ['#85807a', '#778092'] },
  'highway-name-major': { text: ['#85807a', '#778092'] },
};

/**
 * Apparition plus tardive des libellés (zoom minimal). Aux petits zooms ne restent que les pays,
 * les capitales et les grandes villes ; les villes moyennes viennent vers le zoom 7, les villages
 * et le reste bien plus tard.
 */
const MIN_ZOOM: Record<string, number> = {
  label_town: 7.5,
  label_village: 11,
  label_other: 11,
  waterway_line_label: 12,
  'highway-shield-non-us': 10,
  'highway-shield-us-interstate': 10,
  road_shield_us: 10,
  'highway-name-major': 13,
  'highway-name-minor': 16,
  poi_r1: 16.5,
  poi_r7: 17,
  // Les arrêts et gares du fond (pictogrammes bleus) se confondent avec les TER et doublent
  // nos propres couches de transport : ils n'arrivent que tout près.
  poi_transit: 15,
};

/**
 * Les villes ordinaires ne s'affichent qu'à partir d'un certain rang : le rang d'OpenMapTiles
 * classe les villes du monde (1 = la plus grande), on garde les plus grandes quand on est loin,
 * puis davantage de villes à mesure que l'on s'approche (une couche par palier de zoom).
 */
const BIG_CITY_RANK = 5;


/** Peinture du relief ombré (ajouté par `setupBaseMap`, donc hors du style chargé). */
export function hillshadePaint(): Record<string, unknown> {
  return {
    'hillshade-exaggeration': 0.5,
    'hillshade-shadow-color': color('rgba(45, 36, 28, 0.65)', 'rgba(0, 0, 0, 0.6)'),
    'hillshade-highlight-color': color('rgba(255, 255, 255, 0.25)', 'rgba(150, 170, 205, 0.1)'),
  };
}

function paint(map: MapLibreMap, id: string, property: string, value: Expr): void {
  map.setPaintProperty(id, property, value as never, { validate: false });
}

/**
 * Applique le style calme au style qui vient de se charger. À appeler à `style.load`, avant le
 * premier dessin, et après avoir réglé l'état global `nuit` (les expressions le lisent).
 */
export function applyCalmStyle(map: MapLibreMap): void {
  const layers = map.getStyle().layers;
  const ids = new Set(layers.map((layer) => layer.id));

  for (const [id, colors] of Object.entries(FIXED)) {
    if (!ids.has(id)) continue;
    for (const [property, [day, night]] of Object.entries(colors)) paint(map, id, property, color(day, night));
  }

  // Trame blanche des zones piétonnes : trop claire sur fond sombre, elle s'efface presque la nuit.
  if (ids.has('road_area_pattern')) paint(map, 'road_area_pattern', 'fill-opacity', ['interpolate', ['linear'], ['zoom'], 3.5, 1, 5, duoNumber(1, 0.12)]);

  // Le relief ombré de Natural Earth (vu de loin) est clair : il disparaît la nuit.
  if (ids.has('natural_earth')) {
    paint(map, 'natural_earth', 'raster-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      0,
      0.5,
      NIGHT_FADE_FROM_ZOOM,
      0.3,
      NIGHT_FADE_TO_ZOOM,
      duoNumber(0.15, 0),
      7,
      duoNumber(0.05, 0),
    ]);
  }

  for (const layer of layers) {
    const kind = roadClass(layer.id);
    if (kind && layer.type === 'line') {
      const [day, night] = layer.id.endsWith('_casing') ? ROADS[kind].casing : ROADS[kind].fill;
      paint(map, layer.id, 'line-color', color(day, night));
    }
    if (/hatching$/.test(layer.id) && layer.type === 'line') {
      paint(map, layer.id, 'line-color', color(...ROADS.rail.fill));
    }
  }

  for (const [id, spec] of Object.entries(LABELS)) {
    if (!ids.has(id)) continue;
    paint(map, id, 'text-color', color(...spec.text));
    paint(map, id, 'text-halo-color', color(...(spec.halo ?? HALO)));
  }

  for (const [id, zoom] of Object.entries(MIN_ZOOM)) {
    if (!ids.has(id)) continue;
    const layer = layers.find((l) => l.id === id);
    map.setLayerZoomRange(id, zoom, layer?.maxzoom ?? 24);
  }

  // Pictogrammes des arrêts : bleu saturé de Liberty, atténués pour ne pas imiter une donnée.
  if (ids.has('poi_transit')) paint(map, 'poi_transit', 'icon-opacity', ['interpolate', ['linear'], ['zoom'], 15, 0.4, 17, 0.7]);

  thinCities(map, ids);
}

/** Aux petits zooms, seules les plus grandes villes ; les autres arrivent un peu plus près. */
function thinCities(map: MapLibreMap, ids: Set<string>): void {
  for (const id of ['label_city', 'label_city_capital']) {
    if (!ids.has(id)) continue;
    const filter = map.getFilter(id) as unknown[] | undefined;
    if (!filter) continue;
    // Capitale ou ville de rang ≤ BIG_CITY_RANK : visibles dès le zoom 4 ; les autres, plus près.
    map.setFilter(id, ['all', filter, ['<=', ['coalesce', ['get', 'rank'], 99], BIG_CITY_RANK]] as never);
    if (!map.getLayer(`${id}_autres`)) {
      const source = map.getStyle().layers.find((l) => l.id === id);
      if (source) {
        map.addLayer(
          {
            ...(source as object),
            id: `${id}_autres`,
            minzoom: 6.2,
            filter: ['all', filter, ['>', ['coalesce', ['get', 'rank'], 99], BIG_CITY_RANK]],
          } as never,
          id,
        );
      }
    }
  }
}
