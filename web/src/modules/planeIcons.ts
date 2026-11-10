/**
 * Silhouettes d'avion vues de dessus, dessinées une seule fois dans un canvas (« atlas »)
 * que deck.gl découpe ensuite, comme pour les trains.
 *
 * Sept silhouettes : la forme dit le genre d'appareil (le type OACI de l'avion la choisit,
 * voir `planeClass`), la couleur dit l'altitude. Les contours (en mètres, nez vers le haut,
 * demi-contour droit) sont ceux de la planche de symboles validée ; ils sont à l'échelle
 * réelle des appareils, ce qui donne leur taille de près.
 *
 * Le tracé reprend celui de la planche, dessiné à la taille minimale d'affichage de chaque
 * silhouette puis agrandi : le trait sombre et le halo clair gardent ainsi l'épaisseur
 * validée quand l'icône est petite, et l'atlas reste net sur un écran haute densité.
 *
 * Chaque icône pointe vers l'est (la droite) ; deck.gl la fait tourner selon le cap.
 */
import type { IconLayerProps } from '@deck.gl/layers';

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

/** Indice de silhouette tiré de la catégorie ADS-B, quand le type OACI manque. */
export type Shape = 'jet' | 'light' | 'heli';

export type PlaneClass = 'narrow' | 'wide' | 'quad' | 'turboprop' | 'bizjet' | 'light' | 'heli';

export const PLANE_CLASSES: readonly PlaneClass[] = ['narrow', 'wide', 'quad', 'turboprop', 'bizjet', 'light', 'heli'];

export interface PlaneIconSpec {
  key: string;
  cls: PlaneClass;
  color: string;
}

/** Côté d'une icône dans l'atlas (carrée), en pixels : assez pour rester net à l'envergure réelle de près. */
export const ICON_SIZE = 192;
/** Marge autour de la silhouette, en unités de tracé de la planche : de quoi loger le contour et le halo. */
const MARGIN = 4.5;
/**
 * Taille de tracé de la planche par rapport à la taille minimale à l'écran : plus c'est grand, plus
 * le trait sombre et le halo sont fins une fois l'icône réduite. 1,6 donne à la taille minimale un
 * trait d'environ 1,1 pixel CSS (2,2 pixels sur un écran à double densité).
 */
const LINE_REF = 1.6;
const KEY = '#141a26';
const HALO = 'rgba(255,255,255,0.93)';

interface Aircraft {
  /** Envergure réelle (m). */
  span: number;
  /** Demi-contour droit, du nez à la queue (m), nez vers le haut. */
  pts: ReadonlyArray<readonly [number, number]>;
  /** Moteurs : [x, y, demi-largeur, demi-longueur] (m), de chaque côté. */
  engines: ReadonlyArray<readonly [number, number, number, number]>;
  /** Hélices : [x, y, rayon] (m) ; x = 0 pour une hélice dans l'axe. */
  props?: ReadonlyArray<readonly [number, number, number]>;
  name: string;
  examples: string;
}

