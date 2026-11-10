/**
 * Maquettes 3D des navires : une par type de coque de shipIcons.ts (cargo, pétrolier, ferry,
 * pêche, voilier, plaisance, remorqueur, service) plus un paquebot, variante du ferry quand le
 * navire est très long. Chaque maquette est construite à la longueur et à la largeur courantes
 * de son type (`REFERENCE`) ; la couche l'étire sur la longueur et la largeur que l'AIS donne.
 *
 * Repère : x vers la proue, y à bâbord, z vers le haut, la ligne de flottaison à z = 0. La coque
 * plonge sous la mer (tirant d'eau) : sur la mer plate à 0 m, le relief du fond de carte cache
 * cette partie, et la flottaison se dessine d'elle-même.
 *
 * Les couleurs sont cuites dans les sommets (la couche prend une couleur d'instance blanche).
 * Le code des familles (marchandises rouge, passagers ambre, petits bateaux vert d'eau, gris
 * pour le reste) est tenu par la couleur de la coque ou, sur les coques blanches, par la bande
 * et la cheminée ; les superstructures sont blanches, la mer reste calme.
 */
import { MeshBuilder, tint, type MeshData, type Tint } from "./mesh";
import {
  NOMINAL_LENGTH,
  BEAM_RATIO,
  type ShipType,
} from "../modules/shipIcons";

export type ShipModel = ShipType | "croisiere";
export const SHIP_MODELS: readonly ShipModel[] = [
  "cargo",
  "tanker",
  "ferry",
  "croisiere",
  "peche",
  "voilier",
  "plaisance",
  "remorqueur",
  "service",
];

/** Longueur et largeur (m) à laquelle chaque maquette est construite. */
export const REFERENCE: Record<ShipModel, { length: number; beam: number }> = {
  cargo: {
    length: NOMINAL_LENGTH.cargo,
    beam: NOMINAL_LENGTH.cargo * BEAM_RATIO.cargo,
  },
  tanker: {
    length: NOMINAL_LENGTH.tanker,
    beam: NOMINAL_LENGTH.tanker * BEAM_RATIO.tanker,
  },
  ferry: {
    length: NOMINAL_LENGTH.ferry,
    beam: NOMINAL_LENGTH.ferry * BEAM_RATIO.ferry,
  },
  croisiere: { length: 250, beam: 32 },
  peche: {
    length: NOMINAL_LENGTH.peche,
    beam: NOMINAL_LENGTH.peche * BEAM_RATIO.peche,
  },
  voilier: {
    length: NOMINAL_LENGTH.voilier,
    beam: NOMINAL_LENGTH.voilier * BEAM_RATIO.voilier,
  },
  plaisance: {
    length: NOMINAL_LENGTH.plaisance,
    beam: NOMINAL_LENGTH.plaisance * BEAM_RATIO.plaisance,
  },
  remorqueur: {
    length: NOMINAL_LENGTH.remorqueur,
    beam: NOMINAL_LENGTH.remorqueur * BEAM_RATIO.remorqueur,
  },
  service: {
    length: NOMINAL_LENGTH.service,
    beam: NOMINAL_LENGTH.service * BEAM_RATIO.service,
  },
};

/** Un paquebot : un ferry de plus de cette longueur (m). */
export const CRUISE_MIN_LENGTH = 190;

const WHITE_SUPERSTRUCTURE = tint("#eef0f2");
const GLASS = tint("#26313f");
const DARK = tint("#2a2f38");
const GREY = tint("#8b9099");
const UNDER = tint("#4a2b2b");

type Pt = readonly [number, number];

/** Contour de pont convexe, tourné dans le sens trigonométrique vu de dessus, de la proue vers bâbord puis tribord. */
function outline(
  length: number,
  beam: number,
  bow: number,
  stern: number,
  sternWidth: number,
): Pt[] {
  const h = beam / 2;
  const front = length / 2;
  const bowLen = length * bow;
  const aft = -length / 2;
  const left: Pt[] = [
    [front, 0],
    [front - bowLen * 0.3, h * 0.5],
    [front - bowLen * 0.7, h * 0.88],
    [front - bowLen, h],
    [aft + length * stern, h],
    [aft, h * sternWidth],
  ];
  const right: Pt[] = left
    .slice(1)
    .reverse()
    .map(([x, y]) => [x, -y] as const);
  return [...left, ...right];
}

