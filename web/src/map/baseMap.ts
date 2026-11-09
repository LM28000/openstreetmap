/**
 * Fond de carte : style OpenStreetMap (OpenFreeMap), globe, relief 3D,
 * ombrage des reliefs et atmosphère.
 */
import type { Map as MapLibreMap, RasterDEMSourceSpecification, SkySpecification } from 'maplibre-gl';

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

/** Ciel de jour. Le module « Jour et nuit » l'assombrit selon la position du soleil. */
export const DAY_SKY: SkySpecification = {
  'sky-color': '#3d6fb6',
  'horizon-color': '#cfe0f3',
  'fog-color': '#e6edf5',
  'sky-horizon-blend': 0.5,
  'horizon-fog-blend': 0.6,
  'fog-ground-blend': 0.7,
  // Halo d'atmosphère autour du globe, qui s'efface quand on zoome.
  'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
};

/**
 * À appeler à chaque chargement de style. La carte démarre à plat (Mercator) avec
 * le relief ; le globe est proposé par un bouton (voir `keepGlobeAndTerrainApart`).
 */
export function setupBaseMap(map: MapLibreMap): void {
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
          // Assez marqué pour lire le relief même sous l'ombre de la nuit.
          'hillshade-exaggeration': 0.5,
          'hillshade-shadow-color': 'rgba(45, 36, 28, 0.65)',
          'hillshade-highlight-color': 'rgba(255, 255, 255, 0.25)',
        },
      },
      // Au-dessus de la végétation, sous l'eau et les routes.
      existingLayerOr(map, 'waterway_tunnel'),
    );
  }

  map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });

  map.setSky(DAY_SKY);
}

/**
 * MapLibre 5 ne gère pas complètement le relief 3D sur le globe (il l'annonce :
 * « terrain is not fully supported on vertical perspective projection ») : faire
 * pivoter ou incliner la carte peut y déclencher une erreur interne qui la fige
 * définitivement. Globe et relief ne vont donc jamais ensemble : passer au globe
 * coupe le relief (il revient en repassant à plat), et réactiver le relief sur le
 * globe repasse à plat.
 */
export function keepGlobeAndTerrainApart(map: MapLibreMap): void {
  const isGlobe = () => map.getProjection()?.type === 'globe';
  let terrainWanted = true;
  /** État du relief que l'on vient d'imposer nous-mêmes (pour ne pas le prendre pour un choix de l'utilisateur). */
  let imposed: boolean | null = null;

  const setTerrain = (on: boolean) => {
    imposed = on;
    map.setTerrain(on ? { source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION } : null);
  };

  map.on('projectiontransition', () => {
    const hasTerrain = map.getTerrain() !== null;
    if (isGlobe()) {
      if (hasTerrain) setTerrain(false);
    } else if (terrainWanted && !hasTerrain && map.getSource(TERRAIN_SOURCE)) {
      // (L'événement arrive aussi pendant le chargement du style, avant que la source existe.)
      setTerrain(true);
    }
  });

  map.on('terrain', () => {
    const hasTerrain = map.getTerrain() !== null;
    if (imposed === hasTerrain) {
      imposed = null;
      return;
    }
    terrainWanted = hasTerrain;
    if (hasTerrain && isGlobe()) map.setProjection({ type: 'mercator' });
  });
}

/**
 * Le style OSM utilisé référence quelques icônes absentes de sa planche d'images :
 * on les remplace par une image transparente plutôt que d'encombrer la console.
 */
export function ignoreMissingIcons(map: MapLibreMap): void {
  map.on('styleimagemissing', ({ id }) => {
    if (!map.hasImage(id)) map.addImage(id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
}

/** Première couche de texte : on insère nos couches dessous pour garder les noms lisibles. */
export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
}

function existingLayerOr(map: MapLibreMap, id: string): string | undefined {
  return map.getLayer(id) ? id : firstSymbolLayerId(map);
}
