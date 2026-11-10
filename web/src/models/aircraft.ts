/**
 * Maquettes 3D des sept familles d'appareils (celles des silhouettes de planeIcons.ts, aux mêmes
 * cotes : longueur, envergure, flèche des ailes, place des moteurs), en mètres réels.
 *
 * Le fuselage, les ailes, les empennages et les nacelles prennent la couleur d'altitude de
 * l'avion (pièces blanches) ; moteurs et hélices sont plus sombres. Nez sur x, gauche sur y.
 */
import type { PlaneClass } from '../modules/planeIcons';
import { MeshBuilder, shade, type MeshData, type Section, type Tint, type Vec3 } from './mesh';

const ENGINE = shade(0.6);
const PROP = shade(0.28);
const WING = shade(0.93);

/** Profil du fuselage : [x (m, nez positif), demi-largeur (m)], du nez à la queue. */
type Profile = ReadonlyArray<readonly [number, number]>;

/** Surface portante d'un côté (gauche), en coordonnées de la maquette. */
interface Surface {
  /** Bord d'attaque et bord de fuite à l'emplanture (x), demi-envergure intérieure (y). */
  rootLead: number;
  rootTrail: number;
  rootY: number;
  /** Bord d'attaque et bord de fuite au saumon (x), demi-envergure (y). */
  tipLead: number;
  tipTrail: number;
  tipY: number;
  /** Hauteur à l'emplanture (m) et dièdre (degrés). */
  z: number;
  dihedral: number;
  thickness: number;
}

interface Fin {
  rootLead: number;
  rootTrail: number;
  tipLead: number;
  tipTrail: number;
  /** Bas et haut de la dérive (m). */
  z0: number;
  z1: number;
  thickness: number;
}

interface Nacelle {
  x: number;
  y: number;
  z: number;
  r: number;
  halfLength: number;
}

interface Spec {
  profile: Profile;
  /** Rapport hauteur / largeur du fuselage (pont supérieur, cabine haute…). */
  tall: number;
  wing: Surface;
  tail: Surface;
  fin: Fin;
  nacelles: readonly Nacelle[];
  /** Hélices : centre et rayon (disque face à l'avant). */
  props?: ReadonlyArray<{ x: number; y: number; z: number; r: number }>;
}

/** Fuselage : sections elliptiques, la queue relevée (le dessous remonte vers l'empennage), le nez un peu bas. */
function fuselage(b: MeshBuilder, profile: Profile, tall: number, tint: Tint): void {
  const nose = profile[0]![0];
  const tail = profile[profile.length - 1]![0];
  const length = nose - tail;
  const radius = Math.max(...profile.map(([, r]) => r));
  const sections: Section[] = profile.map(([x, r]) => {
    const t = (x - tail) / length; // 0 à la queue, 1 au nez
    const upsweep = t < 0.3 ? radius * 0.55 * (1 - t / 0.3) ** 1.5 : 0;
    const droop = t > 0.93 ? -radius * 0.18 * ((t - 0.93) / 0.07) : 0;
    return { x, ry: r, rz: r * tall, z: upsweep + droop };
  });
  b.loft(sections, tint, 10);
}

function surface(b: MeshBuilder, s: Surface, tint: Tint): void {
  const rise = (s.tipY - s.rootY) * Math.tan((s.dihedral * Math.PI) / 180);
  const corners: Vec3[] = [
    [s.rootLead, s.rootY, s.z],
    [s.tipLead, s.tipY, s.z + rise],
    [s.tipTrail, s.tipY, s.z + rise],
    [s.rootTrail, s.rootY, s.z],
  ];
  b.mirrored((m) => m.plate(corners, [0, 0, 1], s.thickness, tint));
}

function fin(b: MeshBuilder, f: Fin, tint: Tint): void {
  b.plate(
    [
      [f.rootLead, 0, f.z0],
      [f.tipLead, 0, f.z1],
      [f.tipTrail, 0, f.z1],
      [f.rootTrail, 0, f.z0],
    ],
    [0, 1, 0],
    f.thickness,
    tint,
  );
}

