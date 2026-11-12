/**
 * État de la vue dans l'adresse : recharger ou partager le lien rouvre la même vue.
 *
 * Tout vit dans le fragment (`#`), sous forme de paramètres séparés par `&`. MapLibre garde
 * `vue=zoom/lat/lng/cap/inclinaison` (option `hash: 'vue'`) et laisse les autres paramètres
 * en place ; ce module gère les suivants :
 *
 *   couches=trains,voies,avions     couches affichées (présent même vide : « aucune »)
 *   reglages=trains.couleur:retard,velos.mode:x   réglages des couches affichées (id.réglage:valeur)
 *   t=direct | t=2026-11-09T17:00:00Z   instant affiché (UTC), ou le direct
 *   vitesse=3600                     secondes simulées par seconde, absent à ×1
 *   pause=1                          horloge en pause, absent en lecture
 *   depuis=87471003                  gare de départ des isochrones (paramètre propre à un module : `urlState`)
 *   objet=trains:%7B%22type%22…      module sélectionné, puis la valeur de `select` en JSON
 *
 * Les préférences du navigateur (`localStorage`) restent la valeur par défaut quand
 * l'adresse ne dit rien : ce qui vient de l'adresse n'y est pas enregistré.
 */
import { clock } from './clock';
import type { ModuleManager } from './moduleManager';

const KEYS = ['couches', 'reglages', 't', 'vitesse', 'pause', 'objet', 'depuis'] as const;
/** Drapeau de l'adresse qui lance la visite guidée (`#visite`). Ce n'est pas un état à rouvrir : il est retiré dès qu'il est lu. */
const TOUR_FLAG = 'visite';
/** Pendant un rejeu en lecture, l'instant de l'adresse est rafraîchi à ce rythme. */
const REPLAY_REFRESH_MS = 10_000;

/** Paramètres du fragment, dans l'ordre, valeurs non décodées. */
function readParams(fragment: string = window.location.hash): Array<[string, string]> {
  return fragment
    .replace(/^#/, '')
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const i = part.indexOf('=');
      return i < 0 ? [part, ''] : [part.slice(0, i), part.slice(i + 1)];
    });
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Vrai si l'adresse porte un état à rouvrir (et non la seule position de la carte). */
export function hasSharedState(): boolean {
  return readParams().some(([key]) => (KEYS as readonly string[]).includes(key));
}

/** Vrai si l'adresse demande la visite guidée (`#visite`). */
export function hasTourFlag(): boolean {
  return readParams().some(([key]) => key === TOUR_FLAG);
}

