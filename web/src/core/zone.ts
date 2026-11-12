/**
 * Analyse de zone : l'état de l'outil (dessin, zone, résultats) et la géométrie qui va avec.
 *
 * Le serveur (`server/src/analyse.rs`, `POST /api/analyse`) reçoit un contour et rend tout ce qu'il sait de l'intérieur.
 * Ici : la zone dessinée (un cercle ou un polygone), l'appel au serveur, et le codage de la zone dans l'adresse.
 *
 * # Deux formes, un seul contour
 *
 * Un **cercle** est défini par un centre et un rayon (en mètres) ; un **polygone** par ses sommets. Pour le serveur comme pour la
 * carte, tout devient un polygone : le cercle est approché par 96 sommets placés à la bonne distance sur la sphère (formule de
 * la « destination » : on part du centre dans une direction à une distance donnée). Avec 96 côtés, l'écart au vrai cercle est
 * de `1 - cos(π/96)` ≈ 0,05 % du rayon : sous le mètre pour 2 km.
 *
 * # Dans l'adresse
 *
 * `zone=c:2.35220,48.85660,5000` (cercle : longitude, latitude, rayon en mètres) ou `zone=p:2.3,48.8;2.4,48.8;2.4,48.9`
 * (polygone : sommets séparés par `;`), et `zscrutin=l24t2` pour le scrutin choisi dans le panneau.
 */
import { useSyncExternalStore } from 'react';

export type Position = [lon: number, lat: number];

export type ZoneShape = { kind: 'circle'; center: Position; radius: number } | { kind: 'polygon'; points: Position[] };

/** Surface maximale (km²), la même que `MAX_AREA_KM2` côté serveur : une grande région. */
export const MAX_AREA_KM2 = 100_000;
const CIRCLE_SEGMENTS = 96;
const EARTH_RADIUS_M = 6_371_008.8;
const MIN_RADIUS_M = 100;

// ---------------------------------------------------------------------------------------------
// Géométrie sur la sphère
// ---------------------------------------------------------------------------------------------

const rad = (degrees: number) => (degrees * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

/** Distance à vol d'oiseau (mètres) entre deux positions : formule de haversine. */
export function distanceM(a: Position, b: Position): number {
  const h = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[0] - a[0]) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Le point à `distance` mètres de `from`, dans la direction `bearing` (radians depuis le nord). */
function destination(from: Position, distance: number, bearing: number): Position {
  const angular = distance / EARTH_RADIUS_M;
  const [lon, lat] = [rad(from[0]), rad(from[1])];
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(angular) + Math.cos(lat) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat), Math.cos(angular) - Math.sin(lat) * Math.sin(lat2));
  return [deg(lon2), deg(lat2)];
}

/** Les sommets (anneau ouvert) d'une zone : le polygone lui-même, ou le cercle approché. */
export function shapeRing(shape: ZoneShape): Position[] {
  if (shape.kind === 'polygon') return shape.points;
  return Array.from({ length: CIRCLE_SEGMENTS }, (_, i) => destination(shape.center, shape.radius, (2 * Math.PI * i) / CIRCLE_SEGMENTS));
}

/** Surface (km²) d'un anneau sur la sphère (formule de Chamberlain-Duquette : somme de trapèzes en longitude). */
export function ringAreaKm2(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [a, b] = [ring[i]!, ring[(i + 1) % ring.length]!];
    sum += rad(b[0] - a[0]) * (2 + Math.sin(rad(a[1])) + Math.sin(rad(b[1])));
  }
  return (Math.abs(sum) * EARTH_RADIUS_M ** 2) / 2 / 1e6;
}

export const shapeAreaKm2 = (shape: ZoneShape) => (shape.kind === 'circle' ? (Math.PI * shape.radius ** 2) / 1e6 : ringAreaKm2(shape.points));

/** Rayon (mètres) du plus grand cercle permis. */
export const MAX_RADIUS_M = Math.sqrt((MAX_AREA_KM2 * 1e6) / Math.PI);

export const clampRadius = (radius: number) => Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, radius));

// ---------------------------------------------------------------------------------------------
// Dans l'adresse
// ---------------------------------------------------------------------------------------------

