/**
 * Le réseau ferré tel que l'envoie le serveur (`/api/reseau/{version}`, voir
 * server/src/network.rs) : toutes les gares, et les tracés sur les voies entre elles.
 *
 * Il ne change qu'avec les horaires (une fois par jour) : il est téléchargé une fois
 * par version (et gardé en cache par le navigateur), puis partagé par les couches
 * « Trains » et « Voies ferrées ». Les tracés sont décodés à leur première utilisation.
 */

export interface ApiStation {
  /** Code UIC de la gare, stable d'un chargement à l'autre (l'indice, lui, change). */
  code?: string;
  name: string;
  lon: number;
  lat: number;
}

/** Réponse de `/api/reseau/{version}`. */
interface ApiNetwork {
  stations: ApiStation[];
  /** Tracés au format « polyline » étendu (latitude, longitude, altitude, vitesse maximale). */
  tracks: string[];
  /** Les deux gares (indices dans `stations`) reliées par chaque tracé, dans son sens d'écriture. */
  ends: Array<[number, number]>;
}

/** Un tracé décodé : longitude, latitude, ordonnée Mercator, altitude, distance cumulée. */
export interface Track {
  lon: Float64Array;
  lat: Float64Array;
  my: Float64Array;
  /** Altitude du rail en mètres (sans exagération du relief). */
  z: Float32Array;
  /** Distance depuis le début du tracé, en mètres. */
  along: Float64Array;
  /** Vitesse maximale (km/h, 0 : inconnue) de la portion qui part de chaque point. */
  limit: Float32Array;
}

export interface RailNetwork {
  version: string;
  stations: ApiStation[];
  ends: Array<[number, number]>;
  /** Nombre de tracés (voir `trackAt`). */
  trackCount: number;
  /** Tracés codés, et décodés au fur et à mesure. */
  encoded: string[];
  decoded: (Track | undefined)[];
}

export const DEG = Math.PI / 180;

export function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
}

export function latitudeFromMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

/** Décode un tracé « polyline » étendu à l'altitude et à la vitesse maximale (voir server/src/network.rs). */
export function decodeTrack(encoded: string): Track {
  const values: number[] = [];
  let index = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    values.push(result & 1 ? ~(result >> 1) : result >> 1);
  }
  const count = Math.floor(values.length / 4);
  const track: Track = {
    lon: new Float64Array(count),
    lat: new Float64Array(count),
    my: new Float64Array(count),
    z: new Float32Array(count),
    along: new Float64Array(count),
    limit: new Float32Array(count),
  };
  let lat = 0;
  let lon = 0;
  let z = 0;
  let limit = 0;
  for (let i = 0; i < count; i++) {
    lat += values[i * 4]!;
    lon += values[i * 4 + 1]!;
    z += values[i * 4 + 2]!;
    limit += values[i * 4 + 3]!;
    track.limit[i] = limit;
    track.lat[i] = lat / 1e5;
    track.lon[i] = lon / 1e5;
    track.my[i] = mercatorY(lat / 1e5);
    track.z[i] = z;
    if (i > 0) {
      const dx = (track.lon[i]! - track.lon[i - 1]!) * Math.cos(track.lat[i]! * DEG) * 111_320;
      const dy = (track.lat[i]! - track.lat[i - 1]!) * 110_540;
      track.along[i] = track.along[i - 1]! + Math.hypot(dx, dy);
    }
  }
  return track;
}

/** Erreur HTTP du serveur, avec son code (pour distinguer une version périmée). */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('serveur injoignable (lancer « cargo run » dans server/)');
  }
  if (!response.ok) throw new ServerError(`le serveur a répondu ${response.status}`, response.status);
  return (await response.json()) as T;
}

let current: RailNetwork | undefined;
let pending: { version: string; promise: Promise<RailNetwork> } | undefined;

/**
 * Le réseau de cette version (celle de la réponse des trains), ou de la version
 * actuelle du serveur si elle n'est pas précisée. Deux couches qui le demandent en
 * même temps partagent le même téléchargement.
 */
export async function loadNetwork(version: string | null, signal: AbortSignal): Promise<RailNetwork> {
  const wanted = version ?? (await fetchJson<{ version: string }>('/api/reseau', signal)).version;
  if (current?.version === wanted) return current;
  if (pending?.version !== wanted) {
    // Version immuable : le navigateur la garde en cache, même d'une visite à l'autre.
    const promise = fetchJson<ApiNetwork>(`/api/reseau/${wanted}`, new AbortController().signal).then((api) => {
      current = {
        version: wanted,
        stations: api.stations,
        ends: api.ends ?? [],
        trackCount: api.tracks.length,
        encoded: api.tracks,
        decoded: [],
      };
      return current;
    });
    pending = { version: wanted, promise };
    promise.catch(() => {
      if (pending?.promise === promise) pending = undefined;
    });
  }
  // Le téléchargement partagé n'est pas interrompu si une couche abandonne : l'autre peut en avoir besoin.
  const shared = pending!.promise;
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    shared.then(resolve, reject);
  });
}

/** Tracé d'indice `index` (à partir de 0). */
export function trackAt(net: RailNetwork, index: number): Track | undefined {
  const encoded = net.encoded[index];
  if (encoded === undefined) return undefined;
  return (net.decoded[index] ??= decodeTrack(encoded));
}

/** Tracé désigné par une référence de train (k > 0 : tracé k-1, k < 0 : tracé -k-1 à l'envers, 0 : aucun), sans le sens. */
export function trackOf(net: RailNetwork, ref: number): Track | undefined {
  return ref === 0 ? undefined : trackAt(net, Math.abs(ref) - 1);
}
