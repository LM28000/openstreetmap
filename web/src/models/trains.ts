/**
 * Maquettes 3D des voitures de train, aux cotes réelles (mètres), nez sur x, gauche sur y, le
 * dessus du rail à z = 0. Une maquette est une seule voiture : la rame est composée par le module
 * (une instance par voiture, posée et orientée le long de la voie).
 *
 * Une voiture est un balayage le long de x d'une coupe transversale (jupe sombre, caisse,
 * bandeau de fenêtres sombre, épaulement et toit), mise à l'échelle aux extrémités pour faire le
 * nez ; les bogies sont des pavés sombres sous la caisse. Les pièces blanches prennent la couleur
 * de la donnée (famille ou retard), les pièces grises la foncent.
 */
import { MeshBuilder, shade, WHITE, type MeshData, type Tint, type Vec3 } from './mesh';

export type CarType = 'tgv-motrice' | 'tgv-remorque' | 'ter-tete' | 'ter-milieu' | 'tram-tete' | 'tram-milieu' | 'loco' | 'corail';

/** Largeur réelle (m) et hauteur du toit (m) de chaque type, pour agrandir la maquette de loin. */
export const CAR_SIZE: Record<CarType, { width: number; height: number }> = {
  'tgv-motrice': { width: 2.9, height: 4.1 },
  'tgv-remorque': { width: 2.9, height: 4.3 },
  'ter-tete': { width: 2.9, height: 4.15 },
  'ter-milieu': { width: 2.9, height: 4.15 },
  'tram-tete': { width: 2.4, height: 3.5 },
  'tram-milieu': { width: 2.4, height: 3.5 },
  loco: { width: 2.9, height: 4.2 },
  corail: { width: 2.8, height: 4.0 },
};

/** Un type de voiture a un nez (cabine) à l'avant. */
export const HAS_CAB: Record<CarType, boolean> = {
  'tgv-motrice': true,
  'tgv-remorque': false,
  'ter-tete': true,
  'ter-milieu': false,
  'tram-tete': true,
  'tram-milieu': false,
  loco: true,
  corail: false,
};

const GLASS = shade(0.13);
const UNDER = shade(0.24);
const ROOF = shade(0.8);
const EQUIP = shade(0.34);
/** Jour entre deux voitures, déjà retiré de la longueur des maquettes. */
const GAP = 0.7;

/** Un cran de la coupe : bord haut (z), retrait par rapport à la pleine largeur, teinte de la facette en dessous. */
interface Band {
  z: number;
  inset: number;
  tint: Tint;
  /** Facette du dessus (toit, épaulement) : elle devient une vitre sur le pare-brise du nez. */
  top?: boolean;
}

interface Profile {
  halfWidth: number;
  /** Bas de la jupe : hauteur et retrait. */
  base: { z: number; inset: number };
  bands: readonly Band[];
}

