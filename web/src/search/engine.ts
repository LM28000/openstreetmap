/**
 * Moteur de recherche : réunit les fournisseurs, classe, groupe par type.
 *
 * Tout ce qui est local (couches, objets, commandes) se calcule en quelques
 * millisecondes sans requête ; les lieux (réseau) arrivent à part, voir `places.ts`.
 */
import { clock } from '../core/clock';
import type { ModuleManager } from '../core/moduleManager';
import { bikesProvider } from './bikes';
import { chargersProvider } from './chargers';
import { commandsProvider } from './commands';
import { isochronesProvider } from './isochrones';
import { layersProvider } from './layers';
import { parseQuery } from './normalize';
import { planesProvider } from './planes';
import { shipsProvider } from './ships';
import { trainsProvider } from './trains';
import { transitProvider } from './transit';
import { KIND_LABELS, KIND_ORDER, type Kind, type Provider, type SearchContext, type SearchResult } from './types';

const PROVIDERS: readonly Provider[] = [
  trainsProvider,
  isochronesProvider,
  planesProvider,
  shipsProvider,
  transitProvider,
  bikesProvider,
  chargersProvider,
  layersProvider,
  commandsProvider,
];

/** Sous ce nombre de caractères, presque tout correspond : on n'affiche rien. */
export const MIN_QUERY_LENGTH = 2;
/** Résultats montrés par type, et avec un filtre de type actif. */
const PER_GROUP = 4;
const PER_GROUP_FILTERED = 8;

const context = (manager: ModuleManager): SearchContext => ({ manager, time: clock.now() });

/** Prépare les index des données arrivées depuis la dernière fois (appelé hors frappe). */
export function warmIndexes(manager: ModuleManager): void {
  const ctx = context(manager);
  for (const provider of PROVIDERS) provider.warm?.(ctx);
}

/** Résultats locaux, sans classement entre types. */
export function searchLocal(manager: ModuleManager, text: string): SearchResult[] {
  const query = parseQuery(text);
  // Une date courte (« 8h ») compte même sous le seuil.
  if (query.text.length < MIN_QUERY_LENGTH) return [];
  const ctx = context(manager);
  return PROVIDERS.flatMap((provider) => provider.search(query, ctx));
}

export interface Group {
  kind: Kind;
  label: string;
  results: SearchResult[];
}

/**
 * Groupe par type, chaque groupe trié, les groupes rangés par leur meilleur résultat :
 * le meilleur résultat de tous est donc le premier de la liste, prêt pour Entrée.
 * `filter` ne garde qu'un type.
 */
export function arrange(results: readonly SearchResult[], filter: Kind | null): Group[] {
  const groups: Group[] = [];
  for (const kind of KIND_ORDER) {
    if (filter && kind !== filter) continue;
    const own = results.filter((r) => r.kind === kind).sort((a, b) => b.score - a.score);
    // Même clé = même résultat vu deux fois (par deux fournisseurs) : on garde le premier.
    const unique = own.filter((r, i) => own.findIndex((o) => o.key === r.key) === i);
    if (unique.length > 0) groups.push({ kind, label: KIND_LABELS[kind], results: unique.slice(0, filter ? PER_GROUP_FILTERED : PER_GROUP) });
  }
  return groups.sort((a, b) => groupScore(b) - groupScore(a));
}

/**
 * Un lieu ou une gare est plus souvent ce qu'on cherche qu'une borne parmi 53 000 :
 * à correspondance égale, les types passent dans cet ordre.
 */
const KIND_BIAS: Record<Kind, number> = { lieu: 30, gare: 30, train: 10, avion: 10, navire: 0, reseau: 0, action: 0, velo: -40, borne: -50 };
const groupScore = (group: Group): number => group.results[0]!.score + KIND_BIAS[group.kind];
