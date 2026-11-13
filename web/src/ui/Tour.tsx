import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ModuleManager } from '../core/moduleManager';
import { tour } from '../core/tour';
import { formatShortDate, formatTime } from './format';
import { useClockState, useClockTime, useModuleStates } from './hooks';
import { Icon } from './icons';
import { Mark } from './Mark';

/** État de la visite guidée, pour l'interface. */
export function useTour() {
  return useSyncExternalStore(tour.subscribe, tour.getState);
}

/** Bouton « Visite guidée » du catalogue des couches (ordinateur et téléphone). */
export function TourLauncher({ manager }: { manager: ModuleManager }) {
  return (
    <button
      type="button"
      className="tour-launch"
      onClick={() => void tour.start(manager)}
      title="Une visite de 3 minutes : trains, avions, isochrones, prix, élections…"
    >
      <Icon name="visite" size={20} />
      <span className="tour-launch__text">
        <b>Visite guidée</b>
        <span>12 étapes, 3 minutes, la carte en mouvement</span>
      </span>
    </button>
  );
}

/**
 * Panneau de la visite : en bas à gauche, au-dessus de la frise, sur ordinateur ; à la place de la feuille sur téléphone,
 * où il reste compact pour ne pas couvrir la carte. Il annonce ses changements aux lecteurs d'écran (`aria-live`).
 */
export function TourPanel({ manager, phone }: { manager: ModuleManager; phone: boolean }) {
  const state = useTour();
  const states = useModuleStates(manager);
  const { live } = useClockState();
  const time = useClockTime(1_000);
  const ref = useRef<HTMLElement>(null);

  // Sur téléphone, les commandes de la carte et les crédits se posent au-dessus de la place que prend le panneau.
  useEffect(() => {
    const element = ref.current;
    if (!element || !phone) return;
    const publish = () => document.documentElement.style.setProperty('--sheet-h', `${element.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--sheet-h');
    };
  }, [phone]);

  const ended = state.phase === 'end';
  const stat = state.statModule ? states[state.statModule]?.summary : null;
  const when = live ? 'En direct' : `${formatShortDate(time)} · ${formatTime(time)}`;

  return (
    <section ref={ref} className={`tour panel${phone ? ' tour--phone' : ''}${ended ? ' tour--ended' : ''}`} role="region" aria-label="Visite guidée">
      <div className="tour__steps" aria-hidden="true">
        {Array.from({ length: state.total }, (_, i) => (
          <span
            key={i}
            className={`tour__step${i < state.index || ended ? ' tour__step--done' : ''}${i === state.index && !ended ? ' tour__step--now' : ''}`}
          >
            {i === state.index && !ended && state.phase === 'showing' && (
              <i
                key={state.shownAt}
                className="tour__fill"
                style={{ animationDuration: `${state.dwellMs}ms`, animationPlayState: state.playing ? 'running' : 'paused' }}
              />
            )}
          </span>
        ))}
      </div>

      <header className="tour__head">
        {ended && <Mark size={40} className="tour__mark" />}
        <span className="kicker">
          {ended ? 'Fin de la visite' : state.kicker}{' '}
          {!ended && (
            <span className="mono">
              · {state.index + 1} / {state.total}
            </span>
          )}
        </span>
        {!ended && (
          <span className={`tour__when mono${live ? ' tour__when--live' : ''}`} title="Instant affiché par la carte">
            {when}
          </span>
        )}
      </header>

      {/* Seuls le titre et la légende sont annoncés aux lecteurs d'écran : l'heure, elle, change chaque seconde. */}
      <div className="tour__text" aria-live="polite">
      <h2 className="tour__title">{state.title}</h2>
      {state.caption ? (
        <p className="tour__caption">{state.caption}</p>
      ) : (
        <p className="tour__wait">
          <span className="tour__dot" aria-hidden="true" />
          Chargement des données…
        </p>
      )}
      </div>
      {!ended && state.caption && stat && <p className="tour__stat mono">{stat}</p>}
      {state.notice && <p className="tour__notice">{state.notice}</p>}

      <div className="tour__controls">
        <button
          type="button"
          className="icon-button"
          onClick={() => tour.prev()}
          disabled={!ended && state.index === 0}
          aria-label="Étape précédente (←)"
          title="Étape précédente (←)"
        >
          <Icon name="chevronLeft" size={18} />
        </button>
        <button
          type="button"
          className="icon-button tour__play"
          onClick={() => tour.toggle()}
          aria-label={state.playing ? 'Mettre la visite en pause (espace)' : 'Reprendre la visite (espace)'}
          title={state.playing ? 'Pause (espace)' : 'Reprendre (espace)'}
        >
          {state.playing ? <Icon name="pause" size={18} /> : <Icon name="play" size={18} fill="currentColor" />}
        </button>
        <button type="button" className="icon-button" onClick={() => tour.next()} disabled={ended} aria-label="Étape suivante (→)" title="Étape suivante (→)">
          <Icon name="chevron" size={18} />
        </button>
        <span className="tour__spacer" />
        {/* Une seule action principale : à la fin, « Recommencer la visite » ; pendant la visite, la lecture. */}
        {ended && (
          <button type="button" className="btn btn--primary" onClick={() => tour.restart()}>
            Recommencer la visite
          </button>
        )}
        <button type="button" className="btn" onClick={() => tour.quit()} title="Quitter et retrouver ma vue (Échap)">
          {ended ? 'Terminer' : 'Quitter'}
          {!ended && !phone && <kbd className="tour__kbd">Échap</kbd>}
        </button>
      </div>
      {!state.playing && !ended && <p className="tour__paused">Visite en pause : la carte est à vous.</p>}
    </section>
  );
}
