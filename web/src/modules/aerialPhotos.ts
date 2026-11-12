/**
 * Module « Photos aériennes anciennes » : les orthophotographies de l'IGN (Géoplateforme, WMTS,
 * sans clé, Licence Etalab 2.0), des années 1950 à aujourd'hui, avec un rideau « avant / après » :
 * une poignée verticale que l'on glisse sur la carte ; à gauche la photo ancienne, à droite la
 * carte d'aujourd'hui.
 *
 * Le dessin est fait par une couche WebGL maison (voir `aerialCurtain.ts`, qui explique le choix
 * face à une deuxième carte synchronisée). Ici : la poignée (HTML, glisser à la souris, au doigt
 * ou au clavier), les réglages (époque, rideau ou transparence) et la fiche.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { defineModule, type InfoContent, type ModuleSetting } from '../core/module';
import { ModuleManager } from '../core/moduleManager';
import { plainStatus } from '../core/infoStatus';
import { aboveBuildingsId } from '../map/baseMap';
import { createCurtainLayer, type CurtainLayer, type Vintage } from './aerialCurtain';
import './aerialCurtain.css';

const MODULE_ID = 'photos';
const LAYER_ID = 'photos-rideau';
const CREDIT_SOURCE = 'photos-credit';
const CREDIT_LAYER = 'photos-credit-layer';

interface VintageInfo extends Vintage {
  value: string;
  /** Texte court : « 1950–1965 ». */
  years: string;
  label: string;
  /** Ce que montrent les photos de cette époque, pour la fiche. */
  about: string;
}

/** Couches du WMTS de l'IGN (GetCapabilities vérifié en novembre 2026) : 1950-1965 est la principale. */
const VINTAGES: readonly VintageInfo[] = [
  {
    value: '1950-1965',
    years: '1950–1965',
    label: '1950–1965 (années 50)',
    layer: 'ORTHOIMAGERY.ORTHOPHOTOS.1950-1965',
    style: 'BDORTHOHISTORIQUE',
    format: 'image/png',
    minZoom: 0,
    maxZoom: 18,
    about:
      'La France des années 50, avant les grands aménagements des années 60 : photographies historiques numérisées par l’IGN, puis redressées pour se superposer à la carte.',
  },
  {
    value: '1965-1980',
    years: '1965–1980',
    label: '1965–1980',
    layer: 'ORTHOIMAGERY.ORTHOPHOTOS.1965-1980',
    style: 'BDORTHOHISTORIQUE',
    format: 'image/png',
    minZoom: 3,
    maxZoom: 18,
    about: 'Les années des grands ensembles, des autoroutes et du remembrement, d’après les missions photographiques de l’IGN.',
  },
  {
    value: '1980-1995',
    years: '1980–1995',
    label: '1980–1995',
    layer: 'ORTHOIMAGERY.ORTHOPHOTOS.1980-1995',
    style: 'BDORTHOHISTORIQUE',
    format: 'image/png',
    minZoom: 3,
    maxZoom: 18,
    about: 'Photographies aériennes de la fin du XXe siècle, numérisées par l’IGN.',
  },
  {
    value: '2000-2005',
    years: '2000–2005',
    label: '2000–2005',
    layer: 'ORTHOIMAGERY.ORTHOPHOTOS2000-2005',
    style: 'normal',
    format: 'image/jpeg',
    minZoom: 6,
    maxZoom: 18,
    about: 'Première couverture en couleur de tout le territoire (prises de vues de 2000 à 2005).',
  },
  {
    value: '2006-2010',
    years: '2006–2010',
    label: '2006–2010',
    layer: 'ORTHOIMAGERY.ORTHOPHOTOS2006-2010',
    style: 'normal',
    format: 'image/jpeg',
    minZoom: 6,
    maxZoom: 18,
    about: 'Prises de vues aériennes de 2006 à 2010.',
  },
  {
    value: '2011-2015',
    years: '2011–2015',
    label: '2011–2015',
    layer: 'ORTHOIMAGERY.ORTHOPHOTOS2011-2015',
    style: 'normal',
    format: 'image/jpeg',
    minZoom: 6,
    maxZoom: 18,
    about: 'Prises de vues aériennes de 2011 à 2015.',
  },
  {
    value: 'aujourdhui',
    years: 'aujourd’hui',
    label: 'Aujourd’hui',
    layer: 'ORTHOIMAGERY.ORTHOPHOTOS',
    style: 'normal',
    format: 'image/jpeg',
    minZoom: 0,
    maxZoom: 19,
    about: 'La photographie aérienne la plus récente de l’IGN (la BD ORTHO, renouvelée par départements tous les trois ans environ).',
  },
];

