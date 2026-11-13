/**
 * Coques des navires, vues de dessus, dessinées une fois dans un atlas que deck.gl découpe.
 * Tracés de la planche de symboles validée : huit coques selon le type AIS (la passerelle du
 * porte-conteneurs à l'arrière, les ponts blancs du ferry, la voile du voilier…), halo clair,
 * remplissage de la couleur de famille, contour sombre.
 *
 * L'atlas contient deux sortes de cellules, toutes carrées et de même côté (donc une seule taille
 * d'affichage pour les deux) :
 * - les **coques**, proue en haut, centrées, en trois largeurs (étroite, normale, large) pour suivre
 *   la largeur que l'AIS déclare ;
 * - les **sillages**, en quatre longueurs selon la vitesse et trois écartements selon la largeur
 *   de la coque, la poupe tout en haut : la couche des sillages les accroche à la poupe du navire
 *   (ancre au-dessus de la cellule) et les dessine sous toutes les coques.
 *
 * Un navire à l'arrêt n'a pas de sillage : c'est lui qui dit « en route », à la place de l'ancienne
 * coque arrondie. Les cellules sont grandes (256 px) pour rester nettes sur un écran haute densité
 * quand on s'approche d'un navire dessiné à sa longueur réelle.
 */
import { SHIP } from '../design/tokens';
import type { IconLayerProps } from '@deck.gl/layers';

type IconMapping = NonNullable<IconLayerProps['iconMapping']>;

export type ShipType = 'cargo' | 'tanker' | 'ferry' | 'peche' | 'voilier' | 'plaisance' | 'remorqueur' | 'service';
export type Family = 'marchandises' | 'passagers' | 'petits' | 'autres';

export const SHIP_TYPES: readonly ShipType[] = ['cargo', 'tanker', 'ferry', 'peche', 'voilier', 'plaisance', 'remorqueur', 'service'];

/** Palette validée (sur la mer et sur la terre du fond de carte), et un gris pour le reste. */
export const SHIP_COLORS: Record<Family, string> = { ...SHIP };

export const TYPE_FAMILY: Record<ShipType, Family> = {
  cargo: 'marchandises',
  tanker: 'marchandises',
  ferry: 'passagers',
  peche: 'petits',
  voilier: 'petits',
  plaisance: 'petits',
  remorqueur: 'autres',
  service: 'autres',
};

/** Choix de la coque d'après le type AIS. */
export function shipType(kind: number | undefined): ShipType {
  if (kind === undefined) return 'service';
  if (kind >= 70 && kind <= 79) return 'cargo';
  if (kind >= 80 && kind <= 89) return 'tanker';
  if ((kind >= 60 && kind <= 69) || (kind >= 40 && kind <= 49)) return 'ferry';
  if (kind === 30) return 'peche';
  if (kind === 36) return 'voilier';
  if (kind === 37) return 'plaisance';
  if (kind === 31 || kind === 32 || kind === 52) return 'remorqueur';
  return 'service';
}

/** Légende : ce que dit la coque, avec la famille (la couleur) en tête. */
export const SHIP_INFO: Record<ShipType, string> = {
  cargo: 'Marchandises : porte-conteneurs, vraquiers (passerelle à l’arrière)',
  tanker: 'Marchandises : pétroliers, chimiquiers, gaziers (tuyauterie sur le pont)',
  ferry: 'Passagers : ferries, croisières, navettes rapides (ponts blancs)',
  peche: 'Pêche : navires de pêche (timonerie à l’avant)',
  voilier: 'Plaisance : voiliers',
  plaisance: 'Plaisance : bateaux à moteur',
  remorqueur: 'Remorqueurs (courts et larges)',
  service: 'Pilotes, services, type inconnu',
};

/** Largeur de la coque rapportée à sa longueur, par type (planche). */
export const BEAM_RATIO: Record<ShipType, number> = {
  cargo: 0.16,
  tanker: 0.18,
  ferry: 0.2,
  peche: 0.3,
  voilier: 0.26,
  plaisance: 0.34,
  remorqueur: 0.38,
  service: 0.24,
};

