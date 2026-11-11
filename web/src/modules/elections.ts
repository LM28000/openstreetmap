/**
 * Module « Élections » : les résultats des scrutins nationaux récents, par bureau de vote.
 *
 * Les 70 000 bureaux de vote ne se téléchargent pas d'un coup : le serveur les a préparés en tuiles vectorielles
 * (`server/src/tiles/elections.rs`), **un jeu de tuiles par scrutin**, et généralisés par niveau administratif :
 *
 * | zoom   | niveau       | ce qu'on voit                                  |
 * |--------|--------------|------------------------------------------------|
 * | 4 à 7  | département  | ~100 polygones                                  |
 * | 8 à 9  | commune      | ~35 000 polygones                               |
 * | 10 à 12| bureau       | ~68 000 polygones (au-delà : tuiles agrandies)  |
 *
 * Les totaux d'un niveau sont les **sommes** des bureaux (inscrits, votants, exprimés, voix de chaque candidat) : tous les
 * pourcentages se calculent ici, à partir de ces sommes, jamais en moyennant des pourcentages.
 *
 * Trois façons de colorer :
 * - « Participation » : votants / inscrits, une seule teinte (bleu), six classes ;
 * - « En tête » : le candidat ou la liste qui a le plus de voix, coloré par **famille politique** (palette catégorielle,
 *   toujours accompagnée de sa légende et du nom dans la fiche : la couleur ne porte jamais seule l'information) ;
 * - « Part d'un candidat » : sa part des exprimés, une seule teinte (terre de Sienne), sept classes.
 *
 * Les familles sont un regroupement *indicatif* : d'après la nuance du ministère de l'Intérieur quand elle existe
 * (législatives, listes des européennes), d'après l'étiquette du candidat pour la présidentielle (qui n'a pas de nuance).
 * Fiche : le détail de chaque candidat ou liste, avec sa couleur, son nom et son score.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type InfoRow, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { addTileSource, loadTileSheet, type TileSheet } from '../map/vectorTiles';
import { addSelectionRing, selectionRingIds, selectionRingLayers, setSelectionRingFilter } from './statusColors';

const SOURCE_ID = 'elections';
const FLAT_ID = 'elections-plat';
const LINE_ID = 'elections-contour';
const RELIEF_ID = 'elections-relief';
const SELECTED_ID = 'elections-choisi';

// ---------------------------------------------------------------------------------------------
// Familles politiques et couleurs
// ---------------------------------------------------------------------------------------------

type BlocId = 'exg' | 'gauche' | 'eco' | 'centre' | 'droite' | 'ed' | 'autres';

interface Bloc {
  label: string;
  /** Abréviation de la pastille de la fiche. */
  short: string;
  day: string;
  night: string;
}

/**
 * Six familles et « autres ». Les couleurs sont celles, conventionnelles, des cartes électorales françaises (rouge, rose, vert,
 * jaune, bleu), prises dans la palette catégorielle validée du projet (`validate_palette.js`) : validée dans l'ordre
 * droite, centre, gauche, écologistes, extrême droite, extrême gauche (voisins deux à deux), fond clair comme fond sombre :
 * écart minimal entre voisins ΔE 16 (vision normale 19,6 ; daltonisme 16,3 ; fond sombre 13,0 et 19,3).
 * Deux limites, assumées : (1) validée voisin à voisin, pas pour toutes les paires (jaune et rose sont sous 3:1 sur fond clair, bleu et violet
 * proches l'un de l'autre pour un daltonien) ; d'où la légende, le nom dans la fiche et le contour des polygones ; (2) le rouge et le rose
 * sont voisins, comme le bleu et le violet : ce sont des familles proches. « Autres » est un gris neutre.
 */
