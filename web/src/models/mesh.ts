/**
 * Petit atelier de maquettes 3D, construites dans le code (pas de fichier à télécharger, pas
 * de licence) et dessinées par la `SimpleMeshLayer` de deck.gl, une instance par véhicule.
 *
 * Repère d'une maquette, en mètres réels : x vers l'avant (le nez), y vers la gauche, z vers
 * le haut ; l'origine est le point de référence du véhicule (le centre de l'avion, le milieu
 * de la voiture au niveau du rail…). `orientation()` tourne ce repère selon le cap.
 *
 * Les maquettes n'ont pas de normales : deck.gl éclaire alors chaque facette à plat (dérivées
 * de l'écran), ce qui donne le rendu « à facettes » voulu et dispense de les calculer. Les
 * sommets portent une couleur (0..1) multipliée par la couleur de l'instance : une pièce en
 * blanc (1, 1, 1) prend la couleur de la donnée (altitude, ligne…), une pièce grise la fonce.
 * Toutes les faces sont tournées dans le sens trigonométrique vues de l'extérieur.
 */

export type Vec3 = readonly [number, number, number];
/** Couleur de sommet, de 0 à 1. */
export type Tint = readonly [number, number, number];

export const WHITE: Tint = [1, 1, 1];

/** Maquette prête pour `SimpleMeshLayer.mesh` (triangles non indexés). */
export interface MeshData {
  attributes: {
    positions: { value: Float32Array; size: 3 };
    colors: { value: Float32Array; size: 3 };
  };
  /** Boîte englobante (m) : [[xmin, ymin, zmin], [xmax, ymax, zmax]]. */
  bounds: [Vec3, Vec3];
}

/** Section d'un fuseau (fuselage, coque, nacelle) : à l'abscisse `x`, demi-largeur `ry`, demi-hauteur `rz`, centre en `z`. */
export interface Section {
  x: number;
  ry: number;
  rz: number;
  z?: number;
  /** Décalage latéral du centre (nacelles). */
  y?: number;
}

export class MeshBuilder {
  private positions: number[] = [];
  private colors: number[] = [];

  /** Triangle a, b, c (sens trigonométrique vu de l'extérieur). */
  tri(a: Vec3, b: Vec3, c: Vec3, tint: Tint = WHITE): this {
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.colors.push(tint[0], tint[1], tint[2]);
    return this;
  }

