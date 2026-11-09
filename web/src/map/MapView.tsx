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
import type { InfoContent } from '../core/module';
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

export interface Pick {
  moduleName: string;
  content: InfoContent;
}

interface MapViewProps {
  manager: ModuleManager;
  onPick: (pick: Pick | null) => void;
}

export function MapView({ manager, onPick }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onPickRef = useRef(onPick);

  useEffect(() => {
    onPickRef.current = onPick;
  }, [onPick]);

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
    map.on('moveend', () => {
      manager.notifyViewChanged();
      onTerrainChanged();
    });

    // deck.gl dessine dans le même contexte WebGL que MapLibre (« interleaved ») :
    // ses couches se mélangent correctement avec le relief et les bâtiments.
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      onClick: (info: PickingInfo) => {
        const owner = info.layer ? manager.ownerOf(info.layer.id) : undefined;
        const content = owner && info.object != null ? (owner.describe?.(info.object) ?? null) : null;
        onPickRef.current(owner && content ? { moduleName: owner.name, content } : null);
      },
      getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    });

    let frameRequest = 0;
    const tick = () => {
      const layers = manager.frame(clock.now());
      if (layers) overlay.setProps({ layers });
      frameRequest = requestAnimationFrame(tick);
    };

    // En développement, la carte est accessible depuis la console : window.__carte.map, etc.
    if (import.meta.env.DEV) Object.assign(window, { __carte: { map, overlay, clock, manager } });

    map.on('style.load', () => setupBaseMap(map));
    map.once('load', () => {
      map.addControl(overlay);
      manager.attachMap(map);
      frameRequest = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frameRequest);
      clearTimeout(terrainTimer);
      manager.detachMap();
      map.remove();
    };
  }, [manager]);

  return <div ref={containerRef} className="map" />;
}
