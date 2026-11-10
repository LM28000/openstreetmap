/**
 * Module « Ombres des bâtiments » : l'ombre que chaque bâtiment projette au sol,
 * selon la vraie position du soleil à l'instant t.
 *
 * Principe : les empreintes et les hauteurs viennent des tuiles vectorielles que MapLibre
 * a déjà chargées pour dessiner les bâtiments 3D (`querySourceFeatures` : aucun
 * téléchargement en plus, et les ombres collent exactement aux bâtiments affichés).
 * Pour chaque bâtiment, on balaie son empreinte le long de la direction opposée au
 * soleil, sur une longueur `hauteur / tan(hauteur du soleil)`.
 *
 * Toutes les ombres sont dessinées dans UN canvas 2D, en une seule couleur opaque :
 * le remplissage fait l'union des polygones (deux ombres qui se chevauchent ne
 * s'assombrissent pas deux fois), et l'opacité est appliquée ensuite par MapLibre.
 * Le canvas est une image que MapLibre drape sur le relief, sous les bâtiments 3D
 * (qui masquent donc correctement l'ombre derrière eux). On ne passe pas par
 * deck.gl : ses couches se posent à l'altitude 0 et ne suivent pas le relief de MapLibre,
 * et il faudrait redessiner les bâtiments pour qu'ils portent des ombres.
 *
 * Le canvas est un carré orienté selon le cap de la carte, centré sur la vue : il garde
 * ainsi une résolution d'environ un pixel par pixel d'écran. Il est recalculé quand la
 * vue sort de sa marge, quand le zoom change, quand des tuiles arrivent et à chaque
 * pas de temps du soleil. Les empreintes, elles, ne sont relues dans MapLibre que si la vue
 * ou les tuiles ont changé.
 */
import { MercatorCoordinate } from 'maplibre-gl';
import type { CanvasSource, Map as MapLibreMap } from 'maplibre-gl';
import { clock } from '../core/clock';
import { defineModule } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { sunPosition } from './solar';

const SOURCE_ID = 'ombres-batiments';
const LAYER_ID = 'ombres-batiments';
const VECTOR_SOURCE = 'openmaptiles';
const DEG = Math.PI / 180;

/** Zoom à partir duquel le fond de carte affiche les bâtiments en 3D. */
const MIN_ZOOM = 14;
/** Zoom où les ombres sont à pleine opacité (elles apparaissent en fondu avant). */
const FULL_ZOOM = 14.8;
/** Côté du canvas, en pixels. 2048 reste léger à envoyer au GPU (16 Mo) et suffit à ~1 px par pixel d'écran. */
const SIZE = 2048;
/** Le carré couvre au moins la plus grande dimension de l'écran multipliée par ce facteur (marge de déplacement)… */
const MIN_COVERAGE = 1.3;
/** … et au plus ce facteur, quand la vue est très inclinée (au-delà, la résolution devient trop faible). */
const MAX_COVERAGE = 2.2;
/** Ombre plus longue que 14 fois la hauteur (soleil à moins de 4°) : on plafonne, sinon elle traverse la ville. */
const MIN_ELEVATION_FOR_LENGTH = 4;
/** Hauteur du soleil (°) à partir de laquelle l'ombre est à pleine opacité ; en dessous, elle s'estompe. */
const FULL_SHADOW_ELEVATION = 7;
const MAX_OPACITY = 0.42;
const SHADOW_COLOR = 'rgb(16, 20, 44)';
/** Délai minimal entre deux recalculs pendant que le temps défile vite. */
const MIN_REDRAW_INTERVAL_MS = 120;

/** Un bâtiment : empreinte en coordonnées Mercator (0-1), orientée dans le sens positif. */
interface Footprint {
  ring: Float64Array; // x0, y0, x1, y1, …
  height: number; // mètres
  minHeight: number; // mètres (parties en surplomb, ponts)
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Position du carré affiché, en Mercator. */
interface Frame {
  cx: number;
  cy: number;
  /** Côté du carré (unités Mercator). */
  side: number;
  /** Cap de la carte, en radians. */
  bearing: number;
  pitch: number;
  zoom: number;
}

let canvas: HTMLCanvasElement | undefined;
let footprints: Footprint[] = [];
let frame: Frame | undefined;
/** Vrai si les empreintes ne correspondent plus à la vue (déplacement, nouvelles tuiles). */
let footprintsStale = true;
let lastDraw = 0;
let lastOpacity = -1;
let lastVisible: boolean | undefined;
let lastElevation = 0;
let drawnCount = 0;
let cleanup: (() => void) | undefined;

function shadowCanvas(): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
  }
  return canvas;
}

