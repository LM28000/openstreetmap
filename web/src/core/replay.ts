/**
 * Relecture du passé : lit les tronçons que le serveur enregistre (server/src/history/) et rend, pour un instant
 * quelconque, la position interpolée de chaque objet.
 *
 * Le serveur enregistre toutes les 10 minutes un tronçon par couche (avions, bateaux, transports) : des
 * trajectoires en colonnes, avec des entiers codés en différences (voir server/src/history/codec.rs, qui décrit
 * le format ; le décodeur ci-dessous en est le miroir exact). Un tronçon est autonome : il contient, pour chaque
 * objet, le dernier point d'avant son début et le premier d'après sa fin. Pour afficher l'instant t, il suffit donc
 * du tronçon qui contient t.
 *
 * Trois choses vivent ici :
 * - la **disponibilité** (`/api/historique`) : où il y a des enregistrements, et où il y a des trous ;
 * - le **cache de tronçons** : un tronçon fermé est immuable, on ne le redemande jamais ; un tronçon encore ouvert
 *   l'est au plus toutes les 20 s ; on précharge le voisin quand on s'approche d'un bord ;
 * - l'**échantillonnage** : où est tel objet à l'instant t, par interpolation linéaire entre ses deux points voisins.
 */
import { formatDateTime } from '../ui/format';

export type ReplayLayerId = 'avions' | 'bateaux' | 'transports';

/** Durée d'un tronçon (secondes), comme `CHUNK_S` du serveur. */
export const CHUNK_S = 600;
/** Au-delà de ce retard sur l'heure réelle, les couches mobiles passent sur l'enregistrement. */
export const REPLAY_AFTER_MS = 120_000;

/** Vrai quand l'instant affiché est assez loin dans le passé pour être rejoué plutôt que reçu en direct. */
export function isReplayTime(time: number, now = Date.now()): boolean {
  return time < now - REPLAY_AFTER_MS;
}

/**
 * Au-delà de cet écart (secondes) entre deux points consécutifs, un objet qui a bougé a disparu entre les deux (hors
 * de couverture) : on ne l'interpole pas. Et après son dernier point, on le garde ce temps-là (`HOLD_S`) avant de le retirer.
 */
export const MAX_GAP_S: Record<ReplayLayerId, number> = { avions: 120, bateaux: 600, transports: 150 };
export const HOLD_S: Record<ReplayLayerId, number> = { avions: 30, bateaux: 180, transports: 90 };

// ───────────────────────── Disponibilité ─────────────────────────

export interface Availability {
  /** Faux : le serveur n'enregistre rien (pas de dossier d'archive). */
  active: boolean;
  /** Heure du serveur au moment de la réponse. */
  now: number;
  retentionDays: number;
  /** Par couche (et `trains`) : plages `[de, à]` en secondes UNIX où l'on a des données. */
  layers: Record<string, Array<[number, number]>>;
}

let availability: Availability | null = null;
let availabilityPromise: Promise<Availability | null> | null = null;
let availabilityAt = 0;
let availabilityTimer: ReturnType<typeof setInterval> | undefined;
const availabilityListeners = new Set<() => void>();
const AVAILABILITY_EVERY_MS = 60_000;

export const getAvailability = (): Availability | null => availability;

export function subscribeAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  startAvailabilityTimer();
  return () => availabilityListeners.delete(listener);
}

function startAvailabilityTimer(): void {
  if (availabilityTimer !== undefined) return;
  availabilityTimer = setInterval(() => void loadAvailability(true), AVAILABILITY_EVERY_MS);
  if (!availability) void loadAvailability();
}

/** Disponibilité des enregistrements : relue au plus une fois par minute (sauf `force`). */
export function loadAvailability(force = false): Promise<Availability | null> {
  if (availabilityPromise) return availabilityPromise;
  if (!force && availability && Date.now() - availabilityAt < AVAILABILITY_EVERY_MS) return Promise.resolve(availability);
  startAvailabilityTimer();
  availabilityPromise = fetch('/api/historique')
    .then((response) => (response.ok ? (response.json() as Promise<Availability>) : null))
    .catch(() => null)
    .then((result) => {
      if (result) {
        availability = result;
        availabilityAt = Date.now();
        for (const listener of availabilityListeners) listener();
      }
      return availability;
    })
    .finally(() => {
      availabilityPromise = null;
    });
  return availabilityPromise;
}

