/**
 * Tuiles vectorielles préparées par le serveur (voir `server/src/tiles/mod.rs`) : de quoi brancher un jeu de
 * données sur la carte sans rien savoir du format d'archive.
 *
 * Le serveur publie, pour chaque jeu, une fiche `/api/tuiles/<jeu>` (version, zooms, emprise, crédit, plages de
 * valeurs pour les légendes) et ses tuiles à `/api/tuiles/<jeu>/<version>/{z}/{x}/{y}`. La version est dans
 * l'adresse : une tuile ne change jamais (cache d'un an), et une nouvelle fabrication change d'adresse.
 *
 * Ajouter un jeu côté site : `loadTileSheet('<jeu>')` dans le `load()` du module, `addTileSource(map, …)` dans
 * `native.add`, puis des couches MapLibre ordinaires (`fill-extrusion`, `fill`, `circle`…) dont `source-layer`
 * est `sheet.couche`.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { fetchJson, ServerError } from '../modules/railNetwork';

/** Fiche d'un jeu de tuiles. */
export interface TileSheet<TData = unknown> {
  pret: true;
  jeu: string;
  version: string;
  /** Nom de la couche dans les tuiles (`source-layer`). */
  couche: string;
  minzoom: number;
  maxzoom: number;
  /** Ouest, sud, est, nord (degrés). */
  emprise: [number, number, number, number];
  attribution: string;
  licence: string;
  /** Propriétés présentes dans les tuiles. */
  champs: string[];
  tuiles: number;
  octets: number;
  /** Ce que le jeu publie de plus pour son affichage (plages de valeurs, totaux…). */
  donnees: TData;
}

/** Charge la fiche d'un jeu ; une erreur explicite tant que le serveur prépare encore les tuiles. */
export async function loadTileSheet<TData = unknown>(dataset: string, signal: AbortSignal): Promise<TileSheet<TData>> {
  try {
    return await fetchJson<TileSheet<TData>>(`/api/tuiles/${dataset}`, signal);
  } catch (error) {
    if (error instanceof ServerError && error.status === 503) {
      throw new Error('tuiles en préparation sur le serveur (quelques minutes au premier démarrage)');
    }
    throw error;
  }
}

/** Ajoute la source vectorielle du jeu (sans couche). L'adresse est rendue absolue : MapLibre la lit dans un worker. */
export function addTileSource(map: MapLibreMap, sourceId: string, sheet: TileSheet): void {
  const url = new URL(`/api/tuiles/${sheet.jeu}/${sheet.version}/{z}/{x}/{y}`, window.location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
  map.addSource(sourceId, {
    type: 'vector',
    tiles: [url],
    minzoom: sheet.minzoom,
    maxzoom: sheet.maxzoom,
    bounds: sheet.emprise,
    attribution: sheet.attribution,
  });
}