const vintageOf = (settings: Readonly<Record<string, string>>): VintageInfo =>
  VINTAGES.find((v) => v.value === settings.epoque) ?? VINTAGES[0]!;

// --- Le rideau : poignée HTML au-dessus de la carte ---

/** Position du rideau, en fraction de la largeur : gardée quand on masque puis réaffiche la couche. */
let fraction = 0.5;

interface Ui {
  root: HTMLDivElement;
  handle: HTMLDivElement;
  left: HTMLButtonElement;
  right: HTMLSpanElement;
  layer: CurtainLayer;
  map: MapLibreMap;
  /** Mode courant et libellé de l'époque, pour mettre à jour la poignée. */
  curtain: boolean;
  years: string;
  onResize: () => void;
  onProjection: () => void;
}

let ui: Ui | undefined;

/** Place le rideau (fraction de la largeur, entre 0 et 1) : la visite guidée le fait glisser pour montrer l'avant et l'après. */
export function setCurtainFraction(value: number): void {
  fraction = Math.min(0.995, Math.max(0.005, value));
  if (ui) applyFraction(ui);
}

const select = () => ModuleManager.current?.setSelection(MODULE_ID, { type: 'rideau' });

function applyFraction(state: Ui): void {
  const width = state.map.getContainer().clientWidth;
  const x = fraction * width;
  state.handle.style.left = `${x}px`;
  state.handle.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  // Une étiquette qui n'a plus la place de s'afficher d'un côté disparaît : le rideau reste lisible près du bord.
  state.left.hidden = x < 130;
  state.right.hidden = width - x < 130;
  // Les étiquettes se collent de chaque côté du bouton de la poignée (22 px de rayon + un peu d'air).
  state.left.style.right = `${width - x + 32}px`;
  state.right.style.left = `${x + 32}px`;
  state.layer.setCurtain(state.curtain ? x : Infinity);
}

function buildHandle(state: Pick<Ui, 'map'>): Pick<Ui, 'root' | 'handle' | 'left' | 'right'> {
  const root = document.createElement('div');
  root.className = 'rideau';
  const handle = document.createElement('div');
  handle.className = 'rideau__poignee';
  handle.setAttribute('role', 'slider');
  handle.tabIndex = 0;
  handle.setAttribute('aria-label', 'Rideau avant / après : glisser pour comparer la photo ancienne et la carte');
  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '100');
  handle.innerHTML =
    '<span class="rideau__ligne"></span>' +
    '<span class="rideau__bouton" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 7-5 5 5 5M15 7l5 5-5 5"/></svg></span>';
  const left = document.createElement('button');
  left.type = 'button';
  left.className = 'rideau__etiquette rideau__etiquette--gauche';
  left.title = 'Voir la fiche de cette photo';
  const right = document.createElement('span');
  right.className = 'rideau__etiquette rideau__etiquette--droite';
  right.textContent = 'Carte actuelle';
  root.append(left, right, handle);
  state.map.getContainer().appendChild(root);
  return { root, handle, left, right };
}

