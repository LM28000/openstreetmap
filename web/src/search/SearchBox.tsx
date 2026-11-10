/**
 * Recherche universelle : une seule barre pour les lieux, les gares, les trains,
 * les avions, les navires, les lignes, les stations, les bornes, les couches et les dates.
 *
 * Ouverte par ⌘K (Ctrl+K) ou « / ». Les résultats arrivent au fil de la frappe,
 * groupés par type, le meilleur en tête (Entrée l'ouvre). Flèches pour choisir,
 * Tab pour filtrer par type, Échap pour fermer.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ModuleManager } from '../core/moduleManager';
import { useModuleStates } from '../ui/hooks';
import { isLiveWord, parseWhen } from './dates';
import { arrange, MIN_QUERY_LENGTH, searchLocal, warmIndexes } from './engine';
import { fold } from './normalize';
import { replayResult, searchPlaces, type PlaceResult } from './places';
import { addRecent, clearRecents, readRecents, type Recent } from './recents';
import { KIND_LABELS, type Kind, type SearchResult } from './types';
import './search.css';

/** Délai de regroupement des frappes pour la recherche locale. */
const LOCAL_DELAY_MS = 30;
/** Délai avant d'interroger le service de géocodage (une requête par pause de frappe). */
const PLACES_DELAY_MS = 200;
const PLACES_MIN_LENGTH = 3;
/** Un lieu au moins aussi bien classé : on propose de le revoir hier. */
const REPLAY_MIN_SCORE = 280;

const EXAMPLES = ['Lyon', 'Part-Dieu', 'pluie', 'demain 8h', 'direct', 'relief'];