const AIRCRAFT: Record<Exclude<PlaneClass, 'heli'>, Aircraft> = {
  narrow: { span: 35.8, pts: [[0, -18.8], [0.9, -18.2], [1.6, -16.8], [1.95, -14.5], [1.98, -3.2], [17.9, 5.6], [17.9, 7.1], [1.98, 3.6], [1.85, 10.5], [1.3, 13.4], [6.4, 17], [6.4, 18.1], [0.8, 17.4], [0.4, 18.8]], engines: [[5.7, -1.2, 1.0, 2.8]], name: 'Court et moyen-courrier', examples: 'A320, B737' },
  wide: { span: 64.8, pts: [[0, -31.8], [1.5, -30.8], [2.7, -28.5], [3.1, -25], [3.1, -7.5], [32.4, 9.5], [32.4, 11.6], [3.1, 6.5], [3, 19], [2.2, 24.5], [10.7, 29.5], [10.7, 31.2], [1.2, 30.2], [0.5, 31.8]], engines: [[9.8, -3.5, 1.9, 4.6]], name: 'Long-courrier biréacteur', examples: 'A330, A350, B777' },
  quad: { span: 68.4, pts: [[0, -38.1], [1.6, -37], [2.9, -34.5], [3.25, -30], [3.25, -9], [34.2, 11], [34.2, 13.2], [3.25, 8.2], [3.1, 24], [2.3, 30], [11, 35], [11, 36.8], [1.2, 36], [0.5, 38.1]], engines: [[11.6, -4.8, 1.5, 3.9], [21.2, 2.2, 1.4, 3.6]], name: 'Quadriréacteur', examples: 'A380, B747' },
  turboprop: { span: 27, pts: [[0, -13.6], [0.8, -13], [1.3, -11.8], [1.4, -3.2], [13.5, -2.6], [13.5, -0.6], [1.4, 0.4], [1.2, 7], [0.8, 10.6], [3.6, 11.6], [3.6, 12.6], [0.5, 12.4], [0.3, 13.6]], engines: [[4.1, -3.4, 0.75, 2.4]], props: [[4.1, -6, 1.9]], name: 'Turbopropulseur régional', examples: 'ATR 72, Dash 8' },
  bizjet: { span: 23, pts: [[0, -15.5], [0.8, -14.8], [1.3, -13.2], [1.4, -4], [11.5, 3.4], [11.5, 4.6], [1.4, 2.2], [1.35, 9], [1.1, 12.8], [3.3, 14.4], [3.3, 15.3], [0.6, 14.8], [0.3, 15.5]], engines: [[2.45, 9.4, 0.85, 2.4]], name: 'Jet régional et d’affaires', examples: 'CRJ, Falcon' },
  light: { span: 11, pts: [[0, -4.15], [0.45, -4], [0.55, -2.9], [0.6, -1.2], [5.5, -1.1], [5.5, 0.35], [0.55, 0.35], [0.32, 2.9], [1.7, 3.3], [1.7, 3.9], [0.25, 3.9], [0.2, 4.15]], engines: [], props: [[0, -4.45, 1]], name: 'Avion léger', examples: 'Cessna 172, DR400' },
};

/** Nom et exemples d'une silhouette, pour la légende. */
export const PLANE_NAMES: Record<PlaneClass, { name: string; examples: string }> = {
  narrow: AIRCRAFT.narrow,
  wide: AIRCRAFT.wide,
  quad: AIRCRAFT.quad,
  turboprop: AIRCRAFT.turboprop,
  bizjet: AIRCRAFT.bizjet,
  light: AIRCRAFT.light,
  heli: { name: 'Hélicoptère', examples: 'EC135, H145' },
};

/** Envergure réelle (m) : celle du rotor pour un hélicoptère. */
const SPAN_M: Record<PlaneClass, number> = {
  narrow: AIRCRAFT.narrow.span,
  wide: AIRCRAFT.wide.span,
  quad: AIRCRAFT.quad.span,
  turboprop: AIRCRAFT.turboprop.span,
  bizjet: AIRCRAFT.bizjet.span,
  light: AIRCRAFT.light.span,
  heli: 10.8,
};

/** Taille minimale lisible de l'envergure à l'écran, en pixels CSS (de loin, un A380 reste un peu plus grand qu'un Cessna). */
export const MIN_SPAN_PX: Record<PlaneClass, number> = { narrow: 24, wide: 29, quad: 32, turboprop: 20, bizjet: 19, light: 15, heli: 18 };

/** Plus grande dimension de la silhouette (m) : l'envergure ou la longueur, selon la plus grande. */
function extentMeters(cls: PlaneClass): number {
  if (cls === 'heli') return 11.6;
  const a = AIRCRAFT[cls];
  return Math.max(a.span, 2 * Math.abs(a.pts[0]![1]));
}

/** Facteur d'agrandissement du tracé de la planche (réglé à la taille minimale) pour remplir une case. */
function drawScale(cls: PlaneClass): number {
  const px = (MIN_SPAN_PX[cls] * LINE_REF * extentMeters(cls)) / SPAN_M[cls];
  return ICON_SIZE / (px + 2 * MARGIN);
}

