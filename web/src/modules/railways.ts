/**
 * Module « Voies ferrées » : les lignes qu'empruntent les trains de voyageurs, telles
 * que le serveur les a calculées sur les voies OpenStreetMap (le réseau partagé avec
 * la couche « Trains », voir railNetwork.ts).
 *
 * Deux modes : un trait discret, pour situer les trains, ou une couleur par vitesse
 * maximale de la ligne (donnée `maxspeed` d'OSM), du gris clair (lent) au gris
 * foncé (rapide), sans teinte. Un liseré clair sépare les lignes du fond, de jour comme sous
 * l'ombre de la nuit.
 */
import type { Color } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { defineModule, type InfoFigure } from '../core/module';
import { plainStatus } from '../core/infoStatus';
import { fetchJson, loadNetwork, type RailNetwork, trackAt } from './railNetwork';
import { OVER_MAP } from '../map/parameters';
import { KEY } from './symbols';

/** Une portion de tracé de vitesse maximale constante. */
interface Run {
  /** Indice du tracé dans le réseau. */
  track: number;
  /** Vitesse maximale, km/h (0 : inconnue). */
  limit: number;
  /** Sommets dans le tracé : [first, last]. */
  first: number;
  last: number;
  /** Sommets [lon, lat, z] à plat, recalculés quand l'exagération du relief change. */
  path: Float64Array;
  lengthM: number;
}

interface RailsData {
  net: RailNetwork;
  runs: Run[];
  runsByTrack: Map<number, Run[]>;
  /** Exagération du relief appliquée aux chemins (−1 : à calculer). */
  exaggeration: number;
  pathVersion: number;
}

type SpeedClass = 'inconnue' | 'lente' | 'moyenne' | 'rapide' | 'lgv';

/**
 * Rampe ordinale neutre, validée (claire = lente, foncée = rapide) : les voies sont
 * l'infrastructure, elles ne doivent pas prendre les couleurs des véhicules (trains,
 * avions). L'épaisseur double la couleur.
 */
const SPEEDS: Record<SpeedClass, { color: [number, number, number]; css: string; label: string; width: number }> = {
  inconnue: { color: [201, 203, 209], css: '#c9cbd1', label: 'Vitesse inconnue (trait fin)', width: 1 },
  lente: { color: [163, 166, 176], css: '#a3a6b0', label: 'Jusqu’à 100 km/h', width: 1.75 },
  moyenne: { color: [120, 124, 136], css: '#787c88', label: '101 à 160 km/h', width: 2.25 },
  rapide: { color: [79, 83, 95], css: '#4f535f', label: '161 à 220 km/h', width: 2.75 },
  lgv: { color: [38, 41, 51], css: '#262933', label: 'Plus de 220 km/h (LGV)', width: 3.5 },
};
const SPEED_ORDER: SpeedClass[] = ['lgv', 'rapide', 'moyenne', 'lente', 'inconnue'];
/** Trait discret : gris sombre sur le fond de jour, gris clair sur le fond de nuit (sinon il s'y perd). */
const DISCREET_DAY: Color = [52, 58, 76, 170];
const DISCREET_NIGHT: Color = [140, 148, 166, 175];
const discreet = (night: number): Color =>
  DISCREET_DAY.map((value, i) => Math.round(value + ((DISCREET_NIGHT[i] ?? value) - value) * night)) as unknown as Color;
const CASING: Color = [255, 255, 255, 150];
const FAR_ZOOM = 7;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function speedClass(limit: number): SpeedClass {
  if (limit <= 0) return 'inconnue';
  if (limit <= 100) return 'lente';
  if (limit <= 160) return 'moyenne';
  if (limit <= 220) return 'rapide';
  return 'lgv';
}

/**
 * Découpe chaque tracé en portions de même vitesse maximale.
 *
 * Les tracés se superposent (un TGV direct et un TER omnibus suivent les mêmes voies
 * entre des gares différentes) : les plus longs sont dessinés d'abord, pour qu'un clic
 * désigne le tronçon le plus court, donc le plus local, sous le pointeur.
 */