/** Ce que l'on sait de l'instant `time` (ms) pour une couche. */
export type Coverage =
  | { kind: 'ok' }
  | { kind: 'unknown' }
  | { kind: 'inactive' }
  | { kind: 'before'; from: number }
  | { kind: 'gap'; from: number; to: number }
  | { kind: 'after'; to: number };

/** Marge : un instant à quelques secondes d'une plage est considéré comme couvert (cadence des relevés). */
const COVERAGE_SLACK_S = 15;

export function coverageAt(layer: string, time: number): Coverage {
  if (!availability) return { kind: 'unknown' };
  if (!availability.active) return { kind: 'inactive' };
  const ranges = availability.layers[layer] ?? [];
  const t = time / 1000;
  const first = ranges[0];
  if (!first) return { kind: 'before', from: Number.POSITIVE_INFINITY };
  if (t < first[0] - COVERAGE_SLACK_S) return { kind: 'before', from: first[0] * 1000 };
  for (let i = 0; i < ranges.length; i++) {
    const [from, to] = ranges[i]!;
    if (t >= from - COVERAGE_SLACK_S && t <= to + COVERAGE_SLACK_S) return { kind: 'ok' };
    const next = ranges[i + 1];
    if (next && t > to && t < next[0]) return { kind: 'gap', from: to * 1000, to: next[0] * 1000 };
  }
  return { kind: 'after', to: ranges[ranges.length - 1]![1] * 1000 };
}

const dayFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short' });
const hourFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });

/** « 21 h », « 21 h 20 » : l'heure à la française, sans minutes quand elles sont nulles. */
export function hourText(ms: number): string {
  const parts = hourFormat.formatToParts(ms);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return minute === '00' ? `${Number(hour)} h` : `${Number(hour)} h ${minute}`;
}

/** « 10 nov. à 21 h » */
export function dayHourText(ms: number): string {
  return `${dayFormat.format(ms)} à ${hourText(ms)}`;
}

/** « Relecture du 9 nov. à 18:05 » */
export function replayLabel(time: number): string {
  const full = formatDateTime(time); // « 9 nov. 2026, 18:05 »
  const [date = '', hour = ''] = full.replace(/\s\d{4}/, '').split(', ');
  return `Relecture du ${date} à ${hour}`;
}

/** Phrase qui explique l'absence d'enregistrement à cet instant ; `null` s'il y en a un. */
export function noRecordingText(layer: string, time: number): string | null {
  const c = coverageAt(layer, time);
  switch (c.kind) {
    case 'ok':
    case 'unknown':
      return null;
    case 'inactive':
      return 'Ce serveur n’enregistre pas l’historique.';
    case 'before':
      return Number.isFinite(c.from) ? `Pas d’enregistrement avant le ${dayHourText(c.from)}` : 'Pas d’enregistrement pour l’instant';
    case 'gap':
      return dayFormat.format(c.from) === dayFormat.format(c.to)
        ? `Pas d’enregistrement de ${hourText(c.from)} à ${hourText(c.to)} (${dayFormat.format(c.from)})`
        : `Pas d’enregistrement du ${dayHourText(c.from)} au ${dayHourText(c.to)}`;
    case 'after':
      return `Pas d’enregistrement après le ${dayHourText(c.to)}`;
  }
}

// ───────────────────────── Tronçons ─────────────────────────

