import { useCallback, useEffect, useState } from 'react';
import { clock } from './core/clock';
import { ModuleManager } from './core/moduleManager';
import { applySharedState, hasSharedState, startSharedStateSync } from './core/shareState';
import { MapView } from './map/MapView';
import { MODULES } from './modules';
import { SearchBox } from './search/SearchBox';
import { InfoPanel } from './ui/InfoPanel';
import { LayerChips } from './ui/LayerChips';
import { LayerDrawer } from './ui/LayerDrawer';
import { MobileSheet, type Snap } from './ui/MobileSheet';
import { TimeBar } from './ui/TimeBar';
import { Welcome, shouldShowWelcome } from './ui/Welcome';
import { PHONE_QUERY, useMediaQuery } from './ui/hooks';

/** Un seul gestionnaire pour toute l'application : il survit aux remontages de React. */
const manager = new ModuleManager(MODULES);
/** L'adresse prime sur les préférences du navigateur : elle est appliquée avant le premier affichage. */
const openedFromSharedLink = hasSharedState();
applySharedState(manager);
/** Calculé une fois : le drapeau de première visite est posé ici, le double rendu de React ne doit pas l'annuler. */
const showWelcomeAtStart = shouldShowWelcome(openedFromSharedLink);

const HOUR = 3_600_000;

export function App() {
  const phone = useMediaQuery(PHONE_QUERY);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snap>('peek');
  const [welcome, setWelcome] = useState(showWelcomeAtStart);

  useEffect(() => startSharedStateSync(manager), []);

  /** « Couches » : le tiroir sur ordinateur, la moitié de la feuille sur téléphone. */
  const openLayers = useCallback(
    (layerId?: string) => {
      if (layerId) setExpandedId(layerId);
      if (phone) setSnap((current) => (current === 'peek' ? 'half' : current));
      else setDrawerOpen(true);
    },
    [phone],
  );
  const toggleLayers = useCallback(() => {
    if (phone) setSnap((current) => (current === 'peek' ? 'half' : 'peek'));
    else setDrawerOpen((open) => !open);
  }, [phone]);

  useShortcuts({
    toggleLayers,
    // Échap ferme ce qui est ouvert, du plus récent au plus ancien : accueil, couches, fiche.
    close: () => {
      if (welcome) return setWelcome(false);
      if (phone && snap !== 'peek') return setSnap(snap === 'full' ? 'half' : 'peek');
      if (!phone && drawerOpen) return setDrawerOpen(false);
      manager.setSelection(null, null);
    },
  });

  // Toucher la carte referme ce qui la recouvre (« tout s'ouvre à la demande et se referme seul »).
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.map') || target.closest('.maplibregl-ctrl')) return;
      setDrawerOpen(false);
      setSnap((current) => (current === 'peek' ? current : 'peek'));
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  return (
    <div className="app" data-sheet={phone ? snap : undefined}>
      <MapView manager={manager} />

      <div className="zone-tl">
        <div className="zone-tl__search">
          <SearchBox manager={manager} />
        </div>
        <LayerChips
          manager={manager}
          onOpenLayer={(id) => openLayers(id)}
          onOpenCatalog={phone ? toggleLayers : () => (drawerOpen ? setDrawerOpen(false) : openLayers())}
          catalogOpen={phone ? snap !== 'peek' : drawerOpen}
        />
        {!phone && drawerOpen && (
          <LayerDrawer manager={manager} expandedId={expandedId} onExpand={setExpandedId} onClose={() => setDrawerOpen(false)} />
        )}
      </div>

      {phone ? (
        <MobileSheet manager={manager} snap={snap} onSnap={setSnap} expandedId={expandedId} onExpand={setExpandedId} />
      ) : (
        <>
          <InfoPanel manager={manager} />
          <TimeBar />
        </>
      )}

      {welcome && <Welcome manager={manager} onClose={() => setWelcome(false)} />}
    </div>
  );
}

/**
 * Raccourcis : Espace lecture/pause · ← → −1 h/+1 h · L couches · Échap fermer.
 * (⌘K et / appartiennent à la recherche.) Ils n'agissent pas quand un champ de saisie a le focus.
 */
function useShortcuts({ toggleLayers, close }: { toggleLayers: () => void; close: () => void }) {
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && !!target.closest('input:not([type="range"]), textarea, select, [contenteditable="true"]');
    const plain = (event: KeyboardEvent) => !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;

    // Les flèches sont prises avant MapLibre, qui s'en sert pour déplacer la carte quand elle a le focus.
    const onArrow = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.target as HTMLElement | null;
      if (!plain(event) || typing(event.target) || target?.matches('input[type="range"], [role="radio"], [role="tab"]')) return;
      event.preventDefault();
      event.stopPropagation();
      clock.seek(clock.now() + (event.key === 'ArrowRight' ? HOUR : -HOUR));
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !plain(event) || typing(event.target)) return;
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape') {
        close();
      } else if (event.code === 'Space') {
        // Sur un bouton atteint au clavier, Espace l'active comme d'habitude ; après un clic à la souris, il lit ou met en pause.
        if (target?.matches('button:focus-visible, a:focus-visible, summary:focus-visible')) return;
        event.preventDefault();
        clock.toggle();
      } else if (event.key === 'l' || event.key === 'L') {
        event.preventDefault(); // sinon la lettre atterrit dans le filtre qui prend le focus à l'ouverture
        toggleLayers();
      }
    };

    window.addEventListener('keydown', onArrow, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onArrow, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [toggleLayers, close]);
}
