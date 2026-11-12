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
    // Le LiDAR HD (estompage gris ou hauteur du sursol vert, jaune, orange) : une couche raster, seule à l'écran pour que ses teintes ne se mêlent à aucune autre.
    id: 'relief',
    label: 'Relief LiDAR HD',
    description: 'terrain nu, arbres et bâtiments à 50 cm',
    modules: ['lidar'],
  },
  {
    // Le niveau de la mer (jauges bleu marine) avec le vent et la vigilance : la tempête et la marée haute se lisent ensemble.
    id: 'littoral',
    label: 'Mer et littoral',
    description: 'marées, vent, vigilance',
    modules: ['marees', 'vent', 'vigilance-meteo', 'jour-nuit'],
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
    // Les photos aériennes (monochromes) laissent la place aux pictogrammes des monuments.
    id: 'patrimoine',
    label: 'Patrimoine',
    description: 'photos anciennes, monuments historiques',
    modules: ['photos', 'monuments'],
  },
  {
    // Les habitants (terre de Sienne) et jusqu'où l'on va en transports (framboise) : deux teintes sans lien avec les autres couches.
    id: 'population',
    label: 'Population',
    description: 'habitants au carreau de 200 m, isochrones',
    modules: ['population', 'isochrones'],
  },
  {
    // Une seule couche, en vert olive : aucune autre scène ne l'emploie (les opérateurs n'ont pas leurs couleurs de marque).
    id: 'reseau-mobile',
    label: 'Réseau mobile',
    description: 'couverture 4G et voix, zones blanches',
    modules: ['couverture-mobile'],
  },
  {
    // Seule : bleu, gris et rose (échelle divergente autour de la médiane nationale) ne doivent pas se mêler à d'autres aplats.
    id: 'immobilier',
    label: 'Immobilier',
    description: 'prix de vente au m², ventes une à une',
    modules: ['immobilier'],
  },
  {
    // Une couche de polygones pleins, avec ses propres couleurs (familles politiques) : seule, pour ne rien mêler.
    id: 'elections',
    label: 'Élections',
    description: 'résultats par bureau de vote',
    modules: ['elections'],
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
