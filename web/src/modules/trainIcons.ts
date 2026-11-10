/**
 * Têtes de train vues de dessus, dessinées une seule fois dans un canvas
 * (« atlas ») que deck.gl découpe ensuite. Le tracé est celui de la planche des
 * symboles : un nez effilé pour la grande vitesse, arrondi sinon, un pare-brise, et
 * surtout un halo clair sous un contour sombre, qui détache la tête de sa traînée.
 *
 * Chaque train pointe vers l'est (la droite) ; deck.gl le fait tourner selon son cap.
 * Le dessin est fait en « unités de planche » (u) : au zoom où la tête a sa taille
 * pleine, une unité vaut 0,8 pixel d'écran.
 */
import { ink, type IconCell, type IconSheet, packIcons } from './symbols';

/** Nez profilé (grande vitesse, plus long) ou standard. */
export type Nose = 'profile' | 'standard';

export interface TrainIconSpec {
  key: string;
  color: string;
  nose: Nose;
}

/** Pixels de l'atlas par unité de planche : de quoi rester net sans alourdir la texture. */
const SCALE = 2.4;
/** Largeur du corps, longueur du corps selon le nez, contour et halo (en u). */
const BODY_WIDTH = 12;
const BODY_LENGTH: Record<Nose, number> = { profile: 34, standard: 28 };
const KEY = 2;
const HALO = 2.4;
/** Marge autour du halo, pour que le trait ne soit pas rogné. */
const MARGIN = 0.4;

/** Hauteur d'une icône dans l'atlas : c'est cette hauteur que deck.gl met à l'échelle. */
export const ICON_HEIGHT = Math.ceil((BODY_WIDTH + KEY + 2 * HALO + 2 * MARGIN) * SCALE);
const iconWidth = (nose: Nose) => Math.ceil((BODY_LENGTH[nose] + KEY + 2 * HALO + 2 * MARGIN) * SCALE);

/** Silhouette du train, centrée sur l'origine et pointée vers +x. */
function bodyPath(nose: Nose): (ctx: CanvasRenderingContext2D) => void {
  const L = BODY_LENGTH[nose];
  const W = BODY_WIDTH;
  return (c) => {
    c.beginPath();
    c.moveTo(-L / 2 + W / 2, -W / 2);
    if (nose === 'profile') {
      c.lineTo(L * 0.1, -W / 2);
      c.bezierCurveTo(L * 0.36, -W / 2, L / 2, -W * 0.12, L / 2, 0);
      c.bezierCurveTo(L / 2, W * 0.12, L * 0.36, W / 2, L * 0.1, W / 2);
    } else {
      c.lineTo(L / 2 - W * 0.45, -W / 2);
      c.quadraticCurveTo(L / 2, -W / 2, L / 2, 0);
      c.quadraticCurveTo(L / 2, W / 2, L / 2 - W * 0.45, W / 2);
    }
    c.lineTo(-L / 2 + W / 2, W / 2);
    c.arc(-L / 2 + W / 2, 0, W / 2, Math.PI / 2, -Math.PI / 2);
    c.closePath();
  };
}

function drawHead(ctx: CanvasRenderingContext2D, { color, nose }: TrainIconSpec, width: number): void {
  ctx.translate(width / 2, ICON_HEIGHT / 2);
  ctx.scale(SCALE, SCALE);
  ink(ctx, bodyPath(nose), color, { key: KEY, halo: HALO });
  // Pare-brise : un trait clair près du nez.
  const L = BODY_LENGTH[nose];
  const x = nose === 'profile' ? L * 0.3 : L / 2 - BODY_WIDTH * 0.5;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, -BODY_WIDTH * 0.26);
  ctx.lineTo(x, BODY_WIDTH * 0.26);
  ctx.stroke();
}

export type TrainAtlas = IconSheet;

export function buildTrainAtlas(specs: readonly TrainIconSpec[]): TrainAtlas {
  const cells: IconCell[] = specs.map((spec) => {
    const width = iconWidth(spec.nose);
    return { key: spec.key, width, height: ICON_HEIGHT, draw: (ctx) => drawHead(ctx, spec, width) };
  });
  return packIcons(cells);
}
