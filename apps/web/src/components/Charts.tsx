import { useEffect, useRef, useState } from "react";

/**
 * Small hand-drawn charts. Colors come from CSS tokens (styles.css): --series-1 (blue) and
 * --series-2 (orange) in that fixed order; status colors are never used for series. Every chart
 * has a hover readout, and any chart with two series has a legend.
 */

export interface BarDatum {
  label: string;
  value: number;
  /** Shown at the end of the bar; defaults to the value. */
  display?: string;
  /** Extra line in the hover readout. */
  detail?: string;
}

/** Horizontal bars, one series, sorted by the caller. */
export function HBarChart({ data, max, unit = "" }: { data: BarDatum[]; max?: number; unit?: string }) {
  const top = max ?? Math.max(1, ...data.map((d) => d.value));
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="hbar" role="table">
      {data.map((d, i) => (
        <div
          className={`hbar-row${hover === i ? " is-hover" : ""}`}
          role="row"
          key={d.label}
          onMouseEnter={() => setHover(i)}
          onMouseLeave={() => setHover(null)}
          title={d.detail ? `${d.label}: ${d.display ?? d.value}${unit} - ${d.detail}` : undefined}
        >
          <span className="hbar-label" role="cell">
            {d.label}
          </span>
          <span className="hbar-track" role="cell">
            <span className="hbar-fill" style={{ width: `${Math.max(1, (d.value / top) * 100)}%` }} />
          </span>
          <span className="hbar-value num" role="cell">
            {d.display ?? `${d.value}${unit}`}
          </span>
        </div>
      ))}
    </div>
  );
}

export interface GroupDatum {
  label: string;
  a: number | null;
  b: number | null;
  /** Shown under the label, e.g. how many alerts the bucket holds. */
  sub?: string;
  /** Shorter forms used when the buckets are too narrow for the full ones (phones). */
  shortLabel?: string;
  shortSub?: string;
}

/**
 * Grouped vertical bars on a 0-100% scale with dashed target lines - for hit rates, where the
 * question is always "how far from the 75% / 50% line". `a` is the 2x series, `b` the 4x one.
 */
export function TargetBars({
  data,
  aLabel,
  bLabel,
  aTarget,
  bTarget,
  height = 180,
}: {
  data: GroupDatum[];
  aLabel: string;
  bLabel: string;
  aTarget: number;
  bTarget: number;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real pixel width, so text and bars keep their size at any width
  // instead of scaling with the viewBox.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(
      ([entry]) => entry && setWidth(Math.max(280, Math.round(entry.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const padL = 40;
  const padR = 8;
  const padT = 10;
  const padB = 34;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const y = (v: number) => padT + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
  const group = plotW / Math.max(1, data.length);
  const barW = Math.max(4, Math.min(28, (group - 14) / 2));
  const hovered = hover !== null ? data[hover] : undefined;
  // Under ~70px a bucket's two lines of text run into the next bucket's.
  const narrow = group < 70;
  // The tooltip is centered on its bucket but kept inside the chart, so it never runs off a phone screen.
  const tipX =
    hover === null ? 0 : Math.min(Math.max(padL + hover * group + group / 2, 90), Math.max(90, width - 90));

  return (
    <figure className="chart">
      <div className="legend">
        <span className="key">
          <i className="swatch s1" /> {aLabel}
        </span>
        <span className="key">
          <i className="swatch s2" /> {bLabel}
        </span>
        <span className="key muted">
          - - targets {aTarget}% / {bTarget}%
        </span>
      </div>
      <div className="chart-box" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label={`${aLabel} and ${bLabel} by bucket`}
        >
          {[0, 25, 50, 75, 100].map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text className="tick" x={padL - 6} y={y(t) + 3} textAnchor="end">
                {t}%
              </text>
            </g>
          ))}
          <line className="target t1" x1={padL} x2={width - padR} y1={y(aTarget)} y2={y(aTarget)} />
          <line className="target t2" x1={padL} x2={width - padR} y1={y(bTarget)} y2={y(bTarget)} />
          {data.map((d, i) => {
            const x0 = padL + i * group + group / 2 - barW - 1;
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect className="hit" x={padL + i * group} y={padT} width={group} height={plotH + padB} />
                {d.a !== null && <path className="bar s1" d={barPath(x0, y(d.a), barW, padT + plotH)} />}
                {d.b !== null && (
                  <path className="bar s2" d={barPath(x0 + barW + 2, y(d.b), barW, padT + plotH)} />
                )}
                <text className="tick" x={padL + i * group + group / 2} y={height - 18} textAnchor="middle">
                  {narrow ? (d.shortLabel ?? d.label) : d.label}
                </text>
                {d.sub && (
                  <text
                    className="tick faint"
                    x={padL + i * group + group / 2}
                    y={height - 5}
                    textAnchor="middle"
                  >
                    {narrow ? (d.shortSub ?? d.sub) : d.sub}
                  </text>
                )}
              </g>
            );
          })}
          <line className="axis" x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} />
        </svg>
        {hovered && (
          <div className="tooltip" style={{ left: `${(tipX / width) * 100}%` }}>
            <strong>{hovered.label}</strong>
            <span>
              <i className="swatch s1" /> {aLabel}: {hovered.a === null ? "–" : `${hovered.a.toFixed(1)}%`}
            </span>
            <span>
              <i className="swatch s2" /> {bLabel}: {hovered.b === null ? "–" : `${hovered.b.toFixed(1)}%`}
            </span>
            {hovered.sub && <span className="muted">{hovered.sub}</span>}
          </div>
        )}
      </div>
    </figure>
  );
}

