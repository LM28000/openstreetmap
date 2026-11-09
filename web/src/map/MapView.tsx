import { useEffect, useRef } from 'react';
import {
  AttributionControl,
  GlobeControl,
  Map as MapLibreMap,
  NavigationControl,
  TerrainControl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { clock } from '../core/clock';
import type { ModuleManager } from '../core/moduleManager';
import {
  BASE_STYLE_URL,
  INITIAL_VIEW,
  TERRAIN_EXAGGERATION,
  TERRAIN_SOURCE,
  ignoreMissingIcons,
  keepGlobeAndTerrainApart,
  setupBaseMap,
} from './baseMap';

/** Au plus une notification « la vue a changé » par seconde (la caméra qui suit un train bouge sans arrêt). */
const VIEW_NOTIFY_INTERVAL_MS = 1_000;

export function MapView({ manager }: { manager: ModuleManager }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const map = new MapLibreMap({
      container,
      style: BASE_STYLE_URL,
      ...INITIAL_VIEW,
      maxPitch: 80,
      hash: 'vue', // la vue est gardée dans l'adresse : on peut la partager ou recharger
      attributionControl: false,
    });
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new GlobeControl(), 'top-right');
    map.addControl(new TerrainControl({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION }), 'top-right');
    keepGlobeAndTerrainApart(map);
    ignoreMissingIcons(map);

    // Le relief arrive par tuiles, et sa précision change avec le zoom : on prévient
    // les modules posés dessus, au plus quatre fois par seconde.
    let terrainTimer: ReturnType<typeof setTimeout> | undefined;
    const onTerrainChanged = () => {
      terrainTimer ??= setTimeout(() => {
        terrainTimer = undefined;
        manager.notifyTerrainChanged();
      }, 250);
    };
    map.on('sourcedata', (event) => {
      if (event.sourceId === TERRAIN_SOURCE && event.tile) onTerrainChanged();
    });
    map.on('terrain', onTerrainChanged);

    let viewTimer: ReturnType<typeof setTimeout> | undefined;
    map.on('moveend', () => {
      viewTimer ??= setTimeout(() => {
        viewTimer = undefined;
        manager.notifyViewChanged();
      }, VIEW_NOTIFY_INTERVAL_MS);
      onTerrainChanged();
    });
    // Déplacer la carte à la main arrête de suivre la sélection (zoomer ou tourner, non).
    map.on('dragstart', () => manager.setFollowing(false));

    // deck.gl dessine dans le même contexte WebGL que MapLibre (« interleaved ») :
    // ses couches se mélangent correctement avec le relief et les bâtiments.
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onClick: (info: PickingInfo) => manager.pick(info.layer?.id, info.object),
      getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    });

    // En développement, la carte est accessible depuis la console : window.__carte.map, etc.
    if (import.meta.env.DEV) Object.assign(window, { __carte: { map, overlay, clock, manager } });

    let frameRequest = 0;
    const tick = () => {
      const time = clock.now();
      const target = manager.followTarget(time);
      if (target) map.jumpTo({ center: [target.lon, target.lat] });
      const layers = manager.frame(time);
      if (layers) overlay.setProps({ layers });
      frameRequest = requestAnimationFrame(tick);
    };

    map.on('style.load', () => setupBaseMap(map));
    map.once('load', () => {
      map.addControl(overlay);
      manager.attachMap(map);
      frameRequest = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frameRequest);
      clearTimeout(terrainTimer);
      clearTimeout(viewTimer);
      manager.detachMap();
      map.remove();
    };
  }, [manager]);

  return <div ref={containerRef} className="map" />;
}