function wireInteractions(state: Ui): void {
  const { handle } = state;
  let startX = 0;
  let moved = false;
  const move = (clientX: number) => {
    const rect = state.map.getContainer().getBoundingClientRect();
    fraction = Math.min(0.995, Math.max(0.005, (clientX - rect.left) / rect.width));
    applyFraction(state);
  };
  handle.addEventListener('pointerdown', (event) => {
    handle.setPointerCapture(event.pointerId);
    startX = event.clientX;
    moved = false;
    handle.classList.add('rideau__poignee--tire');
    event.preventDefault();
    event.stopPropagation();
  });
  handle.addEventListener('pointermove', (event) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    if (Math.abs(event.clientX - startX) > 3) moved = true;
    move(event.clientX);
  });
  const end = (event: PointerEvent) => {
    if (!handle.hasPointerCapture(event.pointerId)) return;
    handle.releasePointerCapture(event.pointerId);
    handle.classList.remove('rideau__poignee--tire');
    // Un simple toucher (sans glisser) ouvre la fiche.
    if (!moved) select();
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', (event) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === 'ArrowLeft') fraction = Math.max(0.005, fraction - step);
    else if (event.key === 'ArrowRight') fraction = Math.min(0.995, fraction + step);
    else if (event.key === 'Home') fraction = 0.005;
    else if (event.key === 'End') fraction = 0.995;
    else if (event.key === 'Enter' || event.key === ' ') {
      select();
      event.preventDefault();
      return;
    } else return;
    event.preventDefault();
    applyFraction(state);
  });
  handle.addEventListener('dblclick', () => {
    fraction = 0.5;
    applyFraction(state);
  });
  state.left.addEventListener('click', select);
}

function showCurtain(state: Ui, on: boolean): void {
  state.curtain = on;
  state.root.hidden = !on;
  applyFraction(state);
}

// --- Réglages ---

const SETTINGS: readonly ModuleSetting[] = [
  {
    id: 'epoque',
    label: 'Époque des photos',
    options: VINTAGES.map((v) => ({ value: v.value, label: v.label })),
    defaultValue: '1950-1965',
  },
  {
    id: 'mode',
    label: 'Comparaison',
    options: [
      { value: 'rideau', label: 'Rideau (glisser)' },
      { value: 'transparence', label: 'Transparence' },
    ],
    defaultValue: 'rideau',
  },
  {
    // Réglage du mode « Transparence » : sans effet avec le rideau.
    id: 'opacite',
    label: 'Opacité (mode transparence)',
    options: [
      { value: '40', label: '40 %' },
      { value: '60', label: '60 %' },
      { value: '80', label: '80 %' },
    ],
    defaultValue: '60',
    range: { min: 10, max: 100, step: 10, format: (value) => `${value} %` },
  },
];

