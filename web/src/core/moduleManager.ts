/**
 * Gestionnaire des modules : visibilité, réglages, chargements, rendu.
 *
 * Il ne dépend pas de React. La carte l'appelle à chaque image (`frame`) ;
 * l'interface s'y abonne (`subscribe` / `getSnapshot`) pour afficher l'état
 * des couches.
 */
import type { Layer, LayersList } from '@deck.gl/core';
import type { MapGeoJSONFeature, Map as MapLibreMap } from 'maplibre-gl';
import { acceptsSetting, settingOptions, type FocusTarget, type InfoContent, type LayerModule, type LegendItem, type ModuleSetting, type RenderContext, type TerrainSampler } from './module';
import { currentNight } from '../map/baseMap';
import { clock } from './clock';

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

/** L'objet sélectionné (un seul pour toute la carte), et si la caméra le suit. */
export interface Selection {
  moduleId: string;
  /** Valeur renvoyée par `module.select` (ex. `{ type: 'train', id }`). */
  value: unknown;
  following: boolean;
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
  private selection: Selection | null = null;
  /**
   * Altitudes déjà lues, au mètre près, valables pour une version du relief. Chaque lecture de MapLibre
   * parcourt les tuiles du relief (de l'ordre de 30 µs) : sans mémoire, les couches de points qui se
   * partagent les mêmes lieux (trois couches de gares, bornes, vélos…) la payaient à chaque arrivée de tuiles.
   */
  private readonly elevationCache = new Map<number, number>();
  private elevationCacheVersion = -1;
  private readonly terrain: TerrainSampler = {
    elevation: (lon, lat) => {
      const map = this.map;
      if (!map) return 0;
      if (this.elevationCacheVersion !== this.terrain.version || this.elevationCache.size > 200_000) {
        this.elevationCache.clear();
        this.elevationCacheVersion = this.terrain.version;
      }
      const key = Math.round((lon + 180) * 1e5) * 2e7 + Math.round((lat + 90) * 1e5);
      let value = this.elevationCache.get(key);
      if (value === undefined) {
        value = map.queryTerrainElevation([lon, lat]) ?? 0;
        this.elevationCache.set(key, value);
      }
      return value;
    },
    exaggeration: 0,
    version: 0,
  };

  /** Le gestionnaire de l'application, pour ce qui doit agir dessus sans l'avoir en main (action d'une fiche). */
  static current: ModuleManager | undefined;

