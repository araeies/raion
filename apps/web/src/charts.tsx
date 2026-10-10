import { useId, useState } from 'react';
import type { HistorySeries } from './api';

const WIDTH = 320;
const HEIGHT = 96;
const PAD_TOP = 8;
const PAD_BOTTOM = 4;

export function formatValue(unit: HistorySeries['unit'], v: number): string {
  if (unit === 'ratio') return `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;
  if (unit === 'seconds') return v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`;
  return `${v < 10 ? v.toFixed(2) : Math.round(v)}/s`;
}

function clock(t: number): string {
  return new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * A small line chart of one series. Gaps (no data) break the line instead of drawing a slope,
 * so "nothing arrived" never looks like a gradual change.
 */
export function Sparkline({
  series,
  from,
  to,
  step,
  tone = 'accent',
  floor,
}: {
  series: HistorySeries;
  from: number;
  to: number;
  step: number;
  tone?: 'accent' | 'crit' | 'violet' | 'ok';
  /** The value the vertical scale always includes (0 by default; 1 for "share succeeded"). */
  floor?: number;
}) {
  const gradient = useId();
  const [hover, setHover] = useState<number | null>(null);
  const pts = series.points;
  const values = pts.map(([, v]) => v);
  const max = Math.max(...values, floor ?? 0, series.unit === 'ratio' ? 0.01 : 1e-9);
  const min = series.unit === 'ratio' && floor === 1 ? Math.min(...values, 0.9) : 0;
  const x = (t: number) => ((t - from) / Math.max(1, to - from)) * WIDTH;
  const y = (v: number) =>
    PAD_TOP + (1 - (v - min) / Math.max(1e-9, max - min)) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

  // Split into runs wherever a point is missing.
  const runs: [number, number][][] = [];
  for (const p of pts) {
    const last = runs.at(-1);
    const prev = last?.at(-1);
    if (last && prev && p[0] - prev[0] <= step * 1.5) last.push(p);
    else runs.push([p]);
  }
  const line = runs
    .map((r) =>
      r.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(''),
    )
    .join('');
  const area = runs
    .filter((r) => r.length > 1)
    .map(
      (r) =>
        `M${x(r[0]![0]).toFixed(1)},${HEIGHT}` +
        r.map(([t, v]) => `L${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('') +
        `L${x(r.at(-1)![0]).toFixed(1)},${HEIGHT}Z`,
    )
    .join('');
  const latest = pts.at(-1);
  const shown = hover === null ? null : pts[hover];

  const pick = (clientX: number, rect: DOMRect) => {
    if (pts.length === 0) return;
    const t = from + ((clientX - rect.left) / rect.width) * (to - from);
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(pts[i]![0] - t) < Math.abs(pts[best]![0] - t)) best = i;
    }
    setHover(best);
  };

  return (
    <figure className={`chart chart-${tone}`}>
      <figcaption>
        <span className="chart-label">{series.label}</span>
        <span className="chart-value" aria-live="polite">
          {shown
            ? `${formatValue(series.unit, shown[1])} at ${clock(shown[0])}`
            : latest
              ? formatValue(series.unit, latest[1])
              : 'No data'}
        </span>
      </figcaption>
      {pts.length === 0 ? (
        <div className="chart-empty">Nothing arrived in this period.</div>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`${series.label}, ${clock(from)} to ${clock(to)}. Now ${latest ? formatValue(series.unit, latest[1]) : 'no data'}; highest ${formatValue(series.unit, Math.max(...values))}.`}
          tabIndex={0}
          onPointerMove={(e) => pick(e.clientX, e.currentTarget.getBoundingClientRect())}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? pts.length) - 1));
            else if (e.key === 'ArrowRight')
              setHover((h) => Math.min(pts.length - 1, (h ?? -1) + 1));
            else if (e.key === 'Escape') setHover(null);
            else return;
            e.preventDefault();
          }}
        >
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line className="chart-grid" x1="0" x2={WIDTH} y1={y(max)} y2={y(max)} />
          <line
            className="chart-grid"
            x1="0"
            x2={WIDTH}
            y1={y((max + min) / 2)}
            y2={y((max + min) / 2)}
          />
          <path d={area} fill={`url(#${gradient})`} stroke="none" />
          <path d={line} className="chart-line" vectorEffect="non-scaling-stroke" />
          {shown && (
            <line
              className="chart-cursor"
              x1={x(shown[0])}
              x2={x(shown[0])}
              y1={0}
              y2={HEIGHT}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      )}
      <div className="chart-axis" aria-hidden="true">
        <span>{clock(from)}</span>
        <span>now</span>
      </div>
    </figure>
  );
}
