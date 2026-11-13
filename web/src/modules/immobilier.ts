/**
 * Module « Prix de l'immobilier » : les prix de vente des logements au m², France métropolitaine (DGFiP, DVF ; Etalab).
 *
 * Le serveur a préparé les ventes en tuiles vectorielles (`server/src/tiles/dvf.rs`) :
 * - **de loin (zoom < 14)** : des carreaux de 32 km à 100 m selon le zoom, qui portent, pour chaque type de bien
 *   (appartements, maisons, tous) et chaque période (12 mois, 5 ans), le nombre de ventes, la **médiane** du prix au m²
 *   et les quartiles. Une médiane ne s'additionne pas : le serveur fusionne des histogrammes logarithmiques (voir `dvf.rs`) ;
 * - **de près (zoom ≥ 14)** : une vente par point (mois, prix, surface, pièces), sans adresse.
 *
 * Les propriétés d'un carreau se nomment `<grandeur><type><période>` : `pa5` = médiane (p), appartements (a), 5 ans (5) ;
 * `nm1` = nombre de ventes (n), maisons (m), 12 mois (1) ; `l…` et `h…` : premier et troisième quartiles.
 *
 * Couleur : palette **divergente autour d'une médiane de référence** (bleu = moins cher, rose = plus cher, gris = au
 * niveau de la médiane) : la médiane nationale du type choisi, ou celle de la **zone affichée** (réglage « Référence ») pour
 * comparer les quartiers d'une ville chère entre eux (à Paris, tout dépasse 2,8 fois la médiane nationale). Le relief
 * (option) donne le nombre de ventes.
 */
import { IMMO } from '../design/tokens';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { aboveBuildingsId, fillInsertionId } from '../map/baseMap';
import { addTileSource, loadTileSheet, type TileSheet } from '../map/vectorTiles';
import { addSelectionRing, selectionRingIds, selectionRingLayers, setSelectionRingFilter } from './statusColors';

const SOURCE_ID = 'immobilier';
const FILL_ID = 'immobilier-carreaux';
const EXTRUSION_ID = 'immobilier-relief';
const POINTS_ID = 'immobilier-ventes';
const SELECTED_ID = 'immobilier-choisi';
const SELECTED_POINT_ID = 'immobilier-vente-choisie';
/** Pastilles du nombre de ventes sur un même point (calculées côté navigateur, voir `refreshStacks`). */
const STACKS_SOURCE_ID = 'immobilier-piles';
const STACKS_ID = 'immobilier-piles';
const STACKS_LABEL_ID = 'immobilier-piles-nombre';
/** Zoom à partir duquel les pastilles apparaissent (on y distingue les points voisins). */
const STACKS_FROM_ZOOM = 16;
/** Au plus autant de ventes dans une fiche (la sélection voyage dans l'adresse) ; le nombre exact reste affiché. */
const MAX_STACK = 40;
/** Zone des isochrones (module `isochrones`) : les couches de tuiles passent dessous. */
const UNDER = 'isochrones-zone';

/**
 * Divergente, sept classes autour de la médiane nationale : bleu (moins cher) → gris (autour de la médiane) → rose
 * (plus cher). Ni brun ni orange (population, accidents, TGV). Jour : les extrêmes sont les plus foncés ; nuit : les plus
 * clairs. Chaque demi-palette est validée avec `validate_palette.js --ordinal` (une teinte, luminosité monotone, écarts nets,
 * bout clair au-dessus de 2:1 sur le fond), le gris central à 2,5:1 (jour) ; l'ordre des classes se lit aussi par la teinte.
 */
const DAY_RAMP = IMMO.jour;
const NIGHT_RAMP = IMMO.nuit;
/** Bornes des classes, en multiples de la médiane nationale : moins de la moitié, 50-70 %, 70-90 %, autour de la médiane (90-115 %), 115-170 %, 170-280 %, plus de 2,8 fois. */
const RATIOS = [0.5, 0.7, 0.9, 1.15, 1.7, 2.8];

type Kind = 'a' | 'm' | 't';
type Period = '1' | '5';

interface Stats {
  n: number;
  mediane: number;
  q1: number;
  q3: number;
}

interface YearReport {
  annee: number;
  mutations: number;
  gardees: number;
}

