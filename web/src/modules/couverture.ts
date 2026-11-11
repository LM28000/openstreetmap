/**
 * Module « Couverture mobile » : où l'on capte, avec quel opérateur, en 4G ou en voix (ARCEP, « Mon réseau mobile »).
 *
 * Les cartes de couverture de l'ARCEP sont des polygones, par opérateur et par technologie : des centaines de millions de
 * sommets. Le serveur les a **rastérisés** une fois sur une grille de 250 m (`server/src/tiles/couverture.rs`) : pour chaque
 * carreau, le niveau de qualité de chaque opérateur, 4G d'un côté, voix (2G/3G) de l'autre. C'est ce qui rend possible
 * « combien d'opérateurs ici ? » et les zones blanches. À l'échelle de la France, les carreaux sont agrégés (jusqu'à 32 km de
 * côté) : on y lit des moyennes et des parts de surface, recalculées à partir des sommes.
 *
 * Propriétés d'un carreau (préfixe `g` : 4G, `v` : voix) : `q` = qualité de chaque opérateur (0 à 100), `s` = part de surface
 * couverte par chaque opérateur (%), `m` = nombre moyen d'opérateurs × 10, `z` = part de surface sans aucun opérateur (%).
 * `q` et `s` empaquettent les quatre opérateurs (7 bits chacun) : MapLibre n'a pas d'opérations binaires dans ses
 * expressions, on lit l'opérateur `i` par `floor(v / 128^i) % 128`.
 *
 * Deux vues, toutes deux à plat :
 * - « Nombre d'opérateurs » (0 à 4) : une couleur par nombre ;
 * - un opérateur : sa qualité de couverture (aucune, limitée, bonne, très bonne).
 *
 * Couleur : une seule teinte (vert olive), et **la carence est la plus visible** : zéro opérateur, ou aucune couverture, est
 * le plus foncé sur le fond clair (le plus clair sur le fond sombre), la bonne couverture s'efface. Ce ne sont pas les couleurs
 * des opérateurs. Validées avec `validate_palette.js --ordinal` (jour : bout faible à 2,0:1 sur fond clair ; nuit : 2,6:1
 * sur fond sombre ; une teinte, ordre monotone, écarts nets).
 */
import type { LayerSpecification, Map as MapLibreMap } from 'maplibre-gl';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { firstSymbolLayerId } from '../map/baseMap';
import { addTileSource, loadTileSheet, type TileSheet } from '../map/vectorTiles';
import { selectionRingIds, selectionRingLayers } from './statusColors';

const SOURCE_ID = 'couverture';
const FILL_ID = 'couverture-plat';
const SELECTED_SOURCE_ID = 'couverture-choix';
const SELECTED_ID = 'couverture-choisi';

/**
 * Cinq crans, du **plus couvert** au **moins couvert** : 4 opérateurs, 3, 2, 1, 0 (la zone blanche, la plus visible).
 * Jour : foncé = rien ; nuit : clair = rien.
 */
const DAY_RAMP = ['#a6bf4d', '#87a420', '#668300', '#466000', '#2a3a00'];
const NIGHT_RAMP = ['#4f6411', '#6e8a14', '#92b222', '#b9d94a', '#e0f58a'];

const OPERATORS = ['Orange', 'SFR', 'Bouygues Telecom', 'Free Mobile'] as const;
/** Valeur du réglage « Afficher » → rang de l'opérateur dans les propriétés des tuiles. */
const VIEW_OPERATOR: Record<string, number> = { orange: 0, sfr: 1, bouygues: 2, free: 3 };

type Tech = '4g' | 'voix';
/** Préfixe des propriétés des tuiles. */
const PREFIX: Record<Tech, string> = { '4g': 'g', voix: 'v' };
const TECH_LABEL: Record<Tech, string> = { '4g': '4G', voix: 'voix 2G/3G' };

