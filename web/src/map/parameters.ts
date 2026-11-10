/**
 * Paramètres de dessin communs aux couches deck.gl posées sur la carte.
 *
 * - Pas de test de profondeur : les objets restent visibles au-dessus du relief (un
 *   train de montagne serait sinon caché par la pente qu'il longe).
 * - Pas d'élimination des faces arrière : sur le globe, deck.gl 9.4 l'active pour toutes
 *   les couches, ce qui efface les icônes et les textes (trains, avions, bateaux,
 *   étiquettes). Correctif en cours chez deck.gl : https://github.com/visgl/deck.gl/pull/9975
 */
export const OVER_MAP = { depthCompare: 'always', depthWriteEnabled: false, cullMode: 'none' } as const;
