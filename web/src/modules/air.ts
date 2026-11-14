/**
 * Module « Qualité de l'air » : l'indice ATMO de chaque commune (ou intercommunalité, selon
 * l'association régionale) de métropole, et les épisodes de pollution en cours.
 *
 * Source : Atmo Data (Atmo France), qui agrège les flux ouverts des associations agréées de
 * surveillance de la qualité de l'air (AASQA). Le serveur la relève toutes les heures
 * (server/src/air.rs) : l'indice est publié une fois par jour, vers 12–14 h, pour le jour
 * même et les jours qui viennent. Il n'y a pas d'historique : avant le premier jour publié,
 * la carte est vide et le dit.
 *
 * Forme : une couche MapLibre native (cercles flous sous les étiquettes du fond de carte). Il y a
 * près de 29 000 points, espacés de quelques kilomètres : de loin, des cercles qui se recouvrent
 * forment un champ de couleur continu ; de près, ils se resserrent en pastilles nettes autour des
 * communes. Les plus mauvais indices sont dessinés par-dessus pour ne jamais être masqués par
 * leurs voisins. Les intercommunalités (Occitanie, Pays de la Loire, Bretagne…) n'ont qu'un point
 * pour tout un territoire : leur cercle est plus grand.
 *
 * Couleurs : la palette officielle de l'indice ATMO (2021), que le public connaît. Elle n'est
 * jamais seule : la légende, la fiche et le résumé donnent le libellé du niveau.
 */
