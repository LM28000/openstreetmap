import { useEffect, useRef, useState } from 'react';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { IControl, MapMouseEvent, Map as MapLibreMap } from 'maplibre-gl';
import type { ModuleManager } from '../core/moduleManager';
import {
  MAX_AREA_KM2,
  MAX_RADIUS_M,
  type Position,
  type ZoneShape,
  clampRadius,
  distanceM,
  ringAreaKm2,
  shapeAreaKm2,
  shapeRing,
  useZone,
  zoneStore,
} from '../core/zone';
import { Icon } from './icons';
import { ZonePanel } from './ZonePanel';

/**
 * Outil « Analyser une zone » : un bouton parmi les commandes de la carte, un dessin (cercle ou polygone), un contour sur la carte
 * et le panneau des résultats (`ZonePanel`).
 *
 * # Dessiner sans gêner la carte
 *
 * - **Cercle** : on appuie au centre et on glisse jusqu'au bord (souris ou doigt : les *événements de pointeur* couvrent les deux).
 *   Pendant le glisser, le déplacement de la carte est suspendu. Sans glisser (un simple toucher), le centre est posé et un second
 *   toucher donne le rayon : c'est le geste du téléphone quand glisser est malcommode.
 * - **Polygone** : un clic (ou toucher) ajoute un sommet ; double-clic, toucher du premier sommet, Entrée ou « Terminer » ferment.
 *   Le zoom par double-clic est suspendu pendant ce temps. Déplacer la carte reste possible (un clic qui suit un glisser n'ajoute rien).
 *
 * Les clics sur la carte atteignent aussi la couche qui est dessous (deck.gl) : la fiche d'un objet pourrait s'ouvrir par erreur. Le CSS
 * masque les fiches pendant le dessin (`.app[data-zone-drawing]`) et la sélection est vidée à la fin.
 */

const CLOSE_RADIUS_PX = 16;

/** La carte, dès qu'elle est branchée (le gestionnaire ne prévient pas) et si React la recrée. */
function useMap(manager: ModuleManager): MapLibreMap | undefined {
  const [map, setMap] = useState<MapLibreMap | undefined>(() => manager.getMap());
  useEffect(() => {
    const check = () => setMap((current) => (manager.getMap() === current ? current : manager.getMap()));
    check();
    const timer = setInterval(check, 400);
    return () => clearInterval(timer);
  }, [manager]);
  return map;
}

/** Le bouton des commandes de la carte (en bas à droite, avec le zoom et le relief). */
class ZoneControl implements IControl {
  private container = document.createElement('div');
  private button = document.createElement('button');
  private unsubscribe: (() => void) | undefined;

  onAdd(): HTMLElement {
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group maplibregl-ctrl-zone';
    this.button.type = 'button';
    this.button.title = 'Analyser une zone : dessiner un cercle ou un polygone';
    this.button.setAttribute('aria-label', 'Analyser une zone');
    this.button.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7.5 12 4l8 4.5-1.5 9L12 20l-6.5-3Z" stroke-dasharray="2.5 2.5"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/></svg>';
    this.button.addEventListener('click', () => {
      const { mode } = zoneStore.getSnapshot();
      if (mode === 'off') zoneStore.startDrawing('circle');
      else zoneStore.cancelDrawing();
    });
    this.container.append(this.button);
    const refresh = () => {
      const { mode, shape } = zoneStore.getSnapshot();
      this.button.classList.toggle('is-active', mode !== 'off' || !!shape);
      this.button.setAttribute('aria-pressed', String(mode !== 'off'));
    };
    this.unsubscribe = zoneStore.subscribe(refresh);
    refresh();
    return this.container;
  }

  onRemove(): void {
    this.unsubscribe?.();
    this.container.remove();
  }
}

/**
 * Le contour est dessiné par une **surcouche deck.gl à part** (non entrelacée, donc au-dessus de tout) et non par des couches MapLibre :
 * MapLibre teste la profondeur, et un contour posé au sol disparaît derrière les colonnes 3D de la population ou des prix.
 */
const ACCENT_RGB: [number, number, number] = [255, 138, 61];
const closed = (ring: Position[]) => [...ring, ring[0]!];

