/**
 * Pictogrammes des véhicules de transport urbain, dessinés une fois dans un canvas
 * (« atlas ») que deck.gl découpe. Le mode se lit à la **forme**, jamais à la couleur seule :
 * - `bus` : rond ;
 * - `tram` : carré arrondi ;
 * - `metro` : losange ;
 * - `other` : triangle (train, bateau, câble : rares).
 *
 * Chaque forme existe en trois versions blanches, teintées à l'affichage (`mask: true`) :
 * `<forme>-fill` (le corps, de la couleur de la ligne) et `<forme>-halo` (la même forme grossie,
 * en blanc ou en sombre selon la couleur du corps) : le contour garde lisible une couleur
 * officielle claire sur fond clair, ou sombre sur fond sombre. `<forme>-halo-est` est ce même
 * contour en **pointillé**, pour les véhicules dont la position est estimée d'après les horaires
 * et non mesurée : même couleur, même forme, seul le contour change.
 */
import type { IconLayerProps } from '@deck.gl/layers';

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

export type Kind = 'bus' | 'tram' | 'metro' | 'other';
export const KINDS: readonly Kind[] = ['bus', 'tram', 'metro', 'other'];

const SIZE = 64;
const GAP = 4;
/** Épaisseur ajoutée de chaque côté par le contour, dans l'atlas (sur 64). */
const HALO = 6;
/** Contour pointillé : plus épais (il perd la moitié de sa surface en tirets) ; tirets et vides en unités de l'atlas (sur 64). */
const HALO_DASHED = 7;
const DASH: [number, number] = [11, 8];
const OUTLINE_DARK = '#161a26';

function path(ctx: CanvasRenderingContext2D, kind: Kind): void {
  ctx.beginPath();
  switch (kind) {
    case 'bus':
      ctx.arc(32, 32, 21, 0, Math.PI * 2);
      break;
    case 'tram':
      ctx.roundRect(11, 11, 42, 42, 9);
      break;
    case 'metro':
      ctx.moveTo(32, 4);
      ctx.lineTo(60, 32);
      ctx.lineTo(32, 60);
      ctx.lineTo(4, 32);
      ctx.closePath();
      break;
    case 'other':
      ctx.moveTo(32, 8);
      ctx.lineTo(58, 54);
      ctx.lineTo(6, 54);
      ctx.closePath();
      break;
  }
}

function drawBody(ctx: CanvasRenderingContext2D, kind: Kind, color: string): void {
  ctx.fillStyle = color;
  path(ctx, kind);
  ctx.fill();
}

function drawHalo(ctx: CanvasRenderingContext2D, kind: Kind, color: string): void {
  ctx.lineJoin = 'round';
  ctx.lineWidth = HALO * 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  path(ctx, kind);
  ctx.stroke();
  ctx.fill();
}

/** Contour pointillé : seul l'anneau extérieur du corps est dessiné, en tirets ; le corps le recouvre en dedans. */
function drawDashedHalo(ctx: CanvasRenderingContext2D, kind: Kind, color: string): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.lineWidth = HALO_DASHED * 2;
  ctx.setLineDash(DASH);
  ctx.strokeStyle = color;
  path(ctx, kind);
  ctx.stroke();
  ctx.setLineDash([]);
}

export interface TransitAtlas {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
}

export function buildTransitAtlas(): TransitAtlas {
  const names = KINDS.flatMap((kind) => [`${kind}-halo`, `${kind}-halo-est`, `${kind}-fill`] as const);
  const canvas = document.createElement('canvas');
  canvas.width = names.length * (SIZE + GAP);
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const mapping: IconMapping = {};
  names.forEach((name, i) => {
    const x = i * (SIZE + GAP);
    if (ctx) {
      ctx.save();
      ctx.translate(x, 0);
      const kind = name.split('-')[0] as Kind;
      if (name.endsWith('halo-est')) drawDashedHalo(ctx, kind, '#ffffff');
      else if (name.endsWith('halo')) drawHalo(ctx, kind, '#ffffff');
      else drawBody(ctx, kind, '#ffffff');
      ctx.restore();
    }
    mapping[name] = { x, y: 0, width: SIZE, height: SIZE, anchorX: SIZE / 2, anchorY: SIZE / 2, mask: true };
  });
  return { atlas: canvas.toDataURL(), mapping };
}

/** Pictogramme pour la légende : corps coloré et contour, comme sur la carte. */
export function legendIcon(kind: Kind, color: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  drawHalo(ctx, kind, OUTLINE_DARK);
  drawBody(ctx, kind, color);
  return canvas.toDataURL();
}

/** Pictogramme pour la légende d'une position estimée : le même, avec le contour pointillé. */
export function estimatedLegendIcon(kind: Kind, color: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  drawDashedHalo(ctx, kind, OUTLINE_DARK);
  drawBody(ctx, kind, color);
  return canvas.toDataURL();
}

/** Rond de la vue d'ensemble pour la légende : un réseau, taille selon son nombre de véhicules. */
export function bubbleIcon(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.beginPath();
  ctx.arc(16, 16, 13, 0, Math.PI * 2);
  ctx.fillStyle = '#e8ecf4';
  ctx.fill();
  ctx.strokeStyle = OUTLINE_DARK;
  ctx.lineWidth = 3;
  ctx.stroke();
  return canvas.toDataURL();
}
