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
