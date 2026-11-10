/** Ce que l'interface sait dire d'une couche d'après son résumé et sa légende. */
import type { LegendItem } from '../core/module';
import type { ModuleRuntimeState } from '../core/moduleManager';
import { formatRelative } from './format';

/**
 * Compteur court d'un résumé qui commence par un nombre : « 887 trains en circulation… » → « 887 ».
 * Les autres résumés (« France : production… », « Hors direct… ») n'en donnent pas.
 */
export function leadingCount(summary: string | null | undefined): string | null {
  const match = /^(\d[\d   ]*\d|\d)\s+\p{L}/u.exec(summary ?? '');
  return match?.[1]?.replace(/[  ]/g, ' ') ?? null;
}

/**
 * Échantillon de couleur d'une couche : sa couleur si la légende n'en a qu'une, sinon quelques
 * teintes de la légende en bandes franches. Sans légende, un gris neutre.
 */
export function swatchBackground(legend: readonly LegendItem[]): string {
  const colors = [...new Set(legend.map((item) => item.color).filter(Boolean))];
  if (colors.length === 0) return 'var(--ui-faint)';
  // Au plus quatre teintes, réparties sur toute la légende (une rampe garde ses deux bouts).
  const picked =
    colors.length <= 4 ? colors : [0, 1, 2, 3].map((i) => colors[Math.round((i * (colors.length - 1)) / 3)] as string);
  if (picked.length === 1) return picked[0]!;
  const step = 100 / picked.length;
  return `linear-gradient(90deg, ${picked.map((color, i) => `${color} ${i * step}% ${(i + 1) * step}%`).join(', ')})`;
}

/** Ligne de fraîcheur d'une couche : son résumé, sinon l'âge de ses dernières données. */
export function freshness(state: ModuleRuntimeState, now: number): string {
  if (state.status === 'loading') return 'chargement…';
  if (state.status === 'error') return state.lastUpdated ? 'erreur, anciennes données' : 'erreur de chargement';
  if (state.visible && state.summary) return state.summary;
  if (state.lastUpdated !== undefined) return `mis à jour ${formatRelative(state.lastUpdated, now)}`;
  return '';
}
