import type { ModuleManager } from '../core/moduleManager';
import type { Query } from './normalize';

/** Les types de résultats, dans l'ordre où l'on propose de les filtrer. */
export type Kind = 'lieu' | 'gare' | 'train' | 'avion' | 'navire' | 'reseau' | 'velo' | 'borne' | 'action';

export const KIND_LABELS: Record<Kind, string> = {
  lieu: 'Lieux',
  gare: 'Gares',
  train: 'Trains',
  avion: 'Avions',
  navire: 'Bateaux',
  reseau: 'Bus, trams et métros',
  velo: 'Vélos en libre-service',
  borne: 'Bornes de recharge',
  action: 'Couches et actions',
};

export const KIND_ORDER: readonly Kind[] = ['lieu', 'gare', 'train', 'avion', 'navire', 'reseau', 'velo', 'borne', 'action'];

export interface SearchResult {
  /** Identifiant stable (clé React et `id` de l'option). */
  key: string;
  kind: Kind;
  title: string;
  subtitle?: string;
  /** Information « vivante » affichée à droite : « 46 départs dans l'heure », « +4 min ». */
  live?: string;
  /** `alert` : le texte vivant signale un problème (retard important). */
  liveTone?: 'alert';
  /** Classement : plus grand = plus haut. Comparable d'un type à l'autre. */
  score: number;
  /** Ce que fait le résultat quand on le choisit. */
  run: () => void;
}

/** Ce que reçoit chaque fournisseur à chaque recherche. */
export interface SearchContext {
  manager: ModuleManager;
  /** Instant simulé, en millisecondes. */
  time: number;
}

export interface Provider {
  /** Prépare l'index si les données ont changé (appelé en temps libre, hors frappe). */
  warm?(ctx: SearchContext): void;
  search(query: Query, ctx: SearchContext): SearchResult[];
}
