/**
 * Ce que la recherche demande au gestionnaire de modules et à la carte.
 *
 * `ModuleManager` garde ses entrées et sa carte privées : la recherche en a besoin
 * (lire les données des modules, centrer la carte) sans que `core/` change. Tout
 * l'accès « par la bande » est ici, en un seul endroit, pour qu'il soit simple à
 * remplacer par de vraies méthodes du gestionnaire.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { clock } from '../core/clock';
import type { LayerModule, RenderContext } from '../core/module';
import type { ModuleManager } from '../core/moduleManager';
import { currentNight } from '../map/baseMap';

interface Internals {
  map?: MapLibreMap;
  entries: Map<string, { module: LayerModule; data: unknown }>;
}

const internals = (manager: ModuleManager): Internals => manager as unknown as Internals;

/** Données chargées par un module (même masqué, si elles ont déjà été chargées une fois). */
export function dataOf<T>(manager: ModuleManager, moduleId: string): T | undefined {
  return internals(manager).entries.get(moduleId)?.data as T | undefined;
}

export const mapOf = (manager: ModuleManager): MapLibreMap | undefined => internals(manager).map;

export const isShown = (manager: ModuleManager, moduleId: string): boolean => manager.getSnapshot()[moduleId]?.visible ?? false;

/** Bonus de classement d'un objet dont la couche est affichée. */
export const shownBonus = (manager: ModuleManager, moduleId: string): number => (isShown(manager, moduleId) ? 40 : 0);

/**
 * Mémorise le dernier index construit pour un jeu de données : il est refait
 * seulement quand le module a chargé de nouvelles données (nouvel objet), pas à chaque frappe.
 */
export function indexed<D extends object, I>(build: (data: D) => I): (data: D) => I {
  let lastData: D | undefined;
  let lastIndex: I | undefined;
  return (data) => {
    if (data !== lastData) {
      lastIndex = build(data);
      lastData = data;
    }
    return lastIndex as I;
  };
}

export const prefersReducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Centre la carte (sans animation si la personne le préfère). */
export function goTo(manager: ModuleManager, lon: number, lat: number, zoom: number): void {
  const map = mapOf(manager);
  if (!map) return;
  const view = { center: [lon, lat] as [number, number], zoom: Math.max(zoom, 0) };
  if (prefersReducedMotion()) map.jumpTo(view);
  else map.flyTo({ ...view, duration: 1600, essential: false });
}

/** Position actuelle d'une sélection selon son module (un train se déplace : sa place dépend de l'instant). */
export function locate(manager: ModuleManager, moduleId: string, selection: unknown): { lon: number; lat: number } | null {
  const entry = internals(manager).entries.get(moduleId);
  const focus = entry?.module.focus;
  if (!entry || !focus) return null;
  const ctx = {
    data: entry.data,
    time: clock.now(),
    terrain: { elevation: () => 0, exaggeration: 0, version: 0 },
    settings: manager.getSnapshot()[moduleId]?.settings ?? {},
    selection,
    view: { zoom: mapOf(manager)?.getZoom() ?? 0, bearing: 0, pitch: 0 },
    night: currentNight(),
  } satisfies RenderContext<unknown>;
  try {
    return focus.call(entry.module, selection, ctx);
  } catch {
    return null;
  }
}

/** Les couches « en direct seulement » n'ont rien à montrer dans le passé : revenir au présent. */
function ensureLive(): void {
  if (Math.abs(clock.now() - Date.now()) > 30_000) clock.goLive();
}

interface OpenOptions {
  /** Où aller si le module ne sait pas (encore) situer l'objet. */
  fallback: { lon: number; lat: number };
  zoom: number;
  /** Objet qui n'existe qu'en temps réel (avion, navire, bus). */
  liveOnly?: boolean;
}

/** Ce que fait un résultat « objet » : couche affichée, objet sélectionné (la fiche s'ouvre), carte centrée. */
export function openObject(manager: ModuleManager, moduleId: string, selection: unknown, options: OpenOptions): void {
  if (options.liveOnly) ensureLive();
  manager.setVisible(moduleId, true);
  manager.setSelection(moduleId, selection);
  const where = locate(manager, moduleId, selection) ?? options.fallback;
  goTo(manager, where.lon, where.lat, options.zoom);
}