function nacelle(b: MeshBuilder, n: Nacelle): void {
  const draw = (m: MeshBuilder) =>
    m.loft(
      [
        { x: n.x + n.halfLength, y: n.y, z: n.z, ry: n.r * 0.82, rz: n.r * 0.82 },
        { x: n.x + n.halfLength * 0.75, y: n.y, z: n.z, ry: n.r, rz: n.r },
        { x: n.x - n.halfLength * 0.5, y: n.y, z: n.z, ry: n.r * 0.92, rz: n.r * 0.92 },
        { x: n.x - n.halfLength, y: n.y, z: n.z, ry: n.r * 0.5, rz: n.r * 0.5 },
      ],
      ENGINE,
      8,
    );
  if (n.y === 0) draw(b);
  else b.mirrored(draw);
}

/** Disque mince (hélice, rotor de queue) : centre, normale (axe) et rayon. */
function disc(b: MeshBuilder, center: Vec3, axis: 'x' | 'y', r: number, tint: Tint, thickness = 0.08): void {
  const corners: Vec3[] = Array.from({ length: 12 }, (_, k) => {
    const a = (2 * Math.PI * k) / 12;
    const u = r * Math.cos(a);
    const v = r * Math.sin(a);
    return axis === 'x' ? [center[0], center[1] + u, center[2] + v] : [center[0] + u, center[1], center[2] + v];
  });
  b.plate(corners, axis === 'x' ? [1, 0, 0] : [0, 1, 0], thickness, tint);
}

/*
 * Cotes reprises des silhouettes de la planche (planeIcons.ts) : le contour y donne x = -y de la
 * planche (le nez y est en haut) ; les hauteurs (dérive, place des ailes) viennent des plans des
 * appareils types (A320, A330, A380, ATR 72, CRJ, Cessna 172).
 */