type PlacesState = 'idle' | 'loading' | 'error';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function SearchBox({ manager }: { manager: ModuleManager }) {
  const uid = useId();
  const listId = `${uid}-liste`;
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Kind | null>(null);
  const [active, setActive] = useState(0);
  const [recents, setRecents] = useState<Recent[]>(readRecents);
  const [local, setLocal] = useState<SearchResult[]>([]);
  const [places, setPlaces] = useState<PlaceResult[]>([]);
  const [placesState, setPlacesState] = useState<PlacesState>('idle');

  // Les modules publient un nouvel état à chaque donnée reçue : on y accroche la préparation des index
  // et le rafraîchissement des résultats « vivants » (départs, retards).
  const states = useModuleStates(manager);

  // Index prêts avant la frappe : en temps libre, après chaque arrivée de données.
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 200));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = idle(() => warmIndexes(manager));
    return () => cancel(handle);
  }, [manager, states]);

  // Recherche locale, décalée de quelques millisecondes pendant la frappe.
  useEffect(() => {
    if (!open || query.trim().length < MIN_QUERY_LENGTH) {
      setLocal([]);
      return;
    }
    const timer = window.setTimeout(() => {
      const started = performance.now();
      setLocal(searchLocal(manager, query));
      if (import.meta.env.DEV) Object.assign(window, { __recherche: { ms: performance.now() - started, query } });
    }, LOCAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [manager, query, open, states]);

  // Lieux : une requête par pause de frappe, la précédente annulée si elle est dépassée.
  useEffect(() => {
    const text = query.trim();
    // Une date, « direct » ou un numéro court ne désignent pas un lieu : inutile de questionner le service.
    const notAPlace = !!parseWhen(text) || isLiveWord(text) || /^\d{1,4}$/.test(text);
    if (!open || text.length < PLACES_MIN_LENGTH || notAPlace) {
      setPlaces([]);
      setPlacesState('idle');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setPlacesState('loading');
      searchPlaces(text, manager, controller.signal)
        .then((found) => {
          setPlaces(found);
          setPlacesState('idle');
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
          setPlaces([]);
          setPlacesState('error');
        });
    }, PLACES_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [manager, query, open]);

  // Raccourcis globaux : ⌘K / Ctrl+K partout, « / » hors d'un champ de saisie.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const typing = (event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]');
      const palette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      const slash = event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!palette && !slash) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Un clic ailleurs referme la liste.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const typed = query.trim().length >= MIN_QUERY_LENGTH;

  const all = useMemo<SearchResult[]>(() => {
    const extra: SearchResult[] = [];
    const best = places[0];
    // Seulement si le lieu est bien celui qu'on a tapé (« Lyon »), pas un lieu voisin par hasard.
    const typedName = fold(query);
    const exact = best && (fold(best.title) === typedName || fold(best.title).startsWith(`${typedName} `));
    if (best && exact && best.score >= REPLAY_MIN_SCORE) extra.push(replayResult(manager, best));
    return [...local, ...places, ...extra];
  }, [local, places, manager, query]);

  const groups = useMemo(() => arrange(all, filter), [all, filter]);
  const kindsPresent = useMemo(() => arrange(all, null).map((g) => g.kind), [all]);

  // Avant la frappe : les recherches récentes, proposées comme des résultats.
  const recentRows = useMemo<SearchResult[]>(
    () =>
      recents.map((recent) => ({
        key: `recent:${recent.query}`,
        kind: recent.kind,
        title: recent.query,
        subtitle: recent.subtitle,
        score: 0,
        run: () => undefined,
      })),
    [recents],
  );

  const rows: SearchResult[] = typed ? groups.flatMap((g) => g.results) : query.trim() ? [] : recentRows;
  const activeIndex = Math.min(active, rows.length - 1);
  const activeRow = rows[activeIndex];
  const optionId = (key: string) => `${uid}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const close = useCallback(() => {
    setOpen(false);
    setFilter(null);
  }, []);

  const choose = useCallback(
    (row: SearchResult) => {
      if (row.key.startsWith('recent:')) {
        setQuery(row.title);
        setActive(0);
        setFilter(null);
        inputRef.current?.focus();
        return;
      }
      row.run();
      // Un résultat « action » se retrouve par ce qu'on a tapé ; un objet, par son nom.
      const retrievable = !row.key.startsWith('date:') && !row.key.startsWith('revoir:');
      if (retrievable) setRecents(addRecent({ query: row.kind === 'action' ? query.trim() : row.title, kind: row.kind, subtitle: row.subtitle }));
      setQuery('');
      close();
      // Le focus quitte la barre : les raccourcis de la frise (espace, L) redeviennent actifs.
      inputRef.current?.blur();
    },
    [close, query],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      if (rows.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIndex + step + rows.length) % rows.length);
    } else if (event.key === 'Enter') {
      if (activeRow && open) {
        event.preventDefault();
        choose(activeRow);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
      close();
      inputRef.current?.blur();
    } else if (event.key === 'Tab' && open && typed && kindsPresent.length > 1) {
      // Tab filtre par type : tous les types, puis chacun de ceux qui ont des résultats.
      event.preventDefault();
      const cycle: Array<Kind | null> = [null, ...kindsPresent];
      const here = cycle.indexOf(filter);
      setFilter(cycle[(here + (event.shiftKey ? -1 : 1) + cycle.length) % cycle.length] ?? null);
      setActive(0);
    }
  };

  const status = !open
    ? ''
    : typed
      ? rows.length > 0
        ? `${rows.length} résultat${rows.length > 1 ? 's' : ''}`
        : placesState === 'loading'
          ? 'Recherche en cours'
          : 'Aucun résultat'
      : '';

  const showPanel = open && (typed || recentRows.length > 0 || query.trim() === '');

  return (
    <div
      className="search"
      ref={rootRef}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <div className={`search__bar${open ? ' search__bar--open' : ''}`}>
        <svg className="search__icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4.5 4.5" />
        </svg>
        <input
          ref={inputRef}
          className="search__input"
          type="text"
          role="combobox"
          aria-label="Rechercher : lieu, gare, train, avion, navire, couche, date"
          aria-expanded={showPanel}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeRow ? optionId(activeRow.key) : undefined}
          placeholder="Gare, train, ville, vol, navire, couche…"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          value={query}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setFilter(null);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        {query ? (
          <button
            type="button"
            className="search__clear"
            aria-label="Effacer la recherche"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setQuery('');
              setFilter(null);
              inputRef.current?.focus();
            }}
          >
            ×
          </button>
        ) : (
          <kbd className="search__key" aria-hidden="true">
            {open ? 'Échap' : isMac ? '⌘K' : 'Ctrl K'}
          </kbd>
        )}
      </div>

      <div className="search__sr" role="status" aria-live="polite">
        {status}
      </div>

      {showPanel && (
        <div className="search__panel">
          {typed && kindsPresent.length > 1 && (
            <div className="search__filters" role="toolbar" aria-label="Filtrer par type">
              <FilterChip label="Tout" pressed={filter === null} onPress={() => setFilter(null)} />
              {kindsPresent.map((kind) => (
                <FilterChip key={kind} label={KIND_LABELS[kind]} pressed={filter === kind} onPress={() => setFilter(kind)} />
              ))}
            </div>
          )}

          <div id={listId} className="search__list" role="listbox" aria-label={typed ? 'Résultats' : 'Recherches récentes'}>
            {typed ? (
              groups.map((group) => (
                <div key={group.kind} role="group" aria-labelledby={`${uid}-groupe-${group.kind}`}>
                  <div className="search__group" id={`${uid}-groupe-${group.kind}`}>
                    {group.label}
                  </div>
                  {group.results.map((row) => (
                    <Option
                      key={row.key}
                      id={optionId(row.key)}
                      row={row}
                      selected={row === activeRow}
                                           onHover={() => setActive(rows.indexOf(row))}
                      onChoose={() => choose(row)}
                    />
                  ))}
                </div>
              ))
            ) : recentRows.length > 0 ? (
              <div role="group" aria-labelledby={`${uid}-recents`}>
                <div className="search__group search__group--row" id={`${uid}-recents`}>
                  Recherches récentes
                  <button
                    type="button"
                    className="search__link"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setRecents(clearRecents())}
                  >
                    Effacer
                  </button>
                </div>
                {recentRows.map((row) => (
                  <Option
                    key={row.key}
                    id={optionId(row.key)}
                    row={row}
                    selected={row === activeRow}
                    onHover={() => setActive(recentRows.indexOf(row))}
                    onChoose={() => choose(row)}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {typed && rows.length === 0 && (
            <p className="search__note">{placesState === 'loading' ? 'Recherche en cours…' : `Aucun résultat pour « ${query.trim()} ».`}</p>
          )}
          {typed && placesState === 'error' && (
            <p className="search__note search__note--warn">Les lieux ne sont pas disponibles pour l’instant (géocodage de l’IGN injoignable).</p>
          )}
          {!typed && recentRows.length === 0 && (
            <p className="search__note">
              Essayez{' '}
              {EXAMPLES.map((example, i) => (
                <span key={example}>
                  {i > 0 && ', '}
                  <button
                    type="button"
                    className="search__link"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setQuery(example);
                      inputRef.current?.focus();
                    }}
                  >
                    {example}
                  </button>
                </span>
              ))}
              .
            </p>
          )}

          <div className="search__hints" aria-hidden="true">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> choisir
            </span>
            <span>
              <kbd>Entrée</kbd> ouvrir
            </span>
            <span>
              <kbd>⇥</kbd> filtrer par type
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, pressed, onPress }: { label: string; pressed: boolean; onPress: () => void }) {
  return (
    <button
      type="button"
      className={`search__chip${pressed ? ' search__chip--on' : ''}`}
      aria-pressed={pressed}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPress}
    >
      {label}
    </button>
  );
}

function Option(props: { id: string; row: SearchResult; selected: boolean; onHover: () => void; onChoose: () => void }) {
  const { row } = props;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      className={`search__option${props.selected ? ' search__option--active' : ''}`}
      // La souris ne doit pas voler le focus à la barre de saisie.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={props.onHover}
      onClick={props.onChoose}
    >
      <KindIcon kind={row.kind} />
      <span className="search__text">
        <span className="search__title">{row.title}</span>
        {row.subtitle && <span className="search__subtitle">{row.subtitle}</span>}
      </span>
      {row.live && <span className={`search__live${row.liveTone === 'alert' ? ' search__live--alert' : ''}`}>{row.live}</span>}
      {props.selected && (
        <kbd className="search__enter" aria-hidden="true">
          ↵
        </kbd>
      )}
    </div>
  );
}

const ICONS: Record<Kind, ReactNode> = {
  lieu: (
    <>
      <path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 1 0-13 0C5.5 15.4 12 21 12 21Z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  gare: (
    <>
      <path d="M4 20V9l8-5 8 5v11" />
      <path d="M9 20v-6h6v6" />
    </>
  ),
  train: (
    <>
      <rect x="6" y="3.5" width="12" height="13" rx="3" />
      <path d="M6 11h12M9 20l1.5-3.5M15 20l-1.5-3.5" />
    </>
  ),
  avion: <path d="M21 14.5 13.5 10V5a1.5 1.5 0 0 0-3 0v5L3 14.5V16l7.5-2v4L8.5 19.5V21l3.5-1 3.5 1v-1.5L13.5 18v-4L21 16Z" />,
  navire: (
    <>
      <path d="M3 17c2 0 2-1.5 4.5-1.5S10 17 12 17s2.5-1.5 4.5-1.5S19 17 21 17" />
      <path d="M5 14 4 9h16l-1 5M12 9V4h3" />
    </>
  ),
  reseau: (
    <>
      <rect x="5" y="3.5" width="14" height="14" rx="3" />
      <path d="M5 11h14M8 21v-3.5M16 21v-3.5" />
    </>
  ),
  velo: (
    <>
      <circle cx="6" cy="16" r="3.5" />
      <circle cx="18" cy="16" r="3.5" />
      <path d="M6 16l4-8h5l3 8M10 8H8M12 13l3-5" />
    </>
  ),
  borne: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6Z" />,
  action: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),
};

function KindIcon({ kind }: { kind: Kind }) {
  return (
    <svg className="search__kind" viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[kind]}
    </svg>
  );
}
