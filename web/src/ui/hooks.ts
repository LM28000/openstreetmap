import { useEffect, useState, useSyncExternalStore } from 'react';
import { clock, type ClockState } from '../core/clock';
import type { ModuleManager, ModuleRuntimeState } from '../core/moduleManager';

/** État de l'horloge (lecture, vitesse, direct). Ne change qu'aux actions de l'utilisateur. */
export function useClockState(): ClockState {
  return useSyncExternalStore(clock.subscribe, clock.getState);
}

/**
 * Instant simulé, rafraîchi quelques fois par seconde. Suffisant pour l'affichage :
 * la carte, elle, lit l'horloge directement à chaque image.
 */
export function useClockTime(intervalMs = 250): number {
  const [time, setTime] = useState(() => clock.now());
  useEffect(() => {
    const refresh = () => setTime(clock.now());
    const timer = setInterval(refresh, intervalMs);
    const unsubscribe = clock.subscribe(refresh);
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, [intervalMs]);
  return time;
}

/** Heure réelle, rafraîchie régulièrement (pour les « il y a 3 minutes »). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function useModuleStates(manager: ModuleManager): Readonly<Record<string, ModuleRuntimeState>> {
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot);
}

/** Vrai tant que la requête média correspond (ex. `(max-width: 719.98px)`). */
export function useMediaQuery(query: string): boolean {
  const subscribe = (onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  };
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

/** Sous 720 px de large : la mise en page de téléphone (recherche en haut, feuille en bas). */
export const PHONE_QUERY = '(max-width: 719.98px)';

/** Objet sélectionné et sa fiche à l'instant affiché, recalculée en continu (un train avance, un retard change). */
export function useSelectionInfo(manager: ModuleManager) {
  const selection = useSyncExternalStore(manager.subscribe, manager.getSelection);
  // Recalculer aussi quand de nouvelles données arrivent (horloge en pause, saut dans le temps…).
  useModuleStates(manager);
  const time = useClockTime(500);
  const info = selection ? manager.describeSelection(time) : null;
  return { selection, info };
}
