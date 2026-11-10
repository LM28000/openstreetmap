/**
 * Maquettes 3D des véhicules de transport urbain, en mètres réels : bus (12 m), bus articulé
 * (18 m, soufflet visible), tramway (rame de 34 m en cinq éléments, plancher bas, pantographe)
 * et métro (rame de trois voitures de 13 m). C'est le bus articulé qui sert aux modes « autres »
 * (train, bateau, câble), comme la silhouette à deux éléments des symboles à plat.
 *
 * La caisse, le toit et les jupes prennent la couleur de la ligne (pièces blanches) ; la bande
 * vitrée, le dessous, les roues, le soufflet et le pantographe sont sombres, pour que le tout se
 * lise comme un véhicule quelle que soit la couleur de la ligne. Nez sur x, gauche sur y, z vers le
 * haut ; l'origine est au milieu du véhicule, au niveau de la chaussée ou du rail.
 */
import type { Kind } from '../modules/transitIcons';
import { MeshBuilder, shade, type MeshData, type Tint, type Vec3 } from './mesh';

const WHITE_BODY: Tint = [1, 1, 1];
const GLASS = shade(0.1);
const UNDER = shade(0.12);
const TYRE = shade(0.07);
const RUBBER = shade(0.2);
const ROOF = shade(0.86);
const EQUIPMENT = shade(0.62);
const WHITE_LIGHT: Tint = [1, 1, 0.82];

/** Section rectangulaire d'une caisse à l'abscisse `x` : demi-largeur, bas et haut. */
interface Slice {
  x: number;
  hw: number;
  z0: number;
  z1: number;
}

/**
 * Caisse : des sections rectangulaires reliées par des facettes (avant arrondi par une première
 * section plus étroite et plus basse). L'avant (`front`) et l'arrière (`rear`) sont fermés d'une
 * teinte propre : le pare-brise sombre à l'avant d'une tête de rame, la couleur de la ligne ailleurs.
 */
function hull(b: MeshBuilder, slices: readonly Slice[], body: Tint, front: Tint = body, rear: Tint = body, roof: Tint = body): void {
  const corners = (s: Slice): Vec3[] => [
    [s.x, -s.hw, s.z0],
    [s.x, s.hw, s.z0],
    [s.x, s.hw, s.z1],
    [s.x, -s.hw, s.z1],
  ];
  for (let i = 0; i + 1 < slices.length; i++) {
    const a = corners(slices[i]!);
    const c = corners(slices[i + 1]!);
    b.quad(a[0]!, c[0]!, c[1]!, a[1]!, UNDER); // dessous
    b.quad(a[3]!, a[2]!, c[2]!, c[3]!, roof); // toit
    b.quad(a[1]!, c[1]!, c[2]!, a[2]!, body); // flanc gauche
    b.quad(a[0]!, a[3]!, c[3]!, c[0]!, body); // flanc droit
  }
  b.fan(corners(slices[0]!), front);
  b.fan(corners(slices[slices.length - 1]!).reverse(), rear);
}

/** Bande vitrée collée aux deux flancs, entre deux abscisses et deux hauteurs. */
function windows(b: MeshBuilder, x0: number, x1: number, hw: number, z0: number, z1: number): void {
  for (const side of [-1, 1]) {
    const y = side * (hw + 0.025);
    b.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], GLASS);
  }
}

/** Roue : un cylindre à huit pans, d'axe y, centré en (x, z). */
function wheel(b: MeshBuilder, x: number, y: number, z: number, r: number, width: number): void {
  const n = 8;
  const ring = (yy: number) =>
    Array.from({ length: n }, (_, k) => {
      const a = (2 * Math.PI * k) / n;
      return [x + r * Math.cos(a), yy, z + r * Math.sin(a)] as Vec3;
    });
  const a = ring(y - width / 2);
  const c = ring(y + width / 2);
  b.fan(a, TYRE).fan([...c].reverse(), TYRE);
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    b.quad(a[k]!, a[k1]!, c[k1]!, c[k]!, TYRE);
  }
}

/** Les deux roues (gauche et droite) d'un essieu, un peu sorties du flanc. */
function axle(b: MeshBuilder, x: number, hw: number, r: number, width = 0.32): void {
  for (const side of [-1, 1]) wheel(b, x, side * (hw - width / 2 + 0.02), r, r, width);
}

/** Feux avant : deux petits plots clairs sur la face avant. */
function headlights(b: MeshBuilder, x: number, hw: number, z: number): void {
  for (const side of [-1, 1]) b.box(x, side * hw * 0.68, 0.06, 0.34, z, z + 0.16, WHITE_LIGHT);
}

/** Groupe de climatisation sur le toit d'un bus ou d'une voiture de métro. */
function roofUnit(b: MeshBuilder, x: number, length: number, width: number, top: number, height = 0.28): void {
  b.box(x, 0, length, width, top, top + height, EQUIPMENT, EQUIPMENT);
}