const BLOCS: Record<BlocId, Bloc> = {
  exg: { label: 'Extrême gauche', short: 'ExG', day: '#e34948', night: '#e66767' },
  gauche: { label: 'Gauche', short: 'G', day: '#e87ba4', night: '#d55181' },
  eco: { label: 'Écologistes', short: 'Éco', day: '#008300', night: '#008300' },
  centre: { label: 'Centre', short: 'C', day: '#eda100', night: '#c98500' },
  droite: { label: 'Droite', short: 'D', day: '#2a78d6', night: '#3987e5' },
  ed: { label: 'Extrême droite', short: 'ExD', day: '#6250d6', night: '#9085e9' },
  autres: { label: 'Autres', short: 'Aut.', day: '#8c8b85', night: '#8a8984' },
};
const BLOC_ORDER: BlocId[] = ['exg', 'gauche', 'eco', 'centre', 'droite', 'ed', 'autres'];

/** Bureau sans résultat pour ce scrutin (ou jamais de voix) : un gris clair, hors de toute légende de données. */
const NO_DATA = { day: '#cfcdc4', night: '#46464a' };

/**
 * Participation : bleu, six classes (validées avec `--ordinal`, ΔL ≥ 0,06). Fond clair : le plus fort est le plus foncé ;
 * fond sombre : le plus fort est le plus clair, comme les autres couches.
 */
const PARTICIPATION_DAY = ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0a2548'];
const PARTICIPATION_NIGHT = ['#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6', '#e3effd'];
/** Part d'un candidat : terre de Sienne, sept classes (la rampe de la couche Population, validée avec `--ordinal`). */
const SHARE_DAY = ['#d8ac6c', '#c58b49', '#aa6c33', '#865027', '#63381d', '#432414', '#2a160c'];
const SHARE_NIGHT = ['#7d4a2a', '#9a6034', '#b97a40', '#d1975b', '#e3b57f', '#f0cfa6', '#fbeed8'];

// ---------------------------------------------------------------------------------------------
// Les scrutins : colonnes des tuiles (même ordre que `server/src/tiles/elections.rs`), noms, familles
// ---------------------------------------------------------------------------------------------

interface Column {
  /** Clé de la colonne côté serveur (nom, nuance ou numéro de panneau) ; `autres` pour le regroupement. */
  key: string;
  name: string;
  /** Précision affichée après le nom (nuance du ministère, tête de liste). */
  detail?: string;
  bloc: BlocId;
}

type ScrutinId = 'p22t1' | 'p22t2' | 'eu24' | 'l24t1' | 'l24t2';

interface ScrutinDef {
  id: ScrutinId;
  /** Identifiant du jeu de tuiles. */
  jeu: string;
  label: string;
  short: string;
  /** Page des résultats sur data.gouv.fr. */
  page: string;
  /** « candidat », « liste », « nuance » : ce que sont les lignes de la fiche. */
  what: 'candidat' | 'liste' | 'nuance';
  columns: Column[];
  note?: string;
}

const col = (key: string, name: string, bloc: BlocId, detail?: string): Column => ({ key, name, bloc, detail });

const PRESIDENTIELLE_T1: Column[] = [
  col('MACRON', 'Emmanuel Macron', 'centre'),
  col('LE PEN', 'Marine Le Pen', 'ed'),
  col('MÉLENCHON', 'Jean-Luc Mélenchon', 'gauche'),
  col('ZEMMOUR', 'Éric Zemmour', 'ed'),
  col('PÉCRESSE', 'Valérie Pécresse', 'droite'),
  col('JADOT', 'Yannick Jadot', 'eco'),
  col('LASSALLE', 'Jean Lassalle', 'autres'),
  col('ROUSSEL', 'Fabien Roussel', 'gauche'),
  col('DUPONT-AIGNAN', 'Nicolas Dupont-Aignan', 'droite'),
  col('HIDALGO', 'Anne Hidalgo', 'gauche'),
  col('POUTOU', 'Philippe Poutou', 'exg'),
  col('ARTHAUD', 'Nathalie Arthaud', 'exg'),
];

