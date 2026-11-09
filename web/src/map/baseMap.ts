/**
 * Fond de carte : style OpenStreetMap (OpenFreeMap), globe, relief 3D,
 * ombrage des reliefs et atmosphère.
 */
import type { Map as MapLibreMap, RasterDEMSourceSpecification } from 'maplibre-gl';

/** Style OSM gratuit, sans clé, avec bâtiments 3D. © OpenMapTiles © OpenStreetMap. */
export const BASE_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

export const INITIAL_VIEW = {
  center: [2.6, 46.4] as [number, number],
  zoom: 5.2,
  pitch: 30,
  bearing: 0,
};

export const TERRAIN_SOURCE = 'relief';
export const TERRAIN_EXAGGERATION = 1.4;
const HILLSHADE_SOURCE = 'relief-ombrage';

/**
 * Altitudes Mapterhorn (encodage « terrarium », tuiles 512 px).
 * Couverture mondiale jusqu'au zoom 12 ; au-delà, MapLibre agrandit les tuiles.
 */
const DEM_SOURCE: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
  tileSize: 512,
  maxzoom: 12,
  encoding: 'terrarium',
  attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noreferrer">© Mapterhorn</a>',
};

/** À appeler à chaque chargement de style. */
export function setupBaseMap(map: MapLibreMap): void {
  map.setProjection({ type: 'globe' });

  // Deux sources distinctes : MapLibre rend mieux l'ombrage quand il ne partage
  // pas sa source avec le relief 3D.
  if (!map.getSource(TERRAIN_SOURCE)) map.addSource(TERRAIN_SOURCE, DEM_SOURCE);
  if (!map.getSource(HILLSHADE_SOURCE)) map.addSource(HILLSHADE_SOURCE, DEM_SOURCE);

  if (!map.getLayer('ombrage-relief')) {
    map.addLayer(
      {
        id: 'ombrage-relief',
        type: 'hillshade',
        source: HILLSHADE_SOURCE,
        paint: {
          'hillshade-exaggeration': 0.35,
          'hillshade-shadow-color': 'rgba(60, 48, 36, 0.55)',
          'hillshade-highlight-color': 'rgba(255, 255, 255, 0.18)',
        },
      },
      // Au-dessus de la végétation, sous l'eau et les routes.
      existingLayerOr(map, 'waterway_tunnel'),
    );
  }

  map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });

  map.setSky({
    'sky-color': '#3d6fb6',
    'horizon-color': '#cfe0f3',
    'fog-color': '#e6edf5',
    'sky-horizon-blend': 0.5,
    'horizon-fog-blend': 0.6,
    'fog-ground-blend': 0.7,
    // Halo d'atmosphère autour du globe, qui s'efface quand on zoome.
    'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
  });
}

/** Première couche de texte : on insère nos couches dessous pour garder les noms lisibles. */
export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
}

function existingLayerOr(map: MapLibreMap, id: string): string | undefined {
  return map.getLayer(id) ? id : firstSymbolLayerId(map);
}