import { STATUS } from '../design/tokens';
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import { plainStatus, scheduledStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { formatTime } from '../ui/format';
import departements from '../data/departements.json';

// --- Données du serveur ----------------------------------------------------------------------

interface ApiEpisode {
  zone: string;
  /** « O3 », « NO2 », « PM10 », « PM2.5 », « SO2 ». */
  pol: string;
  /** 1 information et recommandation, 2 alerte, 3 alerte sur persistance. */
  level: number;
  day: string;
}

interface ApiAir {
  updatedAt: number;
  issuedAt?: number;
  days: string[];
  sources: string[];
  zones: { name: string[]; lon: number[]; lat: number[]; src: number[]; epci: number[]; v: string[] };
  episodes: ApiEpisode[];
}

interface AirData extends ApiAir {
  geo: { type: 'FeatureCollection'; features: Array<{ type: 'Feature'; id: number; geometry: { type: 'Point'; coordinates: [number, number] }; properties: Record<string, number> }> };
}

// --- Niveaux ---------------------------------------------------------------------------------

/** Palette officielle de l'indice ATMO 2021 ; le 7 (événement) n'a pas de couleur officielle : gris. */
const LEVELS: Record<number, { name: string; color: string; text: string }> = {
  1: { name: 'Bon', color: '#50F0E6', text: 'La qualité de l’air est bonne.' },
  2: { name: 'Moyen', color: '#50CCAA', text: 'La qualité de l’air est moyenne : pas de gêne attendue pour la plupart des personnes.' },
  3: { name: 'Dégradé', color: '#F0E641', text: 'La qualité de l’air est dégradée : les personnes sensibles (asthmatiques, jeunes enfants, personnes âgées) peuvent ressentir une gêne.' },
  4: { name: 'Mauvais', color: '#FF5050', text: 'La qualité de l’air est mauvaise : les personnes sensibles doivent limiter les efforts, les autres peuvent ressentir une gêne.' },
  5: { name: 'Très mauvais', color: '#960032', text: 'La qualité de l’air est très mauvaise : évitez les efforts prolongés, surtout si vous êtes sensible.' },
  6: { name: 'Extrêmement mauvais', color: '#872181', text: 'La qualité de l’air est extrêmement mauvaise : limitez les activités à l’extérieur.' },
  7: { name: 'Événement', color: '#8c93a0', text: 'Un événement particulier (épisode de pollution, incendie…) affecte la qualité de l’air.' },
};

/** Ordre des sous-indices dans la réponse du serveur, après l'indice global. */
const POLLUTANTS = [
  { code: 'NO2', name: 'Dioxyde d’azote (NO2)', short: 'dioxyde d’azote' },
  { code: 'O3', name: 'Ozone (O3)', short: 'ozone' },
  { code: 'PM10', name: 'Particules PM10', short: 'particules PM10' },
  { code: 'PM2.5', name: 'Particules fines PM2.5', short: 'particules fines PM2.5' },
  { code: 'SO2', name: 'Dioxyde de soufre (SO2)', short: 'dioxyde de soufre' },
] as const;

const EPISODE_LEVELS: Record<number, string> = { 1: 'Information et recommandation', 2: 'Alerte', 3: 'Alerte sur persistance' };

/** Région de chaque association, et départements de chaque région (pour rattacher les épisodes). */
const REGIONS: Array<{ name: string; sources: string[]; departments: string[] }> = [
  { name: 'Auvergne-Rhône-Alpes', sources: ['Atmo Auvergne-Rhône-Alpes'], departments: ['01', '03', '07', '15', '26', '38', '42', '43', '63', '69', '73', '74'] },
  { name: 'Bourgogne-Franche-Comté', sources: ['ATMO Bourgogne-Franche-Comté'], departments: ['21', '25', '39', '58', '70', '71', '89', '90'] },
  { name: 'Bretagne', sources: ['Air Breizh'], departments: ['22', '29', '35', '56'] },
  { name: 'Centre-Val de Loire', sources: ['Lig’Air', "Lig'Air"], departments: ['18', '28', '36', '37', '41', '45'] },
  { name: 'Corse', sources: ['Qualitair Corse'], departments: ['2A', '2B'] },
  { name: 'Grand Est', sources: ['Atmo Grand Est'], departments: ['08', '10', '51', '52', '54', '55', '57', '67', '68', '88'] },
  { name: 'Hauts-de-France', sources: ['Atmo HDF'], departments: ['02', '59', '60', '62', '80'] },
  { name: 'Île-de-France', sources: ['Airparif'], departments: ['75', '77', '78', '91', '92', '93', '94', '95'] },
  { name: 'Normandie', sources: ['Atmo Normandie'], departments: ['14', '27', '50', '61', '76'] },
  { name: 'Nouvelle-Aquitaine', sources: ['Atmo Nouvelle-Aquitaine'], departments: ['16', '17', '19', '23', '24', '33', '40', '47', '64', '79', '86', '87'] },
  { name: 'Occitanie', sources: ['Atmo-Occitanie'], departments: ['09', '11', '12', '30', '31', '32', '34', '46', '48', '65', '66', '81', '82'] },
  { name: 'Pays de la Loire', sources: ['Air Pays de la Loire'], departments: ['44', '49', '53', '72', '85'] },
  { name: 'Provence-Alpes-Côte d’Azur', sources: ['AtmoSud'], departments: ['04', '05', '06', '13', '83', '84'] },
];

const regionOfSource = (source: string) => REGIONS.find((r) => r.sources.includes(source))?.name;

// --- Aides -----------------------------------------------------------------------------------

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayNameFormat = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' });

/** Jour de l'instant à Paris, « AAAA-MM-JJ ». */
const dayKey = (time: number): string => dayKeyFormat.format(time);
/** « mardi 10 novembre » d'après « 2026-11-10 ». */
const dayName = (key: string): string => dayNameFormat.format(new Date(`${key}T12:00:00Z`));

/** Position du jour de l'horloge parmi les jours publiés, -1 s'il n'est pas publié. */
function dayIndexAt(data: AirData, time: number): number {
  return data.days.indexOf(dayKey(time));
}

/** Indice (1 à 7) de la zone ce jour-là ; 0 si le jour n'est pas publié pour elle. */
function levelOf(data: AirData, zone: number, day: number, offset = 0): number {
  const code = data.zones.v[zone]?.charCodeAt(day * 6 + offset) ?? 45;
  return code >= 49 && code <= 55 ? code - 48 : 0;
}

/** Retire accents, ponctuation et casse : « Côtes-d'Armor » et « COTES-D'ARMOR » deviennent identiques. */
const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const SMALL_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'en', 'et', 'sur', 'sous', 'd', 'l']);
/** « BASSIN GRENOBLOIS » → « Bassin Grenoblois » (les petits mots restent en minuscules). */
function titleCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/[\p{L}\p{N}]+/gu, (word, offset: number) => (offset > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)));
}