/** Retire le drapeau `visite` de l'adresse : recharger la page ne relance pas la visite. */
export function clearTourFlag(): void {
  const rest = readParams().filter(([key]) => key !== TOUR_FLAG);
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${rest.length ? `#${rest.map(([k, v]) => (v ? `${k}=${v}` : k)).join('&')}` : ''}`);
  } catch {
    // l'adresse ne peut pas être modifiée (aperçu intégré…) : tant pis
  }
}

/**
 * Applique l'état de l'adresse au gestionnaire et à l'horloge. À appeler avant le premier affichage de la carte.
 * `fragment` : un état pris plus tôt par `captureState` (la visite guidée le rejoue en la quittant) ; par défaut, l'adresse.
 */
export function applySharedState(manager: ModuleManager, fragment?: string): void {
  const params = new Map(readParams(fragment));
  const persist = { persist: false };

  const layers = params.get('couches');
  if (layers !== undefined) manager.setVisibleOnly(layers.split(',').map((id) => safeDecode(id) ?? ''), persist);

  for (const entry of (params.get('reglages') ?? '').split(',').filter(Boolean)) {
    const [path = '', rawValue = ''] = entry.split(':').map((piece) => safeDecode(piece) ?? '');
    const dot = path.indexOf('.');
    if (dot > 0) manager.setSetting(path.slice(0, dot), path.slice(dot + 1), rawValue, persist);
  }

  for (const module of manager.modules) {
    const value = module.urlState ? safeDecode(params.get(module.urlState.param) ?? '') : null;
    if (module.urlState && value) module.urlState.write(value);
  }

  const time = params.get('t');
  if (time === 'direct') clock.goLive();
  else if (time) {
    const instant = Date.parse(safeDecode(time) ?? '');
    const speed = Number(params.get('vitesse'));
    if (Number.isFinite(instant)) {
      if (speed > 0) clock.setSpeed(speed);
      clock.seek(instant);
      if (params.get('pause') === '1') clock.pause();
    }
  }

  const object = params.get('objet');
  if (object) {
    const colon = object.indexOf(':');
    const moduleId = colon > 0 ? safeDecode(object.slice(0, colon)) : null;
    const json = colon > 0 ? safeDecode(object.slice(colon + 1)) : null;
    if (moduleId && json) {
      try {
        manager.setSelection(moduleId, JSON.parse(json));
      } catch {
        // adresse abîmée : on ouvre la carte sans sélection
      }
    }
  }
}

/** Les paramètres d'état (couches, réglages, instant, sélection…) pour l'état actuel, sans la position de la carte. */
function stateParams(manager: ModuleManager): Array<[string, string]> {
  const snapshot = manager.getSnapshot();
  const visible = manager.modules.filter((module) => snapshot[module.id]?.visible);

  const settings: string[] = [];
  for (const module of visible) {
    for (const setting of module.settings ?? []) {
      const value = snapshot[module.id]?.settings[setting.id];
      if (value !== undefined) settings.push(`${encodeURIComponent(`${module.id}.${setting.id}`)}:${encodeURIComponent(value)}`);
    }
  }

  const ours: Array<[string, string]> = [['couches', visible.map((m) => encodeURIComponent(m.id)).join(',')]];
  if (settings.length > 0) ours.push(['reglages', settings.join(',')]);

  const { live, playing, speed } = clock.getState();
  if (live) {
    ours.push(['t', 'direct']);
  } else {
    ours.push(['t', new Date(Math.round(clock.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z')]);
    if (speed !== 1) ours.push(['vitesse', String(speed)]);
    if (!playing) ours.push(['pause', '1']);
  }

  for (const module of visible) {
    const value = module.urlState?.read();
    if (module.urlState && value) ours.push([module.urlState.param, encodeURIComponent(value)]);
  }

  const selection = manager.getSelection();
  if (selection) ours.push(['objet', `${encodeURIComponent(selection.moduleId)}:${encodeURIComponent(JSON.stringify(selection.value))}`]);

  return ours;
}

/** Fragment complet (position de la carte comprise) pour l'état actuel. */
function buildHash(manager: ModuleManager): string {
  const kept = readParams().filter(([key]) => !(KEYS as readonly string[]).includes(key));
  return `#${[...kept, ...stateParams(manager)].map(([key, value]) => `${key}=${value}`).join('&')}`;
}

/** L'état actuel (couches, réglages, instant, sélection) sous forme de fragment, à rejouer avec `applySharedState(manager, fragment)`. */
export function captureState(manager: ModuleManager): string {
  return `#${stateParams(manager).map(([key, value]) => `${key}=${value}`).join('&')}`;
}

/** Écrit l'état dans l'adresse (sans ajouter d'entrée à l'historique). */
export function writeSharedState(manager: ModuleManager): void {
  const hash = buildHash(manager);
  if (hash === window.location.hash) return;
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
  } catch {
    // l'adresse ne peut pas être modifiée (aperçu intégré…) : tant pis
  }
}

/** Adresse à partager : la vue, les couches, l'instant et la sélection d'à l'instant. */
export function shareUrl(manager: ModuleManager): string {
  writeSharedState(manager);
  return window.location.href;
}

/**
 * Tient l'adresse à jour. Renvoie la fonction qui arrête la synchronisation.
 * Les écritures sont groupées : le gestionnaire notifie à chaque résumé recalculé.
 */
export function startSharedStateSync(manager: ModuleManager): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    timer ??= setTimeout(() => {
      timer = undefined;
      writeSharedState(manager);
    }, 250);
  };
  const unsubscribeManager = manager.subscribe(schedule);
  const unsubscribeClock = clock.subscribe(schedule);
  // Un rejeu en lecture avance sans que rien ne change : on rafraîchit l'instant de temps en temps.
  const replayTimer = setInterval(() => {
    const { live, playing } = clock.getState();
    if (!live && playing) schedule();
  }, REPLAY_REFRESH_MS);
  const flush = () => writeSharedState(manager);
  window.addEventListener('pagehide', flush);
  schedule();
  return () => {
    clearTimeout(timer);
    clearInterval(replayTimer);
    unsubscribeManager();
    unsubscribeClock();
    window.removeEventListener('pagehide', flush);
  };
}
