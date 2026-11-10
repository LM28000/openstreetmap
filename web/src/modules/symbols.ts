/**
 * Trait commun des symboles de la carte (voir la planche des symboles validée) : un
 * halo clair sous un remplissage, cerné d'un contour sombre. Le même liseré rend chaque
 * symbole lisible sur la terre, la mer, le relief et la nuit. Les états (sélection)
 * passent par un anneau blanc et sombre, jamais par une couleur de plus.
 *
 * Ce fichier réunit ce que partagent les trains, les gares et les points fixes : les
 * couleurs du trait, le dessin « halo, remplissage, contour » dans un canvas, le
 * rangement des icônes dans un atlas, et l'anneau de sélection.
 */
import type { Color, Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { IconLayerProps } from '@deck.gl/layers';

/** Contour sombre. */
export const KEY_CSS = '#141a26';
export const KEY: Color = [20, 26, 38, 255];
/** Halo clair. */
export const HALO_CSS = 'rgba(255,255,255,0.93)';
export const HALO: Color = [255, 255, 255, 237];

export interface InkOptions {
  /** Épaisseur du contour sombre, dans l'unité du canvas. */
  key?: number;
  /** Largeur du halo clair de chaque côté du contour. */
  halo?: number;
  noHalo?: boolean;
}

/** Halo clair, puis remplissage, puis contour sombre. `path` commence par `beginPath()`. */
export function ink(
  ctx: CanvasRenderingContext2D,
  path: (ctx: CanvasRenderingContext2D) => void,
  fill: string,
  { key = 2, halo = 2.4, noHalo = false }: InkOptions = {},
): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!noHalo) {
    path(ctx);
    ctx.strokeStyle = HALO_CSS;
    ctx.lineWidth = key + halo * 2;
    ctx.stroke();
  }
  path(ctx);
  ctx.fillStyle = fill;
  ctx.fill();
  path(ctx);
  ctx.strokeStyle = KEY_CSS;
  ctx.lineWidth = key;
  ctx.stroke();
  ctx.restore();
}

// --- Atlas d'icônes ---

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

export interface IconCell {
  key: string;
  width: number;
  height: number;
  /** Dessine l'icône dans une zone qui va de (0, 0) à (width, height). */
  draw(ctx: CanvasRenderingContext2D): void;
}

export interface IconSheet {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
  /** Image d'une icône (pour la légende). */
  dataUrl(key: string): string | undefined;
}

const SHEET_WIDTH = 1024;
const GAP = 2;

/** Range les icônes en lignes dans un seul canvas. Chaque icône est ancrée en son centre. */
export function packIcons(cells: readonly IconCell[]): IconSheet {
  // Disposition : on remplit des lignes de `SHEET_WIDTH` au plus.
  const placed: Array<{ cell: IconCell; x: number; y: number }> = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const cell of cells) {
    if (x + cell.width > SHEET_WIDTH && x > 0) {
      x = 0;
      y += rowHeight + GAP;
      rowHeight = 0;
    }
    placed.push({ cell, x, y });
    x += cell.width + GAP;
    width = Math.max(width, x);
    rowHeight = Math.max(rowHeight, cell.height);
  }
  const atlas = document.createElement('canvas');
  atlas.width = Math.max(1, width);
  atlas.height = Math.max(1, y + rowHeight);
  const ctx = atlas.getContext('2d');
  const mapping: IconMapping = {};
  const urls = new Map<string, string>();

  for (const { cell, x: cx, y: cy } of placed) {
    if (ctx) {
      ctx.save();
      ctx.translate(cx, cy);
      cell.draw(ctx);
      ctx.restore();
    }
    mapping[cell.key] = {
      x: cx,
      y: cy,
      width: cell.width,
      height: cell.height,
      anchorX: cell.width / 2,
      anchorY: cell.height / 2,
      mask: false,
    };
    const single = document.createElement('canvas');
    single.width = cell.width;
    single.height = cell.height;
    const singleCtx = single.getContext('2d');
    if (singleCtx) {
      cell.draw(singleCtx);
      urls.set(cell.key, single.toDataURL());
    }
  }
  return { atlas: atlas.toDataURL(), mapping, dataUrl: (key) => urls.get(key) };
}

// --- Sélection ---

/**
 * Anneau de sélection d'un point : un trait blanc épais sous un trait sombre fin, lisible
 * sur tous les fonds, jamais bleu. `radius` est en pixels.
 */
export function selectionRing<T>(
  id: string,
  data: readonly T[],
  getPosition: (item: T) => [number, number, number],
  radius: number | ((item: T) => number),
  parameters: object,
): Layer[] {
  const common = {
    data,
    getPosition,
    getRadius: radius,
    radiusUnits: 'pixels' as const,
    filled: false,
    stroked: true,
    lineWidthUnits: 'pixels' as const,
    billboard: true,
    parameters,
  };
  return [
    new ScatterplotLayer<T>({ ...common, id: `${id}-blanc`, getLineColor: [255, 255, 255, 245], getLineWidth: 5 }),
    new ScatterplotLayer<T>({ ...common, id: `${id}-sombre`, getLineColor: KEY, getLineWidth: 2 }),
  ];
}

/** Taille d'un symbole selon le zoom : interpolation linéaire entre deux zooms, bornée. */
export function zoomRamp(zoom: number, from: number, to: number, atFrom: number, atTo: number): number {
  const f = Math.min(1, Math.max(0, (zoom - from) / (to - from)));
  return atFrom + (atTo - atFrom) * f;
}
