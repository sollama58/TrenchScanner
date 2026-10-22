import { useState } from "react";
import { niceScale, scaleTicks } from "../chartScale";
import { hasNumber, lineSegments, type BarRow, type LinePoint } from "../tabs/adminModelsView";
import { pickHandlers, pointerX, useChartWidth } from "./useChartWidth";

/**
 * Admin charts. One or two series, named in the legend. A missing point is a gap.
 * Strokes are the dashboard's first series color and a dashed neutral, not a color per model.
 */

const fmt = (v: number) => {
  const abs = Math.abs(v);
  const text = abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
  return text.replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
};

export function AdminBars({
  label,
  rows,
  empty,
  formatValue = fmt,
}: {
  label: string;
  rows: readonly BarRow[];
  empty: string;
  formatValue?: (value: number) => string;
}) {
  const present = rows.filter((r) => r.value !== null && Number.isFinite(r.value));
  if (present.length === 0) return <p className="muted small">{empty}</p>;
  const lo = Math.min(0, ...present.map((r) => r.value!));
  const hi = Math.max(0, ...present.map((r) => r.value!));
  const span = Math.max(hi - lo, 1e-9);
  return (
    <div className="admin-bars" role="img" aria-label={label}>
      {rows.map((r, i) => {
        const v = r.value;
        const known = v !== null && Number.isFinite(v);
        const width = known ? `${Math.max(v === 0 ? 0 : 1.5, (Math.abs(v!) / span) * 100)}%` : "0%";
        return (
          <div className="admin-bar" key={`${i}-${r.label}`}>
            <span className="admin-bar-name">{r.label}</span>
            <span className="admin-bar-track">
              {known && v! < 0 ? (
                <span className="admin-bar-fill neg" style={{ width }} />
              ) : (
                <span className="admin-bar-fill" style={{ width: known && v! > 0 ? width : "0%" }} />
              )}
            </span>
            <span className="num admin-bar-value">{known ? formatValue(v!) : "–"}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AdminLines({
  label,
  points,
  names,
  empty,
}: {
  label: string;
  points: readonly LinePoint[];
  names: readonly string[];
  empty: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, width] = useChartWidth(640);
  const series = names.map((_, s) => points.map((p) => p.values[s] ?? null));
  if (points.length === 0 || !series.some(hasNumber)) return <p className="muted small">{empty}</p>;

  const height = 200;
  const percent = names.every((name) => name.includes("%"));
  const pad = { l: percent ? 52 : 44, r: 12, t: 12, b: 28 };
  const plotW = Math.max(10, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const finite = series.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  const scale = niceScale(Math.min(0, ...finite), Math.max(...finite) * 1.08 || 1, 4);
  const ticks = scaleTicks(scale);
  const y = (v: number) => {
    const span = scale.max - scale.min || 1;
    return pad.t + plotH - ((v - scale.min) / span) * plotH;
  };
  const x = (i: number) => pad.l + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const tickAt =
    points.length <= 6
      ? points.map((_, i) => i)
      : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const pick = pickHandlers((e) => {
    if (points.length <= 1) return 0;
    const px = pointerX(e, width);
    if (px < pad.l || px > width - pad.r) return null;
    const i = Math.round(((px - pad.l) / plotW) * (points.length - 1));
    return Math.max(0, Math.min(points.length - 1, i));
  }, setHover);
  const shown = hover !== null && hover < points.length ? points[hover] : null;

  return (
    <div className="admin-chart">
      <div ref={boxRef}>
        <svg viewBox={`0 0 ${width} ${height}`} height={height} role="img" aria-label={label} {...pick}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.l - 6} y={y(t) + 4} className="chart-tick" textAnchor="end">
                {percent ? `${fmt(t)}%` : fmt(t)}
              </text>
            </g>
          ))}
          {tickAt.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 8}
              className="chart-tick"
              textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            >
              {points[i]!.label}
            </text>
          ))}
          {series.map((values, s) =>
            lineSegments(values).map((seg, k) =>
              seg.length === 1 ? (
                <circle
                  key={`${s}-${k}`}
                  cx={x(seg[0]!.i)}
                  cy={y(seg[0]!.v)}
                  r={3}
                  className={s === 0 ? "chart-line" : "chart-line alt"}
                />
              ) : (
                <path
                  key={`${s}-${k}`}
                  d={seg.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.i)},${y(p.v)}`).join(" ")}
                  className={s === 0 ? "chart-line" : "chart-line alt"}
                />
              ),
            ),
          )}
          {shown && hover !== null && (
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} className="chart-mark" />
          )}
        </svg>
      </div>
      <p className="admin-legend small">
        {names.map((name, s) => (
          <span key={name}>
            <i className={s === 0 ? "legend-swatch" : "legend-swatch alt"} /> {name}
          </span>
        ))}
      </p>
      <p className="faint small model-readout">
        {shown
          ? `${shown.label}: ${names.map((name, s) => `${name} ${shown.values[s] === null || shown.values[s] === undefined ? "–" : fmt(shown.values[s]!)}`).join(" · ")}`
          : "Hover or tap for a point."}
      </p>
    </div>
  );
}