/** Longueur courante du type (mètres), quand l'AIS ne donne pas la sienne. */
export const NOMINAL_LENGTH: Record<ShipType, number> = {
  cargo: 180,
  tanker: 170,
  ferry: 140,
  peche: 24,
  voilier: 12,
  plaisance: 9,
  remorqueur: 30,
  service: 45,
};

/** Largeur déclarée comparée à celle du type : étroite (0), normale (1) ou large (2). */
const BEAM_SCALES = [0.8, 1, 1.25] as const;
export function beamClassOf(type: ShipType, length: number | undefined, width: number | undefined): 0 | 1 | 2 {
  if (!length || !width) return 1;
  const relative = width / length / BEAM_RATIO[type];
  // Une déclaration absurde (largeur dix fois trop grande) ne déforme pas la coque.
  if (relative < 0.3 || relative > 3) return 1;
  return relative < 0.88 ? 0 : relative > 1.15 ? 2 : 1;
}

/** Longueur du sillage selon la vitesse (nœuds) : tranche 0 à 3, ou -1 sans sillage. */
export const WAKE_BANDS = 4;
export function wakeBandOf(sog: number): number {
  if (sog < 0.5) return -1;
  return sog < 3 ? 0 : sog < 8 ? 1 : sog < 15 ? 2 : 3;
}
/** Longueur du sillage (en longueurs de coque) par tranche : proportionnelle à la vitesse, par paliers. */
const WAKE_LENGTH = [0.3, 0.5, 0.75, 0.98];
/** Largeur de coque (rapportée à sa longueur) que dessinent les trois écartements de sillage. */
const WAKE_BEAMS = [0.17, 0.26, 0.38];
export function wakeWidthOf(type: ShipType, beamClass: number): number {
  const ratio = BEAM_RATIO[type] * BEAM_SCALES[beamClass]!;
  return ratio < 0.215 ? 0 : ratio < 0.32 ? 1 : 2;
}

// --- Tracé ---

const KEY = '#141a26';
const HALO = 'rgba(255,255,255,0.93)';
const DECK = '#f2f4f8';

/** Côté d'une cellule de l'atlas, et longueur de la coque dedans (la marge reçoit contour et halo). */
export const CELL = 256;
export const HULL_LENGTH = 208;
/** Ordonnée de la poupe dans une cellule de sillage. */
const WAKE_STERN = 24;
/** Distance du centre de la coque à sa poupe, en pixels de l'atlas : l'ancre d'une cellule de sillage est à cette distance au-dessus de son bord haut. */
export const WAKE_ANCHOR_Y = WAKE_STERN - HULL_LENGTH / 2;

/**
 * Épaisseur du contour dans l'atlas, par type : une grande coque garde un trait fin ; une petite,
 * qui s'affiche longtemps à sa taille minimale, un trait plus épais pour rester lisible.
 */
const STROKE: Record<ShipType, number> = { cargo: 3, tanker: 3, ferry: 3.2, peche: 4.6, voilier: 4.8, plaisance: 5, remorqueur: 4.4, service: 4.4 };

type PathFn = (ctx: CanvasRenderingContext2D) => void;

/** Halo clair, puis remplissage, puis contour sombre. */
function ink(ctx: CanvasRenderingContext2D, path: PathFn, fill: string, key: number, halo: number, noHalo = false): void {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (!noHalo) {
    path(ctx);
    ctx.strokeStyle = HALO;
    ctx.lineWidth = key + halo * 2;
    ctx.stroke();
  }
  path(ctx);
  ctx.fillStyle = fill;
  ctx.fill();
  path(ctx);
  ctx.strokeStyle = KEY;
  ctx.lineWidth = key;
  ctx.stroke();
  ctx.restore();
}

const rect = (x: number, y: number, w: number, h: number, r = 0): PathFn => (ctx) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