function build(net: RailNetwork): RailsData {
  const runs: Run[] = [];
  const runsByTrack = new Map<number, Run[]>();
  const order = Array.from({ length: net.trackCount }, (_, index) => {
    const track = trackAt(net, index);
    return { index, length: track && track.along.length > 0 ? track.along[track.along.length - 1]! : 0 };
  }).sort((a, b) => b.length - a.length);
  for (const { index } of order) {
    const track = trackAt(net, index);
    if (!track || track.lon.length < 2) continue;
    const n = track.lon.length;
    const ofTrack: Run[] = [];
    let first = 0;
    for (let k = 1; k < n; k++) {
      // La portion k-1 → k a la vitesse du point k-1 ; on coupe quand elle change.
      if (k < n - 1 && track.limit[k] === track.limit[first]) continue;
      const limit = track.limit[first]!;
      const lengthM = track.along[k]! - track.along[first]!;
      const run: Run = { track: index, limit, first, last: k, path: new Float64Array((k - first + 1) * 3), lengthM };
      ofTrack.push(run);
      first = k;
    }
    runs.push(...ofTrack);
    runsByTrack.set(index, ofTrack);
  }
  return { net, runs, runsByTrack, exaggeration: -1, pathVersion: 0 };
}

/** Pose les chemins à l'altitude du rail, avec l'exagération actuelle du relief. */
function refreshPaths(data: RailsData, exaggeration: number): void {
  if (data.exaggeration === exaggeration) return;
  for (const run of data.runs) {
    const track = trackAt(data.net, run.track)!;
    for (let k = run.first, i = 0; k <= run.last; k++, i += 3) {
      run.path[i] = track.lon[k]!;
      run.path[i + 1] = track.lat[k]!;
      run.path[i + 2] = track.z[k]! * exaggeration;
    }
  }
  data.exaggeration = exaggeration;
  data.pathVersion++;
}

let built: RailsData | undefined;

