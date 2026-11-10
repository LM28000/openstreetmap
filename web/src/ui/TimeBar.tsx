import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { clock } from '../core/clock';
import { sunElevation } from '../modules/solar';
import {
  formatClock,
  formatDayLabel,
  formatOffset,
  formatShortDate,
  fromDateTimeInput,
  fromParis,
  parisMidnight,
  parisParts,
  toDateTimeInput,
} from './format';
import { useClockState, useClockTime, useNow } from './hooks';
import { Icon } from './icons';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Plage de la frise : 7 jours en arrière (historique des séismes), 2 jours en avant (horaires prévus). */
const PAST_RANGE_MS = 7 * DAY;
const FUTURE_RANGE_MS = 2 * DAY;
/** Les bandes jour et nuit sont calculées pour Paris : l'écart de lever du soleil sur la France reste sous une heure. */
const PARIS = { lat: 48.86, lon: 2.35 };
/** Place minimale d'un nom de jour sur la piste, en pixels. */
const DAY_LABEL_WIDTH = 58;

export const SPEEDS = [
  { value: 1, label: '×1', title: 'Temps réel' },
  { value: 60, label: '1 min/s', title: 'Une minute par seconde' },
  { value: 600, label: '10 min/s', title: 'Dix minutes par seconde' },
  { value: 3_600, label: '1 h/s', title: 'Une heure par seconde' },
  { value: 21_600, label: '6 h/s', title: 'Six heures par seconde' },
];

/**
 * Frise : direct, lecture, heure, piste de −7 j à +2 j, vitesse et sauts.
 * `compact` : version de la feuille du téléphone (sans date ni nom de jour).
 */
export function TimeBar({ compact = false }: { compact?: boolean }) {
  const { playing, speed, live } = useClockState();
  const time = useClockTime();
  // Les bornes de la piste suivent l'heure réelle, à la minute : le curseur ne saute pas.
  const realNow = useNow(30_000);

  return (
    <div className={compact ? 'timebar timebar--compact' : 'panel timebar'} role="group" aria-label="Contrôle du temps">
      <LivePill live={live} short={compact} />
      <button
        type="button"
        className="icon-button timebar__play"
        onClick={() => clock.toggle()}
        aria-label={playing ? 'Pause (espace)' : 'Lecture (espace)'}
        title={playing ? 'Pause (espace)' : 'Lecture (espace)'}
      >
        {playing ? <Icon name="pause" size={18} /> : <Icon name="play" size={18} fill="currentColor" />}
      </button>

      <div className="timebar__time">
        <span className="timebar__clock">{formatClock(time).slice(0, compact ? 5 : 8)}</span>
        {!compact && (
          <span className="timebar__date">
            {formatShortDate(time)}
            {!live && <span className="timebar__offset"> · {formatOffset(time - Date.now())}</span>}
          </span>
        )}
      </div>

      <Track time={time} realNow={realNow} compact={compact} />
      <SpeedMenu speed={speed} />
    </div>
  );
}

/** `short` : « Direct » dans les deux états, pour la feuille du téléphone où la place manque. */
export function LivePill({ live, short = false }: { live: boolean; short?: boolean }) {
  const label = live ? 'En direct' : 'Revenir au direct';
  return (
    <button
      type="button"
      className={`live${live ? ' live--on' : ''}`}
      onClick={() => clock.goLive()}
      aria-pressed={live}
      aria-label={label}
      title={live ? 'Vous regardez le présent' : 'Revenir au présent, en temps réel'}
    >
      <span className="live__dot" aria-hidden="true" />
      {short ? 'Direct' : label}
    </button>
  );
}