interface DepartmentFeature {
  properties: { code: string; nom: string };
  geometry: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] };
}
const DEPARTMENTS = (departements as unknown as { features: DepartmentFeature[] }).features;

function inRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi! > lat !== yj! > lat && lon < ((xj! - xi!) * (lat - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

/** Département qui contient le point (les départements de métropole ne se recouvrent pas). */
function departmentAt(lon: number, lat: number): DepartmentFeature | undefined {
  return DEPARTMENTS.find(({ geometry }) => {
    const polygons = (geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates) as number[][][][];
    return polygons.some(([outer, ...holes]) => outer !== undefined && inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)));
  });
}

const departmentCache = new Map<AirData, Map<number, DepartmentFeature | null>>();
function departmentOf(data: AirData, zone: number): DepartmentFeature | undefined {
  let cache = departmentCache.get(data);
  if (!cache) departmentCache.set(data, (cache = new Map()));
  let found = cache.get(zone);
  if (found === undefined) {
    found = departmentAt(data.zones.lon[zone]!, data.zones.lat[zone]!) ?? null;
    cache.set(zone, found);
  }
  return found ?? undefined;
}

/** L'épisode concerne-t-il ce département ? Par son nom (« CALVADOS »), ou par sa région (« ILE-DE-FRANCE »). */
function episodeCovers(episode: ApiEpisode, department: DepartmentFeature): boolean {
  const zone = normalize(episode.zone);
  if (zone === normalize(department.properties.nom)) return true;
  return REGIONS.some((r) => normalize(r.name) === zone && r.departments.includes(department.properties.code));
}

/** Nom lisible de la zone d'un épisode : celui du département ou de la région quand on les reconnaît. */
function episodeZoneName(episode: ApiEpisode): string {
  const zone = normalize(episode.zone);
  const region = REGIONS.find((r) => normalize(r.name) === zone);
  if (region) return region.name;
  const department = DEPARTMENTS.find((d) => normalize(d.properties.nom) === zone);
  return department ? department.properties.nom : titleCase(episode.zone);
}

/** « d’ozone », « de particules fines » : l'élision selon la première lettre. */
const ofText = (text: string): string => (/^[aeiouyéèh]/i.test(text) ? `d’${text}` : `de ${text}`);
const pollutantShort = (code: string): string => POLLUTANTS.find((p) => p.code === code)?.short ?? code;

/** Épisodes du jour, regroupés par polluant : « d’ozone en Île-de-France ». */
function episodePhrases(data: AirData, day: string): string[] {
  const byPollutant = new Map<string, string[]>();
  for (const episode of data.episodes.filter((e) => e.day === day)) {
    const zones = byPollutant.get(episode.pol) ?? [];
    const name = episodeZoneName(episode);
    if (!zones.includes(name)) zones.push(name);
    byPollutant.set(episode.pol, zones);
  }
  return [...byPollutant].map(([pol, zones]) => {
    const where = zones.length > 2 ? `${zones.slice(0, 2).join(', ')} et ${zones.length - 2} autre${zones.length > 3 ? 's' : ''} zone${zones.length > 3 ? 's' : ''}` : zones.join(' et ');
    return `épisode ${ofText(pollutantShort(pol))} en ${where}`;
  });
}

// --- Rendu -----------------------------------------------------------------------------------

const SOURCE_ID = 'air';
const FIELD_ID = 'air-champ';
const SELECTED_ID = 'air-choisi';
const INK = STATUS.ink;

/** Rayon des cercles (pixels) d'une commune selon le zoom : se recouvrent de loin, se resserrent de près. */
const RADIUS: Array<[number, number]> = [[4, 1.4], [5, 2.2], [6, 3.4], [7, 5.5], [8, 8], [9, 11], [10, 14], [12, 17], [15, 20]];
/** Une intercommunalité n'a qu'un point pour tout son territoire : un cercle plus large. */
const EPCI_FACTOR = 2.6;

const radiusExpression = (extra = 0): unknown[] => [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...RADIUS.flatMap(([zoom, radius]) => [zoom, ['+', ['*', ['case', ['==', ['get', 'e'], 1], EPCI_FACTOR, 1], radius], extra]]),
];

