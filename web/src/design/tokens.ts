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
 * Générées une fois à partir de la couleur de chaque famille (`ELEC`), dans l'espace OKLCH : teinte et chroma de la famille,
 * luminosité en pas réguliers (ΔL ≥ 0,078 entre classes voisines, contrôlé par calcul).
 * Jour : de 0,76 à 0,28, le plus fort est le plus foncé ; bout clair à 1,8:1 ou plus sur le fond de carte clair.
 * Nuit : de 0,46 à 0,94, le plus fort est le plus clair ; bout sombre à 2,4:1 ou plus sur le fond sombre.
 */
export const ELEC_SHARE: Record<ElecFamily, Ramp> = {
  exg: {
    jour: ['#ff8b7f', '#f56057', '#d8463f', '#bc2827', '#9e0210', '#780009', '#540004'],
    nuit: ['#a70318', '#c52c2f', '#e14946', '#fe645e', '#fe968d', '#ffbfb8', '#fee4e1'],
  },
  gauche: {
    jour: ['#fd84b1', '#e16a99', '#c65281', '#aa3869', '#8f1d53', '#72023d', '#500129'],
    nuit: ['#9f015e', '#bc2975', '#d9468d', '#f561a5', '#fe8ebd', '#ffbad4', '#fee3ec'],
  },
  eco: {
    jour: ['#77c77c', '#5eae64', '#45944c', '#2a7c35', '#07641d', '#014b12', '#003309'],
    nuit: ['#0c6b1d', '#2e8336', '#489b4e', '#62b566', '#7bcf7e', '#95e997', '#beffbf'],
  },
  centre: {
    jour: ['#e5a313', '#c68c03', '#a77600', '#896004', '#6d4c02', '#523800', '#382501'],
    nuit: ['#774f03', '#946407', '#ad7b2d', '#c79448', '#e1ad61', '#fcc77b', '#fee7c9'],
  },
  droite: {
    jour: ['#76b5ff', '#419afc', '#2381e0', '#0469c1', '#01529a', '#003d75', '#012951'],
    nuit: ['#1a599b', '#3470b5', '#4c89cf', '#64a2ea', '#83bbfe', '#b2d4fe', '#deedff'],
  },
  ed: {
    jour: ['#aba6f8', '#938ddd', '#7b74c3', '#645da9', '#4f468f', '#3b2f76', '#28185e'],
    nuit: ['#5938ba', '#6e52d5', '#846bf1', '#9b8aff', '#b4abfe', '#cecaff', '#eae9fe'],
  },
  autres: {
    jour: ['#b2b1ac', '#999893', '#81807b', '#6a6964', '#53534e', '#3e3d3a', '#292926'],
    nuit: ['#595854', '#706f6a', '#878681', '#9f9e9a', '#b8b7b3', '#d2d1cd', '#ecebe8'],
  },
};