export interface DecodedChunk {
  layer: ReplayLayerId;
  /** Début et fin (secondes UNIX). */
  start: number;
  end: number;
  closed: boolean;
  /** Tables de chaînes (transports : 0 = lignes, 1 = arrêts). */
  tables: string[][];
  count: number;
  ids: string[];
  strings: string[][];
  /** Champs numériques d'identité : 0 = absent, sinon valeur + 1. */
  numbers: number[][];
  /** Les points de l'objet `o` sont aux indices `first[o]` (inclus) à `first[o + 1]` (exclu). */
  first: Int32Array;
  /** Instant par rapport au début du tronçon (s), cent-millièmes de degré, masque de présence des mesures. */
  t: Int32Array;
  lon: Int32Array;
  lat: Int32Array;
  mask: Uint8Array;
  cols: Int32Array[];
  /** Dernier point trouvé par objet : le temps avance presque toujours, on repart de là. */
  cursor: Int32Array;
  fetchedAt: number;
}

class Reader {
  pos = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  byte(): number {
    const b = this.bytes[this.pos++];
    if (b === undefined) throw new Error('tronçon tronqué');
    return b;
  }

  /** Entier non signé à longueur variable (sûr jusqu'à 2^53). */
  uvar(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      result += (b & 0x7f) * scale;
      if (b < 0x80) return result;
      scale *= 128;
    }
  }

  ivar(): number {
    const n = this.uvar();
    return n % 2 === 1 ? -(n + 1) / 2 : n / 2;
  }

  u32(): number {
    const p = this.pos;
    this.pos += 4;
    const b = this.bytes;
    if (this.pos > b.length) throw new Error('tronçon tronqué');
    return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;
  }

  string(): string {
    const length = this.uvar();
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return decoder.decode(slice);
  }
}

const decoder = new TextDecoder();

/** Réglages de format par couche : miroir de `Layer::strings`, `numbers`, `columns` et `predicts` côté serveur. */
const FORMAT: Record<number, { layer: ReplayLayerId; strings: number; numbers: number; columns: number; predicts: boolean; timeColumn: number }> = {
  1: { layer: 'avions', strings: 6, numbers: 0, columns: 6, predicts: true, timeColumn: -1 },
  2: { layer: 'bateaux', strings: 3, numbers: 6, columns: 4, predicts: true, timeColumn: -1 },
  3: { layer: 'transports', strings: 1, numbers: 2, columns: 5, predicts: false, timeColumn: 4 },
};

/**
 * Valeur attendue d'une coordonnée d'après les deux points précédents : on prolonge la vitesse du dernier segment.
 * Même arithmétique entière que le serveur (division arrondie vers le bas) : les deux côtés retrouvent la même valeur.
 */
function predict(values: Int32Array, times: Int32Array, base: number, i: number, enabled: boolean): number {
  if (i === 0) return 0;
  if (i === 1) return values[base]!;
  const p1 = values[base + i - 1]!;
  if (!enabled) return p1;
  const p0 = values[base + i - 2]!;
  const dt0 = times[base + i - 1]! - times[base + i - 2]!;
  const dt1 = times[base + i]! - times[base + i - 1]!;
  if (dt0 <= 0) return p1;
  return p1 + Math.floor((2 * (p1 - p0) * dt1 + dt0) / (2 * dt0));
}

