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
                  {d.label}
                </text>
                {d.sub && (
                  <text
                    className="tick faint"
                    x={padL + i * group + group / 2}
                    y={height - 5}
                    textAnchor="middle"
                  >
                    {d.sub}
                  </text>
                )}
              </g>
            );
          })}
          <line className="axis" x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} />
        </svg>
        {hovered && (
          <div
            className="tooltip"
            style={{ left: `${((padL + hover! * group + group / 2) / width) * 100}%` }}
          >
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
 * One rate against its target: the bar is the measured rate, the tick is the target. Status is
 * spelled out in words beside it, never left to color alone.
 */
export function TargetMeter({
  label,
  value,
  target,
  graded,
  minGraded,
}: {
  label: string;
  value: number | null;
  target: number;
  graded: number;
  minGraded: number;
}) {
  const enough = graded >= minGraded;
  const met = value !== null && value >= target;
  const state = !enough ? "early" : met ? "met" : "below";
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <span className="meter-value">{value === null ? "–" : `${value.toFixed(0)}%`}</span>
      </div>
      <div className="meter-track">
        <span className={`meter-fill ${state}`} style={{ width: `${Math.min(100, value ?? 0)}%` }} />
        <span className="meter-target" style={{ left: `${target}%` }} title={`Target ${target}%`} />
      </div>
      <div className="meter-foot">
        <span>target {target}%</span>
        <span className={`state ${state}`}>
          {state === "early"
            ? `early: ${graded}/${minGraded} graded`
            : met
              ? "✓ on target"
              : "▼ below target"}
        </span>
      </div>
    </div>
  );
}
