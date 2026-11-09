/**
 * Icônes de train vues de dessus, dessinées une seule fois dans un canvas
 * (« atlas ») que deck.gl découpe ensuite.
 *
 * Chaque train pointe vers l'est (la droite) ; deck.gl le fait tourner selon son cap.
 * Les dessins sont faits en double résolution pour rester nets.
 */
import type { IconLayerProps } from '@deck.gl/layers';

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

/** Nez profilé (grande vitesse, plus long) ou standard. */
export type Nose = 'profile' | 'standard';

export interface TrainIconSpec {
  key: string;
  color: string;
  nose: Nose;
}

/** Hauteur d'une icône dans l'atlas : c'est cette hauteur que deck.gl met à l'échelle. */
export const ICON_HEIGHT = 40;
const WIDTH: Record<Nose, number> = { profile: 128, standard: 104 };
const OUTLINE = '#161a26';
const GAP = 4;

/** Silhouette du train : queue arrondie, corps, nez. */
function bodyPath(ctx: CanvasRenderingContext2D, nose: Nose): void {
  const width = WIDTH[nose];
  const top = 11;
  const bottom = ICON_HEIGHT - 11;
  const middle = ICON_HEIGHT / 2;
  const left = 5;
  const tip = width - 5;
  const noseStart = nose === 'profile' ? tip - 34 : tip - 12;
  const r = 6;

  ctx.beginPath();
  ctx.moveTo(left + r, top);
  ctx.lineTo(noseStart, top);
  if (nose === 'profile') {
    ctx.bezierCurveTo(noseStart + 22, top, tip, middle - 5, tip, middle);
    ctx.bezierCurveTo(tip, middle + 5, noseStart + 22, bottom, noseStart, bottom);
  } else {
    ctx.quadraticCurveTo(tip, top, tip, middle);
    ctx.quadraticCurveTo(tip, bottom, noseStart, bottom);
  }
  ctx.lineTo(left + r, bottom);
  ctx.arcTo(left, bottom, left, bottom - r, r);
  ctx.lineTo(left, top + r);
  ctx.arcTo(left, top, left + r, top, r);
  ctx.closePath();
}

function drawTrain(ctx: CanvasRenderingContext2D, { color, nose }: TrainIconSpec): void {
  const width = WIDTH[nose];
  const middle = ICON_HEIGHT / 2;

  // Corps, avec un contour sombre pour rester lisible sur fond clair comme sur la carte de nuit.
  bodyPath(ctx, nose);
  ctx.fillStyle = color;
  ctx.fill();

  // Détails, limités à l'intérieur du corps.
  ctx.save();
  bodyPath(ctx, nose);
  ctx.clip();
  // Reflet du toit.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.fillRect(0, 13, width, 4);
  // Séparations entre voitures.
  ctx.strokeStyle = 'rgba(22, 26, 38, 0.55)';
  ctx.lineWidth = 2;
  const carEnd = nose === 'profile' ? width - 40 : width - 18;
  for (let x = 32; x < carEnd - 8; x += 24) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ICON_HEIGHT);
    ctx.stroke();
  }
  // Pare-brise.
  ctx.fillStyle = 'rgba(22, 26, 38, 0.75)';
  ctx.beginPath();
  if (nose === 'profile') {
    ctx.ellipse(width - 22, middle, 8, 5.5, 0, 0, Math.PI * 2);
  } else {
    ctx.roundRect(width - 15, middle - 6, 5, 12, 2);
  }
  ctx.fill();
  ctx.restore();

  bodyPath(ctx, nose);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

export interface TrainAtlas {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
  /** Image d'une icône (pour la légende). */
  dataUrl(key: string): string | undefined;
}

export function buildTrainAtlas(specs: readonly TrainIconSpec[]): TrainAtlas {
  const atlas = document.createElement('canvas');
  atlas.width = specs.reduce((sum, spec) => sum + WIDTH[spec.nose] + GAP, 0);
  atlas.height = ICON_HEIGHT;
  const ctx = atlas.getContext('2d');
  const mapping: IconMapping = {};
  const urls = new Map<string, string>();
  let x = 0;

  for (const spec of specs) {
    const width = WIDTH[spec.nose];
    if (ctx) {
      ctx.save();
      ctx.translate(x, 0);
      drawTrain(ctx, spec);
      ctx.restore();
    }
    // Ancre au milieu du train : sa position est celle de son centre.
    mapping[spec.key] = { x, y: 0, width, height: ICON_HEIGHT, anchorX: width / 2, anchorY: ICON_HEIGHT / 2, mask: false };

    const single = document.createElement('canvas');
    single.width = width;
    single.height = ICON_HEIGHT;
    const singleCtx = single.getContext('2d');
    if (singleCtx) {
      drawTrain(singleCtx, spec);
      urls.set(spec.key, single.toDataURL());
    }
    x += width + GAP;
  }

  return { atlas: atlas.toDataURL(), mapping, dataUrl: (key) => urls.get(key) };
}
