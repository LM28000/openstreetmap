/**
 * Extension deck.gl qui découpe les disques d'une `ScatterplotLayer` en formes
 * (étoile, losange, triangle, carré), pour distinguer des familles d'objets par
 * leur forme et pas seulement par leur couleur.
 *
 * Pourquoi pas une `IconLayer` : dans cette configuration (deck.gl 9.4 sur le globe
 * MapLibre 5), les icônes, les étiquettes et les lignes à base d'instances ne
 * s'affichent pas du tout en vue globe, alors que les disques s'affichent. Découper
 * les disques dans le shader marche partout, y compris sur le globe.
 *
 * Le shader reçoit la position dans le disque (`geometry.uv`, de −1 à 1) et calcule une
 * « distance à la forme » : ≤ 1 dedans, > 1 dehors. Le bord est adouci sur 12 % du rayon.
 */
import { LayerExtension } from '@deck.gl/core';

export type Shape = 'star' | 'diamond' | 'triangle' | 'square';

const SHAPE_FUNCTIONS: Record<Shape, string> = {
  // Étoile à cinq branches : le rayon de la forme varie linéairement entre pointe et creux.
  star: `
    float a = atan(uv.x, uv.y);
    float segment = 6.2831853 / 5.0;
    float tip = abs(mod(a, segment) - segment * 0.5) / (segment * 0.5);
    return length(uv) / mix(0.45, 1.0, tip);`,
  diamond: 'return (abs(uv.x) + abs(uv.y)) / 0.95;',
  // Triangle pointe en haut : base à y = −0.7, demi-largeur 0.95 à la base.
  triangle: `
    float half_width = max(0.001, 0.95 * (1.0 - uv.y) / 1.7);
    return max(abs(uv.x) / half_width, -uv.y / 0.7);`,
  square: 'return max(abs(uv.x), abs(uv.y)) / 0.78;',
};

export class ShapeExtension extends LayerExtension<{ shape: Shape }> {
  static override extensionName = 'ShapeExtension';

  override getShaders(this: unknown, extension: ShapeExtension) {
    const body = SHAPE_FUNCTIONS[extension.opts.shape];
    return {
      inject: {
        'fs:#decl': `float shapeDistance(vec2 uv) {${body}}`,
        'fs:DECKGL_FILTER_COLOR': `
          color.a *= 1.0 - smoothstep(0.88, 1.0, shapeDistance(geometry.uv));
          if (color.a <= 0.0) discard;`,
      },
    };
  }
}
