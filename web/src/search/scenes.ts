/**
 * Les scènes vues par la recherche : celles de `core/scenes.ts`, avec les mots
 * qui doivent les retrouver en plus de leur nom.
 */
import { SCENES as CORE_SCENES } from '../core/scenes';

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

const KEYWORDS: Record<string, string> = {
  mouvement: 'mouvement circulation trafic',
  meteo: 'temps orage',
  air: 'pollution ozone particules smog atmo',
  energie: 'courant electrique',
  ville: 'quartier urbain',
};

export const SCENES: readonly SceneDefinition[] = CORE_SCENES.map((scene) => ({
  id: scene.id,
  name: scene.label,
  summary: scene.description,
  layers: scene.modules,
  keywords: KEYWORDS[scene.id] ?? '',
}));
