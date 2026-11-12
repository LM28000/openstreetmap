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

  map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });

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