/** Même contournement que le module « Jour et nuit » : MapLibre ne relit le canvas que si on le lui demande. */
function pushCanvas(map: MapLibreMap, source: CanvasSource): void {
  source.play();
  source.pause();
  if (Object.keys(source.tiles).length > 0) return;
  map.once('render', () => {
    if (map.getSource(SOURCE_ID) === source) pushCanvas(map, source);
  });
}

// --- Cadre du canvas ---

function currentFrame(map: MapLibreMap): Frame {
  const zoom = map.getZoom();
  const bearing = map.getBearing() * DEG;
  const container = map.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  const screenSide = Math.max(width, height) / (512 * 2 ** zoom); // 512 px = le monde au zoom 0
  const c = MercatorCoordinate.fromLngLat(map.getCenter());
  const right = [Math.cos(bearing), Math.sin(bearing)] as const;
  const down = [-Math.sin(bearing), Math.cos(bearing)] as const;

  // Terrain visible : les coins de l'écran, ramenés au sol (la partie la plus haute de l'écran, près
  // de l'horizon, est ignorée). Incliné, il s'étend loin devant la caméra.
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const [x, y] of [
    [0, height * 0.12],
    [width, height * 0.12],
    [0, height],
    [width, height],
  ] as const) {
    const m = MercatorCoordinate.fromLngLat(map.unproject([x, y]));
    const u = (m.x - c.x) * right[0] + (m.y - c.y) * right[1];
    const v = (m.x - c.x) * down[0] + (m.y - c.y) * down[1];
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  // Carré assez grand pour tout couvrir, mais borné pour garder la résolution ; s'il faut rogner, on garde le premier plan.
  const side = Math.min(MAX_COVERAGE * screenSide, Math.max(MIN_COVERAGE * screenSide, Math.max(uMax - uMin, vMax - vMin) * 1.06));
  const uc = (uMin + uMax) / 2;
  const vc = vMax - vMin > side ? vMax - side / 2 : (vMin + vMax) / 2;
  return {
    cx: c.x + uc * right[0] + vc * down[0],
    cy: c.y + uc * right[1] + vc * down[1],
    side,
    bearing,
    pitch: map.getPitch() * DEG,
    zoom,
  };
}

/** Les quatre coins du carré en lon/lat (haut-gauche, haut-droit, bas-droit, bas-gauche), pour MapLibre. */
function frameCoordinates(f: Frame): [[number, number], [number, number], [number, number], [number, number]] {
  const right = [Math.cos(f.bearing), Math.sin(f.bearing)] as const;
  const down = [-Math.sin(f.bearing), Math.cos(f.bearing)] as const;
  const corner = (sx: number, sy: number): [number, number] => {
    const dx = (sx * f.side) / 2;
    const dy = (sy * f.side) / 2;
    const ll = new MercatorCoordinate(f.cx + dx * right[0] + dy * down[0], f.cy + dx * right[1] + dy * down[1], 0).toLngLat();
    return [ll.lng, ll.lat];
  };
  return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
}

/** La vue a-t-elle quitté le cadre dessiné (déplacement, zoom ou rotation notables) ? */
function frameIsStale(map: MapLibreMap): boolean {
  if (!frame) return true;
  const now = currentFrame(map);
  const drift = Math.hypot(now.cx - frame.cx, now.cy - frame.cy);
  return (
    drift > frame.side * 0.12 ||
    Math.abs(now.zoom - frame.zoom) > 0.35 ||
    Math.abs(angleDifference(now.bearing, frame.bearing)) > 8 * DEG ||
    Math.abs(now.pitch - frame.pitch) > 8 * DEG
  );
}