function overlayLayers(shape: ZoneShape | null, draft: ZoneShape | null, cursor: Position | null) {
  const polygons: Position[][] = [];
  const paths: Position[][] = [];
  const vertices: Array<{ p: Position; first: boolean }> = [];
  if (shape) {
    polygons.push(shapeRing(shape));
    paths.push(closed(shapeRing(shape)));
  }
  if (draft?.kind === 'circle') {
    if (draft.radius > 0) {
      polygons.push(shapeRing(draft));
      paths.push(closed(shapeRing(draft)));
    }
    vertices.push({ p: draft.center, first: true });
  }
  if (draft?.kind === 'polygon') {
    const points = draft.points;
    if (points.length >= 3) polygons.push(points);
    const line = cursor && points.length > 0 ? [...points, cursor] : points;
    if (line.length >= 2) paths.push(line);
    points.forEach((p, i) => vertices.push({ p, first: i === 0 }));
  }
  const common = { parameters: { depthCompare: 'always' as const } };
  return [
    new PolygonLayer<Position[]>({ id: 'zone-fill', data: polygons, getPolygon: (d) => d, getFillColor: [...ACCENT_RGB, 38], stroked: false, pickable: false, ...common }),
    new PathLayer<Position[]>({ id: 'zone-halo', data: paths, getPath: (d) => d, getColor: [255, 255, 255, 235], getWidth: 6, widthUnits: 'pixels', capRounded: true, jointRounded: true, pickable: false, ...common }),
    new PathLayer<Position[]>({ id: 'zone-line', data: paths, getPath: (d) => d, getColor: [...ACCENT_RGB, 255], getWidth: 3, widthUnits: 'pixels', capRounded: true, jointRounded: true, pickable: false, ...common }),
    new ScatterplotLayer<{ p: Position; first: boolean }>({
      id: 'zone-vertex',
      data: vertices,
      getPosition: (d) => d.p,
      getRadius: (d) => (d.first ? 8 : 5.5),
      radiusUnits: 'pixels',
      getFillColor: [255, 255, 255, 255],
      getLineColor: [...ACCENT_RGB, 255],
      getLineWidth: 3,
      lineWidthUnits: 'pixels',
      stroked: true,
      pickable: false,
      ...common,
    }),
  ];
}