/** Une couche de la coque : à la hauteur `z`, le contour mis à l'échelle ; `tint` est celle de la bande qui est dessous. */
interface Ring {
  z: number;
  kx: number;
  ky: number;
  tint: Tint;
}

interface HullSpec {
  length: number;
  beam: number;
  bow: number;
  stern: number;
  sternWidth: number;
  freeboard: number;
  draft: number;
  /** Bordé au-dessus de la flottaison ; `stripe` (facultatif) : bande en haut du bordé. */
  side: Tint;
  stripe?: Tint;
  deck: Tint;
}

/** Coque : pont, bordé, œuvres vives (sous la flottaison). */
function hull(b: MeshBuilder, s: HullSpec): number {
  const base = outline(s.length, s.beam, s.bow, s.stern, s.sternWidth);
  const stripeZ = s.freeboard * 0.62;
  const rings: Ring[] = [
    { z: s.freeboard, kx: 1, ky: 1, tint: s.stripe ?? s.side },
    ...(s.stripe ? [{ z: stripeZ, kx: 1, ky: 1 - 0.02, tint: s.side }] : []),
    { z: 0, kx: 1, ky: 0.97, tint: UNDER },
    { z: -s.draft, kx: 0.9, ky: 0.5, tint: UNDER },
  ];
  const at = (r: Ring) =>
    base.map(([x, y]) => [x * r.kx, y * r.ky, r.z] as const);
  const levels = rings.map(at);
  b.fan(levels[0]!, s.deck);
  for (let r = 0; r + 1 < levels.length; r++) {
    const up = levels[r]!;
    const down = levels[r + 1]!;
    for (let i = 0; i < up.length; i++) {
      const j = (i + 1) % up.length;
      b.quad(down[i]!, down[j]!, up[j]!, up[i]!, rings[r]!.tint);
    }
  }
  b.fan([...levels[levels.length - 1]!].reverse(), UNDER);
  return s.freeboard;
}

/** Pavé sans fond (un conteneur, une caisse posée sur le pont). */
function crate(
  b: MeshBuilder,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  z0: number,
  z1: number,
  top: Tint,
  sides: Tint = top,
): void {
  const x0 = cx - lx / 2;
  const x1 = cx + lx / 2;
  const y0 = cy - ly / 2;
  const y1 = cy + ly / 2;
  b.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], top);
  b.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], sides);
  b.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], sides);
  b.quad([x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], sides);
  b.quad([x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], sides);
}

/** Toit légèrement plus clair que les flancs : donne du relief aux pavés. */
const lighter = (t: Tint): Tint => [
  Math.min(1, t[0] * 1.12 + 0.03),
  Math.min(1, t[1] * 1.12 + 0.03),
  Math.min(1, t[2] * 1.12 + 0.03),
];

/** Superstructure : un pavé blanc et, en bande, ses fenêtres (un peu en saillie). */
function house(
  b: MeshBuilder,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  z0: number,
  z1: number,
  body: Tint = WHITE_SUPERSTRUCTURE,
): void {
  crate(b, cx, cy, lx, ly, z0, z1, lighter(body), body);
  const h = z1 - z0;
  b.box(cx, cy, lx + 0.14, ly + 0.14, z0 + h * 0.3, z0 + h * 0.72, GLASS);
}

/** Cheminée : un pavé et un chapeau de couleur de famille. */
function funnel(
  b: MeshBuilder,
  cx: number,
  cy: number,
  lx: number,
  ly: number,
  z0: number,
  z1: number,
  body: Tint,
  cap: Tint,
): void {
  crate(b, cx, cy, lx, ly, z0, z1, DARK, body);
  b.box(cx, cy, lx + 0.1, ly + 0.1, z1 - (z1 - z0) * 0.22, z1, cap);
}

