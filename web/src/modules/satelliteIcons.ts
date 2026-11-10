/**
 * Silhouettes de satellite vues de dessus, dessinées une seule fois dans un canvas (« atlas »)
 * que deck.gl découpe ensuite (une `IconLayer`).
 *
 * Quatre silhouettes neutres (blanc et gris, panneaux bleu nuit), reprises de la planche de
 * symboles validée : la station (ISS, Tiangong) et ses grands panneaux, le satellite de
 * navigation et ses deux ailes, le satellite météo et son antenne, et les autres satellites
 * brillants. Les satellites ne reprennent aucune couleur de train : seule la forme dit la famille.
 *
 * Le tracé est celui de la planche, dessiné avec ses traits fins puis réduit à la taille
 * d'affichage : le contour sombre et le halo clair gardent ainsi l'épaisseur validée, et
 * l'atlas reste net sur un écran à haute densité.
 */
import type { IconLayerProps } from '@deck.gl/layers';

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

export type Family = 'station' | 'nav' | 'weather' | 'bright';

export const FAMILY_ORDER: readonly Family[] = ['station', 'nav', 'weather', 'bright'];

/** Côté d'une icône dans l'atlas (carrée), en pixels. */
const CELL = 192;
/** Marge autour de la silhouette dans la case, en unités de tracé (contour et halo). */
const MARGIN = 4;
const KEY = '#141a26';
const HALO = 'rgba(255,255,255,0.93)';
const DECK = '#f2f4f8';
const PANEL = '#2b3b63';
/**
 * Pixels de tracé par pixel CSS : plus c'est grand, plus le trait est fin à l'écran. 1,7 donne
 * un contour d'environ 0,8 pixel CSS (1,6 sur un écran à double densité).
 */
const LINE_REF = 1.7;

/** Pixels CSS par unité de la planche, et demi-largeur de la silhouette en unités de la planche. */
const LOOK: Record<Family, { cssPerUnit: number; halfExtent: number }> = {
  station: { cssPerUnit: 1.05, halfExtent: 25 },
  nav: { cssPerUnit: 0.72, halfExtent: 25 },
  weather: { cssPerUnit: 0.72, halfExtent: 25 },
  bright: { cssPerUnit: 0.72, halfExtent: 17.5 },
};

/** Facteur d'agrandissement du tracé pour remplir une case de l'atlas. */
function drawScale(family: Family): number {
  const { cssPerUnit, halfExtent } = LOOK[family];
  return CELL / 2 / (halfExtent * cssPerUnit * LINE_REF + MARGIN);
}

/** Taille d'affichage d'une icône : côté de la case en pixels CSS, et rayon qui enveloppe la silhouette (anneau de sélection). */
export function satelliteSizing(family: Family): { cellPx: number; radiusPx: number } {
  const { cssPerUnit, halfExtent } = LOOK[family];
  return { cellPx: CELL / (drawScale(family) * LINE_REF), radiusPx: halfExtent * cssPerUnit };
}

// --- Tracé (celui de la planche) ---

type Path = (ctx: CanvasRenderingContext2D) => void;

/** Halo clair, puis remplissage, puis contour sombre. */
function ink(ctx: CanvasRenderingContext2D, path: Path, fill: string, key: number, halo: number): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  path(ctx);
  ctx.strokeStyle = HALO;
  ctx.lineWidth = key + halo * 2;
  ctx.stroke();
  path(ctx);
  ctx.fillStyle = fill;
  ctx.fill();
  path(ctx);
  ctx.strokeStyle = KEY;
  ctx.lineWidth = key;
  ctx.stroke();
  ctx.restore();
}

const rect = (x: number, y: number, w: number, h: number, r = 0): Path => (ctx) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ink(ctx, rect(x, y, w, h, 1), PANEL, 1.4, 1.8);
  ctx.strokeStyle = 'rgba(160,190,255,0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < 4; i++) {
    ctx.moveTo(x + (w * i) / 4, y + 1);
    ctx.lineTo(x + (w * i) / 4, y + h - 1);
  }
  ctx.stroke();
}

