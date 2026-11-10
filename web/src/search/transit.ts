/**
 * Bus, trams et métros : réseaux (« TCL », « RATP ») et lignes (« métro 14 », « T3 »).
 *
 * Seules les lignes qui ont un véhicule dans les données y figurent : le serveur
 * n'envoie pas le catalogue complet des lignes.
 */
import type { Line, Network, TransitData, TransitSelection, Vehicle } from '../modules/transit';
import { dataOf, indexed, openObject, shownBonus } from './access';
import { matchScore, pad, rank, TopK } from './normalize';
import type { Provider, SearchResult } from './types';

const MODULE = 'transports';
const MAX_NETWORKS = 3;
const MAX_LINES = 4;

const MODE_LABELS: Record<string, string> = {
  bus: 'Bus',
  tram: 'Tramway',
  metro: 'Métro',
  train: 'Train',
  ferry: 'Bateau',
  cable: 'Câble',
};

interface LineEntry {
  line: Line;
  vehicles: Vehicle[];
  title: string;
}

interface Index {
  networks: Array<{ text: string; network: Network }>;
  lines: Array<{ text: string; entry: LineEntry }>;
}

const build = indexed<TransitData, Index>((data) => {
  const byLine = new Map<Line, Vehicle[]>();
  for (const vehicle of data.vehicles) {
    const list = byLine.get(vehicle.line);
    if (list) list.push(vehicle);
    else byLine.set(vehicle.line, [vehicle]);
  }
  const lines: Index['lines'] = [];
  for (const [line, vehicles] of byLine) {
    const name = line.name ?? line.id;
    if (!name) continue; // une ligne sans nom ne se cherche pas
    const mode = MODE_LABELS[line.mode ?? ''] ?? 'Ligne';
    const title = `${mode} ${name}`;
    lines.push({
      text: pad(`${title} ligne ${line.longName ?? ''} ${line.network.name}`),
      entry: { line, vehicles, title },
    });
  }
  return { networks: data.networks.map((network) => ({ text: pad(network.name), network })), lines };
});

export const transitProvider: Provider = {
  warm({ manager }) {
    const data = dataOf<TransitData>(manager, MODULE);
    if (data) build(data);
  },

  search(query, ctx) {
    const data = dataOf<TransitData>(ctx.manager, MODULE);
    if (!data) return [];
    const index = build(data);
    const bonus = shownBonus(ctx.manager, MODULE);
    const out: SearchResult[] = [];

    const networks = new TopK<Network>(MAX_NETWORKS);
    for (const { text, network } of index.networks) {
      const match = matchScore(text, query, true);
      if (match > 0) networks.push(rank(text, query, match) + bonus, network);
    }
    for (const { score, item: network } of networks.result()) {
      out.push({
        key: `reseau:${network.name}`,
        kind: 'reseau',
        title: network.name,
        subtitle: 'Réseau de transport',
        live: `${network.count.toLocaleString('fr-FR')} véhicule${network.count > 1 ? 's' : ''}`,
        score,
        run: () =>
          openObject(ctx.manager, MODULE, { type: 'network', name: network.name } satisfies TransitSelection, {
            fallback: network,
            zoom: 9.5,
            liveOnly: true,
          }),
      });
    }

    const lines = new TopK<LineEntry>(MAX_LINES);
    for (const { text, entry } of index.lines) {
      const match = matchScore(text, query);
      // Une ligne plus fournie en véhicules est plus probablement celle qu'on cherche.
      if (match > 0) lines.push(rank(text, query, match) + bonus + Math.min(entry.vehicles.length, 20) * 0.1, entry);
    }
    for (const { score, item: entry } of lines.result()) {
      const center = centroid(entry.vehicles);
      // On sélectionne le véhicule le plus proche du milieu de la ligne : la fiche s'ouvre sur du concret.
      const nearest = entry.vehicles.reduce((best, v) => (distance2(v, center) < distance2(best, center) ? v : best));
      out.push({
        key: `ligne:${entry.line.network.name}:${entry.title}`,
        kind: 'reseau',
        title: entry.title,
        subtitle: [entry.line.network.name, entry.line.longName].filter(Boolean).join(' · '),
        live: `${entry.vehicles.length} véhicule${entry.vehicles.length > 1 ? 's' : ''}`,
        score,
        run: () =>
          openObject(ctx.manager, MODULE, { type: 'vehicle', key: nearest.key } satisfies TransitSelection, {
            fallback: nearest,
            zoom: 12,
            liveOnly: true,
          }),
      });
    }
    return out;
  },
};

function centroid(vehicles: readonly Vehicle[]): { lon: number; lat: number } {
  let lon = 0;
  let lat = 0;
  for (const v of vehicles) {
    lon += v.lon;
    lat += v.lat;
  }
  return { lon: lon / vehicles.length, lat: lat / vehicles.length };
}

const distance2 = (a: { lon: number; lat: number }, b: { lon: number; lat: number }) => (a.lon - b.lon) ** 2 + (a.lat - b.lat) ** 2;