/** Mât fin : un pavé étroit. */
function mast(
  b: MeshBuilder,
  x: number,
  y: number,
  z0: number,
  z1: number,
  w = 0.4,
  color: Tint = GREY,
): void {
  b.box(x, y, w, w, z0, z1, color);
}

// --- Cargo ---

/** Couleurs de conteneurs, atténuées pour ne pas faire un arc-en-ciel sur la mer. */
const CONTAINER_COLORS = [
  "#b5503c",
  "#2f4f6f",
  "#7a8793",
  "#c9a24a",
  "#3f6b5c",
  "#8a3b3b",
  "#d8d4c8",
  "#566a85",
].map(tint);

/** Hachage déterministe, pour répartir les couleurs sans hasard. */
const hash = (a: number, b: number) => ((a * 73856093) ^ (b * 19349663)) >>> 0;

function cargo(): MeshData {
  const { length: L, beam: B } = REFERENCE.cargo;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.16,
    stern: 0.05,
    sternWidth: 0.82,
    freeboard: 11,
    draft: 9,
    side: tint("#9a2b2e"),
    deck: tint("#5f6460"),
  });
  const bridgeX = -L / 2 + 0.22 * L;
  // Passerelle : un bloc blanc, un pont de timonerie plus étroit, la cheminée derrière.
  house(b, bridgeX, 0, 13, B * 0.82, fb, fb + 17);
  house(b, bridgeX + 1, 0, 8, B * 0.84, fb + 17, fb + 21);
  funnel(
    b,
    bridgeX - 12,
    0,
    8,
    7,
    fb,
    fb + 25,
    tint("#d9dde2"),
    tint("#9a2b2e"),
  );
  // Conteneurs : des travées de 12 m, six piles de large, des hauteurs variées (plus haut au milieu).
  const stacks = (x0: number, x1: number, seed: number) => {
    const bays = Math.max(1, Math.round((x1 - x0) / 12.5));
    const bay = (x1 - x0) / bays;
    const colW = (B * 0.88) / 6;
    for (let i = 0; i < bays; i++) {
      for (let j = 0; j < 6; j++) {
        const h = hash(i + seed, j);
        const tiers = 3 + ((h >> 3) % 3) - (j === 0 || j === 5 ? 1 : 0);
        const color = CONTAINER_COLORS[h % CONTAINER_COLORS.length]!;
        crate(
          b,
          x0 + bay * (i + 0.5),
          (j - 2.5) * colW,
          bay - 0.7,
          colW - 0.25,
          fb,
          fb + tiers * 2.6,
          lighter(color),
          color,
        );
      }
    }
  };
  stacks(bridgeX + 8, L / 2 - 0.15 * L, 0);
  stacks(-L / 2 + 6, bridgeX - 18, 40);
  // Gaillard avant : un petit mât de pavillon et le guindeau.
  mast(b, L / 2 - 0.08 * L, 0, fb, fb + 6, 0.6);
  return b.build();
}

// --- Pétrolier ---

