/**
 * Les seules fonctions de satellite.js dont on a besoin, importées fichier par fichier.
 *
 * Le point d'entrée du paquet (`satellite.js`) réexporte aussi une version WebAssembly
 * multi-fils qui contient un `await` de haut niveau et des modules Node : elle fait
 * échouer `vite build` (le mode développement s'en accommode). Le paquet n'exposant
 * que son point d'entrée, on va chercher les fichiers JavaScript du modèle SGP4
 * directement ; ils ne dépendent pas du WebAssembly.
 */
export { json2satrec } from '../../node_modules/satellite.js/dist/io.js';
export { gstime, propagate } from '../../node_modules/satellite.js/dist/propagation.js';
export { ecfToLookAngles, eciToGeodetic } from '../../node_modules/satellite.js/dist/transforms.js';
export type { SatRec } from '../../node_modules/satellite.js/dist/propagation/SatRec.js';
