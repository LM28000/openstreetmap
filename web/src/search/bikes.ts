/** Stations de vélos en libre-service : par nom de station ou de réseau (« Vélib Bastille »). */
import type { BikesData, Station } from '../modules/bikes';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'velos';
const MAX_RESULTS = 5;

const build = indexed<BikesData, Array<{ text: string; station: Station }>>((data) =>
  data.stations.map((station) => ({ text: pad(`${station.name} ${station.network}`), station })),
);

export const bikesProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<BikesData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<BikesData>(ctx.manager, MODULE);
    if (!data) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const top = new TopK<Station>(MAX_RESULTS);
    for (const { text, station } of build(data)) {
      const match = matchScore(text, query);
      // En service avant hors service : une station fermée est rarement celle qu'on cherche.
      if (match > 0) top.push(rank(text, query, match) + bonus + (station.renting ? 3 : 0), station);
    }
    return top.result().map(({ score, item: station }): SearchResult => ({
      key: `velo:${station.key}`,
      kind: 'velo',
      title: station.name || 'Station',
      subtitle: station.network,
      live: station.renting ? `${station.bikes} vélo${station.bikes > 1 ? 's' : ''} · ${station.docks} place${station.docks > 1 ? 's' : ''}` : 'hors service',
      score,
      run: () => openObject(ctx.manager, MODULE, { key: station.key }, { fallback: station, zoom: 16 }),
    }));
  },
};
