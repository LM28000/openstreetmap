/**
 * Icônes d'avion vues de dessus, dessinées une seule fois dans un canvas
 * (« atlas ») que deck.gl découpe ensuite, comme pour les trains.
 *
 * Chaque appareil pointe vers l'est (la droite) ; deck.gl le fait tourner selon son cap.
 * Trois silhouettes (la forme dit le genre d'appareil, la couleur dit l'altitude) :
 * - `jet` : ailes en flèche (avion de ligne, jet d'affaires) ;
 * - `light` : aile droite et empennage (avion à hélice, planeur, avion léger) ;
 * - `heli` : fuselage court, poutre de queue et disque du rotor.
 */
import type { IconLayerProps } from '@deck.gl/layers';

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

export type Shape = 'jet' | 'light' | 'heli';

export interface PlaneIconSpec {
  key: string;
  shape: Shape;
  color: string;
}

/** Côté d'une icône dans l'atlas (carrée) : deck.gl met cette hauteur à l'échelle. */
export const ICON_SIZE = 64;
const OUTLINE = '#161a26';
const GAP = 4;

/** Moitié haute du contour d'un jet (du nez à la queue), le bas en est le reflet. */
const JET_HALF: ReadonlyArray<readonly [number, number]> = [
  [61, 32],
  [57, 30],
  [47, 29],
  [41, 28.5],
  [24, 4],
  [16, 4],
  [22, 29.5],
  [13, 29],
  [7, 19],
  [3, 19],
  [5, 30],
  [3, 32],
];

function jetPath(ctx: CanvasRenderingContext2D): void {
  const mirrored = [...JET_HALF].reverse().map(([x, y]) => [x, 64 - y] as const);
  ctx.beginPath();
  JET_HALF.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  for (const [x, y] of mirrored) ctx.lineTo(x, y);
  ctx.closePath();
}

function lightPath(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  // Fuselage.
  ctx.roundRect(6, 28, 52, 8, 4);
  // Aile, puis empennage.
  ctx.roundRect(25, 6, 11, 52, 2);
  ctx.roundRect(5, 21, 8, 22, 2);
}

function drawJetOrLight(ctx: CanvasRenderingContext2D, shape: 'jet' | 'light', color: string): void {
  const path = shape === 'jet' ? jetPath : lightPath;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5;
  path(ctx);
  ctx.stroke();
  ctx.fillStyle = color;
  path(ctx);
  ctx.fill(); // un seul tracé : le contour entoure l'assemblage, pas chaque pièce
}

function drawHeli(ctx: CanvasRenderingContext2D, color: string): void {
  const cx = 38;
  const cy = 32;
  // Disque du rotor : un anneau léger, pour le reconnaître même très petit.
  ctx.beginPath();
  ctx.arc(cx, cy, 25, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.fill();
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  const body = () => {
    ctx.beginPath();
    ctx.ellipse(cx + 4, cy, 14, 8, 0, 0, Math.PI * 2); // cabine
    ctx.moveTo(cx - 8, cy - 2);
    ctx.lineTo(3, cy - 1.5);
    ctx.lineTo(3, cy + 1.5);
    ctx.lineTo(cx - 8, cy + 2);
    ctx.closePath(); // poutre de queue
  };
  ctx.lineJoin = 'round';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 5;
  body();
  ctx.stroke();
  ctx.fillStyle = color;
  body();
  ctx.fill();
  // Pales.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - 22, cy - 11);
  ctx.lineTo(cx + 22, cy + 11);
  ctx.moveTo(cx - 22, cy + 11);
  ctx.lineTo(cx + 22, cy - 11);
  ctx.stroke();
}

function drawPlane(ctx: CanvasRenderingContext2D, { shape, color }: PlaneIconSpec): void {
  if (shape === 'heli') drawHeli(ctx, color);
  else drawJetOrLight(ctx, shape, color);
}

export interface PlaneAtlas {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
  /** Image d'une icône (pour la légende). */
  dataUrl(key: string): string | undefined;
}

export function buildPlaneAtlas(specs: readonly PlaneIconSpec[]): PlaneAtlas {
  const atlas = document.createElement('canvas');
  atlas.width = specs.length * (ICON_SIZE + GAP);
  atlas.height = ICON_SIZE;
  const ctx = atlas.getContext('2d');
  const mapping: IconMapping = {};
  const urls = new Map<string, string>();
  let x = 0;

  for (const spec of specs) {
    if (ctx) {
      ctx.save();
      ctx.translate(x, 0);
      drawPlane(ctx, spec);
      ctx.restore();
    }
    // Ancre au centre : la position de l'avion est celle de son centre.
    mapping[spec.key] = { x, y: 0, width: ICON_SIZE, height: ICON_SIZE, anchorX: ICON_SIZE / 2, anchorY: ICON_SIZE / 2, mask: false };

    const single = document.createElement('canvas');
    single.width = ICON_SIZE;
    single.height = ICON_SIZE;
    const singleCtx = single.getContext('2d');
    if (singleCtx) {
      drawPlane(singleCtx, spec);
      urls.set(spec.key, single.toDataURL());
    }
    x += ICON_SIZE + GAP;
  }
  return { atlas: atlas.toDataURL(), mapping, dataUrl: (key) => urls.get(key) };
}

/** Anneau d'urgence en data URL (légende) : même tracé que l'anneau dessiné sur la carte. */
export function ringDataUrl(color: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.beginPath();
  ctx.arc(16, 16, 11, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 4;
  ctx.stroke();
  return canvas.toDataURL();
}
