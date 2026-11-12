/**
 * Les étapes de la visite guidée (voir `tour.ts` pour la mécanique).
 *
 * Une étape dit : où va la caméra, quelles couches afficher (et leurs réglages), à quel instant, ce qui prouve que ses
 * données sont là (`ready`), et la légende. Règle d'écriture : la légende ne dit que ce qu'on voit à l'écran quand `ready`
 * est vrai ; ce qui peut manquer (navires, avions la nuit) est vérifié, et sans données l'étape est passée.
 */
import { clock } from './clock';
import type { StopContext, TourHelpers } from './tour';
import { setCurtainFraction } from '../modules/aerialPhotos';
import type { PlanesData } from '../modules/planes';
import type { ShipsData } from '../modules/ships';
import type { IsochroneData } from '../modules/isochrones';

/** Choix de l'instant d'une étape. */
export type TimeSpec =
  | { kind: 'live' }
  /** Le direct s'il fait jour (7 h à 20 h à Paris), sinon l'horaire de 10 h le lendemain (les trains et les isochrones sont calculés d'après les horaires). */
  | { kind: 'day'; hour: number }
  /** Le direct s'il fait nuit (22 h à 5 h), sinon la nuit dernière à 23 h 30 ; la lecture avance à `speed` secondes par seconde. */
  | { kind: 'night'; speed: number }
  /**
   * Un moment enregistré par le serveur : la dernière fois (sur 7 jours) que `hour` a été enregistrée pour toutes les `layers`,
   * lue à `speed`. `liveBetween` : le direct convient dans cette plage d'heures. Sans enregistrement : `fallback`.
   */
  | { kind: 'recorded'; hour: number; speed: number; layers: readonly string[]; weekday?: boolean; liveBetween?: [number, number]; fallback: 'live' | 'skip' };

export interface TourStop {
  id: string;
  /** Petite ligne au-dessus du titre : le thème de l'étape. */
  kicker: string;
  title: string;
  caption: string | ((context: StopContext) => string);
  camera: { center: [number, number]; zoom: number; pitch: number; bearing: number; duration?: number };
  /** Couches affichées (toutes les autres sont masquées pendant l'étape). */
  layers: readonly string[];
  /** Réglages imposés aux couches de l'étape (par identifiant de couche). */
  settings?: Record<string, Record<string, string>>;
  time?: TimeSpec;
  /** Couche dont le résumé (un chiffre vivant) est cité sous la légende. */
  stat?: string;
  /** Prépare l'étape avant le vol (choix d'une gare de départ…). */
  prepare?(h: TourHelpers): void;
  /** Vrai quand les données de l'étape sont à l'écran. Sinon, après un délai, l'étape est passée. */
  ready(h: TourHelpers): boolean;
  readyTimeoutMs?: number;
  /** Attente supplémentaire après `ready` (couches dont on ne sait pas voir le chargement). */
  settleMs?: number;
  /** Quand la légende apparaît : sélection, suivi, animation propre à l'étape. Renvoie de quoi la défaire. */
  onReady?(h: TourHelpers): (() => void) | void;
  /** Durée de lecture de la légende, en millisecondes. */
  dwellMs: number;
}

// --- Outils des étapes ---

/** Premier nombre capturé par `pattern` dans le résumé de la couche (« 822 trains » → 822), ou 0. */
function countIn(h: TourHelpers, id: string, pattern: RegExp): number {
  const match = pattern.exec(h.summary(id) ?? '');
  return match?.[1] ? Number(match[1].replace(/[\s  ]/g, '')) : 0;
}

/** Distance approximative en kilomètres (assez juste à cette échelle). */
function km(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const dx = (a.lon - b.lon) * 111.32 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dy = (a.lat - b.lat) * 110.57;
  return Math.hypot(dx, dy);
}

const ROISSY = { lon: 2.5479, lat: 49.0097 };
/** Gare de Paris-Lyon, code UIC. */
const PARIS_LYON = '87686006';

/** Les avions en vol (ou au sol) autour de Roissy, à l'instant affiché : direct ou enregistrement. */
function planesNearRoissy(h: TourHelpers) {
  const data = h.data<PlanesData>('avions');
  if (!data) return [];
  const here = data.replay ? data.replay.present : data.planes;
  return here.filter((p) => km(p, ROISSY) < 40);
}

