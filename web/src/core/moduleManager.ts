/**
 * Gestionnaire des modules : visibilité, chargements périodiques, rendu.
 *
 * Il ne dépend pas de React. La carte l'appelle à chaque image (`frame`) ;
 * l'interface s'y abonne (`subscribe` / `getSnapshot`) pour afficher l'état
 * des couches.
 */
import type { Layer, LayersList } from '@deck.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { LayerModule, RenderContext, TerrainSampler } from './module';

export type ModuleStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ModuleRuntimeState {
  visible: boolean;
  status: ModuleStatus;
  error?: string;
  /** Heure réelle de la dernière réception de données. */
  lastUpdated?: number;
}

interface Entry {
  module: LayerModule;
  data: unknown;
  /** Incrémenté à chaque nouvelle donnée, pour savoir quand redessiner. */
  dataVersion: number;
  timer?: ReturnType<typeof setInterval>;
  abort?: AbortController;
  /** Clé du dernier rendu : version des données + case de temps. */
  renderedKey?: string;
  layers: Layer[];
  nativeAdded: boolean;
}

const STORAGE_KEY = 'carte-vivante:couches-visibles';

export class ModuleManager {
  readonly modules: readonly LayerModule[];
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly layerOwners = new Map<string, LayerModule>();
  private snapshot: Readonly<Record<string, ModuleRuntimeState>>;
  private map: MapLibreMap | undefined;
  private frameCount = 0;
  private viewVersion = 0;
  private dirty = true;
  private readonly terrain: TerrainSampler = {
    elevation: (lon, lat) => this.map?.queryTerrainElevation([lon, lat]) ?? 0,
    version: 0,
  };

  constructor(modules: readonly LayerModule[]) {
    this.modules = modules;
    const saved = readSavedVisibility();
    const snapshot: Record<string, ModuleRuntimeState> = {};
    for (const module of modules) {
      if (this.entries.has(module.id)) throw new Error(`Module en double : ${module.id}`);
      this.entries.set(module.id, { module, data: undefined, dataVersion: 0, layers: [], nativeAdded: false });
      snapshot[module.id] = { visible: saved[module.id] ?? module.visibleByDefault ?? false, status: 'idle' };
    }
    this.snapshot = snapshot;
  }

  // --- Abonnement pour l'interface (compatible useSyncExternalStore) ---

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Readonly<Record<string, ModuleRuntimeState>> => this.snapshot;

  // --- Cycle de vie ---

  /** Branche la carte (style chargé) et active les modules visibles. */
  attachMap(map: MapLibreMap): void {
    this.map = map;
    for (const entry of this.entries.values()) {
      if (this.isVisible(entry)) this.activate(entry);
    }
  }

