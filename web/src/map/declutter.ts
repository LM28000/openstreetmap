/**
 * Désencombrement d'étiquettes, sans dépendre de l'écran.
 *
 * La carte est découpée en cases de la taille d'une étiquette au zoom affiché ;
 * dans chaque case, on ne garde que l'objet prioritaire (le plus petit `rank`), puis on
 * écarte ceux qui touchent encore un voisin mieux placé, de l'autre côté d'un bord de case.
 * Le calcul est refait seulement quand on change de demi-niveau de zoom.
 *
 * (Le filtre de collision de deck.gl, fait sur la carte graphique, masque toutes
 * les étiquettes sur les écrans haute densité dans notre configuration.)
 */

/** Latitude moyenne de la France, pour convertir les degrés en mètres. */
const COS_LAT = Math.cos((46.5 * Math.PI) / 180);

export interface DeclutterOptions<T> {
  lon: (item: T) => number;
  lat: (item: T) => number;
  /** Plus petit = prioritaire (ex. le prix : la station la moins chère l'emporte). */
  rank: (item: T) => number;
  /** Encombrement d'une étiquette à l'écran, en pixels (avec un peu d'air). */
  box: { width: number; height: number };
}

/** Demi-niveau de zoom auquel le désencombrement est calculé. */
export function zoomBand(zoom: number): number {
  return Math.floor(zoom * 2) / 2;
}

/** Les seuils de zoom (`zoomBreaks` d'un module) d'un demi-niveau à l'autre, à partir de `from`. */
export function halfZoomBreaks(from: number, to = 18): number[] {
  return Array.from({ length: Math.round((to - from) * 2) + 1 }, (_, i) => from + i / 2);
}

export function declutter<T>(items: readonly T[], zoom: number, options: DeclutterOptions<T>): T[] {
  const metersPerPixel = (156_543.03 * COS_LAT) / 2 ** zoomBand(zoom);
  const cellWidth = options.box.width * metersPerPixel;
  const cellHeight = options.box.height * metersPerPixel;
  // 1re passe : dans chaque case, l'objet prioritaire.
  interface Winner {
    item: T;
    rank: number;
    /** Position en mètres (projection simple, suffisante à l'échelle d'une étiquette). */
    x: number;
    y: number;
    /** Case de la grille. */
    cx: number;
    cy: number;
  }
  const best = new Map<string, Winner>();
  for (const item of items) {
    const x = options.lon(item) * 111_320 * COS_LAT;
    const y = options.lat(item) * 110_540;
    const cx = Math.floor(x / cellWidth);
    const cy = Math.floor(y / cellHeight);
    const key = `${cx}:${cy}`;
    const rank = options.rank(item);
    const current = best.get(key);
    if (!current || rank < current.rank) best.set(key, { item, rank, x, y, cx, cy });
  }
  // 2e passe : deux gagnants de cases voisines peuvent encore se chevaucher (tous deux près du bord commun).
  // Dans l'ordre des priorités, on écarte celui dont la boîte touche celle d'un voisin déjà gardé. Une boîte
  // fait la taille d'une case : seules les 8 cases voisines peuvent en contenir une qui la touche.
  const winners = [...best.values()].sort((a, b) => a.rank - b.rank);
  const kept = new Map<string, Winner[]>();
  const result: T[] = [];
  for (const w of winners) {
    let clash = false;
    for (let dx = -1; dx <= 1 && !clash; dx++) {
      for (let dy = -1; dy <= 1 && !clash; dy++) {
        for (const k of kept.get(`${w.cx + dx}:${w.cy + dy}`) ?? []) {
          if (Math.abs(k.x - w.x) < cellWidth && Math.abs(k.y - w.y) < cellHeight) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash) continue;
    const key = `${w.cx}:${w.cy}`;
    const list = kept.get(key);
    if (list) list.push(w);
    else kept.set(key, [w]);
    result.push(w.item);
  }
  return result;
}