const fmtKm = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km` : `${Math.round(m)} m`);
const fmtArea = (km2: number) => `${km2.toLocaleString('fr-FR', { maximumFractionDigits: km2 < 10 ? 1 : 0 })} km²`;

export function ZoneTool({ manager, phone }: { manager: ModuleManager; phone: boolean }) {
  const zone = useZone();
  const map = useMap(manager);

  // Le bouton des commandes.
  useEffect(() => {
    if (!map) return;
    const control = new ZoneControl();
    map.addControl(control, 'bottom-right');
    return () => {
      map.removeControl(control);
    };
  }, [map]);

  // Le contour : la surcouche suit l'état.
  const [cursor, setCursor] = useState<Position | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  useEffect(() => {
    if (!map) return;
    const deck = new MapboxOverlay({ interleaved: false, layers: [] });
    map.addControl(deck);
    overlay.current = deck;
    return () => {
      overlay.current = null;
      map.removeControl(deck);
    };
  }, [map]);
  useEffect(() => {
    overlay.current?.setProps({ layers: overlayLayers(zone.shape, zone.draft, cursor) });
  }, [map, zone.shape, zone.draft, cursor]);

  // Sur téléphone, le panneau couvre le bas de l'écran : à chaque nouvelle zone, on la cadre dans ce qui reste visible.
  useEffect(() => {
    if (!map || !phone || !zone.shape) return;
    const ring = shapeRing(zone.shape);
    const lons = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const height = map.getContainer().clientHeight;
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], {
      padding: { top: 130, bottom: height * 0.62 + 24, left: 28, right: 28 },
      maxZoom: 15,
      duration: 500,
    });
    // seule la zone (et non l'état de la fenêtre) déclenche le cadrage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, zone.shape]);

  // Pendant le dessin : les fiches d'objets sont masquées (voir le CSS) et vidées à la fin.
  useEffect(() => {
    const app = document.querySelector('.app');
    if (zone.mode === 'off') {
      app?.removeAttribute('data-zone-drawing');
      return;
    }
    app?.setAttribute('data-zone-drawing', zone.mode);
    return () => {
      app?.removeAttribute('data-zone-drawing');
      // Le geste qui termine le dessin (second toucher, double-clic) atteint aussi la couche des objets, un instant après : on vide deux fois.
      manager.setSelection(null, null);
      setTimeout(() => manager.setSelection(null, null), 350);
    };
  }, [zone.mode, manager]);

  useDrawing(map, zone.mode, setCursor);

  // Une fiche d'objet prend la place du panneau (même endroit), et le rend quand on la ferme.
  const [selected, setSelected] = useState(() => manager.getSelection() != null);
  useEffect(() => {
    const refresh = () => setSelected(manager.getSelection() != null);
    return manager.subscribe(refresh);
  }, [manager]);

  return (
    <>
      {zone.mode !== 'off' && <DrawBar phone={phone} />}
      {zone.shape && zone.mode === 'off' && !selected && zone.panelOpen && <ZonePanel phone={phone} />}
      {zone.shape && zone.mode === 'off' && selected && (
        <button type="button" className="zone-chip" onClick={() => manager.setSelection(null, null)}>
          <Icon name="x" size={14} /> Revenir à l’analyse de la zone
        </button>
      )}
    </>
  );
}

/** La barre de dessin : choix de la forme, consigne, mesure en direct. */
function DrawBar({ phone }: { phone: boolean }) {
  const { mode, draft } = useZone();
  const radius = draft?.kind === 'circle' ? draft.radius : 0;
  const vertices = draft?.kind === 'polygon' ? draft.points.length : 0;
  const area = draft && (draft.kind === 'circle' ? radius > 0 : vertices >= 3) ? shapeAreaKm2(draft) : 0;
  const tooBig = area > MAX_AREA_KM2;
  const hint =
    mode === 'circle'
      ? draft ? (radius > 0 ? `Rayon ${fmtKm(radius)}` : 'Touchez le bord du cercle') : phone ? 'Glissez du centre au bord, ou touchez le centre puis le bord' : 'Glissez du centre jusqu’au bord'
      : vertices === 0
        ? phone ? 'Touchez la carte pour poser les sommets' : 'Cliquez pour poser les sommets'
        : `${vertices} sommet${vertices > 1 ? 's' : ''}${area > 0 ? ` · ${fmtArea(area)}` : ''}${phone ? '' : ' · double-clic pour fermer'}`;
  return (
    <div className="zone-bar panel" role="toolbar" aria-label="Dessiner une zone">
      <div className="zone-bar__modes" role="radiogroup" aria-label="Forme de la zone">
        {(['circle', 'polygon'] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className={`zone-bar__mode${mode === m ? ' is-on' : ''}`} onClick={() => zoneStore.startDrawing(m)}>
            {m === 'circle' ? 'Cercle' : 'Polygone'}
          </button>
        ))}
      </div>
      <span className={`zone-bar__hint mono${tooBig ? ' is-error' : ''}`} aria-live="polite">
        {tooBig ? `Trop grand : ${fmtArea(area)} (max ${MAX_AREA_KM2.toLocaleString('fr-FR')} km²)` : hint}
      </span>
      {mode === 'polygon' && vertices > 0 && (
        <button type="button" className="btn btn--small" onClick={() => zoneStore.setDraft(vertices > 1 ? { kind: 'polygon', points: (draft as { points: Position[] }).points.slice(0, -1) } : null)}>
          Annuler le dernier
        </button>
      )}
      {mode === 'polygon' && vertices >= 3 && (
        <button type="button" className="btn btn--small btn--primary" disabled={tooBig} onClick={() => finishPolygon()}>
          Terminer
        </button>
      )}
      <button type="button" className="btn btn--small" onClick={() => zoneStore.cancelDrawing()}>
        Annuler
      </button>
    </div>
  );
}

function finishPolygon(): void {
  const { draft } = zoneStore.getSnapshot();
  if (draft?.kind !== 'polygon' || draft.points.length < 3) return;
  const clean = dedupe(draft.points);
  if (clean.length >= 3 && ringAreaKm2(clean) <= MAX_AREA_KM2) zoneStore.commit({ kind: 'polygon', points: clean });
}

/** Retire les sommets confondus (le double-clic en pose deux au même endroit). */
function dedupe(points: Position[]): Position[] {
  return points.filter((p, i) => i === 0 || distanceM(points[i - 1]!, p) > 2);
}

/** Les gestes de dessin (voir l'en-tête du fichier). */
function useDrawing(map: MapLibreMap | undefined, mode: 'off' | 'circle' | 'polygon', setCursor: (p: Position | null) => void): void {
  useEffect(() => {
    if (!map || mode === 'off') return;
    const container = map.getCanvasContainer();
    const lngLat = (event: { clientX: number; clientY: number }): Position => {
      const rect = container.getBoundingClientRect();
      const p = map.unproject([event.clientX - rect.left, event.clientY - rect.top]);
      return [p.lng, p.lat];
    };
    const previousCursor = container.style.cursor;
    container.style.cursor = 'crosshair';
    zoneStore.setDraft(null);
    setCursor(null);

    const cleanups: Array<() => void> = [() => (container.style.cursor = previousCursor)];

    if (mode === 'circle') {
      map.dragPan.disable();
      cleanups.push(() => map.dragPan.enable());
      let center: Position | null = null; // centre posé (par glisser ou par toucher)
      let pressed = false;
      let moved = false;
      let downAt: Position | null = null;
      const setRadius = (p: Position) => {
        if (center) zoneStore.setDraft({ kind: 'circle', center, radius: Math.min(distanceM(center, p), MAX_RADIUS_M * 1.01) });
      };
      const onDown = (e: PointerEvent) => {
        if ((e.pointerType === 'mouse' && e.button !== 0) || !e.isPrimary) return;
        const p = lngLat(e);
        if (center && !pressed) {
          // Second toucher : il donne le bord du cercle.
          setRadius(p);
          commit();
          return;
        }
        center = p;
        downAt = p;
        pressed = true;
        moved = false;
        container.setPointerCapture?.(e.pointerId);
        zoneStore.setDraft({ kind: 'circle', center, radius: 0 });
      };
      const onMove = (e: PointerEvent) => {
        if (!center || !e.isPrimary) return;
        if (pressed) {
          const p = lngLat(e);
          if (!moved && downAt && distanceM(downAt, p) < 1) return;
          moved = true;
          setRadius(p);
        } else if (e.pointerType === 'mouse') setRadius(lngLat(e)); // tap-tap à la souris : le cercle suit le pointeur
      };
      const onUp = (e: PointerEvent) => {
        if (!pressed || !e.isPrimary) return;
        pressed = false;
        container.releasePointerCapture?.(e.pointerId);
        if (moved) {
          setRadius(lngLat(e));
          commit();
        }
        // Sans glisser : le centre reste posé, on attend le second toucher.
      };
      const commit = () => {
        const { draft } = zoneStore.getSnapshot();
        if (draft?.kind === 'circle' && center && draft.radius > 0) {
          zoneStore.commit({ kind: 'circle', center, radius: clampRadius(draft.radius) });
        }
      };
      container.addEventListener('pointerdown', onDown);
      container.addEventListener('pointermove', onMove);
      container.addEventListener('pointerup', onUp);
      container.addEventListener('pointercancel', onUp);
      cleanups.push(() => {
        container.removeEventListener('pointerdown', onDown);
        container.removeEventListener('pointermove', onMove);
        container.removeEventListener('pointerup', onUp);
        container.removeEventListener('pointercancel', onUp);
      });
    } else {
      map.doubleClickZoom.disable();
      cleanups.push(() => map.doubleClickZoom.enable());
      const points = (): Position[] => {
        const { draft } = zoneStore.getSnapshot();
        return draft?.kind === 'polygon' ? draft.points : [];
      };
      const onClick = (e: MapMouseEvent) => {
        const current = points();
        const here: Position = [e.lngLat.lng, e.lngLat.lat];
        if (current.length >= 3) {
          const first = map.project(current[0]!);
          if (Math.hypot(first.x - e.point.x, first.y - e.point.y) < CLOSE_RADIUS_PX) return finishPolygon();
        }
        zoneStore.setDraft({ kind: 'polygon', points: [...current, here] });
      };
      const onDblClick = (e: MapMouseEvent) => {
        e.preventDefault();
        // Les deux clics du double-clic ont posé le même sommet : on en retire un, puis on ferme.
        const current = points();
        if (current.length >= 2 && distanceM(current[current.length - 1]!, current[current.length - 2]!) < 30) {
          zoneStore.setDraft({ kind: 'polygon', points: current.slice(0, -1) });
        }
        finishPolygon();
      };
      const onMouseMove = (e: MapMouseEvent) => setCursor([e.lngLat.lng, e.lngLat.lat]);
      map.on('click', onClick);
      map.on('dblclick', onDblClick);
      map.on('mousemove', onMouseMove);
      cleanups.push(() => {
        map.off('click', onClick);
        map.off('dblclick', onDblClick);
        map.off('mousemove', onMouseMove);
      });
    }

    // Clavier : Échap annule, Entrée ferme le polygone, Retour arrière retire le dernier sommet.
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, select')) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        zoneStore.cancelDrawing();
      } else if (mode === 'polygon' && e.key === 'Enter') {
        finishPolygon();
      } else if (mode === 'polygon' && (e.key === 'Backspace' || e.key === 'Delete')) {
        const { draft } = zoneStore.getSnapshot();
        if (draft?.kind === 'polygon') zoneStore.setDraft(draft.points.length > 1 ? { kind: 'polygon', points: draft.points.slice(0, -1) } : null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    cleanups.push(() => window.removeEventListener('keydown', onKey, true));

    return () => {
      for (const cleanup of cleanups) cleanup();
      setCursor(null);
    };
  }, [map, mode, setCursor]);
}
