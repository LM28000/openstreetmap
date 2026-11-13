/**
 * Silhouettes des véhicules de transport urbain, vues de dessus, dessinées une fois dans un canvas
 * (« atlas ») que deck.gl découpe. Tracés de la planche de symboles validée : le mode se lit à la
 * **forme** et à la longueur, jamais à la couleur seule :
 * - `bus` : une caisse de 12 m ;
 * - `tram` : une rame articulée de trois éléments ;
 * - `metro` : trois voitures accouplées ;
 * - `other` : deux éléments articulés (train, bateau, câble : rares ; le flux ne dit pas qu'un bus est
 *   articulé, la silhouette du bus articulé de la planche sert donc à ces modes-là).
 *
 * La proue est en haut de l'image (cap 0 = nord). Toutes les cellules ont la même échelle (un
 * véhicule de N unités fait N × 5 px) et la même hauteur : une seule taille d'icône sur la carte
 * suffit, et un tram est deux fois plus long qu'un bus à l'écran comme dans la rue.
 *
 * Chaque silhouette existe en trois versions blanches, teintées à l'affichage (`mask: true`) :
 * `<forme>-fill` (le corps, de la couleur de la ligne ; un trait de pare-brise y est ajouré, ce qui
 * montre l'avant) et `<forme>-halo` (la même forme grossie, en blanc ou en sombre selon la couleur
 * du corps) : le contour garde lisible une couleur officielle claire sur fond clair, ou sombre sur
 * fond sombre. `<forme>-halo-est` est ce même contour en **pointillé**, pour les véhicules dont la
 * position est estimée d'après les horaires et non mesurée : même couleur, même forme, seul le
 * contour change.
 */
import { STATUS } from '../design/tokens';
import type { IconLayerProps } from '@deck.gl/layers';

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

export type Kind = 'bus' | 'tram' | 'metro' | 'other';
export const KINDS: readonly Kind[] = ['bus', 'tram', 'metro', 'other'];

/** Pixels de l'atlas par unité de la planche (la caisse d'un bus fait 20 unités de long sur 10 de large). */
const K = 5;
const BODY_WIDTH = 10 * K;
const GAP = 2 * K;
const SEGMENTS: Record<Kind, number[]> = { bus: [20], other: [13, 11], tram: [14, 12, 14], metro: [12, 12, 12] };
/** Longueur d'une unité sur le terrain (mètres) : un bus fait 13 m, une rame de tram 29 m. */
const METERS_PER_UNIT = 0.65;
export const CELL_WIDTH = 96;
export const CELL_HEIGHT = 256;
const CELL_GAP = 4;
/** Hauteur d'une cellule sur le terrain (mètres) : la taille d'icône à donner à deck.gl. */
export const CELL_METERS = (CELL_HEIGHT / K) * METERS_PER_UNIT;

/** Longueur d'un véhicule (unités de la planche), avec ses intervalles. */
export const lengthUnits = (kind: Kind) => SEGMENTS[kind].reduce((a, b) => a + b, 0) + 2 * (SEGMENTS[kind].length - 1);
/** Longueur d'un véhicule rapportée à la hauteur d'une cellule. */
export const lengthShare = (kind: Kind) => (lengthUnits(kind) * K) / CELL_HEIGHT;

/** Épaisseur du contour autour du corps, dans l'atlas. */
const HALO = 10;
/** Contour pointillé : plus épais (il perd la moitié de sa surface en tirets) ; tirets et vides en pixels de l'atlas. */
const HALO_DASHED = 11;
const DASH: [number, number] = [16, 12];
const OUTLINE_DARK = STATUS.ink;

/** Les éléments du véhicule, centrés sur l'origine, avant en haut. */
function path(ctx: CanvasRenderingContext2D, kind: Kind): void {
  const segments = SEGMENTS[kind];
  const w = BODY_WIDTH;
  const total = segments.reduce((a, b) => a + b * K, 0) + GAP * (segments.length - 1);
  let y = -total / 2;
  ctx.beginPath();
  segments.forEach((units, i) => {
    const length = units * K;
    // L'avant est arrondi, l'arrière du dernier élément un peu moins carré que les jonctions.
    const radius =
      segments.length === 1
        ? [w * 0.5, w * 0.5, w * 0.4, w * 0.4]
        : i === 0
          ? [w * 0.5, w * 0.5, w * 0.22, w * 0.22]
          : i === segments.length - 1
            ? [w * 0.22, w * 0.22, w * 0.4, w * 0.4]
            : w * 0.22;
    ctx.roundRect(-w / 2, y, w, length, radius);
    y += length + GAP;
  });
}

