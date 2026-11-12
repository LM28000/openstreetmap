import type { InfoChart } from '../core/module';
import { formatTime } from './format';

const W = 300;
const H = 86;
const PAD = { left: 30, right: 6, top: 8, bottom: 16 };

/** Courbe de la fiche : mesures en trait plein, estimation en pointillés, repère « maintenant ». Pas de bibliothèque : un tracé SVG. */
export function InfoChartView({ chart }: { chart: InfoChart }) {
  const measured = chart.points.filter((p): p is readonly [number, number] => p[1] !== null);
  const all = [...measured, ...(chart.forecast ?? [])];
  if (all.length < 2) return null;
  const t0 = Math.min(...all.map((p) => p[0]));
  const t1 = Math.max(...all.map((p) => p[0]));
  const values = all.map((p) => p[1]);
  const lo = Math.floor(Math.min(...values) * 2) / 2;
  const hi = Math.max(Math.ceil(Math.max(...values) * 2) / 2, lo + 0.5);
  const x = (t: number) => PAD.left + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const f = (n: number) => n.toFixed(1);

  // Un trait par tronçon continu : un trou dans les mesures n'est pas relié.
  const segments: Array<Array<readonly [number, number]>> = [[]];
  for (const p of chart.points) {
    if (p[1] === null) {
      if (segments.at(-1)!.length) segments.push([]);
    } else segments.at(-1)!.push([p[0], p[1]]);
  }
  const path = (pts: ReadonlyArray<readonly [number, number]>) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${f(x(p[0]))} ${f(y(p[1]))}`).join('');
  const last = measured.at(-1);
  const forecast = chart.forecast && last ? [last, ...chart.forecast] : chart.forecast;

  // Repères horizontaux : le bas, le milieu et le haut.
  const ticks = [lo, (lo + hi) / 2, hi];
  // Repères horaires toutes les 12 h, alignés sur l'heure de Paris (le décalage est lu sur la première heure).
  const step = 12 * 3600_000;
  const offset = parisOffsetMs(t0);
  const hours: number[] = [];
  for (let t = Math.ceil((t0 + offset) / step) * step - offset; t <= t1; t += step) hours.push(t);

  return (
    <figure className="chart" role="img" aria-label={chart.summary}>
      <figcaption className="chart__title">{chart.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        {ticks.map((v) => (
          <g key={v}>
            <line className="chart__grid" x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} />
            <text className="chart__axis" x={PAD.left - 4} y={y(v) + 3} textAnchor="end">
              {v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}
            </text>
          </g>
        ))}
        {hours.map((t) => (
          <text key={t} className="chart__axis" x={x(t)} y={H - 3} textAnchor="middle">
            {formatTime(t)}
          </text>
        ))}
        {chart.now !== undefined && chart.now >= t0 && chart.now <= t1 && (
          <line className="chart__now" x1={x(chart.now)} x2={x(chart.now)} y1={PAD.top} y2={H - PAD.bottom} />
        )}
        {segments
          .filter((s) => s.length > 1)
          .map((s) => (
            <g key={s[0]![0]}>
              <path className="chart__area" d={`${path(s)}L${f(x(s.at(-1)![0]))} ${f(y(lo))}L${f(x(s[0]![0]))} ${f(y(lo))}Z`} />
              <path className="chart__line" d={path(s)} />
            </g>
          ))}
        {forecast && forecast.length > 1 && <path className="chart__forecast" d={path(forecast)} />}
        {chart.marks
          ?.filter((m) => m.t >= t0 && m.t <= t1)
          .map((m) => (
            <circle key={m.t} className={`chart__dot${m.estimated ? ' chart__dot--estimated' : ''}`} cx={x(m.t)} cy={y(m.value)} r={2.8} />
          ))}
      </svg>
    </figure>
  );
}

const parisHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' });
/** Décalage de l'heure de Paris sur UTC à cet instant, en millisecondes (1 h l'hiver, 2 h l'été). */
function parisOffsetMs(t: number): number {
  const parisH = Number(parisHour.format(t));
  const utcH = new Date(t).getUTCHours();
  return ((parisH - utcH + 24) % 24) * 3600_000;
}
