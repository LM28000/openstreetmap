/**
 * Visite guidée : un déroulé d'étapes (caméra, couches, instant, légende) joué sur la vraie carte.
 *
 * Ce module ne dépend pas de React : l'interface (`ui/Tour.tsx`) s'abonne à l'état, comme pour le gestionnaire
 * de modules. Les étapes elles-mêmes sont des données (`tourStops.ts`) ; ici vivent la mécanique et les garde-fous :
 *
 * - une étape ne montre sa légende qu'une fois ses données arrivées (`ready`) ; sans données après un délai, elle est
 *   passée (une couche en direct peut être vide : pas de navires, peu d'avions la nuit) ;
 * - tout geste de la personne sur la carte (glisser, zoomer) met la visite en pause ;
 * - quitter rend l'état d'avant (caméra, couches, réglages, horloge, sélection), avec `shareState.ts` pour ce qui
 *   s'écrit déjà dans l'adresse et un relevé à part pour le reste.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { TERRAIN_EXAGGERATION, TERRAIN_SOURCE } from '../map/baseMap';
import { fromParis, parisParts } from '../ui/format';
import { clock } from './clock';
import type { ModuleManager } from './moduleManager';
import { coverageAt, loadAvailability } from './replay';
import { applySharedState, captureState } from './shareState';
import { STOPS, type TimeSpec, type TourStop } from './tourStops';

const MINUTE = 60_000;
const POLL_MS = 200;
/** Délai maximal, après l'arrivée de la caméra, pour que les données d'une étape soient là. */
const DEFAULT_READY_TIMEOUT_MS = 9_000;
/** Attente maximale des tuiles de la carte (couches natives) avant d'afficher la légende malgré tout. */
const TILES_TIMEOUT_MS = 4_000;
/** L'avis « étape passée » reste affiché ce temps-là. */
const NOTICE_MS = 5_000;

/** Ce que les étapes peuvent lire : la carte, les couches et leurs données. */
export interface TourHelpers {
  manager: ModuleManager;
  map: MapLibreMap;
  summary(id: string): string | null;
  status(id: string): string | undefined;
  data<T>(id: string): T | undefined;
  /** Vrai quand l'étape n'est plus l'étape courante (la personne est passée à une autre) : arrêter tout travail en cours. */
  cancelled(): boolean;
}

/** Ce que la légende d'une étape peut savoir de l'instant choisi. */
export interface StopContext {
  /** Vrai quand l'instant affiché est un enregistrement du passé et non le direct. */
  recorded: boolean;
}

export type TourPhase = 'loading' | 'showing' | 'end';

export interface TourState {
  active: boolean;
  index: number;
  total: number;
  playing: boolean;
  phase: TourPhase;
  kicker: string;
  title: string;
  /** Légende ; `null` tant que les données de l'étape ne sont pas là. */
  caption: string | null;
  /** Couche dont le résumé est cité sous la légende. */
  statModule: string | null;
  /** Durée de lecture de la légende, et instant où elle est apparue (l'interface en tire sa jauge). */
  dwellMs: number;
  shownAt: number;
  /** Avis bref : l'étape précédente a été passée faute de données. */
  notice: string | null;
}

const IDLE: TourState = {
  active: false,
  index: 0,
  total: STOPS.length,
  playing: false,
  phase: 'loading',
  kicker: '',
  title: '',
  caption: null,
  statModule: null,
  dwellMs: 0,
  shownAt: 0,
  notice: null,
};

/** Ce qu'il faut rendre en quittant. */
interface Saved {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  terrain: boolean;
  globe: boolean;
  /** Couches, instant, sélection, gare des isochrones (`captureState`). */
  fragment: string;
  /** Réglages de toutes les couches, même masquées (l'adresse ne porte que ceux des couches affichées). */
  settings: Record<string, Record<string, string>>;
  /** Valeur des états propres aux modules (gare de départ des isochrones). */
  urlStates: Record<string, string | null>;
}

const prefersReducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Résultat du choix de l'instant : `at: null` = le direct. `skip` : étape à passer. */
interface ResolvedTime {
  at: number | null;
  speed: number;
  recorded: boolean;
  skip?: boolean;
}

/** Choisit l'instant d'une étape : le direct quand il convient, sinon un enregistrement ou un horaire. */
function resolveTime(spec: TimeSpec | undefined, now: number): ResolvedTime {
  const live: ResolvedTime = { at: null, speed: 1, recorded: false };
  if (!spec || spec.kind === 'live') return live;
  const p = parisParts(now);
  const hourNow = p.hour + p.minute / 60;

  if (spec.kind === 'day') {
    // Le jour (7 h à 20 h), le direct convient ; sinon on prend l'horaire du lendemain matin (les trains sont calculés d'après les horaires).
    if (hourNow >= 7 && hourNow < 20) return live;
    const nextDay = hourNow >= 20 ? 1 : 0;
    return { at: fromParis(p.year, p.month, p.day + nextDay, spec.hour), speed: 1, recorded: false };
  }

  if (spec.kind === 'night') {
    if (hourNow >= 22 || hourNow < 5) return live;
    // La nuit dernière : le soir à 23 h 30, et la lecture avance à `speed` pour que ça bouge.
    return { at: fromParis(p.year, p.month, p.day - 1, 23, 30), speed: spec.speed, recorded: true };
  }

  // Enregistrement : le direct s'il tombe dans la plage voulue, sinon la dernière fois que cette heure a été enregistrée.
  const weekday = (day: number): boolean => {
    const dow = new Date(Date.UTC(p.year, p.month - 1, day)).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  if (spec.liveBetween && hourNow >= spec.liveBetween[0] && hourNow < spec.liveBetween[1] && (!spec.weekday || weekday(p.day))) {
    return live;
  }
  for (let back = 0; back < 7; back++) {
    if (spec.weekday && !weekday(p.day - back)) continue;
    const at = fromParis(p.year, p.month, p.day - back, spec.hour, 0);
    if (at > now - 15 * MINUTE) continue;
    // L'enregistrement doit couvrir le début et la fin de la lecture (une dizaine de minutes).
    if (spec.layers.every((layer) => coverageAt(layer, at).kind === 'ok' && coverageAt(layer, at + 10 * MINUTE).kind === 'ok')) {
      return { at, speed: spec.speed, recorded: true };
    }
  }
  return spec.fallback === 'skip' ? { ...live, skip: true } : live;
}

class TourController {
  private state: TourState = IDLE;
  private readonly listeners = new Set<() => void>();
  private manager: ModuleManager | undefined;
  private saved: Saved | undefined;
  /** Change à chaque changement d'étape : les attentes en cours le voient et s'arrêtent. */
  private token = 0;
  private arrived = false;
  /** La personne a repris la main pendant le vol : son arrivée n'en est plus une. */
  private interrupted = false;
  private refly: (() => void) | undefined;
  private leave: (() => void) | undefined;
  private dwellTimer: ReturnType<typeof setTimeout> | undefined;
  private dwellStartedAt = 0;
  private dwellRemaining = 0;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingNotice: string | null = null;
  private map: MapLibreMap | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): TourState => this.state;

  isActive = (): boolean => this.state.active;

  private set(patch: Partial<TourState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // --- Commandes ---

  /** Lance la visite (sans effet si elle tourne déjà). Attend la carte si elle n'est pas encore chargée. */
  async start(manager: ModuleManager): Promise<void> {
    if (this.state.active) return;
    this.manager = manager;
    // Actif tout de suite : l'interface se met en place (accueil et feuilles se referment) pendant l'attente de la carte.
    this.set({ ...IDLE, active: true, playing: true, phase: 'loading', title: STOPS[0]!.title, kicker: STOPS[0]!.kicker });
    const token = ++this.token;
    let map = manager.getMap();
    for (let i = 0; !map && i < 150; i++) {
      await sleep(200);
      if (token !== this.token) return;
      map = manager.getMap();
    }
    if (!map) {
      this.set(IDLE);
      return;
    }
    this.map = map;
    // Avant de toucher à quoi que ce soit : l'état à rendre.
    this.saved = this.capture(manager, map);
    map.on('movestart', this.onMoveStart);
    // Les enregistrements disponibles décident des étapes rejouées (et de leur instant).
    await Promise.race([loadAvailability().catch(() => null), sleep(3_000)]);
    if (token !== this.token) return;
    // La visite se joue sur la carte plane, relief en place (la photo ancienne, le relief des Alpes).
    if (map.getProjection()?.type === 'globe') map.setProjection({ type: 'mercator' });
    if (!map.getTerrain()) map.setTerrain({ source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
    void this.enter(0, 1);
  }

  /** Quitte la visite et rend l'état d'avant (caméra, couches, réglages, instant, sélection). */
  quit(): void {
    if (!this.state.active) return;
    this.token++;
    this.stopWork();
    const manager = this.manager;
    const map = this.map ?? manager?.getMap();
    map?.off('movestart', this.onMoveStart);
    if (manager && this.saved) this.restore(manager, map, this.saved);
    this.saved = undefined;
    this.set(IDLE);
  }

  next(): void {
    if (!this.state.active || this.state.phase === 'end') return;
    void this.enter(this.state.index + 1, 1);
  }

  prev(): void {
    if (!this.state.active) return;
    void this.enter(this.state.phase === 'end' ? STOPS.length - 1 : Math.max(0, this.state.index - 1), -1);
  }

  restart(): void {
    if (this.state.active) void this.enter(0, 1);
  }

  pause(): void {
    if (!this.state.active || !this.state.playing) return;
    if (this.dwellTimer) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = undefined;
      this.dwellRemaining = Math.max(0, this.dwellRemaining - (Date.now() - this.dwellStartedAt));
    }
    this.set({ playing: false });
  }

  resume(): void {
    if (!this.state.active || this.state.playing) return;
    this.set({ playing: true });
    // La personne a déplacé la carte avant l'arrivée : on repart vers l'étape.
    if (!this.arrived) this.refly?.();
    else if (this.state.phase === 'showing') this.runDwell();
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else if (this.state.phase === 'end') this.restart();
    else this.resume();
  }

  // --- Interne ---

  /** Un geste de la personne (glisser, molette, pincement, clavier) : la visite se met en pause. Les mouvements de la visite n'ont pas d'événement d'origine. */
  private onMoveStart = (event: { originalEvent?: unknown }): void => {
    if (event.originalEvent && this.state.active) {
      if (this.state.phase === 'loading') this.interrupted = true;
      this.pause();
    }
  };

  private capture(manager: ModuleManager, map: MapLibreMap): Saved {
    const center = map.getCenter();
    const snapshot = manager.getSnapshot();
    const urlStates: Record<string, string | null> = {};
    for (const module of manager.modules) if (module.urlState) urlStates[module.id] = module.urlState.read();
    return {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      terrain: map.getTerrain() != null,
      globe: map.getProjection()?.type === 'globe',
      fragment: captureState(manager),
      settings: Object.fromEntries(manager.modules.map((m) => [m.id, { ...snapshot[m.id]?.settings }])),
      urlStates,
    };
  }

  private restore(manager: ModuleManager, map: MapLibreMap | undefined, saved: Saved): void {
    const persist = { persist: false };
    manager.setSelection(null, null);
    for (const [id, settings] of Object.entries(saved.settings)) {
      for (const [key, value] of Object.entries(settings)) manager.setSetting(id, key, value, persist);
    }
    // Gare de départ des isochrones : l'adresse ne dit rien quand il n'y en avait pas, il faut l'effacer.
    for (const module of manager.modules) {
      if (module.urlState && module.id in saved.urlStates) module.urlState.write(saved.urlStates[module.id] ?? '');
    }
    applySharedState(manager, saved.fragment);
    if (!map) return;
    if (saved.globe && map.getProjection()?.type !== 'globe') map.setProjection({ type: 'globe' });
    else if (!saved.globe && saved.terrain !== (map.getTerrain() != null)) {
      map.setTerrain(saved.terrain ? { source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION } : null);
    }
    const view = { center: saved.center, zoom: saved.zoom, bearing: saved.bearing, pitch: saved.pitch };
    if (prefersReducedMotion()) map.jumpTo(view);
    else map.flyTo({ ...view, duration: 2_000, essential: true });
  }

  /** Arrête ce que l'étape en cours a mis en route : minuteries, suivi, sélection, animations propres à l'étape. */
  private stopWork(): void {
    clearTimeout(this.dwellTimer);
    this.dwellTimer = undefined;
    clearTimeout(this.noticeTimer);
    this.leave?.();
    this.leave = undefined;
    this.refly = undefined;
    this.manager?.setFollowing(false);
  }

  private helpers(token: number): TourHelpers | undefined {
    const manager = this.manager;
    const map = manager?.getMap();
    if (!manager || !map) return undefined;
    return {
      manager,
      map,
      summary: (id) => manager.getSnapshot()[id]?.summary ?? null,
      status: (id) => manager.getSnapshot()[id]?.status,
      data: <T>(id: string) => manager.getData<T>(id),
      cancelled: () => token !== this.token,
    };
  }

  /** Va à l'étape `index` ; passe celles qui n'ont pas de données, dans le sens `dir`. */
  private async enter(index: number, dir: 1 | -1): Promise<void> {
    const token = ++this.token;
    this.stopWork();
    this.pendingNotice = null;
    let i = index;
    let direction = dir;
    for (;;) {
      if (i >= STOPS.length) return this.enterEnd();
      if (i < 0) {
        i = 0;
        direction = 1;
      }
      const outcome = await this.run(i, token);
      if (token !== this.token) return;
      if (outcome === 'shown') return;
      this.pendingNotice = `Étape « ${STOPS[i]!.title} » passée : pas de données pour le moment.`;
      i += direction;
    }
  }

  private enterEnd(): void {
    this.manager?.setSelection(null, null);
    this.set({
      phase: 'end',
      index: STOPS.length - 1,
      kicker: 'Visite guidée',
      title: 'À vous de jouer',
      caption: 'Cherchez une gare, un vol ou une commune dans la barre du haut, ouvrez « Couches » pour tout ce qu’on n’a pas vu, ou tirez la frise pour remonter le temps.',
      statModule: null,
      dwellMs: 0,
      playing: true,
      notice: this.pendingNotice,
    });
  }

  /** Joue une étape jusqu'à l'affichage de sa légende : `shown`, ou `skipped` faute de données, ou `cancelled`. */
  private async run(index: number, token: number): Promise<'shown' | 'skipped' | 'cancelled'> {
    const stop: TourStop = STOPS[index]!;
    const h = this.helpers(token);
    if (!h) return 'cancelled';
    const { manager, map } = h;

    const when = resolveTime(stop.time, Date.now());
    if (when.skip) return 'skipped';

    // La légende n'apparaît qu'avec les données : en attendant, le titre et l'avis éventuel.
    this.set({
      index,
      phase: 'loading',
      kicker: stop.kicker,
      title: stop.title,
      caption: null,
      statModule: null,
      dwellMs: 0,
      notice: this.pendingNotice,
      playing: this.state.playing || this.state.phase === 'end',
    });
    this.dwellRemaining = 0;
    this.armNotice();

    // Couches, réglages et instant, avant le vol : les données se chargent pendant le déplacement.
    stop.prepare?.(h);
    manager.setSelection(null, null);
    manager.setVisibleOnly(stop.layers, { persist: false });
    for (const [id, settings] of Object.entries(stop.settings ?? {})) {
      for (const [key, value] of Object.entries(settings)) manager.setSetting(id, key, value, { persist: false });
    }
    if (when.at === null) {
      clock.goLive();
      if (when.speed !== 1) clock.setSpeed(when.speed);
    } else {
      clock.setSpeed(when.speed);
      clock.seek(when.at);
      clock.play();
    }

    // Caméra.
    const camera = stop.camera;
    const flight = camera.duration ?? 5_000;
    let attempts = 0;
    const fly = (): void => {
      this.arrived = false;
      this.interrupted = false;
      const view = { center: camera.center, zoom: camera.zoom, pitch: camera.pitch, bearing: camera.bearing };
      if (prefersReducedMotion()) {
        // Coupure franche : pas de long vol pour qui préfère moins de mouvement.
        map.jumpTo(view);
        this.arrived = true;
        return;
      }
      map.flyTo({ ...view, duration: flight, essential: true });
      // Après `flyTo` : démarrer un vol interrompt le précédent, qui annonce sa propre fin.
      map.once('moveend', () => {
        if (token !== this.token || this.interrupted) return;
        // Un vol coupé net par autre chose (la caméra qui lâchait un avion suivi, par exemple) n'est pas une arrivée : on repart.
        const c = map.getCenter();
        const off = Math.abs(c.lng - camera.center[0]) + Math.abs(c.lat - camera.center[1]);
        if ((off > 0.02 || Math.abs(map.getZoom() - camera.zoom) > 0.3) && attempts++ < 3) fly();
        else this.arrived = true;
      });
    };
    // Laisser passer une image : la carte lâche d'abord l'objet suivi à l'étape précédente, ce qui couperait le vol.
    await sleep(120);
    if (token !== this.token) return 'cancelled';
    this.refly = fly;
    fly();

    // Attente des données (et de l'arrivée de la caméra).
    let deadline = Date.now() + flight + (stop.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    for (;;) {
      await sleep(POLL_MS);
      if (token !== this.token) return 'cancelled';
      // La personne a repris la main avant l'arrivée : on l'attend sans compter ce temps.
      if (!this.state.playing && !this.arrived) {
        deadline += POLL_MS;
        continue;
      }
      if (this.arrived && stop.ready(h)) break;
      if (Date.now() > deadline) return 'skipped';
    }

    // Les couches natives (tuiles) arrivent après les données : on les attend un peu pour ne pas légender un fond vide.
    const tilesDeadline = Date.now() + TILES_TIMEOUT_MS;
    while (!map.areTilesLoaded() && Date.now() < tilesDeadline) {
      await sleep(150);
      if (token !== this.token) return 'cancelled';
    }
    if (stop.settleMs) {
      await sleep(stop.settleMs);
      if (token !== this.token) return 'cancelled';
    }

    this.leave = stop.onReady?.(h) ?? undefined;
    const context: StopContext = { recorded: when.recorded };
    this.set({
      phase: 'showing',
      caption: typeof stop.caption === 'string' ? stop.caption : stop.caption(context),
      statModule: stop.stat ?? null,
      dwellMs: stop.dwellMs,
      shownAt: Date.now(),
    });
    this.dwellRemaining = stop.dwellMs;
    if (this.state.playing) this.runDwell();
    return 'shown';
  }

  /** Fait disparaître l'avis « étape passée » au bout d'un moment. */
  private armNotice(): void {
    clearTimeout(this.noticeTimer);
    if (!this.state.notice) return;
    this.noticeTimer = setTimeout(() => this.set({ notice: null }), NOTICE_MS);
  }

  private runDwell(): void {
    clearTimeout(this.dwellTimer);
    this.dwellStartedAt = Date.now();
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = undefined;
      this.next();
    }, this.dwellRemaining);
  }
}

export const tour = new TourController();

// En développement, la visite est accessible depuis la console : window.__tour.next(), etc.
if (import.meta.env.DEV) Object.assign(window, { __tour: tour });
