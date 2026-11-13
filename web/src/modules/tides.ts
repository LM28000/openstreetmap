/**
 * Module « Marées » : le niveau de la mer aux marégraphes du réseau REFMAR (Shom et partenaires), en temps réel.
 *
 * Chaque marégraphe est un cercle qui se remplit comme une jauge : plein à la pleine mer, vide à la basse mer
 * (par rapport aux 48 dernières heures du port), avec une pointe vers le haut quand la mer monte et vers le bas
 * quand elle descend. Le niveau est écrit à côté, en mètres au-dessus du zéro hydrographique. La fiche trace les
 * 48 dernières heures, les dernières pleines et basses mers observées, et une estimation des prochaines.
 *
 * Les prédictions officielles du Shom ne sont pas ouvertes : les prochaines marées sont **estimées** par le serveur
 * à partir des observations des 29 derniers jours (voir `server/src/tides.rs`) et annoncées comme telles.
 *
 * Comme toute couche, l'affichage est une fonction de l'instant : en rejouant le temps, la jauge suit la courbe
 * mesurée des 48 heures, puis l'estimation pour les 36 heures à venir.
 */
import { MARINE } from '../design/tokens';
import { IconLayer, TextLayer } from '@deck.gl/layers';
import { estimatedStatus, measuredStatus, replayStatus } from '../core/infoStatus';
import { defineModule, type InfoContent } from '../core/module';
import { OVER_MAP } from '../map/parameters';
import { formatRelative, formatTime } from '../ui/format';
import { ink, type IconSheet, KEY, packIcons, selectionRing, zoomRamp } from './symbols';

interface ApiExtreme {
  high: boolean;
  time: number;
  height: number;
}

interface ApiGauge {
  id: number;
  name: string;
  lon: number;
  lat: number;
  level: number;
  time: number;
  rate: number;
  min: number;
  max: number;
  tidal: boolean;
  seriesStart: number;
  seriesStep: number;
  series: Array<number | null>;
  extremes: ApiExtreme[];
  forecastStart: number;
  forecastStep: number;
  forecast: number[];
  next: ApiExtreme[];
  fitRms?: number;
}

export interface Gauge extends ApiGauge {
  /** Mesures en mètres, au pas de `seriesStep`. */
  meters: Array<number | null>;
}

interface TidesData {
  updatedAt: number;
  gauges: Gauge[];
  byId: Map<number, Gauge>;
}

type Trend = 'up' | 'down' | 'flat' | 'none';
interface Reading {
  level: number;
  /** Mètres par heure : positif quand la mer monte. */
  rate: number;
  /** `measured` : relevé ; `estimated` : estimation du serveur ; `held` : la dernière mesure, gardée faute de mieux. */
  kind: 'measured' | 'estimated' | 'held';
}

const PALE = '#f3f7fb';
/** Au-dessus de cette variation (m/h), la mer monte ou descend : en dessous, elle est « étale ». */
const SLACK_RATE = 0.08;
/** Une mesure plus vieille que cela n'est plus « le niveau actuel » : le cercle s'efface. */
const STALE_MS = 3 * 3600_000;
const FILL_STEPS = 8;

const GAUGE_W = 46;
const GAUGE_H = 40;
const gaugeKey = (fill: number, trend: Trend) => `maree:${fill}:${trend}`;