const SPECS: Record<Exclude<PlaneClass, 'heli'>, Spec> = {
  narrow: {
    profile: [[18.8, 0], [18.2, 0.9], [16.8, 1.6], [14.5, 1.95], [3.2, 1.98], [-3.6, 1.98], [-10.5, 1.85], [-13.4, 1.3], [-17.4, 0.8], [-18.8, 0.4]],
    tall: 1.06,
    wing: { rootLead: 3.4, rootTrail: -3.6, rootY: 1, tipLead: -5.6, tipTrail: -7.1, tipY: 17.9, z: -1.2, dihedral: 5, thickness: 0.5 },
    tail: { rootLead: -13.4, rootTrail: -17.4, rootY: 0.6, tipLead: -17, tipTrail: -18.1, tipY: 6.4, z: 0.9, dihedral: 4, thickness: 0.25 },
    fin: { rootLead: -11.2, rootTrail: -18.2, tipLead: -16.6, tipTrail: -19.2, z0: 1.4, z1: 7.6, thickness: 0.35 },
    nacelles: [{ x: 1.4, y: 5.7, z: -2.0, r: 1.0, halfLength: 2.8 }],
  },
  wide: {
    profile: [[31.8, 0], [30.8, 1.5], [28.5, 2.7], [25, 3.1], [7.5, 3.1], [-6.5, 3.1], [-19, 3.0], [-24.5, 2.2], [-30.2, 1.2], [-31.8, 0.5]],
    tall: 1.05,
    wing: { rootLead: 7.6, rootTrail: -6.5, rootY: 1.5, tipLead: -9.5, tipTrail: -11.6, tipY: 32.4, z: -1.9, dihedral: 5, thickness: 0.8 },
    tail: { rootLead: -24.5, rootTrail: -30.2, rootY: 1, tipLead: -29.5, tipTrail: -31.2, tipY: 10.7, z: 1.6, dihedral: 4, thickness: 0.35 },
    fin: { rootLead: -20.5, rootTrail: -31.2, tipLead: -28.6, tipTrail: -32.6, z0: 2.3, z1: 12.4, thickness: 0.5 },
    nacelles: [{ x: 3.5, y: 9.8, z: -3.4, r: 1.9, halfLength: 4.6 }],
  },
  quad: {
    profile: [[38.1, 0], [37, 1.6], [34.5, 2.9], [30, 3.25], [9, 3.25], [-8.2, 3.25], [-24, 3.1], [-30, 2.3], [-36, 1.2], [-38.1, 0.5]],
    tall: 1.3,
    wing: { rootLead: 9.2, rootTrail: -8.2, rootY: 1.6, tipLead: -11, tipTrail: -13.2, tipY: 34.2, z: -2.6, dihedral: 5, thickness: 0.9 },
    tail: { rootLead: -30, rootTrail: -36, rootY: 1, tipLead: -35, tipTrail: -36.8, tipY: 11, z: 1.8, dihedral: 4, thickness: 0.35 },
    fin: { rootLead: -25.5, rootTrail: -37.4, tipLead: -34, tipTrail: -38.6, z0: 3, z1: 14.5, thickness: 0.55 },
    nacelles: [
      { x: 4.8, y: 11.6, z: -3.6, r: 1.5, halfLength: 3.9 },
      { x: -2.2, y: 21.2, z: -2.7, r: 1.4, halfLength: 3.6 },
    ],
  },
  turboprop: {
    profile: [[13.6, 0], [13, 0.8], [11.8, 1.3], [3.2, 1.4], [-0.4, 1.4], [-7, 1.2], [-10.6, 0.8], [-12.4, 0.5], [-13.6, 0.3]],
    tall: 1.1,
    wing: { rootLead: 3.2, rootTrail: -0.4, rootY: 0.4, tipLead: 2.6, tipTrail: 0.6, tipY: 13.5, z: 1.35, dihedral: 1.5, thickness: 0.35 },
    // Empennage en T, au sommet de la dérive.
    tail: { rootLead: -11.4, rootTrail: -13, rootY: 0, tipLead: -12, tipTrail: -13.2, tipY: 3.6, z: 5.6, dihedral: 0, thickness: 0.2 },
    fin: { rootLead: -7.4, rootTrail: -12.8, tipLead: -11.2, tipTrail: -13.3, z0: 0.9, z1: 5.7, thickness: 0.28 },
    nacelles: [{ x: 3.4, y: 4.1, z: 0.85, r: 0.75, halfLength: 2.6 }],
    props: [{ x: 6.1, y: 4.1, z: 0.85, r: 1.9 }],
  },
  bizjet: {
    profile: [[15.5, 0], [14.8, 0.8], [13.2, 1.3], [4, 1.4], [-2.2, 1.4], [-9, 1.35], [-12.8, 1.1], [-14.8, 0.6], [-15.5, 0.3]],
    tall: 1.08,
    wing: { rootLead: 4.1, rootTrail: -2.2, rootY: 0.6, tipLead: -3.4, tipTrail: -4.6, tipY: 11.5, z: -0.9, dihedral: 4, thickness: 0.3 },
    // Empennage en T et réacteurs à l'arrière du fuselage.
    tail: { rootLead: -13.6, rootTrail: -15.4, rootY: 0, tipLead: -15, tipTrail: -16, tipY: 3.3, z: 4.6, dihedral: 0, thickness: 0.2 },
    fin: { rootLead: -9.6, rootTrail: -15, tipLead: -13.6, tipTrail: -15.9, z0: 0.9, z1: 4.7, thickness: 0.28 },
    nacelles: [{ x: -9.4, y: 2.45, z: 0.55, r: 0.85, halfLength: 2.4 }],
  },
  light: {
    profile: [[4.15, 0.25], [4, 0.45], [2.9, 0.55], [1.2, 0.6], [-0.35, 0.55], [-2.9, 0.3], [-4.15, 0.2]],
    tall: 1.55,
    wing: { rootLead: 1.2, rootTrail: -0.35, rootY: 0, tipLead: 1.1, tipTrail: -0.35, tipY: 5.5, z: 0.95, dihedral: 1.5, thickness: 0.18 },
    tail: { rootLead: -2.9, rootTrail: -3.9, rootY: 0.2, tipLead: -3.3, tipTrail: -3.9, tipY: 1.7, z: 0.2, dihedral: 0, thickness: 0.1 },
    fin: { rootLead: -2.6, rootTrail: -4, tipLead: -3.6, tipTrail: -4.2, z0: 0.3, z1: 1.7, thickness: 0.12 },
    nacelles: [],
    props: [{ x: 4.3, y: 0, z: 0, r: 0.95 }],
  },
};

