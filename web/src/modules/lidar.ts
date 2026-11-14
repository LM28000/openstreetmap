/**
 * Module « Relief LiDAR HD » : les produits dérivés du LiDAR HD de l'IGN (Géoplateforme, sans clé, Licence Etalab 2.0),
 * en raster posé sur la carte, à fort zoom seulement : la couverture est partielle (le LiDAR HD est encore en cours de
 * survol) et les tuiles sont lourdes. Là où il n'y a pas encore de données, le serveur de l'IGN répond 404 : la carte
 * reste simplement celle du dessous (la console du navigateur peut le signaler, c'est normal).
 *
 * Quatre produits, tous issus du nuage de points (10 points au m², maille de 50 cm) :
 * - `mnt` : estompage du terrain nu (modèle numérique de terrain) : le relief sans arbres ni bâtiments, qui fait
 *   apparaître talus, fossés, voies anciennes, tumulus ;
 * - `mns` : estompage de la surface (modèle numérique de surface) : le sursol compris, arbres et toits ;
 * - `mnh-ombre` : estompage de la hauteur du sursol (modèle numérique de hauteur) ;
 * - `mnh` : la hauteur de la végétation et du bâti en couleurs (teinte hypsométrique de l'IGN, vert au ras du sol,
 *   jaune puis orange et rouge de plus en plus haut). L'IGN ne publie pas la valeur de chaque teinte.
 *
 * Les estompages sont servis en tuiles WMTS (`PM`, zoom 0 à 18), la hauteur colorée par le WMS-Raster (la couche
 * « hypso_mnh » n'existe pas en tuiles). La couche est insérée sous les étiquettes (et sous l'ombre de la nuit),
 * donc le relief, les noms et les symboles restent lisibles ; elle est drapée sur le relief s'il est affiché.
 *
 * Le relief 3D lui-même peut aussi prendre son altitude du LiDAR HD (réglage « Relief 3D », éteint par défaut : Mapterhorn, qui
 * sert en France des tuiles jusqu'au zoom 16 issues du même LiDAR, donne la même forme à moins de 0,1 m près, voir docs/couches.md) : le
 * serveur convertit le MNT de l'IGN (BIL 32 bits) en tuiles « terrarium » (`/api/relief-lidar`, voir `server/src/relief_lidar.rs`)
 * et retombe sur Mapterhorn hors de la zone couverte. MapLibre n'admet qu'une source de relief à la fois : on bascule de
 * l'une à l'autre (`setLidarTerrain`) en s'approchant d'une zone de France (zoom 11) et on revient en s'éloignant (zoom 10),
 * jamais à chaque zoom : un changement de source recharge tout le relief. C'est toujours le terrain nu (MNT) qui donne la
 * forme, quel que soit le produit affiché en estompage.
 */
import type { Map as MapLibreMap, RasterSourceSpecification } from 'maplibre-gl';
import { defineModule, type LegendItem } from '../core/module';
import { firstSymbolLayerId, isLidarTerrain, setLidarTerrain } from '../map/baseMap';

const SOURCE_PREFIX = 'lidar-hd-';
const LAYER_ID = 'lidar-hd';
const WMTS = 'https://data.geopf.fr/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&STYLE=normal&FORMAT=image/png&TILEMATRIXSET=PM';
const WMS =
  'https://data.geopf.fr/wms-r/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&FORMAT=image/png&TRANSPARENT=true&CRS=EPSG:3857&WIDTH=256&HEIGHT=256';

interface Product {
  label: string;
  /** Adresse des tuiles (modèle MapLibre). */
  tiles: string;
  /** Ce que la fiche des réglages dit du produit (utilisé pour le résumé). */
  about: string;
}

