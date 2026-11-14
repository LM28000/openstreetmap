/**
 * Fond de carte : style OpenStreetMap (OpenFreeMap), globe, relief 3D,
 * ombrage des reliefs et atmosphère.
 */
import { ScaleControl, type Map as MapLibreMap, type RasterDEMSourceSpecification, type SkySpecification } from 'maplibre-gl';
import { clock } from '../core/clock';
import { nightAmount, sunElevation } from '../modules/solar';
import { NIGHT_STATE, applyCalmStyle, hillshadePaint } from './calmStyle';

/**
 * Style OSM gratuit, sans clé, avec bâtiments 3D. © OpenMapTiles © OpenStreetMap.
 * C'est le style « Liberty » d'OpenFreeMap ; `setupBaseMap` le repeint en fond calme (calmStyle.ts).
 */
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

/** Relief du LiDAR HD de l'IGN (module « Relief LiDAR HD »), converti par le serveur : voir `setLidarTerrain`. */
export const LIDAR_TERRAIN_SOURCE = 'relief-lidar';
const LIDAR_HILLSHADE_SOURCE = 'relief-lidar-ombrage';
const LIDAR_HILLSHADE_LAYER = 'ombrage-relief-lidar';

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

/**
 * Altitudes du LiDAR HD, mêmes encodage et taille de tuile. Le serveur (`/api/relief-lidar`) rend le MNT de l'IGN là où
 * il existe et renvoie vers la tuile Mapterhorn ailleurs et sous le zoom 13. Mapterhorn n'a plus de tuiles en France
 * au-dessus du zoom 16 (ni du 17 à Lille) : la source s'arrête au 16, MapLibre agrandit au-delà.
 */
function lidarDemSource(): RasterDEMSourceSpecification {
  return {
    type: 'raster-dem',
    tiles: [new URL('/api/relief-lidar/{z}/{x}/{y}.png', window.location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}')],
    tileSize: 512,
    maxzoom: 16,
    encoding: 'terrarium',
    attribution: 'IGN, LiDAR HD (Licence Etalab 2.0)',
  };
}

/**
 * Source d'altitude du relief 3D à un instant donné. MapLibre n'en admet qu'une seule à la fois pour `setTerrain` :
 * changer de source remplace tout le relief (et son cache de rendu), donc on ne le fait qu'à l'allumage et à
 * l'extinction du relief LiDAR, pas à chaque zoom (le serveur se charge de retomber sur Mapterhorn au besoin).
 */
let lidarTerrain = false;

export const isLidarTerrain = (): boolean => lidarTerrain;
export const isTerrainSource = (id: string | undefined): boolean => id === TERRAIN_SOURCE || id === LIDAR_TERRAIN_SOURCE;

/** Le réglage du relief 3D (source et exagération) à donner à `map.setTerrain`. L'exagération est la même pour les deux sources : pas de saut au passage de l'une à l'autre. */
export function terrainOptions(): { source: string; exaggeration: number } {
  return { source: lidarTerrain ? LIDAR_TERRAIN_SOURCE : TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION };
}

/** Ajoute (si besoin) les deux sources du relief LiDAR, et la couche d'ombrage qui lui correspond. */
function ensureLidarSources(map: MapLibreMap): void {
  if (!map.getSource(LIDAR_TERRAIN_SOURCE)) map.addSource(LIDAR_TERRAIN_SOURCE, lidarDemSource());
  if (!map.getSource(LIDAR_HILLSHADE_SOURCE)) map.addSource(LIDAR_HILLSHADE_SOURCE, lidarDemSource());
  if (!map.getLayer(LIDAR_HILLSHADE_LAYER) && map.getLayer('ombrage-relief')) {
    map.addLayer(
      { id: LIDAR_HILLSHADE_LAYER, type: 'hillshade', source: LIDAR_HILLSHADE_SOURCE, layout: { visibility: 'none' }, paint: hillshadePaint() as never },
      'ombrage-relief',
    );
  }
}

/**
 * Allume ou éteint le relief 3D du LiDAR HD (appelé par le module « Relief LiDAR HD »). L'ombrage change de source en même
 * temps, sinon un ombrage de relief grossier se poserait sur un relief fin.
 */
export function setLidarTerrain(map: MapLibreMap, on: boolean): void {
  if (lidarTerrain === on) return;
  lidarTerrain = on;
  if (on) ensureLidarSources(map);
  const layer = map.getLayer(LIDAR_HILLSHADE_LAYER);
  if (layer) map.setLayoutProperty(LIDAR_HILLSHADE_LAYER, 'visibility', on ? 'visible' : 'none');
  if (map.getLayer('ombrage-relief')) map.setLayoutProperty('ombrage-relief', 'visibility', on && layer ? 'none' : 'visible');
  syncTerrainSource(map);
}

/** Met la source du relief en place en accord avec `lidarTerrain` (seulement si le relief est affiché : l'éteindre est un choix de l'utilisateur). */
function syncTerrainSource(map: MapLibreMap): void {
  const terrain = map.getTerrain();
  if (!terrain || terrain.source === terrainOptions().source || !map.getSource(terrainOptions().source)) return;
  if (map.getProjection()?.type === 'globe') return;
  map.setTerrain(terrainOptions());
}

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
  // L'état « nuit » doit exister avant les couleurs qui le lisent. On part de l'état du soleil
  // au centre de la vue pour ne pas montrer un fond de jour une seconde avant la bascule.
  const center = map.getCenter();
  nightValue = quantize(nightAmount(sunElevation(center.lat, center.lng, clock.now())));
  map.setGlobalStateProperty(NIGHT_STATE, nightValue);
  sunDrivesNight = false;
  // Si le module « Jour et nuit » est masqué, personne ne pilotera la nuit : retour au jour.
  map.once('load', () => {
    setTimeout(() => {
      if (!sunDrivesNight) setNight(map, 0);
    }, 3000);
  });
  const started = performance.now();
  applyCalmStyle(map);
  performance.measure('fond-calme', { start: started });

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
        // Assez marqué pour lire le relief même de nuit ; ombres et lumières suivent la palette.
        paint: hillshadePaint() as never,
      },
      // Au-dessus de la végétation, sous l'eau et les routes.
      existingLayerOr(map, 'waterway_tunnel'),
    );
  }

  // Après un changement de style, le relief LiDAR (s'il est demandé) est à remettre avec ses sources.
  if (lidarTerrain) {
    ensureLidarSources(map);
    if (map.getLayer(LIDAR_HILLSHADE_LAYER)) {
      map.setLayoutProperty(LIDAR_HILLSHADE_LAYER, 'visibility', 'visible');
      map.setLayoutProperty('ombrage-relief', 'visibility', 'none');
    }
  }
  map.setTerrain(terrainOptions());

  map.setSky(DAY_SKY);
}