const colorExpression = (day: number): unknown[] => [
  'match',
  ['get', `q${day}`],
  ...Object.entries(LEVELS).flatMap(([level, { color }]) => [Number(level), color]),
  'rgba(0,0,0,0)',
];

/** Opacité du champ : le fond sombre de la nuit porte une couleur plus pleine, le fond clair demande qu'elle ne le noie pas. */
const opacityAt = (night: number): number => 0.8 + 0.1 * night;
/** Contour des pastilles quand on s'approche : sombre le jour, clair la nuit (même rôle que le liseré des symboles). */
const strokeAt = (night: number): string => {
  const mix = (day: number, dark: number) => Math.round(day + (dark - day) * night);
  return `rgba(${mix(20, 255)},${mix(26, 255)},${mix(38, 255)},${(0.5 - 0.1 * night).toFixed(2)})`;
};

let shown: { data: AirData; day: number; night: number } | undefined;

function applyDay(map: MapLibreMap, day: number, night: number): void {
  if (!map.getLayer(FIELD_ID)) return;
  map.setPaintProperty(FIELD_ID, 'circle-color', colorExpression(day) as never);
  map.setPaintProperty(FIELD_ID, 'circle-opacity', opacityAt(night));
  map.setPaintProperty(FIELD_ID, 'circle-stroke-color', strokeAt(night));
  // Les plus mauvais indices par-dessus ; une zone sans indice ce jour-là (aucun niveau) est tout dessous.
  map.setLayoutProperty(FIELD_ID, 'circle-sort-key', ['coalesce', ['get', `q${day}`], 0] as never);
}

// --- Chargement ------------------------------------------------------------------------------

async function loadAir(signal: AbortSignal): Promise<AirData> {
  const response = await fetch('/api/air', { signal });
  if (response.status === 503) throw new Error(await response.text().then((t) => t || 'le serveur récupère encore l’indice de qualité de l’air'));
  if (!response.ok) throw new Error(`le serveur de la qualité de l’air a répondu ${response.status}`);
  const json = (await response.json()) as ApiAir;
  const { zones, days } = json;
  const features: AirData['geo']['features'] = [];
  for (let i = 0; i < zones.name.length; i++) {
    const properties: Record<string, number> = { i, e: zones.epci[i]! };
    for (let day = 0; day < days.length; day++) {
      const code = zones.v[i]!.charCodeAt(day * 6);
      if (code >= 49 && code <= 55) properties[`q${day}`] = code - 48;
    }
    features.push({ type: 'Feature', id: i, geometry: { type: 'Point', coordinates: [zones.lon[i]!, zones.lat[i]!] }, properties });
  }
  return { ...json, geo: { type: 'FeatureCollection', features } };
}

// --- Module ----------------------------------------------------------------------------------

