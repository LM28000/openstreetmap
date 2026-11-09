/**
 * Contrat d'un module de couche.
 *
 * Un module = une source de données + sa fréquence de rafraîchissement + son
 * affichage + sa fiche d'info au clic. Ajouter une couche à la carte, c'est
 * écrire un module et l'ajouter à `src/modules/index.ts` : rien d'autre à toucher.
 *
 * Règle d'or : l'affichage est une fonction de (données, instant t). Un module ne
 * garde pas d'état « courant » ; il répond à « quel est ton état à l'instant t ? ».
 * C'est ce qui rend le replay et la frise temporelle possibles.
 */
import type { LayersList } from '@deck.gl/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

export type Category = 'transport' | 'environnement' | 'energie' | 'territoire' | 'ciel' | 'histoire';

export const CATEGORY_ORDER: readonly Category[] = [
  'transport',
  'environnement',
  'energie',
  'territoire',
  'ciel',
  'histoire',
];

export const CATEGORY_LABELS: Record<Category, string> = {
  transport: 'Transports',
  environnement: 'Environnement',
  energie: 'Énergie',
  territoire: 'Territoire',
  ciel: 'Ciel et espace',
  histoire: 'Histoire',
};

export interface RenderContext<TData> {
  /** Données renvoyées par `load()`, ou `undefined` tant qu'elles ne sont pas arrivées. */
  data: TData | undefined;
  /** Instant simulé, en millisecondes depuis 1970 (UTC). */
  time: number;
  /** Altitude du relief, pour poser les objets dessus (modules avec `followsTerrain`). */
  terrain: TerrainSampler;
  /** Valeur choisie pour chaque réglage du module (voir `settings`). */
  settings: Readonly<Record<string, string>>;
}

export interface LoadContext {
  signal: AbortSignal;
  /** Instant simulé au moment du chargement : pour ne charger que la période utile. */
  time: number;
}

/** Un réglage proposé dans le panneau des couches, sous forme de choix exclusifs. */
export interface ModuleSetting {
  id: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  defaultValue: string;
}

export interface LegendItem {
  /** Couleur CSS du symbole. */
  color: string;
  label: string;
  /** Taille relative du symbole, quand la taille porte aussi l'information. */
  size?: 'small' | 'medium' | 'large';
  /** Image du symbole (adresse ou data URL), à la place de la pastille de couleur. */
  icon?: string;
}

export interface TerrainSampler {
  /** Altitude affichée du relief en mètres (exagération comprise), 0 si le relief est désactivé. */
  elevation(lon: number, lat: number): number;
  /** Exagération du relief affiché (0 quand le relief est désactivé). */
  exaggeration: number;
  /**
   * Change à chaque arrivée de tuiles de relief ou activation du relief.
   * À mettre dans les `updateTriggers` de `getPosition` des couches deck.gl.
   */
  version: number;
}

/** Contenu de la fiche affichée quand on clique sur un objet. */
export interface InfoContent {
  title: string;
  subtitle?: string;
  fields?: Array<[label: string, value: string]>;
  link?: { href: string; label: string };
}

/**
 * Couches MapLibre natives, pour ce que deck.gl ne sait pas bien faire :
 * images drapées sur le relief (nuit, radar de pluie, photos anciennes…).
 */
export interface NativeLayers<TData> {
  /** Ajoute sources et couches à la carte. Appelé à l'activation du module. */
  add(map: MapLibreMap): void;
  /** Met la couche à jour pour l'instant t (à chaque pas de temps ou nouvelle donnée). */
  update?(map: MapLibreMap, ctx: RenderContext<TData>): void;
  /** Retire sources et couches. Appelé quand on masque le module. */
  remove(map: MapLibreMap): void;
}

export interface LayerModule<TData = unknown> {
  /** Identifiant unique, aussi utilisé comme préfixe des identifiants de couches. */
  id: string;
  name: string;
  category: Category;
  description: string;
  /** Crédit de la source de données (obligatoire : chaque source a sa licence). */
  attribution: string;
  visibleByDefault?: boolean;

  /** Charge ou calcule les données. Appelé à l'activation, puis toutes les `refreshIntervalMs`. */
  load?(ctx: LoadContext): Promise<TData>;
  /** Absent = données chargées une seule fois. */
  refreshIntervalMs?: number;
  /**
   * Faut-il recharger pour afficher l'instant t ? Par exemple quand t sort de la
   * période chargée, après un saut dans le temps.
   */
  needsReload?(data: TData, time: number): boolean;

  /** Réglages proposés à l'utilisateur (ex. mode de couleur). */
  settings?: readonly ModuleSetting[];
  /** Légende affichée sous la couche quand elle est visible. */
  legend?(settings: Readonly<Record<string, string>>): LegendItem[];
  /** Résumé court affiché sous la couche, recalculé chaque seconde (ex. « 812 trains en circulation »). */
  summary?(ctx: RenderContext<TData>): string | null;

  /**
   * Granularité de l'affichage, en millisecondes de temps simulé.
   * - `0` : couche animée, redessinée à chaque image.
   * - sinon : redessinée seulement quand t change de « case »
   *   (par exemple 60 000 = une fois par minute simulée).
   */
  timeStepMs: number;
  /**
   * Vrai si les objets sont posés sur le relief (via `ctx.terrain`) : le module est
   * alors redessiné quand des tuiles de relief plus précises arrivent.
   */
  followsTerrain?: boolean;
  /**
   * Vrai si l'affichage dépend de la zone regardée : le module est alors redessiné
   * après chaque déplacement de la carte.
   */
  followsView?: boolean;

  /** Couches deck.gl (objets animés, points cliquables…) pour l'instant t. */
  deckLayers?(ctx: RenderContext<TData>): LayersList;
  /** Couches MapLibre natives. */
  native?: NativeLayers<TData>;
  /** Fiche d'un objet cliqué. Renvoie `null` si l'objet n'a rien à montrer. */
  describe?(object: unknown): InfoContent | null;
}

/** Aide au typage : `defineModule<MesDonnées>({ ... })`. */
export function defineModule<TData>(module: LayerModule<TData>): LayerModule<TData> {
  return module;
}
