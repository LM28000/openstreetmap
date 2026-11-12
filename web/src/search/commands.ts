/** Commandes : aller à une date, revenir au direct, relief, globe, pause. */
import { clock } from '../core/clock';
import { tour } from '../core/tour';
import { TERRAIN_EXAGGERATION, TERRAIN_SOURCE } from '../map/baseMap';
import { mapOf } from './access';
import { FUTURE_LIMIT_MS, isLiveWord, parseWhen, PAST_LIMIT_MS } from './dates';
import { matchScore, pad, rank } from './normalize';
import type { Provider, SearchResult } from './types';

const COMMAND_BONUS = 100;

export const commandsProvider: Provider = {
  search(query, { manager }) {
    const out: SearchResult[] = [];

    const when = parseWhen(query.raw);
    if (when) {
      out.push({
        key: `date:${when.at}`,
        kind: 'action',
        title: `Aller à ${when.label}`,
        subtitle: when.clamped
          ? `Ramené à la limite de la frise (${PAST_LIMIT_MS / 86_400_000} jours en arrière, ${FUTURE_LIMIT_MS / 86_400_000} en avant)`
          : 'Placer la frise à ce moment',
        score: 500,
        run: () => clock.seek(when.at),
      });
    }

    if (isLiveWord(query.raw)) {
      out.push({
        key: 'direct',
        kind: 'action',
        title: 'Revenir au direct',
        subtitle: 'Le présent, en temps réel',
        score: 500,
        run: () => clock.goLive(),
      });
    }

    const map = mapOf(manager);
    const terrainOn = map?.getTerrain() != null;
    const globeOn = map?.getProjection()?.type === 'globe';
    const commands: Array<{ key: string; keywords: string; title: string; subtitle: string; run: () => void }> = [
      {
        key: 'relief',
        keywords: 'relief 3d montagne altitude terrain',
        title: terrainOn ? 'Désactiver le relief 3D' : 'Activer le relief 3D',
        subtitle: 'Commande de la carte',
        run: () => {
          if (!map) return;
          map.setTerrain(terrainOn ? null : { source: TERRAIN_SOURCE, exaggeration: TERRAIN_EXAGGERATION });
        },
      },
      {
        key: 'globe',
        keywords: 'globe terre sphere planete carte plate',
        title: globeOn ? 'Revenir à la carte à plat' : 'Afficher le globe',
        subtitle: 'Commande de la carte',
        run: () => map?.setProjection({ type: globeOn ? 'mercator' : 'globe' }),
      },
      {
        key: 'visite',
        keywords: 'visite guidee tour demo demonstration presentation decouverte parcours',
        title: 'Lancer la visite guidée',
        subtitle: 'Douze étapes en trois minutes',
        run: () => void tour.start(manager),
      },
      {
        key: 'pause',
        keywords: 'pause lecture arreter reprendre temps',
        title: clock.getState().playing ? 'Mettre le temps en pause' : 'Reprendre le temps',
        subtitle: 'Commande de la frise',
        run: () => clock.toggle(),
      },
    ];
    for (const command of commands) {
      const text = pad(`${command.keywords} ${command.title}`);
      const match = matchScore(text, query, true);
      if (match > 0) out.push({ key: `commande:${command.key}`, kind: 'action', title: command.title, subtitle: command.subtitle, score: rank(text, query, match) + COMMAND_BONUS, run: command.run });
    }
    return out;
  },
};
