/**
 * Module « Trafic routier » : deux regards sur la route, réglables dans le panneau.
 *
 * - **Événements** (Bison Futé, DATEX II) : bouchons, accidents, fermetures, travaux et
 *   dangers du réseau routier national non concédé. Un pictogramme par famille (étoile :
 *   accident, carré : fermeture, losange : travaux, triangle : danger) ; un bouchon est un
 *   tronçon brun, d'autant plus épais et foncé que la file est longue ; une fermeture ou des
 *   travaux sur un tronçon sont des traits pointillés. Un événement est montré tant que
 *   l'horloge est entre son début et sa fin.
 * - **État de la circulation** : des tronçons colorés de fluide à coupé (Bison Futé autour des
 *   grandes agglomérations, Rennes Métropole). Les routes fluides restent discrètes. Les
 *   couleurs d'état sont les couleurs de statut des crues, doublées de l'épaisseur du trait.
 *
 * Le serveur (server/src/traffic.rs et traffic_state.rs) relit les sources toutes les 2 à 5
 * minutes. Les autoroutes concédées (Vinci, APRR, Sanef…) ne sont pas couvertes : leurs
 * événements et leur état ne sont pas publiés en données ouvertes.
 */
import type { Color } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { measuredStatus, plainStatus } from '../core/infoStatus';
import { defineModule } from '../core/module';
import type { InfoFigure, LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { OVER_MAP } from '../map/parameters';
import { formatDateTime, formatRelative, formatTime } from '../ui/format';
import { type Shape, ShapeExtension } from './shapeExtension';
import { STATUS_COLORS, addSelectionRing, selectionRingIds, selectionRingLayers, setSelectionRingFilter } from './statusColors';

type Kind = 'bouchon' | 'accident' | 'fermeture' | 'travaux' | 'danger';

interface TrafficEvent {
  id: string;
  kind: Kind;
  label: string;
  severity: number;
  lon: number;
  lat: number;
  line?: [[number, number], [number, number]];
  lengthM?: number;
  road?: string;
  from?: string;
  to?: string;
  direction?: string;
  start?: number;
  end?: number;
  period?: string;
  comment?: string;
  location?: string;
  lanes?: [number, number];
  source?: string;
  uncertain?: boolean;
  updated?: number;
}

interface Section {
  id: string;
  source: string;
  road?: string;
  name?: string;
  state: number;
  speed?: number;
  flow?: number;
  time: number;
  line: Array<[number, number]>;
}

interface TrafficData {
  events: TrafficEvent[];
  eventsById: Map<string, TrafficEvent>;
  sections: Section[];
  sectionsById: Map<string, Section>;
  eventsAt: number;
  stateAt: number | undefined;
  /** Une des deux sources n'a pas répondu : on le dit dans le résumé plutôt que de tout masquer. */
  missing: string | null;
}

// --- Apparence ---------------------------------------------------------------------------------

/** États de la circulation : couleurs de statut (celles des crues), jamais seules (épaisseur aussi). */
const STATES = [
  { name: 'Fluide', color: STATUS_COLORS.vert },
  { name: 'Ralenti', color: STATUS_COLORS.jaune },
  { name: 'Saturé', color: STATUS_COLORS.orange },
  { name: 'Coupé', color: STATUS_COLORS.rouge },
] as const;

/** Bouchons : une seule teinte brune, du clair (ralentissement) au foncé (très long). Validée. */
const JAM = [
  { color: '#e0a26f', label: 'Trafic ralenti', width: 3 },
  { color: '#bc804d', label: 'Bouchon', width: 5 },
  { color: '#995f2c', label: 'Bouchon important (2 km et plus)', width: 7 },
  { color: '#764002', label: 'Bouchon très important (5 km et plus) ou trafic à l’arrêt', width: 9 },
] as const;

const INK = '#161a26';
const SHAPES: Record<Exclude<Kind, 'bouchon'>, { shape: Shape; label: string; size: number; fill: Color }> = {
  accident: { shape: 'star', label: 'Accident', size: 10, fill: [22, 26, 38] },
  fermeture: { shape: 'square', label: 'Route fermée', size: 8, fill: [22, 26, 38] },
  travaux: { shape: 'diamond', label: 'Travaux, voie neutralisée', size: 6, fill: [255, 255, 255] },
  danger: { shape: 'triangle', label: 'Danger (obstacle, chaussée…)', size: 8, fill: [255, 255, 255] },
};

/** Nom de chaque famille d'événements, pour le type affiché en tête de fiche. */
const KIND_NAMES: Record<Kind, string> = {
  bouchon: 'Bouchon',
  accident: 'Accident',
  fermeture: 'Fermeture de route',
  travaux: 'Travaux',
  danger: 'Danger',
};

const KIND_ORDER: Kind[] = ['travaux', 'danger', 'fermeture', 'accident', 'bouchon'];

/** Pictogramme de légende : la même forme que sur la carte. */
const iconCache = new Map<string, string>();
function shapeIcon(shape: Shape, fill: Color): string {
  const key = `${shape}|${fill.join(',')}`;
  const cached = iconCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 28;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const path = (): void => {
    ctx.beginPath();
    switch (shape) {
      case 'star':
        for (let i = 0; i < 10; i++) {
          const radius = i % 2 === 0 ? 11 : 4.8;
          const angle = -Math.PI / 2 + (i * Math.PI) / 5;
          ctx[i === 0 ? 'moveTo' : 'lineTo'](14 + radius * Math.cos(angle), 14.5 + radius * Math.sin(angle));
        }
        break;
      case 'square':
        ctx.rect(5, 5, 18, 18);
        break;
      case 'diamond':
        ctx.moveTo(14, 2);
        ctx.lineTo(26, 14);
        ctx.lineTo(14, 26);
        ctx.lineTo(2, 14);
        break;
      default:
        ctx.moveTo(14, 3);
        ctx.lineTo(26, 24);
        ctx.lineTo(2, 24);
    }
    ctx.closePath();
  };
  path();
  ctx.fillStyle = `rgb(${fill[0]},${fill[1]},${fill[2]})`;
  ctx.fill();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = fill[0] === 22 ? '#ffffff' : INK;
  ctx.stroke();
  const url = canvas.toDataURL();
  iconCache.set(key, url);
  return url;
}

// --- Chargement --------------------------------------------------------------------------------

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (response.status === 503) throw new Error('première collecte en cours');
  if (!response.ok) throw new Error(`${url} a répondu ${response.status}`);
  return (await response.json()) as T;
}

