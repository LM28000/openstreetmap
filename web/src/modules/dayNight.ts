/**
 * Module « Jour et nuit » : la nuit et les crépuscules, d'après la position du soleil à l'instant t.
 *
 * Deux choses, qui se relaient selon le zoom :
 *  - de près (à partir du zoom 5 environ), le fond de carte lui-même passe à une palette sombre
 *    selon la hauteur du soleil au centre de la vue (voir `setNight` dans baseMap.ts) ;
 *  - de loin (continent, globe), où la nuit n'est pas la même d'un bord à l'autre de la vue, un
 *    voile drape l'ombre de la Terre : chaque pixel d'une image Web Mercator reçoit une opacité
 *    selon la hauteur du soleil à cet endroit, ce qui dessine la ligne du crépuscule en dégradé.
 *    L'image couvre le monde entier et s'efface en fondu quand on zoome (le fond prend le relais).
 *
 * Les bâtiments 3D sont éclairés comme le vrai soleil, et le ciel suit.
 */
import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl';
import { defineModule } from '../core/module';
import { DAY_SKY, firstSymbolLayerId, setNight } from '../map/baseMap';
import { NIGHT_FADE_FROM_ZOOM, NIGHT_FADE_TO_ZOOM } from '../map/calmStyle';
import { clock } from '../core/clock';
import { nightAmount, subsolarPoint, sunPosition } from './solar';

const SIZE = 512;
const SOURCE_ID = 'jour-nuit';
const LAYER_ID = 'jour-nuit';
const DEG = Math.PI / 180;
/** Limite de latitude de la projection Web Mercator. */
const MAX_LAT = 85.051129;
const NIGHT_COLOR = [12, 20, 56] as const;
/** Le voile n'est que la ligne du crépuscule vue de loin : assez sombre pour sentir la nuit. */
const MAX_OPACITY = 0.5;

interface Box {
  west: number;
  south: number;
  east: number;
  north: number;
}

const WORLD_BOX: Box = { west: -180, south: -MAX_LAT, east: 180, north: MAX_LAT };

/**
 * Opacité (0-255) en fonction du sinus de la hauteur du soleil, précalculée.
 * Soleil levé : rien. Puis crépuscules civil (0 à -6°), nautique (-6 à -12°)
 * et astronomique (-12 à -18°) de plus en plus sombres, puis nuit noire.
 */
const LUT_SIZE = 2001;
const LUT_HALF = (LUT_SIZE - 1) / 2;
const opacityLut = new Uint8ClampedArray(LUT_SIZE);
for (let i = 0; i < LUT_SIZE; i++) {
  const elevation = Math.asin(i / LUT_HALF - 1) / DEG;
  const t = Math.min(1, Math.max(0, (0.8 - elevation) / 18.8)); // 0,8° : réfraction de l'atmosphère
  opacityLut[i] = Math.round(255 * MAX_OPACITY * Math.pow(t, 0.6));
}

const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
const inverseMercatorY = (y: number) => 2 * Math.atan(Math.exp(y)) - Math.PI / 2; // en radians

/** Image de l'ombre de la nuit sur la zone `box`, à l'instant `time`. */
export function renderNightImage(time: number, box: Box = WORLD_BOX): ImageData {
  const sun = subsolarPoint(time);
  const sinDec = Math.sin(sun.lat * DEG);
  const cosDec = Math.cos(sun.lat * DEG);

  const colCosHourAngle = new Float64Array(SIZE);
  for (let x = 0; x < SIZE; x++) {
    const lon = box.west + ((box.east - box.west) * (x + 0.5)) / SIZE;
    colCosHourAngle[x] = Math.cos((lon - sun.lon) * DEG);
  }

  // MapLibre étire l'image linéairement en Web Mercator : les lignes sont régulières en « y Mercator ».
  const yNorth = mercatorY(box.north);
  const ySouth = mercatorY(box.south);
  const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const lat = inverseMercatorY(yNorth + ((ySouth - yNorth) * (y + 0.5)) / SIZE);
    const a = Math.sin(lat) * sinDec;
    const b = Math.cos(lat) * cosDec;
    for (let x = 0; x < SIZE; x++) {
      const sinElevation = a + b * colCosHourAngle[x]!;
      const i = (y * SIZE + x) * 4;
      pixels[i] = NIGHT_COLOR[0];
      pixels[i + 1] = NIGHT_COLOR[1];
      pixels[i + 2] = NIGHT_COLOR[2];
      pixels[i + 3] = opacityLut[Math.round((sinElevation + 1) * LUT_HALF)]!;
    }
  }
  return new ImageData(pixels, SIZE, SIZE);
}