const fixed = (n: number) => n.toFixed(5);

export function encodeShape(shape: ZoneShape): string {
  if (shape.kind === 'circle') return `c:${fixed(shape.center[0])},${fixed(shape.center[1])},${Math.round(shape.radius)}`;
  return `p:${shape.points.map((p) => `${fixed(p[0])},${fixed(p[1])}`).join(';')}`;
}

export function decodeShape(text: string): ZoneShape | null {
  const kind = text.slice(0, 2);
  const numbers = (part: string) => part.split(',').map(Number);
  if (kind === 'c:') {
    const [lon, lat, radius] = numbers(text.slice(2));
    if ([lon, lat, radius].some((n) => !Number.isFinite(n)) || radius! <= 0) return null;
    return { kind: 'circle', center: [lon!, lat!], radius: clampRadius(radius!) };
  }
  if (kind === 'p:') {
    const points = text
      .slice(2)
      .split(';')
      .map((pair) => numbers(pair) as Position);
    if (points.length < 3 || points.length > 400 || points.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)))) return null;
    return { kind: 'polygon', points };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Les résultats du serveur (voir `analyse.rs`)
// ---------------------------------------------------------------------------------------------

/** Une section absente ou en échec : `null` (non demandée) ou `{ erreur }`. */
export interface SectionError {
  erreur: string;
}

export interface ZoneAnalysis {
  zone: { surfaceKm2: number; centre: Position; sommets: number };
  population: (PopulationSection & Partial<SectionError>) | SectionError;
  immobilier: (HousingSection & Partial<SectionError>) | SectionError;
  mobile: (MobileSection & Partial<SectionError>) | SectionError;
  elections: (ElectionSection & Partial<SectionError>) | SectionError | null;
  accidents: (AccidentSection & Partial<SectionError>) | SectionError;
  monuments: ({ total: number; classes: number; inscrits: number } & Partial<SectionError>) | SectionError;
  gares: StationSection;
  dureeMs: number;
  dureesMs: Record<string, number>;
}

export interface PopulationSection {
  zoom: number;
  tailleCarreau: number;
  carreaux: number;
  habitants: number;
  menages: number;
  densite: number;
  niveauDeVie: number;
  partPauvres: number;
  part65: number;
  partImputes: number;
  millesime: string;
}

export interface SalesGroup {
  ventes: number;
  mediane: number;
  q1: number;
  q3: number;
}

export interface HousingSection {
  methode: 'ventes' | 'carreaux';
  zoom: number;
  tailleCarreau: number;
  appartements: SalesGroup;
  maisons: SalesGroup;
  appartements12mois: SalesGroup;
  maisons12mois: SalesGroup;
  moisReference: string;
  debut5ans: string;
}

export interface MobileSection {
  zoom: number;
  tailleCarreau: number;
  exact: boolean;
  surface: { sans: number; un: number | null; deuxEtPlus: number | null };
  operateursMoyen: number;
  habitants: { sans: number; un: number; deuxEtPlus: number; total: number; partSans: number; partUn: number; partDeuxEtPlus: number };
  trimestre: string;
}

export interface ElectionSection {
  scrutin: string;
  zoom: number;
  niveau: string;
  objets: number;
  inscrits: number;
  votants: number;
  exprimes: number;
  voix: number[];
}

export interface AccidentSection {
  annees: number[];
  accidents: number;
  accidentsMortels: number;
  tues: number;
  hospitalises: number;
  blessesLegers: number;
  indemnes: number;
  parAnnee: Array<{ annee: number; accidents: number; tues: number }>;
}

export interface StationSection {
  dans: number;
  liste: Array<{ nom: string; lon: number; lat: number }>;
  plusProche: { nom: string; distanceKm: number; lon: number; lat: number; dedans: boolean } | null;
}

/** Vrai si la section est une vraie réponse (ni absente, ni en erreur). */
export function ok<T extends object>(section: T | SectionError | null | undefined): section is T {
  return !!section && !('erreur' in section && section.erreur);
}

