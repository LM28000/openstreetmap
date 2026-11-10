/** Navires : par nom, numéro MMSI, indicatif radio ou numéro OMI. */
import type { Ship, ShipsData } from '../modules/ships';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'bateaux';
const MAX_RESULTS = 5;

const build = indexed<ShipsData, Array<{ text: string; ship: Ship }>>((data) =>
  data.ships.map((ship) => ({
    text: pad([ship.name, ship.mmsi, ship.callSign, ship.imo].filter(Boolean).join(' ')),
    ship,
  })),
);

export const shipsProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<ShipsData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<ShipsData>(ctx.manager, MODULE);
    if (!data) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const top = new TopK<Ship>(MAX_RESULTS);
    for (const { text, ship } of build(data)) {
      const match = matchScore(text, query);
      if (match > 0) top.push(rank(text, query, match) + bonus, ship);
    }
    return top.result().map(({ score, item: ship }): SearchResult => ({
      key: `navire:${ship.mmsi}`,
      kind: 'navire',
      title: ship.name ?? `Navire ${ship.mmsi}`,
      subtitle: [ship.destination ? `vers ${ship.destination}` : undefined, `MMSI ${ship.mmsi}`].filter(Boolean).join(' · '),
      live: ship.moving ? (ship.sog !== undefined ? `${Math.round(ship.sog)} nœuds` : 'en route') : 'à l’arrêt',
      score,
      run: () => openObject(ctx.manager, MODULE, { mmsi: ship.mmsi }, { fallback: ship, zoom: 12, liveOnly: true }),
    }));
  },
};
