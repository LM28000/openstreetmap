/**
 * Éclairage des maquettes 3D (et des colonnes de l'électricité) par le vrai soleil : sa
 * direction au centre de la vue à l'instant de la frise, une teinte dorée au crépuscule, un
 * clair de lune neutre la nuit. Les mêmes règles éclairent les bâtiments de MapLibre
 * (dayNight.ts) : une maquette et l'immeuble voisin ont leur face claire du même côté.
 *
 * L'effet est recréé seulement quand le soleil a bougé d'un degré (ou la lumière d'un cran) :
 * deck.gl redessine tout quand on change ses effets.
 */
import { AmbientLight, DirectionalLight, LightingEffect } from '@deck.gl/core';
import { sunPosition } from '../modules/solar';

type Rgb = [number, number, number];

const DAY: Rgb = [255, 255, 255];
const DUSK: Rgb = [255, 196, 140];
const MOON: Rgb = [170, 180, 205];

const mix = (a: Rgb, b: Rgb, t: number): Rgb => a.map((v, i) => Math.round(v + (b[i]! - v) * t)) as Rgb;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

let cache: { key: string; effects: LightingEffect[] } | undefined;

/** Soleil fixe, haut au sud-ouest : quand la couche « Jour et nuit » est éteinte (fond de jour, bâtiments éclairés de même). */
const FIXED_SUN = { elevation: 50, azimuth: 210 };

/**
 * Effets deck.gl pour le soleil vu de (lat, lon) à l'instant `time`, ou pour un soleil fixe de
 * plein jour si `followSun` est faux. Même tableau tant que rien n'a bougé.
 */
export function sunEffects(lat: number, lon: number, time: number, followSun = true): LightingEffect[] {
  const { elevation, azimuth } = followSun ? sunPosition(lat, lon, time) : FIXED_SUN;
  const key = `${Math.round(elevation)}:${Math.round(azimuth)}`;
  if (cache?.key === key) return cache.effects;

  // Jour : soleil blanc, doré sous 10° ; nuit : une lune fixe, haute au sud-ouest, et un fond plus faible.
  const day = clamp01((elevation + 6) / 12); // 0 sous -6°, 1 au-dessus de +6°
  const sunUp = elevation > 0;
  const color = sunUp ? mix(DAY, DUSK, clamp01((10 - elevation) / 10)) : MOON;
  const height = sunUp ? Math.max(elevation, 8) : 40;
  const az = ((sunUp ? azimuth : 210) * Math.PI) / 180;
  const el = (height * Math.PI) / 180;
  // La lumière va du soleil vers le sol : l'opposé de la direction du soleil (x est, y nord, z haut).
  const direction: [number, number, number] = [-Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), -Math.sin(el)];

  const effects = [
    new LightingEffect({
      ambient: new AmbientLight({ color: mix(MOON, DAY, day), intensity: 0.8 + 0.25 * day }),
      sun: new DirectionalLight({ color, intensity: 0.45 + 0.6 * day, direction }),
      // Lumière d'appoint, à l'opposé et faible : les faces à l'ombre ne tombent pas dans le noir.
      fill: new DirectionalLight({ color: [200, 208, 225], intensity: 0.25, direction: [-direction[0], -direction[1], -0.6] }),
    }),
  ];
  cache = { key, effects };
  return effects;
}