function tanker(): MeshData {
  const { length: L, beam: B } = REFERENCE.tanker;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.12,
    stern: 0.05,
    sternWidth: 0.85,
    freeboard: 6,
    draft: 11,
    side: tint("#7d2b2d"),
    deck: tint("#4e5249"),
  });
  const aft = -L / 2 + 0.11 * L;
  house(b, aft, 0, 15, B * 0.7, fb, fb + 9);
  house(b, aft + 1, 0, 11, B * 0.66, fb + 9, fb + 14);
  house(b, aft + 1.5, 0, 7, B * 0.5, fb + 14, fb + 17);
  funnel(b, aft - 9, 0, 6, 6, fb, fb + 19, tint("#c9cdd2"), tint("#7d2b2d"));
  // Tuyauterie : une grosse conduite sur l'axe, des collecteurs en travers, des trappes de citerne de chaque côté.
  const x0 = aft + 14;
  const x1 = L / 2 - 0.12 * L;
  crate(
    b,
    (x0 + x1) / 2,
    0,
    x1 - x0,
    1.1,
    fb + 1.5,
    fb + 2.6,
    tint("#8a8f95"),
    tint("#6c7177"),
  );
  for (let x = x0 + 6; x < x1 - 4; x += 14) {
    crate(
      b,
      x,
      0,
      1.2,
      B * 0.5,
      fb + 0.6,
      fb + 1.6,
      tint("#8a8f95"),
      tint("#6c7177"),
    );
    for (const s of [-1, 1])
      crate(
        b,
        x + 6,
        s * B * 0.27,
        5,
        4,
        fb,
        fb + 0.9,
        tint("#6b6f66"),
        tint("#585c54"),
      );
  }
  // Passerelle de coursive sur la conduite, au milieu : un manifold plus haut.
  crate(
    b,
    (x0 + x1) / 2,
    0,
    7,
    B * 0.4,
    fb,
    fb + 2.4,
    tint("#7b8087"),
    tint("#656a70"),
  );
  mast(b, L / 2 - 0.07 * L, 0, fb, fb + 8, 0.6);
  return b.build();
}

// --- Passagers ---

function ferry(): MeshData {
  const { length: L, beam: B } = REFERENCE.ferry;
  const b = new MeshBuilder();
  // Coque haute et large, étrave droite : un ro-ro.
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.1,
    stern: 0.04,
    sternWidth: 0.92,
    freeboard: 9,
    draft: 6,
    side: tint("#a56b0a"),
    stripe: tint("#eef0f2"),
    deck: tint("#c8ccd0"),
  });
  const xa = -L / 2 + 4;
  const xb = L / 2 - 14;
  // Pont des garages, deux ponts de cabines, la passerelle sur l'avant, une cheminée ambre.
  house(b, (xa + xb) / 2 - 2, 0, xb - xa - 4, B * 0.94, fb, fb + 4.2);
  house(b, (xa + xb) / 2 - 8, 0, xb - xa - 20, B * 0.9, fb + 4.2, fb + 8.2);
  house(b, -18, 0, 52, B * 0.72, fb + 8.2, fb + 11.8);
  house(b, L / 2 - 28, 0, 9, B * 0.94, fb + 8.2, fb + 12.4);
  house(b, L / 2 - 27.5, 0, 6, B * 0.6, fb + 12.4, fb + 15.4);
  funnel(b, -34, 0, 9, 7, fb + 11.8, fb + 19, tint("#e4e6ea"), tint("#a56b0a"));
  mast(b, L / 2 - 28, 0, fb + 15.4, fb + 21, 0.5);
  return b.build();
}

function cruise(): MeshData {
  const { length: L, beam: B } = REFERENCE.croisiere;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.16,
    stern: 0.07,
    sternWidth: 0.8,
    freeboard: 9,
    draft: 8,
    side: tint("#eef0f2"),
    stripe: tint("#eef0f2"),
    deck: tint("#c9ccd0"),
  });
  // Un fin liseré ambre sur le bordé : la famille « passagers ».
  b.box(-4, 0, L * 0.7, B * 0.985, 3.2, 4.2, tint("#a56b0a"));
  const x0 = -L / 2 + 14;
  const x1 = L / 2 - 28;
  let z = fb;
  for (let k = 0; k < 7; k++) {
    const shrink = k < 3 ? 0.92 - k * 0.02 : 0.84 - (k - 3) * 0.09;
    house(
      b,
      (x0 + x1) / 2 - k * 1.5,
      0,
      x1 - x0 - 10 - k * 3,
      B * shrink,
      z,
      z + 3.3,
    );
    z += 3.3;
  }
  // Passerelle large sur l'avant du bloc, cheminées ambre au milieu et à l'arrière.
  house(b, x1 - 6, 0, 8, B * 0.96, fb + 9.9, fb + 13.4);
  funnel(b, -22, 0, 12, 10, z - 3, z + 8, tint("#e4e6ea"), tint("#a56b0a"));
  funnel(b, -48, 0, 9, 8, z - 6, z + 3, tint("#e4e6ea"), tint("#a56b0a"));
  mast(b, x1 - 6, 0, fb + 13.4, fb + 20, 0.5);
  return b.build();
}