/** Noms de couches relevés dans les GetCapabilities WMTS et WMS de data.geopf.fr (novembre 2026). */
const PRODUCTS: Record<string, Product> = {
  mnt: {
    label: 'Terrain nu (MNT, estompage)',
    tiles: `${WMTS}&LAYER=IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
    about: 'terrain nu, sans arbres ni bâtiments',
  },
  mns: {
    label: 'Surface : arbres et toits (MNS, estompage)',
    tiles: `${WMTS}&LAYER=IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
    about: 'surface avec arbres et toits',
  },
  'mnh-ombre': {
    label: 'Hauteur du sursol (MNH, estompage)',
    tiles: `${WMTS}&LAYER=IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.SHADOW&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`,
    about: 'hauteur de la végétation et du bâti, en relief',
  },
  mnh: {
    label: 'Hauteur de la végétation et du bâti (MNH, couleurs)',
    tiles: `${WMS}&LAYERS=IGNF_LIDAR-HD_MNH_ELEVATION.ELEVATIONGRIDCOVERAGE.WGS84G&STYLES=hypso_mnh&BBOX={bbox-epsg-3857}`,
    about: 'hauteur de la végétation et du bâti, en couleurs',
  },
};

/** Les quatre teintes de l'échelle hypsométrique, relevées dans les images du WMS (sol, bas, haut, très haut). */
const HYPSO = ['#94ff3d', '#fffa7b', '#ffa83e', '#ff4d00'];

/** Relief 3D du LiDAR : on bascule en s'approchant (zoom `TERRAIN_ON_ZOOM`) et on revient en s'éloignant (`TERRAIN_OFF_ZOOM`). */
const TERRAIN_ON_ZOOM = 11;
const TERRAIN_OFF_ZOOM = 10;
/** France métropolitaine (ouest, sud, est, nord) : le LiDAR HD n'existe pas ailleurs (le serveur n'interroge pas l'IGN hors de là). */
const FRANCE_BOX = [-5.5, 41.2, 9.9, 51.3] as const;
/** Marge (degrés) avant de repasser au relief ordinaire en quittant la France : évite de basculer sur la frontière. */
const LEAVE_MARGIN = 0.5;

function inFrance(lng: number, lat: number, margin: number): boolean {
  const [west, south, east, north] = FRANCE_BOX;
  return lng >= west - margin && lng <= east + margin && lat >= south - margin && lat <= north + margin;
}

/** Faut-il que le relief 3D prenne l'altitude du LiDAR, vu le réglage, le zoom et la zone regardée ? */
function wantsLidarTerrain(map: MapLibreMap, settings: Readonly<Record<string, string>>, zoom: number): boolean {
  if (settings.relief3d === 'non') return false;
  const center = map.getCenter();
  const on = isLidarTerrain();
  if (!inFrance(center.lng, center.lat, on ? LEAVE_MARGIN : 0)) return false;
  return on ? zoom >= TERRAIN_OFF_ZOOM : zoom >= TERRAIN_ON_ZOOM;
}

const sourceId = (product: string) => `${SOURCE_PREFIX}${product}`;

function productOf(settings: Readonly<Record<string, string>>): string {
  const value = settings.produit;
  return value && value in PRODUCTS ? value : 'mnt';
}

/** Retire la couche et toutes les sources LiDAR (un seul produit à la fois est chargé). */
function removeAll(map: MapLibreMap): void {
  if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
  for (const product of Object.keys(PRODUCTS)) if (map.getSource(sourceId(product))) map.removeSource(sourceId(product));
}

function ensure(map: MapLibreMap, product: string, minZoom: number): void {
  const id = sourceId(product);
  const layer = map.getLayer(LAYER_ID);
  if (layer && layer.source === id && map.getSource(id)) return;
  removeAll(map);
  const source: RasterSourceSpecification = {
    type: 'raster',
    tiles: [PRODUCTS[product]!.tiles],
    tileSize: 256,
    maxzoom: 18,
    attribution: 'IGN, LiDAR HD (Licence Etalab 2.0)',
  };
  map.addSource(id, source);
  // Sous l'ombre de la nuit si elle est affichée, sinon sous les étiquettes.
  const before = map.getLayer('jour-nuit') ? 'jour-nuit' : firstSymbolLayerId(map);
  map.addLayer(
    { id: LAYER_ID, type: 'raster', source: id, minzoom: minZoom, paint: { 'raster-opacity': 0.7, 'raster-fade-duration': 150, 'raster-resampling': 'linear' } },
    before,
  );
}