let gauges: IconSheet | undefined;
/** Les jauges sont dessinées au premier usage (il faut un document pour créer un canvas). */
function gaugeSheet(): IconSheet {
  gauges ??= packIcons(
    ([0, 1, 2, 3, 4, 5, 6, 7, 8] as const).flatMap((fill) =>
      (['up', 'down', 'flat', 'none'] as const).map((trend) => ({
        key: gaugeKey(fill, trend),
        width: GAUGE_W,
        height: GAUGE_H,
        draw(c: CanvasRenderingContext2D) {
          const cx = 23;
          const cy = 23;
          const r = 12;
          const circle = (k: CanvasRenderingContext2D, radius = r) => {
            k.beginPath();
            k.arc(cx, cy, radius, 0, Math.PI * 2);
          };
          ink(c, (k) => circle(k), PALE, { key: 2.2 });
          // L'eau : un niveau dans le cercle, du fond vers le haut.
          c.save();
          circle(c, r - 1);
          c.clip();
          const water = (2 * (r - 1) * fill) / FILL_STEPS;
          c.fillStyle = MARINE;
          c.fillRect(cx - r, cy + r - 1 - water, 2 * r, water + 2);
          c.restore();
          if (trend === 'up' || trend === 'down') {
            const dir = trend === 'up' ? -1 : 1; // -1 : pointe en haut
            ink(
              c,
              (k) => {
                k.beginPath();
                k.moveTo(35, 9 + dir * 5.5);
                k.lineTo(35 - 6.5, 9 - dir * 4);
                k.lineTo(35 + 6.5, 9 - dir * 4);
                k.closePath();
              },
              MARINE,
              { key: 1.8, halo: 1.6 },
            );
          } else if (trend === 'flat') {
            ink(
              c,
              (k) => {
                k.beginPath();
                k.roundRect(28.5, 6.5, 13, 5, 2.5);
              },
              PALE,
              { key: 1.8, halo: 1.6 },
            );
          }
        },
      })),
    ),
  );
  return gauges;
}

const metersFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rateFormat = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' });
const dayTime = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const meters = (v: number) => `${metersFormat.format(v)} m`;

/** Valeur interpolée d'une courbe régulière (`start` et `step` en secondes). */
function sample(values: ReadonlyArray<number | null>, start: number, step: number, t: number): number | null {
  const x = (t - start) / step;
  const i = Math.floor(x);
  const a = values[i];
  const b = values[i + 1];
  if (a == null) return null;
  if (b == null) return a;
  return a + (b - a) * (x - i);
}

/** Le niveau et la tendance du marégraphe à l'instant `time` (ms), ou `null` s'il n'y a rien à montrer. */
function readingAt(g: Gauge, time: number): Reading | null {
  const t = time / 1000;
  const lastSeries = g.seriesStart + (g.meters.length - 1) * g.seriesStep;
  // Le présent : la dernière mesure, plus précise que les cases de dix minutes.
  if (t >= g.time - 600 && t <= g.time + 1200) return { level: g.level, rate: g.rate, kind: 'measured' };
  if (t < g.time - 600) {
    if (t < g.seriesStart) return null;
    const level = sample(g.meters, g.seriesStart, g.seriesStep, Math.min(t, lastSeries));
    if (level === null) return null;
    const before = sample(g.meters, g.seriesStart, g.seriesStep, Math.max(g.seriesStart, t - 900));
    const after = sample(g.meters, g.seriesStart, g.seriesStep, Math.min(lastSeries, t + 900));
    const span = Math.min(lastSeries, t + 900) - Math.max(g.seriesStart, t - 900);
    const rate = before !== null && after !== null && span > 0 ? ((after - before) / span) * 3600 : 0;
    return { level, rate, kind: 'measured' };
  }
  // L'avenir : l'estimation, si le port en a une.
  const forecastEnd = g.forecastStart + (g.forecast.length - 1) * g.forecastStep;
  if (g.forecast.length > 1 && t >= g.forecastStart && t <= forecastEnd) {
    const cm = g.forecast.map((v) => v / 100);
    const level = sample(cm, g.forecastStart, g.forecastStep, t);
    if (level !== null) {
      const ahead = sample(cm, g.forecastStart, g.forecastStep, Math.min(forecastEnd, t + 900));
      const behind = sample(cm, g.forecastStart, g.forecastStep, Math.max(g.forecastStart, t - 900));
      const rate = ahead !== null && behind !== null ? ((ahead - behind) / 1800) * 3600 : 0;
      return { level, rate, kind: 'estimated' };
    }
  }
  // Entre la dernière mesure et la première valeur estimée (une demi-heure au plus), ou sans estimation : on garde la dernière mesure.
  return { level: g.level, rate: 0, kind: 'held' };
}

