import type { ModuleManager } from './moduleManager';

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
    // Les voies, discrètes, donnent leur contexte aux trains.
    modules: ['trains', 'voies', 'avions', 'bateaux', 'transports'],
  },
  {
    id: 'meteo',
    label: 'Météo',
    description: 'pluie, vent, vigilance',
    modules: ['pluie', 'vent', 'vigilance-meteo', 'jour-nuit'],
  },
  {
    // Hors de « Météo » : l'indice (jaune, rouge, turquoise) y recouvrirait la vigilance (jaune, orange, rouge)
    // et le radar de pluie (bleu). Le vent, lui, est blanc et montre où l'air pollué est emporté.
    id: 'air',
    label: 'Qualité de l’air',
    description: 'indice ATMO, épisodes, vent',
    modules: ['air', 'vent', 'jour-nuit'],
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

/**
 * Couches d'ambiance : une scène ne les éteint pas. Couper « Jour et nuit » en pleine nuit
 * repasserait d'un coup le fond de carte au jour, ce qui n'a rien à voir avec la scène choisie.
 * Une scène peut en revanche les allumer (« Météo » affiche le jour et la nuit).
 */
const AMBIENT: readonly string[] = ['jour-nuit'];

/** Couches à afficher pour une scène, compte tenu des couches d'ambiance déjà affichées. */
export function sceneLayers(scene: Scene, visibleIds: ReadonlySet<string>): string[] {
  return [...new Set([...scene.modules, ...AMBIENT.filter((id) => visibleIds.has(id))])];
}

/** Applique une scène : ses couches remplacent les couches affichées (sauf l'ambiance). */
export function applyScene(manager: ModuleManager, scene: Scene): void {
  const snapshot = manager.getSnapshot();
  const visibleIds = new Set(manager.modules.filter((module) => snapshot[module.id]?.visible).map((module) => module.id));
  manager.setVisibleOnly(sceneLayers(scene, visibleIds));
}

/** La scène dont les couches sont exactement celles qui sont affichées (ambiance mise à part), sinon `undefined`. */
export function activeScene(visibleIds: ReadonlySet<string>): Scene | undefined {
  const shown = [...visibleIds].filter((id) => !AMBIENT.includes(id));
  return SCENES.find((scene) => {
    const wanted = scene.modules.filter((id) => !AMBIENT.includes(id));
    return wanted.length === shown.length && wanted.every((id) => visibleIds.has(id));
  });
}