// --- Petits bateaux ---

function fishing(): MeshData {
  const { length: L, beam: B } = REFERENCE.peche;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.2,
    stern: 0.1,
    sternWidth: 0.8,
    freeboard: 2.2,
    draft: 2.6,
    side: tint("#0b8a7c"),
    deck: tint("#9aa0a4"),
  });
  // Timonerie à l'avant, portique de pêche à l'arrière, mât de charge, treuil.
  house(b, L * 0.2, 0, 5.4, B * 0.62, fb, fb + 3.2);
  crate(
    b,
    L * 0.2 + 0.4,
    0,
    3.6,
    B * 0.5,
    fb + 3.2,
    fb + 4.4,
    tint("#f6f7f8"),
    WHITE_SUPERSTRUCTURE,
  );
  mast(b, L * 0.2, 0, fb + 4.4, fb + 8, 0.28);
  for (const s of [-1, 1])
    mast(b, -L * 0.3, s * B * 0.36, fb, fb + 5.5, 0.35, tint("#5a6068"));
  crate(b, -L * 0.3, 0, 0.4, B * 0.8, fb + 5.3, fb + 5.7, tint("#5a6068"));
  mast(b, -L * 0.06, B * 0.2, fb, fb + 6, 0.3, tint("#5a6068"));
  crate(b, -L * 0.1, -B * 0.18, 1.4, 1.4, fb, fb + 1, tint("#4b5058"));
  return b.build();
}

function sailboat(): MeshData {
  const { length: L, beam: B } = REFERENCE.voilier;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.28,
    stern: 0.12,
    sternWidth: 0.7,
    freeboard: 1.0,
    draft: 1.6,
    side: tint("#f1f3f4"),
    stripe: tint("#0b8a7c"),
    deck: tint("#cdbb92"),
  });
  crate(
    b,
    -0.2,
    0,
    3.2,
    B * 0.5,
    fb,
    fb + 0.7,
    tint("#f7f8f9"),
    WHITE_SUPERSTRUCTURE,
  );
  const mx = L * 0.08;
  mast(b, mx, 0, fb, fb + 13, 0.2, tint("#c8ccd0"));
  b.box(mx - 2.2, 0, 4.4, 0.14, fb + 1.2, fb + 1.4, tint("#c8ccd0"));
  // Grand-voile et foc : deux triangles creusés d'un ventre (la voile n'est pas plate).
  const sail = tint("#fbfcfc");
  const main: Array<[number, number, number]> = [
    [mx + 0.1, 0, fb + 1.4],
    [mx + 0.1, 0, fb + 12.6],
    [mx - 4.3, 0, fb + 1.45],
  ];
  const belly = (p: Array<[number, number, number]>, k: number) => {
    const mid: [number, number, number] = [
      (p[0]![0] + p[1]![0] + p[2]![0]) / 3,
      k,
      (p[0]![2] + p[1]![2] + p[2]![2]) / 3,
    ];
    b.tri(p[0]!, p[1]!, mid, sail)
      .tri(p[1]!, p[2]!, mid, sail)
      .tri(p[2]!, p[0]!, mid, sail);
  };
  belly(main, -0.35);
  belly(
    [
      [L * 0.46, 0, fb + 0.9],
      [mx + 0.25, 0, fb + 11.5],
      [mx - 0.8, 0, fb + 1.3],
    ],
    0.25,
  );
  return b.build();
}

function motorboat(): MeshData {
  const { length: L, beam: B } = REFERENCE.plaisance;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.3,
    stern: 0.05,
    sternWidth: 0.85,
    freeboard: 1.0,
    draft: 0.6,
    side: tint("#f1f3f4"),
    stripe: tint("#0b8a7c"),
    deck: tint("#e4e6e8"),
  });
  // Cabine et pare-brise sombre, petit toit de couleur de famille, rail d'arrière.
  house(b, 0.2, 0, 3.6, B * 0.62, fb, fb + 1.0);
  crate(
    b,
    0.5,
    0,
    2.6,
    B * 0.56,
    fb + 1.0,
    fb + 1.2,
    tint("#0b8a7c"),
    tint("#0b8a7c"),
  );
  b.box(L * 0.1 + 1.0, 0, 0.12, B * 0.5, fb + 1.0, fb + 1.7, GLASS);
  mast(b, -0.4, 0, fb + 1.2, fb + 2.4, 0.14, tint("#c8ccd0"));
  return b.build();
}