function trendOf(g: Gauge, r: Reading): Trend {
  if (!g.tidal) return 'none';
  if (r.kind === 'held' || Math.abs(r.rate) < SLACK_RATE) return 'flat';
  return r.rate > 0 ? 'up' : 'down';
}

/** Remplissage du cercle (0 à 8) : la place du niveau entre le plus bas et le plus haut des 48 dernières heures. */
function fillOf(g: Gauge, r: Reading): number {
  if (!g.tidal) return Math.round(FILL_STEPS / 2);
  const span = Math.max(g.max - g.min, 0.1);
  return Math.max(0, Math.min(FILL_STEPS, Math.round(((r.level - g.min) / span) * FILL_STEPS)));
}

async function loadTides(signal: AbortSignal): Promise<TidesData> {
  const response = await fetch('/api/marees', { signal });
  if (response.status === 503) throw new Error('le serveur récupère encore les niveaux de la mer');
  if (!response.ok) throw new Error(`le serveur des marées a répondu ${response.status}`);
  const json = (await response.json()) as { updatedAt: number; gauges: ApiGauge[] };
  const gauges = json.gauges.map((g) => ({ ...g, meters: g.series.map((cm) => (cm === null ? null : cm / 100)) }));
  return { updatedAt: json.updatedAt, gauges, byId: new Map(gauges.map((g) => [g.id, g])) };
}

/** Les marégraphes à afficher à cet instant, avec ce qu'on lit dessus. */
interface Shown {
  gauge: Gauge;
  reading: Reading;
  stale: boolean;
}

function shownAt(data: TidesData, time: number): Shown[] {
  const out: Shown[] = [];
  for (const gauge of data.gauges) {
    const reading = readingAt(gauge, time);
    if (!reading) continue;
    out.push({ gauge, reading, stale: reading.kind === 'held' && time - gauge.time * 1000 > STALE_MS });
  }
  return out;
}

let shownCache: { data: TidesData; step: number; shown: Shown[] } | undefined;