function toCoordinates(box: Box): [[number, number], [number, number], [number, number], [number, number]] {
  return [
    [box.west, box.north],
    [box.east, box.north],
    [box.east, box.south],
    [box.west, box.south],
  ];
}

/**
 * Les bâtiments 3D sont dessinés par-dessus les couches au sol : l'ombre ne les
 * couvre pas. On règle donc l'éclairage de la carte comme le vrai soleil au centre
 * de la vue : sa direction le jour, une teinte dorée au crépuscule, sombre la nuit.
 */
const DAY_LIGHT = [255, 255, 255];
const DUSK_LIGHT = [255, 190, 135];
/**
 * Clair de lune à peine bleuté : assez lumineux pour que les faces des bâtiments restent
 * distinctes, mais neutre, sinon les bâtiments (déjà sombres la nuit) virent au violet.
 */
const NIGHT_LIGHT = [150, 158, 178];
const DEFAULT_LIGHT = { anchor: 'viewport', color: 'white', intensity: 0.5, position: [1.15, 210, 30] } as const;

/** Couleurs du ciel : jour (celles du fond de carte) → nuit. */
const SKY_DAY = { sky: [61, 111, 182], horizon: [207, 224, 243], fog: [230, 237, 245] };
/**
 * La nuit, le brouillard se mêle au sol sur 70 % de la vue inclinée (`fog-ground-blend`) :
 * il doit rester proche du fond de nuit (#12161d), sinon toute la carte vire au violet.
 */
const SKY_NIGHT = { sky: [9, 13, 26], horizon: [30, 37, 52], fog: [24, 29, 38] };

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((value, i) => Math.round(value + ((b[i] ?? value) - value) * t));
  return `rgb(${c.join(', ')})`;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Éclairage des bâtiments, palette du fond et couleur du ciel selon le soleil au centre de la vue. */
function applySunLight(map: MapLibreMap, time: number): void {
  const center = map.getCenter();
  const { elevation, azimuth } = sunPosition(center.lat, center.lng, time);
  const color =
    elevation >= 0
      ? mix(DAY_LIGHT, DUSK_LIGHT, clamp01((8 - elevation) / 8))
      : mix(DUSK_LIGHT, NIGHT_LIGHT, clamp01(-elevation / 8));
  map.setLight({
    anchor: 'map', // la direction est relative au nord, comme le soleil
    color,
    intensity: 0.45,
    // [distance, direction depuis le nord, angle depuis le zénith] ; la nuit, lumière diffuse de biais
    position: elevation > 0 ? [1.15, azimuth, Math.min(85, 90 - elevation)] : [1.15, 210, 40],
  });

  // Le fond de carte et le ciel basculent pendant les crépuscules, entre +4° et -12° de hauteur du soleil.
  setNight(map, nightAmount(elevation));
  const night = clamp01((4 - elevation) / 16);
  map.setSky({
    ...DAY_SKY,
    'sky-color': mix(SKY_DAY.sky, SKY_NIGHT.sky, night),
    'horizon-color': mix(SKY_DAY.horizon, SKY_NIGHT.horizon, night),
    'fog-color': mix(SKY_DAY.fog, SKY_NIGHT.fog, night),
  });
}

let canvas: HTMLCanvasElement | undefined;
/** Pas de temps (minute) de la dernière image du voile, et vrai si le voile est resté en retard (caché de près). */
let drawnStep = Number.NaN;
let veilStale = false;

function nightCanvas(): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
  }
  return canvas;
}

/**
 * Fait recopier le canvas par MapLibre : play() puis pause() le recopie une fois et
 * redessine la carte. Juste après le chargement, la source n'a pas encore de tuiles et
 * MapLibre ignore la copie : on réessaie alors à chaque image jusqu'à ce qu'elle passe
 * (sinon, en pause, l'ombre restait celle d'avant jusqu'au prochain déplacement).
 */
function pushCanvas(map: MapLibreMap, source: CanvasSource): void {
  source.play();
  source.pause();
  if (Object.keys(source.tiles).length > 0) return;
  map.once('render', () => {
    if (map.getSource(SOURCE_ID) === source) pushCanvas(map, source);
  });
}

