/**
 * Couleurs de statut partagées par les crues, la vigilance météo et l'état du trafic,
 * et anneau de sélection commun à ces trois couches.
 */
import { STATUS } from '../design/tokens';
import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';

/**
 * Vert, jaune, orange, rouge. Validées avec le validateur de palette (fond clair et fond sombre) :
 * jaune et orange à ΔE 20 ou plus (l'ancien orange #ec835a n'en avait que 13,6), orange et rouge
 * à ΔE 20. Vert et rouge restent proches pour un daltonien (deutéranope) : on ne s'y fie jamais
 * à la couleur seule (trame de la vigilance, épaisseur des traits des crues et du trafic).
 * Le rouge reste assez foncé pour se distinguer de l'orange, au prix d'un contraste modeste sur
 * fond sombre, compensé par le contour sombre et la lueur claire des traits.
 */
export const STATUS_COLORS = {
  vert: STATUS.vert,
  jaune: STATUS.jaune,
  orange: STATUS.orange,
  rouge: STATUS.rouge,
} as const;

/** Encre des contours et des trames. */
export const STATUS_INK = STATUS.ink;

const RING_OUTLINE_SUFFIX = '-contour';

/**
 * Largeur d'un trait selon le zoom : `[[zoom, largeur], …]`, avec `extra` pixels en plus.
 * (Une expression de zoom doit rester au sommet : on ne peut pas ajouter après coup.)
 */
export function zoomWidth(stops: [number, number][], extra = 0): unknown[] {
  return ['interpolate', ['linear'], ['zoom'], ...stops.flatMap(([zoom, width]) => [zoom, width + extra])];
}

/**
 * Anneau de sélection : un liseré blanc cerné de sombre, lisible sur le fond clair comme sur
 * le fond de nuit, et qui ne dit rien par sa teinte (la couleur est réservée aux données).
 * `stops` donne la largeur du liseré blanc selon le zoom (ou une seule largeur) ; `gap` l'écart
 * avec l'objet (l'anneau l'entoure plutôt que de le recouvrir).
 */
export function selectionRingLayers(
  id: string,
  source: string,
  filter: unknown[],
  stops: number | [number, number][],
  gap?: number,
  layout: Record<string, unknown> = { 'line-cap': 'round', 'line-join': 'round' },
): LayerSpecification[] {
  const width = (extra: number) => (typeof stops === 'number' ? stops + extra : zoomWidth(stops, extra));
  const ring = (layerId: string, color: string, w: unknown) =>
    ({
      id: layerId,
      type: 'line',
      source,
      filter,
      layout,
      paint: { 'line-color': color, 'line-width': w, ...(gap === undefined ? {} : { 'line-gap-width': gap }) },
    }) as unknown as LayerSpecification;
  // Le trait sombre, plus large, dépasse de part et d'autre du liseré blanc posé dessus.
  return [ring(id + RING_OUTLINE_SUFFIX, STATUS_INK, width(3)), ring(id, '#ffffff', width(0))];
}

/** Ajoute l'anneau (dessous d'abord) avant la couche `before`. */
export function addSelectionRing(map: MapLibreMap, layers: LayerSpecification[], before: string | undefined): void {
  for (const layer of layers) map.addLayer(layer, before);
}

/** Change l'objet entouré. */
export function setSelectionRingFilter(map: MapLibreMap, id: string, filter: unknown[]): void {
  for (const layerId of [id + RING_OUTLINE_SUFFIX, id]) {
    if (map.getLayer(layerId)) map.setFilter(layerId, filter as never);
  }
}

/** Identifiants des deux couches de l'anneau (pour les retirer). */
export function selectionRingIds(id: string): string[] {
  return [id, id + RING_OUTLINE_SUFFIX];
}