export const air = defineModule<AirData>({
  id: 'air',
  name: 'Qualité de l’air',
  category: 'environnement',
  description: 'Indice ATMO de chaque commune, aujourd’hui et les jours prévus, et épisodes de pollution.',
  attribution: 'Atmo France / AASQA (données ouvertes)',
  refreshIntervalMs: 30 * 60_000,
  // Change avec le jour de l'horloge (et la nuit) : une fois par minute suffit.
  timeStepMs: 60_000,

  load: ({ signal }) => loadAir(signal),

  legend(): LegendItem[] {
    return [1, 2, 3, 4, 5, 6].map((level) => ({ color: LEVELS[level]!.color, label: `${LEVELS[level]!.name}`, size: 'medium' as const }));
  },

  summary({ data, time }) {
    if (!data) return null;
    const day = dayIndexAt(data, time);
    if (day < 0) {
      const first = data.days[0];
      return first && dayKey(time) < first
        ? 'Pas d’historique : l’indice n’est publié que pour aujourd’hui et les jours à venir'
        : 'Indice pas encore publié pour ce jour (il couvre aujourd’hui, demain et parfois après-demain)';
    }
    const counts = [0, 0, 0, 0, 0, 0, 0, 0];
    const worst = new Map<string, number>();
    let total = 0;
    for (let zone = 0; zone < data.zones.name.length; zone++) {
      const level = levelOf(data, zone, day);
      if (level === 0) continue;
      total++;
      counts[level]!++;
      if (level >= 3) worst.set(data.sources[data.zones.src[zone]!]!, (worst.get(data.sources[data.zones.src[zone]!]!) ?? 0) + 1);
    }
    if (total === 0) return `${dayName(data.days[day]!)} : pas d’indice publié`;
    const share = (levels: number[]) => levels.reduce((sum, level) => sum + counts[level]!, 0) / total;
    const parts: string[] = [];
    if (share([1]) >= 0.9) parts.push('bon presque partout');
    else if (share([2]) >= 0.9) parts.push('moyen presque partout');
    else if (share([1, 2]) >= 0.9) parts.push('bon à moyen presque partout');
    else parts.push(`${Math.round(share([1]) * 100)} % bon, ${Math.round(share([2]) * 100)} % moyen`);
    const degraded = counts[3]! + counts[4]! + counts[5]! + counts[6]! + counts[7]!;
    if (degraded > 0) {
      const [top] = [...worst].sort((a, b) => b[1] - a[1]);
      const where = top ? regionOfSource(top[0]) : undefined;
      const worse = counts[4]! + counts[5]! + counts[6]!;
      const label = worse > 0 ? 'mauvais ou pire' : 'dégradé';
      parts.push(`${label} dans ${degraded.toLocaleString('fr-FR')} zone${degraded > 1 ? 's' : ''}${where ? `, surtout en ${where}` : ''}`);
    }
    parts.push(...episodePhrases(data, data.days[day]!));
    return `Air : ${parts.join(', ')}`;
  },

  native: {
    add(map) {
      shown = undefined;
      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer(
        {
          id: FIELD_ID,
          type: 'circle',
          source: SOURCE_ID,
          layout: { 'circle-sort-key': 0 },
          paint: {
            'circle-radius': radiusExpression() as never,
            'circle-color': colorExpression(0) as never,
            'circle-opacity': opacityAt(0),
            // Flou de loin (un champ continu), net de près (des pastilles, cernées d'un fin contour).
            'circle-blur': ['interpolate', ['linear'], ['zoom'], 4, 1, 8, 0.85, 11, 0.45, 13, 0.2] as never,
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9.5, 0, 12, 0.8] as never,
            'circle-stroke-color': strokeAt(0),
            'circle-pitch-alignment': 'map',
            'circle-pitch-scale': 'map',
          },
        },
        firstSymbolLayerId(map),
      );
      // La zone choisie : liseré blanc cerné de sombre, sans teinte (la couleur dit la qualité de l'air).
      const ring = (id: string, color: string, width: number, extra: number) => ({
        id,
        type: 'circle' as const,
        source: SOURCE_ID,
        filter: ['==', ['get', 'i'], -1] as never,
        paint: {
          'circle-radius': radiusExpression(extra) as never,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': color,
          'circle-stroke-width': width,
          'circle-pitch-alignment': 'map' as const,
        },
      });
      map.addLayer(ring(`${SELECTED_ID}-contour`, INK, 5, 1), firstSymbolLayerId(map));
      map.addLayer(ring(SELECTED_ID, '#ffffff', 2.4, 1), firstSymbolLayerId(map));
    },
    update(map, { data, time, selection, night }) {
      if (data) {
        const day = dayIndexAt(data, time);
        const quantizedNight = Math.round(night * 8) / 8;
        if (!shown || shown.data !== data) (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(data.geo as never);
        if (!shown || shown.data !== data || shown.day !== day || shown.night !== quantizedNight) {
          applyDay(map, day, quantizedNight);
          shown = { data, day, night: quantizedNight };
        }
      }
      const index = (selection as { i: number } | null)?.i ?? -1;
      for (const id of [SELECTED_ID, `${SELECTED_ID}-contour`]) if (map.getLayer(id)) map.setFilter(id, ['==', ['get', 'i'], index] as never);
    },
    remove(map) {
      for (const id of [SELECTED_ID, `${SELECTED_ID}-contour`, FIELD_ID]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      shown = undefined;
    },
    pickable: {
      layerIds: [FIELD_ID],
      toObject: (feature) => ({ i: Number(feature.properties?.i) }),
    },
  },

  select(object) {
    const i = (object as { i: number }).i;
    return Number.isInteger(i) && i >= 0 ? { i } : null;
  },

  focus(selection, { data }) {
    const i = (selection as { i: number } | null)?.i;
    return data && i !== undefined && data.zones.name[i] !== undefined ? { lon: data.zones.lon[i]!, lat: data.zones.lat[i]!, fixed: true } : null;
  },

  describe(selection, { data, time }): InfoContent | null {
    const zone = (selection as { i: number }).i;
    if (!data || data.zones.name[zone] === undefined) return null;
    // Atmo HDF écrit ses communes en capitales : « GRAND-FORT-PHILIPPE » devient « Grand-Fort-Philippe ».
    const name = titleCase(data.zones.name[zone]!);
    const source = data.sources[data.zones.src[zone]!] ?? '';
    const region = regionOfSource(source);
    const subtitle = `${data.zones.epci[zone] ? 'Intercommunalité' : 'Commune'} · ${source}${region ? ` (${region})` : ''}`;
    const day = dayIndexAt(data, time);
    const level = day < 0 ? 0 : levelOf(data, zone, day);
    if (level === 0) {
      return {
        kind: 'Qualité de l’air',
        title: name,
        subtitle,
        note: 'Pas d’indice publié pour cette zone à cette date : l’indice ne couvre que le jour même et les jours à venir, il n’y a pas d’historique.',
      };
    }
    const dayText = dayName(data.days[day]!);
    const published = data.issuedAt ? ` · publié à ${formatTime(data.issuedAt * 1000)}` : '';
    const isToday = data.days[day] === dayKey(Date.now());
    const subs = POLLUTANTS.map((p, k) => ({ ...p, level: levelOf(data, zone, day, k + 1) }));
    const maxSub = Math.max(...subs.map((s) => s.level));
    const dominant = maxSub >= 2 ? subs.filter((s) => s.level === maxSub) : [];
    const dominantText = dominant.length === 0 ? 'Aucun' : dominant.length > 2 ? 'Plusieurs' : dominant.map((s) => s.short.replace(/^./, (c) => c.toUpperCase())).join(' et ');

    const department = departmentOf(data, zone);
    const episodes = department ? data.episodes.filter((e) => e.day === data.days[day] && episodeCovers(e, department)) : [];

    const content: InfoContent = {
      kind: `Qualité de l’air · ${LEVELS[level]!.name.toLowerCase()}`,
      title: name,
      subtitle,
      // L'indice est calculé par les associations (mesures et modèles) puis publié : ce n'est pas un relevé direct.
      status: isToday ? plainStatus(`Indice du jour${published}`) : scheduledStatus(`Prévision pour ${dayText}${published}`),
      figures: [
        { value: LEVELS[level]!.name, label: `indice ATMO (${level} sur 6)` },
        { value: dominantText, label: dominant.length > 1 ? 'polluants dominants' : 'polluant dominant' },
        ...(episodes.length > 0 ? [{ value: EPISODE_LEVELS[Math.max(...episodes.map((e) => e.level))]!.split(' ')[0]!, label: 'épisode de pollution' }] : []),
      ],
      tables: [
        {
          title: `Sous-indices par polluant · ${dayText}`,
          columns: ['Polluant', 'Niveau'],
          rows: subs.map((s) => ({
            cells: [s.name, s.level === 0 ? 'non évalué' : `${LEVELS[s.level]!.name} (${s.level})`],
            tone: dominant.includes(s) ? ('current' as const) : undefined,
          })),
        },
        ...(episodes.length > 0
          ? [
              {
                title: 'Épisodes de pollution',
                columns: ['Polluant', 'Zone', 'Niveau'],
                rows: episodes.map((e) => ({ cells: [pollutantShort(e.pol).replace(/^./, (c) => c.toUpperCase()), episodeZoneName(e), EPISODE_LEVELS[e.level] ?? ''], tone: e.level >= 2 ? ('alert' as const) : undefined })),
              },
            ]
          : []),
      ],
      note: `${LEVELS[level]!.text} L’indice global est le plus élevé des cinq sous-indices.`,
      actions: [{ label: 'Indice ATMO sur Atmo France', href: 'https://www.atmo-france.org/article/lindice-atmo' }],
    };
    return content;
  },
});
