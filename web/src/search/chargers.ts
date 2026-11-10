/** Bornes de recharge : par nom, opérateur ou adresse (53 000 stations : texte replié une fois par chargement). */
import type { ChargersData, Station } from '../modules/chargers';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'bornes';
const MAX_RESULTS = 5;

const build = indexed<ChargersData, { texts: string[]; stations: Station[] }>((data) => ({
  texts: data.stations.map((s) => pad(`${s.name} ${s.operator} ${s.address}`)),
  stations: data.stations,
}));

export const chargersProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<ChargersData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<ChargersData>(ctx.manager, MODULE);
    if (!data) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const { texts, stations } = build(data);
    const top = new TopK<Station>(MAX_RESULTS);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const match = matchScore(text, query);
      if (match > 0) top.push(rank(text, query, match) + bonus, stations[i]!);
    }
    return top.result().map(({ score, item: station }): SearchResult => ({
      key: `borne:${station.id}`,
      kind: 'borne',
      title: station.name || 'Station de recharge',
      subtitle: [station.operator, station.address].filter(Boolean).join(' · ') || undefined,
      live: station.kw > 0 ? `${Math.round(station.kw)} kW` : undefined,
      score,
      run: () => openObject(ctx.manager, MODULE, { id: station.id }, { fallback: station, zoom: 16 }),
    }));
  },
};