/** Une coque centrée sur l'origine, proue vers le haut, de longueur `L`. `k` : épaisseur des traits. */
function drawHull(ctx: CanvasRenderingContext2D, type: ShipType, L: number, beamScale: number, k: number): void {
  const color = SHIP_COLORS[TYPE_FAMILY[type]];
  const B = L * BEAM_RATIO[type] * beamScale;
  const h = L / 2;
  const b = B / 2;
  const hull: PathFn = (c) => {
    c.beginPath();
    if (type === 'cargo') {
      c.moveTo(0, -h);
      c.quadraticCurveTo(b, -h * 0.82, b, -h * 0.55);
      c.lineTo(b, h * 0.9);
      c.quadraticCurveTo(b, h, b * 0.7, h);
      c.lineTo(-b * 0.7, h);
      c.quadraticCurveTo(-b, h, -b, h * 0.9);
      c.lineTo(-b, -h * 0.55);
      c.quadraticCurveTo(-b, -h * 0.82, 0, -h);
    } else if (type === 'tanker') {
      c.moveTo(-b, -h * 0.6);
      c.bezierCurveTo(-b, -h * 1.02, b, -h * 1.02, b, -h * 0.6);
      c.lineTo(b, h * 0.88);
      c.quadraticCurveTo(b, h, b * 0.6, h);
      c.lineTo(-b * 0.6, h);
      c.quadraticCurveTo(-b, h, -b, h * 0.88);
      c.closePath();
    } else if (type === 'ferry') {
      c.moveTo(0, -h);
      c.bezierCurveTo(b * 1.1, -h * 0.9, b, -h * 0.45, b, -h * 0.3);
      c.lineTo(b, h * 0.78);
      c.quadraticCurveTo(b, h, 0, h);
      c.quadraticCurveTo(-b, h, -b, h * 0.78);
      c.lineTo(-b, -h * 0.3);
      c.bezierCurveTo(-b, -h * 0.45, -b * 1.1, -h * 0.9, 0, -h);
    } else if (type === 'voilier') {
      c.moveTo(0, -h);
      c.bezierCurveTo(b * 1.4, -h * 0.4, b * 1.2, h * 0.6, b * 0.5, h);
      c.lineTo(-b * 0.5, h);
      c.bezierCurveTo(-b * 1.2, h * 0.6, -b * 1.4, -h * 0.4, 0, -h);
    } else if (type === 'remorqueur') {
      c.roundRect(-b, -h, B, L, [b, b, b * 0.6, b * 0.6]);
    } else {
      c.moveTo(0, -h);
      c.quadraticCurveTo(b * 1.1, -h * 0.5, b, -h * 0.1);
      c.lineTo(b, h * 0.85);
      c.quadraticCurveTo(b, h, b * 0.7, h);
      c.lineTo(-b * 0.7, h);
      c.quadraticCurveTo(-b, h, -b, h * 0.85);
      c.lineTo(-b, -h * 0.1);
      c.quadraticCurveTo(-b * 1.1, -h * 0.5, 0, -h);
    }
  };
  ink(ctx, hull, color, (type === 'remorqueur' ? 2.8 : 1.8) * k, 2.2 * k);

  // Superstructures et ponts, dans la coque.
  ctx.save();
  hull(ctx);
  ctx.clip();
  const inner = 1.2 * k;
  if (type === 'cargo') {
    for (let y = -h * 0.5; y < h * 0.55; y += L * 0.075) {
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(-b * 0.75, y, B * 0.75, L * 0.06);
    }
    ink(ctx, rect(-b * 0.9, h * 0.62, B * 0.9, L * 0.09, 2 * k), DECK, inner, 0, true);
  } else if (type === 'tanker') {
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(1.4 * k, B * 0.1);
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.65);
    ctx.lineTo(0, h * 0.6);
    ctx.stroke();
    ink(ctx, rect(-b * 0.85, h * 0.66, B * 0.85, L * 0.09, 2 * k), DECK, inner, 0, true);
  } else if (type === 'ferry') {
    ink(ctx, rect(-b * 0.78, -h * 0.4, B * 0.78, L * 0.72, b * 0.5), DECK, inner, 0, true);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, h * 0.12, b * 0.32, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'peche') {
    ink(ctx, rect(-b * 0.7, -h * 0.32, B * 0.7, L * 0.26, 2 * k), DECK, inner, 0, true);
  } else if (type === 'voilier') {
    ctx.fillStyle = DECK;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.3);
    ctx.lineTo(b * 1.6, h * 0.45);
    ctx.lineTo(0, h * 0.45);
    ctx.closePath();
    ctx.fill();
  } else if (type === 'remorqueur' || type === 'service') {
    ink(ctx, rect(-b * 0.6, -h * 0.15, B * 0.6, L * 0.34, 2 * k), DECK, inner, 0, true);
  } else if (type === 'plaisance') {
    ctx.strokeStyle = DECK;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.arc(0, -h * 0.05, b * 0.7, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Sillage à partir de la poupe (origine), vers le bas : deux traits en V et un trait central,
 * de longueur `wake` (pixels) ; `halfBeam` : demi-largeur de la coque à la poupe.
 */
function drawWake(ctx: CanvasRenderingContext2D, halfBeam: number, wake: number, k: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2.2 * k;
  ctx.beginPath();
  ctx.moveTo(-halfBeam * 0.9, -wake * 0.02);
  ctx.lineTo(-halfBeam * 0.9 - wake * 0.32, wake);
  ctx.moveTo(halfBeam * 0.9, -wake * 0.02);
  ctx.lineTo(halfBeam * 0.9 + wake * 0.32, wake);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1.6 * k;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, wake * 0.8);
  ctx.stroke();
  ctx.restore();
}

const WAKE_K = 3.2;

// --- Atlas ---

export interface ShipAtlas {
  /** Image de l'atlas (data URL), telle que deck.gl l'attend. */
  atlas: string;
  mapping: IconMapping;
}

export const hullKey = (type: ShipType, beamClass: number) => `${type}-${beamClass}`;
export const wakeKey = (widthClass: number, band: number) => `sillage-${widthClass}-${band}`;

const COLUMNS = 6;
let atlasCache: ShipAtlas | undefined;

export function shipAtlas(): ShipAtlas {
  if (atlasCache) return atlasCache;
  const cells: Array<{ key: string; draw: (ctx: CanvasRenderingContext2D) => void; anchorY: number }> = [];
  for (const type of SHIP_TYPES) {
    for (let beam = 0; beam < BEAM_SCALES.length; beam++) {
      cells.push({
        key: hullKey(type, beam),
        anchorY: CELL / 2,
        draw: (ctx) => {
          ctx.translate(CELL / 2, CELL / 2);
          drawHull(ctx, type, HULL_LENGTH, BEAM_SCALES[beam]!, STROKE[type]);
        },
      });
    }
  }
  for (let width = 0; width < WAKE_BEAMS.length; width++) {
    for (let band = 0; band < WAKE_BANDS; band++) {
      cells.push({
        key: wakeKey(width, band),
        anchorY: WAKE_ANCHOR_Y,
        draw: (ctx) => {
          ctx.translate(CELL / 2, WAKE_STERN);
          drawWake(ctx, (HULL_LENGTH * WAKE_BEAMS[width]!) / 2, HULL_LENGTH * WAKE_LENGTH[band]!, WAKE_K);
        },
      });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = COLUMNS * CELL;
  canvas.height = Math.ceil(cells.length / COLUMNS) * CELL;
  const ctx = canvas.getContext('2d');
  const mapping: IconMapping = {};
  cells.forEach(({ key, draw, anchorY }, i) => {
    const x = (i % COLUMNS) * CELL;
    const y = Math.floor(i / COLUMNS) * CELL;
    if (ctx) {
      ctx.save();
      ctx.translate(x, y);
      draw(ctx);
      ctx.restore();
    }
    mapping[key] = { x, y, width: CELL, height: CELL, anchorX: CELL / 2, anchorY, mask: false };
  });
  atlasCache = { atlas: canvas.toDataURL(), mapping };
  return atlasCache;
}

/**
 * Image de légende (36 x 14 px affichés, dessinée en 4x) : la coque couchée, proue à droite,
 * avec son sillage si `band` est donné.
 */
export function legendHull(type: ShipType, band = -1): string {
  const canvas = document.createElement('canvas');
  canvas.width = 144;
  canvas.height = 56;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const L = band >= 0 ? 78 : 112;
  const centerX = band >= 0 ? 104 : 72;
  ctx.translate(centerX, 28);
  ctx.rotate(Math.PI / 2);
  const width = wakeWidthOf(type, 1);
  if (band >= 0) {
    ctx.save();
    ctx.translate(0, L / 2);
    drawWake(ctx, (L * WAKE_BEAMS[width]!) / 2, L * WAKE_LENGTH[band]!, 1.5);
    ctx.restore();
  }
  drawHull(ctx, type, L, 1, 1.3);
  return canvas.toDataURL();
}