/** Le voile n'est visible que sous ce zoom : au-dessus, inutile de le recalculer. */
const VEIL_MAX_ZOOM = NIGHT_FADE_TO_ZOOM;
const VEIL_STEP_MS = 60_000;

/**
 * Redessine le voile et le fait recopier par MapLibre.
 *
 * Pourquoi `setCoordinates` avec les mêmes coordonnées : avec le relief, MapLibre dessine les
 * couches raster dans une texture par tuile du relief, qu'il garde en cache (`RenderToTexture`).
 * Il ne la vide que sur un événement de chargement de tuile de la source, et pour une source
 * « canvas » il ne vide que les tuiles du relief descendantes de la tuile qui porte l'image
 * (`freeRtt(tileID)` : sa condition « c'est une image » ne reconnaît pas le type `canvas`, alors
 * qu'elle vide tout pour le type `image`). Une image qui déborde de sa tuile laissait donc les
 * tuiles voisines sur l'image précédente : une coupure nette au méridien 0° quand le voile
 * ne couvrait que la zone autour de la vue. Le voile couvre maintenant toujours le monde, donc
 * la tuile 0/0/0 : toutes les tuiles du relief en descendent et sont vidées. Redonner les
 * coordonnées recharge la tuile et déclenche cet événement, même sans changement.
 */
function redrawVeil(map: MapLibreMap, source: CanvasSource, time: number): void {
  nightCanvas().getContext('2d')?.putImageData(renderNightImage(time), 0, 0);
  pushCanvas(map, source);
  source.setCoordinates(toCoordinates(WORLD_BOX));
  drawnStep = Math.floor(time / VEIL_STEP_MS);
  veilStale = false;
}

let onZoomEnd: (() => void) | undefined;

export const dayNight = defineModule<undefined>({
  id: 'jour-nuit',
  name: 'Jour et nuit',
  category: 'ciel',
  description: 'La nuit et les crépuscules : fond sombre la nuit, ligne du crépuscule vue de loin.',
  attribution: 'calcul astronomique',
  visibleByDefault: true,
  timeStepMs: 60_000, // le soleil bouge d'environ 0,25° par minute : inutile d'aller plus vite
  followsView: true, // la palette suit le soleil au centre de la vue

  native: {
    add(map: MapLibreMap) {
      drawnStep = Number.NaN;
      veilStale = true;
      // animate: false → MapLibre ne relit le canvas que quand on le lui demande (voir redrawVeil).
      map.addSource(SOURCE_ID, {
        type: 'canvas',
        canvas: nightCanvas(),
        coordinates: toCoordinates(WORLD_BOX),
        animate: false,
      });
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'raster',
          source: SOURCE_ID,
          maxzoom: VEIL_MAX_ZOOM,
          paint: {
            'raster-fade-duration': 0,
            'raster-resampling': 'linear',
            // Plein vue de loin, absent de près : le fond de carte prend le relais.
            'raster-opacity': ['interpolate', ['linear'], ['zoom'], NIGHT_FADE_FROM_ZOOM, 1, NIGHT_FADE_TO_ZOOM, 0],
          },
        },
        firstSymbolLayerId(map),
      );
      // En revenant de près à loin, le voile n'a pas suivi l'heure : on le remet à jour.
      onZoomEnd = () => {
        const source = map.getSource(SOURCE_ID) as CanvasSource | undefined;
        if (source && veilStale && map.getZoom() < VEIL_MAX_ZOOM) redrawVeil(map, source, clock.now());
      };
      map.on('zoomend', onZoomEnd);
    },
    update(map, { time }) {
      const source = map.getSource(SOURCE_ID) as CanvasSource | undefined;
      if (!source) return;
      // L'image ne dépend que de l'heure (pas de la vue) : une fois par minute simulée, et seulement
      // quand le voile se voit.
      if (map.getZoom() < VEIL_MAX_ZOOM) {
        if (veilStale || Math.floor(time / VEIL_STEP_MS) !== drawnStep) redrawVeil(map, source, time);
      } else {
        veilStale = true;
      }
      applySunLight(map, time);
    },
    remove(map) {
      if (onZoomEnd) map.off('zoomend', onZoomEnd);
      onZoomEnd = undefined;
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      map.setLight({ ...DEFAULT_LIGHT, position: [...DEFAULT_LIGHT.position] });
      map.setSky(DAY_SKY);
      setNight(map, 0);
    },
  },
});