  /** Quadrilatère a, b, c, d (dans l'ordre du tour, sens trigonométrique vu de l'extérieur). */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, tint: Tint = WHITE): this {
    return this.tri(a, b, c, tint).tri(a, c, d, tint);
  }

  /** Polygone convexe (éventail depuis le premier sommet). */
  fan(points: readonly Vec3[], tint: Tint = WHITE): this {
    for (let i = 1; i + 1 < points.length; i++) this.tri(points[0]!, points[i]!, points[i + 1]!, tint);
    return this;
  }

  /**
   * Prisme : un contour convexe dans le plan horizontal (x, y), tourné dans le sens trigonométrique
   * vu de dessus, extrudé de `z0` à `z1`. Sert aux caisses, aux superstructures, aux conteneurs…
   */
  prism(outline: ReadonlyArray<readonly [number, number]>, z0: number, z1: number, tint: Tint = WHITE, sides: Tint = tint): this {
    const top = outline.map(([x, y]) => [x, y, z1] as const);
    const bottom = outline.map(([x, y]) => [x, y, z0] as const).reverse();
    this.fan(top, tint);
    this.fan(bottom, sides);
    for (let i = 0; i < outline.length; i++) {
      const [x0, y0] = outline[i]!;
      const [x1, y1] = outline[(i + 1) % outline.length]!;
      this.quad([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1], sides);
    }
    return this;
  }

  /** Pavé centré en (cx, cy) dans le plan, de longueur `lx` (avant-arrière), largeur `ly`, de `z0` à `z1`. */
  box(cx: number, cy: number, lx: number, ly: number, z0: number, z1: number, tint: Tint = WHITE, sides: Tint = tint): this {
    const x0 = cx - lx / 2;
    const x1 = cx + lx / 2;
    const y0 = cy - ly / 2;
    const y1 = cy + ly / 2;
    return this.prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1, tint, sides);
  }

  /**
   * Fuseau : une suite de sections elliptiques le long de x, de l'avant vers l'arrière ou
   * l'inverse, reliées par des facettes ; une section de rayon nul fait une pointe. Les deux
   * bouts sont fermés.
   */
  loft(sections: readonly Section[], tint: Tint = WHITE, segments = 8): this {
    const ring = (s: Section) =>
      Array.from({ length: segments }, (_, k) => {
        const a = (2 * Math.PI * k) / segments;
        return [s.x, (s.y ?? 0) + s.ry * Math.cos(a), (s.z ?? 0) + s.rz * Math.sin(a)] as const;
      });
    const rings = sections.map(ring);
    // Sens : la normale extérieure dépend de l'ordre des x ; on l'inverse si les sections reculent.
    const forward = sections.length < 2 || sections[sections.length - 1]!.x >= sections[0]!.x;
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i]!;
      const b = rings[i + 1]!;
      for (let k = 0; k < segments; k++) {
        const k1 = (k + 1) % segments;
        if (forward) this.quad(a[k]!, b[k]!, b[k1]!, a[k1]!, tint);
        else this.quad(a[k]!, a[k1]!, b[k1]!, b[k]!, tint);
      }
    }
    const cap = (r: readonly Vec3[], flip: boolean) => {
      const pts = flip ? [...r].reverse() : r;
      this.fan(pts, tint);
    };
    if (sections[0]!.ry > 0 || sections[0]!.rz > 0) cap(rings[0]!, forward);
    const last = sections[sections.length - 1]!;
    if (last.ry > 0 || last.rz > 0) cap(rings[rings.length - 1]!, !forward);
    return this;
  }

  /**
   * Surface mince (aile, empennage, dérive) : un contour convexe a, b, c, d donné dans son plan
   * moyen, épaissi de `thickness` selon `normal` (vecteur unitaire). Le contour tourne dans le sens
   * trigonométrique vu du côté de `normal`.
   */
  plate(corners: readonly Vec3[], normal: Vec3, thickness: number, tint: Tint = WHITE): this {
    const h = thickness / 2;
    const up = corners.map(([x, y, z]) => [x + normal[0] * h, y + normal[1] * h, z + normal[2] * h] as const);
    const down = corners.map(([x, y, z]) => [x - normal[0] * h, y - normal[1] * h, z - normal[2] * h] as const);
    this.fan(up, tint);
    this.fan([...down].reverse(), tint);
    for (let i = 0; i < corners.length; i++) {
      const j = (i + 1) % corners.length;
      this.quad(down[i]!, down[j]!, up[j]!, up[i]!, tint);
    }
    return this;
  }

  /** Copie miroir (y → -y) de ce qui est ajouté par `draw` : une aile droite donne l'aile gauche. */
  mirrored(draw: (b: MeshBuilder) => void): this {
    const start = this.positions.length;
    draw(this);
    const end = this.positions.length;
    const colorStart = (start / 3) * 3;
    for (let i = start; i < end; i += 9) {
      // Le miroir retourne les faces : on échange deux sommets pour garder le bon sens.
      const a = this.positions.slice(i, i + 3);
      const b = this.positions.slice(i + 3, i + 6);
      const c = this.positions.slice(i + 6, i + 9);
      this.positions.push(a[0]!, -a[1]!, a[2]!, c[0]!, -c[1]!, c[2]!, b[0]!, -b[1]!, b[2]!);
    }
    this.colors.push(...this.colors.slice(colorStart, (end / 3) * 3));
    return this;
  }

  /** Ajoute une autre maquette, déplacée de `offset`. */
  add(other: MeshData, offset: Vec3 = [0, 0, 0]): this {
    const p = other.attributes.positions.value;
    for (let i = 0; i < p.length; i += 3) this.positions.push(p[i]! + offset[0], p[i + 1]! + offset[1], p[i + 2]! + offset[2]);
    this.colors.push(...other.attributes.colors.value);
    return this;
  }

  build(): MeshData {
    const value = new Float32Array(this.positions);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < value.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, value[i + k]!);
        max[k] = Math.max(max[k]!, value[i + k]!);
      }
    }
    return {
      attributes: {
        positions: { value, size: 3 },
        colors: { value: new Float32Array(this.colors), size: 3 },
      },
      bounds: [min as unknown as Vec3, max as unknown as Vec3],
    };
  }
}

/** Gris (0..1) : une pièce plus sombre que la couleur de la donnée. */
export const shade = (k: number): Tint => [k, k, k];

/** Couleur CSS « #rrggbb » en teinte de sommet (0..1). */
export function tint(hex: string): Tint {
  const n = Number.parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Orientation deck.gl ([tangage, lacet, roulis], en degrés) d'une maquette dont le nez est sur
 * x, pour un cap en degrés depuis le nord (sens horaire), une pente (degrés, positive en montée)
 * et une inclinaison latérale (degrés, positive vers la droite).
 */
export function orientation(heading: number, climb = 0, bank = 0): [number, number, number] {
  return [-climb, 90 - heading, bank];
}