/** L'étape du suivi d'un avion : celui qui, en vol et assez bas, est le plus près de Roissy (approche ou départ). */
function followPlane(h: TourHelpers): (() => void) | void {
  const candidates = planesNearRoissy(h).filter((p) => !p.ground && p.altM !== null && p.altM > 150 && p.altM < 4_000 && p.speedKt > 100);
  const pool = candidates.length > 0 ? candidates : planesNearRoissy(h).filter((p) => !p.ground);
  const target = pool.sort((a, b) => km(a, ROISSY) - km(b, ROISSY))[0];
  if (!target) return;
  const { map, manager } = h;
  // Vol court jusqu'à l'avion, cap derrière lui, puis la caméra le suit (la sélection ouvre aussi sa fiche).
  const view = { center: [target.lon, target.lat] as [number, number], zoom: 15.6, pitch: 68, bearing: (target.track + 150) % 360 };
  const arrive = () => {
    if (h.cancelled()) return;
    manager.setSelection('avions', { hex: target.hex });
    manager.setFollowing(true);
  };
  // Coupure franche pour qui préfère moins de mouvement.
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    map.jumpTo(view);
    arrive();
    return;
  }
  map.flyTo({ ...view, duration: 3_000, essential: true });
  map.once('moveend', arrive);
  return () => map.off('moveend', arrive);
}

/** Fait glisser le rideau des photos : de la photo ancienne seule à la carte d'aujourd'hui, puis au milieu. */
function sweepCurtain(h: TourHelpers): () => void {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    setCurtainFraction(0.5); // rideau au milieu, sans balayage
    return () => undefined;
  }
  const t0 = performance.now();
  const from = 0.88;
  const to = 0.14;
  const back = 0.5;
  const go = 4_000;
  const rest = 6_500;
  let frame = 0;
  const step = (now: number) => {
    if (h.cancelled()) return;
    const t = now - t0;
    const ease = (x: number) => x * x * (3 - 2 * x);
    const fraction = t < go ? from + (to - from) * ease(t / go) : t < rest ? to + (back - to) * ease((t - go) / (rest - go)) : back;
    setCurtainFraction(fraction);
    if (t < rest) frame = requestAnimationFrame(step);
  };
  setCurtainFraction(from);
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

