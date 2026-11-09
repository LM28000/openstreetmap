/**
 * Gestionnaire des modules : visibilité, réglages, chargements, rendu.
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
  /** Valeur de chaque réglage du module. */
  settings: Readonly<Record<string, string>>;
  /** Résumé court fourni par le module (ex. « 812 trains en circulation »). */
  summary?: string | null;
}

interface Entry {
  module: LayerModule;
  data: unknown;
  /** Incrémenté à chaque nouvelle donnée ou nouveau réglage, pour savoir quand redessiner. */
  version: number;
  timer?: ReturnType<typeof setInterval>;
  abort?: AbortController;
  /** Heure réelle du dernier échec de chargement (pour ne pas réessayer en boucle). */
  lastFailure: number;
  /** Clé du dernier rendu : version + case de temps + relief + vue. */
  renderedKey?: string;
  layers: Layer[];
  nativeAdded: boolean;
}

const VISIBILITY_KEY = 'carte-vivante:couches-visibles';
const SETTINGS_KEY = 'carte-vivante:reglages';
/** Après un échec, délai avant de retenter un rechargement déclenché par un saut dans le temps. */
const RELOAD_BACKOFF_MS = 3_000;
const SUMMARY_INTERVAL_MS = 1_000;

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
  /** Dernier instant simulé vu par `frame` (les chargements s'en servent). */
  private currentTime = Date.now();
  private lastSummaryAt = 0;
  private readonly terrain: TerrainSampler = {
    elevation: (lon, lat) => this.map?.queryTerrainElevation([lon, lat]) ?? 0,
    exaggeration: 0,
    version: 0,
  };

  constructor(modules: readonly LayerModule[]) {
    this.modules = modules;
    const savedVisibility = readStorage<Record<string, boolean>>(VISIBILITY_KEY);
    const savedSettings = readStorage<Record<string, Record<string, string>>>(SETTINGS_KEY);
    const snapshot: Record<string, ModuleRuntimeState> = {};
    for (const module of modules) {
      if (this.entries.has(module.id)) throw new Error(`Module en double : ${module.id}`);
      this.entries.set(module.id, { module, data: undefined, version: 0, lastFailure: 0, layers: [], nativeAdded: false });
      snapshot[module.id] = {
        visible: savedVisibility[module.id] ?? module.visibleByDefault ?? false,
        status: 'idle',
        settings: initialSettings(module, savedSettings[module.id]),
      };
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
    writeStorage(VISIBILITY_KEY, mapValues(this.snapshot, (state) => state.visible));
    if (!this.map) return;
    if (visible) this.activate(entry);
    else this.deactivate(entry);
  }

  setSetting(id: string, settingId: string, value: string): void {
    const entry = this.entries.get(id);
    const state = this.snapshot[id];
    if (!entry || !state || state.settings[settingId] === value) return;
    this.patch(id, { settings: { ...state.settings, [settingId]: value } });
    writeStorage(SETTINGS_KEY, mapValues(this.snapshot, (s) => s.settings));
    entry.version++;
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
   * dont les données, les réglages ou la case de temps ont changé. Renvoie la
   * nouvelle liste de couches deck.gl, ou `null` si rien n'a changé.
   */
  frame(time: number): Layer[] | null {
    if (!this.map) return null;
    this.frameCount++;
    this.currentTime = time;
    this.terrain.exaggeration = this.map.getTerrain()?.exaggeration ?? 0;
    let changed = this.dirty;
    const now = Date.now();
    const refreshSummaries = now - this.lastSummaryAt >= SUMMARY_INTERVAL_MS;
    if (refreshSummaries) this.lastSummaryAt = now;

    for (const entry of this.entries.values()) {
      const state = this.snapshot[entry.module.id];
      if (!state?.visible) continue;
      const { module } = entry;
      const ctx: RenderContext<unknown> = { data: entry.data, time, terrain: this.terrain, settings: state.settings };

      // Saut dans le temps hors de la période chargée : on recharge (sans s'acharner en cas d'échec).
      if (
        module.needsReload &&
        entry.data !== undefined &&
        !entry.abort &&
        now - entry.lastFailure > RELOAD_BACKOFF_MS &&
        module.needsReload(entry.data, time)
      ) {
        void this.load(entry, { showLoading: true });
      }

      if (refreshSummaries && module.summary) {
        const summary = module.summary(ctx);
        if (summary !== state.summary) this.patch(module.id, { summary });
      }

      const step = module.timeStepMs > 0 ? Math.floor(time / module.timeStepMs) : `image-${this.frameCount}`;
      const terrainVersion = module.followsTerrain ? this.terrain.version : 0;
      const viewVersion = module.followsView ? this.viewVersion : 0;
      const key = `${entry.version}:${step}:${terrainVersion}:${viewVersion}`;
      if (key === entry.renderedKey) continue;
      entry.renderedKey = key;

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
      (module.refreshIntervalMs !== undefined && Date.now() - lastUpdated > module.refreshIntervalMs) ||
      (module.needsReload?.(entry.data, this.currentTime) ?? false);
    if (stale) void this.load(entry, { showLoading: entry.data === undefined });
    if (module.refreshIntervalMs) {
      entry.timer = setInterval(() => void this.load(entry, { showLoading: false }), module.refreshIntervalMs);
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

  private async load(entry: Entry, { showLoading }: { showLoading: boolean }): Promise<void> {
    const { module } = entry;
    if (!module.load) return;
    entry.abort?.abort();
    const controller = new AbortController();
    entry.abort = controller;
    // Pendant un simple rafraîchissement, on garde l'affichage actuel sans indicateur.
    if (showLoading) this.patch(module.id, { status: 'loading', error: undefined });
    try {
      const data = await module.load({ signal: controller.signal, time: this.currentTime });
      if (controller.signal.aborted) return;
      entry.data = data;
      entry.version++;
      this.patch(module.id, { status: 'ready', error: undefined, lastUpdated: Date.now() });
    } catch (error) {
      if (controller.signal.aborted) return;
      entry.lastFailure = Date.now();
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

/** Réglages enregistrés s'ils sont encore valides, sinon valeurs par défaut. */
function initialSettings(module: LayerModule, saved: Record<string, string> | undefined): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const setting of module.settings ?? []) {
    const value = saved?.[setting.id];
    settings[setting.id] = setting.options.some((o) => o.value === value) && value ? value : setting.defaultValue;
  }
  return settings;
}

function mapValues<T, U>(record: Readonly<Record<string, T>>, fn: (value: T) => U): Record<string, U> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));
}

function flattenLayers(list: LayersList, out: Layer[] = []): Layer[] {
  for (const item of list) {
    if (Array.isArray(item)) flattenLayers(item, out);
    else if (item) out.push(item as Layer);
  }
  return out;
}

function readStorage<T extends object>(key: string): Partial<T> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Partial<T>) : {};
  } catch {
    return {}; // stockage indisponible (navigation privée…) : valeurs par défaut
  }
}

function writeStorage(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // stockage indisponible : la préférence ne sera simplement pas retenue
  }
}