/** Nuances du ministère aux législatives 2024 (celles qui dépassent 0,7 % des exprimés), puis le reste. */
const LEGISLATIVES: Column[] = [
  col('RN', 'Rassemblement national', 'ed', 'RN'),
  col('UG', 'Union de la gauche', 'gauche', 'UG'),
  col('ENS', 'Ensemble', 'centre', 'ENS'),
  col('LR', 'Les Républicains', 'droite', 'LR'),
  col('UXD', 'Union de l’extrême droite', 'ed', 'UXD'),
  col('DVD', 'Divers droite', 'droite', 'DVD'),
  col('DVG', 'Divers gauche', 'gauche', 'DVG'),
  col('DVC', 'Divers centre', 'centre', 'DVC'),
  col('EXG', 'Extrême gauche', 'exg', 'EXG'),
  col('REG', 'Régionalistes', 'autres', 'REG'),
  col('REC', 'Reconquête', 'ed', 'REC'),
  col('HOR', 'Horizons', 'centre', 'HOR'),
  col('autres', 'Autres nuances', 'autres'),
];

const SCRUTINS: ScrutinDef[] = [
  {
    id: 'p22t1',
    jeu: 'elec-p22t1',
    label: 'Présidentielle 2022, 1er tour',
    short: 'Prés. 2022 · 1er tour',
    page: 'https://www.data.gouv.fr/fr/datasets/election-presidentielle-des-10-et-24-avril-2022-resultats-definitifs-du-1er-tour/',
    what: 'candidat',
    columns: PRESIDENTIELLE_T1,
  },
  {
    id: 'p22t2',
    jeu: 'elec-p22t2',
    label: 'Présidentielle 2022, 2nd tour',
    short: 'Prés. 2022 · 2nd tour',
    page: 'https://www.data.gouv.fr/fr/datasets/election-presidentielle-des-10-et-24-avril-2022-resultats-definitifs-du-2nd-tour/',
    what: 'candidat',
    columns: [col('MACRON', 'Emmanuel Macron', 'centre'), col('LE PEN', 'Marine Le Pen', 'ed')],
  },
  {
    id: 'eu24',
    jeu: 'elec-eu24',
    label: 'Européennes 2024',
    short: 'Européennes 2024',
    page: 'https://www.data.gouv.fr/fr/datasets/resultats-des-elections-europeennes-du-9-juin-2024/',
    what: 'liste',
    // Numéros de panneau des 12 listes au-dessus de 1 % des exprimés, de la plus à la moins votée.
    columns: [
      col('5', 'La France revient', 'ed', 'liste de Jordan Bardella'),
      col('11', 'Besoin d’Europe', 'centre', 'liste de Valérie Hayer'),
      col('27', 'Réveil européen', 'gauche', 'liste de Raphaël Glucksmann'),
      col('4', 'La France insoumise', 'gauche', 'liste de Manon Aubry'),
      col('18', 'La droite pour faire entendre la voix de la France en Europe', 'droite', 'liste de François-Xavier Bellamy'),
      col('6', 'Europe Écologie', 'eco', 'liste de Marie Toussaint'),
      col('3', 'La France fière (Reconquête)', 'ed', 'liste de Marion Maréchal'),
      col('33', 'Gauche unie', 'gauche'),
      col('29', 'Alliance rurale', 'droite'),
      col('8', 'Parti animaliste', 'autres'),
      col('35', 'Écologie au centre', 'eco'),
      col('15', 'Liste Asselineau – Frexit', 'autres'),
      col('autres', 'Autres listes', 'autres'),
    ],
    note: 'Les 12 listes qui ont dépassé 1 % des exprimés au niveau national sont détaillées ; les 26 autres sont regroupées.',
  },
  {
    id: 'l24t1',
    jeu: 'elec-l24t1',
    label: 'Législatives 2024, 1er tour',
    short: 'Législ. 2024 · 1er tour',
    page: 'https://www.data.gouv.fr/fr/datasets/elections-legislatives-des-30-juin-et-7-juillet-2024-resultats-definitifs-du-1er-tour/',
    what: 'nuance',
    columns: LEGISLATIVES,
    note: 'Résultats par nuance du ministère de l’Intérieur : les candidats d’une même nuance sont additionnés (une commune ou un département compte plusieurs circonscriptions).',
  },
  {
    id: 'l24t2',
    jeu: 'elec-l24t2',
    label: 'Législatives 2024, 2nd tour',
    short: 'Législ. 2024 · 2nd tour',
    page: 'https://www.data.gouv.fr/fr/datasets/elections-legislatives-des-30-juin-et-7-juillet-2024-resultats-definitifs-du-2nd-tour/',
    what: 'nuance',
    columns: LEGISLATIVES,
    note: 'Résultats par nuance du ministère de l’Intérieur. Les circonscriptions où un candidat a été élu au 1er tour n’ont pas de 2nd tour : leurs bureaux n’ont pas de résultat.',
  },
];

