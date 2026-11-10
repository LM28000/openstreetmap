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
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number; lastY: number; lastTime: number; velocity: number; dragging: boolean } | null>(null);

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

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // Les boutons de la poignée gardent leur geste : seul le fond de l'en-tête se tire.
    if ((event.target as HTMLElement).closest('button:not(.sheet__handle), a, input')) return;
    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: heights[snap],
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
      dragging: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.dragging) {
      if (Math.abs(event.clientY - state.startY) < DRAG_THRESHOLD) return;
      state.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    const dt = Math.max(1, event.timeStamp - state.lastTime);
    state.velocity = 0.6 * state.velocity + 0.4 * ((event.clientY - state.lastY) / dt); // px/ms, positif vers le bas
    state.lastY = event.clientY;
    state.lastTime = event.timeStamp;
    setDragHeight(Math.min(heights.full, Math.max(heights.peek, state.startHeight - (event.clientY - state.startY))));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    drag.current = null;
    if (!state?.dragging) return;
    // Un geste vif part dans sa direction : on tient compte de l'élan, pas seulement de la position.
    const projected = (dragHeight ?? state.startHeight) - state.velocity * 160;
    setDragHeight(null);
    onSnap(nearest(projected));
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

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
          <div className="sheet__body">
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