export const tides = defineModule<TidesData>({
  id: 'marees',
  name: 'Marées',
  category: 'environnement',
  description: 'Niveau de la mer aux marégraphes de France, en direct : monte ou descend, 48 heures de courbe, prochaines pleines mers estimées.',
  attribution: 'Shom, REFMAR (Licence Ouverte 2.0)',
  refreshIntervalMs: 5 * 60_000,
  // Le niveau change de plusieurs centimètres par minute en Manche : un redessin toutes les 5 minutes suit sans coûter cher.
  timeStepMs: 300_000,
  followsTerrain: true,
  zoomBreaks: [6.5, 8, 9.5],

  legend() {
    const sheet = gaugeSheet();
    return [
      { color: MARINE, label: 'La mer monte (le cercle se remplit)', icon: sheet.dataUrl(gaugeKey(5, 'up')) },
      { color: MARINE, label: 'La mer descend', icon: sheet.dataUrl(gaugeKey(3, 'down')) },
      { color: MARINE, label: 'Étale, ou pas de marée nette (Méditerranée)', icon: sheet.dataUrl(gaugeKey(4, 'flat')) },
    ];
  },

  load: ({ signal }) => loadTides(signal),

  summary({ data, time }) {
    if (!data) return null;
    const shown = shownAt(data, time).filter((s) => s.gauge.tidal && s.reading.kind !== 'held');
    if (!shown.length) return `${data.gauges.length} marégraphes`;
    const rising = shown.filter((s) => s.reading.rate >= SLACK_RATE).length;
    const falling = shown.filter((s) => s.reading.rate <= -SLACK_RATE).length;
    return `${data.gauges.length} marégraphes · ${rising} voient monter la mer, ${falling} la voient descendre`;
  },

  deckLayers({ data, time, selection, terrain, view }) {
    if (!data) return [];
    const step = Math.floor(time / 300_000);
    if (shownCache?.data !== data || shownCache.step !== step) shownCache = { data, step, shown: shownAt(data, time) };
    const shown = shownCache.shown;
    const sheet = gaugeSheet();
    const size = zoomRamp(view.zoom, 4.5, 9, 26, 46);
    const onGround = (s: Shown): [number, number, number] => [s.gauge.lon, s.gauge.lat, terrain.elevation(s.gauge.lon, s.gauge.lat)];
    const chosenId = selection ? (selection as { id: number }).id : undefined;
    const chosen = shown.filter((s) => s.gauge.id === chosenId);
    const showLevel = view.zoom >= 6.5;
    const showName = view.zoom >= 9;
    const parameters = OVER_MAP;
    const alpha = (s: Shown) => (s.stale ? 110 : s.reading.kind === 'estimated' ? 215 : 255);
    return [
      new IconLayer<Shown>({
        id: 'marees/jauges',
        data: shown,
        iconAtlas: sheet.atlas,
        iconMapping: sheet.mapping,
        getIcon: (s) => gaugeKey(fillOf(s.gauge, s.reading), trendOf(s.gauge, s.reading)),
        getPosition: onGround,
        getColor: (s) => [255, 255, 255, alpha(s)],
        sizeUnits: 'pixels',
        getSize: size,
        billboard: true,
        pickable: true,
        autoHighlight: true,
        highlightColor: [255, 255, 255, 140],
        updateTriggers: { getIcon: step, getColor: step, getPosition: terrain.version },
        parameters,
      }),
      showLevel &&
        new TextLayer<Shown>({
          id: 'marees/niveaux',
          data: shown,
          getPosition: onGround,
          getText: (s) => meters(s.reading.level),
          characterSet: '0123456789,.-−+ m',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 700,
          getSize: 11.5,
          getColor: KEY,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'top',
          getPixelOffset: [0, size * 0.42],
          background: true,
          getBackgroundColor: [255, 255, 255, 238],
          getBorderColor: [20, 26, 38, 150],
          getBorderWidth: 1,
          backgroundBorderRadius: 8,
          backgroundPadding: [6, 2],
          billboard: true,
          pickable: true,
          updateTriggers: { getText: step, getPosition: terrain.version, getPixelOffset: size },
          parameters,
        }),
      showName &&
        new TextLayer<Shown>({
          id: 'marees/noms',
          data: shown,
          getPosition: onGround,
          getText: (s) => s.gauge.name,
          characterSet: 'auto',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          fontWeight: 600,
          getSize: 11.5,
          getColor: KEY,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'bottom',
          getPixelOffset: [0, -size * 0.5 - 2],
          background: true,
          getBackgroundColor: [255, 255, 255, 225],
          backgroundBorderRadius: 6,
          backgroundPadding: [5, 1],
          billboard: true,
          pickable: true,
          updateTriggers: { getPosition: terrain.version, getPixelOffset: size },
          parameters,
        }),
      chosen.length > 0 && selectionRing('marees/choisi', chosen, onGround, size * 0.46, parameters),
    ];
  },

  select(object) {
    return { id: (object as Shown).gauge.id };
  },

  focus(selection, { data }) {
    const g = data?.byId.get((selection as { id: number }).id);
    return g ? { lon: g.lon, lat: g.lat } : null;
  },

  describe(selection, { data, time }) {
    const g = data?.byId.get((selection as { id: number }).id);
    if (!g) return null;
    const reading = readingAt(g, time);
    const nowMs = time;
    const trend = reading ? trendOf(g, reading) : 'none';
    const rateText = reading && g.tidal ? `${rateFormat.format(reading.rate)}` : '—';
    const verb = trend === 'up' ? 'monte' : trend === 'down' ? 'descend' : g.tidal ? 'étale' : 'pas de marée nette';

    let status: InfoContent['status'];
    if (!reading) status = replayStatus(time);
    else if (reading.kind === 'estimated') status = estimatedStatus(`Estimation pour ${formatTime(time)}`);
    else if (reading.kind === 'held') status = { tone: 'none', text: `Dernière mesure ${formatRelative(g.time * 1000)}` };
    else status = measuredStatus(time, g.time * 1000);

    const points = g.meters.map((v, i) => [(g.seriesStart + i * g.seriesStep) * 1000, v] as const);
    const forecast = g.forecast.map((cm, i) => [(g.forecastStart + i * g.forecastStep) * 1000, cm / 100] as const);
    const marks = [
      ...g.extremes.map((e) => ({ t: e.time * 1000, value: e.height, high: e.high })),
      ...g.next.map((e) => ({ t: e.time * 1000, value: e.height, high: e.high, estimated: true })),
    ];
    const label = (e: ApiExtreme) => `${formatTime(e.time * 1000)} · ${meters(e.height)}`;
    const lastHigh = g.extremes.findLast((e) => e.high);
    const lastLow = g.extremes.findLast((e) => !e.high);
    const nextHigh = g.next.find((e) => e.high && e.time * 1000 > nowMs);
    const nextLow = g.next.find((e) => !e.high && e.time * 1000 > nowMs);
    const fields: Array<[string, string]> = [];
    if (nextHigh) fields.push(['Prochaine pleine mer (estimée)', label(nextHigh)]);
    if (nextLow) fields.push(['Prochaine basse mer (estimée)', label(nextLow)]);
    if (lastHigh) fields.push(['Dernière pleine mer mesurée', `${dayTime.format(lastHigh.time * 1000)} · ${meters(lastHigh.height)}`]);
    if (lastLow) fields.push(['Dernière basse mer mesurée', `${dayTime.format(lastLow.time * 1000)} · ${meters(lastLow.height)}`]);

    const noEstimate = g.tidal && g.next.length === 0;
    return {
      kind: 'Marégraphe · REFMAR',
      title: g.name,
      subtitle: 'Hauteur d’eau, zéro hydrographique',
      status,
      figures: reading
        ? [
            { value: metersFormat.format(reading.level), unit: 'm', label: reading.kind === 'estimated' ? 'niveau estimé' : 'niveau' },
            { value: rateText, unit: g.tidal ? 'm/h' : undefined, label: verb },
            reading?.kind === 'measured' && Math.abs(time - g.time * 1000) > 1_200_000
              ? { value: formatTime(time), label: 'heure affichée' }
              : { value: formatTime(g.time * 1000), label: 'dernière mesure' },
          ]
        : undefined,
      chart: {
        title: g.forecast.length ? 'Niveau (m) : 48 h mesurées, puis estimation en pointillés' : 'Niveau (m) sur 48 h',
        unit: 'm',
        points,
        forecast: forecast.length ? forecast : undefined,
        now: nowMs,
        marks,
        summary: `Niveau de la mer à ${g.name} sur 48 heures : ${metersFormat.format(g.min)} m au plus bas, ${metersFormat.format(g.max)} m au plus haut.`,
      },
      fields,
      note:
        (g.tidal
          ? 'Mesures brutes du Shom, ni validées ni expertisées, en mètres au-dessus du zéro hydrographique (le zéro des cartes marines). '
          : 'Ici la marée est faible : le niveau varie surtout avec la pression et le vent. ') +
        (g.next.length
          ? 'Les marées à venir sont une estimation calculée à partir des 29 derniers jours de mesures du port : elle ignore la météo et ne remplace pas les prévisions officielles du Shom, qui ne sont pas en données ouvertes.'
          : noEstimate
            ? 'Pas d’estimation pour ce port : les prévisions officielles du Shom ne sont pas en données ouvertes, et il manque des mesures pour les calculer.'
            : ''),
      actions: [{ label: 'Source', href: `https://refmar.shom.fr/donnees/${g.id}` }],
    };
  },
});
