/**
 * Palettes de données de Vigie : les couleurs des couches, en un seul endroit.
 *
 * Les valeurs viennent de `design/tokens.json` (la source de vérité du design system) ; un changement de couleur
 * se fait d'abord là-bas, puis ici. Les modules importent ces palettes au lieu de définir leurs propres littéraux.
 *
 * - Teintes catégorielles : une couleur par catégorie (trains, transports, navires, familles politiques).
 * - Rampes séquentielles ou divergentes : un tableau du plus faible au plus fort, en version `jour` et `nuit`
 *   (la nuit, le plus fort devient le plus clair). Les rampes sans différence entre jour et nuit ont les mêmes valeurs.
 * - Statuts : réservés aux états (crues, vigilance, trafic), jamais à une catégorie ni à une grandeur.
 *
 * Le rouge vif de l'interface (`ui-live`) n'est pas une couleur de données : il n'est pas ici.
 */

/** Une rampe du plus faible au plus fort, pour la carte de jour et pour la carte de nuit. */
export interface Ramp {
  jour: readonly string[];
  nuit: readonly string[];
}

/** « #rrggbb » → `[r, g, b]` (les couches deck.gl veulent des triplets). */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// --- Trains ---------------------------------------------------------------------------------

/** Familles de trains : TER (bleu), grande vitesse (orange), Intercités (vert), et le train sans information. */
export const TRAIN = {
  ter: '#2a78d6',
  gv: '#eb6834',
  ic: '#1baf7a',
  inconnu: '#8a8f9c',
} as const;

/** Contour d'un train selon son retard : à l'heure, 5 à 14 min, 15 min ou plus. */
export const RETARD = {
  heure: '#ffffff',
  cinq: '#f0913a',
  quinze: '#a83a16',
} as const;

// --- Transports urbains ---------------------------------------------------------------------

/** Couleur de mode quand le réseau ne donne pas la couleur de ligne ; `autre` est un gris sans teinte. */
export const TRANSIT = {
  bus: '#d9548f',
  tram: '#0a93a6',
  metro: '#b98a00',
  autre: '#8b92a1',
} as const;

// --- Navires --------------------------------------------------------------------------------

export const SHIP = {
  marchandises: '#a3262a',
  passagers: '#a66b00',
  petits: '#00897a',
  autres: '#6b7280',
} as const;

// --- Statuts (crues, vigilance, trafic) -------------------------------------------------------

export const STATUS = {
  vert: '#0ca30c',
  jaune: '#f7c325',
  orange: '#e8702a',
  rouge: '#b01e32',
  /** Encre des contours et des trames. */
  ink: '#161a26',
} as const;

/** Marées : remplissage des jauges et courbe des marégraphes. */
export const MARINE = '#1d6fb8';

// --- Rampes ---------------------------------------------------------------------------------

/** Avions par altitude (violet) : du plus bas au plus haut. Identique le jour et la nuit. */
export const AVION_ALT: Ramp = {
  jour: ['#aca8ff', '#918be5', '#7670c7', '#5d55a9', '#463b8d'],
  nuit: ['#aca8ff', '#918be5', '#7670c7', '#5d55a9', '#463b8d'],
};
/** Population (terre de Sienne) : de la densité la plus faible à la plus forte. Le jour le plus dense est le plus foncé, la nuit le plus clair. */
export const POP: Ramp = {
  jour: ['#d8ac6c', '#c58b49', '#aa6c33', '#865027', '#63381d', '#432414', '#2a160c'],
  nuit: ['#7d4a2a', '#9a6034', '#b97a40', '#d1975b', '#e3b57f', '#f0cfa6', '#fbeed8'],
};
/** Isochrones (framboise) : du plus loin en temps (cran 1) au plus proche (cran 6). */
export const ISO: Ramp = {
  jour: ['#ec8fb2', '#e0709f', '#cc4a86', '#ad2368', '#86114f', '#5a0a3a'],
  nuit: ['#a9255f', '#c43a7b', '#d95b92', '#e982ab', '#f4a9c3', '#fbd0de'],
};
/** Prix de l'immobilier (divergente) : bleu moins cher, gris autour de la médiane (cran 4), rose plus cher. */
export const IMMO: Ramp = {
  jour: ['#1b5a94', '#3f84bf', '#86b3dc', '#a3a3a3', '#d889b0', '#bb3d78', '#821a54'],
  nuit: ['#9fd0f7', '#6aaee8', '#3f86c4', '#7d7d7d', '#c04a85', '#e07aa6', '#f7b5cf'],
};
/** Couverture mobile (vert olive) : du plus couvert (4 opérateurs) au moins couvert (aucun). */
export const COUV: Ramp = {
  jour: ['#a6bf4d', '#87a420', '#668300', '#466000', '#2a3a00'],
  nuit: ['#4f6411', '#6e8a14', '#92b222', '#b9d94a', '#e0f58a'],
};
/** Radar de pluie (bleu) : de la pluie faible à la pluie très forte. Identique le jour et la nuit. */
export const PLUIE: Ramp = {
  jour: ['#71b5ff', '#599ee7', '#4286ce', '#2a6fb6', '#0e599d'],
  nuit: ['#71b5ff', '#599ee7', '#4286ce', '#2a6fb6', '#0e599d'],
};
/** Accidents par pire issue (ocre) : indemne, blessé léger, hospitalisé, tué. Identique le jour et la nuit. */
export const ACCIDENT: Ramp = {
  jour: ['#d6aa62', '#b98340', '#9c6224', '#80481a'],
  nuit: ['#d6aa62', '#b98340', '#9c6224', '#80481a'],
};
/** Élections, participation (bleu) : de la plus faible à la plus forte. */
export const PARTICIPATION: Ramp = {
  jour: ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0a2548'],
  nuit: ['#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6', '#e3effd'],
};
// --- Élections : familles politiques ---------------------------------------------------------