// ---------------------------------------------------------------------------------------------
// L'état de l'outil
// ---------------------------------------------------------------------------------------------

export type DrawMode = 'off' | 'circle' | 'polygon';

export interface ZoneState {
  /** Ce qu'on dessine : `off` quand on ne dessine pas. */
  mode: DrawMode;
  /** Le dessin en cours (cercle en train d'être tiré, sommets déjà posés). */
  draft: ZoneShape | null;
  /** La zone dessinée. */
  shape: ZoneShape | null;
  /** Le scrutin du panneau (identifiant côté site : `l24t2`…). */
  scrutin: string;
  analysis: { status: 'idle' | 'loading' | 'ok' | 'error'; data?: ZoneAnalysis; error?: string };
  /** Le panneau est-il affiché (faux quand une fiche d'objet prend la place) ? */
  panelOpen: boolean;
}

const DEFAULT_SCRUTIN = 'l24t2';

class ZoneStore {
  private state: ZoneState = { mode: 'off', draft: null, shape: null, scrutin: DEFAULT_SCRUTIN, analysis: { status: 'idle' }, panelOpen: true };
  private listeners = new Set<() => void>();
  private abort: AbortController | undefined;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ZoneState => this.state;

  private set(patch: Partial<ZoneState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Commence (ou arrête, si on y est déjà) le dessin d'un cercle ou d'un polygone. */
  startDrawing(mode: 'circle' | 'polygon'): void {
    this.set({ mode, draft: null });
  }

  cancelDrawing(): void {
    this.set({ mode: 'off', draft: null });
  }

  setDraft(draft: ZoneShape | null): void {
    this.set({ draft });
  }

  /** La zone est dessinée : on la garde et on l'analyse. */
  commit(shape: ZoneShape): void {
    this.set({ mode: 'off', draft: null, shape, panelOpen: true });
    void this.analyse();
  }

  /** Applique une zone lue dans l'adresse. */
  restore(shape: ZoneShape, scrutin?: string): void {
    if (scrutin) this.state = { ...this.state, scrutin };
    this.commit(shape);
  }

  clear(): void {
    this.abort?.abort();
    this.set({ mode: 'off', draft: null, shape: null, analysis: { status: 'idle' } });
  }

  setScrutin(scrutin: string): void {
    if (scrutin === this.state.scrutin) return;
    this.set({ scrutin });
    void this.analyse();
  }

  setPanelOpen(panelOpen: boolean): void {
    if (panelOpen !== this.state.panelOpen) this.set({ panelOpen });
  }

  /** Demande l'analyse de la zone au serveur (la précédente, encore en cours, est abandonnée). */
  async analyse(): Promise<void> {
    const shape = this.state.shape;
    if (!shape) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.set({ analysis: { status: 'loading', data: this.state.analysis.data } });
    const ring = shapeRing(shape).map((p): Position => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);
    try {
      const response = await fetch('/api/analyse', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ zone: { type: 'Polygon', coordinates: [[...ring, ring[0]]] }, scrutin: `elec-${this.state.scrutin}` }),
        signal: abort.signal,
      });
      if (!response.ok) throw new Error((await response.text()).trim() || `erreur ${response.status}`);
      const data = (await response.json()) as ZoneAnalysis;
      if (!abort.signal.aborted) this.set({ analysis: { status: 'ok', data } });
    } catch (error) {
      if (abort.signal.aborted) return;
      this.set({ analysis: { status: 'error', error: error instanceof Error ? error.message : String(error) } });
    }
  }
}

export const zoneStore = new ZoneStore();

export function useZone(): ZoneState {
  return useSyncExternalStore(zoneStore.subscribe, zoneStore.getSnapshot);
}

/** La zone et le scrutin dans l'adresse (voir `shareState.ts`). */
export const zoneUrl = {
  read(): { zone: string; scrutin: string } | null {
    const { shape, scrutin } = zoneStore.getSnapshot();
    return shape ? { zone: encodeShape(shape), scrutin } : null;
  },
  write(zone: string, scrutin: string | null): void {
    const shape = decodeShape(zone);
    if (shape) zoneStore.restore(shape, scrutin ?? undefined);
  },
};