export function decodeChunk(buffer: ArrayBuffer): DecodedChunk {
  const r = new Reader(new Uint8Array(buffer));
  if (r.byte() !== 0x43 || r.byte() !== 0x56 || r.byte() !== 0x48 || r.byte() !== 0x31) throw new Error('pas un tronçon d’historique');
  const format = FORMAT[r.byte()];
  if (!format) throw new Error('couche inconnue');
  const closed = (r.byte() & 1) !== 0;
  const start = r.u32();
  const end = r.u32();

  const tables: string[][] = [];
  for (let n = r.uvar(); n > 0; n--) {
    const table: string[] = [];
    for (let m = r.uvar(); m > 0; m--) table.push(r.string());
    tables.push(table);
  }
  const count = r.uvar();
  const ids: string[] = [];
  const strings: string[][] = [];
  const numbers: number[][] = [];
  for (let o = 0; o < count; o++) {
    ids.push(r.string());
    const s: string[] = [];
    for (let k = 0; k < format.strings; k++) s.push(r.string());
    strings.push(s);
    const n: number[] = [];
    for (let k = 0; k < format.numbers; k++) n.push(r.uvar());
    numbers.push(n);
  }
  const first = new Int32Array(count + 1);
  for (let o = 0; o < count; o++) first[o + 1] = first[o]! + r.uvar();
  const total = first[count]!;

  const t = new Int32Array(total);
  for (let o = 0; o < count; o++) {
    let previous = 0;
    for (let i = first[o]!; i < first[o + 1]!; i++) {
      previous = i === first[o] ? r.ivar() : previous + r.uvar();
      t[i] = previous;
    }
  }
  const lon = new Int32Array(total);
  const lat = new Int32Array(total);
  for (const values of [lon, lat]) {
    for (let o = 0; o < count; o++) {
      const base = first[o]!;
      const n = first[o + 1]! - base;
      for (let i = 0; i < n; i++) values[base + i] = predict(values, t, base, i, format.predicts) + r.ivar();
    }
  }
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) mask[i] = r.byte();
  const cols: Int32Array[] = [];
  for (let k = 0; k < format.columns; k++) {
    const column = new Int32Array(total);
    for (let o = 0; o < count; o++) {
      let previous = k === format.timeColumn ? start : 0;
      for (let i = first[o]!; i < first[o + 1]!; i++) {
        if (mask[i]! & (1 << k)) {
          previous += r.ivar();
          column[i] = previous;
        }
      }
    }
    cols.push(column);
  }
  return { layer: format.layer, start, end, closed, tables, count, ids, strings, numbers, first, t, lon, lat, mask, cols, cursor: new Int32Array(count), fetchedAt: Date.now() };
}

// ───────────────────────── Échantillonnage ─────────────────────────

/** Où est un objet à l'instant demandé. */
export interface Sample {
  lon: number;
  lat: number;
  /** Indices (dans le tronçon) du point d'avant, du point d'après (ou -1) et part du chemin parcouru entre les deux. */
  i: number;
  j: number;
  f: number;
  /** Âge (s) du point d'avant : sert à estomper ce qui n'a plus de nouvelles. */
  age: number;
  /** Vrai quand la valeur est tenue sur place (objet immobile, ou plus de nouvelles depuis un moment). */
  held: boolean;
}

/**
 * Cherche l'objet `o` à l'instant `rel` (secondes depuis le début du tronçon). Rend l'indice du dernier point
 * qui ne le dépasse pas, ou -1 si l'objet n'existe pas encore.
 */
function locate(chunk: DecodedChunk, o: number, rel: number): number {
  const lo = chunk.first[o]!;
  const hi = chunk.first[o + 1]! - 1;
  if (hi < lo || rel < chunk.t[lo]!) return -1;
  let i = Math.min(Math.max(chunk.cursor[o]!, lo), hi);
  if (chunk.t[i]! > rel) {
    // On a reculé : d'abord quelques pas, puis dichotomie si le saut est grand.
    let steps = 0;
    while (i > lo && chunk.t[i]! > rel && steps < 4) {
      i--;
      steps++;
    }
    if (chunk.t[i]! > rel) {
      let a = lo;
      let b = i;
      while (a < b) {
        const mid = (a + b + 1) >> 1;
        if (chunk.t[mid]! <= rel) a = mid;
        else b = mid - 1;
      }
      i = a;
    }
  } else {
    let steps = 0;
    while (i < hi && chunk.t[i + 1]! <= rel && steps < 4) {
      i++;
      steps++;
    }
    if (i < hi && chunk.t[i + 1]! <= rel) {
      let a = i;
      let b = hi;
      while (a < b) {
        const mid = (a + b + 1) >> 1;
        if (chunk.t[mid]! <= rel) a = mid;
        else b = mid - 1;
      }
      i = a;
    }
  }
  chunk.cursor[o] = i;
  return i;
}

/**
 * Position de l'objet `o` à l'instant `time` (ms) : interpolation linéaire entre ses deux points voisins.
 * Rend `false` (rien à montrer) si l'objet n'existe pas encore, s'il a disparu entre deux points trop éloignés
 * (il avait bougé : hors de couverture), ou s'il n'a plus de nouvelles depuis plus de `HOLD_S`.
 */
