// provisoire : remplacé par l'agent Recherche
import type { JSX } from 'react';
import type { ModuleManager } from '../core/moduleManager';

/** Boîte de recherche : ici seulement la forme visible, sans fonction (la vraie vient de l'agent Recherche). */
export function SearchBox(_props: { manager: ModuleManager }): JSX.Element {
  return (
    <div className="search-box-placeholder" role="search">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <path d="M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM16 16l4.5 4.5" />
      </svg>
      <input type="search" placeholder="Gare, train, ville, vol, navire, couche…" aria-label="Rechercher" />
      <kbd>⌘K</kbd>
    </div>
  );
}