export const lidar = defineModule<null>({
  id: 'lidar',
  name: 'Relief LiDAR HD',
  category: 'territoire',
  description: 'Le relief et la hauteur des arbres et des bâtiments d’après le LiDAR HD de l’IGN, à fort zoom, là où il est publié.',
  attribution: 'IGN, LiDAR HD (Licence Etalab 2.0)',
  timeStepMs: 60_000,
  followsView: true,
  zoomBreaks: [TERRAIN_OFF_ZOOM, TERRAIN_ON_ZOOM],

  settings: [
    {
      id: 'produit',
      label: 'Produit',
      defaultValue: 'mnt',
      options: Object.entries(PRODUCTS).map(([value, product]) => ({ value, label: product.label })),
    },
    {
      id: 'relief3d',
      label: 'Relief 3D',
      defaultValue: 'non',
      options: [
        { value: 'oui', label: 'Altitude du LiDAR HD (50 cm, jusqu’au zoom 17)' },
        { value: 'non', label: 'Relief ordinaire (Mapterhorn, jusqu’au zoom 16)' },
      ],
    },
    {
      id: 'opacite',
      label: 'Opacité',
      defaultValue: '70',
      options: [30, 50, 70, 90].map((v) => ({ value: String(v), label: `${v} %` })),
      range: { min: 20, max: 100, step: 10, format: (v) => `${v} %` },
    },
    {
      id: 'zoom',
      label: 'Affichée à partir du zoom',
      defaultValue: '14',
      options: [12, 13, 14, 15, 16].map((v) => ({ value: String(v), label: String(v) })),
      range: { min: 11, max: 17, step: 1, format: (v) => `${v}` },
    },
  ],

  legend(settings): LegendItem[] {
    const altitude: LegendItem = {
      color: 'var(--ui-muted)',
      label:
        settings.relief3d === 'non'
          ? 'Relief 3D : altitude Mapterhorn (relief ordinaire, tuiles jusqu’au zoom 16)'
          : 'Relief 3D : altitude du LiDAR HD de l’IGN (terrain nu, maille de 50 cm), là où il est publié, sinon Mapterhorn',
    };
    if (productOf(settings) !== 'mnh') return [altitude];
    return [
      altitude,
      { color: HYPSO[0]!, label: 'Au ras du sol, herbe, toits plats' },
      { color: HYPSO[1]!, label: 'Haies, arbustes, maisons' },
      { color: HYPSO[2]!, label: 'Grands arbres, immeubles' },
      { color: HYPSO[3]!, label: 'Les plus hauts (échelle non publiée par l’IGN)' },
    ];
  },

  summary({ settings, view }) {
    const minZoom = Number(settings.zoom) || 14;
    const about = PRODUCTS[productOf(settings)]!.about;
    const relief = isLidarTerrain() ? ' Altitude du relief 3D : LiDAR HD de l’IGN.' : '';
    if (view.zoom < minZoom) return `Approchez-vous (zoom ${minZoom} ou plus) pour voir le ${about}.${relief}`;
    return `LiDAR HD : ${about}. Couverture partielle : rien là où l’IGN n’a pas encore publié.${relief}`;
  },

  native: {
    add(map) {
      ensure(map, 'mnt', 14);
    },

    update(map, { settings, night, view }) {
      setLidarTerrain(map, wantsLidarTerrain(map, settings, view.zoom));
      const product = productOf(settings);
      const minZoom = Number(settings.zoom) || 14;
      ensure(map, product, minZoom);
      if (!map.getLayer(LAYER_ID)) return;
      map.setLayerZoomRange(LAYER_ID, minZoom, 24);
      map.setPaintProperty(LAYER_ID, 'raster-opacity', (Number(settings.opacite) || 70) / 100);
      // La nuit le fond est sombre : un estompage gris clair l'éblouirait, on l'assombrit (et la hauteur colorée un peu moins).
      map.setPaintProperty(LAYER_ID, 'raster-brightness-max', product === 'mnh' ? 1 - 0.35 * night : 1 - 0.7 * night);
    },

    remove(map) {
      setLidarTerrain(map, false);
      removeAll(map);
    },
  },
});
