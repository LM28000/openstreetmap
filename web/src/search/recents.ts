/** Recherches récentes : les derniers résultats choisis, gardés dans le navigateur (si le stockage le permet). */
import type { Kind } from './types';

const KEY = 'carte-vivante:recherches-recentes';
const MAX = 6;

export interface Recent {
  /** Texte à remettre dans la barre pour retrouver le résultat. */
  query: string;
  kind: Kind;
  subtitle?: string;
}

export function readRecents(): Recent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is Recent => !!r && typeof r.query === 'string' && typeof r.kind === 'string').slice(0, MAX);
  } catch {
    return []; // stockage indisponible (navigation privée…) : pas de récents
  }
}

export function addRecent(recent: Recent): Recent[] {
  const next = [recent, ...readRecents().filter((r) => r.query !== recent.query)].slice(0, MAX);
  writeRecents(next);
  return next;
}

export function clearRecents(): Recent[] {
  writeRecents([]);
  return [];
}

function writeRecents(recents: Recent[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(recents));
  } catch {
    // stockage indisponible : la liste ne sera simplement pas retenue
  }
}
