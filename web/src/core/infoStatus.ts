/**
 * Pastilles de statut des fiches (`InfoContent.status`), communes à toutes les couches :
 * une même nature de donnée s'annonce partout avec les mêmes mots et le même signe.
 *
 * - `live` (point rouge) : la donnée est reçue en temps réel et l'horloge est au direct ;
 * - `replay` (anneau) : on regarde le passé (ou l'avenir), la donnée est rejouée ;
 * - `estimated` (anneau pointillé) : valeur calculée (position d'après l'horaire…) ;
 * - `scheduled` (point gris) : horaire théorique, prévision ;
 * - `none` : simple mention, sans point.
 */
import type { InfoStatus } from './module';
import { formatDateTime, formatRelative, formatTime } from '../ui/format';
import { replayLabel } from './replay';

/**
 * Écart toléré entre l'horloge de la carte et l'heure réelle pour parler de direct.
 * `RenderContext` ne dit pas si l'horloge est « en direct » : on compare son instant au présent.
 */
const LIVE_WINDOW_MS = 15_000;

/** Vrai si l'instant affiché par la carte est le présent. */
export function isLiveTime(time: number): boolean {
  return Math.abs(time - Date.now()) < LIVE_WINDOW_MS;
}

/** « 08:40 » le jour même, « 9 nov. 2026, 08:40 » sinon. */
function moment(ms: number): string {
  return new Date(ms).toDateString() === new Date().toDateString() ? formatTime(ms) : formatDateTime(ms);
}

/**
 * Donnée mesurée (position reçue, relevé, détection) :
 * « En direct · il y a 2 minutes » au direct, « Rejoué · 08:40 » hors du direct.
 * `measuredAt` : instant de la mesure (ms), s'il est connu.
 */
export function measuredStatus(time: number, measuredAt?: number): InfoStatus {
  if (isLiveTime(time)) {
    return { tone: 'live', text: measuredAt === undefined ? 'En direct' : `En direct · ${formatRelative(measuredAt)}` };
  }
  return { tone: 'replay', text: `Rejoué · ${moment(time)}` };
}

/** Donnée relue dans l'historique enregistré par le serveur : « Relecture du 9 nov. à 18:05 ». */
export function replayStatus(time: number): InfoStatus {
  return { tone: 'replay', text: replayLabel(time) };
}

/** Valeur calculée plutôt que mesurée : « Position estimée d'après l'horaire ». */
export function estimatedStatus(text: string): InfoStatus {
  return { tone: 'estimated', text };
}

/** Horaire théorique ou prévision : « Horaire prévu », « Prévision pour 15:00 ». */
export function scheduledStatus(text: string): InfoStatus {
  return { tone: 'scheduled', text };
}

/** Simple mention, sans point : « Mis à jour à 14:05 ». */
export function plainStatus(text: string): InfoStatus {
  return { tone: 'none', text };
}
