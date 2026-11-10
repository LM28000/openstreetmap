/**
 * Dates et heures en français (« demain 8h », « hier 18h », « il y a 2 h », « lundi 14h30 »).
 *
 * Tout se calcule à l'heure de Paris, comme le reste de l'interface : « demain 8h »
 * veut dire 8 h à Paris, quel que soit le fuseau de l'ordinateur.
 */
import { fold } from './normalize';

const ZONE = 'Europe/Paris';
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Plage de la frise : 7 jours en arrière, 2 jours en avant (voir `TimeBar`). */
export const PAST_LIMIT_MS = 7 * DAY;
export const FUTURE_LIMIT_MS = 2 * DAY;

const parts = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
}

function wallTime(ms: number): Wall {
  const get = Object.fromEntries(parts.formatToParts(ms).map((p) => [p.type, Number(p.value)]));
  return { y: get.year!, m: get.month!, d: get.day!, h: get.hour!, mi: get.minute! };
}

/** L'instant où il est `h:mi` à Paris le `y-m-d` (le jour est normalisé : le 32 janvier devient le 1er février). */
function fromWall(y: number, m: number, d: number, h: number, mi: number): number {
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  let ms = asUtc;
  // Deux passes : l'écart avec UTC dépend de l'heure d'été en vigueur à l'instant cherché.
  for (let i = 0; i < 2; i++) {
    const w = wallTime(ms);
    ms += asUtc - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
  }
  return ms;
}

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const NUMBER_WORDS: Record<string, number> = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, dix: 10 };
const UNIT_MS: Array<[RegExp, number]> = [
  [/^(?:h|heures?)$/, HOUR],
  [/^(?:mn|min|minutes?)$/, MINUTE],
  [/^(?:j|jours?)$/, DAY],
  [/^semaines?$/, 7 * DAY],
];

/** Moment de la journée, quand il n'y a pas d'heure précise. */
const PART_OF_DAY: Array<[RegExp, number]> = [
  [/\bmatin\b/, 8],
  [/\bapres midi\b/, 15],
  [/\bmidi\b/, 12],
  [/\bsoir\b/, 20],
  [/\bminuit\b/, 0],
];

export interface When {
  at: number;
  /** Texte tel qu'on le montre : « mardi 11 novembre à 08:00 ». */
  label: string;
  /** Vrai si le moment demandé sort de la frise et a été ramené à sa limite. */
  clamped: boolean;
}

const labelFormat = new Intl.DateTimeFormat('fr-FR', {
  timeZone: ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});

/** Comprend une date ou une heure en français, `null` si le texte n'en est pas une. */
export function parseWhen(raw: string, now = Date.now()): When | null {
  // « 8:30 » devient « 8h30 » avant que la normalisation ne fasse disparaître les deux-points.
  const text = fold(raw.toLowerCase().replace(/(\d)\s*:\s*(\d)/g, '$1h$2'));
  if (!text) return null;
  const at = relative(text, now) ?? absolute(text, now);
  if (at === null) return null;
  const min = now - PAST_LIMIT_MS;
  const max = now + FUTURE_LIMIT_MS;
  const clamped = at < min || at > max;
  const bounded = Math.min(Math.max(at, min), max);
  return { at: bounded, label: labelFormat.format(bounded).replace(',', ''), clamped };
}

/** « il y a 2 h », « dans 3 jours ». */
function relative(text: string, now: number): number | null {
  const found = /^(il y a|dans) (\d{1,3}|un|une|deux|trois|quatre|cinq|six|dix) ?([a-z]+)$/.exec(text);
  if (!found) return null;
  const count = /^\d/.test(found[2]!) ? Number(found[2]) : NUMBER_WORDS[found[2]!];
  const unit = UNIT_MS.find(([pattern]) => pattern.test(found[3]!));
  if (count === undefined || !unit) return null;
  return now + (found[1] === 'dans' ? 1 : -1) * count * unit[1];
}

/** « demain 8h », « hier 18h30 », « lundi », « 14h », « ce soir ». */
function absolute(text: string, now: number): number | null {
  const today = wallTime(now);
  let dayShift: number | null = null;

  if (/\bavant hier\b/.test(text)) dayShift = -2;
  else if (/\bhier\b/.test(text)) dayShift = -1;
  else if (/\bapres demain\b/.test(text)) dayShift = 2;
  else if (/\bdemain\b/.test(text)) dayShift = 1;
  else if (/\baujourd hui\b|\bce (?:matin|soir)\b|\bcet apres midi\b/.test(text)) dayShift = 0;
  else {
    const weekday = WEEKDAYS.findIndex((name) => new RegExp(`\\b${name}\\b`).test(text));
    if (weekday >= 0) {
      const todayWeekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay();
      dayShift = (weekday - todayWeekday + 7) % 7 || 7; // le prochain, pas aujourd'hui
    }
  }

  // Heure précise : « 8h », « 18 h 15 », « 8 heures ».
  let hour: number | null = null;
  let minute = 0;
  const clock = /(?:^| )(\d{1,2}) ?(?:h|heures?)(?: ?(\d{2}))?(?= |$)/.exec(text);
  if (clock) {
    hour = Number(clock[1]);
    minute = clock[2] ? Number(clock[2]) : 0;
    if (hour > 24 || minute > 59) return null;
  } else {
    const part = PART_OF_DAY.find(([pattern]) => pattern.test(text));
    if (part) hour = part[1];
  }

  if (dayShift === null && hour === null) return null;
  // Une heure seule veut dire aujourd'hui ; un jour seul garde l'heure qu'il est.
  const y = today.y;
  const day = today.d + (dayShift ?? 0);
  return fromWall(y, today.m, day, hour ?? today.h, hour === null ? today.mi : minute);
}

/** Vrai si le texte est du seul registre « maintenant ». */
export const isLiveWord = (text: string): boolean => /^(?:direct|en direct|maintenant|live|temps reel|present)$/.test(fold(text));