const PROFILES: Record<CarType, Profile> = {
  // Motrice TGV : caisse pleine, grille d'aération sombre, toit bas.
  'tgv-motrice': {
    halfWidth: 1.45,
    base: { z: 0.35, inset: 0.5 },
    bands: [
      { z: 0.95, inset: 0, tint: UNDER },
      { z: 2.3, inset: 0, tint: WHITE },
      { z: 2.85, inset: 0, tint: GLASS },
      { z: 3.6, inset: 0.02, tint: WHITE },
      { z: 3.85, inset: 0.3, tint: WHITE, top: true },
      { z: 4.1, inset: 0.95, tint: ROOF, top: true },
    ],
  },
  // Remorque Duplex : deux niveaux de fenêtres.
  'tgv-remorque': {
    halfWidth: 1.45,
    base: { z: 0.35, inset: 0.5 },
    bands: [
      { z: 0.95, inset: 0, tint: UNDER },
      { z: 1.55, inset: 0, tint: WHITE },
      { z: 2.3, inset: 0, tint: GLASS },
      { z: 2.8, inset: 0, tint: WHITE },
      { z: 3.6, inset: 0.02, tint: GLASS },
      { z: 4.0, inset: 0.28, tint: WHITE, top: true },
      { z: 4.3, inset: 0.95, tint: ROOF, top: true },
    ],
  },
  // Régiolis / AGC.
  'ter-tete': {
    halfWidth: 1.45,
    base: { z: 0.35, inset: 0.5 },
    bands: [
      { z: 1.0, inset: 0, tint: UNDER },
      { z: 1.6, inset: 0, tint: WHITE },
      { z: 2.85, inset: 0, tint: GLASS },
      { z: 3.5, inset: 0.05, tint: WHITE },
      { z: 3.95, inset: 0.35, tint: WHITE, top: true },
      { z: 4.15, inset: 0.95, tint: ROOF, top: true },
    ],
  },
  'ter-milieu': {
    halfWidth: 1.45,
    base: { z: 0.35, inset: 0.5 },
    bands: [
      { z: 1.0, inset: 0, tint: UNDER },
      { z: 1.6, inset: 0, tint: WHITE },
      { z: 2.85, inset: 0, tint: GLASS },
      { z: 3.5, inset: 0.05, tint: WHITE },
      { z: 3.95, inset: 0.35, tint: WHITE, top: true },
      { z: 4.15, inset: 0.95, tint: ROOF, top: true },
    ],
  },
  // Tram-train : plus étroit et plus bas.
  'tram-tete': {
    halfWidth: 1.2,
    base: { z: 0.4, inset: 0.4 },
    bands: [
      { z: 0.85, inset: 0, tint: UNDER },
      { z: 1.3, inset: 0, tint: WHITE },
      { z: 2.5, inset: 0, tint: GLASS },
      { z: 3.15, inset: 0.18, tint: WHITE, top: true },
      { z: 3.5, inset: 0.6, tint: ROOF, top: true },
    ],
  },
  'tram-milieu': {
    halfWidth: 1.2,
    base: { z: 0.4, inset: 0.4 },
    bands: [
      { z: 0.85, inset: 0, tint: UNDER },
      { z: 1.3, inset: 0, tint: WHITE },
      { z: 2.5, inset: 0, tint: GLASS },
      { z: 3.15, inset: 0.18, tint: WHITE, top: true },
      { z: 3.5, inset: 0.6, tint: ROOF, top: true },
    ],
  },
  // Locomotive électrique (BB) : caisse haute et presque pleine.
  loco: {
    halfWidth: 1.45,
    base: { z: 0.4, inset: 0.5 },
    bands: [
      { z: 0.95, inset: 0, tint: UNDER },
      { z: 2.4, inset: 0, tint: WHITE },
      { z: 2.95, inset: 0, tint: GLASS },
      { z: 3.7, inset: 0.03, tint: WHITE },
      { z: 3.95, inset: 0.3, tint: WHITE, top: true },
      { z: 4.2, inset: 0.95, tint: ROOF, top: true },
    ],
  },
  // Voiture Corail.
  corail: {
    halfWidth: 1.4,
    base: { z: 0.35, inset: 0.5 },
    bands: [
      { z: 1.0, inset: 0, tint: UNDER },
      { z: 1.65, inset: 0, tint: WHITE },
      { z: 2.65, inset: 0, tint: GLASS },
      { z: 3.4, inset: 0.04, tint: WHITE },
      { z: 3.8, inset: 0.3, tint: WHITE, top: true },
      { z: 4.0, inset: 0.85, tint: ROOF, top: true },
    ],
  },
};

/** Station d'un nez : distance depuis la pointe, échelles en largeur et hauteur (autour du bas de la caisse). */
type NoseStation = readonly [from: number, sy: number, sz: number];

interface Nose {
  stations: readonly NoseStation[];
  /** Teinte de la face avant (vitre de cabine ou caisse). */
  cap: Tint;
  /** Nombre de tronçons, depuis la pointe, dont le dessus est un pare-brise. */
  windshield: number;
}

const NOSES: Record<'pointu' | 'rond' | 'loco', Nose> = {
  // TGV : long nez effilé qui s'abaisse.
  pointu: {
    stations: [
      [0, 0.3, 0.46],
      [1.5, 0.6, 0.6],
      [3.4, 0.84, 0.79],
      [5.4, 0.97, 0.95],
      [6.8, 1, 1],
    ],
    cap: WHITE,
    windshield: 3,
  },
  // Automotrice régionale : front arrondi, grande vitre.
  rond: {
    stations: [
      [0, 0.6, 0.6],
      [0.45, 0.8, 0.74],
      [1.2, 0.94, 0.9],
      [2.3, 0.995, 0.985],
      [3.1, 1, 1],
    ],
    cap: GLASS,
    windshield: 3,
  },
  // Locomotive : front incliné court.
  loco: {
    stations: [
      [0, 0.9, 0.8],
      [0.55, 0.98, 0.93],
      [1.6, 1, 1],
    ],
    cap: GLASS,
    windshield: 2,
  },
};

const NOSE_OF: Partial<Record<CarType, Nose>> = {
  'tgv-motrice': NOSES.pointu,
  'ter-tete': NOSES.rond,
  'tram-tete': NOSES.rond,
  loco: NOSES.loco,
};

/** Une section : la coupe mise à l'échelle (largeur, hauteur) à l'abscisse x. */
interface Station {
  x: number;
  sy: number;
  sz: number;
  /** Les facettes « top » entre cette section et la suivante sont des vitres. */
  glass: boolean;
}

/**
 * Balaye la coupe de `profile` le long de `stations` (de l'avant vers l'arrière). La coupe est
 * parcourue de la gauche vers la droite par le haut : jupe, bandes, toit, puis redescente à droite.
 */
