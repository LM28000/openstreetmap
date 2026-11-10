/**
 * Module « Monuments historiques » : les 44 000 immeubles protégés de la base Mérimée (ministère
 * de la Culture, Licence Ouverte 2.0), collectés une fois par semaine par le serveur
 * (server/src/monuments.rs).
 *
 * Deux informations, deux canaux, et aucune couleur :
 * - la **catégorie** (religieux, château et demeure, militaire…) est dite par le pictogramme ;
 * - la **protection** est dite par la forme et la valeur du badge : un carré sombre à pictogramme
 *   clair pour un monument CLASSÉ (la protection la plus forte), un rond clair à pictogramme
 *   sombre pour un monument INSCRIT. Un monument protégé en partie seulement est un peu plus petit.
 * Pas de teinte : le badge noir et blanc ressort sur le fond clair de jour comme sur le fond sombre
 * de nuit (halo clair et contour sombre, comme les autres symboles), et ne prend aucune des couleurs
 * déjà prises par d'autres couches.
 *
 * À l'échelle de la France, des points (les classés d'abord, et au plus un par case) ; à partir du
 * zoom 11, les pictogrammes ; à partir du zoom 13, le nom du monument.
 */
import { IconLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { plainStatus } from '../core/infoStatus';
import { defineModule, type InfoContent, type LegendItem } from '../core/module';
import { declutter, halfZoomBreaks, zoomBand } from '../map/declutter';
import { OVER_MAP } from '../map/parameters';
import { HALO_CSS, KEY_CSS, KEY, packIcons, selectionRing, type IconSheet, zoomRamp } from './symbols';

/** Un monument, tel que le serveur le décrit (tableau de 12 cases, voir `monuments.rs`). */
export interface Monument {
  ref: string;
  lon: number;
  lat: number;
  /** Catégorie, de 0 à 7 (voir `CATEGORIES`). */
  cat: number;
  /** Protection : 0 inscrit, 1 classé, 2 inscrit en partie, 3 classé en partie. */
  prot: number;
  name: string;
  commune: string;
  dep: string;
  denomination: string;
  period: string;
  /** Date de la protection, « AAAA-MM-JJ » ou vide. */
  date: string;
  description: string;
}

export interface MonumentsData {
  list: Monument[];
  byRef: Map<string, Monument>;
  updatedAt: number;
  withoutPosition: number;
}

type Row = [string, number, number, number, number, string, string, string, string, string, string, string];

const isClassed = (m: Monument) => m.prot === 1 || m.prot === 3;
const isPartial = (m: Monument) => m.prot >= 2;

/** Catégories d'affichage : le nom, et le tracé du pictogramme (voir `drawGlyph`). */
const CATEGORIES = [
  { label: 'Religieux (églises, chapelles, abbayes)', short: 'Religieux' },
  { label: 'Château et demeure (châteaux, hôtels, manoirs, maisons)', short: 'Château et demeure' },
  { label: 'Militaire (forts, remparts, portes de ville)', short: 'Militaire' },
  { label: 'Civil et urbain (mairies, halles, théâtres, écoles)', short: 'Civil et urbain' },
  { label: 'Archéologique (sites, grottes ornées, oppidums)', short: 'Archéologique' },
  { label: 'Industriel, agricole et ouvrage d’art (moulins, ponts, usines)', short: 'Industriel, agricole, ouvrage d’art' },
  { label: 'Funéraire et commémoratif (croix, monuments aux morts, tombeaux)', short: 'Funéraire et commémoratif' },
  { label: 'Autre', short: 'Autre' },
] as const;

// --- Pictogrammes ---

const CELL = 64;
/** Rayon du badge, dans la cellule de 64 : laisse la place du halo et du contour. */
const BADGE = 25;
const iconKey = (cat: number, classed: boolean) => `m:${cat}:${classed ? 'c' : 'i'}`;

/** Trace le pictogramme d'une catégorie, centré en (0, 0), dans un carré d'environ 26 × 26. */
function drawGlyph(c: CanvasRenderingContext2D, cat: number): void {
  c.beginPath();
  switch (cat) {
    case 0: // église : toit pointu, croix au sommet
      c.moveTo(-9, 11);
      c.lineTo(-9, -1);
      c.lineTo(0, -8);
      c.lineTo(9, -1);
      c.lineTo(9, 11);
      c.closePath();
      c.moveTo(0, -8);
      c.lineTo(0, -16);
      c.moveTo(-4, -13);
      c.lineTo(4, -13);
      c.moveTo(-3, 11);
      c.lineTo(-3, 4);
      c.lineTo(3, 4);
      c.lineTo(3, 11);
      break;
    case 1: // château : deux tours crénelées reliées par un mur
      c.moveTo(-13, 11);
      c.lineTo(-13, -10);
      c.lineTo(-9, -10);
      c.lineTo(-9, -7);
      c.lineTo(-5, -7);
      c.lineTo(-5, -10);
      c.lineTo(-1, -10);
      c.lineTo(-1, -3);
      c.lineTo(1, -3);
      c.lineTo(1, -10);
      c.lineTo(5, -10);
      c.lineTo(5, -7);
      c.lineTo(9, -7);
      c.lineTo(9, -10);
      c.lineTo(13, -10);
      c.lineTo(13, 11);
      c.closePath();
      c.moveTo(-3, 11);
      c.lineTo(-3, 3);
      c.arc(0, 3, 3, Math.PI, 0);
      c.lineTo(3, 11);
      break;
    case 2: // militaire : un écu
      c.moveTo(-10, -11);
      c.lineTo(10, -11);
      c.lineTo(10, 1);
      c.quadraticCurveTo(10, 8, 0, 13);
      c.quadraticCurveTo(-10, 8, -10, 1);
      c.closePath();
      c.moveTo(0, -11);
      c.lineTo(0, 12);
      break;
    case 3: // civil : fronton et colonnes
      c.moveTo(-13, -4);
      c.lineTo(0, -12);
      c.lineTo(13, -4);
      c.closePath();
      c.moveTo(-9, -1);
      c.lineTo(-9, 8);
      c.moveTo(0, -1);
      c.lineTo(0, 8);
      c.moveTo(9, -1);
      c.lineTo(9, 8);
      c.moveTo(-13, 12);
      c.lineTo(13, 12);
      break;
    case 4: // archéologique : un dolmen (deux pierres dressées, une table)
      c.moveTo(-11, 12);
      c.lineTo(-9, -3);
      c.moveTo(11, 12);
      c.lineTo(9, -3);
      c.moveTo(-14, -3);
      c.lineTo(14, -6);
      c.lineTo(13, -9);
      c.lineTo(-13, -7);
      c.closePath();
      break;
    case 5: // industriel et ouvrage d'art : une cheminée d'usine et un toit en dents de scie
      c.moveTo(-12, 12);
      c.lineTo(-12, 0);
      c.lineTo(-4, -5);
      c.lineTo(-4, 0);
      c.lineTo(4, -5);
      c.lineTo(4, 12);
      c.moveTo(8, 12);
      c.lineTo(8, -12);
      c.lineTo(13, -12);
      c.lineTo(13, 12);
      c.moveTo(-12, 12);
      c.lineTo(13, 12);
      break;
    case 6: // funéraire : un obélisque
      c.moveTo(-4, 12);
      c.lineTo(-3, -6);
      c.lineTo(0, -13);
      c.lineTo(3, -6);
      c.lineTo(4, 12);
      c.closePath();
      c.moveTo(-8, 12);
      c.lineTo(8, 12);
      break;
    default: // autre : un losange
      c.moveTo(0, -11);
      c.lineTo(10, 0);
      c.lineTo(0, 11);
      c.lineTo(-10, 0);
      c.closePath();
  }
}

/** Un badge : carré sombre (classé) ou rond clair (inscrit), avec son pictogramme. */
function drawBadge(c: CanvasRenderingContext2D, cat: number, classed: boolean): void {
  c.translate(CELL / 2, CELL / 2);
  c.lineJoin = 'round';
  c.lineCap = 'round';
  const shape = () => {
    c.beginPath();
    if (classed) c.roundRect(-BADGE, -BADGE, BADGE * 2, BADGE * 2, 7);
    else c.arc(0, 0, BADGE, 0, Math.PI * 2);
  };
  // Halo clair, remplissage, contour sombre : le trait commun des symboles de la carte.
  shape();
  c.strokeStyle = HALO_CSS;
  c.lineWidth = 4 + 2 * 2.6;
  c.stroke();
  shape();
  c.fillStyle = classed ? KEY_CSS : '#ffffff';
  c.fill();
  shape();
  c.strokeStyle = KEY_CSS;
  c.lineWidth = 3;
  c.stroke();
  // Pictogramme : clair sur le badge sombre, sombre sur le badge clair.
  c.scale(0.85, 0.85);
  drawGlyph(c, cat);
  c.strokeStyle = classed ? '#ffffff' : KEY_CSS;
  c.lineWidth = 3.4;
  c.stroke();
}

let sheet: IconSheet | undefined;
/** Les pictogrammes sont dessinés au premier usage (il faut un document pour créer un canvas). */
function icons(): IconSheet {
  sheet ??= packIcons(
    CATEGORIES.flatMap((_, cat) =>
      [true, false].map((classed) => ({
        key: iconKey(cat, classed),
        width: CELL,
        height: CELL,
        draw: (c: CanvasRenderingContext2D) => drawBadge(c, cat, classed),
      })),
    ),
  );
  return sheet;
}

// --- Chargement ---

async function loadMonuments(signal: AbortSignal): Promise<MonumentsData> {
  const response = await fetch('/api/monuments', { signal });
  if (response.status === 503) throw new Error('le serveur prépare encore la base des monuments (premier téléchargement)');
  if (!response.ok) throw new Error(`le serveur des monuments a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; monuments: Row[]; sansPosition: number };
  const list: Monument[] = json.monuments.map(([ref, lon, lat, cat, prot, name, commune, dep, denomination, period, date, description]) => ({
    ref, lon, lat, cat, prot, name, commune, dep, denomination, period, date, description,
  }));
  // Les classés en dernier : ils sont dessinés par-dessus les inscrits.
  list.sort((a, b) => Number(isClassed(a)) - Number(isClassed(b)));
  return { list, byRef: new Map(list.map((m) => [m.ref, m])), updatedAt: json.updatedAt * 1000, withoutPosition: json.sansPosition };
}

// --- Filtres ---

function visible(data: MonumentsData, settings: Readonly<Record<string, string>>): Monument[] {
  const protection = settings.protection ?? 'tous';
  const type = settings.type ?? 'tous';
  return data.list.filter(
    (m) =>
      (protection === 'tous' || (protection === 'classes') === isClassed(m)) && (type === 'tous' || Number(type) === m.cat),
  );
}

/** Mémoire du dernier filtrage : la liste ne change qu'avec les données ou les réglages. */
let filterCache: { data: MonumentsData; key: string; list: Monument[] } | undefined;
function filtered(data: MonumentsData, settings: Readonly<Record<string, string>>): Monument[] {
  const key = `${settings.protection}|${settings.type}`;
  if (filterCache?.data !== data || filterCache.key !== key) filterCache = { data, key, list: visible(data, settings) };
  return filterCache.list;
}

// --- Désencombrement ---

/** Sous ce zoom : des points ; à partir de celui-ci, des pictogrammes ; puis le nom du monument. */
const ICON_ZOOM = 11;
const NAME_ZOOM = 14;
/** Au-delà de ce zoom, tous les pictogrammes sont dessinés (même serrés) ; avant, un par case. */
const ALL_ICONS_ZOOM = 16;
const LABEL_BOX = { width: 250, height: 26 };

let sparseCache: { list: Monument[]; band: number; items: Monument[] } | undefined;
/**
 * De loin, au plus un monument par case de 9 pixels (le classé l'emporte) : sans cela, 44 000 points
 * ne font qu'un aplat. Les classés sont dessinés par-dessus les inscrits (ordre de `list`).
 */
function sparse(list: Monument[], zoom: number): Monument[] {
  const band = zoomBand(zoom);
  if (sparseCache?.list !== list || sparseCache.band !== band) {
    const items = declutter(list, zoom, { lon: (m) => m.lon, lat: (m) => m.lat, rank: (m) => (isClassed(m) ? 0 : 1), box: { width: 9, height: 9 } });
    items.sort((a, b) => Number(isClassed(a)) - Number(isClassed(b)));
    sparseCache = { list, band, items };
  }
  return sparseCache.items;
}

let iconCache: { list: Monument[]; band: number; items: Monument[] } | undefined;
/** Pictogrammes de 11 à 16 : un par case de 23 pixels, pour ne pas se chevaucher dans les centres historiques. */
function spacedIcons(list: Monument[], zoom: number): Monument[] {
  const band = zoomBand(zoom);
  if (iconCache?.list !== list || iconCache.band !== band) {
    const items = declutter(list, zoom, { lon: (m) => m.lon, lat: (m) => m.lat, rank: (m) => (isClassed(m) ? 0 : 1), box: { width: 23, height: 23 } });
    items.sort((a, b) => Number(isClassed(a)) - Number(isClassed(b)));
    iconCache = { list, band, items };
  }
  return iconCache.items;
}

let labelCache: { list: Monument[]; band: number; items: Monument[] } | undefined;
function labelled(list: Monument[], zoom: number): Monument[] {
  const band = zoomBand(zoom);
  if (labelCache?.list !== list || labelCache.band !== band) {
    labelCache = { list, band, items: declutter(list, zoom, { lon: (m) => m.lon, lat: (m) => m.lat, rank: (m) => (isClassed(m) ? 0 : 1), box: LABEL_BOX }) };
  }
  return labelCache.items;
}

// --- Fiche ---

/** « 1930-11-30 » → « 30 novembre 1930 » ; « 1862-05 » → « mai 1862 » ; « 1862 » → « 1862 » (la base ne donne parfois que l'année). */
function formatDate(iso: string): string | undefined {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year) return undefined;
  if (!month) return String(year);
  const options: Intl.DateTimeFormatOptions = day ? { day: 'numeric', month: 'long', year: 'numeric' } : { month: 'long', year: 'numeric' };
  return new Date(Date.UTC(year, month - 1, day ?? 1)).toLocaleDateString('fr-FR', { ...options, timeZone: 'UTC' });
}

function protectionText(m: Monument): string {
  const level = isClassed(m) ? 'Classé' : 'Inscrit';
  const date = formatDate(m.date);
  return `${level} au titre des monuments historiques${isPartial(m) ? ' (en partie)' : ''}${date ? (m.date.length === 4 ? `, en ${date}` : `, le ${date}`) : ''}`;
}

const FRENCH_UPDATE = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export const monuments = defineModule<MonumentsData>({
  id: 'monuments',
  name: 'Monuments historiques',
  category: 'histoire',
  description: 'Les immeubles protégés au titre des monuments historiques : le pictogramme dit le genre, la forme du badge dit classé ou inscrit.',
  attribution: 'Base Mérimée, ministère de la Culture, data.gouv.fr (Licence Ouverte 2.0)',
  // Base mise à jour chaque semaine par le serveur : on la relit une fois par jour au plus.
  refreshIntervalMs: 24 * 3600_000,
  // Pas d'historique : le dessin ne dépend pas de l'instant affiché.
  timeStepMs: 3_600_000,
  zoomBreaks: [...new Set([7, 8, 9, 10, ICON_ZOOM, ...halfZoomBreaks(ICON_ZOOM, 17)])].sort((a, b) => a - b),
  followsTerrain: true,

  settings: [
    {
      id: 'protection',
      label: 'Protection',
      options: [
        { value: 'tous', label: 'Classés et inscrits' },
        { value: 'classes', label: 'Classés seulement' },
        { value: 'inscrits', label: 'Inscrits seulement' },
      ],
      defaultValue: 'tous',
    },
    {
      id: 'type',
      label: 'Genre',
      options: [{ value: 'tous', label: 'Tous' }, ...CATEGORIES.map((c, i) => ({ value: String(i), label: c.short }))],
      defaultValue: 'tous',
    },
  ],

  legend(): LegendItem[] {
    const sheet = icons();
    return [
      { color: KEY_CSS, label: 'Carré sombre : classé (protection la plus forte)', icon: sheet.dataUrl(iconKey(0, true)) },
      { color: '#ffffff', label: 'Rond clair : inscrit', icon: sheet.dataUrl(iconKey(0, false)) },
      ...CATEGORIES.map((c, i) => ({ color: KEY_CSS, label: c.label, icon: sheet.dataUrl(iconKey(i, true)) })),
    ];
  },

  load: ({ signal }) => loadMonuments(signal),

  summary({ data, settings, view }) {
    if (!data) return null;
    const list = filtered(data, settings);
    const classed = list.filter(isClassed).length;
    const hint = view.zoom < ICON_ZOOM ? ' · zoomer pour voir les pictogrammes' : '';
    return `${list.length.toLocaleString('fr-FR')} monuments dont ${classed.toLocaleString('fr-FR')} classés${hint}`;
  },

  deckLayers({ data, settings, selection, view, terrain }) {
    if (!data) return [];
    const list = filtered(data, settings);
    const chosen = selection ? data.byRef.get((selection as { ref: string }).ref) : undefined;
    const onGround = (m: Monument): [number, number, number] => [m.lon, m.lat, terrain.elevation(m.lon, m.lat)];
    const pictograms = view.zoom >= ICON_ZOOM;
    const sheet = pictograms ? icons() : undefined;
    // Taille du badge selon le zoom ; un peu plus petit s'il n'est protégé qu'en partie.
    const badge = (m: Monument) => zoomRamp(view.zoom, ICON_ZOOM, 15, 19, 30) * (isPartial(m) ? 0.86 : 1) * (isClassed(m) ? 1 : 0.94);
    const dotRadius = (m: Monument) => (isClassed(m) ? zoomRamp(view.zoom, 5, 10, 2.1, 3.4) : zoomRamp(view.zoom, 5, 10, 1.6, 2.8));
    const points = pictograms ? [] : view.zoom < 10 ? sparse(list, view.zoom) : list;
    const shown = pictograms && view.zoom < ALL_ICONS_ZOOM ? spacedIcons(list, view.zoom) : list;
    return [
      !pictograms &&
        new ScatterplotLayer<Monument>({
          id: 'monuments/halo',
          data: points,
          getPosition: onGround,
          getRadius: (m) => dotRadius(m) + 1.4,
          radiusUnits: 'pixels',
          getFillColor: [255, 255, 255, 235],
          billboard: true,
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
      !pictograms &&
        new ScatterplotLayer<Monument>({
          id: 'monuments/points',
          data: points,
          getPosition: onGround,
          getRadius: dotRadius,
          radiusUnits: 'pixels',
          // Valeur et non teinte : sombre pour le classé, clair cerné de sombre pour l'inscrit.
          getFillColor: (m) => (isClassed(m) ? KEY : [255, 255, 255, 255]),
          stroked: true,
          getLineColor: KEY,
          getLineWidth: 0.9,
          lineWidthUnits: 'pixels',
          billboard: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 170],
          updateTriggers: { getPosition: terrain.version },
          parameters: OVER_MAP,
        }),
      sheet &&
        new IconLayer<Monument>({
          id: 'monuments/pictogrammes',
          data: shown,
          iconAtlas: sheet.atlas,
          iconMapping: sheet.mapping,
          getIcon: (m) => iconKey(m.cat, isClassed(m)),
          getPosition: onGround,
          sizeUnits: 'pixels',
          // La cellule fait 64 px dont ~16 de marge : on agrandit pour que le badge ait la taille demandée.
          getSize: (m) => badge(m) * 1.3,
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getSize: Math.round(view.zoom * 4) },
          parameters: OVER_MAP,
        }),
      view.zoom >= NAME_ZOOM &&
        new TextLayer<Monument>({
          id: 'monuments/noms',
          data: labelled(list, view.zoom),
          getPosition: onGround,
          getText: (m) => (m.name.length > 38 ? `${m.name.slice(0, 37)}…` : m.name),
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          characterSet: 'auto',
          getSize: 12,
          getColor: [20, 26, 38, 255],
          // Liseré clair autour des lettres : lisible sur la photo comme sur la carte, de jour comme de nuit.
          outlineWidth: 3.5,
          outlineColor: [255, 255, 255, 240],
          fontSettings: { sdf: true, radius: 8 },
          getTextAnchor: 'start',
          getAlignmentBaseline: 'center',
          getPixelOffset: (m) => [badge(m) * 0.5 + 4, 0],
          maxWidth: 150,
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getPixelOffset: Math.round(view.zoom * 4) },
          parameters: OVER_MAP,
        }),
      chosen && selectionRing('monuments/choisi', [chosen], onGround, (m) => (pictograms ? badge(m) * 0.72 : dotRadius(m) + 8), OVER_MAP),
    ];
  },

  select(object) {
    return { ref: (object as Monument).ref };
  },

  describe(selection, { data }): InfoContent | null {
    const m = data?.byRef.get((selection as { ref: string }).ref);
    if (!m) return null;
    const fields: Array<[string, string]> = [['Commune', m.dep ? `${m.commune} (${m.dep})` : m.commune]];
    fields.push(['Protection', protectionText(m)]);
    if (m.period) fields.push(['Époque', m.period]);
    fields.push(['Genre', CATEGORIES[m.cat]?.short ?? 'Autre']);
    fields.push(['Référence', m.ref]);
    return {
      kind: `Monument historique · ${isClassed(m) ? 'classé' : 'inscrit'}`,
      title: m.name,
      subtitle: m.denomination || undefined,
      status: plainStatus(`Base Mérimée du ${FRENCH_UPDATE.format(data!.updatedAt)}`),
      figures: [
        {
          value: m.date ? m.date.slice(0, 4) : '–',
          label: `${isClassed(m) ? 'classé' : 'inscrit'}${isPartial(m) ? ' en partie' : ''}`,
        },
      ],
      fields,
      note: m.description || undefined,
      link: { href: `https://pop.culture.gouv.fr/notice/merimee/${m.ref}`, label: 'Notice sur POP' },
    };
  },
});