function Track({ time, realNow, compact }: { time: number; realNow: number; compact: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const from = Math.round(realNow / 60_000) * 60_000 - PAST_RANGE_MS;
  const to = from + PAST_RANGE_MS + FUTURE_RANGE_MS;
  const frac = (t: number) => Math.min(1, Math.max(0, (t - from) / (to - from)));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Bandes jour et nuit : la teinte suit la hauteur du soleil, avec un crépuscule progressif.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(24 * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(ratio, ratio);
    for (let x = 0; x < width; x += 2) {
      const elevation = sunElevation(PARIS.lat, PARIS.lon, from + ((x + 1) / width) * (to - from));
      const light = Math.min(1, Math.max(0, (elevation + 6) / 24));
      const eased = light * light * (3 - 2 * light);
      context.fillStyle = `rgb(${Math.round(27 + 59 * eased)}, ${Math.round(34 + 64 * eased)}, ${Math.round(51 + 71 * eased)})`;
      context.fillRect(x, 0, 2, 24);
    }
  }, [width, from, to]);

  // Minuits à Paris dans la plage, et nom du jour au milieu de chaque jour.
  const midnights: number[] = [];
  for (let m = parisMidnight(from, 1); m < to; m = parisMidnight(m + 12 * HOUR, 1)) midnights.push(m);
  const dayStarts = [parisMidnight(from), ...midnights];
  const dayPx = width / ((to - from) / DAY);
  const labelEvery = Math.max(1, Math.ceil(DAY_LABEL_WIDTH / Math.max(dayPx, 1)));
  const nowX = frac(realNow) * width;
  const labels = dayStarts
    .map((start, i) => {
      const end = dayStarts[i + 1] ?? parisMidnight(start + 30 * HOUR);
      const visibleStart = Math.max(start, from);
      const visibleEnd = Math.min(end, to);
      return { start, x: frac((visibleStart + visibleEnd) / 2) * width, share: (visibleEnd - visibleStart) / DAY };
    })
    .filter((label, i) => label.share >= 0.5 && i % labelEvery === 0)
    .filter((label) => Math.abs(label.x - nowX) > DAY_LABEL_WIDTH * 0.7);

  const head = frac(time) * width;

  return (
    <div className="track" ref={ref}>
      <canvas ref={canvasRef} className="track__bands" style={{ width, height: 24 }} aria-hidden="true" />
      <div className="track__future" style={{ left: nowX }} aria-hidden="true" />
      {midnights.map((m) => (
        <i key={m} className="track__tick" style={{ left: frac(m) * width }} aria-hidden="true" />
      ))}
      <span className="track__now" style={{ left: nowX }} aria-hidden="true" />
      <span className="track__head" style={{ left: head }} aria-hidden="true" />
      {!compact && (
        <>
          {labels.map((label) => (
            <span key={label.start} className="track__label" style={{ left: label.x }} aria-hidden="true">
              {formatDayLabel(label.start + 12 * HOUR)}
            </span>
          ))}
          <span className="track__label track__label--now" style={{ left: nowX }} aria-hidden="true">
            maintenant
          </span>
        </>
      )}
      <input
        type="range"
        className="track__input"
        aria-label="Instant affiché"
        min={from}
        max={to}
        step={60_000}
        value={Math.min(Math.max(time, from), to)}
        onChange={(event) => clock.seek(Number(event.target.value))}
      />
    </div>
  );
}

function SpeedMenu({ speed }: { speed: number }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [dateValue, setDateValue] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const current = SPEEDS.find((option) => option.value === speed);

  const close = (restoreFocus = true) => {
    setOpen(false);
    setCustom(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const radios = rootRef.current?.querySelectorAll<HTMLElement>('[role="radio"]');
    (rootRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? radios?.[0])?.focus();
  }, [open]);

  const seekTo = (instant: number) => clock.seek(instant);
  const yesterday8 = () => {
    const p = parisParts(Date.now());
    return fromParis(p.year, p.month, p.day - 1, 8, 0);
  };
  const goToDate = () => {
    const instant = fromDateTimeInput(dateValue);
    if (instant === null) return;
    seekTo(instant);
    close();
  };

  return (
    <div
      className="speed-menu"
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="speed"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        aria-label={`Vitesse du temps : ${current?.title ?? `×${speed}`}. Ouvrir le menu de vitesse et de sauts`}
        onClick={() => setOpen(!open)}
      >
        {current?.label ?? `×${speed}`}
        <Icon name="chevronDown" size={14} />
      </button>

      {open && (
        <div className="popover panel" id={popoverId} role="dialog" aria-label="Vitesse du temps et sauts">
          <h3 className="kicker">Vitesse du temps</h3>
          <div className="popover__speeds" role="radiogroup" aria-label="Vitesse">
            {SPEEDS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={speed === option.value}
                className="popover__speed"
                title={option.title}
                onClick={() => {
                  clock.setSpeed(option.value);
                  close();
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
          <h3 className="kicker">Aller à</h3>
          <div className="popover__jumps">
            <button type="button" className="btn btn--small" onClick={() => seekTo(clock.now() - HOUR)}>
              −1 h
            </button>
            <button type="button" className="btn btn--small" onClick={() => seekTo(clock.now() + HOUR)}>
              +1 h
            </button>
            <button
              type="button"
              className="btn btn--small"
              onClick={() => {
                seekTo(yesterday8());
                close();
              }}
            >
              Hier 8 h
            </button>
            <button
              type="button"
              className="btn btn--small"
              aria-expanded={custom}
              onClick={() => {
                setCustom(!custom);
                setDateValue(toDateTimeInput(clock.now()));
              }}
            >
              Choisir une date…
            </button>
          </div>
          {custom && (
            <form
              className="popover__date"
              onSubmit={(event) => {
                event.preventDefault();
                goToDate();
              }}
            >
              <input
                type="datetime-local"
                value={dateValue}
                min={toDateTimeInput(Date.now() - PAST_RANGE_MS)}
                max={toDateTimeInput(Date.now() + FUTURE_RANGE_MS)}
                onChange={(event) => setDateValue(event.target.value)}
                aria-label="Date et heure (heure de Paris)"
                autoFocus
              />
              <button type="submit" className="btn btn--small btn--primary">
                Aller
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
