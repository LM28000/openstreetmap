/**
 * Icônes de l'interface : tracés simples en contour, de la même famille que la maquette.
 * Elles prennent la couleur du texte (`currentColor`) : l'interface reste neutre,
 * la couleur est réservée aux données.
 */
import type { SVGProps } from 'react';

const PATHS: Record<string, string> = {
  search: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM16 16l4.5 4.5',
  layers: 'm12 4 8 4.5-8 4.5-8-4.5ZM4 13l8 4.5 8-4.5',
  x: 'm7 7 10 10M17 7 7 17',
  chevron: 'm9 6 6 6-6 6',
  chevronLeft: 'm15 6-6 6 6 6',
  visite: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM10.2 9v6l5-3Z',
  chevronDown: 'm6 9 6 6 6-6',
  play: 'M8 5.5v13l10-6.5Z',
  pause: 'M8 5v14M16 5v14',
  follow: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM12 3v3M12 18v3M3 12h3M18 12h3',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  clock: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM12 8v4l3 2',
  // Couches (une par module)
  trains: 'M9 3h6a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM6 11h12M9 21l1.5-4M15 21l-1.5-4',
  voies: 'M8 3 5 21M16 3l3 18M6.5 8h11M5.8 14h12.4M5.2 19h13.6',
  trafic: 'M5 16V11l2-5h10l2 5v5ZM5 16v2.5M19 16v2.5M5 11h14M8 14h.01M16 14h.01',
  avions: 'M21 16v-2l-8-5V4a1.5 1.5 0 0 0-3 0v5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-4.5Z',
  bateaux: 'M4 15h16l-2.5 4.5h-11ZM12 4v11M12 5l5 8h-5',
  transports: 'M6 4h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM4 11h16M7 20v-3M17 20v-3M8 14.5h.01M16 14.5h.01',
  velos: 'M6 12.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM18 12.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM6 16 9.5 8h4l4.5 8M9.5 8 12 16h2',
  vigicrues: 'M3 9c3-2.5 6 2.5 9 0s6 2.5 9 0M3 14c3-2.5 6 2.5 9 0s6 2.5 9 0M3 19c3-2.5 6 2.5 9 0s6 2.5 9 0M12 3v2',
  'vigilance-meteo': 'M12 4 3 19.5h18ZM12 10v4.5M12 17v.01',
  air: 'M6 7h.01M12 5h.01M18 8h.01M9 11h.01M15 12h.01M5 15h.01M11 17h.01M18 17h.01M8 20h.01M14 21h.01',
  feux: 'M12 3c.5 3.5 4.5 5 4.5 10a4.5 4.5 0 0 1-9 0c0-2 1-3 2-4 0 1.5 1 2 1.5 2C11 8 10.5 5.5 12 3Z',
  seismes: 'M3 12h4l2-6 3 12 3-9 2 3h4',
  electricite: 'M13 3 5 13.5h6L10 21l8-10.5h-6Z',
  bornes: 'M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0ZM12 16v5',
  carburants: 'M5 20V6a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v14M4 20h11M5 10h9M14 8l3 2v7a1.5 1.5 0 0 0 3 0v-5l-2.5-3',
  'jour-nuit': 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z',
  'ombres-batiments': 'M5 20V8l5-3v15M10 9h5l4 3v8M5 20h14M7.5 11h.01M7.5 14h.01M7.5 17h.01',
  satellites: 'm8 8 4 4M10 5l4 4-5 5-4-4ZM15 10l4 4-5 5-4-4ZM5 19l2-2M19 5l-2 2',
  photos: 'M4 8h3l1.5-2h7L17 8h3v11H4ZM12 11a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z',
  monuments: 'M3 20h18M5 20V11M9.5 20V11M14.5 20V11M19 20V11M3 11l9-6.5 9 6.5Z',
  accidents: 'M8 21 10 3M16 21l-2-18M12 5v2.5M12 10.5v3M12 16.5V19',
  pluie: 'M7 15a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.6 1.5A3.5 3.5 0 0 1 17 15ZM9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5',
  vent: 'M3 9h10a2.5 2.5 0 1 0-2.5-2.5M3 13h14a2.5 2.5 0 1 1-2.5 2.5M3 17h6',
};

/** Icône générique d'une couche inconnue. */
const FALLBACK = PATHS.layers;

export function Icon({ name, size = 18, ...rest }: { name: string; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name] ?? FALLBACK} />
    </svg>
  );
}