export interface TrendPoint {
  label: string;
  a: number | null;
  b: number | null;
  /** Shown in the tooltip under the two values, e.g. the day's lift and call count. */
  sub?: string;
}

/**
 * Two rates over time as lines, for "is this moving": `a` is the series being judged (the feed's
 * 2x rate), `b` the yardstick it is judged against (the market's). The y-axis fits the data rather
 * than running to 100%, because the point is the gap between the lines and how it changes, not
 * the distance to a target - TargetBars does that.
 */
export function TrendLines({
  data,
  aLabel,
  bLabel,
  height = 180,
}: {
  data: TrendPoint[];
  aLabel: string;
  bLabel: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(
      ([entry]) => entry && setWidth(Math.max(280, Math.round(entry.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const padL = 40;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const values = data.flatMap((d) => [d.a, d.b]).filter((v): v is number => v !== null);
  // Headroom above the tallest point, on a 10% step so the ticks are round numbers.
  const top = Math.max(10, Math.ceil(((Math.max(0, ...values) || 0) * 1.15) / 10) * 10);
  const step = top <= 30 ? 10 : top <= 60 ? 20 : 25;
  const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
  const x = (i: number) => padL + (data.length <= 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v: number) => padT + plotH - (Math.min(top, Math.max(0, v)) / top) * plotH;
  const path = (pick: (d: TrendPoint) => number | null) => {
    let d = "";
    let pen = false;
    data.forEach((p, i) => {
      const v = pick(p);
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  // Label every point when they fit, else every nth, always the last.
  const every = Math.max(1, Math.ceil((data.length * 44) / Math.max(1, plotW)));
  const hovered = hover !== null ? data[hover] : undefined;
  const slot = data.length <= 1 ? plotW : plotW / (data.length - 1);
  const tipX = hover === null ? 0 : Math.min(Math.max(x(hover), 90), Math.max(90, width - 90));

  return (
    <figure className="chart">
      <div className="legend">
        <span className="key">
          <i className="swatch s1" /> {aLabel}
        </span>
        <span className="key">
          <i className="swatch s2" /> {bLabel}
        </span>
      </div>
      <div className="chart-box" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label={`${aLabel} and ${bLabel} over time`}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text className="tick" x={padL - 6} y={y(t) + 3} textAnchor="end">
                {t}%
              </text>
            </g>
          ))}
          <path className="line s2" d={path((d) => d.b)} />
          <path className="line s1" d={path((d) => d.a)} />
          {data.map((d, i) => (
            <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect className="hit" x={x(i) - slot / 2} y={padT} width={slot} height={plotH + padB} />
              {d.b !== null && <circle className="dot s2" cx={x(i)} cy={y(d.b)} r={hover === i ? 4 : 2.5} />}
              {d.a !== null && <circle className="dot s1" cx={x(i)} cy={y(d.a)} r={hover === i ? 4 : 2.5} />}
              {(i % every === 0 || i === data.length - 1) && (
                <text
                  className="tick"
                  x={x(i)}
                  y={height - 8}
                  textAnchor={i === data.length - 1 ? "end" : i === 0 ? "start" : "middle"}
                >
                  {d.label}
                </text>
              )}
            </g>
          ))}
          <line className="axis" x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} />
        </svg>
        {hovered && (
          <div className="tooltip" style={{ left: `${(tipX / width) * 100}%` }}>
            <strong>{hovered.label}</strong>
            <span>
              <i className="swatch s1" /> {aLabel}: {hovered.a === null ? "–" : `${hovered.a.toFixed(1)}%`}
            </span>
            <span>
              <i className="swatch s2" /> {bLabel}: {hovered.b === null ? "–" : `${hovered.b.toFixed(1)}%`}
            </span>
            {hovered.sub && <span className="muted">{hovered.sub}</span>}
          </div>
        )}
      </div>
    </figure>
  );
}

/** A bar whose top corners are rounded 4px and whose base sits square on the baseline. */
function barPath(x: number, top: number, w: number, base: number): string {
  const h = base - top;
  if (h <= 0) return "";
  const r = Math.min(4, w / 2, h);
  return `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${base} Z`;
}

/**
 * One hit rate against its target, as a ring: the arc is the measured rate, the notch is the
 * target. The verdict is spelled out under it in words, never left to color alone.
 */
export function RingGauge({
  label,
  value,
  target,
  graded,
  minGraded,
  series = 1,
}: {
  label: string;
  value: number | null;
  target: number;
  graded: number;
  minGraded: number;
  series?: 1 | 2;
}) {
  const enough = graded >= minGraded;
  const met = value !== null && value >= target;
  const state = !enough ? "early" : met ? "met" : "below";
  const r = 38;
  const c = 2 * Math.PI * r;
  const frac = Math.min(1, Math.max(0, (value ?? 0) / 100));
  // The notch sits on the ring at the target's angle, measured clockwise from 12 o'clock.
  const a = (target / 100) * 2 * Math.PI - Math.PI / 2;
  const notch = (rr: number) => [50 + rr * Math.cos(a), 50 + rr * Math.sin(a)] as const;
  const [x1, y1] = notch(r - 9);
  const [x2, y2] = notch(r + 9);
  return (
    <div className="ring">
      <svg
        viewBox="0 0 100 100"
        className="ring-svg"
        role="img"
        aria-label={`${label}: ${value === null ? "no data" : `${value.toFixed(0)}%`}, target ${target}%`}
      >
        <circle cx="50" cy="50" r={r} className="ring-track" />
        <circle
          cx="50"
          cy="50"
          r={r}
          className={`ring-arc s${series}`}
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 50 50)"
        />
        <line x1={x1} y1={y1} x2={x2} y2={y2} className="ring-notch" />
        <text x="50" y="49" className="ring-value" textAnchor="middle">
          {value === null ? "–" : `${value.toFixed(0)}%`}
        </text>
        <text x="50" y="63" className="ring-sub" textAnchor="middle">
          target {target}%
        </text>
      </svg>
      <div className="ring-text">
        <span className="ring-label">{label}</span>
        <span className={`state ${state}`}>
          {state === "early"
            ? `Early · ${graded}/${minGraded} graded`
            : met
              ? "✓ On target"
              : "▼ Below target"}
        </span>
      </div>
    </div>
  );
}

/** Placeholder blocks with a shimmer, shaped like what is loading. */
export function Skeleton({ lines = 3, height = 14 }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton-group" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} className="skeleton" style={{ height, width: `${100 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }: { count?: number }) {
  return (
    <div className="cards">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card card-skeleton">
          <div className="row gap-s">
            <span className="skeleton round" style={{ width: 40, height: 40 }} />
            <Skeleton lines={2} />
          </div>
          <Skeleton lines={3} height={18} />
        </div>
      ))}
    </div>
  );
}