/**
 * Dimensions pour deck.gl : côté d'une case en mètres réels (la taille de l'icône à l'échelle),
 * envergure réelle, et envergure minimale à l'écran en pixels.
 */
export function planeSizing(cls: PlaneClass): { cellMeters: number; spanMeters: number; minSpanPx: number } {
  const metersPerPx = SPAN_M[cls] / (MIN_SPAN_PX[cls] * LINE_REF * drawScale(cls)); // mètres par pixel d'atlas
  return { cellMeters: ICON_SIZE * metersPerPx, spanMeters: SPAN_M[cls], minSpanPx: MIN_SPAN_PX[cls] };
}

// --- Tracé (celui de la planche) ---

/** Halo clair, puis remplissage, puis contour sombre. */
function ink(ctx: CanvasRenderingContext2D, path: (c: CanvasRenderingContext2D) => void, fill: string, key = 2, halo = 2.4): void {
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

/** Contour symétrique : demi-contour droit (x ≥ 0) du nez à la queue, mis à l'échelle s. */
const symmetric = (points: Aircraft['pts'], s: number) => (ctx: CanvasRenderingContext2D) => {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x * s, y * s) : ctx.moveTo(x * s, y * s)));
  for (let i = points.length - 1; i >= 0; i--) ctx.lineTo(-points[i]![0] * s, points[i]![1] * s);
  ctx.closePath();
};

const roundRect = (x: number, y: number, w: number, h: number, r: number) => (ctx: CanvasRenderingContext2D) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

/** Silhouette nez vers le haut, centrée sur l'origine, dont l'envergure fait `spanPx` pixels. */
function drawSilhouette(ctx: CanvasRenderingContext2D, cls: PlaneClass, spanPx: number, color: string): void {
  if (cls === 'heli') {
    const s = spanPx / 10.8;
    // Disque du rotor : un voile léger, pour le reconnaître même très petit.
    ctx.beginPath();
    ctx.arc(0, -0.8 * s, 5.4 * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,38,0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ink(
      ctx,
      (c) => {
        c.beginPath();
        c.ellipse(0, -1.2 * s, 1.3 * s, 2.7 * s, 0, 0, Math.PI * 2);
        c.rect(-0.28 * s, 0.8 * s, 0.56 * s, 4.8 * s);
      },
      color,
      1.8,
    );
    ink(ctx, roundRect(-1.4 * s, 5.2 * s, 2.8 * s, 0.6 * s, 0.3 * s), color, 1.4);
    ctx.strokeStyle = 'rgba(20,26,38,0.75)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-5 * s, -2.8 * s);
    ctx.lineTo(5 * s, 1.2 * s);
    ctx.moveTo(-5 * s, 1.2 * s);
    ctx.lineTo(5 * s, -2.8 * s);
    ctx.stroke();
    return;
  }
  const a = AIRCRAFT[cls];
  const s = spanPx / a.span;
  ink(ctx, symmetric(a.pts, s), color, 1.8, 2.4);
  for (const [ex, ey, rx, ry] of a.engines) {
    for (const sx of [1, -1]) {
      ctx.beginPath();
      ctx.ellipse(sx * ex * s, ey * s, Math.max(rx * s, 1.6), ry * s, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,26,38,0.62)';
      ctx.fill();
    }
  }
  for (const [px, py, r] of a.props ?? []) {
    for (const sx of px ? [1, -1] : [1]) {
      ctx.strokeStyle = 'rgba(20,26,38,0.8)';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(sx * px * s - r * s, py * s);
      ctx.lineTo(sx * px * s + r * s, py * s);
      ctx.stroke();
    }
  }
  // Arête de fuselage : un reflet clair.
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = Math.max(1.2, s * 0.6);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, a.pts[1]![1] * s);
  ctx.lineTo(0, a.pts[a.pts.length - 3]![1] * s);
  ctx.stroke();
}