async function loadTraffic(signal: AbortSignal): Promise<TrafficData> {
  const [events, state] = await Promise.allSettled([
    getJson<{ updatedAt: number; events: TrafficEvent[] }>('/api/trafic', signal),
    getJson<{ updatedAt: number; sections: Section[] }>('/api/trafic/etat', signal),
  ]);
  if (events.status === 'rejected' && state.status === 'rejected') throw new Error(`le serveur du trafic : ${(events.reason as Error).message}`);
  const eventList = events.status === 'fulfilled' ? events.value.events : [];
  const sections = state.status === 'fulfilled' ? state.value.sections : [];
  return {
    events: eventList,
    eventsById: new Map(eventList.map((e) => [e.id, e])),
    sections,
    sectionsById: new Map(sections.map((s) => [s.id, s])),
    eventsAt: events.status === 'fulfilled' ? events.value.updatedAt : 0,
    stateAt: state.status === 'fulfilled' ? state.value.updatedAt : undefined,
    missing: events.status === 'rejected' ? 'événements' : state.status === 'rejected' ? 'état des routes' : null,
  };
}

/** Un événement est montré de son début à sa fin (sans fin : jusqu'à nouvel ordre). */
function activeAt(event: TrafficEvent, time: number): boolean {
  return (event.start === undefined || event.start * 1000 <= time) && (event.end === undefined || event.end * 1000 >= time);
}

const showsEvents = (settings: Readonly<Record<string, string>>) => settings.affichage !== 'etat';
const showsState = (settings: Readonly<Record<string, string>>) => settings.affichage !== 'evenements';

