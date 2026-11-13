/**
 * Module « Population » : où vivent les habitants, et comment, au carreau de 200 m (INSEE, Filosofi 2019).
 *
 * 2,3 millions de carreaux ne se téléchargent pas : le serveur les a préparés une fois en tuiles vectorielles
 * (`server/src/tiles/`), généralisées par zoom. À l'échelle de la France, un carreau est un agrégat de 8 à 16 km de
 * côté ; en zoomant, les carreaux se subdivisent jusqu'à 200 m. À chaque échelle, les comptes (habitants,
 * ménages) sont additionnés et les ratios (niveau de vie, pauvreté, âge) recalculés à partir des sommes,
 * jamais moyennés.
 *
 * - Hauteur de la colonne : densité d'habitants (racine carrée : sans elle, Paris écraserait tout le reste).
 * - Couleur : une variable au choix (densité, niveau de vie moyen, ménages pauvres, 65 ans et plus), en une seule
 *   teinte, du clair au foncé. Les seuils viennent du serveur : quantiles de la distribution *des habitants*.
 * - Mode « à plat » : mêmes couleurs, sans relief.
 *
 * Secret statistique : sous 11 ménages fiscaux, l'INSEE publie une valeur imputée (approchée) ; la fiche indique la
 * part d'habitants concernée.
 */
import { POP } from '../design/tokens';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { fillInsertionId } from '../map/baseMap';
import { addTileSource, loadTileSheet, type TileSheet } from '../map/vectorTiles';
import { addSelectionRing, selectionRingIds, selectionRingLayers, setSelectionRingFilter } from './statusColors';

const SOURCE_ID = 'population';
const COLUMNS_ID = 'population-colonnes';
const FLAT_ID = 'population-plat';
const SELECTED_ID = 'population-choisi';
/** Zone des isochrones (module `isochrones`) : la population passe dessous, pour qu'on la voie à travers les gares atteintes. */
const UNDER = 'isochrones-zone';

/**
 * Une seule teinte (terre de Sienne), sept classes. Jour : le plus dense est le plus foncé ; nuit : le plus dense
 * est le plus clair, comme les autres couches sur le fond sombre. Validées avec `validate_palette.js --ordinal` :
 * ordre monotone, écarts nets, bout faible à 2,0:1 (jour, fond clair) et 2,4:1 (nuit, fond sombre).
 */
const DAY_RAMP = POP.jour;
const NIGHT_RAMP = POP.nuit;

/** Seuils de densité (habitants par km²), fixes : une densité moyenne a le même sens à chaque échelle. */
const DENSITY_STOPS = [10, 50, 200, 1000, 4000, 12000];

type Variable = 'd' | 'niv' | 'pauv' | 'a65';

interface PopulationSheet {
  millesime: string;
  habitants: number;
  carreaux: number;
  carreauxImputes: number;
  habitantsImputes: number;
  seuils: Record<Exclude<Variable, 'd'>, number[]>;
  tailles: Array<[number, number]>;
}

interface PopulationData {
  sheet: TileSheet<PopulationSheet>;
}

