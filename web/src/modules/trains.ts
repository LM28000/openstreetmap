/**
 * Module « Trains » : les TGV, Intercités et TER de France à leur position à
 * l'instant t, avec leurs retards en temps réel.
 *
 * Le serveur (dossier `server/`) envoie, pour une période de quelques heures, les
 * trains avec leurs arrêts et leurs horaires prévus et réels. Le navigateur calcule
 * lui-même la position de chaque train à chaque image, par interpolation entre
 * deux gares : aucun échange réseau pendant l'animation, et le replay fonctionne
 * comme le direct.
 *
 * Chaque train est dessiné vu de dessus, orienté dans son sens de marche, à plat
 * sur la carte. Sa traînée montre le chemin parcouru dans le quart d'heure écoulé.
 *
 * Limite actuelle : un train va en ligne droite d'une gare à la suivante.
 * Le recalage sur les vraies voies (OpenStreetMap) est la prochaine étape.
 */
import type { Color } from '@deck.gl/core';
import { TripsLayer } from '@deck.gl/geo-layers';
import { IconLayer } from '@deck.gl/layers';
import { defineModule, type TerrainSampler } from '../core/module';
import { formatTime } from '../ui/format';
import { buildTrainAtlas, type Nose, type TrainAtlas, type TrainIconSpec } from './trainIcons';

// --- Réponse de l'API (voir server/src/api.rs) ---

interface ApiStation {
  name: string;
  lon: number;
  lat: number;
}

interface ApiTrain {
  id: string;
  number: string;
  category: string;
  line: string;
  stations: number[];
  arr: number[];
  dep: number[];
  arrRt?: number[];
  depRt?: number[];
  skipped?: number[];
  canceled: boolean;
}

interface ApiResponse {
  from: number;
  to: number;
  realtime: { feedTimestamp: number; fetchedAt: number } | null;
  stations: ApiStation[];
  trains: ApiTrain[];
}

// --- Modèle côté navigateur ---

interface Station {
  name: string;
  lon: number;
  lat: number;
  /** Altitude du relief sous la gare, mise à jour quand le relief change. */
  z: number;
  /** Ordonnée Web Mercator : la carte trace les lignes droites dans cette projection. */
  my: number;
}

type Family = 'ter' | 'grande-vitesse' | 'intercites';
type DelayClass = 'inconnu' | 'heure' | 'retard' | 'gros-retard';

interface Train {
  id: string;
  number: string;
  category: string;
  family: Family;
  line: string;
  /** Arrêts desservis, dans l'ordre. */
  stops: Station[];
  /** Horaires retenus : réels si connus, sinon prévus (secondes UTC). */
  arr: number[];
  dep: number[];
  plannedArr: number[];
  plannedDep: number[];
  realtime: boolean;
  skippedCount: number;
  /** Traînée : une gare par sommet, avec son horodatage (secondes depuis `TrainsData.base`). */
  pathStops: Station[];
  timestamps: number[];
  path: [number, number, number][];
  /** Position courante, réutilisée d'une image à l'autre. */
  head: Head;
}

interface Head {
  train: Train;
  position: [number, number, number];
  /** Cap, en degrés dans le sens inverse des aiguilles d'une montre depuis l'est (convention deck.gl). */
  angle: number;
  /** Retard en secondes à cet instant, `null` sans temps réel. */
  delay: number | null;
  delayClass: DelayClass;
  /** Indice de l'arrêt où le train est à quai, sinon `null`. */
  atStop: number | null;
  nextStop: number | null;
}

interface TrainsData {
  /** Période chargée (secondes UTC). */
  from: number;
  to: number;
  /** Origine des horodatages de la traînée : la précision des flottants GPU l'exige. */
  base: number;
  realtimeAt: number | null;
  stations: Station[];
  trains: Train[];
  canceled: number;
  terrainVersion: number;
}

// --- Apparence (couleurs vérifiées pour le daltonisme, voir README) ---