export const railways = defineModule<RailsData>({
  id: 'voies',
  name: 'Voies ferrées',
  category: 'transport',
  description: 'Les lignes empruntées par les trains de voyageurs, et leur vitesse maximale.',
  attribution: 'voies et vitesses © OpenStreetMap — ODbL',
  visibleByDefault: true,
  // Le réseau change au plus une fois par jour, mais juste après un redémarrage du serveur les
  // tracés ne sont pas encore prêts : on revérifie souvent (une petite requête, rien n'est
  // redessiné tant que la version ne change pas).
  refreshIntervalMs: 2 * 60_000,
  timeStepMs: 3_600_000, // ne dépend pas de l'instant affiché
  followsTerrain: true,
  // Sous les trains, quelle que soit sa place dans le panneau.
  drawOrder: -1,
  zoomBreaks: [FAR_ZOOM],

  settings: [
    {
      id: 'couleur',
      label: 'Couleur',
      options: [
        { value: 'discret', label: 'Discrète' },
        { value: 'vitesse', label: 'Par vitesse' },
      ],
      defaultValue: 'discret',
    },
  ],

  legend(settings) {
    if (settings.couleur !== 'vitesse') return [{ color: 'rgb(52, 58, 76)', label: 'Ligne empruntée par des trains de voyageurs', size: 'small' }];
    return SPEED_ORDER.map((c) => ({ color: SPEEDS[c].css, label: SPEEDS[c].label, size: 'small' as const }));
  },

  async load({ signal }) {
    const { version } = await fetchJson<{ version: string }>('/api/reseau', signal);
    // Même version : mêmes données (deck.gl n'a alors rien à renvoyer à la carte graphique).
    if (built?.net.version === version) return built;
    const net = await loadNetwork(version, signal);
    if (net.trackCount === 0) throw new Error('le serveur calcule encore les tracés, nouvel essai dans quelques minutes');
    built = build(net);
    return built;
  },

  summary({ data }) {
    if (!data) return null;
    // (Pas de total en kilomètres : les tronçons se superposent, il compterait des voies plusieurs fois.)
    return `${data.runsByTrack.size.toLocaleString('fr-FR')} tronçons entre gares`;
  },

  deckLayers({ data, terrain, settings, selection, view, night }) {
    if (!data) return [];
    const discreetColor = discreet(night);
    refreshPaths(data, terrain.exaggeration);
    const bySpeed = settings.couleur === 'vitesse';
    const parameters = OVER_MAP;
    // Vu de loin, les lignes se touchent : traits plus fins.
    const scale = view.zoom < FAR_ZOOM ? 0.65 : 1;
    const width = (run: Run) => (bySpeed ? SPEEDS[speedClass(run.limit)].width : 1.25);
    const chosen = selection ? data.runsByTrack.get((selection as { track: number }).track) : undefined;
    const common = {
      positionFormat: 'XYZ' as const,
      _pathType: 'open' as const,
      getPath: (run: Run) => run.path,
      widthUnits: 'pixels' as const,
      capRounded: true,
      jointRounded: true,
      parameters,
    };
    return [
      // Liseré clair sous les couleurs, pour les détacher du fond de jour comme de nuit.
      bySpeed &&
        new PathLayer<Run>({
          ...common,
          id: 'voies/liseré',
          data: data.runs,
          getColor: CASING,
          getWidth: (run) => width(run) + 1.5,
          widthScale: scale,
          updateTriggers: { getPath: data.pathVersion },
        }),
      new PathLayer<Run>({
        ...common,
        id: 'voies/lignes',
        data: data.runs,
        getColor: (run) => (bySpeed ? [...SPEEDS[speedClass(run.limit)].color, 255] : discreetColor),
        getWidth: width,
        widthScale: scale,
        // Pas d'autoHighlight : il casserait les clics sur les trains dessinés au-dessus.
        pickable: true,
        updateTriggers: { getPath: data.pathVersion, getColor: [bySpeed, discreetColor.join()], getWidth: bySpeed },
      }),
      // Sélection : une bande blanche cernée d'un trait sombre, comme l'anneau des points (jamais bleue).
      chosen &&
        new PathLayer<Run>({
          ...common,
          id: 'voies/choisie-blanc',
          data: chosen,
          getColor: [255, 255, 255, 245],
          getWidth: 8,
          updateTriggers: { getPath: data.pathVersion },
        }),
      chosen &&
        new PathLayer<Run>({
          ...common,
          id: 'voies/choisie-sombre',
          data: chosen,
          getColor: KEY,
          getWidth: 3,
          updateTriggers: { getPath: data.pathVersion },
        }),
    ];
  },

  select(object) {
    const run = object as Run;
    return { track: run.track, limit: run.limit };
  },

  describe(selection, { data }) {
    if (!data) return null;
    const { track, limit } = selection as { track: number; limit: number };
    const runs = data.runsByTrack.get(track);
    if (!runs) return null;
    const [a, b] = data.net.ends[track] ?? [];
    const from = a !== undefined ? data.net.stations[a]?.name : undefined;
    const to = b !== undefined ? data.net.stations[b]?.name : undefined;
    const total = runs.reduce((sum, run) => sum + run.lengthM, 0);
    // Répartition par classe de vitesse (celles de la légende), de la plus rapide à la plus lente.
    const byClass = new Map<SpeedClass, number>();
    for (const run of runs) byClass.set(speedClass(run.limit), (byClass.get(speedClass(run.limit)) ?? 0) + run.lengthM);
    const top = Math.max(...runs.map((run) => run.limit));
    const shares = SPEED_ORDER.filter((c) => byClass.has(c)).map(
      (c) => `${lowerFirst(SPEEDS[c].label.replace(' (trait fin)', ''))} : ${Math.max(1, Math.round(((byClass.get(c) ?? 0) / total) * 100))} %`,
    );
    const lonLat = runs[Math.floor(runs.length / 2)]?.path;
    const speed = (value: number, label: string): InfoFigure =>
      value > 0 ? { value: String(value), unit: 'km/h', label } : { value: '—', label };
    return {
      kind: 'Voie ferrée',
      title: from && to ? `${from} – ${to}` : 'Voie ferrée',
      subtitle: 'tronçon entre deux gares',
      // Données d'OpenStreetMap, pas un relevé : pastille sans point.
      status: plainStatus('Vitesses d’après OpenStreetMap'),
      figures: [
        speed(limit, 'vitesse max ici'),
        { value: (total / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }), unit: 'km', label: 'de long' },
        speed(top, 'max du tronçon'),
      ],
      fields: [['Répartition', shares.join(' · ')]],
      note: 'Vitesses maximales de la ligne d’après OpenStreetMap : les trains roulent souvent moins vite (arrêts, matériel, horaires).',
      actions: lonLat
        ? [
            {
              label: 'OpenRailwayMap',
              href: `https://www.openrailwaymap.org/?style=maxspeed&lat=${lonLat[1]!.toFixed(4)}&lon=${lonLat[0]!.toFixed(4)}&zoom=12`,
            },
          ]
        : undefined,
    };
  },
});