function visibleEvents(data: TrafficData, time: number, settings: Readonly<Record<string, string>>): TrafficEvent[] {
  if (!showsEvents(settings)) return [];
  const grave = settings.types === 'graves';
  return data.events.filter((e) => activeAt(e, time) && !(grave && (e.kind === 'travaux' || e.kind === 'danger')));
}

/** Mémoire des événements visibles : recalculés quand la minute, les données ou les réglages changent. */
let eventCache: { data: TrafficData; key: string; list: TrafficEvent[] } | undefined;
function eventsNow(data: TrafficData, time: number, settings: Readonly<Record<string, string>>): TrafficEvent[] {
  const key = `${Math.floor(time / 60_000)}|${settings.affichage}|${settings.types}`;
  if (eventCache?.data !== data || eventCache.key !== key) eventCache = { data, key, list: visibleEvents(data, time, settings) };
  return eventCache.list;
}

// --- Couches MapLibre --------------------------------------------------------------------------

const STATE_SOURCE = 'trafic-etat';
const STATE_CASING = 'trafic-etat-contour';
const STATE_LINE = 'trafic-etat-trait';
const STATE_SELECTED = 'trafic-etat-choisi';
const EVENT_SOURCE = 'trafic-evenements';
const JAM_CASING = 'trafic-bouchons-contour';
const JAM_LINE = 'trafic-bouchons';
const CLOSURE_CASING = 'trafic-fermetures-contour';
const CLOSURE_LINE = 'trafic-fermetures';
const WORKS_CASING = 'trafic-travaux-contour';
const WORKS_LINE = 'trafic-travaux';
const EVENT_SELECTED = 'trafic-evenement-choisi';
const STATE_LAYERS = [...selectionRingIds(STATE_SELECTED), STATE_LINE, STATE_CASING];
const EVENT_LAYERS = [...selectionRingIds(EVENT_SELECTED), WORKS_LINE, WORKS_CASING, CLOSURE_LINE, CLOSURE_CASING, JAM_LINE, JAM_CASING];

const byState = (values: [number, number, number, number]) => ['match', ['get', 'state'], 1, values[1], 2, values[2], 3, values[3], values[0]] as never;
const bySeverity = (values: [number, number, number, number]) => ['match', ['get', 'severity'], 2, values[1], 3, values[2], 4, values[3], values[0]] as never;

/** Un tronçon d'événement trop long (> 30 km) serait une corde sans rapport avec la route : on ne trace que son pictogramme. */
const MAX_LINE_M = 30_000;

let shownState: TrafficData | undefined;
let shownEvents: TrafficEvent[] | undefined;

function sectionsGeoJson(data: TrafficData) {
  return {
    type: 'FeatureCollection' as const,
    features: data.sections.map((s) => ({
      type: 'Feature' as const,
      properties: { id: s.id, state: s.state },
      geometry: { type: 'LineString' as const, coordinates: s.line },
    })),
  };
}

function eventsGeoJson(events: TrafficEvent[]) {
  return {
    type: 'FeatureCollection' as const,
    features: events
      .filter((e) => e.line && (e.lengthM ?? 0) <= MAX_LINE_M && (e.kind === 'bouchon' || e.kind === 'fermeture' || e.kind === 'travaux'))
      .map((e) => ({
        type: 'Feature' as const,
        properties: { id: e.id, kind: e.kind, severity: e.severity },
        geometry: { type: 'LineString' as const, coordinates: e.line! },
      })),
  };
}

function setVisibility(map: MapLibreMap, ids: string[], visible: boolean): void {
  for (const id of ids) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
}

/** Fin d'un événement, assez courte pour une case de chiffre : « 18:30 » le jour même, « 12 nov. » sinon. */
function endLabel(ms: number): string {
  const day = (t: number) => new Date(t).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
  if (day(ms) === day(Date.now())) return formatTime(ms);
  return new Date(ms).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'short' });
}

const stateAge = (data: TrafficData): string => (data.stateAt ? formatRelative(data.stateAt * 1000) : '');

