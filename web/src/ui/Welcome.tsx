import { useEffect, useRef } from 'react';
import type { ModuleManager } from '../core/moduleManager';
import { SCENES, applyScene } from '../core/scenes';
import { tour } from '../core/tour';
import { formatShortDate, formatTime } from './format';
import { useClockTime, useModuleStates } from './hooks';
import { Icon } from './icons';
import { leadingCount } from './layerInfo';

const SEEN_KEY = 'carte-vivante:accueil-vu';
/** Lignes de l'accueil, dans l'ordre de préférence : ce qui parle d'abord à quelqu'un qui découvre. */
const LINE_ORDER = ['trains', 'avions', 'bateaux', 'transports', 'vigilance-meteo', 'electricite', 'velos', 'voies', 'seismes'];
const MAX_LINES = 4;

/**
 * Faut-il montrer l'accueil ? Seulement à la toute première visite, et jamais quand l'adresse
 * porte déjà une vue à rouvrir. Le drapeau est posé dès l'affichage : recharger ne le ramène pas.
 */
export function shouldShowWelcome(openedFromSharedLink: boolean): boolean {
  if (openedFromSharedLink) return false;
  try {
    if (localStorage.getItem(SEEN_KEY)) return false;
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    return false; // sans stockage on ne pourrait pas se souvenir : mieux vaut ne pas insister à chaque visite
  }
  return true;
}

/** Une ligne de résumé : compteur à droite, reste du texte à gauche. */
function splitSummary(summary: string): { count: string | null; text: string } {
  const first = summary.split(' · ')[0] ?? summary;
  const count = leadingCount(first);
  return { count, text: count ? first.slice(count.length).trim() : first };
}

interface WelcomeProps {
  manager: ModuleManager;
  onClose: () => void;
}

/** Carte « Maintenant en France » de la première visite : l'instant en quelques lignes, et une scène à découvrir. */
export function Welcome({ manager, onClose }: WelcomeProps) {
  const states = useModuleStates(manager);
  const time = useClockTime(5_000);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primary.current?.focus({ preventScroll: true });
  }, []);

  const withSummary = manager.modules
    .filter((module) => states[module.id]?.visible && states[module.id]?.summary)
    .sort((a, b) => rank(a.id) - rank(b.id))
    .slice(0, MAX_LINES);

  const motion = SCENES[0]!;
  const hidden = motion.modules.filter((id) => !states[id]?.visible);

  return (
    <section className="welcome panel" role="dialog" aria-label="Maintenant en France">
      <header className="welcome__head">
        <span className="kicker">
          Maintenant en France · <span className="mono">{formatTime(time)}</span>
        </span>
        <h2 className="welcome__title">{capitalize(formatShortDate(time))}</h2>
      </header>
      <ul className="welcome__lines">
        {withSummary.map((module) => {
          const { count, text } = splitSummary(states[module.id]?.summary ?? '');
          return (
            <li key={module.id} className="welcome__line">
              <Icon name={module.id} size={18} />
              <span className="welcome__text">{count ? text || module.name : `${module.name} · ${text}`}</span>
              {count && <b className="welcome__count">{count}</b>}
            </li>
          );
        })}
        {withSummary.length === 0 && <li className="welcome__line welcome__line--wait">Les premières données arrivent…</li>}
      </ul>
      {hidden.length > 0 && (
        <p className="welcome__hint">
          La scène « {motion.label} » ajoute {hidden.map((id) => manager.modules.find((m) => m.id === id)?.name.toLowerCase()).join(', ')}.
        </p>
      )}
      <div className="actions welcome__actions">
        <button
          ref={primary}
          type="button"
          className="btn btn--primary"
          onClick={() => {
            onClose();
            void tour.start(manager);
          }}
        >
          <Icon name="visite" size={16} />
          Visite guidée · 3 minutes
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            applyScene(manager, motion);
            onClose();
          }}
        >
          Voir ce qui bouge
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Explorer seul
        </button>
      </div>
    </section>
  );
}

function rank(id: string): number {
  const i = LINE_ORDER.indexOf(id);
  return i < 0 ? LINE_ORDER.length : i;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
