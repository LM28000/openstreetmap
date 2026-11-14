import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ModuleManager } from '../core/moduleManager';
import { formatShortDate, formatTime } from './format';
import { useClockState, useClockTime, useSelectionInfo } from './hooks';
import { Icon } from './icons';
import { InfoBody, InfoSummary } from './InfoPanel';
import { LayerCatalog } from './LayerDrawer';
import { LivePill, TimeBar } from './TimeBar';

export type Snap = 'peek' | 'half' | 'full';
const SNAPS: readonly Snap[] = ['peek', 'half', 'full'];
/** Place laissée en haut quand la feuille est en plein écran : la recherche et les pastilles restent visibles. */
const FULL_TOP_GAP = 112;
const PEEK_HEIGHT = 68;
const PEEK_HEIGHT_WITH_SELECTION = 100;
/** Au-delà de ce déplacement (pixels), le geste est un glisser et non un appui. */
const DRAG_THRESHOLD = 6;

interface DragState {
  /** Identifiant du pointeur de la poignée, ou -1 pour un glisser commencé sur le contenu (événements tactiles). */
  pointerId: number;
  startY: number;
  startHeight: number;
  lastY: number;
  lastTime: number;
  velocity: number;
  dragging: boolean;
  /** Dernière hauteur donnée à la feuille pendant le glisser (lue à la fin du geste, hors du rendu). */
  height: number;
}

/** Vrai si l'élément, ou un parent jusqu'au corps de la feuille, a du contenu au-dessus de ce qu'il montre : on peut encore remonter. */
function canScrollUp(from: EventTarget | null, root: HTMLElement): boolean {
  for (let el = from instanceof HTMLElement ? from : null; el; el = el.parentElement) {
    if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) return true;
    if (el === root) break;
  }
  return false;
}

interface MobileSheetProps {
  manager: ModuleManager;
  snap: Snap;
  onSnap: (snap: Snap) => void;
  expandedId: string | null;
  onExpand: (id: string | null) => void;
}

/**
 * Feuille du téléphone, tirée du bas. Trois hauteurs : poignée (fiche résumée ou heure),
 * moitié (fiche ou catalogue, et frise compacte), plein écran. On la tire au doigt.
 */
