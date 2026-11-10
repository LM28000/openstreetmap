/**
 * Module « Bornes de recharge » : les 50 000 stations de recharge pour véhicules électriques
 * de la base nationale consolidée (IRVE), regroupées par station par le serveur
 * (server/src/irve.rs, une fois par jour).
 *
 * La couleur dit la puissance maximale de la station, en quatre classes ordonnées d'une
 * seule teinte (du clair, lent, au foncé, ultra-rapide) ; à l'approche, la puissance est
 * écrite sur la station. Les stations les plus puissantes sont dessinées par-dessus.
 *
 * La base ne dit pas si une borne est libre en ce moment : la disponibilité en temps réel
 * existe dans la base nationale « dynamique », mais elle n'est pas reprise ici.
 */
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { defineModule } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { HALO, ink, type IconSheet, KEY, packIcons, selectionRing, zoomRamp } from './symbols';

interface Station {
  id: string;
  lon: number;
  lat: number;
  name: string;
  operator: string;
  address: string;
  pdc: number;
  kw: number;
  plugs: number;
  free?: boolean;
  hours?: string;
  tariff?: string;
  restricted?: boolean;
  powers: Array<[kw: number, count: number]>;
  updated?: string;
}

interface ChargersData {
  stations: Station[];
  byId: Map<string, Station>;
  updatedAt: number;
}

/**
 * Quatre classes de puissance : une seule teinte (turquoise), du clair (lent) au foncé
 * (ultra-rapide). Rampe ordinale validée avec validate_palette.js (--ordinal), en clair sur
 * le fond de la carte et en sombre sur le panneau (#0f121a) : une teinte, luminosité
 * monotone, écarts d'au moins 0,06, extrémités à plus de 2:1 de leur fond. Elle évite
 * le bleu (trains, pluie), l'orange (TGV), le vert (Intercités, vélos), le violet (avions)
 * et le magenta (bus), que l'ancienne rampe rose confondait avec les bus de « Ma ville ».
 * La taille du symbole double la couleur : plus la station est puissante, plus il est grand.
 */
const CLASSES: Array<{
  min: number;
  color: [number, number, number];
  css: string;
  text: [number, number, number];
  glyph: string;
  label: string;
  /** Rayon du point vu de loin, et taille de l'icône vue de près (pixels). */
  dot: number;
  icon: number;
}> = [
  { min: 0, color: [92, 192, 208], css: '#5cc0d0', text: [22, 26, 38], glyph: '#141a26', label: 'Jusqu’à 22 kW (normale)', dot: 2.2, icon: 17 },
  { min: 22.5, color: [43, 163, 184], css: '#2ba3b8', text: [22, 26, 38], glyph: '#141a26', label: '22 à 50 kW (accélérée)', dot: 3, icon: 20 },
  { min: 50, color: [18, 130, 154], css: '#12829a', text: [255, 255, 255], glyph: '#ffffff', label: '50 à 150 kW (rapide)', dot: 4.2, icon: 24 },
  { min: 150, color: [10, 99, 119], css: '#0a6377', text: [255, 255, 255], glyph: '#ffffff', label: '150 kW et plus (ultra-rapide)', dot: 5.6, icon: 29 },
];
/** À partir de ce zoom, chaque station porte le pictogramme d'une prise. */
const PLUG_MIN_ZOOM = 13;

// --- Pictogramme de prise ---

const PLUG_SCALE = 1.2;
const PLUG_BOX = 48;
const PLUG_CELL = Math.ceil((PLUG_BOX + 2 + 2 * 2.4 + 1) * PLUG_SCALE);
const plugKey = (cls: number) => `prise:${cls}`;

let plugs: IconSheet | undefined;
/** Les pictogrammes sont dessinés au premier usage (il faut un document pour créer un canvas). */
function plugSheet(): IconSheet {
  plugs ??= packIcons(
    CLASSES.map((cls, index) => ({
      key: plugKey(index),
      width: PLUG_CELL,
      height: PLUG_CELL,
      draw(c: CanvasRenderingContext2D) {
        c.translate(PLUG_CELL / 2, PLUG_CELL / 2);
        c.scale(PLUG_SCALE, PLUG_SCALE);
        ink(
          c,
          (k) => {
            k.beginPath();
            k.roundRect(-PLUG_BOX / 2, -PLUG_BOX / 2, PLUG_BOX, PLUG_BOX, 12);
          },
          cls.css,
          { key: 2 },
        );
        // La prise : deux broches, le boîtier arrondi, le câble.
        c.strokeStyle = cls.glyph;
        c.lineWidth = 4;
        c.lineCap = 'round';
        c.lineJoin = 'round';
        c.beginPath();
        c.moveTo(-6, -14);
        c.lineTo(-6, -4);
        c.moveTo(6, -14);
        c.lineTo(6, -4);
        c.moveTo(-11, -4);
        c.lineTo(11, -4);
        c.lineTo(11, 2);
        c.quadraticCurveTo(11, 10, 0, 10);
        c.quadraticCurveTo(-11, 10, -11, 2);
        c.closePath();
        c.moveTo(0, 10);
        c.lineTo(0, 17);
        c.stroke();
      },
    })),
  );
  return plugs;
}

