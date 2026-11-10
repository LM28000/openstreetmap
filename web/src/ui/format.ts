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
const timeFormat = new Intl.DateTimeFormat('fr-FR', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});
const relativeFormat =new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });

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

/** « 22:16 » */
export function formatTime(ms: number): string {
  return timeFormat.format(ms);
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

// --- Calendrier de Paris (les jours de la frise commencent à minuit à Paris) ---

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export interface ParisParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function parisParts(ms: number): ParisParts {
  const values: Record<string, number> = {};
  for (const part of partsFormat.formatToParts(ms)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year ?? 1970,
    month: values.month ?? 1,
    day: values.day ?? 1,
    hour: values.hour ?? 0,
    minute: values.minute ?? 0,
    second: values.second ?? 0,
  };
}

/** Instant (ms UTC) d'une date et d'une heure lues à Paris. Le jour peut déborder (0 ou 32 : le mois suit). */
export function fromParis(year: number, month: number, day: number, hour = 0, minute = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // L'écart avec UTC dépend de la date (heure d'été) : on l'évalue deux fois pour tomber juste autour des changements d'heure.
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = parisParts(guess);
    guess = wall - (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(guess / 1000) * 1000);
  }
  return guess;
}

/** Minuit à Paris du jour qui contient `ms`, décalé de `days` jours. */
export function parisMidnight(ms: number, days = 0): number {
  const p = parisParts(ms);
  return fromParis(p.year, p.month, p.day + days, 0, 0);
}

const weekdayFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric' });
/** « mar. 10 » */
export function formatDayLabel(ms: number): string {
  return weekdayFormat.format(ms);
}

const shortDateFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'short' });
/** « mardi 10 nov. » */
export function formatShortDate(ms: number): string {
  return shortDateFormat.format(ms);
}

/** Valeur d'un champ `datetime-local` (heure de Paris) pour cet instant. */
export function toDateTimeInput(ms: number): string {
  const p = parisParts(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)}T${two(p.hour)}:${two(p.minute)}`;
}

/** Instant d'une valeur de champ `datetime-local`, lue à l'heure de Paris. `null` si elle est incomplète. */
export function fromDateTimeInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  return fromParis(y!, mo!, d!, h!, mi!);
}