  constructor(modules: readonly LayerModule[]) {
    ModuleManager.current = this;
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

  getSelection = (): Selection | null => this.selection;

  /** La carte MapLibre, une fois son style chargé (sinon `undefined`) : la visite guidée y lit et y pilote la caméra. */
  getMap = (): MapLibreMap | undefined => this.map;

  /** Données chargées par un module (même masqué, si elles ont déjà été chargées une fois). */
  getData<T>(id: string): T | undefined {
    return this.entries.get(id)?.data as T | undefined;
  }

  // --- Sélection ---

  /** Clic sur un objet deck.gl : le module propriétaire décide quoi sélectionner. */
  pick(layerId: string | undefined, object: unknown): void {
    const module = layerId ? this.layerOwners.get(layerId) : undefined;
    const value = module && object != null ? module.select?.(object) : null;
    this.setSelection(module && value != null ? module.id : null, value ?? null);
  }

  /** Couches natives cliquables des modules visibles (pour chercher sous le pointeur). */
  nativePickLayerIds(): string[] {
    return [...this.entries.values()]
      .filter((entry) => entry.nativeAdded && this.isVisible(entry))
      .flatMap((entry) => entry.module.native?.pickable?.layerIds ?? []);
  }

  /** Clic sur un objet d'une couche native : le module propriétaire décide quoi sélectionner. */
  pickFeature(feature: MapGeoJSONFeature): void {
    const entry = [...this.entries.values()].find((e) => e.module.native?.pickable?.layerIds.includes(feature.layer.id));
    const pickable = entry?.module.native?.pickable;
    const value = entry && pickable ? entry.module.select?.(pickable.toObject(feature)) : null;
    this.setSelection(entry && value != null ? entry.module.id : null, value ?? null);
  }

  /** Sélectionne une valeur d'un module (ex. une ligne cliquée dans une fiche), ou rien. */
  setSelection(moduleId: string | null, value: unknown): void {
    const previous = this.selection;
    this.selection = moduleId && value != null ? { moduleId, value, following: false } : null;
    for (const id of [previous?.moduleId, moduleId]) {
      const entry = id ? this.entries.get(id) : undefined;
      if (entry) entry.version++; // redessiner : la sélection est mise en évidence
    }
    this.notify();
  }

  setFollowing(following: boolean): void {
    if (!this.selection || this.selection.following === following) return;
    this.selection = { ...this.selection, following };
    this.notify();
  }

  /** Fiche de la sélection à l'instant t, ou `null` si elle n'existe plus. */
  describeSelection(time: number): { moduleName: string; content: InfoContent; canFollow: boolean } | null {
    const found = this.selectedEntry();
    if (!found) return null;
    const { entry, selection } = found;
    const ctx = this.context(entry, time);
    const content = entry.module.describe?.(selection.value, ctx);
    // « Suivre » n'a de sens que pour ce qui a une position à suivre (un train, pas une gare).
    const canFollow = entry.module.focus?.(selection.value, ctx) != null;
    return content ? { moduleName: entry.module.name, content, canFollow } : null;
  }

  /** Position à suivre (si la caméra suit la sélection). */
  followTarget(time: number): FocusTarget | null {
    const found = this.selectedEntry();
    if (!found?.selection.following) return null;
    return found.entry.module.focus?.(found.selection.value, this.context(found.entry, time)) ?? null;
  }

  // --- Cycle de vie ---

  /** Branche la carte (style chargé) et active les modules visibles. */
  attachMap(map: MapLibreMap): void {
    this.map = map;
    // Un lien partagé peut ouvrir la carte dans le passé : les premiers chargements doivent viser cet instant.
    this.currentTime = clock.now();
    for (const entry of this.entries.values()) {
      if (this.isVisible(entry)) this.activate(entry);
    }
  }

  /** Débranche la carte avant sa destruction : arrête chargements et minuteries. */
  detachMap(): void {
    for (const entry of this.entries.values()) this.deactivate(entry);
    this.map = undefined;
  }

  /**
   * `persist: false` : l'état vient d'une adresse partagée ; il ne doit pas écraser les préférences
   * de ce navigateur, qui restent la valeur par défaut quand l'adresse ne dit rien.
   */
  setVisible(id: string, visible: boolean, { persist = true }: { persist?: boolean } = {}): void {
    const entry = this.entries.get(id);
    if (!entry || this.isVisible(entry) === visible) return;
    this.patch(id, { visible });
    if (persist) writeStorage(VISIBILITY_KEY, mapValues(this.snapshot, (state) => state.visible));
    if (!visible && this.selection?.moduleId === id) this.setSelection(null, null);
    if (!this.map) return;
    if (visible) this.activate(entry);
    else this.deactivate(entry);
  }

  /** Affiche exactement ces couches et masque les autres (une scène, ou l'état d'une adresse). */
  setVisibleOnly(ids: Iterable<string>, options: { persist?: boolean } = {}): void {
    const wanted = new Set(ids);
    for (const module of this.modules) this.setVisible(module.id, wanted.has(module.id), options);
  }

  setSetting(id: string, settingId: string, value: string, { persist = true }: { persist?: boolean } = {}): void {
    const entry = this.entries.get(id);
    const state = this.snapshot[id];
    if (!entry || !state || state.settings[settingId] === value) return;
    const setting = entry.module.settings?.find((s) => s.id === settingId);
    if (!setting || !acceptsSetting(setting, value, state.settings)) return; // valeur inconnue (adresse périmée)
    this.patch(id, { settings: fixDependentSettings(entry.module, { ...state.settings, [settingId]: value }) });
    if (persist) writeStorage(SETTINGS_KEY, mapValues(this.snapshot, (s) => s.settings));
    entry.version++;
    // Un chargement qui avait échoué avec les anciens réglages (le scrutin choisi n'avait pas ses tuiles) : on réessaie avec les nouveaux.
    if (state.visible && state.status === 'error' && entry.data === undefined && entry.module.load) void this.load(entry, { showLoading: true });
  }

  /**
   * Un module a reçu quelque chose en dehors de `load` (l'itinéraire demandé par une fiche, par exemple) :
   * redessiner et rafraîchir l'interface, même si l'horloge est en pause.
   */
  refresh(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.version++;
    this.patch(id, { lastUpdated: Date.now() });
  }

  /** À appeler quand le relief change (tuiles reçues, relief activé ou désactivé). */
  notifyTerrainChanged(): void {
    this.terrain.version++;
  }

  /** À appeler à la fin de chaque déplacement de la carte. */
  notifyViewChanged(): void {
    this.viewVersion++;
  }

  /** Légende d'un module, d'après ses réglages et ses données actuelles. */
  legendOf(id: string): LegendItem[] {
    const entry = this.entries.get(id);
    const state = this.snapshot[id];
    return entry && state ? (entry.module.legend?.(state.settings, entry.data) ?? []) : [];
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
      const ctx = this.context(entry, time);

      // Saut dans le temps hors de la période chargée : on recharge (sans s'acharner en cas d'échec).
      if (
        module.needsReload &&
        entry.data !== undefined &&
        !entry.abort &&
        now - entry.lastFailure > RELOAD_BACKOFF_MS &&
        module.needsReload(entry.data, time, this.snapshot[module.id]?.settings ?? {})
      ) {
        void this.load(entry, { showLoading: true });
      }

      if (refreshSummaries && module.summary) {
        const summary = module.summary(ctx);
        if (summary !== state.summary) this.patch(module.id, { summary });
      }

      const stepMs = typeof module.timeStepMs === 'function' ? module.timeStepMs(ctx.view) : module.timeStepMs;
      const step = stepMs > 0 ? Math.floor(time / stepMs) : `image-${this.frameCount}`;
      const terrainVersion = module.followsTerrain ? this.terrain.version : 0;
      const viewVersion = module.followsView ? this.viewVersion : 0;
      const zoomBand = module.zoomBreaks?.filter((z) => ctx.view.zoom >= z).length ?? 0;
      // Le fond change de palette au crépuscule : on redessine par huitièmes de nuit, pas plus souvent.
      const nightBand = Math.round(ctx.night * 8);
      const key = `${entry.version}:${step}:${terrainVersion}:${viewVersion}:${zoomBand}:${nightBand}`;
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
    const byDrawOrder = [...this.entries.values()].sort((a, b) => (a.module.drawOrder ?? 0) - (b.module.drawOrder ?? 0));
    for (const entry of byDrawOrder) {
      if (!this.isVisible(entry)) continue;
      for (const layer of entry.layers) {
        layers.push(layer);
        this.layerOwners.set(layer.id, entry.module);
      }
    }
    return layers;
  }

  // --- Interne ---

  private context(entry: Entry, time: number): RenderContext<unknown> {
    const selection = this.selection?.moduleId === entry.module.id ? this.selection.value : null;
    return {
      data: entry.data,
      time,
      terrain: this.terrain,
      settings: this.snapshot[entry.module.id]?.settings ?? {},
      selection,
      view: {
        zoom: this.map?.getZoom() ?? 0,
        bearing: this.map?.getBearing() ?? 0,
        pitch: this.map?.getPitch() ?? 0,
        bounds: () => this.viewBounds(),
      },
      night: currentNight(),
    };
  }

  private boundsFrame = -1;
  private boundsValue: readonly [number, number, number, number] = [-180, -90, 180, 90];
  /** Emprise visible de la carte, calculée au plus une fois par image. */
  private viewBounds(): readonly [number, number, number, number] {
    if (this.map && this.boundsFrame !== this.frameCount) {
      const b = this.map.getBounds();
      this.boundsValue = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
      this.boundsFrame = this.frameCount;
    }
    return this.boundsValue;
  }

  private selectedEntry(): { entry: Entry; selection: Selection } | null {
    const selection = this.selection;
    const entry = selection ? this.entries.get(selection.moduleId) : undefined;
    return selection && entry && this.isVisible(entry) ? { entry, selection } : null;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

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
      (module.needsReload?.(entry.data, this.currentTime, this.snapshot[module.id]?.settings ?? {}) ?? false);
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
      const data = await module.load({ signal: controller.signal, time: this.currentTime, settings: this.snapshot[module.id]?.settings ?? {} });
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
    this.notify();
  }
}

/** Réglages enregistrés s'ils sont encore valides, sinon valeurs par défaut. */
function initialSettings(module: LayerModule, saved: Record<string, string> | undefined): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const setting of module.settings ?? []) {
    const value = saved?.[setting.id];
    settings[setting.id] = acceptsSetting(setting, value, settings) ? value : fallbackValue(setting, settings);
  }
  return settings;
}

/** Valeur par défaut d'un réglage, ou son premier choix si les autres réglages ne permettent pas la valeur par défaut. */
function fallbackValue(setting: ModuleSetting, settings: Readonly<Record<string, string>>): string {
  if (acceptsSetting(setting, setting.defaultValue, settings)) return setting.defaultValue;
  return settingOptions(setting, settings)[0]?.value ?? setting.defaultValue;
}

/** Après un changement de réglage : les réglages qui en dépendent (`optionsFor`) reviennent à un choix permis. */
function fixDependentSettings(module: LayerModule, settings: Record<string, string>): Record<string, string> {
  const fixed = { ...settings };
  for (const setting of module.settings ?? []) {
    if (setting.optionsFor && !acceptsSetting(setting, fixed[setting.id], fixed)) fixed[setting.id] = fallbackValue(setting, fixed);
  }
  return fixed;
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
