/**
 * Isochrones : « depuis Rennes », « isochrone Lyon », « jusqu'où en train Nantes ».
 *
 * Seules les requêtes qui commencent par l'un de ces mots proposent des gares de départ : « Rennes »
 * seul doit rester une recherche de lieu ou de gare. Les gares viennent des données de la couche Trains.
 */
import type { Station, TrainsData } from '../modules/trains';
import { setIsochroneOrigin } from '../modules/isochrones';
import { dataOf, indexed } from './access';
import { matchScore, pad, parseQuery, rank, TopK } from './normalize';
import type { Provider } from './types';

const MAX_RESULTS = 4;
/** Mots d'introduction, déjà normalisés (sans accents), du plus long au plus court. */
const PREFIX = /^(?:ou aller en train depuis|jusqu ou en train depuis|jusqu ou en train|jusqu ou depuis|jusqu ou|isochrones|isochrone|depuis|carte des temps|temps de trajet)\s+(.+)$/;

const build = indexed<TrainsData, Array<{ text: string; station: Station }>>((data) =>
  data.stations.filter((s) => s.code).map((station) => ({ text: pad(station.name), station })),
);

export const isochronesProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<TrainsData>(manager, 'trains');
    if (data) build(data);
  },

  search(query, { manager }) {
    const rest = PREFIX.exec(query.text)?.[1];
    if (!rest) return [];
    const data = dataOf<TrainsData>(manager, 'trains');
    if (!data) return [];
    const stationQuery = parseQuery(rest);
    const top = new TopK<Station>(MAX_RESULTS);
    for (const { text, station } of build(data)) {
      const match = matchScore(text, stationQuery, true);
      // Les grandes gares d'abord : « Lyon » doit proposer Part-Dieu avant Lyon-Vaise.
      if (match > 0) top.push(rank(text, stationQuery, match) + Math.min(40, Math.log2(1 + station.perDay) * 5), station);
    }
    return top.result().map(({ score, item: station }) => ({
      key: `isochrone:${station.code}`,
      kind: 'action' as const,
      title: `Jusqu’où en train depuis ${station.name} ?`,
      subtitle: 'Isochrone ferroviaire, à l’heure de la frise',
      // Au-dessus des couches et commandes : la personne a écrit le mot qui l'annonce.
      score: score + 200,
      run: () => setIsochroneOrigin(station.code!, station),
    }));
  },
};
