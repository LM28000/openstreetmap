/**
 * Scènes : des ensembles de couches pensés pour aller ensemble (couleurs comprises :
 * aucune teinte n'y a deux sens). Appliquer une scène remplace les couches affichées.
 * Les identifiants sont ceux des modules (`src/modules/index.ts`).
 */
export interface Scene {
  id: string;
  label: string;
  /** Résumé en une ligne, sous le nom dans le catalogue. */
  description: string;
  /** Identifiants des modules affichés par la scène. */
  modules: readonly string[];
}

export const SCENES: readonly Scene[] = [
  {
    id: 'mouvement',
    label: 'Ce qui bouge',
    description: 'trains, avions, bateaux, bus',
    modules: ['trains', 'avions', 'bateaux', 'transports'],
  },
  {
    id: 'meteo',
    label: 'Météo',
    description: 'pluie, vent, vigilance',
    modules: ['pluie', 'vent', 'vigilance-meteo', 'jour-nuit'],
  },
  {
    id: 'energie',
    label: 'Énergie',
    description: 'électricité, bornes, carburants',
    modules: ['electricite', 'bornes', 'carburants'],
  },
  {
    id: 'ville',
    label: 'Ma ville',
    description: 'bus, vélos, trafic, bornes',
    modules: ['transports', 'velos', 'trafic', 'bornes'],
  },
];

/** La scène dont les couches sont exactement celles qui sont affichées, sinon `undefined`. */
export function activeScene(visibleIds: ReadonlySet<string>): Scene | undefined {
  return SCENES.find((scene) => scene.modules.length === visibleIds.size && scene.modules.every((id) => visibleIds.has(id)));
}
