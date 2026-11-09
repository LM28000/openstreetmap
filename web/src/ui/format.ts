/** Formatage des dates et durées, toujours à l'heure de Paris. */

const TIME_ZONE = 'Europe/Paris';

const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const longDateFormat = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const clockFormat = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const relativeFormat = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

/** « 9 nov. 2026, 22:16 » */
export function formatDateTime(ms: number): string {
  return dateTimeFormat.format(ms);
}

/** « lundi 9 novembre 2026 » */
export function formatLongDate(ms: number): string {
  return longDateFormat.format(ms);
}

/** « 22:16:05 » */
export function formatClock(ms: number): string {
  return clockFormat.format(ms);
}

/** « il y a 3 minutes », « à l'instant » */
export function formatRelative(ms: number, now = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  if (Math.abs(seconds) < 45) return 'à l’instant';
  if (Math.abs(seconds) < 60) return relativeFormat.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeFormat.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeFormat.format(hours, 'hour');
  return relativeFormat.format(Math.round(hours / 24), 'day');
}

/** Écart avec le présent : « −3 h 20 », « +2 j 4 h », « +45 s ». */
export function formatOffset(deltaMs: number): string {
  const sign = deltaMs < 0 ? '−' : '+';
  let seconds = Math.round(Math.abs(deltaMs) / 1000);
  if (seconds < 60) return `${sign}${seconds} s`;
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds - hours * 3_600) / 60);
  if (days > 0) return `${sign}${days} j ${hours} h`;
  if (hours > 0) return `${sign}${hours} h ${String(minutes).padStart(2, '0')}`;
  return `${sign}${minutes} min`;
}