const BY_ID = new Map<string, ScrutinDef>(SCRUTINS.map((s) => [s.id, s]));
/** Du plus récent au plus ancien : par défaut, le scrutin le plus récent dont le serveur a fini les tuiles. */
const RECENCY: ScrutinId[] = ['l24t2', 'l24t1', 'eu24', 'p22t2', 'p22t1'];
const DEFAULT_SCRUTIN: ScrutinId = RECENCY[0]!;

function scrutinOf(id: string | undefined): ScrutinDef {
  return BY_ID.get(id ?? '') ?? BY_ID.get(DEFAULT_SCRUTIN)!;
}

// ---------------------------------------------------------------------------------------------
// Données de la fiche du jeu de tuiles (voir `Elections::scan`)
// ---------------------------------------------------------------------------------------------

interface ElectionsSheet {
  scrutin: string;
  libelle: string;
  /** Clés des colonnes `c0`, `c1`… des tuiles. */
  colonnes: string[];
  /** Seuils de participation en % (six). */
  participation: number[];
  /** Seuils de part des exprimés en % (six), par colonne. */
  parts: number[][];
  national: { inscrits: number; votants: number; exprimes: number; voix: number[] };
  appariement: { bureaux: number; bureauxAvecContour: number; inscrits: number; inscritsAvecContour: number; communesDeRepli: number };
}

interface ElectionsData {
  /** Scrutin dont les tuiles sont affichées. */
  scrutin: ScrutinId;
  /** Scrutin demandé : différent de `scrutin` quand ses tuiles ne sont pas encore prêtes sur le serveur. */
  requested: ScrutinId;
  sheet: TileSheet<ElectionsSheet>;
}

/** Ce qu'on retient d'un objet cliqué : de quoi refaire sa fiche, même après un changement de zoom. */
interface Picked {
  scrutin: ScrutinId;
  niv: number;
  code: string;
  nom: string;
  i: number;
  v: number;
  x: number;
  /** Voix par colonne, dans l'ordre du scrutin (`c0`, `c1`…). */
  c: number[];
}

// ---------------------------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------------------------

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
const pct = (part: number, whole: number, digits = 1) =>
  whole > 0 ? `${((100 * part) / whole).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %` : '—';

/** Seuil de légende : sans décimale à partir de 10 %. */
const cut = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('fr-FR');

/** Rend la suite strictement croissante (une classe de largeur nulle ferait échouer l'expression `step`). */
function ascending(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) out.push(out.length > 0 && v <= out[out.length - 1]! ? Math.round((out[out.length - 1]! + 0.1) * 10) / 10 : v);
  return out;
}

function rangeLabels(cuts: number[]): string[] {
  const last = cuts.length - 1;
  return [`Moins de ${cut(cuts[0]!)} %`, ...cuts.slice(0, last).map((c, i) => `${cut(c)} à ${cut(cuts[i + 1]!)} %`), `${cut(cuts[last]!)} % et plus`];
}

// ---------------------------------------------------------------------------------------------
// Expressions de style
// ---------------------------------------------------------------------------------------------

type Affichage = 'participation' | 'tete' | 'part';

/** Les seuils des classes de participation : on garde les cinq derniers des six que donne le serveur (six classes de couleur). */
function participationCuts(sheet: ElectionsSheet): number[] {
  return ascending(sheet.participation.slice(1));
}

function columnIndex(def: ScrutinDef, key: string): number {
  return Math.max(0, def.columns.findIndex((c) => c.key === key));
}