/** Quantification de la nuit : 48 paliers suffisent à l'œil et évitent de repeindre à chaque image. */
const NIGHT_STEPS = 48;
const quantize = (amount: number) => Math.round(Math.min(1, Math.max(0, amount)) * NIGHT_STEPS) / NIGHT_STEPS;

let nightValue = 0;
let sunDrivesNight = false;

/** Part de nuit du fond de carte (0 = jour, 1 = nuit), pour que les couches adaptent leurs couleurs. */
export function currentNight(): number {
  return nightValue;
}

/**
 * Fait passer tout le fond de sa palette de jour (0) à sa palette de nuit (1). Un seul réglage
 * d'état global : les couleurs du style le lisent (voir calmStyle.ts).
 */
export function setNight(map: MapLibreMap, amount: number): void {
  const next = quantize(amount);
  sunDrivesNight = true;
  if (next === nightValue) return;
  nightValue = next;
  map.setGlobalStateProperty(NIGHT_STATE, next);
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
    map.setTerrain(on ? terrainOptions() : null);
  };

  map.on('projectiontransition', () => {
    const hasTerrain = map.getTerrain() !== null;
    if (isGlobe()) {
      if (hasTerrain) setTerrain(false);
    } else if (terrainWanted && !hasTerrain && map.getSource(terrainOptions().source)) {
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

/**
 * Point d'insertion des aplats de tuiles (élections, prix, population, zone des isochrones) : au-dessus des routes
 * **et des ponts** du fond, sous les bâtiments et les noms. Insérés avant le premier texte, les aplats passaient sous
 * les couches « bridge_* » (posées après les routes), et de courts traits blancs de ponts perçaient la couleur.
 */
export function fillInsertionId(map: MapLibreMap): string | undefined {
  for (const id of ['building', 'building-3d', 'boundary_3']) if (map.getLayer(id)) return id;
  return firstSymbolLayerId(map);
}

/**
 * Point d'insertion des marques ponctuelles (ventes, pastilles) : au-dessus des bâtiments 3D, sous les textes.
 * (Le premier texte du style est une flèche de sens unique, sous les ponts et les bâtiments.)
 */
export function aboveBuildingsId(map: MapLibreMap): string | undefined {
  const layers = map.getStyle().layers;
  const roof = layers.findIndex((layer) => layer.id === 'building-3d' || layer.id === 'building');
  const from = roof < 0 ? 0 : roof;
  return layers.slice(from).find((layer) => layer.type === 'symbol')?.id ?? firstSymbolLayerId(map);
}

function existingLayerOr(map: MapLibreMap, id: string): string | undefined {
  return map.getLayer(id) ? id : firstSymbolLayerId(map);
}

/**
 * Échelle de la carte. Celle de MapLibre se recalcule à chaque image de mouvement avec deux `unproject`,
 * et avec le relief chaque `unproject` redessine la passe de coordonnées puis relit un pixel du GPU
 * (`readPixels`, qui bloque le processeur jusqu'à la fin du dessin) : environ la moitié du temps d'image
 * d'une vue de ville. Pendant le mouvement, le calcul se fait donc sur le plan sans relief (instantané) ;
 * à l'arrêt, il est refait avec le relief : la barre est exacte au repos.
 */
export class CalmScaleControl extends ScaleControl {
  override onAdd(map: MapLibreMap): HTMLElement {
    const self = this as unknown as { _onMove: () => void; _map?: MapLibreMap };
    const exact = self._onMove;
    type Transform = { screenPointToLocation(point: { x: number; y: number }): unknown };
    const flat = Object.create(map) as MapLibreMap;
    (flat as unknown as { unproject: (p: [number, number]) => unknown }).unproject = ([x, y]) =>
      (map.transform as unknown as Transform).screenPointToLocation({ x, y });
    let moving = false;
    self._onMove = () => {
      moving = true;
      const real = self._map;
      self._map = flat;
      try {
        exact();
      } finally {
        self._map = real;
      }
    };
    const element = super.onAdd(map);
    // Les déplacements par saccades (suivi d'un train, rotation pilotée) enchaînent des « moveend » à chaque
    // image : on attend un court silence avant de refaire le calcul exact.
    let settle: ReturnType<typeof setTimeout> | undefined;
    map.on('move', () => clearTimeout(settle));
    map.on('moveend', () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (!moving) return;
        moving = false;
        exact();
      }, 200);
    });
    return element;
  }
}