export function sample(chunk: DecodedChunk, o: number, time: number, out: Sample): boolean {
  const rel = time / 1000 - chunk.start;
  const i = locate(chunk, o, rel);
  if (i < 0) return false;
  const lastIndex = chunk.first[o + 1]! - 1;
  const ti = chunk.t[i]!;
  out.i = i;
  out.age = rel - ti;
  if (i === lastIndex) {
    if (rel - ti > HOLD_S[chunk.layer]) return false;
    out.j = -1;
    out.f = 0;
    out.lon = chunk.lon[i]! / 1e5;
    out.lat = chunk.lat[i]! / 1e5;
    out.held = true;
    return true;
  }
  const j = i + 1;
  const gap = chunk.t[j]! - ti;
  const same = chunk.lon[i] === chunk.lon[j] && chunk.lat[i] === chunk.lat[j];
  if (gap > MAX_GAP_S[chunk.layer] && !same) {
    // Disparu entre les deux points : on le tient sur place un moment, puis on le retire.
    if (rel - ti > HOLD_S[chunk.layer]) return false;
    out.j = -1;
    out.f = 0;
    out.lon = chunk.lon[i]! / 1e5;
    out.lat = chunk.lat[i]! / 1e5;
    out.held = true;
    return true;
  }
  const f = gap > 0 ? (rel - ti) / gap : 0;
  out.j = j;
  out.f = f;
  out.lon = (chunk.lon[i]! + (chunk.lon[j]! - chunk.lon[i]!) * f) / 1e5;
  out.lat = (chunk.lat[i]! + (chunk.lat[j]! - chunk.lat[i]!) * f) / 1e5;
  out.held = same;
  return true;
}

export const newSample = (): Sample => ({ lon: 0, lat: 0, i: 0, j: -1, f: 0, age: 0, held: false });

/**
 * Valeur de la mesure `k` pour un échantillon : interpolée entre les deux points quand ils la portent tous deux,
 * sinon celle du point d'avant, `undefined` s'il ne l'a pas. `discrete` : pas d'interpolation (statut, indicateur).
 */
export function measure(chunk: DecodedChunk, s: Sample, k: number, discrete = false): number | undefined {
  const bit = 1 << k;
  if (!(chunk.mask[s.i]! & bit)) return undefined;
  const a = chunk.cols[k]![s.i]!;
  if (discrete || s.j < 0 || !(chunk.mask[s.j]! & bit)) return a;
  return a + (chunk.cols[k]![s.j]! - a) * s.f;
}

/** Comme `measure`, pour un angle en degrés : par le plus court chemin autour du cercle. */
export function measureAngle(chunk: DecodedChunk, s: Sample, k: number, scale = 1): number | undefined {
  const bit = 1 << k;
  if (!(chunk.mask[s.i]! & bit)) return undefined;
  const a = chunk.cols[k]![s.i]! / scale;
  if (s.j < 0 || !(chunk.mask[s.j]! & bit)) return a;
  const b = chunk.cols[k]![s.j]! / scale;
  const delta = ((b - a + 540) % 360) - 180;
  return (a + delta * s.f + 360) % 360;
}

// ───────────────────────── Cache et chargement ─────────────────────────

interface Slot {
  chunk: DecodedChunk | null;
  /** Instant (ms) où le tronçon a été reçu. */
  at: number;
  promise?: Promise<DecodedChunk | null>;
}

const slots = new Map<string, Slot>();
const MAX_SLOTS_PER_LAYER = 4;
/** Un tronçon encore ouvert grossit : on ne s'en fie pas au-delà de ce délai. */
const OPEN_CHUNK_TTL_MS = 20_000;

export const chunkStart = (time: number): number => Math.floor(time / 1000 / CHUNK_S) * CHUNK_S;