const FAMILY_OF: Record<string, Family> = {
  'TGV INOUI': 'grande-vitesse',
  OUIGO: 'grande-vitesse',
  ICE: 'grande-vitesse',
  Lyria: 'grande-vitesse',
  INTERCITES: 'intercites',
  'INTERCITES de nuit': 'intercites',
};

/** Couleur par famille ; les trains à grande vitesse ont aussi un nez profilé et sont plus longs. */
const FAMILY_STYLE: Record<Family, { color: [number, number, number]; css: string; nose: Nose; label: string }> = {
  ter: { color: [42, 120, 214], css: '#2a78d6', nose: 'standard', label: 'TER et trains régionaux' },
  'grande-vitesse': { color: [235, 104, 52], css: '#eb6834', nose: 'profile', label: 'Grande vitesse : TGV INOUI, OUIGO, ICE, Lyria' },
  intercites: { color: [27, 175, 122], css: '#1baf7a', nose: 'standard', label: 'Intercités, de jour et de nuit' },
};
const FAMILY_ORDER: Family[] = ['ter', 'grande-vitesse', 'intercites'];

/** Le retard est une grandeur ordonnée : neutre à l'heure, puis un orange de plus en plus sombre. */
const DELAY_STYLE: Record<DelayClass, { css: string; label: string }> = {
  inconnu: { css: '#8a8f9c', label: 'Sans information temps réel' },
  heure: { css: '#ffffff', label: 'À l’heure (moins de 5 min)' },
  retard: { css: '#f0913a', label: '5 à 14 min de retard' },
  'gros-retard': { css: '#a83a16', label: '15 min de retard ou plus' },
};
const DELAY_ORDER: DelayClass[] = ['heure', 'retard', 'gros-retard', 'inconnu'];

const familyIcon = (family: Family) => `famille:${family}`;
const delayIcon = (nose: Nose, delay: DelayClass) => `retard:${nose}:${delay}`;

/** L'atlas est dessiné au premier usage (il faut un document pour créer un canvas). */
let atlas: TrainAtlas | undefined;
function trainAtlas(): TrainAtlas {
  if (!atlas) {
    const specs: TrainIconSpec[] = FAMILY_ORDER.map((family) => ({
      key: familyIcon(family),
      color: FAMILY_STYLE[family].css,
      nose: FAMILY_STYLE[family].nose,
    }));
    for (const nose of ['standard', 'profile'] as const) {
      for (const delay of DELAY_ORDER) specs.push({ key: delayIcon(nose, delay), color: DELAY_STYLE[delay].css, nose });
    }
    atlas = buildTrainAtlas(specs);
  }
  return atlas;
}

/**
 * Taille des trains : hauteur de l'icône en mètres, bornée en pixels pour rester
 * visible vu de loin et ne pas envahir l'écran vu de près.
 */
const TRAIN_SIZE_M = 900;
const TRAIN_MIN_PX = 7;
const TRAIN_MAX_PX = 18;
const TRAIL_GREY: Color = [230, 233, 240, 150];
const DEG = Math.PI / 180;
/** Longueur de la traînée, en secondes de trajet. */
const TRAIL_SECONDS = 15 * 60;
/** Période chargée autour de l'instant affiché. */
const LOAD_BEFORE_S = 30 * 60;
const LOAD_AFTER_S = 3 * 3600;

const CATEGORY_NAMES: Record<string, string> = {
  'Train TER': 'TER',
  INTERCITES: 'Intercités',
  'INTERCITES de nuit': 'Intercités de nuit',
  TramTrain: 'Tram-train',
};

// --- Chargement ---

