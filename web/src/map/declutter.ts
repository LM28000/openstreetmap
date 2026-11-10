/**
 * Désencombrement d'étiquettes, sans dépendre de l'écran.
 *
 * La carte est découpée en cases de la taille d'une étiquette au zoom affiché ;
 * dans chaque case, on ne garde que l'objet prioritaire (le plus petit `rank`).
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
  const best = new Map<string, T>();
  for (const item of items) {
    const x = Math.floor((options.lon(item) * 111_320 * COS_LAT) / cellWidth);
    const y = Math.floor((options.lat(item) * 110_540) / cellHeight);
    const key = `${x}:${y}`;
    const current = best.get(key);
    if (!current || options.rank(item) < options.rank(current)) best.set(key, item);
  }
  return [...best.values()];
}