/** Ce qu'on retient d'un carreau cliqué. */
interface Cell {
  pop: number;
  d: number;
  men: number;
  niv: number;
  pauv: number;
  a65: number;
  imp: number;
  /** Côté du carreau à l'échelle où il a été cliqué (mètres). */
  size: number;
}

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
const fmtSize = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('fr-FR')} km` : `${m} m`);

/** Les six seuils (sept classes) de la variable. */
function thresholds(variable: Variable, sheet: PopulationSheet): number[] {
  if (variable === 'd') return DENSITY_STOPS;
  // Le serveur donne sept quantiles (3, 17, 33, 50, 67, 83, 97 %) ; on garde les six derniers.
  return sheet.seuils[variable].slice(1);
}

const VARIABLES: Record<Variable, { label: string; unit: string; legendLabel: (low: number | null, high: number | null) => string }> = {
  d: {
    label: 'Densité d’habitants',
    unit: 'hab./km²',
    legendLabel: (low, high) => range(low, high, ' hab./km²'),
  },
  niv: {
    label: 'Niveau de vie moyen',
    unit: '€/an',
    legendLabel: (low, high) => range(low, high, ' €/an'),
  },
  pauv: {
    label: 'Ménages pauvres',
    unit: '%',
    legendLabel: (low, high) => range(low, high, ' %'),
  },
  a65: {
    label: '65 ans et plus',
    unit: '%',
    legendLabel: (low, high) => range(low, high, ' %'),
  },
};

function range(low: number | null, high: number | null, unit: string): string {
  if (low === null && high !== null) return `Moins de ${fmt(high)}${unit}`;
  if (high === null && low !== null) return `${fmt(low)}${unit} et plus`;
  return `${fmt(low ?? 0)} à ${fmt(high ?? 0)}${unit}`;
}

/** Couleur d'un carreau selon sa variable : classes (`step`), pour que la légende dise exactement ce qu'on voit. */
function colorExpression(variable: Variable, sheet: PopulationSheet, night: number): unknown[] {
  const ramp = night >= 0.5 ? NIGHT_RAMP : DAY_RAMP;
  const cuts = thresholds(variable, sheet);
  const expression: unknown[] = ['step', ['get', variable], ramp[0]];
  cuts.forEach((cut, i) => expression.push(cut, ramp[i + 1]));
  return expression;
}

/**
 * Hauteur (mètres) : racine de la densité × un facteur qui double à chaque zoom perdu. À zoom élevé, 1 m de colonne
 * mesure beaucoup de pixels ; à zoom bas, un carreau de 16 km serait un trait si sa colonne ne grandissait pas avec lui.
 */
function heightExpression(): unknown[] {
  const AT_Z12 = 5;
  // `zoom` ne peut être que l'entrée d'une interpolation de plus haut niveau : la densité est donc dans chaque cran.
  const stops: unknown[] = [];
  for (let zoom = 4; zoom <= 12; zoom++) stops.push(zoom, ['*', AT_Z12 * 2 ** (12 - zoom), ['sqrt', ['get', 'd']]]);
  return ['interpolate', ['linear'], ['zoom'], ...stops];
}

let shownKey = '';
let viewZoom = 6;

function sizeAt(sheet: PopulationSheet, zoom: number): number {
  const z = Math.min(12, Math.max(4, Math.floor(zoom)));
  return sheet.tailles.find(([tileZoom]) => tileZoom === z)?.[1] ?? 200;
}

export const population = defineModule<PopulationData>({
  id: 'population',
  name: 'Population',
  category: 'territoire',
  description: 'Habitants au carreau de 200 m, en colonnes : hauteur = densité, couleur au choix (niveau de vie, pauvreté, âge).',
  attribution: 'INSEE, Filosofi 2019 (licence ouverte Etalab)',
  timeStepMs: 3_600_000, // statistique annuelle : ne dépend pas de l'instant affiché
  followsView: false,

  settings: [
    {
      id: 'couleur',
      label: 'Couleur',
      defaultValue: 'd',
      options: [
        { value: 'd', label: 'Densité' },
        { value: 'niv', label: 'Niveau de vie' },
        { value: 'pauv', label: 'Pauvreté' },
        { value: 'a65', label: '65 ans et +' },
      ],
    },
    {
      id: 'relief',
      label: 'Affichage',
      defaultValue: 'colonnes',
      options: [
        { value: 'colonnes', label: 'Colonnes 3D' },
        { value: 'plat', label: 'À plat' },
      ],
    },
  ],

  async load({ signal }) {
    return { sheet: await loadTileSheet<PopulationSheet>('population', signal) };
  },

  legend(settings, data) {
    if (!data) return [];
    const variable = (settings.couleur ?? 'd') as Variable;
    const cuts = thresholds(variable, data.sheet.donnees);
    const ramp = DAY_RAMP;
    const items: LegendItem[] = ramp.map((color, i) => ({
      color,
      label: VARIABLES[variable].legendLabel(i === 0 ? null : cuts[i - 1]!, i === ramp.length - 1 ? null : cuts[i]!),
    }));
    return items;
  },

  summary({ data }) {
    if (!data) return null;
    const { habitants, millesime } = data.sheet.donnees;
    return `${(habitants / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} millions d’habitants · recensement fiscal ${millesime} · carreaux de 200 m`;
  },

  native: {
    add(map: MapLibreMap) {
      shownKey = '';
      // Les couches sont ajoutées par `update`, quand la fiche des tuiles est arrivée (la source en a besoin).
      void map;
    },
    update(map, { data, settings, night, view, selection }) {
      viewZoom = view.zoom;
      if (!data) return;
      const sheet = data.sheet;
      if (!map.getSource(SOURCE_ID)) {
        addTileSource(map, SOURCE_ID, sheet);
        const before = fillInsertionId(map);
        map.addLayer(
          {
            id: COLUMNS_ID,
            type: 'fill-extrusion',
            source: SOURCE_ID,
            'source-layer': sheet.couche,
            paint: { 'fill-extrusion-opacity': 0.88, 'fill-extrusion-vertical-gradient': true },
          } as never,
          before,
        );
        map.addLayer(
          { id: FLAT_ID, type: 'fill', source: SOURCE_ID, 'source-layer': sheet.couche, paint: { 'fill-opacity': 0.78 } } as never,
          before,
        );
        const ring = selectionRingLayers(SELECTED_ID, SOURCE_ID, ['==', ['get', 'pop'], -1], [[5, 1.5], [12, 3]]);
        addSelectionRing(map, ring.map((layer) => ({ ...layer, 'source-layer': sheet.couche }) as never), before);
        shownKey = '';
      }
      // Sous les autres couches natives qui dessinent une zone (isochrones) : elles s'activent dans n'importe quel ordre.
      for (const id of [COLUMNS_ID, FLAT_ID]) if (map.getLayer(UNDER) && map.getLayer(id)) map.moveLayer(id, UNDER);
      const variable = (settings.couleur ?? 'd') as Variable;
      const flat = settings.relief === 'plat';
      const key = `${variable}:${flat}:${night >= 0.5}`;
      if (key !== shownKey) {
        shownKey = key;
        const color = colorExpression(variable, sheet.donnees, night) as never;
        map.setPaintProperty(COLUMNS_ID, 'fill-extrusion-color', color);
        map.setPaintProperty(COLUMNS_ID, 'fill-extrusion-height', heightExpression() as never);
        map.setPaintProperty(COLUMNS_ID, 'fill-extrusion-base', 0);
        map.setPaintProperty(FLAT_ID, 'fill-color', color);
        map.setLayoutProperty(COLUMNS_ID, 'visibility', flat ? 'none' : 'visible');
        map.setLayoutProperty(FLAT_ID, 'visibility', flat ? 'visible' : 'none');
      }
      const cell = selection as Cell | null;
      setSelectionRingFilter(
        map,
        SELECTED_ID,
        cell ? ['all', ['==', ['get', 'pop'], cell.pop], ['==', ['get', 'd'], cell.d], ['==', ['get', 'niv'], cell.niv], ['==', ['get', 'men'], cell.men]] : ['==', ['get', 'pop'], -1],
      );
    },
    remove(map) {
      for (const id of [...selectionRingIds(SELECTED_ID), FLAT_ID, COLUMNS_ID]) if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      shownKey = '';
    },
    pickable: {
      layerIds: [COLUMNS_ID, FLAT_ID],
      toObject: (feature) => ({ ...(feature.properties as object), zoom: viewZoom }),
    },
  },

  select(object) {
    const p = object as Record<string, number>;
    if (p.pop === undefined) return null;
    return { pop: p.pop, d: p.d, men: p.men, niv: p.niv, pauv: p.pauv, a65: p.a65, imp: p.imp, zoom: p.zoom };
  },

  describe(selection, { data }): InfoContent | null {
    const cell = selection as Cell & { zoom: number };
    if (!data) return null;
    const { millesime } = data.sheet.donnees;
    const size = sizeAt(data.sheet.donnees, cell.zoom);
    const aggregated = size > 200;
    const notes: string[] = [];
    if (cell.imp >= 50) {
      notes.push(
        `Secret statistique : ${cell.imp} % des habitants de ce ${aggregated ? 'secteur' : 'carreau'} vivent dans des carreaux de moins de 11 ménages fiscaux, dont l’INSEE ne publie pas les valeurs exactes mais des valeurs approchées (imputées). Lisez ces chiffres comme des ordres de grandeur.`,
      );
    } else if (cell.imp > 0) {
      notes.push(`${cell.imp} % des habitants vivent dans des carreaux dont les valeurs sont imputées (moins de 11 ménages fiscaux, secret statistique).`);
    } else {
      notes.push('Toutes les valeurs de ce carreau sont celles de l’INSEE (au moins 11 ménages fiscaux).');
    }
    if (aggregated) {
      notes.push(`Carreau agrégé à cette échelle : habitants et ménages sont les sommes des carreaux de 200 m, les ratios en sont recalculés. Zoomez pour le détail.`);
    }
    return {
      kind: `Population · carreau de ${fmtSize(size)}`,
      title: `${fmt(cell.pop)} habitants`,
      subtitle: `${fmt(cell.d)} habitants par km²`,
      status: plainStatus(`INSEE, Filosofi ${millesime}`),
      figures: [
        { value: fmt(cell.pop), label: 'habitants' },
        { value: fmt(cell.niv), unit: '€/an', label: 'niveau de vie moyen' },
        { value: `${cell.pauv} %`, label: 'ménages pauvres' },
      ],
      fields: [
        ['Ménages', fmt(cell.men)],
        ['65 ans et plus', `${cell.a65} %`],
        ['Valeurs imputées', `${cell.imp} % des habitants`],
      ],
      note: `${notes.join(' ')} Niveau de vie : revenu disponible par unité de consommation, moyenne des habitants.`,
      link: { href: 'https://www.insee.fr/fr/statistiques/7655475', label: 'Données carroyées de l’INSEE' },
    };
  },
});