/** Silhouette centrée sur l'origine ; `s` est le nombre de pixels de tracé par unité de la planche. */
function drawSilhouette(ctx: CanvasRenderingContext2D, family: Family, s: number): void {
  if (family === 'station') {
    for (const px of [-21, -13, 13, 21]) for (const py of [-15, 2.5]) panel(ctx, (px - 3) * s, py * s, 6 * s, 12.5 * s);
    ink(ctx, rect(-25 * s, -1.6 * s, 50 * s, 3.2 * s, 1), DECK, 1.4, 1.8);
    ink(ctx, rect(-2.6 * s, -11 * s, 5.2 * s, 22 * s, 2), DECK, 1.4, 1.8);
    ink(ctx, rect(-7 * s, -3 * s, 14 * s, 6 * s, 2), DECK, 1.4, 1.8);
  } else if (family === 'nav') {
    ctx.strokeStyle = KEY;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-14 * s, 0);
    ctx.lineTo(14 * s, 0);
    ctx.stroke();
    panel(ctx, -25 * s, -4 * s, 13 * s, 8 * s);
    panel(ctx, 12 * s, -4 * s, 13 * s, 8 * s);
    ink(ctx, rect(-6 * s, -6 * s, 12 * s, 12 * s, 2), DECK, 1.5, 2);
  } else if (family === 'weather') {
    panel(ctx, 7 * s, -4 * s, 18 * s, 8 * s);
    ink(ctx, rect(-6 * s, -6 * s, 12 * s, 12 * s, 2), DECK, 1.5, 2);
    ink(
      ctx,
      (c) => {
        c.beginPath();
        c.ellipse(-12 * s, 0, 5 * s, 5 * s, 0, 0, Math.PI * 2);
      },
      DECK,
      1.5,
      2,
    );
    ctx.fillStyle = KEY;
    ctx.beginPath();
    ctx.arc(-12 * s, 0, 1.4 * s, 0, Math.PI * 2);
    ctx.fill();
  } else {
    panel(ctx, -17 * s, -3 * s, 10 * s, 6 * s);
    panel(ctx, 7 * s, -3 * s, 10 * s, 6 * s);
    ink(ctx, rect(-4.5 * s, -4.5 * s, 9 * s, 9 * s, 2), DECK, 1.4, 1.8);
  }
}

/** Une icône centrée dans une case de `CELL` pixels dont le coin haut gauche est l'origine. */
function drawIcon(ctx: CanvasRenderingContext2D, family: Family): void {
  ctx.save();
  ctx.translate(CELL / 2, CELL / 2);
  const k = drawScale(family);
  ctx.scale(k, k);
  drawSilhouette(ctx, family, LOOK[family].cssPerUnit * LINE_REF);
  ctx.restore();
}

export interface SatelliteAtlas {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
  /** Image de légende d'une silhouette (format 36 × 14 de la légende), éventuellement estompée. */
  legend(family: Family, alpha?: number): string;
}

export function buildSatelliteAtlas(): SatelliteAtlas {
  const atlas = document.createElement('canvas');
  atlas.width = FAMILY_ORDER.length * CELL;
  atlas.height = CELL;
  const ctx = atlas.getContext('2d');
  const mapping: IconMapping = {};
  FAMILY_ORDER.forEach((family, i) => {
    const x = i * CELL;
    if (ctx) {
      ctx.save();
      ctx.translate(x, 0);
      drawIcon(ctx, family);
      ctx.restore();
    }
    // Ancre au centre : la position du satellite est celle du centre de son corps.
    mapping[family] = { x, y: 0, width: CELL, height: CELL, anchorX: CELL / 2, anchorY: CELL / 2, mask: false };
  });

  const cache = new Map<string, string>();
  const legend = (family: Family, alpha = 1): string => {
    const key = `${family}:${alpha}`;
    const cached = cache.get(key);
    if (cached) return cached;
    // La légende affiche l'image à 36 × 14 pixels : on la prépare à ce format, en 4×.
    const out = document.createElement('canvas');
    out.width = 144;
    out.height = 56;
    const outCtx = out.getContext('2d');
    if (!outCtx) return '';
    const cell = document.createElement('canvas');
    cell.width = cell.height = CELL;
    const cellCtx = cell.getContext('2d');
    if (!cellCtx) return '';
    drawIcon(cellCtx, family);
    outCtx.globalAlpha = alpha;
    // On découpe la bande de la case qui contient la silhouette (large et peu haute), puis on la loge entière dans l'image.
    const band = family === 'station' ? 0.66 : 0.4;
    const srcH = CELL * band;
    const scale = Math.min(144 / CELL, 56 / srcH);
    outCtx.drawImage(cell, 0, (CELL - srcH) / 2, CELL, srcH, (144 - CELL * scale) / 2, (56 - srcH * scale) / 2, CELL * scale, srcH * scale);
    const url = out.toDataURL();
    cache.set(key, url);
    return url;
  };
  return { atlas: atlas.toDataURL(), mapping, legend };
}