export const traffic = defineModule<TrafficData>({
  id: 'trafic',
  name: 'Trafic routier',
  category: 'transport',
  description: 'Bouchons, accidents, fermetures et travaux du réseau routier national, et état de la circulation autour des grandes villes.',
  attribution: 'Bison Futé (transport.data.gouv.fr, Licence Ouverte 2.0), Rennes Métropole (ODbL)',
  refreshIntervalMs: 2 * 60_000,
  timeStepMs: 60_000,

  settings: [
    {
      id: 'affichage',
      label: 'Affichage',
      options: [
        { value: 'les-deux', label: 'Les deux' },
        { value: 'evenements', label: 'Événements' },
        { value: 'etat', label: 'État du trafic' },
      ],
      defaultValue: 'les-deux',
    },
    {
      id: 'types',
      label: 'Événements',
      options: [
        { value: 'tous', label: 'Tous' },
        { value: 'graves', label: 'Sans travaux ni dangers' },
      ],
      defaultValue: 'tous',
    },
  ],

  load: ({ signal }) => loadTraffic(signal),

  legend(settings) {
    const items: LegendItem[] = [];
    if (showsState(settings)) {
      for (const [index, state] of STATES.entries()) items.push({ color: state.color, label: `Circulation ${state.name.toLowerCase()}`, size: index >= 2 ? 'large' : index === 1 ? 'medium' : 'small' });
    }
    if (showsEvents(settings)) {
      for (const jam of JAM) items.push({ color: jam.color, label: jam.label, size: jam.width >= 7 ? 'large' : jam.width >= 5 ? 'medium' : 'small' });
      for (const kind of ['accident', 'fermeture', 'travaux', 'danger'] as const) {
        if (settings.types === 'graves' && (kind === 'travaux' || kind === 'danger')) continue;
        const spec = SHAPES[kind];
        items.push({ color: INK, label: spec.label, icon: shapeIcon(spec.shape, spec.fill) });
      }
    }
    return items;
  },

  summary({ data, time, settings }) {
    if (!data) return null;
    const parts: string[] = [];
    if (showsEvents(settings)) {
      const events = eventsNow(data, time, settings);
      const jams = events.filter((e) => e.kind === 'bouchon').length;
      parts.push(`${events.length} événements${jams ? ` dont ${jams} bouchon${jams > 1 ? 's' : ''}` : ''}`);
    }
    if (showsState(settings)) {
      const slow = data.sections.filter((s) => s.state >= 1).length;
      parts.push(`${data.sections.length} tronçons mesurés${slow ? `, ${slow} ralenti${slow > 1 ? 's' : ''} ou pire` : ''}`);
    }
    if (data.missing) parts.push(`source « ${data.missing} » indisponible`);
    parts.push('hors autoroutes concédées');
    return parts.join(' · ');
  },

  native: {
    add(map: MapLibreMap) {
      shownState = undefined;
      shownEvents = undefined;
      const empty = { type: 'FeatureCollection' as const, features: [] };
      map.addSource(STATE_SOURCE, { type: 'geojson', data: empty });
      map.addSource(EVENT_SOURCE, { type: 'geojson', data: empty });
      const before = firstSymbolLayerId(map);
      const round = { 'line-cap': 'round', 'line-join': 'round' } as const;

      // État : le fluide reste discret (fin, translucide), le reste ressort par la couleur et l'épaisseur.
      map.addLayer(
        {
          id: STATE_CASING,
          type: 'line',
          source: STATE_SOURCE,
          layout: round,
          paint: {
            'line-color': INK,
            'line-opacity': byState([0.15, 0.7, 0.8, 0.9]),
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, byState([2, 4, 6, 8]), 12, byState([4, 8, 11, 14])] as never,
          },
        },
        before,
      );
      map.addLayer(
        {
          id: STATE_LINE,
          type: 'line',
          source: STATE_SOURCE,
          layout: round,
          paint: {
            'line-color': ['match', ['get', 'state'], 1, STATES[1].color, 2, STATES[2].color, 3, STATES[3].color, STATES[0].color] as never,
            'line-opacity': byState([0.55, 1, 1, 1]),
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, byState([1, 2.5, 4, 5.5]), 12, byState([2, 5, 7.5, 10])] as never,
          },
        },
        before,
      );
      addSelectionRing(map, selectionRingLayers(STATE_SELECTED, STATE_SOURCE, ['==', ['get', 'id'], ''], [[5, 2], [12, 5]], 3), before);

      // Événements : bouchons (brun, épaisseur selon la gravité), fermetures et travaux (pointillés).
      map.addLayer(
        {
          id: JAM_CASING,
          type: 'line',
          source: EVENT_SOURCE,
          filter: ['==', ['get', 'kind'], 'bouchon'],
          layout: round,
          paint: { 'line-color': INK, 'line-opacity': 0.85, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, bySeverity([4, 6, 8, 10]), 12, bySeverity([6, 9, 12, 15])] as never },
        },
        before,
      );
      map.addLayer(
        {
          id: JAM_LINE,
          type: 'line',
          source: EVENT_SOURCE,
          filter: ['==', ['get', 'kind'], 'bouchon'],
          layout: round,
          paint: {
            'line-color': ['match', ['get', 'severity'], 2, JAM[1].color, 3, JAM[2].color, 4, JAM[3].color, JAM[0].color] as never,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, bySeverity([2, 3.5, 5, 6.5]), 12, bySeverity([3, 5.5, 8, 10.5])] as never,
          },
        },
        before,
      );
      for (const [casing, line, kind, dash, width] of [
        [CLOSURE_CASING, CLOSURE_LINE, 'fermeture', [1.6, 1.2], 4],
        [WORKS_CASING, WORKS_LINE, 'travaux', [1, 1.8], 3],
      ] as const) {
        map.addLayer(
          {
            id: casing,
            type: 'line',
            source: EVENT_SOURCE,
            minzoom: 7,
            filter: ['==', ['get', 'kind'], kind],
            layout: { 'line-cap': 'butt' },
            paint: { 'line-color': '#ffffff', 'line-opacity': 0.9, 'line-width': width + 3 },
          },
          before,
        );
        map.addLayer(
          {
            id: line,
            type: 'line',
            source: EVENT_SOURCE,
            minzoom: 7,
            filter: ['==', ['get', 'kind'], kind],
            layout: { 'line-cap': 'butt' },
            paint: { 'line-color': INK, 'line-width': width, 'line-dasharray': [...dash] },
          },
          before,
        );
      }
      addSelectionRing(map, selectionRingLayers(EVENT_SELECTED, EVENT_SOURCE, ['==', ['get', 'id'], ''], 3, 4), before);
    },

    update(map, { data, time, settings, selection }) {
      if (data && shownState !== data) {
        (map.getSource(STATE_SOURCE) as GeoJSONSource | undefined)?.setData(sectionsGeoJson(data) as Parameters<GeoJSONSource['setData']>[0]);
        shownState = data;
      }
      if (data) {
        const events = eventsNow(data, time, settings);
        if (shownEvents !== events) {
          (map.getSource(EVENT_SOURCE) as GeoJSONSource | undefined)?.setData(eventsGeoJson(events) as Parameters<GeoJSONSource['setData']>[0]);
          shownEvents = events;
        }
      }
      setVisibility(map, STATE_LAYERS, showsState(settings));
      setVisibility(map, EVENT_LAYERS, showsEvents(settings));
      const chosen = selection as { type: string; id: string } | null;
      setSelectionRingFilter(map, STATE_SELECTED, ['==', ['get', 'id'], chosen?.type === 'section' ? chosen.id : '']);
      setSelectionRingFilter(map, EVENT_SELECTED, ['==', ['get', 'id'], chosen?.type === 'event' ? chosen.id : '']);
    },

    remove(map) {
      for (const id of [...EVENT_LAYERS, ...STATE_LAYERS]) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [STATE_SOURCE, EVENT_SOURCE]) if (map.getSource(id)) map.removeSource(id);
      shownState = undefined;
      shownEvents = undefined;
    },

    pickable: {
      layerIds: [STATE_LINE, STATE_CASING, JAM_LINE, JAM_CASING, CLOSURE_LINE, CLOSURE_CASING, WORKS_LINE, WORKS_CASING],
      toObject: (feature) => {
        const id = String(feature.properties?.id ?? '');
        return { type: String(feature.layer.id).startsWith('trafic-etat') ? 'section' : 'event', id };
      },
    },
  },

  deckLayers({ data, time, settings, selection }) {
    if (!data || !showsEvents(settings)) return [];
    const events = eventsNow(data, time, settings);
    const chosen = (selection as { type: string; id: string } | null)?.type === 'event' ? data.eventsById.get((selection as { id: string }).id) : undefined;
    const layers = [];

    // Bouchons : un disque brun au milieu du tronçon, pour les voir de loin.
    const jams = events.filter((e) => e.kind === 'bouchon');
    if (jams.length) {
      layers.push(
        new ScatterplotLayer<TrafficEvent>({
          id: 'trafic/bouchons',
          data: jams,
          getPosition: (e) => [e.lon, e.lat],
          radiusUnits: 'pixels',
          getRadius: (e) => 5 + e.severity * 1.5,
          getFillColor: (e) => hexToRgb(JAM[Math.min(Math.max(e.severity, 1), 4) - 1]!.color),
          stroked: true,
          getLineColor: [255, 255, 255, 235],
          lineWidthUnits: 'pixels',
          getLineWidth: 1.5,
          billboard: true,
          pickable: true,
          updateTriggers: { getFillColor: events },
          parameters: OVER_MAP,
        }),
      );
    }

    // Une couche par famille : la forme est découpée dans le shader (voir shapeExtension.ts).
    for (const kind of KIND_ORDER) {
      if (kind === 'bouchon') continue;
      const members = events.filter((e) => e.kind === kind);
      if (!members.length) continue;
      const spec = SHAPES[kind];
      const extensions = [new ShapeExtension({ shape: spec.shape })];
      // Un contour opposé à la couleur de remplissage, un peu plus grand, garde la forme lisible sur tous les fonds.
      const light = spec.fill[0] === 255;
      layers.push(
        new ScatterplotLayer<TrafficEvent>({
          id: `trafic/${kind}-contour`,
          data: members,
          getPosition: (e) => [e.lon, e.lat],
          radiusUnits: 'pixels',
          getRadius: spec.size + 2.2,
          getFillColor: light ? [22, 26, 38, 240] : [255, 255, 255, 245],
          billboard: true,
          extensions,
          parameters: OVER_MAP,
        }),
        new ScatterplotLayer<TrafficEvent>({
          id: `trafic/${kind}`,
          data: members,
          getPosition: (e) => [e.lon, e.lat],
          radiusUnits: 'pixels',
          getRadius: spec.size,
          getFillColor: spec.fill,
          billboard: true,
          pickable: true,
          extensions,
          parameters: OVER_MAP,
        }),
      );
    }

    if (chosen) {
      // Anneau blanc cerné de sombre (comme sur les tronçons) : la sélection ne prend aucune teinte.
      layers.push(
        new ScatterplotLayer<TrafficEvent>({
          id: 'trafic/choisi-contour',
          data: [chosen],
          getPosition: (e) => [e.lon, e.lat],
          radiusUnits: 'pixels',
          getRadius: 16,
          filled: false,
          stroked: true,
          getLineColor: [22, 26, 38, 235],
          lineWidthUnits: 'pixels',
          getLineWidth: 6,
          billboard: true,
          parameters: OVER_MAP,
        }),
        new ScatterplotLayer<TrafficEvent>({
          id: 'trafic/choisi',
          data: [chosen],
          getPosition: (e) => [e.lon, e.lat],
          radiusUnits: 'pixels',
          getRadius: 16,
          filled: false,
          stroked: true,
          getLineColor: [255, 255, 255],
          lineWidthUnits: 'pixels',
          getLineWidth: 3,
          billboard: true,
          parameters: OVER_MAP,
        }),
      );
    }
    return layers;
  },

  select(object) {
    const picked = object as { type?: string; id?: string; kind?: string };
    // Venant de deck.gl : l'événement lui-même ; venant d'une couche native : { type, id }.
    if (picked.kind) return { type: 'event', id: (object as TrafficEvent).id };
    return picked.id ? { type: picked.type ?? 'event', id: picked.id } : null;
  },

  describe(selection, { data, time }) {
    if (!data) return null;
    const { type, id } = selection as { type: string; id: string };
    const NOT_COVERED = 'Les autoroutes concédées (Vinci, APRR, Sanef…) ne sont pas couvertes : leurs événements et leur état ne sont pas publiés en données ouvertes.';
    const source = { label: 'Source', href: 'https://www.bison-fute.gouv.fr/' };

    if (type === 'section') {
      const section = data.sectionsById.get(id);
      if (!section) return null;
      const fields: Array<[string, string]> = [];
      if (section.road && section.name) fields.push(['Sens', section.name]);
      return {
        kind: 'Tronçon routier',
        title: section.road ?? section.name ?? 'Tronçon routier',
        subtitle: section.source,
        // L'état est une mesure des capteurs, datée : c'est la seule donnée ici qui est vraiment reçue en continu.
        status: measuredStatus(time, section.time * 1000),
        // L'état n'est jamais absent ; la vitesse et le débit dépendent des capteurs de la source.
        figures: [
          ...(section.speed !== undefined ? [{ value: String(Math.round(section.speed)), unit: 'km/h', label: 'vitesse moyenne' }] : []),
          { value: STATES[section.state]?.name ?? 'Inconnu', label: 'état' },
          ...(section.flow !== undefined ? [{ value: section.flow.toLocaleString('fr-FR'), unit: 'véh./h', label: 'débit' }] : []),
        ],
        fields: fields.length ? fields : undefined,
        note: `${NOT_COVERED}${stateAge(data) ? ` Données relues ${stateAge(data)}.` : ''}`,
        actions: [source],
      };
    }

    const event = data.eventsById.get(id);
    if (!event) return null;
    const places = event.from && event.to && event.from !== event.to ? `de ${event.from} à ${event.to}` : (event.from ?? '');
    const length =
      event.lengthM !== undefined && event.lengthM > 0
        ? event.lengthM >= 1000
          ? { value: (event.lengthM / 1000).toFixed(1).replace('.', ','), unit: 'km' }
          : { value: String(event.lengthM), unit: 'm' }
        : undefined;
    const figures: InfoFigure[] = [];
    if (length) figures.push({ ...length, label: event.kind === 'bouchon' ? 'de file' : 'de tronçon' });
    if (event.lanes && event.lanes[1] > 0) figures.push({ value: `${event.lanes[0]}/${event.lanes[1]}`, label: 'voies concernées' });
    figures.push({ value: event.end !== undefined ? endLabel(event.end * 1000) : '–', label: event.end !== undefined ? 'fin prévue' : 'fin non précisée' });
    // Les chiffres portent déjà la longueur, les voies et la fin ; la fiche garde le reste du détail.
    const fields: Array<[string, string]> = [];
    if (event.road) fields.push(['Route', event.road]);
    if (event.direction) fields.push(['Sens', event.direction]);
    if (event.start !== undefined) fields.push(['Début', formatDateTime(event.start * 1000)]);
    if (event.period) fields.push(['Période', event.period]);
    if (event.location) fields.push(['Position', event.location]);
    if (event.source) fields.push(['Source', `${event.source} (Bison Futé)`]);
    return {
      kind: KIND_NAMES[event.kind],
      title: event.label,
      subtitle: [event.road, places].filter(Boolean).join(' · ') || undefined,
      // Un événement est déclaré par les gestionnaires de route, pas mesuré : on dit sa fraîcheur, sans point rouge.
      status: plainStatus(
        event.uncertain
          ? 'Probable, pas encore confirmé'
          : event.updated !== undefined
            ? `Mis à jour ${formatRelative(event.updated * 1000)}`
            : 'Déclaré par Bison Futé',
      ),
      figures,
      fields: fields.length ? fields : undefined,
      note: [event.comment, NOT_COVERED].filter(Boolean).join('\n\n'),
      actions: [source],
    };
  },

  focus(selection, { data }) {
    const chosen = selection as { type: string; id: string };
    if (!data || chosen.type !== 'event') return null;
    const event = data.eventsById.get(chosen.id);
    return event ? { lon: event.lon, lat: event.lat } : null;
  },
});

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
