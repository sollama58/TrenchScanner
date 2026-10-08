import { useEffect, useRef, useState } from "react";
import type { Series, Unit } from "../lighthouseMetrics";

/**
 * The Lighthouse tab's chart: up to five series over the same buckets as lines, grouped bars or
 * stacked bars. Rates, counts and returns each have their own scale; a chart carries one on the
 * left axis and, when a second is needed, one on the right. Colors are the categorical slots
 * --series-1..5 through the lh-s1..5 classes (lh-other for the neutral remainder), and every
 * series is named in the legend and the readout, never by color alone.
 */

export interface TrendChartProps {
  /** Tick labels and readout labels, one per bucket. */
  labels: { short: string; full: string }[];
  series: Series[];
  kind: "line" | "bars" | "stacked";
  height?: number;
  /** Buckets whose readout should say they are still filling (the current one). */
  partialLast?: boolean;
}

/** A readable number: counts whole, rates to a decimal, with the unit's sign and suffix. */
export function fmt(v: number | null, unit: Unit): string {
  if (v === null) return "–";
  if (unit === "count") return Math.round(v).toLocaleString();
  const s = `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;
  return unit === "ret" && v > 0 ? `+${s}` : s;
}

/** Round axis bounds and ticks around the data: a step of 1, 2, 2.5 or 5 times a power of ten. */
export function niceScale(lo: number, hi: number, ticks = 4): { min: number; max: number; step: number } {
  if (hi <= lo) hi = lo + 1;
  const raw = (hi - lo) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { min: Math.floor(lo / step) * step, max: Math.ceil(hi / step) * step, step };
}

const cls = (slot: number) => (slot === 0 ? "lh-other" : `lh-s${slot}`);

export function TrendChart({ labels, series, kind, height = 220, partialLast = false }: TrendChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(
      ([entry]) => entry && setWidth(Math.max(280, Math.round(entry.contentRect.width))),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = labels.length;
  const units: Unit[] = [];
  for (const s of series) if (!units.includes(s.unit)) units.push(s.unit);
  const left = units[0] ?? "count";
  const right = units[1];
  const padL = 44;
  const padR = right ? 44 : 10;
  const padT = 12;
  const padB = 28;
  const plotW = Math.max(10, width - padL - padR);
  const plotH = height - padT - padB;

  // One scale per unit, fitted to the data (plus any goal line); rates never go below zero, and
  // a stack's scale is the stack's height.
  const scaleFor = (unit: Unit) => {
    let lo = 0;
    let hi = 0;
    for (const s of series) {
      if (s.unit !== unit) continue;
      if (s.target !== undefined) hi = Math.max(hi, s.target);
    }
    if (kind === "stacked") {
      for (let i = 0; i < n; i++) {
        let tot = 0;
        for (const s of series) if (s.unit === unit) tot += Math.max(0, s.values[i] ?? 0);
        hi = Math.max(hi, tot);
      }
    } else {
      for (const s of series) {
        if (s.unit !== unit) continue;
        for (const v of s.values) {
          if (v === null) continue;
          hi = Math.max(hi, v);
          lo = Math.min(lo, v);
        }
      }
    }
    const nice = niceScale(lo, hi * 1.08 || 1);
    return { ...nice, max: unit === "pct" ? Math.min(100, Math.max(nice.max, nice.step)) : nice.max };
  };
  // The left axis always has a scale, even with no series (an empty breakdown), so the axis can draw.
  const scales = new Map<Unit, ReturnType<typeof scaleFor>>(
    (units.length ? units : [left]).map((u) => [u, scaleFor(u)]),
  );
  const y = (v: number, unit: Unit) => {
    const sc = scales.get(unit)!;
    const span = sc.max - sc.min || 1;
    return padT + plotH - ((Math.min(sc.max, Math.max(sc.min, v)) - sc.min) / span) * plotH;
  };
  const slot = plotW / Math.max(1, n);
  const xMid = (i: number) => padL + i * slot + slot / 2;
  const ticksFor = (unit: Unit) => {
    const sc = scales.get(unit)!;
    const out: number[] = [];
    for (let t = sc.min; t <= sc.max + sc.step / 1e6; t += sc.step) out.push(Number(t.toFixed(6)));
    return out;
  };

  const barGroups = kind === "bars" ? series.length : 1;
  const barW = Math.max(2, Math.min(26, (slot * 0.72) / barGroups));
  const every = Math.max(1, Math.ceil((n * 52) / Math.max(1, plotW)));
  const hovered = hover !== null && hover < n ? hover : null;
  const tipX = hovered === null ? 0 : Math.min(Math.max(xMid(hovered), 110), Math.max(110, width - 110));
  const empty = series.length === 0 || series.every((s) => s.values.every((v) => v === null));

  const linePath = (s: Series) => {
    let d = "";
    let pen = false;
    s.values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xMid(i).toFixed(1)},${y(v, s.unit).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <figure className="chart lht">
      <div className="legend">
        {series.map((s) => (
          <span className="key" key={s.id}>
            <i className={`lh-swatch ${cls(s.slot)}`} /> {s.label}
            {right && <span className="faint"> ({s.unit === left ? "left" : "right"})</span>}
          </span>
        ))}
        {series.some((s) => s.target !== undefined) && <span className="key muted">- - goal</span>}
      </div>
      <div className="chart-box" ref={boxRef}>
        {empty && <p className="lht-empty muted small">Nothing to draw in this window yet.</p>}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label={series.map((s) => s.label).join(", ")}
        >
          {ticksFor(left).map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={width - padR} y1={y(t, left)} y2={y(t, left)} />
              <text className="tick" x={padL - 6} y={y(t, left) + 3} textAnchor="end">
                {fmt(t, left === "ret" ? "pct" : left)}
              </text>
            </g>
          ))}
          {right &&
            ticksFor(right).map((t) => (
              <text key={t} className="tick" x={width - padR + 6} y={y(t, right) + 3} textAnchor="start">
                {fmt(t, right === "ret" ? "pct" : right)}
              </text>
            ))}
          {scales.get(left)!.min < 0 && (
            <line className="axis" x1={padL} x2={width - padR} y1={y(0, left)} y2={y(0, left)} />
          )}
          {series.map((s) =>
            s.target !== undefined ? (
              <line
                key={`t-${s.id}`}
                className={`lht-goal ${cls(s.slot)}`}
                x1={padL}
                x2={width - padR}
                y1={y(s.target, s.unit)}
                y2={y(s.target, s.unit)}
              />
            ) : null,
          )}
          {kind === "line" &&
            series.map((s) => <path key={s.id} className={`lht-line ${cls(s.slot)}`} d={linePath(s)} />)}
          {labels.map((_, i) => {
            const stackBase = new Map<Unit, number>();
            return (
              <g
                key={i}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setHover(i)}
              >
                <rect className="hit" x={padL + i * slot} y={padT} width={slot} height={plotH + padB} />
                {kind === "bars" &&
                  series.map((s, j) => {
                    const v = s.values[i];
                    if (v === null || v === undefined) return null;
                    const x0 = xMid(i) - (barGroups * barW) / 2 + j * barW;
                    const y0 = y(Math.max(0, v), s.unit);
                    const y1 = y(Math.min(0, v), s.unit);
                    return (
                      <rect
                        key={s.id}
                        className={`lht-bar ${cls(s.slot)}`}
                        x={x0 + 0.5}
                        y={y0}
                        width={Math.max(1, barW - 1)}
                        height={Math.max(0.5, y1 - y0)}
                      />
                    );
                  })}
                {kind === "stacked" &&
                  series.map((s) => {
                    const v = Math.max(0, s.values[i] ?? 0);
                    if (v === 0) return null;
                    const base = stackBase.get(s.unit) ?? 0;
                    stackBase.set(s.unit, base + v);
                    const yTop = y(base + v, s.unit);
                    const yBot = y(base, s.unit);
                    return (
                      <rect
                        key={s.id}
                        className={`lht-bar ${cls(s.slot)}`}
                        x={xMid(i) - barW / 2}
                        y={yTop}
                        width={barW}
                        height={Math.max(0.5, yBot - yTop)}
                      />
                    );
                  })}
                {kind === "line" &&
                  series.map((s) => {
                    const v = s.values[i];
                    return v === null || v === undefined ? null : (
                      <circle
                        key={s.id}
                        className={`lht-dot ${cls(s.slot)}`}
                        cx={xMid(i)}
                        cy={y(v, s.unit)}
                        r={hovered === i ? 4 : n > 60 ? 0 : 2.5}
                      />
                    );
                  })}
                {(i === n - 1 || (i % every === 0 && (n - 1 - i) * slot >= 48)) && (
                  <text
                    className="tick"
                    x={xMid(i)}
                    y={height - 8}
                    textAnchor={i === n - 1 && n > 1 ? "end" : i === 0 ? "start" : "middle"}
                  >
                    {labels[i]!.short}
                  </text>
                )}
              </g>
            );
          })}
          <line className="axis" x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} />
        </svg>
        {hovered !== null && (
          <div className="tooltip" style={{ left: `${(tipX / width) * 100}%` }}>
            <strong>
              {labels[hovered]!.full}
              {partialLast && hovered === n - 1 ? " · still filling" : ""}
            </strong>
            {series.map((s) => (
              <span key={s.id}>
                <i className={`lh-swatch ${cls(s.slot)}`} /> {s.label}:{" "}
                {fmt(s.values[hovered] ?? null, s.unit)}
              </span>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}
