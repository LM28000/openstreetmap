/** Avions : par indicatif (AFR1234), immatriculation (F-GKXA), type (A320) ou code ICAO. */
import type { Plane, PlanesData, PlanesSelection } from '../modules/planes';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'avions';
const MAX_RESULTS = 5;

const build = indexed<PlanesData, Array<{ text: string; plane: Plane }>>((data) =>
  data.planes.map((plane) => ({
    text: pad([plane.callsign, plane.registration, plane.type, plane.hex].filter(Boolean).join(' ')),
    plane,
  })),
);

export const planesProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<PlanesData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<PlanesData>(ctx.manager, MODULE);
    if (!data) return [];
    const bonus = shownBonus(ctx.manager, MODULE);
    const top = new TopK<Plane>(MAX_RESULTS);
    for (const { text, plane } of build(data)) {
      const match = matchScore(text, query);
      if (match === 0) continue;
      // À correspondance égale, un avion en vol passe devant un avion au sol.
      top.push(rank(text, query, match) + bonus + (plane.ground ? 0 : 5), plane);
    }
    return top.result().map(({ score, item: plane }): SearchResult => {
      const name = plane.callsign ?? plane.registration ?? plane.hex.toUpperCase();
      return {
        key: `avion:${plane.hex}`,
        kind: 'avion',
        title: name,
        subtitle: [plane.type, plane.registration && plane.registration !== name ? plane.registration : undefined, `ICAO ${plane.hex.toUpperCase()}`]
          .filter(Boolean)
          .join(' · '),
        live: plane.ground ? 'au sol' : plane.altM !== null ? `${Math.round(plane.altM).toLocaleString('fr-FR')} m` : undefined,
        score,
        run: () =>
          openObject(ctx.manager, MODULE, { hex: plane.hex } satisfies PlanesSelection, {
            fallback: plane,
            zoom: 10,
            liveOnly: true,
          }),
      };
    });
  },
};