export const aerialPhotos = defineModule<undefined>({
  id: MODULE_ID,
  name: 'Photos aériennes anciennes',
  category: 'histoire',
  description:
    'Les photographies aériennes de l’IGN des années 1950 à aujourd’hui, en rideau avant / après ou en transparence sur la carte.',
  attribution: 'IGN, Géoplateforme (photographies aériennes), Licence Etalab 2.0',
  // Pas de données à charger ni de temps simulé : les photos ne dépendent pas de l'horloge.
  timeStepMs: 3_600_000,
  // Dessinée par-dessus le relief mais sous les noms de lieux et les couches deck.gl.
  drawOrder: -5,
  settings: SETTINGS,

  legend(settings) {
    const vintage = vintageOf(settings);
    return [{ color: '#8a8f9c', label: `Photos ${vintage.years}, IGN`, size: 'medium' }];
  },

  summary({ settings, view }) {
    if (ui?.map.getProjection()?.type === 'globe') return 'Indisponible sur le globe : repasser à la carte plane';
    const vintage = vintageOf(settings);
    const minZoom = vintage.minZoom;
    const zoomHint = view.zoom < minZoom ? ` · zoomer pour voir les photos (zoom ${minZoom} au moins)` : '';
    const mode = settings.mode === 'transparence' ? `transparence ${settings.opacite ?? '60'} %` : 'rideau';
    return `Prise de vue ${vintage.years}, IGN · ${mode}${zoomHint}`;
  },

  native: {
    add(map) {
      const layer = createCurtainLayer(LAYER_ID, VINTAGES[0]!);
      // Sous l'ombre de la nuit si elle est là, sinon sous les étiquettes. Au-dessus des bâtiments d'aujourd'hui : des tours
      // de La Défense sur une photo de 1955 seraient un contresens (et leurs toits laissaient des plaques blanches).
      const before = map.getLayer('jour-nuit') ? 'jour-nuit' : aboveBuildingsId(map);
      map.addLayer(layer, before);
      // Crédit dans le cartouche de la carte : une source vide, jamais dessinée, qui porte la mention.
      map.addSource(CREDIT_SOURCE, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        attribution: '<a href="https://geoservices.ign.fr/" target="_blank" rel="noreferrer">© IGN</a> (Licence Etalab 2.0)',
      });
      map.addLayer({ id: CREDIT_LAYER, type: 'line', source: CREDIT_SOURCE, paint: { 'line-opacity': 0 } });

      const parts = buildHandle({ map });
      const state: Ui = {
        ...parts,
        layer,
        map,
        curtain: true,
        years: VINTAGES[0]!.years,
        onResize: () => applyFraction(state),
        onProjection: () => {
          state.root.classList.toggle('rideau--globe', map.getProjection()?.type === 'globe');
        },
      };
      wireInteractions(state);
      map.on('resize', state.onResize);
      map.on('projectiontransition', state.onProjection);
      ui = state;
      applyFraction(state);
    },

    update(map, { settings }) {
      if (!ui) return;
      const vintage = vintageOf(settings);
      ui.layer.setVintage(vintage);
      ui.years = vintage.years;
      ui.left.textContent = `Photo ${vintage.years}`;
      ui.left.setAttribute('aria-label', `Photo aérienne ${vintage.years} : voir la fiche`);
      ui.right.textContent = vintage.value === 'aujourdhui' ? 'Carte' : 'Carte actuelle';
      const rideau = settings.mode !== 'transparence';
      showCurtain(ui, rideau);
      ui.layer.setOpacity(rideau ? 1 : Math.min(1, Math.max(0.1, Number(settings.opacite ?? '60') / 100)));
      map.triggerRepaint();
    },

    remove(map) {
      if (!ui) return;
      map.off('resize', ui.onResize);
      map.off('projectiontransition', ui.onProjection);
      ui.root.remove();
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
      if (map.getLayer(CREDIT_LAYER)) map.removeLayer(CREDIT_LAYER);
      if (map.getSource(CREDIT_SOURCE)) map.removeSource(CREDIT_SOURCE);
      ui = undefined;
    },
  },

  select() {
    return { type: 'rideau' };
  },

  describe(_selection, { settings }): InfoContent {
    const vintage = vintageOf(settings);
    const transparency = settings.mode === 'transparence';
    const today = vintage.value === 'aujourdhui';
    return {
      kind: 'Photos aériennes anciennes',
      title: `Prise de vue ${vintage.years}, IGN`,
      subtitle: today ? 'Photographie aérienne actuelle' : 'Photographie aérienne historique',
      status: plainStatus('Archives de l’IGN · pas en temps réel'),
      figures: [{ value: vintage.years, label: today ? 'dernière couverture' : 'prise de vue' }],
      fields: [
        [
          'Ce que vous voyez',
          transparency
            ? `La photo ${vintage.years} fondue dans la carte (${settings.opacite ?? '60'} % d’opacité)`
            : `À gauche du rideau, la photo ${vintage.years} ; à droite, la carte d’aujourd’hui`,
        ],
        ['Source', 'IGN, Géoplateforme, photographies aériennes (BD ORTHO)'],
        ['Licence', 'Licence Etalab 2.0'],
      ],
      note: `${vintage.about}${today ? '' : ' Selon les secteurs, la date exacte de prise de vue varie dans cette période ; certains endroits n’ont pas été photographiés et restent vides.'}`,
      link: { href: 'https://remonterletemps.ign.fr/', label: 'Remonter le temps (IGN)' },
    };
  },
});