const LABEL_MIN_ZOOM = 12;
const LABEL_BOX_PX = { width: 64, height: 26 };

const PLUGS: Array<[bit: number, label: string]> = [
  [2, 'Type 2'],
  [4, 'CCS Combo'],
  [8, 'CHAdeMO'],
  [1, 'Prise domestique (E/F)'],
  [16, 'Autre'],
];

const MIN_KW: Record<string, number> = { toutes: 0, rapides: 50, tres: 150 };

function classOf(kw: number): number {
  let index = 0;
  for (let i = 0; i < CLASSES.length; i++) if (kw >= CLASSES[i]!.min) index = i;
  return index;
}

const kwLabel = (kw: number) => `${Number.isInteger(kw) ? kw : kw.toFixed(1).replace('.', ',')} kW`;

async function loadChargers(signal: AbortSignal): Promise<ChargersData> {
  const response = await fetch('/api/bornes', { signal });
  if (response.status === 503) throw new Error('le serveur prépare encore la base des bornes (premier téléchargement)');
  if (!response.ok) throw new Error(`le serveur des bornes a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; stations: Station[] };
  // Les plus puissantes en dernier : elles sont dessinées par-dessus.
  const stations = json.stations.sort((a, b) => a.kw - b.kw);
  return { stations, byId: new Map(stations.map((s) => [s.id, s])), updatedAt: json.updatedAt };
}

function visible(data: ChargersData, settings: Readonly<Record<string, string>>): Station[] {
  const min = MIN_KW[settings.puissance ?? 'toutes'] ?? 0;
  const openOnly = (settings.acces ?? 'ouvertes') === 'ouvertes';
  return data.stations.filter((s) => s.kw >= min && !(openOnly && s.restricted));
}

/** Mémoire du dernier filtrage : la liste ne change qu'avec les données ou les réglages. */
let filterCache: { data: ChargersData; key: string; list: Station[] } | undefined;
function filtered(data: ChargersData, settings: Readonly<Record<string, string>>): Station[] {
  const key = `${settings.puissance}|${settings.acces}`;
  if (filterCache?.data !== data || filterCache.key !== key) filterCache = { data, key, list: visible(data, settings) };
  return filterCache.list;
}

let labelCache: { list: Station[]; band: number; stations: Station[] } | undefined;
function labelled(list: Station[], zoom: number): Station[] {
  const band = zoomBand(zoom);
  if (labelCache?.list !== list || labelCache.band !== band) {
    labelCache = { list, band, stations: declutter(list, zoom, { lon: (s) => s.lon, lat: (s) => s.lat, rank: (s) => -s.kw, box: LABEL_BOX_PX }) };
  }
  return labelCache.stations;
}

export const chargers = defineModule<ChargersData>({
  id: 'bornes',
  name: 'Bornes de recharge',
  category: 'energie',
  description: 'Les stations de recharge pour véhicules électriques, colorées selon leur puissance maximale.',
  attribution: 'Base nationale des IRVE, transport.data.gouv.fr (Licence Ouverte 2.0)',
  refreshIntervalMs: 6 * 3600_000,
  timeStepMs: 3_600_000, // pas d'historique : le dessin ne dépend pas de l'instant affiché
  zoomBreaks: halfZoomBreaks(LABEL_MIN_ZOOM),
  followsTerrain: true,

  settings: [
    {
      id: 'puissance',
      label: 'Puissance',
      options: [
        { value: 'toutes', label: 'Toutes' },
        { value: 'rapides', label: 'Rapides (≥ 50 kW)' },
        { value: 'tres', label: 'Ultra-rapides (≥ 150 kW)' },
      ],
      defaultValue: 'toutes',
    },
    {
      id: 'acces',
      label: 'Accès',
      options: [
        { value: 'ouvertes', label: 'Ouvertes à tous' },
        { value: 'toutes', label: 'Avec accès réservé' },
      ],
      defaultValue: 'ouvertes',
    },
  ],

  legend: () => CLASSES.map((c) => ({ color: c.css, label: c.label, size: 'small' as const })),

  load: ({ signal }) => loadChargers(signal),

  summary({ data, settings }) {
    if (!data) return null;
    const list = filtered(data, settings);
    const points = list.reduce((sum, s) => sum + s.pdc, 0);
    return `${list.length.toLocaleString('fr-FR')} stations · ${points.toLocaleString('fr-FR')} points de charge`;
  },

  deckLayers({ data, settings, selection, view, terrain }) {
    if (!data) return [];
    const list = filtered(data, settings);
    const chosen = selection ? data.byId.get((selection as { id: string }).id) : undefined;
    const onGround = (s: Station): [number, number, number] => [s.lon, s.lat, terrain.elevation(s.lon, s.lat)];
    const trigger = `${settings.puissance}|${settings.acces}`;
    const plugged = view.zoom >= PLUG_MIN_ZOOM;
    const dotScale = zoomRamp(view.zoom, 5, 10, 0.65, 1);
    const dotRadius = (s: Station) => CLASSES[classOf(s.kw)]!.dot;
    const iconSize = (s: Station) => CLASSES[classOf(s.kw)]!.icon;
    const sheet = plugged ? plugSheet() : undefined;
    return [
      // De loin : un point par station, plus gros quand elle est plus puissante ; le halo clair dès qu'il se voit.
      !plugged &&
        view.zoom >= 9 &&
        new ScatterplotLayer<Station>({
          id: 'bornes/halo',
          data: list,
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: (s) => dotRadius(s) + 1.6,
          radiusScale: dotScale,
          getFillColor: HALO,
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
      !plugged &&
        new ScatterplotLayer<Station>({
          id: 'bornes/stations',
          data: list,
          getPosition: onGround,
          radiusUnits: 'pixels',
          getRadius: dotRadius,
          radiusScale: dotScale,
          getFillColor: (s) => CLASSES[classOf(s.kw)]!.color,
          stroked: true,
          getLineColor: KEY,
          lineWidthUnits: 'pixels',
          getLineWidth: 0.8,
          billboard: true,
          pickable: true,
          autoHighlight: view.zoom < LABEL_MIN_ZOOM,
          highlightColor: [255, 255, 255, 160],
          updateTriggers: { getPosition: terrain.version, getFillColor: trigger },
          parameters: OVER_MAP,
        }),
      // De près : le pictogramme d'une prise, à la couleur et à la taille de la classe.
      sheet &&
        new IconLayer<Station>({
          id: 'bornes/prises',
          data: list,
          iconAtlas: sheet.atlas,
          iconMapping: sheet.mapping,
          getIcon: (s) => plugKey(classOf(s.kw)),
          getPosition: onGround,
          sizeUnits: 'pixels',
          getSize: iconSize,
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
      view.zoom >= LABEL_MIN_ZOOM &&
        new TextLayer<Station>({
          id: 'bornes/puissance',
          data: labelled(list, view.zoom),
          getPosition: onGround,
          getText: (s) => kwLabel(s.kw),
          characterSet: '0123456789, kW',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 12,
          getColor: (s) => CLASSES[classOf(s.kw)]!.text,
          // À droite du symbole, pour ne pas le cacher.
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: (s) => [(plugged ? iconSize(s) : dotRadius(s) * 2) / 2 + 3, 0],
          background: true,
          getBackgroundColor: (s) => [...CLASSES[classOf(s.kw)]!.color, 245],
          getBorderColor: [20, 26, 38, 170],
          getBorderWidth: 1,
          backgroundBorderRadius: 9,
          backgroundPadding: [6, 3],
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getPixelOffset: plugged },
          parameters: OVER_MAP,
        }),
      chosen && selectionRing('bornes/choisie', [chosen], onGround, (s) => (plugged ? iconSize(s) * 0.62 : dotRadius(s) + 8), OVER_MAP),
    ];
  },

  select(object) {
    return { id: (object as Station).id };
  },

  describe(selection, { data }) {
    const station = data?.byId.get((selection as { id: string }).id);
    if (!station) return null;
    const plugs = PLUGS.filter(([bit]) => station.plugs & bit).map(([, label]) => label);
    const fields: Array<[string, string]> = [
      ['Opérateur', station.operator || 'non renseigné'],
      ['Puissance maximale', kwLabel(station.kw)],
      ['Points de charge', String(station.pdc)],
      ['Prises', plugs.length ? plugs.join(', ') : 'non renseignées'],
      ['Paiement', station.free === true ? 'gratuit' : station.free === false ? 'payant' : 'non renseigné'],
      ['Accès', station.restricted ? 'réservé (clientèle, résidents…)' : 'ouvert à tous'],
    ];
    if (station.hours) fields.push(['Horaires', station.hours === '24/7' ? '24 h/24, 7 j/7' : station.hours]);
    if (station.tariff) fields.push(['Tarification', station.tariff]);
    if (station.updated) fields.push(['Données mises à jour le', station.updated.split('-').reverse().join('/')]);
    return {
      title: station.name || 'Station de recharge',
      subtitle: station.address || undefined,
      fields,
      tables: [
        {
          title: 'Points de charge par puissance',
          columns: ['Puissance', 'Points'],
          rows: station.powers.map(([kw, count]) => ({ cells: [kwLabel(kw), String(count)] })),
          empty: 'Puissance non renseignée.',
        },
      ],
      note: 'La disponibilité en temps réel des bornes n’est pas affichée.',
    };
  },
});