function sweep(b: MeshBuilder, profile: Profile, stations: readonly Station[], frontCap: Tint, rearCap: Tint): void {
  const w = profile.halfWidth;
  // Côté gauche, de bas en haut : [y, z, teinte de l'arête qui arrive, facette du dessus].
  const left: Array<{ y: number; z: number; tint: Tint; top: boolean }> = [
    { y: w - profile.base.inset, z: profile.base.z, tint: UNDER, top: false },
    ...profile.bands.map((band) => ({ y: w - band.inset, z: band.z, tint: band.tint, top: band.top === true })),
  ];
  const z0 = profile.base.z;
  const ring = (s: Station): Vec3[] => {
    const point = (y: number, z: number): Vec3 => [s.x, y * s.sy, z0 + (z - z0) * s.sz];
    return [...left.map((p) => point(p.y, p.z)), ...[...left].reverse().map((p) => point(-p.y, p.z))];
  };
  const n = left.length;
  const rings = stations.map(ring);
  const segment = (a: readonly Vec3[], c: readonly Vec3[], glass: boolean) => {
    const size = a.length;
    for (let e = 0; e < size; e++) {
      const next = (e + 1) % size;
      // Arêtes 1..n-1 : flanc gauche ; n-1 : le dessus ; puis le flanc droit ; la dernière : le dessous.
      let tint: Tint;
      let top = false;
      if (e < n - 1) {
        tint = left[e + 1]!.tint;
        top = left[e + 1]!.top;
      } else if (e === n - 1) {
        tint = left[n - 1]!.tint;
        top = true;
      } else if (e < 2 * n - 1) {
        const index = 2 * n - 1 - e; // arête du flanc droit (en redescendant)
        tint = left[index]!.tint;
        top = left[index]!.top;
      } else {
        tint = UNDER;
      }
      if (glass && top) tint = GLASS;
      b.quad(a[e]!, c[e]!, c[next]!, a[next]!, tint);
    }
  };
  for (let i = 0; i + 1 < rings.length; i++) segment(rings[i]!, rings[i + 1]!, stations[i]!.glass);
  b.fan(rings[0]!, frontCap);
  b.fan([...rings[rings.length - 1]!].reverse(), rearCap);
}

const cache = new Map<string, MeshData>();

/**
 * Maquette d'une voiture de `length` mètres (jours déduits). Avec `nose` faux, une voiture de tête
 * garde sa caisse mais l'extrémité est plane (accouplement avec une autre rame).
 */
export function carMesh(type: CarType, length: number, nose = true): MeshData {
  const cab = HAS_CAB[type] && nose;
  const key = `${type}:${length}:${cab ? 1 : 0}`;
  let mesh = cache.get(key);
  if (!mesh) {
    mesh = buildCar(type, length - GAP, cab);
    cache.set(key, mesh);
  }
  return mesh;
}

function buildCar(type: CarType, length: number, cab: boolean): MeshData {
  const b = new MeshBuilder();
  const profile = PROFILES[type];
  const front = length / 2;
  const back = -length / 2;
  const nose = cab ? NOSE_OF[type] : undefined;
  const stations: Station[] = [];
  if (nose) {
    nose.stations.forEach(([from, sy, sz], i) => {
      stations.push({ x: front - from, sy, sz, glass: i < nose.windshield });
    });
    stations.push({ x: back, sy: 1, sz: 1, glass: false });
  } else {
    stations.push({ x: front, sy: 1, sz: 1, glass: false }, { x: back, sy: 1, sz: 1, glass: false });
  }
  sweep(b, profile, stations, nose ? nose.cap : UNDER, UNDER);

  // Bogies : deux pavés sombres sous la caisse, un peu en retrait des extrémités.
  const noseLength = nose ? nose.stations[nose.stations.length - 1]![0] : 0;
  const bogieFront = front - Math.max(3.4, noseLength * 0.7);
  const bogieBack = back + 3.4;
  const bogieLength = Math.min(3.4, length / 4);
  for (const x of [bogieFront, bogieBack]) b.box(x, 0, bogieLength, 2.1, 0.12, profile.base.z + 0.25, EQUIP, EQUIP);

  // Équipements de toit : pantographes des motrices et des locomotives, climatiseurs des automotrices.
  const roof = profile.bands[profile.bands.length - 1]!.z;
  if (type === 'tgv-motrice' || type === 'loco') {
    b.box(front - noseLength - 3, 0, 1.7, 1.5, roof - 0.05, roof + 0.4, EQUIP, EQUIP);
    b.box(back + 4, 0, 1.7, 1.5, roof - 0.05, roof + 0.4, EQUIP, EQUIP);
  } else if (type === 'ter-tete' || type === 'ter-milieu' || type === 'tram-tete' || type === 'tram-milieu') {
    b.box(length * 0.12, 0, Math.min(4.5, length * 0.28), 1.5, roof - 0.05, roof + 0.4, EQUIP, EQUIP);
  }
  return b.build();
}