/** Seuils de la qualité (0 à 100 : 33 limitée, 67 bonne, 100 très bonne ; une moyenne aux échelles larges). */
const QUALITY_CUTS = [17, 50, 84];
const QUALITY_LABELS = ['Aucune couverture', 'Couverture limitée', 'Bonne couverture', 'Très bonne couverture'];

interface TechStats {
  operateurs: Array<{ nom: string; couvert: number; tresBonne: number }>;
  /** Part de la terre (%) couverte par 0, 1, 2, 3 ou 4 opérateurs. */
  nbOperateurs: number[];
  zoneBlancheKm2: number;
}

interface CoverageSheet {
  trimestre: string;
  /** Date butoir des cartes, `AAAA-MM-JJ`. */
  date: string;
  terreKm2: number;
  stats: Record<Tech, TechStats>;
  tailles: Array<[number, number]>;
}

interface CoverageData {
  sheet: TileSheet<CoverageSheet>;
}

/** Ce qu'on retient d'un carreau cliqué. */
interface Cell {
  props: Record<string, number>;
  zoom: number;
  /** Contour du carreau (lon, lat), pour l'entourer. */
  ring: Array<[number, number]>;
}

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
const fmtSize = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('fr-FR')} km` : `${m} m`);

/** L'opérateur `i` (0 à 3) dans un entier empaqueté (4 × 7 bits). */
const unpack = (packed: number, i: number) => Math.floor(packed / 128 ** i) % 128;

/** Même lecture, dans une expression MapLibre. */
const unpackExpression = (property: string, i: number): unknown[] => ['%', ['floor', ['/', ['get', property], 128 ** i]], 128];

function qualityLevel(q: number): number {
  return QUALITY_CUTS.filter((cut) => q >= cut).length;
}

function sizeAt(sheet: CoverageSheet, zoom: number): number {
  const z = Math.min(11, Math.max(4, Math.floor(zoom)));
  return sheet.tailles.find(([tileZoom]) => tileZoom === z)?.[1] ?? 250;
}

/** Couleur d'un carreau : le nombre d'opérateurs, ou la qualité d'un opérateur. */
function colorExpression(tech: Tech, view: string, night: boolean): unknown[] {
  const ramp = night ? NIGHT_RAMP : DAY_RAMP;
  const p = PREFIX[tech];
  const operator = VIEW_OPERATOR[view];
  if (operator === undefined) {
    // `m` = nombre moyen d'opérateurs × 10. Plus de la moitié de la surface sans personne : zone blanche, quelle que soit la moyenne.
    return [
      'case',
      ['>=', ['get', `${p}z`], 50],
      ramp[4],
      ['step', ['get', `${p}m`], ramp[4], 5, ramp[3], 15, ramp[2], 25, ramp[1], 35, ramp[0]],
    ];
  }
  // Quatre classes de qualité, prises sur les crans 0, 2, 3, 4 : aucune, limitée, bonne, très bonne.
  const [none, limited, good, veryGood] = [ramp[4], ramp[2], ramp[1], ramp[0]];
  return ['step', unpackExpression(`${p}q`, operator), none, QUALITY_CUTS[0], limited, QUALITY_CUTS[1], good, QUALITY_CUTS[2], veryGood];
}

/** Quelle technologie, quelle vue : les réglages du module. */
function readSettings(settings: Readonly<Record<string, string>>): { tech: Tech; view: string } {
  return { tech: settings.techno === 'voix' ? 'voix' : '4g', view: settings.vue ?? 'nombre' };
}

let shownKey = '';
let viewZoom = 6;

const frDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export const couverture = defineModule<CoverageData>({
  id: 'couverture-mobile',
  name: 'Couverture mobile',
  category: 'territoire',
  description: 'Où l’on capte en 4G ou en voix, opérateur par opérateur, et combien d’opérateurs couvrent chaque endroit (ARCEP).',
  attribution: 'ARCEP, Mon réseau mobile (licence ouverte)',
  timeStepMs: 3_600_000, // carte trimestrielle : ne dépend pas de l'instant affiché
  followsView: false,

  settings: [
    {
      id: 'techno',
      label: 'Technologie',
      defaultValue: '4g',
      options: [
        { value: '4g', label: '4G' },
        { value: 'voix', label: 'Voix 2G/3G' },
      ],
    },
    {
      id: 'vue',
      label: 'Afficher',
      defaultValue: 'nombre',
      options: [
        { value: 'nombre', label: 'Nombre d’opérateurs' },
        { value: 'orange', label: 'Orange' },
        { value: 'sfr', label: 'SFR' },
        { value: 'bouygues', label: 'Bouygues' },
        { value: 'free', label: 'Free' },
      ],
    },
  ],

  async load({ signal }) {
    return { sheet: await loadTileSheet<CoverageSheet>('couverture', signal) };
  },

  legend(settings) {
    const { view } = readSettings(settings);
    if (VIEW_OPERATOR[view] === undefined) {
      const labels = ['4 opérateurs', '3 opérateurs', '2 opérateurs', '1 opérateur', 'Aucun opérateur (zone blanche)'];
      return DAY_RAMP.map((color, i): LegendItem => ({ color, label: labels[i]! }));
    }
    const ramp = [DAY_RAMP[4]!, DAY_RAMP[2]!, DAY_RAMP[1]!, DAY_RAMP[0]!];
    return ramp.map((color, i): LegendItem => ({ color, label: QUALITY_LABELS[i]! }));
  },

  summary({ data, settings }) {
    if (!data) return null;
    const { tech } = readSettings(settings);
    const { stats, trimestre, terreKm2 } = data.sheet.donnees;
    const s = stats[tech];
    if (!s) return null;
    const blanche = s.nbOperateurs[0] ?? 0;
    return `${TECH_LABEL[tech]} : ${blanche.toLocaleString('fr-FR')} % du territoire sans aucun opérateur (${fmt(s.zoneBlancheKm2)} km² sur ${fmt(terreKm2)}) · cartes théoriques ARCEP, ${trimestre.replace(' ', ' ')}`;
  },

  native: {
    add(map: MapLibreMap) {
      shownKey = '';
      void map;
    },
    update(map, { data, settings, night, view, selection }) {
      viewZoom = view.zoom;
      if (!data) return;
      const sheet = data.sheet;
      if (!map.getSource(SOURCE_ID)) {
        addTileSource(map, SOURCE_ID, sheet);
        const before = firstSymbolLayerId(map);
        map.addLayer(
          {
            id: FILL_ID,
            type: 'fill',
            source: SOURCE_ID,
            'source-layer': sheet.couche,
            // Pas de lissage des bords : des carreaux contigus ne doivent pas laisser de fil clair entre eux.
            paint: { 'fill-opacity': 0.74, 'fill-antialias': false },
          } as never,
          before,
        );
        map.addSource(SELECTED_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        for (const layer of selectionRingLayers(SELECTED_ID, SELECTED_SOURCE_ID, ['all'], [[5, 1.5], [12, 3]])) map.addLayer(layer as LayerSpecification, before);
        shownKey = '';
      }
      const { tech, view: showing } = readSettings(settings);
      const dark = night >= 0.5;
      const key = `${tech}:${showing}:${dark}`;
      if (key !== shownKey) {
        shownKey = key;
        map.setPaintProperty(FILL_ID, 'fill-color', colorExpression(tech, showing, dark) as never);
      }
      const cell = selection as Cell | null;
      const source = map.getSource(SELECTED_SOURCE_ID) as { setData?(data: unknown): void } | undefined;
      source?.setData?.({
        type: 'FeatureCollection',
        features: cell ? [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [cell.ring] } }] : [],
      });
    },
    remove(map) {
      for (const id of [...selectionRingIds(SELECTED_ID), FILL_ID]) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [SELECTED_SOURCE_ID, SOURCE_ID]) if (map.getSource(id)) map.removeSource(id);
      shownKey = '';
    },
    pickable: {
      layerIds: [FILL_ID],
      toObject: (feature) => ({
        props: feature.properties as Record<string, number>,
        zoom: viewZoom,
        ring: ((feature.geometry as { coordinates?: number[][][] }).coordinates?.[0] ?? []) as Array<[number, number]>,
      }),
    },
  },

  select(object) {
    const cell = object as Cell;
    return cell?.props?.gm === undefined ? null : cell;
  },

  describe(selection, { data }): InfoContent | null {
    const cell = selection as Cell;
    if (!data) return null;
    const { donnees } = data.sheet;
    const size = sizeAt(donnees, cell.zoom);
    const aggregated = size > 250;
    const p = cell.props;
    const date = frDate(donnees.date);

    const count = (tech: Tech) => (p[`${PREFIX[tech]}m`] ?? 0) / 10;
    const countText = (tech: Tech) => {
      const n = count(tech);
      return aggregated ? n.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : String(Math.round(n));
    };
    const four = Math.round(count('4g'));
    const title = aggregated
      ? `En moyenne ${countText('4g')} opérateur${count('4g') >= 2 ? 's' : ''} en 4G`
      : four === 0
        ? 'Zone blanche en 4G'
        : `${four} opérateur${four > 1 ? 's' : ''} en 4G`;

    // Par opérateur : la meilleure technologie (4G, sinon voix) et son niveau ; à l'échelle large, la part de surface couverte.
    const level = (tech: Tech, i: number) => qualityLevel(unpack(p[`${PREFIX[tech]}q`] ?? 0, i));
    const share = (tech: Tech, i: number) => unpack(p[`${PREFIX[tech]}s`] ?? 0, i);
    const levelWord = ['—', 'limitée', 'bonne', 'très bonne'];
    const rows = OPERATORS.map((name, i) => {
      if (aggregated) return { cells: [name, `${share('4g', i)} %`, `${share('voix', i)} %`] };
      const best = level('4g', i) > 0 ? `4G · ${levelWord[level('4g', i)]}` : level('voix', i) > 0 ? `${TECH_LABEL.voix} · ${levelWord[level('voix', i)]}` : 'Aucune';
      return { cells: [name, level('4g', i) > 0 ? levelWord[level('4g', i)]! : '—', level('voix', i) > 0 ? levelWord[level('voix', i)]! : '—'], title: best };
    });

    const white4 = p.gz ?? 0;
    const note = [
      'Cartes de couverture théoriques : des simulations réalisées par les opérateurs et publiées sous le contrôle de l’ARCEP. Ce ne sont pas des mesures : la couverture réelle dépend du terrain, des bâtiments (très bonne : à l’extérieur et, le plus souvent, à l’intérieur ; limitée : plutôt à l’extérieur) et du téléphone.',
      aggregated
        ? `Carreau agrégé à cette échelle (${fmtSize(size)}) : parts de la surface couverte par chaque opérateur, ${white4} % de la surface sans aucun opérateur en 4G. Zoomez pour le détail.`
        : '',
      'Free Mobile n’a pas de carte 2G ; la voix combine 2G et 3G. La 5G n’est pas publiée.',
    ]
      .filter(Boolean)
      .join(' ');

    return {
      kind: `Couverture mobile · carreau de ${fmtSize(size)}`,
      title,
      subtitle: `${countText('voix')} opérateur${count('voix') >= 2 ? 's' : ''} en voix (2G/3G)`,
      status: plainStatus(`ARCEP · cartes du ${date}`),
      figures: [
        { value: countText('4g'), unit: 'sur 4', label: aggregated ? '4G, en moyenne' : 'opérateurs en 4G' },
        { value: countText('voix'), unit: 'sur 4', label: aggregated ? 'voix, en moyenne' : 'opérateurs en voix' },
      ],
      tables: [
        {
          title: aggregated ? 'Part de la surface couverte, par opérateur' : 'Couverture par opérateur',
          columns: ['Opérateur', '4G', 'Voix'],
          rows: rows.map((row) => ({ cells: row.cells })),
        },
      ],
      note,
      link: { href: 'https://monreseaumobile.arcep.fr/', label: 'Mon réseau mobile (ARCEP)' },
    };
  },
});