/** Caisse de bus : 2,55 m de large, 3,0 m de haut, nez légèrement incliné. */
function busBox(b: MeshBuilder, x0: number, x1: number, opts: { front?: boolean; rear?: boolean } = {}): void {
  const hw = 1.275;
  const z0 = 0.42;
  const z1 = 3.0;
  const slices: Slice[] = [];
  if (opts.front) slices.push({ x: x1, hw: hw - 0.08, z0: z0 + 0.1, z1: z1 - 0.28 });
  slices.push({ x: opts.front ? x1 - 0.28 : x1, hw, z0, z1 });
  slices.push({ x: opts.rear ? x0 + 0.22 : x0, hw, z0, z1 });
  if (opts.rear) slices.push({ x: x0, hw: hw - 0.05, z0: z0 + 0.05, z1: z1 - 0.1 });
  hull(b, slices, WHITE_BODY, opts.front ? GLASS : WHITE_BODY, WHITE_BODY, ROOF);
  windows(b, x0 + (opts.rear ? 0.5 : 0.2), x1 - (opts.front ? 0.45 : 0.2), hw, 1.05, 2.5);
  // Jupe basse sombre : le dessous de caisse se voit entre les roues.
  b.box((x0 + x1) / 2, 0, x1 - x0 - 0.6, 2.0, 0.22, z0 + 0.04, UNDER);
}

function standardBus(): MeshData {
  const b = new MeshBuilder();
  busBox(b, -6, 6, { front: true, rear: true });
  roofUnit(b, -2.2, 3.2, 1.5, 3.0);
  headlights(b, 6.0, 1.275, 0.62);
  axle(b, 3.6, 1.275, 0.52);
  axle(b, -3.1, 1.275, 0.52);
  return b.build();
}

/** Bus articulé : deux caisses de 8,3 m et 8,9 m reliées par un soufflet de 0,8 m (18 m en tout). */
function articulatedBus(): MeshData {
  const b = new MeshBuilder();
  busBox(b, 0.4, 9, { front: true });
  busBox(b, -9, -0.4, { rear: true });
  // Soufflet : plus étroit, noir, un peu plus bas que le toit.
  hull(
    b,
    [
      { x: 0.42, hw: 1.2, z0: 0.5, z1: 2.9 },
      { x: -0.42, hw: 1.2, z0: 0.5, z1: 2.9 },
    ],
    RUBBER,
    RUBBER,
    RUBBER,
    RUBBER,
  );
  roofUnit(b, 5, 3.0, 1.5, 3.0);
  roofUnit(b, -5, 3.0, 1.5, 3.0);
  headlights(b, 9.0, 1.275, 0.62);
  axle(b, 6.6, 1.275, 0.52);
  axle(b, -6.5, 1.275, 0.52);
  axle(b, -2.4, 1.275, 0.52);
  return b.build();
}

/** Caisse de tram ou de métro : plancher bas (tram), bande vitrée continue, tête en biseau. */
function railBody(
  b: MeshBuilder,
  x0: number,
  x1: number,
  o: { hw: number; z0: number; z1: number; front?: boolean; rear?: boolean; glass: [number, number]; skirt?: boolean },
): void {
  const slices: Slice[] = [];
  const run = 0.9; // longueur du biseau de tête
  if (o.front) slices.push({ x: x1, hw: o.hw - 0.3, z0: o.z0 + 0.15, z1: o.z1 - 0.55 });
  slices.push({ x: o.front ? x1 - run : x1, hw: o.hw, z0: o.z0, z1: o.z1 });
  slices.push({ x: o.rear ? x0 + run : x0, hw: o.hw, z0: o.z0, z1: o.z1 });
  if (o.rear) slices.push({ x: x0, hw: o.hw - 0.3, z0: o.z0 + 0.15, z1: o.z1 - 0.55 });
  hull(b, slices, WHITE_BODY, o.front ? GLASS : WHITE_BODY, o.rear ? GLASS : WHITE_BODY, ROOF);
  windows(b, x0 + (o.rear ? run + 0.3 : 0.25), x1 - (o.front ? run + 0.3 : 0.25), o.hw, o.glass[0], o.glass[1]);
  if (o.skirt !== false) b.box((x0 + x1) / 2, 0, x1 - x0 - 0.5, o.hw * 1.7, o.z0 - 0.18, o.z0 + 0.04, UNDER);
}