export function MobileSheet({ manager, snap, onSnap, expandedId, onExpand }: MobileSheetProps) {
  const { selection, info } = useSelectionInfo(manager);
  const [tab, setTab] = useState<'fiche' | 'couches'>('couches');
  const [viewport, setViewport] = useState(() => window.innerHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const drag = useRef<DragState | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  const peek = selection ? PEEK_HEIGHT_WITH_SELECTION : PEEK_HEIGHT;
  const heights: Record<Snap, number> = { peek, half: Math.round(viewport * 0.56), full: viewport - FULL_TOP_GAP };
  const height = dragHeight ?? heights[snap];

  useEffect(() => {
    const onResize = () => setViewport(window.visualViewport?.height ?? window.innerHeight);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
    };
  }, []);

  // Les commandes de la carte et les crédits se posent au-dessus de la feuille : ils lisent sa hauteur.
  useLayoutEffect(() => {
    document.documentElement.style.setProperty('--sheet-h', `${height}px`);
    return () => {
      document.documentElement.style.removeProperty('--sheet-h');
    };
  }, [height]);

  // Un nouvel objet touché ouvre sa fiche ; sans objet, il ne reste que le catalogue.
  const selectionKey = selection ? `${selection.moduleId}:${JSON.stringify(selection.value)}` : '';
  useEffect(() => {
    setTab(selectionKey ? 'fiche' : 'couches');
  }, [selectionKey]);

  const nearest = (value: number): Snap =>
    SNAPS.reduce((best, s) => (Math.abs(heights[s] - value) < Math.abs(heights[best] - value) ? s : best), 'peek' as Snap);

  // Le geste est commun à la poignée (pointeur) et au contenu (toucher) : on suit le doigt, puis on retombe sur le cran le plus proche.
  const beginDrag = (pointerId: number, y: number, time: number) => {
    drag.current = { pointerId, startY: y, startHeight: heights[snap], lastY: y, lastTime: time, velocity: 0, dragging: false, height: heights[snap] };
  };
  const moveDrag = (state: DragState, y: number, time: number) => {
    const dt = Math.max(1, time - state.lastTime);
    state.velocity = 0.6 * state.velocity + 0.4 * ((y - state.lastY) / dt); // px/ms, positif vers le bas
    state.lastY = y;
    state.lastTime = time;
    state.height = Math.min(heights.full, Math.max(heights.peek, state.startHeight - (y - state.startY)));
    setDragHeight(state.height);
  };
  const finishDrag = () => {
    const state = drag.current;
    drag.current = null;
    if (!state?.dragging) return false;
    // Un geste vif part dans sa direction : on tient compte de l'élan, pas seulement de la position.
    setDragHeight(null);
    onSnap(nearest(state.height - state.velocity * 160));
    return true;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Les boutons de la poignée gardent leur geste : seul le fond de l'en-tête se tire.
    if ((event.target as HTMLElement).closest('button:not(.sheet__handle), a, input')) return;
    beginDrag(event.pointerId, event.clientY, event.timeStamp);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.dragging) {
      if (Math.abs(event.clientY - state.startY) < DRAG_THRESHOLD) return;
      state.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    moveDrag(state, event.clientY, event.timeStamp);
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (finishDrag()) event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  // Le contenu défile au doigt ; quand il est tout en haut, tirer vers le bas emmène la feuille (comme sur iOS et Android).
  // Les écouteurs sont natifs : ceux de React sont passifs, et il faut pouvoir retenir le défilement en cours de geste.
  const latest = useRef({ beginDrag, moveDrag, finishDrag });
  latest.current = { beginDrag, moveDrag, finishDrag };
  useEffect(() => {
    const body = sectionRef.current?.querySelector<HTMLElement>('.sheet__body');
    if (!body || snap === 'peek') return;
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch) return;
      // Si le contenu peut encore remonter, le geste lui appartient : on ne s'en mêle pas.
      if (canScrollUp(event.target, body)) return;
      latest.current.beginDrag(-1, touch.clientY, event.timeStamp);
    };
    const onMove = (event: TouchEvent) => {
      const state = drag.current;
      const touch = event.touches[0];
      if (!state || state.pointerId !== -1 || !touch) return;
      if (!state.dragging) {
        // Vers le haut, c'est le contenu qui défile : on laisse la main au navigateur.
        if (touch.clientY - state.startY < 0) return void (drag.current = null);
        if (touch.clientY - state.startY < DRAG_THRESHOLD) return;
        state.dragging = true;
      }
      if (event.cancelable) event.preventDefault();
      latest.current.moveDrag(state, touch.clientY, event.timeStamp);
    };
    const onEnd = () => {
      if (drag.current?.pointerId === -1) latest.current.finishDrag();
    };
    body.addEventListener('touchstart', onStart, { passive: true });
    body.addEventListener('touchmove', onMove, { passive: false });
    body.addEventListener('touchend', onEnd);
    body.addEventListener('touchcancel', onEnd);
    return () => {
      body.removeEventListener('touchstart', onStart);
      body.removeEventListener('touchmove', onMove);
      body.removeEventListener('touchend', onEnd);
      body.removeEventListener('touchcancel', onEnd);
    };
  }, [snap]);

  const onHandleKey = (event: KeyboardEvent) => {
    const i = SNAPS.indexOf(snap);
    if (event.key === 'ArrowUp' && i < SNAPS.length - 1) onSnap(SNAPS[i + 1]!);
    else if (event.key === 'ArrowDown' && i > 0) onSnap(SNAPS[i - 1]!);
    else return;
    event.preventDefault();
  };

  const toggle = () => onSnap(snap === 'peek' ? 'half' : 'peek');

  return (
    <section
      ref={sectionRef}
      className={`sheet panel${dragHeight !== null ? ' sheet--dragging' : ''}`}
      style={{ height }}
      aria-label="Fiche, couches et temps"
    >
      <div
        className="sheet__grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <button
          type="button"
          className="sheet__handle"
          aria-label={snap === 'peek' ? 'Ouvrir la feuille' : 'Réduire la feuille'}
          aria-expanded={snap !== 'peek'}
          onClick={toggle}
          onKeyDown={onHandleKey}
        />
        {snap === 'peek' ? (
          <PeekRow manager={manager} info={info} hasSelection={!!selection} onOpen={() => onSnap('half')} />
        ) : selection && info ? (
          <div className="sheet__tabs" role="tablist" aria-label="Contenu de la feuille">
            <button type="button" role="tab" aria-selected={tab === 'fiche'} className="sheet__tab" onClick={() => setTab('fiche')}>
              Fiche
            </button>
            <button type="button" role="tab" aria-selected={tab === 'couches'} className="sheet__tab" onClick={() => setTab('couches')}>
              Couches
            </button>
          </div>
        ) : (
          <h2 className="sheet__title">Couches</h2>
        )}
      </div>

      {snap !== 'peek' && (
        <>
          <div className={`sheet__body${selection && info && tab === 'fiche' ? '' : ' sheet__body--catalog'}`}>
            {selection && info && tab === 'fiche' ? (
              <div className="sheet__fiche">
                <InfoBody manager={manager} selection={selection} info={info} />
              </div>
            ) : (
              <LayerCatalog manager={manager} expandedId={expandedId} onExpand={onExpand} />
            )}
          </div>
          <div className="sheet__time">
            <TimeBar compact />
          </div>
        </>
      )}
    </section>
  );
}

/** Contenu de la poignée : la fiche résumée de l'objet touché, sinon le direct, l'heure et le bouton des couches. */
function PeekRow({
  manager,
  info,
  hasSelection,
  onOpen,
}: {
  manager: ModuleManager;
  info: ReturnType<ModuleManager['describeSelection']>;
  hasSelection: boolean;
  onOpen: () => void;
}) {
  const { live } = useClockState();
  const time = useClockTime(1_000);
  if (hasSelection && info) {
    return (
      <div className="sheet__peek">
        <InfoSummary info={info} />
        <button type="button" className="icon-button" onClick={() => manager.setSelection(null, null)} aria-label="Fermer la fiche">
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }
  return (
    <div className="sheet__peek">
      <LivePill live={live} short />
      <span className="sheet__clock">
        {formatTime(time)}
        <small>{formatShortDate(time)}</small>
      </span>
      <button type="button" className="chip chip--add" onClick={onOpen}>
        <Icon name="layers" size={16} />
        Couches
      </button>
    </div>
  );
}
