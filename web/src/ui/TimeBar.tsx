import { useEffect } from 'react';
import { clock } from '../core/clock';
import { formatClock, formatLongDate, formatOffset } from './format';
import { useClockState, useClockTime } from './hooks';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Plage de la frise : 7 jours en arrière (historique des séismes), 2 jours en avant (horaires prévus). */
const PAST_RANGE_MS = 7 * DAY;
const FUTURE_RANGE_MS = 2 * DAY;

const SPEEDS = [
  { value: 1, label: '×1', title: 'Temps réel' },
  { value: 60, label: '1 min/s', title: 'Une minute par seconde' },
  { value: 600, label: '10 min/s', title: 'Dix minutes par seconde' },
  { value: 3_600, label: '1 h/s', title: 'Une heure par seconde' },
  { value: 21_600, label: '6 h/s', title: 'Six heures par seconde' },
];

export function TimeBar() {
  const { playing, speed, live } = useClockState();
  const time = useClockTime();
  const realNow = Date.now();

  useKeyboardShortcuts();

  return (
    <div className="panel timebar" role="group" aria-label="Contrôle du temps">
      <div className="timebar__row">
        <button
          type="button"
          className={`live-button${live ? ' live-button--on' : ''}`}
          onClick={() => clock.goLive()}
          title="Revenir au présent (L)"
        >
          <span className="live-button__dot" aria-hidden="true" />
          {live ? 'En direct' : 'Revenir au direct'}
        </button>

        <button
          type="button"
          className="icon-button icon-button--large"
          onClick={() => clock.toggle()}
          aria-label={playing ? 'Pause (espace)' : 'Lecture (espace)'}
          title={playing ? 'Pause (espace)' : 'Lecture (espace)'}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>

        <div className="timebar__time" aria-live="off">
          <span className="timebar__clock">{formatClock(time)}</span>
          <span className="timebar__date">
            {formatLongDate(time)}
            {!live && <span className="timebar__offset"> · {formatOffset(time - realNow)}</span>}
          </span>
        </div>

        <div className="speeds" role="radiogroup" aria-label="Vitesse">
          {SPEEDS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={speed === option.value}
              className="speed"
              title={option.title}
              onClick={() => clock.setSpeed(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <input
        type="range"
        className="timebar__slider"
        aria-label="Instant affiché"
        min={realNow - PAST_RANGE_MS}
        max={realNow + FUTURE_RANGE_MS}
        step={60_000}
        value={Math.min(Math.max(time, realNow - PAST_RANGE_MS), realNow + FUTURE_RANGE_MS)}
        onChange={(event) => clock.seek(Number(event.target.value))}
      />
      <div className="timebar__scale" aria-hidden="true">
        <span>−7 j</span>
        <span>maintenant</span>
        <span>+2 j</span>
      </div>
    </div>
  );
}

/**
 * Espace : lecture/pause · L : retour au direct.
 * (Les flèches restent à la carte : elles servent à se déplacer et à tourner.)
 */
function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Space') {
        event.preventDefault();
        clock.toggle();
      } else if (event.key === 'l' || event.key === 'L') {
        clock.goLive();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function PlayIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M5 3.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="4" y="3.5" width="3.5" height="11" rx="1" fill="currentColor" />
      <rect x="10.5" y="3.5" width="3.5" height="11" rx="1" fill="currentColor" />
    </svg>
  );
}
