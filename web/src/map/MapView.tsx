import { useEffect, useRef } from 'react';
import {
  AttributionControl,
  GlobeControl,
  LngLat,
  Map as MapLibreMap,
  NavigationControl,
  TerrainControl,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { PickingInfo } from '@deck.gl/core';
import { clock } from '../core/clock';
import type { ModuleManager } from '../core/moduleManager';
import { sunEffects } from '../models/sunLight';
import {
  BASE_STYLE_URL,
  INITIAL_VIEW,
  TERRAIN_EXAGGERATION,
  isTerrainSource,
  terrainOptions,
  ignoreMissingIcons,
  CalmScaleControl,
  keepGlobeAndTerrainApart,
  setupBaseMap,
} from './baseMap';

/** Tolérance de clic, en pixels : les points, étiquettes et trains vus de loin sont petits. */
const PICKING_RADIUS = 5;
/** Au plus une notification « la vue a changé » par seconde (la caméra qui suit un train bouge sans arrêt). */
const VIEW_NOTIFY_INTERVAL_MS = 1_000;

/** Libellés des commandes de la carte (lecteurs d'écran et info-bulles). */
const FRENCH_LABELS = {
  'AttributionControl.ToggleAttribution': 'Afficher les crédits',
  'AttributionControl.MapFeedback': 'Signaler une erreur sur la carte',
  'NavigationControl.ResetBearing': 'Remettre le nord en haut (glisser pour tourner)',
  'NavigationControl.ZoomIn': 'Zoom avant',
  'NavigationControl.ZoomOut': 'Zoom arrière',
  'GlobeControl.Enable': 'Afficher le globe',
  'GlobeControl.Disable': 'Revenir à la carte plane',
  'TerrainControl.Enable': 'Activer le relief',
  'TerrainControl.Disable': 'Désactiver le relief',
};

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
      // La vue est gardée dans l'adresse (paramètre `vue`), à côté des couches, de l'instant et de la
      // sélection que gère `core/shareState.ts` : on peut partager ou recharger.
      hash: 'vue',
      attributionControl: false,
      locale: FRENCH_LABELS,
    });
    // Commandes regroupées en bas à droite, loin de la fiche (voir styles.css). Pour les coins du bas,
    // MapLibre empile du bas vers le haut : le dernier contrôle ajouté est le plus haut.
    map.addControl(new AttributionControl(), 'bottom-right'); // placé en bas de l'écran par le CSS
    map.addControl(new CalmScaleControl({ maxWidth: 110 }), 'bottom-right');
    // Le bouton relief réactive le relief avec la source du moment (ordinaire ou LiDAR HD, voir `setLidarTerrain`).
    map.addControl(new TerrainControl({ get source() { return terrainOptions().source; }, exaggeration: TERRAIN_EXAGGERATION }), 'bottom-right');
    map.addControl(new GlobeControl(), 'bottom-right');
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');
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
      if (isTerrainSource(event.sourceId) && event.tile) onTerrainChanged();
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
    // Déplacer la carte à la main arrête de suivre la sélection. Zoomer, tourner ou pincer à deux doigts, non.
    map.on('dragstart', (e) => {
      const touches = (e.originalEvent as TouchEvent | undefined)?.touches;
      if (touches && touches.length > 1) return;
      manager.setFollowing(false);
    });

    // Pendant le suivi, la caméra est recentrée à chaque image. Un `jumpTo` interrompt toute animation en cours
    // (boutons +/−, clavier) : celles qui ne font que zoomer, tourner ou incliner sont donc rejouées par le suivi.
    let followEase: { from: FollowCamera; to: FollowCamera; start: number; duration: number } | null = null;
    const easeTo = map.easeTo.bind(map);
    map.easeTo = (options, eventData) => {
      const offset = options.offset as [number, number] | { x: number; y: number } | undefined;
      const pans = offset != null && (Array.isArray(offset) ? offset[0] !== 0 || offset[1] !== 0 : offset.x !== 0 || offset.y !== 0);
      if (pans || !manager.followTarget(clock.now())) return easeTo(options, eventData);
      const from = { zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
      followEase = {
        from,
        to: { zoom: options.zoom ?? from.zoom, bearing: options.bearing ?? from.bearing, pitch: options.pitch ?? from.pitch },
        start: performance.now(),
        duration: options.duration ?? 300,
      };
      return map;
    };
    const followEaseStep = (): Partial<FollowCamera> => {
      if (!followEase) return {};
      const k = Math.min(1, (performance.now() - followEase.start) / Math.max(1, followEase.duration));
      const e = 1 - (1 - k) ** 3;
      const { from, to } = followEase;
      if (k >= 1) followEase = null;
      const turn = ((((to.bearing - from.bearing) % 360) + 540) % 360) - 180; // par le plus court
      return { zoom: from.zoom + (to.zoom - from.zoom) * e, bearing: from.bearing + turn * e, pitch: from.pitch + (to.pitch - from.pitch) * e };
    };
    /** Vrai pendant le suivi : molette et pincement zooment alors autour du centre (l'objet suivi), pas du pointeur. */
    let zoomsAroundCenter = false;
    // Doigts ou boutons posés sur la carte. Tant qu'il y en a, pas de `jumpTo` : il remettrait à zéro les gestes
    // de MapLibre (pincement, rotation au clic droit) avant même qu'ils démarrent.
    const pressed = new Set<number>();
    const canvasContainer = map.getCanvasContainer();
    canvasContainer.addEventListener('pointerdown', (e) => pressed.add(e.pointerId), { passive: true });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
      window.addEventListener(type, (e) => pressed.delete(e.pointerId), { passive: true });
    }

    // deck.gl dessine dans le même contexte WebGL que MapLibre (« interleaved ») :
    // ses couches se mélangent correctement avec le relief et les bâtiments.
    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      pickingRadius: PICKING_RADIUS,
      onClick: (info: PickingInfo) => {
        if (info.object != null) {
          manager.pick(info.layer?.id, info.object);
          return;
        }
        // Rien sous le pointeur côté deck.gl : peut-être un objet d'une couche MapLibre native (rivières…).
        const layers = manager.nativePickLayerIds().filter((id) => map.getLayer(id));
        const box: [[number, number], [number, number]] = [
          [info.x - 4, info.y - 4],
          [info.x + 4, info.y + 4],
        ];
        const feature = layers.length > 0 ? map.queryRenderedFeatures(box, { layers })[0] : undefined;
        if (feature) manager.pickFeature(feature);
        else manager.pick(undefined, null);
      },
      getCursor: ({ isDragging, isHovering }) => (isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab'),
    });

    // En développement, la carte est accessible depuis la console : window.__carte.map, etc.
    if (import.meta.env.DEV) Object.assign(window, { __carte: { map, overlay, clock, manager } });

    let frameRequest = 0;
    let frameCount = 0;
    /** Vrai pendant qu'on suit un objet en vol (centre de la vue décollé du sol). */
    let aloft = false;
    let effects: ReturnType<typeof sunEffects> | undefined;
    const tick = () => {
      const time = clock.now();
      const target = manager.followTarget(time);
      if ((target != null) !== zoomsAroundCenter) {
        zoomsAroundCenter = target != null;
        const around = zoomsAroundCenter ? { around: 'center' as const } : undefined;
        if (map.scrollZoom.isEnabled()) map.scrollZoom.enable(around);
        if (map.touchZoomRotate.isEnabled()) map.touchZoomRotate.enable(around);
        if (!zoomsAroundCenter) followEase = null;
      }
      if (target?.alt !== undefined && !aloft) {
        // Objet en vol : la caméra tourne autour de lui, à son altitude, et non autour du sol dessous.
        map.setCenterClampedToGround(false);
        aloft = true;
      } else if (target?.alt === undefined && aloft) {
        // Fin du suivi d'un objet en vol : le centre de la vue redescend sur le relief.
        map.setCenterClampedToGround(true);
        map.jumpTo({ elevation: map.queryTerrainElevation(map.getCenter()) ?? 0 });
        aloft = false;
      }
      if (target) {
        if (pressed.size > 0 || map.isMoving()) {
          // Geste en cours (molette, pincement, rotation) : un `jumpTo` l'interromprait. On déplace seulement le centre.
          map.transform.setCenter(new LngLat(target.lon, target.lat));
          if (target.alt !== undefined) map.transform.setElevation(target.alt);
          map.triggerRepaint();
        } else {
          map.jumpTo({
            center: [target.lon, target.lat],
            ...(target.alt !== undefined ? { elevation: target.alt } : {}),
            ...followEaseStep(),
          });
        }
      }
      const layers = manager.frame(time);
      // Maquettes 3D éclairées par le soleil du centre de la vue (vérifié quelques fois par seconde).
      if (frameCount++ % 15 === 0) {
        const center = map.getCenter();
        // Comme les bâtiments : le vrai soleil seulement quand la couche « Jour et nuit » est affichée.
        const followSun = manager.getSnapshot()['jour-nuit']?.visible === true;
        const next = sunEffects(center.lat, center.lng, time, followSun);
        if (next !== effects) {
          effects = next;
          overlay.setProps({ effects });
        }
      }
      if (layers) overlay.setProps({ layers });
      frameRequest = requestAnimationFrame(tick);
    };

    map.on('style.load', () => setupBaseMap(map));
    map.once('load', () => {
      // Sur téléphone les crédits démarrent repliés (le bouton (i) les déroule) : dépliés, ils couvrent la carte.
      if (window.matchMedia('(max-width: 719.98px)').matches) {
        const attribution = container.querySelector('.maplibregl-ctrl-attrib');
        attribution?.classList.remove('maplibregl-compact-show');
        attribution?.removeAttribute('open');
      }
      map.addControl(overlay);
      manager.attachMap(map);
      frameRequest = requestAnimationFrame(tick);
    });

    return () => {
      cancelAnimationFrame(frameRequest);
      clearTimeout(terrainTimer);
      clearTimeout(viewTimer);
      manager.detachMap();
      // En se détruisant, MapLibre efface la vue de l'adresse. Or React détruit et recrée
      // la carte en développement (double montage, rechargement à chaud) : on la remet.
      const hash = window.location.hash;
      map.remove();
      window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
    };
  }, [manager]);

  return <div ref={containerRef} className="map" />;
}

/** Ce que le suivi anime lui-même quand on zoome ou tourne pendant qu'il recentre la caméra. */
interface FollowCamera {
  zoom: number;
  bearing: number;
  pitch: number;
}