interface ImmobilierSheet {
  moisReference: string;
  debut12mois: string;
  debut5ans: string;
  pointsDepuis: number;
  ventes: number;
  national: Record<`${Kind}${Period}`, Stats>;
  annees: YearReport[];
  tailles: Array<[number, number]>;
  explorateur: string;
}

interface ImmobilierData {
  sheet: TileSheet<ImmobilierSheet>;
}

/** Propriétés d'un objet de tuile : une vente (`mo`, `ty`, `pc`, `sf`, `pr`, `em`) ou un carreau (`n…`, `p…`, `l…`, `h…`). */
type Props = Record<'mo' | 'ty' | 'pc' | 'sf' | 'pr' | 'em', number> & Record<string, number | undefined>;

/** Une vente d'un point partagé : `[mois, type (0 appartement, 1 maison), pièces, surface, prix, €/m²]`. */
type Sale = [mo: number, ty: number, pc: number, sf: number, pr: number, em: number];
/** Ventes d'un même point (positions arrondies à ~20 m : tout un immeuble se retrouve au même endroit). */
interface StackInfo {
  /** Nombre total de ventes sur le point. */
  n: number;
  /** Les plus récentes d'abord, au plus `MAX_STACK`. */
  ventes: Sale[];
}

const fmt = (n: number) => Math.round(n).toLocaleString('fr-FR');
const fmtSize = (m: number) => (m >= 1000 ? `${(m / 1000).toLocaleString('fr-FR')} km` : `${m} m`);
const KIND_LABEL: Record<Kind, string> = { a: 'Appartements', m: 'Maisons', t: 'Tous logements' };
const KIND_LABEL_LOWER: Record<Kind, string> = { a: 'd’appartements', m: 'de maisons', t: 'de logements' };