function angleDifference(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

// --- Lecture des bâtiments ---

/** Relit les empreintes des tuiles chargées. C'est la partie coûteuse : on la limite aux changements de vue. */
function extractFootprints(map: MapLibreMap): void {
  const features = map.querySourceFeatures(VECTOR_SOURCE, {
    sourceLayer: 'building',
    filter: ['!', ['has', 'hide_3d']],
  });
  const seen = new Set<string>();
  const result: Footprint[] = [];
  for (const feature of features) {
    const height = Number(feature.properties?.render_height) || 0;
    if (height <= 0) continue;
    const minHeight = Math.min(Number(feature.properties?.render_min_height) || 0, height);
    const geometry = feature.geometry;
    const polygons =
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
    for (const polygon of polygons) {
      const outer = polygon[0]; // les cours intérieures sont ignorées : le bâtiment les ombrage presque toujours
      if (!outer || outer.length < 4) continue;
      const n = outer.length - 1; // le dernier point répète le premier
      const ring = new Float64Array(n * 2);
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < n; i++) {
        const [lng, lat] = outer[i] as [number, number];
        const m = MercatorCoordinate.fromLngLat({ lng, lat });
        ring[i * 2] = m.x;
        ring[i * 2 + 1] = m.y;
        if (m.x < minX) minX = m.x;
        if (m.x > maxX) maxX = m.x;
        if (m.y < minY) minY = m.y;
        if (m.y > maxY) maxY = m.y;
      }
      // Un bâtiment à cheval sur deux tuiles de zooms différents peut sortir deux fois : une seule.
      const key = `${height}|${ring[0]}|${ring[1]}|${n}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Sens positif pour tous les contours : le remplissage « non nul » fait alors l'union.
      if (signedArea(ring) < 0) reverseRing(ring);
      result.push({ ring, height, minHeight, minX, minY, maxX, maxY });
    }
  }
  footprints = result;
  footprintsStale = false;
}

function signedArea(ring: Float64Array): number {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += ring[i * 2]! * ring[j * 2 + 1]! - ring[j * 2]! * ring[i * 2 + 1]!;
  }
  return sum;
}

function reverseRing(ring: Float64Array): void {
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < j; i++, j--) {
    const x = ring[i * 2]!;
    const y = ring[i * 2 + 1]!;
    ring[i * 2] = ring[j * 2]!;
    ring[i * 2 + 1] = ring[j * 2 + 1]!;
    ring[j * 2] = x;
    ring[j * 2 + 1] = y;
  }
}

// --- Dessin ---

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Dessine les ombres de tous les bâtiments dans le canvas, pour un soleil donné. Renvoie leur nombre. */
function drawShadows(f: Frame, azimuth: number, elevation: number): number {
  const ctx = shadowCanvas().getContext('2d');
  if (!ctx) return 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, SIZE, SIZE);

  // Mètres → unités Mercator, à la latitude du centre.
  const lat = new MercatorCoordinate(f.cx, f.cy, 0).toLngLat().lat;
  const metre = MercatorCoordinate.fromLngLat({ lng: 0, lat }, 1).z;
  // Longueur d'ombre par mètre de hauteur, et direction (opposée au soleil) en x est / y sud.
  const perMetre = metre / Math.tan(Math.max(elevation, MIN_ELEVATION_FOR_LENGTH) * DEG);
  const dirX = -Math.sin(azimuth * DEG);
  const dirY = Math.cos(azimuth * DEG);

  // Mercator → pixels du canvas (rotation par le cap, échelle, centrage).
  const k = SIZE / f.side;
  const cb = Math.cos(f.bearing);
  const sb = Math.sin(f.bearing);
  const toU = (x: number, y: number) => k * ((x - f.cx) * cb + (y - f.cy) * sb) + SIZE / 2;
  const toV = (x: number, y: number) => k * (-(x - f.cx) * sb + (y - f.cy) * cb) + SIZE / 2;

  // Un bâtiment dont l'emprise (ombre comprise) sort du canvas est ignoré.
  const half = f.side * 0.71; // demi-diagonale du carré
  let count = 0;
  ctx.fillStyle = SHADOW_COLOR;
  for (const b of footprints) {
    const reach = b.height * perMetre;
    const bx = (b.minX + b.maxX) / 2;
    const by = (b.minY + b.maxY) / 2;
    if (Math.hypot(bx - f.cx, by - f.cy) - reach - Math.hypot(b.maxX - b.minX, b.maxY - b.minY) > half) continue;

    // Un remplissage par bâtiment : un seul chemin géant pour toute la ville prend plusieurs secondes à tracer.
    ctx.beginPath();
    const d0x = dirX * b.minHeight * perMetre;
    const d0y = dirY * b.minHeight * perMetre;
    const d1x = dirX * b.height * perMetre;
    const d1y = dirY * b.height * perMetre;
    const ring = b.ring;
    const n = ring.length / 2;

    // Toit décalé, et base (le sol sous le bâtiment, ou le dessous d'un surplomb).
    for (const [ox, oy] of [
      [d1x, d1y],
      [d0x, d0y],
    ] as const) {
      ctx.moveTo(toU(ring[0]! + ox, ring[1]! + oy), toV(ring[0]! + ox, ring[1]! + oy));
      for (let i = 1; i < n; i++) {
        const x = ring[i * 2]! + ox;
        const y = ring[i * 2 + 1]! + oy;
        ctx.lineTo(toU(x, y), toV(x, y));
      }
      ctx.closePath();
    }

    // Les murs : chaque arête balayée de la base au toit forme un parallélogramme.
    const ex0 = d1x - d0x;
    const ey0 = d1y - d0y;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const px = ring[i * 2]!;
      const py = ring[i * 2 + 1]!;
      const qx = ring[j * 2]!;
      const qy = ring[j * 2 + 1]!;
      const cross = (qx - px) * ey0 - (qy - py) * ex0;
      if (Math.abs(cross) < 1e-18) continue; // arête parallèle au soleil : rien à balayer
      const ax = px + d0x;
      const ay = py + d0y;
      const bx2 = qx + d0x;
      const by2 = qy + d0y;
      const cx2 = qx + d1x;
      const cy2 = qy + d1y;
      const dx2 = px + d1x;
      const dy2 = py + d1y;
      ctx.moveTo(toU(ax, ay), toV(ax, ay));
      if (cross > 0) {
        ctx.lineTo(toU(bx2, by2), toV(bx2, by2));
        ctx.lineTo(toU(cx2, cy2), toV(cx2, cy2));
        ctx.lineTo(toU(dx2, dy2), toV(dx2, dy2));
      } else {
        ctx.lineTo(toU(dx2, dy2), toV(dx2, dy2));
        ctx.lineTo(toU(cx2, cy2), toV(cx2, cy2));
        ctx.lineTo(toU(bx2, by2), toV(bx2, by2));
      }
      ctx.closePath();
    }
    ctx.fill('nonzero');
    count++;
  }
  return count;
}

/** Opacité des ombres selon la hauteur du soleil : nulle la nuit, pleine en journée, estompée à l'aube et au crépuscule. */
function opacityFor(elevation: number): number {
  return MAX_OPACITY * smoothstep(clamp01(elevation / FULL_SHADOW_ELEVATION));
}

// --- Mise à jour ---

function refresh(map: MapLibreMap, time: number, { force = false }: { force?: boolean } = {}): void {
  const source = map.getSource(SOURCE_ID) as CanvasSource | undefined;
  if (!source || !map.getLayer(LAYER_ID)) return;

  const center = map.getCenter();
  const { elevation, azimuth } = sunPosition(center.lat, center.lng, time);
  lastElevation = elevation;
  const visible = map.getZoom() >= MIN_ZOOM && elevation > 0;
  if (visible !== lastVisible) {
    lastVisible = visible;
    map.setLayoutProperty(LAYER_ID, 'visibility', visible ? 'visible' : 'none');
  }
  if (!visible) return;

  const opacity = opacityFor(elevation);
  if (Math.abs(opacity - lastOpacity) > 0.002) {
    lastOpacity = opacity;
    // Fondu à l'apparition entre le zoom 14 et 14,8 (le zoom d'une expression doit être l'entrée de l'interpolation).
    map.setPaintProperty(LAYER_ID, 'raster-opacity', [
      'interpolate',
      ['linear'],
      ['zoom'],
      MIN_ZOOM,
      0,
      FULL_ZOOM,
      opacity,
    ]);
  }

  const now = performance.now();
  if (!force && now - lastDraw < MIN_REDRAW_INTERVAL_MS) return;
  lastDraw = now;

  const moved = frameIsStale(map);
  if (moved) frame = currentFrame(map);
  if (moved || footprintsStale) extractFootprints(map);
  if (!frame) return;

  drawnCount = drawShadows(frame, azimuth, elevation);
  pushCanvas(map, source);
  // Avec le relief, MapLibre ne redessine un raster que si la source change de « révision ».
  source.setCoordinates(frameCoordinates(frame));
}

export const buildingShadows = defineModule<undefined>({
  id: 'ombres-batiments',
  name: 'Ombres des bâtiments',
  category: 'ciel',
  description: 'L’ombre portée des bâtiments selon la position du soleil : longue le matin et le soir, courte à midi, absente la nuit.',
  attribution: '© OpenMapTiles © OpenStreetMap, calcul astronomique',
  // Le soleil avance d'environ 0,25° par minute : une mise à jour toutes les 30 s simulées est invisible.
  timeStepMs: 30_000,
  followsView: true,
  zoomBreaks: [MIN_ZOOM],

  summary() {
    if (!frame || lastVisible === undefined) return null;
    if (lastElevation <= 0) return 'Soleil sous l’horizon : pas d’ombre';
    if (!lastVisible) return `Visible à partir du zoom ${MIN_ZOOM}`;
    return `Soleil à ${Math.round(lastElevation)}° · ${drawnCount} bâtiments`;
  },

  native: {
    add(map) {
      footprints = [];
      frame = undefined;
      footprintsStale = true;
      lastOpacity = -1;
      lastVisible = undefined;
      map.addSource(SOURCE_ID, {
        type: 'canvas',
        canvas: shadowCanvas(),
        coordinates: frameCoordinates(currentFrame(map)),
        animate: false,
      });
      // Sous les bâtiments 3D : ils masquent l'ombre derrière eux grâce au tampon de profondeur.
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'raster',
          source: SOURCE_ID,
          minzoom: MIN_ZOOM,
          layout: { visibility: 'none' },
          paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear', 'raster-opacity': 0 },
        },
        map.getLayer('building-3d') ? 'building-3d' : firstSymbolLayerId(map),
      );

      // Des tuiles de bâtiments arrivent (déplacement, zoom) : on relit les empreintes, sans se presser.
      let tilesTimer: ReturnType<typeof setTimeout> | undefined;
      const onSourceData = (event: { sourceId?: string; tile?: unknown }) => {
        if (event.sourceId !== VECTOR_SOURCE || !event.tile || map.getZoom() < MIN_ZOOM) return;
        footprintsStale = true;
        clearTimeout(tilesTimer);
        tilesTimer = setTimeout(() => refresh(map, clock.now(), { force: true }), 300);
      };
      // En fin de mouvement, et pendant le mouvement si l'on s'approche du bord du canvas.
      const onMoveEnd = () => {
        if (map.getZoom() >= MIN_ZOOM && frameIsStale(map)) refresh(map, clock.now(), { force: true });
      };
      const onMove = () => {
        if (map.getZoom() >= MIN_ZOOM && frameIsStale(map)) refresh(map, clock.now());
      };
      map.on('sourcedata', onSourceData);
      map.on('moveend', onMoveEnd);
      map.on('move', onMove);
      cleanup = () => {
        clearTimeout(tilesTimer);
        map.off('sourcedata', onSourceData);
        map.off('moveend', onMoveEnd);
        map.off('move', onMove);
      };
    },
    update(map, { time }) {
      refresh(map, time, { force: true });
    },
    remove(map) {
      cleanup?.();
      cleanup = undefined;
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      footprints = [];
      frame = undefined;
    },
  },
});