// --- Services ---

function tug(): MeshData {
  const { length: L, beam: B } = REFERENCE.remorqueur;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.24,
    stern: 0.06,
    sternWidth: 0.9,
    freeboard: 2.6,
    draft: 4.0,
    side: tint("#59616d"),
    stripe: tint("#23272d"),
    deck: tint("#3d424a"),
  });
  // Timonerie haute à l'avant du milieu, cheminée sur l'arrière.
  house(b, 2, 0, 9, B * 0.72, fb, fb + 3.2);
  house(b, 2.5, 0, 5.5, B * 0.58, fb + 3.2, fb + 6.4);
  funnel(b, -5.5, 0, 3.4, 3.6, fb, fb + 8.2, tint("#b9bec6"), tint("#2a2f38"));
  mast(b, 2.5, 0, fb + 6.4, fb + 9.5, 0.25);
  crate(b, L * 0.32, 0, 1.6, 1.6, fb, fb + 0.9, tint("#2a2f38"));
  return b.build();
}

function service(): MeshData {
  const { length: L, beam: B } = REFERENCE.service;
  const b = new MeshBuilder();
  const fb = hull(b, {
    length: L,
    beam: B,
    bow: 0.22,
    stern: 0.06,
    sternWidth: 0.85,
    freeboard: 3.4,
    draft: 2.6,
    side: tint("#6b7280"),
    stripe: tint("#e2e5e9"),
    deck: tint("#4d535c"),
  });
  // Passerelle à l'avant, pont de travail à l'arrière avec une grue.
  house(b, L * 0.17, 0, 11, B * 0.8, fb, fb + 3.4);
  house(b, L * 0.18, 0, 7, B * 0.66, fb + 3.4, fb + 6.2);
  mast(b, L * 0.18, 0, fb + 6.2, fb + 11, 0.3);
  mast(b, -L * 0.3, B * 0.28, fb, fb + 4.5, 0.7, tint("#c9cdd2"));
  b.box(-L * 0.3 - 3, B * 0.28, 7, 0.5, fb + 4.2, fb + 4.7, tint("#c9cdd2"));
  crate(b, -L * 0.1, 0, 5, 4, fb, fb + 1.6, tint("#8a9098"), tint("#6e747c"));
  return b.build();
}

let cache: Record<ShipModel, MeshData> | undefined;

/** Maquette de chaque type de navire (construite une fois). */
export function shipMeshes(): Record<ShipModel, MeshData> {
  cache ??= {
    cargo: cargo(),
    tanker: tanker(),
    ferry: ferry(),
    croisiere: cruise(),
    peche: fishing(),
    voilier: sailboat(),
    plaisance: motorboat(),
    remorqueur: tug(),
    service: service(),
  };
  return cache;
}

/** Maquette d'un navire d'après son type et sa longueur (m). */
export function modelOf(type: ShipType, lengthM: number): ShipModel {
  return type === "ferry" && lengthM >= CRUISE_MIN_LENGTH ? "croisiere" : type;
}

/**
 * Échelle [x, y, z] d'une maquette pour une coque de `lengthM` sur `beamM` : la hauteur suit la
 * moyenne géométrique des deux, pour qu'un navire long et fin ne devienne pas une tour.
 */
export function scaleOf(
  model: ShipModel,
  lengthM: number,
  beamM: number,
): [number, number, number] {
  const ref = REFERENCE[model];
  const sx = lengthM / ref.length;
  const sy = beamM / ref.beam;
  return [sx, sy, Math.sqrt(sx * sy)];
}