/** Mois « 2025-12 » → « décembre 2025 ». */
/** Mois (depuis janvier 2000) → « déc. 2025 ». */
function shortMonth(mo: number): string {
  return new Date(Date.UTC(2000 + Math.floor(mo / 12), mo % 12, 1)).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function monthName(label: string): string {
  const [year, month] = label.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Mois « 2025-12 » → nombre de mois depuis janvier 2000 (comme la propriété `mo` des ventes). */
function monthIndex(label: string): number {
  const [year, month] = label.split('-').map(Number) as [number, number];
  return (year - 2000) * 12 + month - 1;
}

function periodLabel(sheet: ImmobilierSheet, period: Period): string {
  const start = period === '1' ? sheet.debut12mois : sheet.debut5ans;
  return `${monthName(start)} à ${monthName(sheet.moisReference)}`;
}

/**
 * Médiane de la zone affichée (réglage « Référence : zone affichée »), recalculée quand la carte s'arrête : `null` tant
 * qu'elle n'est pas connue, ou s'il y a trop peu de ventes à l'écran (on revient alors à la médiane nationale).
 */
let viewMedian: number | null = null;
/** En dessous, la médiane de la zone serait trop fragile pour servir de référence. */
const MIN_VIEW_SALES = 30;

/** Médiane de référence, en €/m² : celle de la zone affichée si elle est demandée et connue, sinon la nationale (5 ans). */
function referenceMedian(kind: Kind, sheet: ImmobilierSheet, reference: string | undefined): number {
  return reference === 'vue' && viewMedian ? viewMedian : sheet.national[`${kind}5`].mediane;
}

/** Bornes des sept classes, en €/m² : multiples de la médiane de référence, arrondis à 50 €. */
function thresholds(kind: Kind, sheet: ImmobilierSheet, reference?: string): number[] {
  const median = referenceMedian(kind, sheet, reference);
  return RATIOS.map((ratio) => Math.round((median * ratio) / 50) * 50);
}

/**
 * Médiane pondérée des objets dessinés à l'écran : les carreaux (médiane du carreau, pondérée par son nombre de ventes)
 * ou, de près, les ventes elles-mêmes. C'est une médiane de médianes pondérée, une approximation honnête de la médiane
 * des ventes de la zone (la vraie demanderait les histogrammes). Les carreaux répétés au bord des tuiles comptent
 * deux fois : sans effet visible sur une zone entière.
 */
function medianOnScreen(map: MapLibreMap, combo: string, pointsFrom: number, relief: boolean): number | null {
  const points = map.getZoom() >= pointsFrom;
  const layer = points ? POINTS_ID : relief ? EXTRUSION_ID : FILL_ID;
  if (!map.getLayer(layer)) return null;
  const values: Array<[number, number]> = [];
  let total = 0;
  for (const feature of map.queryRenderedFeatures({ layers: [layer] })) {
    const p = feature.properties as Record<string, number | undefined>;
    const value = points ? p.em : p[`p${combo}`];
    const weight = points ? 1 : (p[`n${combo}`] ?? 0);
    if (!value || !weight) continue;
    values.push([value, weight]);
    total += weight;
  }
  if (total < MIN_VIEW_SALES) return null;
  values.sort((a, b) => a[0] - b[0]);
  let seen = 0;
  for (const [value, weight] of values) {
    seen += weight;
    if (seen >= total / 2) return value;
  }
  return null;
}

/** Couleur par classes (`step`) : la légende dit exactement ce qu'on voit. */
function colorExpression(property: unknown[], cuts: number[], night: number): unknown[] {
  const ramp = night >= 0.5 ? NIGHT_RAMP : DAY_RAMP;
  const expression: unknown[] = ['step', property, ramp[0]];
  cuts.forEach((cut, i) => expression.push(cut, ramp[i + 1]));
  return expression;
}

/**
 * Hauteur (mètres) du relief : racine de la densité de ventes (ventes par carreau ÷ surface du carreau), pour qu'un
 * carreau de 32 km et un de 100 m soient comparables, × un facteur qui double à chaque zoom perdu (1 m de colonne
 * mesure moins de pixels de loin).
 */
function heightExpression(sheet: ImmobilierSheet, count: string): unknown[] {
  const AT_Z13 = 18;
  const stops: unknown[] = [];
  for (const [zoom, size] of sheet.tailles) {
    stops.push(zoom, ['*', AT_Z13 * 2 ** (13 - zoom) * (100 / size), ['sqrt', ['get', count]]]);
  }
  return ['interpolate', ['linear'], ['zoom'], ...stops];
}

/** Filtre des ventes affichées de près : type et période choisis. */
function pointFilter(kind: Kind, period: Period, sheet: ImmobilierSheet): unknown[] {
  const filters: unknown[] = [['>', ['get', 'pr'], 0]];
  if (kind !== 't') filters.push(['==', ['get', 'ty'], kind === 'a' ? 0 : 1]);
  if (period === '1') filters.push(['>=', ['get', 'mo'], monthIndex(sheet.debut12mois)]);
  return ['all', ...filters];
}

let shownKey = '';
/** La carte, gardée à l'activation : la couche ne se redessine pas quand on déplace la vue (`followsView: false`), le zoom d'un clic se lit donc sur la carte. */
let theMap: MapLibreMap | null = null;
let viewZoom = 6;

function sizeAt(sheet: ImmobilierSheet, zoom: number): number {
  const z = Math.min(13, Math.max(4, Math.floor(zoom)));
  return sheet.tailles.find(([tileZoom]) => tileZoom === z)?.[1] ?? 100;
}

/** Ce que `update` a affiché en dernier : de quoi recalculer la médiane de la zone quand la carte s'arrête. */
let current: { combo: string; pointsFrom: number; relief: boolean; reference: string } | null = null;

/**
 * Recalcule la médiane de la zone affichée. Hystérésis de 3 % : un petit déplacement ne repeint pas la carte (et repeindre
 * déclenche un nouvel « idle », qui retrouve la même médiane : pas de boucle). Rend vrai si elle a changé.
 */
function refreshViewMedian(map: MapLibreMap): boolean {
  if (!current || current.reference !== 'vue') return false;
  const median = medianOnScreen(map, current.combo, current.pointsFrom, current.relief);
  const rounded = median ? Math.round(median / 50) * 50 : null;
  if (rounded === viewMedian) return false;
  if (rounded && viewMedian && Math.abs(rounded / viewMedian - 1) < 0.03) return false;
  viewMedian = rounded;
  return true;
}

/** Repeint la couche avec les derniers réglages (fixé par `update`). */
let repaint: (() => void) | null = null;

/** Nom de la couche des tuiles et filtre des ventes affichées (type, période), fixés par `update`. */
let salesLayer = '';
let shownPointsFilter: unknown[] | null = null;

const saleOf = (p: Record<string, unknown>): Sale => [Number(p.mo), Number(p.ty), Number(p.pc), Number(p.sf), Number(p.pr), Number(p.em)];

/** Les ventes affichées des tuiles chargées, avec leur position : de quoi regrouper celles qui partagent un point. */
function loadedSales(map: MapLibreMap): Array<{ lng: number; lat: number; sale: Sale }> {
  if (!salesLayer || !map.getSource(SOURCE_ID)) return [];
  const features = map.querySourceFeatures(SOURCE_ID, { sourceLayer: salesLayer, filter: shownPointsFilter as never });
  const found: Array<{ lng: number; lat: number; sale: Sale }> = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (feature.geometry.type !== 'Point') continue;
    const [lng, lat] = feature.geometry.coordinates as [number, number];
    const sale = saleOf(feature.properties);
    // Une vente au bord d'une tuile figure dans les deux : on ne la compte qu'une fois.
    const key = `${lng.toFixed(6)}|${lat.toFixed(6)}|${sale.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ lng, lat, sale });
  }
  return found;
}

/** Les ventes qui partagent le point d'une vente cliquée (la sienne comprise), les plus récentes d'abord. */
function stackAt(map: MapLibreMap, lng: number, lat: number): StackInfo {
  const EPS = 2e-6; // ~0,2 m : très en dessous de la grille de 20 m
  const sales = loadedSales(map)
    .filter((entry) => Math.abs(entry.lng - lng) < EPS && Math.abs(entry.lat - lat) < EPS)
    .map((entry) => entry.sale)
    .sort((a, b) => b[0] - a[0] || b[4] - a[4]);
  return { n: sales.length, ventes: sales.slice(0, MAX_STACK) };
}

/** Pastilles « nombre de ventes » sur les points qui en portent plusieurs (zoom ≥ 16, fonds de tuiles chargés). */
function refreshStacks(map: MapLibreMap): void {
  const source = map.getSource(STACKS_SOURCE_ID) as { setData(data: unknown): void } | undefined;
  if (!source) return;
  const features: unknown[] = [];
  if (map.getZoom() >= STACKS_FROM_ZOOM) {
    const groups = new Map<string, { lng: number; lat: number; n: number }>();
    for (const { lng, lat } of loadedSales(map)) {
      const key = `${Math.round(lng * 1e5)}|${Math.round(lat * 1e5)}`;
      const group = groups.get(key);
      if (group) group.n++;
      else groups.set(key, { lng, lat, n: 1 });
    }
    for (const g of groups.values()) {
      if (g.n > 1) features.push({ type: 'Feature', properties: { n: g.n }, geometry: { type: 'Point', coordinates: [g.lng, g.lat] } });
    }
  }
  source.setData({ type: 'FeatureCollection', features });
}

/** La carte s'est arrêtée et ses tuiles sont chargées : si la médiane de la zone a changé, on repeint tout de suite. */
function onIdle(): void {
  if (!theMap) return;
  if (refreshViewMedian(theMap)) repaint?.();
  refreshStacks(theMap);
}

export const immobilier = defineModule<ImmobilierData>({
  id: 'immobilier',
  name: 'Prix de l’immobilier',
  category: 'territoire',
  description: 'Prix de vente au m² des logements (médiane par carreau, ventes une à une de près) : appartements, maisons, 12 mois ou 5 ans.',
  attribution: 'DGFiP, DVF ; Etalab (licence ouverte)',
  timeStepMs: 3_600_000, // statistique semestrielle : ne dépend pas de l'instant affiché
  // Suit la vue pour la référence « zone affichée » (sinon, rien ne change quand on se déplace : la clé de `update` est la même).
  followsView: true,

  settings: [
    {
      id: 'type',
      label: 'Biens',
      defaultValue: 't',
      options: [
        { value: 't', label: 'Tous' },
        { value: 'a', label: 'Appartements' },
        { value: 'm', label: 'Maisons' },
      ],
    },
    {
      id: 'periode',
      label: 'Période',
      defaultValue: '5',
      options: [
        { value: '5', label: '5 ans' },
        { value: '1', label: '12 mois' },
      ],
    },
    {
      id: 'reference',
      label: 'Référence',
      // Par défaut, la zone affichée : vue de toute la France, c'est presque la médiane nationale ; dans une ville, les
      // quartiers se distinguent au lieu de tomber tous dans la classe « plus de 2,8 fois la médiane nationale ».
      defaultValue: 'vue',
      options: [
        { value: 'france', label: 'Médiane nationale' },
        { value: 'vue', label: 'Zone affichée' },
      ],
    },
    {
      id: 'relief',
      label: 'Affichage',
      defaultValue: 'plat',
      options: [
        { value: 'plat', label: 'À plat' },
        { value: '3d', label: 'Relief : nombre de ventes' },
      ],
    },
  ],

  async load({ signal }) {
    return { sheet: await loadTileSheet<ImmobilierSheet>('dvf', signal) };
  },

  legend(settings, data) {
    if (!data) return [];
    const kind = (settings.type ?? 't') as Kind;
    const cuts = thresholds(kind, data.sheet.donnees, settings.reference);
    const middle = settings.reference === 'vue' && viewMedian ? 'médiane de la zone affichée' : 'médiane nationale';
    return DAY_RAMP.map<LegendItem>((color, i) => ({
      color,
      label:
        i === 0
          ? `Moins de ${fmt(cuts[0]!)} €/m²`
          : i === DAY_RAMP.length - 1
            ? `${fmt(cuts[i - 1]!)} €/m² et plus`
            : i === 3
              ? `${fmt(cuts[2]!)} à ${fmt(cuts[3]!)} €/m² (${middle})`
              : `${fmt(cuts[i - 1]!)} à ${fmt(cuts[i]!)} €/m²`,
    }));
  },

  summary({ data, settings }) {
    if (!data) return null;
    const kind = (settings.type ?? 't') as Kind;
    const period = (settings.periode ?? '5') as Period;
    const stats = data.sheet.donnees.national[`${kind}${period}`];
    const national = `Médiane nationale ${KIND_LABEL_LOWER[kind]} : ${fmt(stats.mediane)} €/m² (${fmt(stats.n / 1000)} milliers de ventes, ${periodLabel(data.sheet.donnees, period)})`;
    if (settings.reference !== 'vue') return `${national} · centré sur la médiane nationale`;
    return viewMedian
      ? `Médiane de la zone affichée : ${fmt(viewMedian)} €/m² · couleurs centrées sur elle · ${national}`
      : `${national} · trop peu de ventes à l'écran pour une médiane de la zone`;
  },

  native: {
    add(map: MapLibreMap) {
      shownKey = '';
      theMap = map;
      viewMedian = null;
      map.on('idle', onIdle);
    },
    update(map, { data, settings, night, view, selection }) {
      viewZoom = view.zoom;
      if (!data) return;
      const sheet = data.sheet;
      const info = sheet.donnees;
      if (!map.getSource(SOURCE_ID)) {
        addTileSource(map, SOURCE_ID, sheet);
        const before = fillInsertionId(map);
        // Les ventes (points) restent visibles au-dessus des bâtiments 3D : sous les textes seulement.
        const abovePoints = aboveBuildingsId(map);
        const common = { source: SOURCE_ID, 'source-layer': sheet.couche };
        map.addLayer({ id: EXTRUSION_ID, type: 'fill-extrusion', ...common, maxzoom: info.pointsDepuis, paint: { 'fill-extrusion-opacity': 0.88, 'fill-extrusion-vertical-gradient': true } } as never, before);
        map.addLayer({ id: FILL_ID, type: 'fill', ...common, maxzoom: info.pointsDepuis, paint: { 'fill-opacity': 0.8 } } as never, before);
        map.addLayer(
          {
            id: POINTS_ID,
            type: 'circle',
            ...common,
            minzoom: info.pointsDepuis,
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 3.5, 17, 6, 20, 10],
              'circle-opacity': 0.92,
              'circle-stroke-width': 1,
            },
          } as never,
          abovePoints,
        );
        salesLayer = sheet.couche;
        // Pastille du nombre de ventes sur un point partagé (sous la vente choisie, au-dessus des points).
        map.addSource(STACKS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
        map.addLayer(
          {
            id: STACKS_ID,
            type: 'circle',
            source: STACKS_SOURCE_ID,
            minzoom: STACKS_FROM_ZOOM,
            paint: {
              'circle-radius': ['interpolate', ['linear'], ['zoom'], 16, 8, 20, 12],
              'circle-color': '#14141a',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 1.5,
              'circle-translate': [0, -10],
            },
          } as never,
          abovePoints,
        );
        map.addLayer(
          {
            id: STACKS_LABEL_ID,
            type: 'symbol',
            source: STACKS_SOURCE_ID,
            minzoom: STACKS_FROM_ZOOM,
            layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-allow-overlap': true, 'text-ignore-placement': true },
            paint: { 'text-color': '#ffffff', 'text-translate': [0, -10] },
          } as never,
          abovePoints,
        );
        const ring = selectionRingLayers(SELECTED_ID, SOURCE_ID, ['==', ['get', 'pr'], -1], [[5, 1.5], [13, 3]]);
        addSelectionRing(map, ring.map((layer) => ({ ...layer, 'source-layer': sheet.couche, maxzoom: info.pointsDepuis }) as never), before);
        // La vente choisie : un cercle blanc cerné de sombre autour du point (deux couches, la sombre dessous).
        for (const [id, color, extra] of [[`${SELECTED_POINT_ID}-contour`, '#14141a', 3], [SELECTED_POINT_ID, '#ffffff', 0]] as const) {
          map.addLayer(
            {
              id,
              type: 'circle',
              ...common,
              minzoom: info.pointsDepuis,
              filter: ['==', ['get', 'pr'], -1],
              paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 6 + extra / 2, 20, 14 + extra / 2],
                'circle-color': 'rgba(0,0,0,0)',
                'circle-stroke-color': color,
                'circle-stroke-width': 2 + extra,
              },
            } as never,
            abovePoints,
          );
        }
        shownKey = '';
      }
      for (const id of [EXTRUSION_ID, FILL_ID]) if (map.getLayer(UNDER) && map.getLayer(id)) map.moveLayer(id, UNDER);
      const kind = (settings.type ?? 't') as Kind;
      const period = (settings.periode ?? '5') as Period;
      const relief = settings.relief === '3d';
      const reference = settings.reference ?? 'france';
      current = { combo: `${kind}${period}`, pointsFrom: info.pointsDepuis, relief, reference };
      if (reference === 'vue') refreshViewMedian(map);
      const keyOf = () => `${kind}${period}:${relief}:${night >= 0.5}:${reference}:${reference === 'vue' ? viewMedian : ''}`;
      const paint = () => {
        shownKey = keyOf();
        const combo = `${kind}${period}`;
        const cuts = thresholds(kind, info, reference);
        const cellColor = colorExpression(['get', `p${combo}`], cuts, night) as never;
        // Un carreau sans vente (de ce type, sur cette période) n'existe pas : il n'est pas dessiné.
        const hasSales = ['>', ['get', `n${combo}`], 0] as never;
        // Moins de 3 ventes : la médiane est fragile, le carreau est estompé (fill seulement : l'opacité du relief n'est pas pilotée par les données).
        map.setFilter(FILL_ID, hasSales);
        map.setPaintProperty(FILL_ID, 'fill-color', cellColor);
        map.setPaintProperty(FILL_ID, 'fill-opacity', ['case', ['<', ['get', `n${combo}`], 3], 0.45, 0.82] as never);
        map.setFilter(EXTRUSION_ID, hasSales);
        map.setPaintProperty(EXTRUSION_ID, 'fill-extrusion-color', cellColor);
        map.setPaintProperty(EXTRUSION_ID, 'fill-extrusion-height', heightExpression(info, `n${combo}`) as never);
        map.setPaintProperty(EXTRUSION_ID, 'fill-extrusion-base', 0);
        map.setLayoutProperty(EXTRUSION_ID, 'visibility', relief ? 'visible' : 'none');
        map.setLayoutProperty(FILL_ID, 'visibility', relief ? 'none' : 'visible');
        shownPointsFilter = pointFilter(kind, period, info);
        map.setFilter(POINTS_ID, shownPointsFilter as never);
        refreshStacks(map);
        map.setPaintProperty(POINTS_ID, 'circle-color', colorExpression(['get', 'em'], cuts, night) as never);
        map.setPaintProperty(POINTS_ID, 'circle-stroke-color', night >= 0.5 ? '#14141a' : '#ffffff');
      };
      repaint = paint;
      if (keyOf() !== shownKey) paint();
      const p = selection as Props | null;
      const isSale = !!p && p.pr > 0;
      const none = ['==', ['get', 'pr'], -1];
      setSelectionRingFilter(
        map,
        SELECTED_ID,
        p && !isSale
          ? ['all', ...['na5', 'nm5', 'pa5', 'pm5', 'pt5', 'nt5'].map((k) => ['==', ['get', k], p[k] ?? 0])]
          : none,
      );
      const salesFilter = isSale ? ['all', ['==', ['get', 'mo'], p.mo], ['==', ['get', 'pr'], p.pr], ['==', ['get', 'sf'], p.sf], ['==', ['get', 'ty'], p.ty]] : none;
      for (const id of [SELECTED_POINT_ID, `${SELECTED_POINT_ID}-contour`]) if (map.getLayer(id)) map.setFilter(id, salesFilter as never);
    },
    remove(map) {
      map.off('idle', onIdle);
      current = null;
      repaint = null;
      shownPointsFilter = null;
      for (const id of [`${SELECTED_POINT_ID}-contour`, SELECTED_POINT_ID, ...selectionRingIds(SELECTED_ID), STACKS_LABEL_ID, STACKS_ID, POINTS_ID, FILL_ID, EXTRUSION_ID]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(STACKS_SOURCE_ID)) map.removeSource(STACKS_SOURCE_ID);
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
      shownKey = '';
    },
    pickable: {
      layerIds: [POINTS_ID, FILL_ID, EXTRUSION_ID],
      toObject: (feature) => {
        const object: Record<string, unknown> = { ...(feature.properties as object), zoom: theMap?.getZoom() ?? viewZoom };
        // Plusieurs ventes sur le même point : la fiche les liste toutes (la plus récente d'abord).
        if (theMap && feature.layer.id === POINTS_ID && feature.geometry.type === 'Point') {
          const [lng, lat] = feature.geometry.coordinates as [number, number];
          const stack = stackAt(theMap, lng, lat);
          if (stack.n > 1) object.pile = stack;
        }
        return object;
      },
    },
  },

  select(object) {
    const p = object as Props;
    if (p.mo === undefined && p.na5 === undefined) return null;
    return { ...p } satisfies Props;
  },

  describe(selection, { data, settings }): InfoContent | null {
    const p = selection as Props;
    if (!data) return null;
    const sheet = data.sheet.donnees;
    const source = plainStatus('DGFiP, DVF ; Etalab');
    const link = { href: sheet.explorateur, label: 'Explorateur officiel des valeurs foncières' };
    const national = (kind: Kind) => sheet.national[`${kind}5`].mediane;

    const stack = (selection as { pile?: StackInfo }).pile;
    if (p.pr > 0 && stack && stack.n > 1) {
      // Plusieurs ventes sur le même point (un immeuble, un lotissement) : la liste, la plus récente d'abord.
      const rows = stack.ventes.map((sale) => {
        const [mo, ty, pc, sf, pr, em] = sale;
        return {
          cells: [shortMonth(mo), `${ty === 1 ? 'Maison' : 'Appart.'} ${fmt(sf)} m²${pc > 0 ? ` · ${pc} p.` : ''}`, fmt(pr), fmt(em)],
          select: { mo, ty, pc, sf, pr, em } satisfies Props,
        };
      });
      const ems = stack.ventes.map((sale) => sale[5]).sort((a, b) => a - b);
      const mid = ems[Math.floor(ems.length / 2)] ?? 0;
      const more = stack.n > stack.ventes.length ? ` (les ${stack.ventes.length} plus récentes)` : '';
      return {
        kind: 'Ventes · même point',
        title: `${stack.n} ventes à cet endroit`,
        subtitle: `${shortMonth(stack.ventes[stack.ventes.length - 1]![0])} à ${shortMonth(stack.ventes[0]![0])}`,
        status: source,
        figures: [
          { value: fmt(stack.n), label: 'ventes' },
          { value: fmt(mid), unit: '€/m²', label: 'médiane de ce point' },
        ],
        tables: [{ title: `Ventes${more}`, columns: ['Mois', 'Bien (surface, pièces)', 'Prix €', '€/m²'], rows }],
        note: 'Position arrondie à une vingtaine de mètres (conditions de réutilisation de la DGFiP) : toutes les ventes d’un même immeuble se retrouvent au même point. Date réduite au mois, aucune adresse. Cliquez une ligne pour le détail d’une vente.',
        link,
      };
    }

    if (p.pr > 0) {
      // Une vente.
      const kind: Kind = p.ty === 1 ? 'm' : 'a';
      const reference = national(kind);
      const gap = Math.round((p.em / reference - 1) * 100);
      const monthLabel = new Date(Date.UTC(2000 + Math.floor(p.mo / 12), p.mo % 12, 1)).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      return {
        kind: `Vente · ${kind === 'a' ? 'appartement' : 'maison'}`,
        title: `${fmt(p.pr)} €`,
        subtitle: `${fmt(p.em)} €/m² · ${fmt(p.sf)} m²${p.pc > 0 ? ` · ${p.pc} pièce${p.pc > 1 ? 's' : ''}` : ''}`,
        status: source,
        figures: [
          { value: fmt(p.em), unit: '€/m²', label: 'prix au m²' },
          { value: fmt(p.sf), unit: 'm²', label: 'surface bâtie' },
          { value: `${gap > 0 ? '+' : ''}${gap} %`, label: `vs médiane nationale` },
        ],
        fields: [
          ['Vendu en', monthLabel],
          ['Médiane nationale', `${fmt(reference)} €/m² (${KIND_LABEL[kind].toLowerCase()}, ${periodLabel(sheet, '5')})`],
        ],
        note: 'Un seul logement dans la vente (maison ou appartement, dépendances comprises dans le prix). Pour ne pas permettre de ré-identifier les personnes (conditions de réutilisation de la DGFiP), la date est réduite au mois, la position arrondie à une vingtaine de mètres et aucune adresse n’est publiée. Position et surface sont celles du fichier DVF, avec ses erreurs possibles.',
        link,
      };
    }

    // Un carreau.
    const kind = (settings.type ?? 't') as Kind;
    const period = (settings.periode ?? '5') as Period;
    const combo = `${kind}${period}`;
    const size = sizeAt(sheet, p.zoom ?? viewZoom);
    const n = p[`n${combo}`] ?? 0;
    const median = p[`p${combo}`] ?? 0;
    const q1 = p[`l${combo}`];
    const q3 = p[`h${combo}`];
    const reference = national(kind);
    const row = (k: Kind) => {
      const count = p[`n${k}${period}`] ?? 0;
      return count > 0 ? `${fmt(p[`p${k}${period}`] ?? 0)} €/m² (${fmt(count)} vente${count > 1 ? 's' : ''})` : 'aucune vente';
    };
    const notes: string[] = [];
    if (n < 5) notes.push(`Seulement ${n} vente${n > 1 ? 's' : ''} : la médiane est fragile, ne la prenez pas pour le prix du quartier.`);
    notes.push(
      'La médiane est lue sur un histogramme (128 classes logarithmiques, précision ~2 %) que le serveur fusionne carreau par carreau : une médiane ne s’additionne pas, on additionne des effectifs par classe de prix.',
    );
    if (q1 === undefined) notes.push('Les quartiles ne sont pas publiés à cette échelle (trop peu de ventes par carreau) : dézoomez.');
    return {
      kind: `Prix de l’immobilier · carreau de ${fmtSize(size)}`,
      title: n > 0 ? `${fmt(median)} €/m²` : 'Aucune vente',
      subtitle: `médiane · ${KIND_LABEL[kind].toLowerCase()} · ${period === '1' ? '12 derniers mois' : '5 ans'}`,
      status: source,
      figures: [
        { value: fmt(median), unit: '€/m²', label: 'médiane' },
        { value: fmt(n), label: `vente${n > 1 ? 's' : ''}` },
        { value: q1 !== undefined && q3 !== undefined ? `${fmt(q1)} – ${fmt(q3)}` : '–', unit: q1 !== undefined ? '€/m²' : undefined, label: '1er et 3e quartiles' },
      ],
      fields: [
        ['Période', periodLabel(sheet, period)],
        ['Appartements', row('a')],
        ['Maisons', row('m')],
        ['Médiane nationale', `${fmt(reference)} €/m² (${fmt(Math.round((median / reference) * 100))} % ici)`],
      ],
      note: notes.join(' '),
      link,
    };
  },
});