async function loadTrains(signal: AbortSignal, time: number): Promise<TrainsData> {
  const t = Math.floor(time / 1000);
  let response: Response;
  try {
    response = await fetch(`/api/trains?from=${t - LOAD_BEFORE_S}&to=${t + LOAD_AFTER_S}`, { signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error('serveur des trains injoignable (lancer « cargo run » dans server/)');
  }
  if (!response.ok) throw new Error(`le serveur des trains a répondu ${response.status}`);
  return parse((await response.json()) as ApiResponse);
}

function parse(json: ApiResponse): TrainsData {
  const stations: Station[] = json.stations.map((s) => ({ ...s, z: 0, my: mercatorY(s.lat) }));
  const trains: Train[] = [];
  let canceled = 0;

  for (const api of json.trains) {
    if (api.canceled) {
      canceled++;
      continue;
    }
    const skipped = new Set(api.skipped ?? []);
    // Un train peut partir plus loin ou terminer plus tôt que prévu : on garde les arrêts desservis aux extrémités.
    let first = 0;
    while (first < api.stations.length && skipped.has(first)) first++;
    let last = api.stations.length - 1;
    while (last > first && skipped.has(last)) last--;
    if (last <= first) continue;

    const slice = <T>(values: T[]) => values.slice(first, last + 1);
    const stops = slice(api.stations).map((i) => stations[i]);
    if (stops.some((s) => s === undefined)) continue;
    const served = stops as Station[];

    const plannedArr = slice(api.arr);
    const plannedDep = slice(api.dep);
    const arr = slice(api.arrRt ?? api.arr);
    const dep = slice(api.depRt ?? api.dep);

    // Sommets de la traînée : départ de la première gare, puis arrivée (et départ s'il y a un arrêt) à chaque gare.
    const pathStops: Station[] = [];
    const timestamps: number[] = [];
    served.forEach((station, i) => {
      const arrival = arr[i] ?? 0;
      const departure = dep[i] ?? arrival;
      if (i === 0) {
        pathStops.push(station);
        timestamps.push(departure - json.from);
        return;
      }
      pathStops.push(station);
      timestamps.push(arrival - json.from);
      if (i < served.length - 1 && departure > arrival) {
        pathStops.push(station);
        timestamps.push(departure - json.from);
      }
    });

    const train = {
      id: api.id,
      number: api.number,
      category: api.category,
      family: FAMILY_OF[api.category] ?? 'ter',
      line: api.line,
      stops: served,
      arr,
      dep,
      plannedArr,
      plannedDep,
      realtime: api.arrRt !== undefined,
      skippedCount: [...skipped].filter((i) => i > first && i < last).length,
      pathStops,
      timestamps,
      path: pathStops.map((s) => [s.lon, s.lat, s.z] as [number, number, number]),
    } as Omit<Train, 'head'> as Train;
    train.head = { train, position: [0, 0, 0], angle: 0, delay: null, delayClass: 'inconnu', atStop: null, nextStop: null };
    trains.push(train);
  }

  return {
    from: json.from,
    to: json.to,
    base: json.from,
    realtimeAt: json.realtime?.feedTimestamp ?? null,
    stations,
    trains,
    canceled,
    terrainVersion: -1,
  };
}

// --- Calculs à l'instant t ---

/** Pose gares et traînées sur le relief, une fois par version du relief. */
function refreshElevations(data: TrainsData, terrain: TerrainSampler): void {
  if (data.terrainVersion === terrain.version) return;
  for (const station of data.stations) station.z = terrain.elevation(station.lon, station.lat);
  for (const train of data.trains) train.path = train.pathStops.map((s) => [s.lon, s.lat, s.z]);
  data.terrainVersion = terrain.version;
}

function isRunning(train: Train, t: number): boolean {
  return t >= (train.dep[0] ?? Infinity) && t <= (train.arr[train.arr.length - 1] ?? -Infinity);
}

function mercatorY(lat: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
}

function latitudeFromMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

/** Cap de a vers b, tel qu'il apparaît sur la carte (Web Mercator). */
function heading(a: Station, b: Station): number {
  return Math.atan2(b.my - a.my, (b.lon - a.lon) * DEG) / DEG;
}

/**
 * Met à jour la position du train à l'instant t (secondes). Renvoie faux s'il ne roule pas.
 *
 * L'interpolation se fait en Web Mercator, comme le tracé de la traînée : la carte
 * dessine les lignes droites dans cette projection, où la latitude n'avance pas
 * régulièrement. Interpoler en latitude/longitude décalerait le train de sa traînée.
 */
function updateHead(train: Train, t: number): boolean {
  if (!isRunning(train, t)) return false;
  const { arr, dep, stops, head } = train;
  for (let i = 0; i < stops.length; i++) {
    const departure = dep[i] ?? 0;
    if (t > departure) continue;
    const arrival = arr[i] ?? departure;
    const station = stops[i]!;
    if (t >= arrival || i === 0) {
      // À quai, orienté vers la gare suivante (ou depuis la précédente au terminus).
      head.position[0] = station.lon;
      head.position[1] = station.lat;
      head.position[2] = station.z;
      const next = stops[i + 1];
      const previous = stops[i - 1];
      head.angle = next ? heading(station, next) : previous ? heading(previous, station) : head.angle;
      head.atStop = i;
      head.nextStop = i + 1 < stops.length ? i + 1 : null;
      const isLast = i === stops.length - 1;
      head.delay = train.realtime
        ? isLast
          ? arrival - (train.plannedArr[i] ?? arrival)
          : departure - (train.plannedDep[i] ?? departure)
        : null;
    } else {
      // Entre la gare précédente et celle-ci.
      const previous = stops[i - 1]!;
      const leftAt = dep[i - 1] ?? arrival;
      const f = arrival > leftAt ? (t - leftAt) / (arrival - leftAt) : 1;
      head.position[0] = previous.lon + (station.lon - previous.lon) * f;
      head.position[1] = latitudeFromMercatorY(previous.my + (station.my - previous.my) * f);
      head.position[2] = previous.z + (station.z - previous.z) * f;
      head.angle = heading(previous, station);
      head.atStop = null;
      head.nextStop = i;
      head.delay = train.realtime ? arrival - (train.plannedArr[i] ?? arrival) : null;
    }
    head.delayClass = classify(head.delay);
    return true;
  }
  return false;
}

function classify(delay: number | null): DelayClass {
  if (delay === null) return 'inconnu';
  if (delay < 5 * 60) return 'heure';
  if (delay < 15 * 60) return 'retard';
  return 'gros-retard';
}

function delayText(delay: number | null): string {
  if (delay === null) return 'pas d’information temps réel';
  const minutes = Math.round(delay / 60);
  if (minutes === 0) return 'à l’heure';
  return minutes > 0 ? `+${minutes} min` : `${-minutes} min d’avance`;
}

const hhmm = (seconds: number | undefined) => (seconds === undefined ? '?' : formatTime(seconds * 1000));
const displayCategory = (category: string) => CATEGORY_NAMES[category] ?? category;

// --- Module ---

export const trains = defineModule<TrainsData>({
  id: 'trains',
  name: 'Trains',
  category: 'transport',
  description: 'TGV, Intercités et TER en circulation, avec leurs retards en temps réel.',
  attribution: 'SNCF (horaires et temps réel, ODbL)',
  visibleByDefault: true,
  refreshIntervalMs: 60_000, // le temps réel SNCF change environ chaque minute
  timeStepMs: 0, // animé : les trains bougent à chaque image
  followsTerrain: true,

  settings: [
    {
      id: 'couleur',
      label: 'Couleur',
      options: [
        { value: 'type', label: 'Par type' },
        { value: 'retard', label: 'Par retard' },
      ],
      defaultValue: 'type',
    },
  ],

  legend(settings) {
    const icons = trainAtlas();
    return settings.couleur === 'retard'
      ? DELAY_ORDER.map((c) => ({
          color: DELAY_STYLE[c].css,
          label: DELAY_STYLE[c].label,
          icon: icons.dataUrl(delayIcon('standard', c)),
        }))
      : FAMILY_ORDER.map((f) => ({
          color: FAMILY_STYLE[f].css,
          label: FAMILY_STYLE[f].label,
          icon: icons.dataUrl(familyIcon(f)),
        }));
  },

  load: ({ signal, time }) => loadTrains(signal, time),

  needsReload(data, time) {
    const t = time / 1000;
    return t < data.from + 5 * 60 || t > data.to - 30 * 60;
  },

  summary({ data, time }) {
    if (!data) return null;
    const t = time / 1000;
    const running = data.trains.filter((train) => isRunning(train, t)).length;
    const live = data.realtimeAt ? ` · temps réel de ${hhmm(data.realtimeAt)}` : ' · horaires théoriques';
    return `${running.toLocaleString('fr-FR')} trains en circulation${live}`;
  },

  deckLayers({ data, time, terrain, settings }) {
    if (!data) return [];
    refreshElevations(data, terrain);
    const t = time / 1000;
    const byDelay = settings.couleur === 'retard';
    const heads = data.trains.filter((train) => updateHead(train, t)).map((train) => train.head);
    const icons = trainAtlas();
    // Toujours dessinés par-dessus le relief (les trains de montagne resteraient sinon cachés).
    const parameters = { depthCompare: 'always', depthWriteEnabled: false } as const;

    return [
      new TripsLayer<Train>({
        id: 'trains/traines',
        data: data.trains,
        getPath: (train) => train.path,
        getTimestamps: (train) => train.timestamps,
        // En mode « retard », seules les têtes sont colorées : la traînée reste neutre.
        getColor: (train) => (byDelay ? TRAIL_GREY : [...FAMILY_STYLE[train.family].color, 200]),
        currentTime: t - data.base,
        trailLength: TRAIL_SECONDS,
        fadeTrail: true,
        widthUnits: 'pixels',
        getWidth: 3,
        capRounded: true,
        jointRounded: true,
        updateTriggers: { getPath: data.terrainVersion, getColor: byDelay },
        parameters,
      }),
      new IconLayer<Head>({
        id: 'trains/positions',
        data: heads,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: (head) =>
          byDelay
            ? delayIcon(FAMILY_STYLE[head.train.family].nose, head.delayClass)
            : familyIcon(head.train.family),
        getPosition: (head) => head.position,
        getAngle: (head) => head.angle,
        // À plat sur la carte : le train tourne avec elle et suit son sens de marche.
        billboard: false,
        sizeUnits: 'meters',
        getSize: TRAIN_SIZE_M,
        sizeMinPixels: TRAIN_MIN_PX,
        sizeMaxPixels: TRAIN_MAX_PX,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 110],
        parameters,
      }),
    ];
  },

  describe(object) {
    const head = object as Head;
    const train = head.train;
    const last = train.stops.length - 1;
    const origin = train.stops[0]!;
    const terminus = train.stops[last]!;
    const fields: Array<[string, string]> = [['Retard', delayText(head.delay)]];

    if (head.atStop !== null) {
      const station = train.stops[head.atStop]!;
      fields.push(
        head.atStop === last
          ? ['Arrivé', `${station.name}, ${hhmm(train.arr[last])}`]
          : ['À quai', `${station.name}, départ ${hhmm(train.dep[head.atStop])}`],
      );
    } else if (head.nextStop !== null) {
      fields.push(['Prochain arrêt', `${train.stops[head.nextStop]!.name}, ${hhmm(train.arr[head.nextStop])}`]);
    }
    fields.push(['Départ', `${origin.name}, ${hhmm(train.dep[0])}`]);
    fields.push(['Arrivée', `${terminus.name}, ${hhmm(train.arr[last])}`]);
    if (train.line) fields.push(['Ligne', train.line]);
    if (train.skippedCount > 0) fields.push(['Arrêts supprimés', String(train.skippedCount)]);
    if (!train.realtime) fields.push(['Source', 'horaire théorique']);

    return {
      title: `${displayCategory(train.category)} ${train.number}`,
      subtitle: `${origin.name} → ${terminus.name}`,
      fields,
    };
  },
});