function airplane(spec: Spec): MeshData {
  const b = new MeshBuilder();
  fuselage(b, spec.profile, spec.tall, [1, 1, 1]);
  surface(b, spec.wing, WING);
  surface(b, spec.tail, WING);
  fin(b, spec.fin, [1, 1, 1]);
  for (const n of spec.nacelles) nacelle(b, n);
  for (const p of spec.props ?? []) {
    const draw = (m: MeshBuilder) => disc(m, [p.x, p.y, p.z], 'x', p.r, PROP);
    if (p.y === 0) draw(b);
    else b.mirrored(draw);
  }
  return b.build();
}

/** Hélicoptère léger (EC135, H145) : cabine en goutte, poutre de queue, patins, rotor en croix. */
function helicopter(): MeshData {
  const b = new MeshBuilder();
  b.loft(
    [
      { x: 3.6, ry: 0.12, rz: 0.12, z: -0.15 },
      { x: 3.0, ry: 0.8, rz: 0.9, z: 0 },
      { x: 1.5, ry: 1.1, rz: 1.25, z: 0.1 },
      { x: -0.6, ry: 1.0, rz: 1.15, z: 0.15 },
      { x: -1.7, ry: 0.45, rz: 0.55, z: 0.4 },
      { x: -6.3, ry: 0.2, rz: 0.24, z: 0.55 },
    ],
    [1, 1, 1],
    10,
  );
  // Dérive et petit empennage.
  b.plate([[-5.4, 0, 0.5], [-6.1, 0, 1.7], [-6.6, 0, 1.7], [-6.5, 0, 0.4]], [0, 1, 0], 0.12, [1, 1, 1]);
  b.mirrored((m) => m.plate([[-5, 0.15, 0.55], [-5.2, 1.1, 0.55], [-5.6, 1.1, 0.55], [-5.6, 0.15, 0.55]], [0, 0, 1], 0.08, WING));
  // Patins.
  b.mirrored((m) => m.box(0.4, 0.95, 3.6, 0.12, -1.55, -1.43, ENGINE));
  b.mirrored((m) => m.box(1.2, 0.85, 0.12, 0.12, -1.45, -0.9, ENGINE));
  b.mirrored((m) => m.box(-0.8, 0.85, 0.12, 0.12, -1.45, -0.9, ENGINE));
  // Mât et rotor principal (pales en croix), rotor de queue.
  b.box(0.2, 0, 0.5, 0.5, 1.2, 1.75, ENGINE);
  b.box(0.2, 0, 10.8, 0.32, 1.75, 1.83, PROP);
  b.box(0.2, 0, 0.32, 10.8, 1.75, 1.83, PROP);
  disc(b, [-6.2, 0.3, 1.0], 'y', 0.9, PROP, 0.06);
  return b.build();
}

let cache: Record<PlaneClass, MeshData> | undefined;

/** Hauteur du point de référence au-dessus du sol quand l'appareil est posé (m, à l'échelle 1) : son point le plus bas, plus le train. */
export function groundClearance(cls: PlaneClass): number {
  const mesh = aircraftMeshes()[cls];
  return -mesh.bounds[0][2] + (cls === 'heli' ? 0 : 0.8);
}

/** Maquette de chaque famille d'appareil (construite une fois). */
export function aircraftMeshes(): Record<PlaneClass, MeshData> {
  cache ??= {
    narrow: airplane(SPECS.narrow),
    wide: airplane(SPECS.wide),
    quad: airplane(SPECS.quad),
    turboprop: airplane(SPECS.turboprop),
    bizjet: airplane(SPECS.bizjet),
    light: airplane(SPECS.light),
    heli: helicopter(),
  };
  return cache;
}