function shareCuts(sheet: ElectionsSheet, index: number): number[] {
  return ascending(sheet.parts[index] ?? [1, 5, 10, 20, 30, 40]);
}

function stepExpression(input: unknown[], ramp: string[], cuts: number[]): unknown[] {
  const expression: unknown[] = ['step', input, ramp[0]];
  cuts.forEach((c, i) => expression.push(c, ramp[i + 1]));
  return expression;
}

function colorExpression(def: ScrutinDef, sheet: ElectionsSheet, affichage: Affichage, listKey: string, night: boolean): unknown[] {
  const noData = night ? NO_DATA.night : NO_DATA.day;
  if (affichage === 'participation') {
    const ramp = night ? PARTICIPATION_NIGHT : PARTICIPATION_DAY;
    return ['case', ['<=', ['get', 'i'], 0], noData, stepExpression(['*', 100, ['/', ['get', 'v'], ['get', 'i']]], ramp, participationCuts(sheet))];
  }
  if (affichage === 'part') {
    const ramp = night ? SHARE_NIGHT : SHARE_DAY;
    const index = columnIndex(def, listKey);
    return [
      'case',
      ['<=', ['get', 'x'], 0],
      noData,
      stepExpression(['*', 100, ['/', ['get', `c${index}`], ['get', 'x']]], ramp, shareCuts(sheet, index)),
    ];
  }
  // En tête : `t` est le rang (à partir de 1) de la colonne la mieux placée, 0 s'il n'y a aucune voix. Les colonnes de même famille partagent une couleur.
  const byColor = new Map<string, number[]>();
  def.columns.forEach((c, i) => {
    if (c.key === 'autres') return; // « autres » n'est jamais en tête (le serveur ne le compte pas)
    const color = night ? BLOCS[c.bloc].night : BLOCS[c.bloc].day;
    byColor.set(color, [...(byColor.get(color) ?? []), i + 1]);
  });
  const match: unknown[] = ['match', ['get', 't']];
  for (const [color, ranks] of byColor) match.push(ranks, color);
  match.push(noData);
  return ['case', ['<=', ['get', 'i'], 0], noData, match];
}

/**
 * Hauteur (mètres) en mode relief : racine des votants × un facteur qui diminue de moitié à chaque zoom gagné (une colonne garde
 * la même hauteur à l'écran), recalé à chaque changement de niveau : un département compte des centaines de milliers de votants,
 * un bureau quelques centaines. La racine adoucit les écarts (sans elle, Paris écraserait le reste).
 */
function heightExpression(): unknown[] {
  const stops: unknown[] = [];
  for (let zoom = 4; zoom <= 12; zoom++) {
    const factor = zoom <= 7 ? 240 * 2 ** (4 - zoom) : zoom <= 9 ? 100 * 2 ** (8 - zoom) : 20 * 2 ** (10 - zoom);
    stops.push(zoom, ['*', factor, ['sqrt', ['get', 'v']]]);
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops];
}

let shownJeu = '';
let shownKey = '';
/** Scrutin de la source affichée : une tuile ne dit pas de quel scrutin elle vient, et `select` ne reçoit que ses propriétés. */
let shownScrutin: ScrutinId = DEFAULT_SCRUTIN;

function removeLayers(map: MapLibreMap): void {
  for (const id of [...selectionRingIds(SELECTED_ID), LINE_ID, FLAT_ID, RELIEF_ID]) if (map.getLayer(id)) map.removeLayer(id);
  if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
  shownJeu = '';
  shownKey = '';
}

// ---------------------------------------------------------------------------------------------
// Le module
// ---------------------------------------------------------------------------------------------

