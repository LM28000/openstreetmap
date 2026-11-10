/**
 * Gares et trains : par nom de gare, par numéro ou par nom de ligne.
 *
 * Les trains ne sont cherchés que par numéro, catégorie et ligne (pas par gare
 * desservie) : « Lyon » doit proposer des lieux et des gares, pas deux cents TER.
 */
import type { Station, Train, TrainsData, TrainsSelection } from '../modules/trains';
import { formatTime } from '../ui/format';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK, type Query } from './normalize';
import type { Provider, SearchContext, SearchResult } from './types';

const MODULE = 'trains';
const MAX_STATIONS = 5;
const MAX_TRAINS = 4;
/** Retrait d'un train trouvé par sa ligne et non par son numéro. */
const LINE_ONLY_PENALTY = 90;

interface Index {
  stations: Array<{ text: string; station: Station }>;
  trains: Array<{ text: string; line: string; train: Train }>;
}

const CATEGORY_NAMES: Record<string, string> = {
  'Train TER': 'TER',
  INTERCITES: 'Intercités',
  'INTERCITES de nuit': 'Intercités de nuit',
  TramTrain: 'Tram-train',
};
const categoryName = (category: string) => CATEGORY_NAMES[category] ?? category;

const build = indexed<TrainsData, Index>((data) => ({
  stations: data.stations.map((station) => ({ text: pad(station.name), station })),
  // « TGV INOUI 6623 » d'un côté, la ligne (« Amiens - Arras ») de l'autre : la ligne est une route, donc moins précise.
  trains: data.trains.map((train) => ({ text: pad(`${categoryName(train.category)} ${train.number}`), line: pad(train.line), train })),
}));

export const trainsProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<TrainsData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<TrainsData>(ctx.manager, MODULE);
    if (!data) return [];
    const index = build(data);
    const bonus = shownBonus(ctx.manager, MODULE);
    return [...searchStations(index, query, ctx, bonus), ...searchTrains(index, query, ctx, bonus)];
  },
};

function searchStations(index: Index, query: Query, ctx: SearchContext, bonus: number): SearchResult[] {
  const top = new TopK<Station>(MAX_STATIONS);
  for (const { text, station } of index.stations) {
    const match = matchScore(text, query, true);
    if (match > 0) top.push(rank(text, query, match) + bonus, station);
  }
  return top.result().map(({ score, item: station }) => {
    const departures = departuresWithinHour(station, ctx.time / 1000);
    return {
      key: `gare:${station.key}`,
      kind: 'gare',
      title: station.name,
      subtitle: 'Gare · tableau d’affichage',
      live: `${departures} départ${departures > 1 ? 's' : ''} dans l’heure`,
      score,
      run: () =>
        openObject(ctx.manager, MODULE, { type: 'gare', key: station.key } satisfies TrainsSelection, {
          fallback: station,
          zoom: 14,
        }),
    };
  });
}

function searchTrains(index: Index, query: Query, ctx: SearchContext, bonus: number): SearchResult[] {
  const t = ctx.time / 1000;
  const top = new TopK<Train>(MAX_TRAINS);
  for (const { text, line, train } of index.trains) {
    let match = matchScore(text, query);
    let base = match > 0 ? rank(text, query, match) : 0;
    if (match === 0) {
      // Trouvé par sa ligne seulement : « lyon » ne doit pas noyer les gares sous les TER qui y passent.
      match = matchScore(line, query);
      if (match === 0) continue;
      base = rank(line, query, match) - LINE_ONLY_PENALTY;
    }
    // Un train qui roule passe devant celui qui partira, et devant celui qui est arrivé.
    const phase = phaseOf(train, t);
    const timing = phase === 'roule' ? 40 : phase === 'attend' ? 10 : -60;
    top.push(base + timing + bonus, train);
  }
  return top.result().map(({ score, item: train }) => {
    const last = train.stations[train.stations.length - 1];
    const first = train.stations[0];
    const phase = phaseOf(train, t);
    const delay = phase === 'roule' ? currentDelay(train, t) : null;
    const route = `${first?.name ?? '?'} → ${last?.name ?? '?'}`;
    let subtitle: string;
    if (phase === 'roule') subtitle = `${route} · arrivée ${formatTime((train.arr[train.arr.length - 1] ?? 0) * 1000)}`;
    else if (phase === 'attend') subtitle = `${route} · départ ${formatTime((train.dep[0] ?? 0) * 1000)}`;
    else subtitle = `${route} · terminé`;
    const late = delay !== null && delay >= 300;
    return {
      key: `train:${train.id}`,
      kind: 'train',
      title: `${categoryName(train.category)} ${train.number}`,
      subtitle,
      live: delay === null ? undefined : delay >= 60 ? `+${Math.round(delay / 60)} min` : 'à l’heure',
      liveTone: late ? 'alert' : undefined,
      score,
      run: () =>
        openObject(ctx.manager, MODULE, { type: 'train', id: train.id } satisfies TrainsSelection, {
          fallback: first ?? { lon: 2.35, lat: 46.8 },
          zoom: 11,
        }),
    };
  });
}

function phaseOf(train: Train, t: number): 'roule' | 'attend' | 'fini' {
  if (t < (train.dep[0] ?? Infinity)) return 'attend';
  if (t > (train.arr[train.arr.length - 1] ?? -Infinity)) return 'fini';
  return 'roule';
}

/** Retard (secondes) au dernier arrêt quitté, `null` sans temps réel pour ce train. */
function currentDelay(train: Train, t: number): number | null {
  if (!train.realtime) return null;
  let stop = 0;
  while (stop + 1 < train.dep.length && (train.dep[stop + 1] ?? Infinity) <= t) stop++;
  return (train.dep[stop] ?? 0) - (train.plannedDep[stop] ?? 0);
}

function departuresWithinHour(station: Station, t: number): number {
  let count = 0;
  for (const { run, stop } of station.visits) {
    if (run.canceled || stop >= run.stations.length - 1) continue;
    const at = run.dep[stop] ?? 0;
    if (at >= t - 60 && at <= t + 3600) count++;
  }
  return count;
}