/** Pare-brise : un trait près de l'avant, sur le premier élément. */
function windscreen(ctx: CanvasRenderingContext2D, kind: Kind): void {
  const segments = SEGMENTS[kind];
  const total = segments.reduce((a, b) => a + b * K, 0) + GAP * (segments.length - 1);
  const y = -total / 2 + BODY_WIDTH * 0.36;
  ctx.lineCap = 'round';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(-BODY_WIDTH * 0.28, y);
  ctx.lineTo(BODY_WIDTH * 0.28, y);
  ctx.stroke();
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

/** Contour pointillé : l'anneau extérieur du corps en tirets ; le corps le recouvre en dedans. */
function drawDashedHalo(ctx: CanvasRenderingContext2D, kind: Kind, color: string): void {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.lineWidth = HALO_DASHED * 2;
  ctx.setLineDash(DASH);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  path(ctx, kind);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fill();
}

export interface TransitAtlas {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
}

export function buildTransitAtlas(): TransitAtlas {
  const names = KINDS.flatMap((kind) => [`${kind}-halo`, `${kind}-halo-est`, `${kind}-fill`] as const);
  const canvas = document.createElement('canvas');
  canvas.width = names.length * (CELL_WIDTH + CELL_GAP);
  canvas.height = CELL_HEIGHT;
  const ctx = canvas.getContext('2d');
  const mapping: IconMapping = {};
  names.forEach((name, i) => {
    const x = i * (CELL_WIDTH + CELL_GAP);
    if (ctx) {
      ctx.save();
      ctx.translate(x + CELL_WIDTH / 2, CELL_HEIGHT / 2);
      const kind = name.split('-')[0] as Kind;
      if (name.endsWith('halo-est')) drawDashedHalo(ctx, kind, '#ffffff');
      else if (name.endsWith('halo')) drawHalo(ctx, kind, '#ffffff');
      else {
        drawBody(ctx, kind, '#ffffff');
        // Le pare-brise est ajouré : le contour dessous (clair ou sombre) y apparaît à moitié.
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        windscreen(ctx, kind);
      }
      ctx.restore();
    }
    mapping[name] = { x, y: 0, width: CELL_WIDTH, height: CELL_HEIGHT, anchorX: CELL_WIDTH / 2, anchorY: CELL_HEIGHT / 2, mask: true };
  });
  return { atlas: canvas.toDataURL(), mapping };
}

/** Légende (36 x 14 px affichés, dessinée en 4x) : le véhicule couché, avant à droite, corps coloré et contour. */
function legendCanvas(kind: Kind, color: string, dashed: boolean): string {
  const canvas = document.createElement('canvas');
  canvas.width = 144;
  canvas.height = 56;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.translate(72, 28);
  ctx.rotate(Math.PI / 2);
  ctx.scale(0.5, 0.5);
  if (dashed) drawDashedHalo(ctx, kind, OUTLINE_DARK);
  else drawHalo(ctx, kind, OUTLINE_DARK);
  drawBody(ctx, kind, color);
  ctx.strokeStyle = 'rgba(22,26,38,0.55)';
  windscreen(ctx, kind);
  return canvas.toDataURL();
}

/** Pictogramme pour la légende : corps coloré et contour, comme sur la carte. */
export const legendIcon = (kind: Kind, color: string) => legendCanvas(kind, color, false);

/** Pictogramme pour la légende d'une position estimée : le même, avec le contour pointillé. */
export const estimatedLegendIcon = (kind: Kind, color: string) => legendCanvas(kind, color, true);

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

/**
 * Empreinte au sol des maquettes 3D (voir models/transit.ts) : un rectangle arrondi pointillé, aux
 * cotes réelles du véhicule (un peu agrandies), posé sous la maquette d'une position estimée. Même
 * échelle pour toutes les cellules (10 px par mètre), donc une seule taille d'icône pour tous les modes.
 */
const FOOT_PX_PER_M = 10;
const FOOT_CELL_W = 60;
const FOOT_CELL_H = 460;
/** Hauteur d'une cellule d'empreinte sur le terrain (mètres) : la taille d'icône de base. */
export const FOOT_CELL_METERS = FOOT_CELL_H / FOOT_PX_PER_M;
const FOOT_WIDTH_M: Record<Kind, number> = { bus: 2.55, other: 2.55, tram: 2.4, metro: 2.45 };

export function buildFootprintAtlas(lengths: Record<Kind, number>): TransitAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = KINDS.length * (FOOT_CELL_W + CELL_GAP);
  canvas.height = FOOT_CELL_H;
  const ctx = canvas.getContext('2d');
  const mapping: IconMapping = {};
  KINDS.forEach((kind, i) => {
    const x = i * (FOOT_CELL_W + CELL_GAP);
    if (ctx) {
      const w = (FOOT_WIDTH_M[kind] + 0.9) * FOOT_PX_PER_M;
      const l = (lengths[kind] + 0.9) * FOOT_PX_PER_M;
      ctx.save();
      ctx.translate(x + FOOT_CELL_W / 2, FOOT_CELL_H / 2);
      ctx.beginPath();
      ctx.roundRect(-w / 2, -l / 2, w, l, w * 0.45);
      // Un voile léger sous le trait : la tache se lit même quand la maquette la recouvre presque.
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'butt';
      ctx.lineWidth = 5;
      ctx.setLineDash([22, 14]);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.restore();
    }
    mapping[kind] = { x, y: 0, width: FOOT_CELL_W, height: FOOT_CELL_H, anchorX: FOOT_CELL_W / 2, anchorY: FOOT_CELL_H / 2, mask: true };
  });
  return { atlas: canvas.toDataURL(), mapping };
}
