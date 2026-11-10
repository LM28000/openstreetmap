/**
 * Extension deck.gl qui découpe les disques d'une `ScatterplotLayer` en formes
 * (étoile, losange, triangle, carré), pour distinguer des familles d'objets par
 * leur forme et pas seulement par leur couleur.
 *
 * Il ne sert plus aux satellites, qui ont des silhouettes en `IconLayer` depuis que les
 * paramètres communs `OVER_MAP` (map/parameters.ts) désactivent l'élimination des faces arrière
 * sur le globe ; le module du trafic routier l'utilise encore pour ses disques.
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
