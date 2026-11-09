/**
 * Module « Jour et nuit » : l'ombre de la nuit et des crépuscules, calculée
 * à partir de la position du soleil à l'instant t.
 *
 * On calcule une image en projection Web Mercator : chaque pixel reçoit une
 * opacité selon la hauteur du soleil à cet endroit. L'image est dessinée dans un
 * canvas, affiché par MapLibre (couche native) qui le drape sur le relief et le globe.
 *
 * Vue de loin, l'image couvre le monde entier. Vue de près, elle ne couvre qu'une
 * zone autour de la vue : MapLibre ne sait pas afficher une image grande comme le
 * monde à fort zoom (elle s'efface à partir du zoom 13 environ).
 */
import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl';
import { defineModule } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { subsolarPoint, sunPosition } from './solar';

const SIZE = 512;
const SOURCE_ID = 'jour-nuit';
const LAYER_ID = 'jour-nuit';
const DEG = Math.PI / 180;
/** Limite de latitude de la projection Web Mercator. */
const MAX_LAT = 85.051129;
/** En dessous de ce zoom, on calcule le monde entier ; au-dessus, la zone autour de la vue. */
const WORLD_MAX_ZOOM = 6;
const NIGHT_COLOR = [8, 12, 38] as const;
const MAX_OPACITY = 0.62;

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

/** Zone à calculer : le monde vu de loin, sinon la vue élargie d'une largeur de chaque côté. */
function boxForView(map: MapLibreMap): Box {
  if (map.getZoom() < WORLD_MAX_ZOOM) return WORLD_BOX;
  const bounds = map.getBounds();
  const width = bounds.getEast() - bounds.getWest();
  const height = bounds.getNorth() - bounds.getSouth();
  return {
    west: Math.max(-180, bounds.getWest() - width),
    east: Math.min(180, bounds.getEast() + width),
    south: Math.max(-MAX_LAT, bounds.getSouth() - height),
    north: Math.min(MAX_LAT, bounds.getNorth() + height),
  };
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
const NIGHT_LIGHT = [52, 62, 108];
const DEFAULT_LIGHT = { anchor: 'viewport', color: 'white', intensity: 0.5, position: [1.15, 210, 30] } as const;

function mix(a: number[], b: number[], t: number): string {
  const c = a.map((value, i) => Math.round(value + ((b[i] ?? value) - value) * t));
  return `rgb(${c.join(', ')})`;
}

function applySunLight(map: MapLibreMap, time: number): void {
  const center = map.getCenter();
  const { elevation, azimuth } = sunPosition(center.lat, center.lng, time);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const color =
    elevation >= 0 ? mix(DAY_LIGHT, DUSK_LIGHT, clamp((8 - elevation) / 8)) : mix(DUSK_LIGHT, NIGHT_LIGHT, clamp(-elevation / 8));
  map.setLight({
    anchor: 'map', // la direction est relative au nord, comme le soleil
    color,
    intensity: 0.4,
    // [distance, direction depuis le nord, angle depuis le zénith] ; la nuit, lumière diffuse d'en haut
    position: elevation > 0 ? [1.15, azimuth, Math.min(85, 90 - elevation)] : [1.15, 210, 30],
  });
}

let canvas: HTMLCanvasElement | undefined;
let currentBox: Box = WORLD_BOX;

function nightCanvas(): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
  }
  return canvas;
}

export const dayNight = defineModule<undefined>({
  id: 'jour-nuit',
  name: 'Jour et nuit',
  category: 'ciel',
  description: 'L’ombre de la nuit et des crépuscules, d’après la position du soleil.',
  attribution: 'calcul astronomique',
  visibleByDefault: true,
  timeStepMs: 60_000, // l'ombre bouge d'environ 0,25° par minute : inutile d'aller plus vite
  followsView: true,

  native: {
    add(map: MapLibreMap) {
      currentBox = WORLD_BOX;
      // animate: false → MapLibre ne relit le canvas que quand on le lui demande (voir update).
      map.addSource(SOURCE_ID, {
        type: 'canvas',
        canvas: nightCanvas(),
        coordinates: toCoordinates(currentBox),
        animate: false,
      });
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'raster',
          source: SOURCE_ID,
          paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear' },
        },
        firstSymbolLayerId(map),
      );
    },
    update(map, { time }) {
      const source = map.getSource(SOURCE_ID) as CanvasSource | undefined;
      if (!source) return;
      const box = boxForView(map);
      nightCanvas().getContext('2d')?.putImageData(renderNightImage(time, box), 0, 0);
      if (JSON.stringify(box) !== JSON.stringify(currentBox)) {
        source.setCoordinates(toCoordinates(box));
        currentBox = box;
      }
      // play() puis pause() : MapLibre recopie le canvas une fois puis redessine la carte.
      source.play();
      source.pause();
      applySunLight(map, time);
    },
    remove(map) {
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      map.setLight({ ...DEFAULT_LIGHT, position: [...DEFAULT_LIGHT.position] });
    },
  },
});