  /** Débranche la carte avant sa destruction : arrête chargements et minuteries. */
  detachMap(): void {
    for (const entry of this.entries.values()) this.deactivate(entry);
    this.map = undefined;
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || this.isVisible(entry) === visible) return;
    this.patch(id, { visible });
    saveVisibility(this.snapshot);
    if (!this.map) return;
    if (visible) this.activate(entry);
    else this.deactivate(entry);
  }

  /** À appeler quand le relief change (tuiles reçues, relief activé ou désactivé). */
  notifyTerrainChanged(): void {
    this.terrain.version++;
  }

  /** À appeler à la fin de chaque déplacement de la carte. */
  notifyViewChanged(): void {
    this.viewVersion++;
  }

  /** Module propriétaire d'une couche deck.gl (pour le clic). */
  ownerOf(layerId: string): LayerModule | undefined {
    return this.layerOwners.get(layerId);
  }

  /**
   * Appelé à chaque image avec l'instant simulé. Ne redessine que les modules
   * dont les données ou la case de temps ont changé. Renvoie la nouvelle liste
   * de couches deck.gl, ou `null` si rien n'a changé (la carte ne fait alors rien).
   */
  frame(time: number): Layer[] | null {
    if (!this.map) return null;
    this.frameCount++;
    let changed = this.dirty;

    for (const entry of this.entries.values()) {
      if (!this.isVisible(entry)) continue;
      const { module } = entry;
      const step = module.timeStepMs > 0 ? Math.floor(time / module.timeStepMs) : `image-${this.frameCount}`;
      const terrainVersion = module.followsTerrain ? this.terrain.version : 0;
      const viewVersion = module.followsView ? this.viewVersion : 0;
      const key = `${entry.dataVersion}:${step}:${terrainVersion}:${viewVersion}`;
      if (key === entry.renderedKey) continue;
      entry.renderedKey = key;

      const ctx: RenderContext<unknown> = { data: entry.data, time, terrain: this.terrain };
      if (module.deckLayers) {
        entry.layers = flattenLayers(module.deckLayers(ctx));
        changed = true;
      }
      if (module.native?.update && entry.nativeAdded) module.native.update(this.map, ctx);
    }

    if (!changed) return null;
    this.dirty = false;
    this.layerOwners.clear();
    const layers: Layer[] = [];
    for (const entry of this.entries.values()) {
      if (!this.isVisible(entry)) continue;
      for (const layer of entry.layers) {
        layers.push(layer);
        this.layerOwners.set(layer.id, entry.module);
      }
    }
    return layers;
  }

  // --- Interne ---

  private isVisible(entry: Entry): boolean {
    return this.snapshot[entry.module.id]?.visible ?? false;
  }

  private activate(entry: Entry): void {
    const { module } = entry;
    if (this.map && module.native && !entry.nativeAdded) {
      module.native.add(this.map);
      entry.nativeAdded = true;
    }
    entry.renderedKey = undefined;
    this.dirty = true;

    if (!module.load) {
      this.patch(module.id, { status: 'ready' });
      return;
    }
    const lastUpdated = this.snapshot[module.id]?.lastUpdated ?? 0;
    const stale =
      entry.data === undefined ||
      (module.refreshIntervalMs !== undefined && Date.now() - lastUpdated > module.refreshIntervalMs);
    if (stale) void this.load(entry);
    if (module.refreshIntervalMs) {
      entry.timer = setInterval(() => void this.load(entry), module.refreshIntervalMs);
    }
  }

  private deactivate(entry: Entry): void {
    clearInterval(entry.timer);
    entry.timer = undefined;
    entry.abort?.abort();
    entry.abort = undefined;
    if (this.map && entry.nativeAdded) entry.module.native?.remove(this.map);
    entry.nativeAdded = false;
    entry.layers = [];
    entry.renderedKey = undefined;
    this.dirty = true;
    if (this.snapshot[entry.module.id]?.status === 'loading') this.patch(entry.module.id, { status: 'idle' });
  }

  private async load(entry: Entry): Promise<void> {
    const { module } = entry;
    if (!module.load) return;
    entry.abort?.abort();
    const controller = new AbortController();
    entry.abort = controller;
    // Pendant un simple rafraîchissement, on garde l'affichage actuel sans indicateur de chargement.
    if (entry.data === undefined) this.patch(module.id, { status: 'loading', error: undefined });
    try {
      const data = await module.load(controller.signal);
      if (controller.signal.aborted) return;
      entry.data = data;
      entry.dataVersion++;
      this.patch(module.id, { status: 'ready', error: undefined, lastUpdated: Date.now() });
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error(`[module ${module.id}]`, error);
      this.patch(module.id, { status: 'error', error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (entry.abort === controller) entry.abort = undefined;
    }
  }

  private patch(id: string, patch: Partial<ModuleRuntimeState>): void {
    const current = this.snapshot[id];
    if (!current) return;
    this.snapshot = { ...this.snapshot, [id]: { ...current, ...patch } };
    for (const listener of this.listeners) listener();
  }
}

function flattenLayers(list: LayersList, out: Layer[] = []): Layer[] {
  for (const item of list) {
    if (Array.isArray(item)) flattenLayers(item, out);
    else if (item) out.push(item as Layer);
  }
  return out;
}

function readSavedVisibility(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {}; // stockage indisponible (navigation privée…) : valeurs par défaut
  }
}

function saveVisibility(snapshot: Readonly<Record<string, ModuleRuntimeState>>): void {
  try {
    const visibility = Object.fromEntries(Object.entries(snapshot).map(([id, state]) => [id, state.visible]));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // stockage indisponible : la préférence ne sera simplement pas retenue
  }
}
