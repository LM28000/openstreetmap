/**
 * Lieux : géocodage de la Géoplateforme de l'IGN (successeur de l'API Adresse).
 *
 * - Adresse : https://data.geopf.fr/geocodage/search, sans clé, `Access-Control-Allow-Origin: *`
 *   (appel direct depuis le navigateur, aucun serveur à modifier). Limite annoncée : 50 requêtes
 *   par seconde et par adresse IP ; la recherche en envoie une toutes les 200 ms au plus.
 * - `index=address,poi` : communes, rues et numéros (base adresse nationale) mêlés aux lieux
 *   nommés de l'IGN (quartiers, gares, monuments, lieux-dits).
 * - L'ancienne adresse (api-adresse.data.gouv.fr) répond encore mais renvoie « deprecated »
 *   et sera arrêtée : on ne s'en sert pas.
 */
import { Marker } from 'maplibre-gl';
import { clock } from '../core/clock';
import type { ModuleManager } from '../core/moduleManager';
import { formatDateTime } from '../ui/format';
import { goTo, mapOf } from './access';
import { fold } from './normalize';
import type { SearchResult } from './types';

const ENDPOINT = 'https://data.geopf.fr/geocodage/search';
const LIMIT = 7;
/** Au-delà, deux lieux de même nom ne sont plus le même lieu. */
const SAME_PLACE_KM = 8;

interface GeoFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    _type: 'address' | 'poi';
    score?: number;
    // adresses
    label?: string;
    name?: string | string[];
    type?: 'housenumber' | 'street' | 'locality' | 'municipality';
    postcode?: string | string[];
    city?: string | string[];
    context?: string;
    district?: string;
    // lieux nommés
    toponym?: string;
    category?: string[];
    classification?: number;
  };
}

export interface PlaceResult extends SearchResult {
  lon: number;
  lat: number;
  zoom: number;
}

const cache = new Map<string, PlaceResult[]>();
const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Cherche des lieux. Rejette si la requête est annulée (`signal`) ou si le service est injoignable. */
export async function searchPlaces(text: string, manager: ModuleManager, signal: AbortSignal): Promise<PlaceResult[]> {
  const key = fold(text);
  const cached = cache.get(key);
  if (cached) return cached.map((r) => bind(r, manager));

  const url = `${ENDPOINT}?${new URLSearchParams({ q: text, limit: String(LIMIT), index: 'address,poi' })}`;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Géocodage : HTTP ${response.status}`);
  const json = (await response.json()) as { features?: GeoFeature[] };

  const places: PlaceResult[] = [];
  (json.features ?? []).forEach((feature, index) => {
    const place = toPlace(feature, index, manager);
    if (!place) return;
    // Une commune ressort deux fois (base adresse et lieux nommés) : on garde la mieux classée.
    const twin = places.some((p) => fold(p.title) === fold(place.title) && distanceKm(p, place) < SAME_PLACE_KM);
    if (!twin) places.push(place);
  });
  if (cache.size > 40) cache.delete(cache.keys().next().value as string);
  cache.set(key, places);
  return places;
}

/** Le même résultat, relié au gestionnaire courant (le cache est partagé entre recherches). */
function bind(place: PlaceResult, manager: ModuleManager): PlaceResult {
  return { ...place, run: () => showPlace(manager, place, place.zoom) };
}

function toPlace(feature: GeoFeature, index: number, manager: ModuleManager): PlaceResult | null {
  const p = feature.properties;
  const [lon, lat] = feature.geometry.coordinates;
  let title: string;
  let subtitle: string;
  let zoom: number;
  let bonus = 0;

  if (p._type === 'poi') {
    title = p.toponym ?? first(p.name) ?? '';
    const kind = p.category?.[0] ?? 'Lieu';
    const where = first(p.city);
    const isTown = p.category?.includes('commune') ?? false;
    subtitle = [capitalize(isTown ? 'commune' : kind), where && where !== title ? where : undefined].filter(Boolean).join(' · ');
    zoom = isTown ? 11 : p.category?.includes('transport') ? 15 : 14;
    if (isTown) bonus = 60; // « Lyon » : la ville, avant ses rues et ses arrêts
  } else if (p.type === 'municipality') {
    title = first(p.name) ?? p.label ?? '';
    subtitle = `Commune · ${p.context ?? ''}`.replace(/ · $/, '');
    zoom = 11;
    bonus = 60;
  } else if (p.type === 'locality') {
    title = first(p.name) ?? p.label ?? '';
    subtitle = `Lieu-dit · ${[first(p.postcode), first(p.city)].filter(Boolean).join(' ')}`;
    zoom = 14;
  } else {
    // rue ou numéro
    title = first(p.name) ?? p.label ?? '';
    subtitle = `${p.type === 'housenumber' ? 'Adresse' : 'Rue'} · ${[first(p.postcode), first(p.city)].filter(Boolean).join(' ')}`;
    zoom = p.type === 'housenumber' ? 17 : 16;
  }
  if (!title) return null;

  const place: PlaceResult = {
    key: `lieu:${title}:${lon.toFixed(4)}:${lat.toFixed(4)}`,
    kind: 'lieu',
    title,
    subtitle,
    // Le score du service va de 0 à 1 ; l'ordre d'arrivée départage les ex æquo.
    score: 150 + (p.score ?? 0.5) * 150 - index * 3 + bonus,
    lon,
    lat,
    zoom,
    run: () => undefined,
  };
  return bind(place, manager);
}

let pin: Marker | undefined;
let pinTimer: ReturnType<typeof setTimeout> | undefined;

/** Centre la carte sur un lieu et y pose un repère qui s'efface seul. */
export function showPlace(manager: ModuleManager, place: { lon: number; lat: number; title: string }, zoom: number): void {
  manager.setSelection(null, null);
  goTo(manager, place.lon, place.lat, zoom);
  const map = mapOf(manager);
  if (!map) return;
  pin?.remove();
  clearTimeout(pinTimer);
  const element = document.createElement('div');
  element.className = 'search-pin';
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', place.title);
  pin = new Marker({ element }).setLngLat([place.lon, place.lat]).addTo(map);
  pinTimer = setTimeout(() => pin?.remove(), 12_000);
}

/** « Revoir Lyon hier à la même heure » : le lieu, et l'horloge un jour en arrière. */
export function replayResult(manager: ModuleManager, place: PlaceResult): SearchResult {
  const at = Date.now() - 24 * 3_600_000;
  return {
    key: `revoir:${place.key}`,
    kind: 'action',
    title: `Revoir ${place.title} hier à la même heure`,
    subtitle: formatDateTime(at),
    score: place.score - 20,
    run: () => {
      clock.seek(at);
      showPlace(manager, place, place.zoom);
    },
  };
}

function distanceKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dx = (a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, a.lat - b.lat) * 111;
}