export const elections = defineModule<ElectionsData>({
  id: 'elections',
  name: 'Élections',
  category: 'territoire',
  description:
    'Résultats des scrutins nationaux (présidentielle 2022, européennes et législatives 2024) par bureau de vote : départements de loin, communes puis bureaux de près.',
  attribution: 'Ministère de l’Intérieur ; Etalab (contours des bureaux de vote) ; IGN',
  timeStepMs: 3_600_000, // résultats définitifs : ne dépendent pas de l'instant affiché
  followsView: false,

  settings: [
    {
      id: 'scrutin',
      label: 'Scrutin',
      defaultValue: DEFAULT_SCRUTIN,
      options: SCRUTINS.map((s) => ({ value: s.id, label: s.short })),
    },
    {
      id: 'affichage',
      label: 'Afficher',
      defaultValue: 'tete',
      options: [
        { value: 'tete', label: 'En tête' },
        { value: 'participation', label: 'Participation' },
        { value: 'part', label: 'Part d’un candidat' },
      ],
    },
    {
      id: 'liste',
      label: 'Candidat ou liste',
      defaultValue: 'RN',
      options: [],
      // Les candidats du scrutin choisi (le premier est le plus voté au niveau national).
      optionsFor: (settings) => scrutinOf(settings.scrutin).columns.filter((c) => c.key !== 'autres').map((c) => ({ value: c.key, label: c.name })),
      visibleWhen: (settings) => settings.affichage === 'part',
    },
    {
      id: 'relief',
      label: 'Relief',
      defaultValue: 'plat',
      options: [
        { value: 'plat', label: 'À plat' },
        { value: 'hauteur', label: 'Hauteur = votants' },
      ],
    },
  ],

  async load({ signal, settings }) {
    const wanted = scrutinOf(settings.scrutin).id;
    // Le scrutin demandé si ses tuiles sont prêtes ; sinon le plus récent qui l'est (le serveur les fabrique l'une après l'autre).
    for (const id of [wanted, ...RECENCY.filter((r) => r !== wanted)]) {
      try {
        return { scrutin: id, requested: wanted, sheet: await loadTileSheet<ElectionsSheet>(scrutinOf(id).jeu, signal) };
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('préparation')) throw error;
      }
    }
    throw new Error('résultats en préparation sur le serveur (quelques minutes au premier démarrage)');
  },

  // Un autre scrutin, c'est un autre jeu de tuiles : on recharge sa fiche. Un scrutin en préparation est redemandé de temps en temps.
  refreshIntervalMs: 120_000,
  needsReload: (data, _time, settings) => {
    const wanted = scrutinOf(settings.scrutin).id;
    return data.scrutin !== wanted && data.requested !== wanted;
  },

  legend(settings, data) {
    if (!data) return [];
    const def = scrutinOf(data.scrutin);
    const sheet = data.sheet.donnees;
    const night = false; // la légende est affichée dans le panneau, sur fond d'interface : couleurs du jour
    const affichage = (settings.affichage ?? 'tete') as Affichage;
    if (affichage === 'tete') {
      const present = new Set(def.columns.filter((c) => c.key !== 'autres').map((c) => c.bloc));
      const items: LegendItem[] = BLOC_ORDER.filter((b) => present.has(b)).map((b) => ({ color: night ? BLOCS[b].night : BLOCS[b].day, label: BLOCS[b].label }));
      items.push({ color: NO_DATA.day, label: 'Pas de résultat' });
      return items;
    }
    if (affichage === 'participation') {
      return rangeLabels(participationCuts(sheet)).map((label, i) => ({ color: PARTICIPATION_DAY[i]!, label }));
    }
    const index = columnIndex(def, settings.liste ?? '');
    const items: LegendItem[] = rangeLabels(shareCuts(sheet, index)).map((label, i) => ({ color: SHARE_DAY[i]!, label }));
    items.push({ color: NO_DATA.day, label: 'Pas de résultat' });
    return items;
  },

  summary({ data, settings }) {
    if (!data) return null;
    const def = scrutinOf(data.scrutin);
    const { national } = data.sheet.donnees;
    const pending = data.requested !== data.scrutin ? `« ${scrutinOf(data.requested).label} » en préparation sur le serveur · ` : '';
    const base = `${pending}${def.label} · participation ${pct(national.votants, national.inscrits)} (${(national.inscrits / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} millions d’inscrits en France, hors Français de l’étranger)`;
    const affichage = (settings.affichage ?? 'tete') as Affichage;
    if (affichage === 'part') {
      const index = columnIndex(def, settings.liste ?? '');
      const column = def.columns[index]!;
      return `${base} · ${column.name} : ${pct(national.voix[index] ?? 0, national.exprimes)} des exprimés`;
    }
    return base;
  },

  native: {
    add(map: MapLibreMap) {
      // Les couches sont ajoutées par `update`, quand la fiche des tuiles est arrivée (la source en a besoin).
      void map;
      shownJeu = '';
      shownKey = '';
    },
    update(map, { data, settings, night, selection }) {
      if (!data) return;
      const sheet = data.sheet;
      const def = scrutinOf(data.scrutin);
      shownScrutin = def.id;
      if (shownJeu !== sheet.jeu) {
        // Premier affichage, ou changement de scrutin : une autre source de tuiles.
        removeLayers(map);
        addTileSource(map, SOURCE_ID, sheet);
        const before = firstSymbolLayerId(map);
        const layer = sheet.couche;
        map.addLayer({ id: RELIEF_ID, type: 'fill-extrusion', source: SOURCE_ID, 'source-layer': layer, paint: { 'fill-extrusion-opacity': 0.9, 'fill-extrusion-vertical-gradient': true } } as never, before);
        map.addLayer({ id: FLAT_ID, type: 'fill', source: SOURCE_ID, 'source-layer': layer, paint: { 'fill-opacity': 0.82 } } as never, before);
        // Contour fin : il masque les interstices entre deux polygones simplifiés séparément, et fait lire les limites à chaque niveau.
        map.addLayer(
          {
            id: LINE_ID,
            type: 'line',
            source: SOURCE_ID,
            'source-layer': layer,
            layout: { 'line-join': 'round' },
            // Plus fin à l'intérieur d'un niveau dense (communes, bureaux) qu'à celui des départements, un peu plus épais en gros plan.
            paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 4, 0.9, 7.9, 1.1, 8, 0.5, 9.9, 0.7, 10, 0.4, 13, 0.9, 16, 1.4] },
          } as never,
          before,
        );
        const ring = selectionRingLayers(SELECTED_ID, SOURCE_ID, ['==', ['get', 'code'], ''], [[4, 2], [12, 3.5]]);
        addSelectionRing(map, ring.map((l) => ({ ...l, 'source-layer': layer }) as never), before);
      }
      const affichage = (settings.affichage ?? 'tete') as Affichage;
      const listKey = settings.liste ?? '';
      const relief = settings.relief === 'hauteur';
      const dark = night >= 0.5;
      const key = `${sheet.jeu}:${affichage}:${listKey}:${relief}:${dark}`;
      if (key !== shownKey) {
        shownKey = key;
        const color = colorExpression(def, sheet.donnees, affichage, listKey, dark) as never;
        map.setPaintProperty(FLAT_ID, 'fill-color', color);
        map.setPaintProperty(RELIEF_ID, 'fill-extrusion-color', color);
        map.setPaintProperty(RELIEF_ID, 'fill-extrusion-height', heightExpression() as never);
        map.setPaintProperty(RELIEF_ID, 'fill-extrusion-base', 0);
        map.setLayoutProperty(RELIEF_ID, 'visibility', relief ? 'visible' : 'none');
        map.setLayoutProperty(FLAT_ID, 'visibility', relief ? 'none' : 'visible');
        map.setPaintProperty(LINE_ID, 'line-color', dark ? 'rgba(240,239,236,0.38)' : 'rgba(35,38,48,0.5)');
      }
      const picked = selection as Picked | null;
      setSelectionRingFilter(
        map,
        SELECTED_ID,
        picked && picked.scrutin === def.id ? ['all', ['==', ['get', 'code'], picked.code], ['==', ['get', 'niv'], picked.niv]] : ['==', ['get', 'code'], ''],
      );
    },
    remove(map) {
      removeLayers(map);
    },
    pickable: {
      layerIds: [RELIEF_ID, FLAT_ID],
      toObject: (feature) => ({ ...feature.properties, scrutin: shownScrutin }),
    },
  },

  select(object) {
    const p = object as Record<string, unknown>;
    if (typeof p.code !== 'string' || typeof p.i !== 'number') return null;
    const def = scrutinOf(String(p.scrutin));
    const c: number[] = [];
    for (let k = 0; k < def.columns.length; k++) c.push(Number(p[`c${k}`] ?? 0));
    return { scrutin: def.id, niv: Number(p.niv), code: p.code, nom: String(p.nom ?? ''), i: p.i, v: Number(p.v), x: Number(p.x), c } satisfies Picked;
  },

  describe(selection): InfoContent | null {
    const p = selection as Picked;
    const def = scrutinOf(p.scrutin);
    const level = ['Département', 'Commune', 'Bureau de vote', 'Commune'][p.niv] ?? 'Objet';
    const code = p.niv === 2 ? p.code.split('_')[1] ?? p.code : p.code.split('_')[0] ?? p.code;
    const subtitle =
      p.niv === 2
        ? `Bureau de vote ${code} · commune ${p.code.split('_')[0]}`
        : p.niv === 0
          ? `Département ${code}`
          : p.niv === 3
            ? `Commune ${code} · résultats de l’ensemble des bureaux`
            : `Commune ${code}`;
    const base: InfoContent = {
      kind: `${level} · ${def.short}`,
      title: p.nom,
      subtitle,
      status: plainStatus('Résultats définitifs · ministère de l’Intérieur'),
      link: { href: def.page, label: 'Résultats sur data.gouv.fr' },
    };
    if (p.i <= 0) {
      return { ...base, note: `Pas de résultat pour ce scrutin dans ce ${p.niv === 2 ? 'bureau' : 'territoire'} (bureau créé, supprimé ou sans second tour).` };
    }
    // Chaque candidat ou liste, du plus au moins voté ; « autres » ferme la marche.
    const lines = def.columns.map((column, k) => ({ column, votes: p.c[k] ?? 0 }));
    lines.sort((a, b) => (a.column.key === 'autres' ? 1 : b.column.key === 'autres' ? -1 : b.votes - a.votes));
    const rows: InfoRow[] = lines.map(({ column, votes }, rank) => ({
      cells: [column.key === 'autres' ? '' : String(rank + 1), column.detail && def.what === 'nuance' ? `${column.detail} · ${column.name}` : column.name, fmt(votes), pct(votes, p.x)],
      badge: { text: BLOCS[column.bloc].short, color: BLOCS[column.bloc].day.slice(1) },
    }));
    const notes: string[] = [];
    if (p.niv === 0 || p.niv === 1 || p.niv === 3) {
      notes.push('Totaux : sommes des résultats des bureaux de vote ; les pourcentages sont recalculés à partir de ces sommes.');
    } else {
      notes.push('Contour approximatif, tracé par Etalab à partir des adresses du répertoire électoral unique : il n’a pas valeur officielle.');
    }
    if (p.niv === 3) notes.push('Certains bureaux de cette commune n’ont pas de contour : la commune est montrée entière.');
    if (def.note) notes.push(def.note);
    notes.push('Pourcentages sur les suffrages exprimés. Couleurs : familles politiques, regroupement indicatif.');
    return {
      ...base,
      figures: [
        { value: fmt(p.i), label: 'inscrits' },
        { value: fmt(p.v), label: 'votants' },
        { value: pct(p.v, p.i), label: 'participation' },
      ],
      tables: [{ title: def.what === 'candidat' ? 'Candidats' : def.what === 'liste' ? 'Listes' : 'Nuances', columns: ['', def.what === 'candidat' ? 'Candidat' : def.what === 'liste' ? 'Liste' : 'Nuance', 'Voix', '%'], rows }],
      fields: [
        ['Exprimés', fmt(p.x)],
        ['Blancs et nuls', fmt(p.v - p.x)],
        ['Abstentions', fmt(p.i - p.v)],
      ],
      note: notes.join(' '),
    };
  },
});