/** Une icône dans une case de `ICON_SIZE` pixels dont le coin haut gauche est l'origine, nez vers l'est. */
function drawIcon(ctx: CanvasRenderingContext2D, { cls, color }: PlaneIconSpec, north = false): void {
  ctx.save();
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  if (!north) ctx.rotate(Math.PI / 2);
  const k = drawScale(cls);
  ctx.scale(k, k);
  drawSilhouette(ctx, cls, MIN_SPAN_PX[cls] * LINE_REF, color);
  ctx.restore();
}

export interface PlaneAtlas {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
  /** Image d'une icône, nez vers le haut (pour la légende). */
  dataUrl(key: string): string | undefined;
}

const COLUMNS = 6;

export function buildPlaneAtlas(specs: readonly PlaneIconSpec[]): PlaneAtlas {
  const rows = Math.ceil(specs.length / COLUMNS);
  const atlas = document.createElement('canvas');
  atlas.width = COLUMNS * ICON_SIZE;
  atlas.height = rows * ICON_SIZE;
  const ctx = atlas.getContext('2d');
  const mapping: IconMapping = {};
  const urls = new Map<string, string>();

  specs.forEach((spec, i) => {
    const x = (i % COLUMNS) * ICON_SIZE;
    const y = Math.floor(i / COLUMNS) * ICON_SIZE;
    if (ctx) {
      ctx.save();
      ctx.translate(x, y);
      drawIcon(ctx, spec);
      ctx.restore();
    }
    // Ancre au centre : la position de l'avion est celle de son centre.
    mapping[spec.key] = { x, y, width: ICON_SIZE, height: ICON_SIZE, anchorX: ICON_SIZE / 2, anchorY: ICON_SIZE / 2, mask: false };
  });

  /** Image de légende, créée à la demande : seules quelques silhouettes y figurent. */
  const legend = (key: string): string | undefined => {
    const cached = urls.get(key);
    if (cached) return cached;
    const spec = specs.find((s) => s.key === key);
    if (!spec) return undefined;
    const single = document.createElement('canvas');
    single.width = single.height = ICON_SIZE;
    const singleCtx = single.getContext('2d');
    if (!singleCtx) return undefined;
    drawIcon(singleCtx, spec, true);
    const url = single.toDataURL();
    urls.set(key, url);
    return url;
  };
  return { atlas: atlas.toDataURL(), mapping, dataUrl: legend };
}

/** Anneau d'urgence en data URL (légende) : rouge doublé de blanc, comme celui dessiné sur la carte. */
export function ringDataUrl(color: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.beginPath();
  ctx.arc(16, 16, 11, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  ctx.stroke();
  return canvas.toDataURL();
}

/** Anneau de sélection en data URL (légende) : blanc cerné de sombre, comme sur la carte. */
export function selectionRingDataUrl(): string {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.beginPath();
  ctx.arc(16, 16, 11, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 7;
  ctx.stroke();
  ctx.strokeStyle = KEY;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  return canvas.toDataURL();
}

/** Silhouette choisie d'après le type OACI (A320, B77W, AT76…) ; `shape` (catégorie ADS-B) sert quand le type manque ou est inconnu. */
export function planeClass(type: string | undefined, shape: Shape): PlaneClass {
  if (shape === 'heli') return 'heli';
  const t = type ?? '';
  if (/^(A38|B74|A34|IL96|A124)/.test(t)) return 'quad';
  if (/^(A3[035]|B7[6-8]|A30|MD11|DC10)/.test(t)) return 'wide';
  if (/^(AT[4-7]|DH8|SF34|B190|D328|F50|C130|A400)/.test(t)) return 'turboprop';
  if (/^(CRJ|CL[36]|GLF|GLEX|FA[0-9]|F2TH|F900|C25|C5[0-9]|C68|C700|C750|E5[05]P|LJ|H25|PC24|BE40)/.test(t)) return 'bizjet';
  if (/^(C1[0-9]{2}|C2[0-9]{2}|P28|PA|DR|SR2|TB|DA[24]|RV|CAP|M20|PC12|TBM)/.test(t)) return 'light';
  if (/^(EC|H1|H2|AS3|AS5|A109|A119|A139|R22|R44|R66|B06|B407|S76|NH90)/.test(t)) return 'heli';
  return shape === 'light' ? 'light' : 'narrow';
}