export const STOPS: readonly TourStop[] = [
  {
    id: 'trains',
    kicker: 'Mouvement',
    title: 'La France sur les rails',
    caption:
      'Chaque pastille est un train en circulation, placé d’après les horaires et le temps réel de la SNCF. Les voies grises, en fond, montrent par où ils passent.',
    camera: { center: [2.6, 46.6], zoom: 5.6, pitch: 40, bearing: 0, duration: 3_200 },
    layers: ['trains', 'voies'],
    time: { kind: 'day', hour: 10 },
    stat: 'trains',
    ready: (h) => h.status('trains') === 'ready' && countIn(h, 'trains', /(\d[\d  ]*)\s+trains? en circulation/) >= 30,
    dwellMs: 8_500,
  },
  {
    id: 'pointe',
    kicker: 'Mouvement',
    title: 'Paris à l’heure de pointe',
    caption: ({ recorded }) =>
      recorded
        ? 'Métros, RER, tramways et bus d’Île-de-France, rejoués d’après l’enregistrement d’un soir en semaine, à 18 h : le réseau tourne à plein. Une minute passe à chaque seconde.'
        : 'Métros, RER, tramways et bus d’Île-de-France en ce moment. Pour les réseaux qui ne donnent pas la position, elle est estimée d’après les horaires.',
    camera: { center: [2.34, 48.855], zoom: 11.4, pitch: 58, bearing: -25, duration: 4_000 },
    layers: ['transports'],
    time: { kind: 'recorded', hour: 18, speed: 60, layers: ['transports'], weekday: true, liveBetween: [17, 19], fallback: 'live' },
    stat: 'transports',
    ready: (h) => h.status('transports') === 'ready' && countIn(h, 'transports', /(\d[\d  ]*)\s+véhicule/) >= 200,
    dwellMs: 9_500,
  },
  {
    id: 'roissy',
    kicker: 'Mouvement',
    title: 'Roissy, avion en suivi',
    caption:
      'Les avions sont dessinés en 3D, à leur altitude, d’après les signaux ADS-B qu’ils émettent. La caméra suit ici un appareil à l’approche ou au départ de Roissy-Charles-de-Gaulle.',
    camera: { center: [ROISSY.lon, ROISSY.lat], zoom: 10.6, pitch: 62, bearing: 30, duration: 4_000 },
    layers: ['avions'],
    time: { kind: 'recorded', hour: 17, speed: 1, layers: ['avions'], liveBetween: [6, 22], fallback: 'live' },
    stat: 'avions',
    ready: (h) => h.status('avions') === 'ready' && planesNearRoissy(h).filter((p) => !p.ground).length >= 3,
    onReady: followPlane,
    dwellMs: 10_500,
  },
  {
    id: 'manche',
    kicker: 'Mouvement',
    title: 'Le Pas-de-Calais, plein de navires',
    caption:
      'Cargos, pétroliers et ferries, d’après leurs signaux AIS. Dans l’un des détroits les plus fréquentés du monde, les navires suivent deux voies à sens unique, comme sur une autoroute.',
    camera: { center: [1.1, 50.75], zoom: 8.2, pitch: 40, bearing: -10, duration: 4_000 },
    layers: ['bateaux'],
    time: { kind: 'live' },
    stat: 'bateaux',
    ready: (h) => {
      const data = h.data<ShipsData>('bateaux');
      if (!data || data.disabled || h.status('bateaux') !== 'ready') return false;
      // Les navires du détroit même, pas ceux de la carte entière.
      return data.ships.filter((s) => s.lon > -0.5 && s.lon < 2.5 && s.lat > 50 && s.lat < 51.5).length >= 25;
    },
    dwellMs: 8_500,
  },
  {
    id: 'isochrones',
    kicker: 'Territoire',
    title: 'Jusqu’où va-t-on depuis Paris ?',
    caption:
      'Depuis Paris-Gare-de-Lyon, la zone colorée montre tout ce qu’on atteint en moins de trois heures, en trains, en cars et en transports franciliens. Plus bas, le nombre d’habitants à portée.',
    camera: { center: [2.9, 47.0], zoom: 5.4, pitch: 35, bearing: 0, duration: 3_800 },
    layers: ['isochrones'],
    settings: { isochrones: { duree: '180', correspondances: '2', modes: 'tout', affichage: 'zone' } },
    time: { kind: 'day', hour: 9 },
    stat: 'isochrones',
    prepare: (h) => {
      h.manager.modules.find((m) => m.id === 'isochrones')?.urlState?.write(PARIS_LYON);
      h.manager.refresh('isochrones');
    },
    ready: (h) => {
      const data = h.data<IsochroneData>('isochrones');
      return h.status('isochrones') === 'ready' && !!data && data.query.code === PARIS_LYON && data.reached.length >= 20 && !!data.population;
    },
    readyTimeoutMs: 20_000,
    settleMs: 800,
    dwellMs: 10_500,
  },
  {
    id: 'population',
    kicker: 'Territoire',
    title: 'Où vivent les Français',
    caption:
      'Chaque colonne est un carreau de 200 m de côté : sa hauteur dit combien d’habitants y vivent (INSEE). L’agglomération parisienne forme un massif, loin devant le reste du pays.',
    camera: { center: [2.4, 48.85], zoom: 9.2, pitch: 62, bearing: 20, duration: 4_000 },
    layers: ['population'],
    settings: { population: { couleur: 'd', relief: 'colonnes' } },
    stat: 'population',
    ready: (h) => h.status('population') === 'ready' && !!h.summary('population'),
    settleMs: 600,
    dwellMs: 8_500,
  },
  {
    id: 'immobilier',
    kicker: 'Territoire',
    title: 'Le prix du mètre carré à Paris',
    caption:
      'Chaque carreau est coloré selon le prix de vente médian au m², d’après les ventes enregistrées par la DGFiP sur cinq ans. Les couleurs se lisent par rapport à la médiane de la zone affichée : la légende donne les tranches.',
    camera: { center: [2.34, 48.86], zoom: 11.6, pitch: 35, bearing: 0, duration: 3_800 },
    layers: ['immobilier'],
    settings: { immobilier: { type: 't', periode: '5', reference: 'vue', relief: 'plat' } },
    stat: 'immobilier',
    ready: (h) => h.status('immobilier') === 'ready' && !!h.summary('immobilier'),
    settleMs: 600,
    dwellMs: 9_500,
  },
  {
    id: 'reseau-mobile',
    kicker: 'Territoire',
    title: 'Zones blanches dans les Alpes',
    caption:
      'Plus la teinte est claire, plus il y a d’opérateurs en 4G ; les taches les plus sombres sont des zones sans aucun opérateur (cartes théoriques de l’ARCEP). Elles se logent dans les vallées et les hauts massifs.',
    camera: { center: [6.3, 44.65], zoom: 9, pitch: 60, bearing: -25, duration: 4_000 },
    layers: ['couverture-mobile'],
    settings: { 'couverture-mobile': { techno: '4g', vue: 'nombre' } },
    stat: 'couverture-mobile',
    ready: (h) => h.status('couverture-mobile') === 'ready' && !!h.summary('couverture-mobile'),
    settleMs: 600,
    dwellMs: 8_500,
  },
  {
    id: 'elections',
    kicker: 'Territoire',
    title: 'Les élections, bureau par bureau',
    caption:
      'Second tour de la présidentielle 2022 : chaque département prend la couleur de la famille politique arrivée en tête. En zoomant, la carte passe aux communes, puis aux bureaux de vote.',
    camera: { center: [2.4, 46.6], zoom: 5.5, pitch: 0, bearing: 0, duration: 3_800 },
    layers: ['elections'],
    settings: { elections: { scrutin: 'p22t2', affichage: 'tete' } },
    stat: 'elections',
    ready: (h) => h.status('elections') === 'ready',
    settleMs: 800,
    dwellMs: 8_500,
  },
  {
    id: 'photos',
    kicker: 'Histoire',
    title: 'La France des années 50',
    caption:
      'À gauche du rideau, les photographies aériennes de l’IGN prises entre 1950 et 1965 ; à droite, la carte d’aujourd’hui. À La Défense, les tours n’existent pas encore : l’établissement chargé de l’aménager n’est créé qu’en 1958.',
    camera: { center: [2.238, 48.892], zoom: 13.4, pitch: 20, bearing: 0, duration: 4_000 },
    layers: ['photos'],
    settings: { photos: { epoque: '1950-1965', mode: 'rideau' } },
    stat: 'photos',
    ready: (h) => h.status('photos') === 'ready',
    // Les tuiles de la couche « rideau » se dessinent hors de MapLibre : on ne voit pas quand elles sont là.
    settleMs: 3_000,
    onReady: sweepCurtain,
    dwellMs: 9_500,
  },
  {
    id: 'meteo',
    kicker: 'Environnement',
    title: 'Vent et pluie',
    caption:
      'Les particules blanches suivent le vent à 10 m d’altitude ; les couleurs montrent les averses vues par les radars, rejouées ici sur leurs deux dernières heures.',
    camera: { center: [2.4, 46.6], zoom: 5.5, pitch: 25, bearing: 0, duration: 4_000 },
    layers: ['pluie', 'vent'],
    time: { kind: 'live' },
    stat: 'pluie',
    ready: (h) => {
      const wind = h.summary('vent');
      const rain = h.summary('pluie');
      return h.status('vent') === 'ready' && h.status('pluie') === 'ready' && !!wind && !wind.startsWith('Vent masqué') && !!rain && !rain.startsWith('Radar masqué');
    },
    settleMs: 600,
    // Les deux dernières heures du radar défilent pendant la lecture de la légende.
    onReady: () => {
      const span = 10_500; // la durée de lecture de la légende
      clock.setSpeed((90 * 60_000) / span);
      clock.seek(Date.now() - 90 * 60_000);
      clock.play();
    },
    dwellMs: 10_500,
  },
  {
    id: 'nuit',
    kicker: 'Ciel',
    title: 'La nuit sur la France',
    caption:
      'Le fond de carte s’assombrit selon la vraie position du soleil. Quelques trains roulent toute la nuit, comme les Intercités de nuit entre Paris et le sud du pays.',
    camera: { center: [2.6, 46.6], zoom: 5.5, pitch: 40, bearing: 0, duration: 3_800 },
    layers: ['jour-nuit', 'trains'],
    time: { kind: 'night', speed: 120 },
    stat: 'trains',
    ready: (h) => h.status('trains') === 'ready' && countIn(h, 'trains', /(\d[\d  ]*)\s+trains? en circulation/) >= 5,
    settleMs: 600,
    dwellMs: 9_500,
  },
];
