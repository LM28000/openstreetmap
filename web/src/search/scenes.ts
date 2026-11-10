/**
 * Les scènes : des ensembles de couches prêts à l'emploi.
 *
 * Définitions minimales propres à la recherche, en attendant d'être branchées sur
 * `core/scenes.ts` (même liste de quatre scènes, mêmes identifiants de modules).
 */
export interface SceneDefinition {
  id: string;
  name: string;
  /** Résumé affiché sous le nom. */
  summary: string;
  /** Identifiants des modules affichés ; tous les autres sont masqués. */
  layers: readonly string[];
  /** Mots qui doivent retrouver la scène en plus de son nom. */
  keywords: string;
}

export const SCENES: readonly SceneDefinition[] = [
  { id: 'mouvement', name: 'Ce qui bouge', summary: 'trains, avions, bateaux, bus', layers: ['trains', 'avions', 'bateaux', 'transports'], keywords: 'mouvement circulation trafic' },
  { id: 'meteo', name: 'Météo', summary: 'pluie, vent, vigilance', layers: ['pluie', 'vent', 'vigilance-meteo'], keywords: 'temps orage' },
  { id: 'energie', name: 'Énergie', summary: 'électricité, bornes, carburants', layers: ['electricite', 'bornes', 'carburants'], keywords: 'courant electrique' },
  { id: 'ville', name: 'Ma ville', summary: 'bus, vélos, trafic, bornes', layers: ['transports', 'velos', 'trafic', 'bornes'], keywords: 'quartier urbain' },
];