/** Pantographe : base sur le toit, deux bras en V relevés, archet transversal. */
function pantograph(b: MeshBuilder, x: number, roof: number): void {
  const top = roof + 1.0;
  b.box(x, 0, 1.3, 1.0, roof, roof + 0.16, UNDER);
  for (const side of [-1, 1]) {
    const y = side * 0.32;
    b.plate(
      [
        [x - 0.55, y, roof + 0.16],
        [x - 0.45, y, roof + 0.16],
        [x + 0.05, y, top],
        [x - 0.05, y, top],
      ],
      [0, 1, 0],
      0.06,
      UNDER,
    );
    b.plate(
      [
        [x + 0.55, y, roof + 0.16],
        [x + 0.45, y, roof + 0.16],
        [x - 0.05, y, top],
        [x + 0.05, y, top],
      ],
      [0, 1, 0],
      0.06,
      UNDER,
    );
  }
  b.box(x, 0, 0.12, 1.9, top, top + 0.06, UNDER);
}

/** Bogie : un châssis bas et sombre avec ses roues, caché sous la jupe. */
function bogie(b: MeshBuilder, x: number, hw: number): void {
  b.box(x, 0, 2.4, hw * 1.5, 0.12, 0.5, UNDER);
  axle(b, x - 0.8, hw - 0.1, 0.34, 0.2);
  axle(b, x + 0.8, hw - 0.1, 0.34, 0.2);
}

/** Tramway : cinq éléments de 2,4 m de large, 3,3 m de haut, plancher à 0,35 m ; 34 m en tout. */
function tram(): MeshData {
  const b = new MeshBuilder();
  const lengths = [7, 6, 6, 6, 7];
  const gap = 0.5;
  const total = lengths.reduce((a, c) => a + c, 0) + gap * (lengths.length - 1);
  let x = total / 2;
  const hw = 1.2;
  lengths.forEach((len, i) => {
    const x1 = x;
    const x0 = x - len;
    railBody(b, x0, x1, { hw, z0: 0.36, z1: 3.3, front: i === 0, rear: i === lengths.length - 1, glass: [0.95, 2.55] });
    if (i === 1 || i === 3) pantograph(b, (x0 + x1) / 2, 3.3);
    if (i === 2) roofUnit(b, (x0 + x1) / 2, 3.4, 1.4, 3.3, 0.3);
    // Bogies : sous les éléments de tête (côté de la jonction) et les éléments du milieu.
    if (i === 0) bogie(b, x0 + 1.4, hw);
    else if (i === lengths.length - 1) bogie(b, x1 - 1.4, hw);
    else bogie(b, (x0 + x1) / 2, hw);
    // Soufflet entre deux éléments.
    if (i < lengths.length - 1) {
      hull(
        b,
        [
          { x: x0 - 0.02, hw: hw - 0.08, z0: 0.45, z1: 3.15 },
          { x: x0 - gap + 0.02, hw: hw - 0.08, z0: 0.45, z1: 3.15 },
        ],
        RUBBER,
        RUBBER,
        RUBBER,
        RUBBER,
      );
    }
    x = x0 - gap;
  });
  headlights(b, total / 2 + 0.0, 1.0, 0.7);
  return b.build();
}

/** Métro : trois voitures de 13 m (2,45 m de large, 3,5 m de haut), accouplées par un intercirculation noir. */
function metro(): MeshData {
  const b = new MeshBuilder();
  const len = 13;
  const gap = 0.35;
  const cars = 3;
  const total = cars * len + (cars - 1) * gap;
  let x = total / 2;
  const hw = 1.225;
  for (let i = 0; i < cars; i++) {
    const x1 = x;
    const x0 = x - len;
    railBody(b, x0, x1, { hw, z0: 0.55, z1: 3.5, front: i === 0, rear: i === cars - 1, glass: [1.0, 2.6] });
    roofUnit(b, (x0 + x1) / 2, 4.5, 1.7, 3.5, 0.3);
    bogie(b, x0 + 2.6, hw);
    bogie(b, x1 - 2.6, hw);
    if (i < cars - 1) {
      hull(
        b,
        [
          { x: x0 - 0.02, hw: hw - 0.12, z0: 0.65, z1: 3.3 },
          { x: x0 - gap + 0.02, hw: hw - 0.12, z0: 0.65, z1: 3.3 },
        ],
        RUBBER,
        RUBBER,
        RUBBER,
        RUBBER,
      );
    }
    x = x0 - gap;
  }
  headlights(b, total / 2, 1.0, 0.8);
  return b.build();
}

/** Longueur réelle (m) de chaque maquette : sert à la taille minimale à l'écran et à l'anneau de sélection. */
export const TRANSIT_LENGTH: Record<Kind, number> = { bus: 12, other: 18, tram: 34, metro: 40.7 };

let cache: Record<Kind, MeshData> | undefined;

/** Les maquettes, construites une fois. */
export function transitMeshes(): Record<Kind, MeshData> {
  cache ??= { bus: standardBus(), other: articulatedBus(), tram: tram(), metro: metro() };
  return cache;
}