export type ElecFamily = 'exg' | 'gauche' | 'eco' | 'centre' | 'droite' | 'ed' | 'autres';

/** Couleur de chaque famille (aplat « en tête », pastille de la fiche, légende). */
export const ELEC: Record<ElecFamily, { jour: string; nuit: string }> = {
  exg: { jour: '#a60412', nuit: '#b41520' },
  gauche: { jour: '#ed75a3', nuit: '#d34188' },
  eco: { jour: '#409048', nuit: '#53a658' },
  centre: { jour: '#e09f02', nuit: '#a1701e' },
  droite: { jour: '#3b95f6', nuit: '#508dd4' },
  ed: { jour: '#524993', nuit: '#6648cb' },
  autres: { jour: '#8c8b85', nuit: '#8a8984' },
};

/** Bureau sans résultat pour ce scrutin : un gris clair, hors de toute légende de données. */
export const ELEC_SANS = { jour: '#cfcdc4', nuit: '#46464a' } as const;

/**
 * « Part d'un candidat » : une rampe d'une seule teinte, celle de la famille du candidat (sept classes, de la part la plus
 * faible à la plus forte). Elle ne reprend donc plus la rampe de la population (terre de Sienne).
 *
 * Générées une fois à partir de la couleur de chaque famille (`ELEC`), dans l'espace OKLCH : une teinte par famille (celle de sa
 * couleur, au jour ou à la nuit), la chroma de la famille plafonnée à 97 % de ce que l'écran sait afficher à chaque clarté, et la
 * clarté en pas réguliers de 0,0795 (ΔL ≥ 0,078 entre classes voisines, contrôlé par calcul après arrondi en hexadécimal).
 * Jour : le plus fort est le plus foncé ; le bout clair, placé le plus clair possible, reste à 1,8:1 ou plus sur le fond de carte clair
 * (clarté de 0,76 à 0,79 au départ, 0,28 à 0,31 à l'arrivée). Le bout foncé ne descend plus sous 0,28 de clarté : au-dessous, rouge,
 * ocre et vert se confondent avec du noir et les libellés posés dessus ne se lisent plus.
 * Nuit : le plus fort est le plus clair ; le bout sombre, placé le plus sombre possible, reste à 2,2:1 ou plus sur le fond sombre
 * (clarté de 0,43 à 0,46 au départ, 0,90 à 0,93 à l'arrivée).
 * Le gris « autres » garde sa chroma à 0,01 : sa teinte n'a pas de sens.
 */
export const ELEC_SHARE: Record<ElecFamily, Ramp> = {
  exg: {
    jour: ['#fd9b91', '#fd6c62', '#e34f48', '#c63330', '#aa0e17', '#85050e', '#610207'],
    nuit: ['#a20919', '#c2282c', '#de4644', '#fb615b', '#fd9188', '#febab3', '#fedfdc'],
  },
  gauche: {
    jour: ['#fd96bb', '#ec74a2', '#d05b8a', '#b54272', '#9a295c', '#800746', '#5d0231'],
    nuit: ['#9a085b', '#b92572', '#d5438a', '#f15ea2', '#fd88b9', '#feb5d1', '#fedde9'],
  },
  eco: {
    jour: ['#76c77c', '#5dad64', '#44944c', '#2a7c35', '#07641d', '#034b13', '#003309'],
    nuit: ['#066118', '#22792d', '#3e9144', '#57aa5c', '#70c474', '#8ade8d', '#a3f9a6'],
  },
  centre: {
    jour: ['#ebaa21', '#cd9214', '#ae7c0f', '#916609', '#745105', '#593d02', '#3f2a00'],
    nuit: ['#6c4804', '#895c08', '#a47221', '#bd8a3e', '#d7a357', '#f1bc71', '#fedaaa'],
  },
  droite: {
    jour: ['#7fb9fd', '#4b9ffc', '#2985e5', '#0a6dc7', '#0656a0', '#02417b', '#002d58'],
    nuit: ['#105193', '#2b68ad', '#4480c7', '#5c99e1', '#74b2fc', '#a2ccfd', '#cfe4fe'],
  },
  ed: {
    jour: ['#b2adfd', '#9993e5', '#827bca', '#6b63b0', '#554c97', '#40367e', '#2d1f66'],
    nuit: ['#5634b6', '#6b4ed1', '#8167ed', '#9785fc', '#afa6fd', '#c9c5fe', '#e4e3fe'],
  },
  autres: {
    jour: ['#b7b6ad', '#9f9d95', '#87857d', '#6f6e66', '#595750', '#43423b', '#2f2d27'],
    nuit: ['#504f47', '#66655d', '#7d7c74', '#95948b', '#aeaca4', '#c7c5bd', '#e1dfd6'],
  },
};