async function fetchChunk(layer: ReplayLayerId, start: number): Promise<DecodedChunk | null> {
  const response = await fetch(`/api/historique/${layer}/${start}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`le serveur de l’historique a répondu ${response.status}`);
  // Le navigateur a déjà défait le gzip (Content-Encoding) : on reçoit le format du tronçon.
  return decodeChunk(await response.arrayBuffer());
}

function evict(layer: ReplayLayerId, keep: string): void {
  const mine = [...slots.entries()].filter(([key]) => key.startsWith(`${layer}/`));
  if (mine.length <= MAX_SLOTS_PER_LAYER) return;
  mine
    .filter(([key, slot]) => key !== keep && !slot.promise)
    .sort((a, b) => a[1].at - b[1].at)
    .slice(0, mine.length - MAX_SLOTS_PER_LAYER)
    .forEach(([key]) => slots.delete(key));
}

/** Le tronçon qui commence à `start` : du cache s'il y est (et s'il est fermé ou récent), sinon du serveur. `null` : pas d'enregistrement. */
export function getChunk(layer: ReplayLayerId, start: number): Promise<DecodedChunk | null> {
  const key = `${layer}/${start}`;
  const slot = slots.get(key);
  if (slot) {
    if (slot.promise) return slot.promise;
    const fresh = slot.chunk ? slot.chunk.closed || Date.now() - slot.at < OPEN_CHUNK_TTL_MS : Date.now() - slot.at < OPEN_CHUNK_TTL_MS;
    if (fresh) return Promise.resolve(slot.chunk);
  }
  const promise = fetchChunk(layer, start)
    .then((chunk) => {
      slots.set(key, { chunk, at: Date.now() });
      evict(layer, key);
      return chunk;
    })
    .catch((error: unknown) => {
      // On garde l'ancienne version s'il y en a une : mieux vaut un tronçon un peu vieux que rien.
      if (slot) slots.set(key, { chunk: slot.chunk, at: slot.at });
      else slots.delete(key);
      throw error;
    });
  slots.set(key, { chunk: slot?.chunk ?? null, at: slot?.at ?? 0, promise });
  return promise;
}

/** Tronçon déjà en mémoire (sans réseau). */
export function cachedChunk(layer: ReplayLayerId, start: number): DecodedChunk | null {
  return slots.get(`${layer}/${start}`)?.chunk ?? null;
}

/** Zone du tronçon, à ses deux bords, où l'on commence à charger le voisin. */
const PREFETCH_EDGE_S = 180;

/** Charge d'avance le tronçon voisin quand `time` approche d'un bord : le défilement reste fluide, et rien n'est redemandé. */
export function prefetchNear(layer: ReplayLayerId, time: number): void {
  const start = chunkStart(time);
  const inChunk = time / 1000 - start;
  const wanted: number[] = [];
  if (inChunk > CHUNK_S - PREFETCH_EDGE_S) wanted.push(start + CHUNK_S);
  if (inChunk < PREFETCH_EDGE_S) wanted.push(start - CHUNK_S);
  for (const s of wanted) {
    if (slots.has(`${layer}/${s}`)) continue;
    if (coverageAt(layer, s * 1000 + (CHUNK_S * 1000) / 2).kind !== 'ok') continue;
    void getChunk(layer, s).catch(() => undefined);
  }
}

/**
 * Ce qu'une couche reçoit pour l'instant `time` : le tronçon (ou `null`, avec la raison), et une clé qui change
 * quand il faut recharger (autre tronçon, ou passage d'un trou à une plage couverte).
 */
export interface ReplayState {
  key: string;
  chunk: DecodedChunk | null;
  /** Pourquoi il n'y a rien à montrer, le cas échéant (phrase prête à afficher). */
  absence: string | null;
}

export function replayKey(layer: ReplayLayerId, time: number): string {
  return `${chunkStart(time)}:${coverageAt(layer, time).kind}`;
}

export async function loadReplay(layer: ReplayLayerId, time: number): Promise<ReplayState> {
  // La disponibilité décide s'il y a quelque chose à demander : on n'interroge pas le serveur sur un trou.
  if (!availability || Date.now() - availabilityAt > AVAILABILITY_EVERY_MS) await loadAvailability();
  const key = replayKey(layer, time);
  const absence = noRecordingText(layer, time);
  if (absence) return { key, chunk: null, absence };
  const chunk = await getChunk(layer, chunkStart(time));
  return { key, chunk, absence: chunk ? null : 'Pas d’enregistrement à cet instant' };
}
