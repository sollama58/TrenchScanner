import { useState } from "react";
import { signedPct } from "../format";
import { PricingChangeMark } from "./PricingChangeMark";
import { offScale, perHourText, shareAt, type CutoffPoint } from "../cutoffCurve";
import { lineScale, tickIndices, tickTextWidth, tipCenter } from "../chartScale";
import { pickHandlers, pointerX, useChartWidth } from "./useChartWidth";

/**
 * Small hand-drawn charts. Colors come from CSS tokens (styles.css): --series-1 (blue) and
 * --series-2 (orange) in that fixed order; status colors are never used for series. The SVG
 * charts have a readout on hover or tap, the bar lists print each value on its row, and any
 * chart with two series has a legend.
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
          key={`${i}-${d.label}`}
          onPointerEnter={() => setHover(i)}
          onPointerDown={() => setHover(i)}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
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
  /** Too few calls to read: the bars are faded. */
  thin?: boolean;
  /** An extra tooltip line, e.g. the rate's interval. */
  note?: string;
  /** This bucket's own mark for `a`, drawn across its group (refLabel names it). */
  aRef?: number;
}

/**
 * Grouped vertical bars on a 0-100% scale with dashed target lines - for hit rates, where the
 * question is always "how far from the 75% / 50% line". `a` is the 2x series, `b` the 4x one.
 * With null targets and each bucket's own `aRef`, every bucket is judged against its own mark
 * instead (a calibration chart: did the calls given 30-40% odds double 35% of the time?).
 */
export function TargetBars({
  data,
  aLabel,
  bLabel,
  aTarget,
  bTarget,
  refLabel,
  height = 180,
}: {
  data: GroupDatum[];
  aLabel: string;
  bLabel: string;
  /** The goal lines across the chart; null leaves one off. */
  aTarget: number | null;
  bTarget: number | null;
  /** The legend's name for the buckets' own `aRef` marks. */
  refLabel?: string;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the container's real pixel width, so text and bars keep their size at any width
  // instead of scaling with the viewBox.
  const [boxRef, width] = useChartWidth();
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
  const tipX = hover === null ? 0 : tipCenter(padL + hover * group + group / 2, width);
  const pick = pickHandlers((e) => {
    const px = pointerX(e, width);
    if (data.length === 0 || px < padL || px > width - padR) return null;
    return Math.min(data.length - 1, Math.floor((px - padL) / group));
  }, setHover);
  const targets = [aTarget, bTarget].filter((t): t is number => t !== null);

  return (
    <figure className="chart">
      <div className="legend">
        <span className="key">
          <i className="swatch s1" /> {aLabel}
        </span>
        <span className="key">
          <i className="swatch s2" /> {bLabel}
        </span>
        {targets.length > 0 && (
          <span className="key muted">
            - - {targets.length > 1 ? "targets" : "target"} {targets.map((t) => `${t}%`).join(" / ")}
          </span>
        )}
        {refLabel && <span className="key muted">- - {refLabel}</span>}
      </div>
      <div className="chart-box" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label={`${aLabel} and ${bLabel} by bucket`}
          {...pick}
        >
          {[0, 25, 50, 75, 100].map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text className="tick" x={padL - 6} y={y(t) + 3} textAnchor="end">
                {t}%
              </text>
            </g>
          ))}
          {aTarget !== null && (
            <line className="target t1" x1={padL} x2={width - padR} y1={y(aTarget)} y2={y(aTarget)} />
          )}
          {bTarget !== null && (
            <line className="target t2" x1={padL} x2={width - padR} y1={y(bTarget)} y2={y(bTarget)} />
          )}
          {data.map((d, i) => {
            const x0 = padL + i * group + group / 2 - barW - 1;
            return (
              <g key={i}>
                <rect
                  className={`hit${hover === i ? " on" : ""}`}
                  x={padL + i * group}
                  y={padT}
                  width={group}
                  height={plotH + padB}
                />
                {d.a !== null && (
                  <path
                    className={`bar s1${d.thin ? " thin" : ""}`}
                    d={barPath(x0, y(d.a), barW, padT + plotH)}
                  />
                )}
                {d.b !== null && (
                  <path
                    className={`bar s2${d.thin ? " thin" : ""}`}
                    d={barPath(x0 + barW + 2, y(d.b), barW, padT + plotH)}
                  />
                )}
                {d.aRef !== undefined && (
                  <line
                    className="target t1"
                    x1={x0 - 3}
                    x2={x0 + 2 * barW + 5}
                    y1={y(d.aRef)}
                    y2={y(d.aRef)}
                  />
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
              {hovered.aRef !== undefined && refLabel ? ` (${refLabel} ${hovered.aRef.toFixed(0)}%)` : ""}
            </span>
            <span>
              <i className="swatch s2" /> {bLabel}: {hovered.b === null ? "–" : `${hovered.b.toFixed(1)}%`}
            </span>
            {hovered.sub && <span className="muted">{hovered.sub}</span>}
            {hovered.note && <span className="muted">{hovered.note}</span>}
          </div>
        )}
      </div>
    </figure>
  );
}

export interface LineSeries {
  key: string;
  label: string;
  /** Its CSS class: s1..s5 for the categorical slots, "ref" for the market, "all" for the pooled line. */
  tone: string;
  /** One value per label, oldest first; null leaves a gap. */
  values: (number | null)[];
}

/**
 * Several rates over the same days as lines: up to five picked series in the categorical slots
 * plus the yardsticks ("ref" dashed, "all" in ink). The y-axis fits the data rather
 * than running to 100%, because the point is the gap between the lines and how it changes.
 */
export function MultiLines({
  labels,
  series,
  height = 220,
  signed = false,
  subs,
  pricingChange = null,
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  signed?: boolean;
  /** Shown in the tooltip under the values, one per label. */
  subs?: string[];
  /** Where pricing changed, in points from the first (pricingChangePoint); null when off-axis. */
  pricingChange?: number | null;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, width] = useChartWidth();
  const padL = 40;
  const padR = 12;
  const padT = 10;
  const padB = 26;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const values = series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const { top, bottom, ticks } = lineScale(values, signed);
  const n = labels.length;
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) =>
    padT + plotH - ((Math.min(top, Math.max(bottom, v)) - bottom) / (top - bottom)) * plotH;
  const fmt = (v: number | null) => (v === null ? "–" : signed ? signedPct(v, 1) : `${v.toFixed(1)}%`);
  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const slot = n <= 1 ? plotW : plotW / (n - 1);
  // Labels only where they fit, the last always: it is the newest day.
  const tickAt = new Set(tickIndices(n, slot, Math.max(30, ...labels.map((l) => tickTextWidth(l)))));
  const tipX = hover === null ? 0 : tipCenter(x(hover), width);
  const pick = pickHandlers((e) => {
    if (n === 0) return null;
    const i = n <= 1 ? 0 : Math.round((pointerX(e, width) - padL) / slot);
    return Math.min(n - 1, Math.max(0, i));
  }, setHover);
  // Yardsticks first so the picked models draw over them.
  const drawn = [...series].sort((a, b) => Number(/^s\d$/.test(a.tone)) - Number(/^s\d$/.test(b.tone)));

  return (
    <figure className="chart">
      <div className="legend">
        {series.map((s) => (
          <span className="key" key={s.key}>
            <i className={`swatch ${s.tone}`} /> {s.label}
          </span>
        ))}
      </div>
      <div className="chart-box" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label={`${series.map((s) => s.label).join(", ")} by day`}
          {...pick}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} />
              <text className="tick" x={padL - 6} y={y(t) + 3} textAnchor="end">
                {signed && t > 0 ? "+" : ""}
                {t}%
              </text>
            </g>
          ))}
          {pricingChange !== null && n > 1 && (
            <PricingChangeMark x={x(pricingChange)} top={padT} bottom={padT + plotH} width={width} />
          )}
          {drawn.map((s) => (
            <path key={s.key} className={`line ${s.tone}`} d={path(s.values)} />
          ))}
          {labels.map((label, i) => (
            <g key={i}>
              <rect
                className={`hit${hover === i ? " on" : ""}`}
                x={x(i) - slot / 2}
                y={padT}
                width={slot}
                height={plotH + padB}
              />
              {drawn.map((s) => {
                const v = s.values[i] ?? null;
                return v === null ? null : (
                  <circle
                    key={s.key}
                    className={`dot ${s.tone}`}
                    cx={x(i)}
                    cy={y(v)}
                    r={hover === i ? 4 : 2.5}
                  />
                );
              })}
              {tickAt.has(i) && (
                <text
                  className="tick"
                  x={x(i)}
                  y={height - 8}
                  textAnchor={i === n - 1 ? "end" : i === 0 ? "start" : "middle"}
                >
                  {label}
                </text>
              )}
            </g>
          ))}
          <line className="axis" x1={padL} x2={width - padR} y1={y(0)} y2={y(0)} />
        </svg>
        {hover !== null && (
          <div className="tooltip" style={{ left: `${(tipX / width) * 100}%` }}>
            <strong>{labels[hover]}</strong>
            {series.map((s) => (
              <span key={s.key}>
                <i className={`swatch ${s.tone}`} /> {s.label}: {fmt(s.values[hover] ?? null)}
              </span>
            ))}
            {subs?.[hover] && <span className="muted">{subs[hover]}</span>}
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

export interface MarkerBarDatum {
  id: string;
  label: string;
  /** The rate in percent; null draws an empty track ("–"). */
  value: number | null;
  /** Shown at the end of the row; defaults to the value as a percent. */
  display?: string;
  /** A second, smaller line under the value, e.g. the rate's lift over the baseline. */
  note?: string;
  /** Colors the note: "up" for a gain, "down" for a loss. */
  noteTone?: "up" | "down";
  /** Under the label, e.g. how many graded calls the rate rests on. */
  sub?: string;
  /** Drawn dimmer: a rate on too few calls to lean on. */
  thin?: boolean;
  /** Draws the bar as a loss: the value is then the loss's size. */
  down?: boolean;
  /** Highlights the row with a small tag after its label, e.g. the model worth adding to a feed. */
  badge?: { text: string; title?: string };
  /** A small switch before the row (e.g. this model's calls in your live feed), outside the row's button. */
  toggle?: { on: boolean; disabled?: boolean; title: string; label: string; onChange: () => void };
}

export interface BarMarker {
  label: string;
  value: number;
  /** "base" is the yardstick the bars are judged against, "goal" the target. */
  kind: "base" | "goal";
}

/**
 * Horizontal bars on a percent scale with vertical marker lines through every row - for "how far
 * above the yardstick is each of these". Rows are buttons: hovering or focusing one picks it, and
 * the caller shows the picked row's detail; with `onOpen`, a click opens the row (a chevron says so).
 */
export function MarkerBars({
  data,
  markers,
  selected,
  onSelect,
  onOpen,
  columns,
  legend = "Hit rate",
}: {
  data: MarkerBarDatum[];
  markers: BarMarker[];
  selected: string | null;
  onSelect: (id: string) => void;
  onOpen?: (id: string) => void;
  /** Headings over the label and value columns. */
  columns?: { label: string; value: string; note?: string };
  /** The bars' legend key. */
  legend?: string;
}) {
  const values = [...data.map((d) => d.value ?? 0), ...markers.map((m) => m.value)];
  // Headroom past the furthest bar or marker, on a 10% step, never past 100%.
  const top = Math.min(100, Math.max(10, Math.ceil((Math.max(0, ...values) * 1.12) / 10) * 10));
  const at = (v: number) => `${(Math.min(top, Math.max(0, v)) / top) * 100}%`;
  const toggles = data.some((d) => d.toggle);
  // Two marker tags closer than about a tag's width would print over each other: the lower one
  // then reads leftwards from its line and the higher one rightwards.
  const [lowM, highM] = [...markers].sort((a, b) => a.value - b.value);
  const close =
    markers.length === 2 && lowM && highM && ((highM.value - lowM.value) / top) * 100 < 14 ? lowM.kind : null;
  const nudge = (m: BarMarker) => (close === null ? "" : m.kind === close ? " nudge-l" : " nudge-r");
  return (
    <figure className="chart">
      <div className="legend">
        <span className="key">
          <i className="swatch s1" /> {legend}
        </span>
        {markers.map((m) => (
          <span className="key" key={m.kind}>
            <i className={`marker-key ${m.kind}`} /> {m.label}
          </span>
        ))}
        {/* The scale follows the data, so say where the track ends: a full bar is this, not 100%. */}
        <span className="key muted">Track 0–{top}%</span>
      </div>
      <div className={`mbar${onOpen ? " opens" : ""}${toggles ? " toggles" : ""}`}>
        {columns && (
          <div className="mbar-row head-row" aria-hidden="true">
            <span>{columns.label}</span>
            <span />
            <span className="mbar-value">
              {columns.value}
              {columns.note && <small>{columns.note}</small>}
            </span>
            {onOpen && <span />}
          </div>
        )}
        {data.map((d) => {
          const row = (
            <button
              type="button"
              className={`mbar-row${selected === d.id ? " on" : ""}${d.thin ? " thin" : ""}${d.badge ? " badged" : ""}`}
              key={d.id}
              onMouseEnter={() => onSelect(d.id)}
              onFocus={() => onSelect(d.id)}
              onClick={() => {
                onSelect(d.id);
                onOpen?.(d.id);
              }}
              aria-pressed={onOpen ? undefined : selected === d.id}
              aria-haspopup={onOpen ? "dialog" : undefined}
            >
              <span className="mbar-label">
                {d.label}
                {d.badge && (
                  <span className="mbar-badge" title={d.badge.title}>
                    {d.badge.text}
                  </span>
                )}
                {d.sub && <small>{d.sub}</small>}
              </span>
              <span className="mbar-track">
                {d.value !== null && (
                  <span className={`mbar-fill${d.down ? " down" : ""}`} style={{ width: at(d.value) }} />
                )}
                {markers.map((m) => (
                  <i key={m.kind} className={`mbar-marker ${m.kind}`} style={{ left: at(m.value) }} />
                ))}
              </span>
              <span className="mbar-value num">
                {d.display ?? (d.value === null ? "–" : `${d.value.toFixed(1)}%`)}
                {d.note && <small className={d.noteTone}>{d.note}</small>}
              </span>
              {onOpen && (
                <span className="mbar-open" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    width="14"
                    height="14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </span>
              )}
            </button>
          );
          if (!toggles) return row;
          const tg = d.toggle;
          return (
            <div className="mbar-line" key={d.id}>
              {tg ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={tg.on}
                  aria-label={tg.label}
                  title={tg.title}
                  className={`switch mini${tg.on ? " on" : ""}`}
                  disabled={tg.disabled}
                  onClick={tg.onChange}
                >
                  <span className="switch-track">
                    <span className="switch-thumb" />
                  </span>
                </button>
              ) : (
                <span className="mbar-switch-gap" />
              )}
              {row}
            </div>
          );
        })}
        <div className="mbar-row axis-row" aria-hidden="true">
          <span />
          <span className="mbar-track bare">
            {markers.map((m) => (
              <span key={m.kind} className={`mbar-tag ${m.kind}${nudge(m)}`} style={{ left: at(m.value) }}>
                {m.value.toFixed(1)}%
              </span>
            ))}
          </span>
          <span />
          {onOpen && <span />}
        </div>
      </div>
    </figure>
  );
}

/**
 * The cutoff curve: hit rate (2x, 4x) against how picky the cutoff is, on a log axis of the share
 * of decision moments called, with what each cutoff would send per hour under it and the live
 * cutoff marked.
 */
export function CutoffCurve({
  points,
  aTarget,
  bTarget,
  live,
  height = 220,
}: {
  points: CutoffPoint[];
  aTarget: number;
  bTarget: number;
  /** The live cutoff: the share it calls, and what it sent per hour over the last day. */
  live: { sharePct: number; perHour: number | null } | null;
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [boxRef, width] = useChartWidth();
  const padL = 40;
  const padR = 22;
  const padT = 24;
  const padB = 38;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const x = (share: number) => padL + shareAt(share) * plotW;
  const y = (v: number) => padT + plotH - (Math.min(100, Math.max(0, v)) / 100) * plotH;
  const narrow = plotW < 420;
  const line = (key: "winRatePct" | "goalRatePct") =>
    points.map((p, i) => `${i ? "L" : "M"}${x(p.sharePct).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  // Each point's hover band runs halfway to its neighbours.
  const edges = points.map((p) => x(p.sharePct));
  const band = (i: number) => {
    const left = i === 0 ? padL : (edges[i - 1]! + edges[i]!) / 2;
    const right = i === edges.length - 1 ? width - padR : (edges[i]! + edges[i + 1]!) / 2;
    return { left, w: right - left };
  };
  const hovered = hover !== null ? points[hover] : undefined;
  const tipX = hovered ? tipCenter(x(hovered.sharePct), width) : 0;
  const pick = pickHandlers((e) => {
    const px = pointerX(e, width);
    const i = edges.findIndex((_, j) => {
      const b = band(j);
      return px >= b.left && px < b.left + b.w;
    });
    return i < 0 ? null : i;
  }, setHover);
  const liveX = live ? x(live.sharePct) : null;
  // A live cutoff outside the curve's 1-50% is pinned to the edge it ran past with an arrow
  // pointing off the scale and a dotted line, rather than drawn as if it sat on the end slice.
  const liveOff = live ? offScale(live.sharePct) : null;
  const flip = liveX !== null && liveX > width - 130;

  return (
    <figure className="chart">
      <div className="legend">
        <span className="key">
          <i className="swatch s1" /> Doubled (2x)
        </span>
        <span className="key">
          <i className="swatch s2" /> Reached 4x
        </span>
        <span className="key muted">
          - - targets {aTarget}% / {bTarget}%
        </span>
        {live && (
          <span className="key">
            <i className="marker-key live" /> Live cutoff
          </span>
        )}
      </div>
      <div className="chart-box" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          height={height}
          role="img"
          aria-label="2x and 4x hit rate at each cutoff, by share of decision moments flagged"
          {...pick}
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
          {liveX !== null && live && (
            <g className={`cutoff-live${liveOff ? " off" : ""}`}>
              <line x1={liveX} x2={liveX} y1={padT - 6} y2={padT + plotH} />
              <text x={flip ? liveX - 5 : liveX + 5} y={padT - 10} textAnchor={flip ? "end" : "start"}>
                {liveOff === "below" ? "◀ " : ""}
                Live: top {live.sharePct < 10 ? live.sharePct.toFixed(1) : Math.round(live.sharePct)}%
                {live.perHour !== null ? `, ${perHourText(live.perHour)}` : ""}
                {liveOff === "above" ? " ▶" : ""}
              </text>
            </g>
          )}
          <path className="line s1" d={line("winRatePct")} />
          <path className="line s2" d={line("goalRatePct")} />
          {points.map((p, i) => {
            const b = band(i);
            const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
            return (
              <g key={i}>
                <rect
                  className={`hit${hover === i ? " on" : ""}`}
                  x={b.left}
                  y={padT}
                  width={b.w}
                  height={plotH + padB}
                />
                <circle
                  className="dot s1"
                  cx={x(p.sharePct)}
                  cy={y(p.winRatePct)}
                  r={hover === i ? 4.5 : 3}
                />
                <circle
                  className="dot s2"
                  cx={x(p.sharePct)}
                  cy={y(p.goalRatePct)}
                  r={hover === i ? 4.5 : 3}
                />
                <text className="tick" x={x(p.sharePct)} y={height - 20} textAnchor={anchor}>
                  {narrow ? `${p.sharePct}%` : `Top ${p.sharePct}%`}
                </text>
                <text className="tick faint" x={x(p.sharePct)} y={height - 6} textAnchor={anchor}>
                  {perHourText(p.perHour)}
                </text>
              </g>
            );
          })}
          <line className="axis" x1={padL} x2={width - padR} y1={padT + plotH} y2={padT + plotH} />
        </svg>
        {hovered && (
          <div className="tooltip" style={{ left: `${(tipX / width) * 100}%` }}>
            <strong>Top {hovered.sharePct}% of moments</strong>
            <span>
              <i className="swatch s1" /> Doubled (2x): {hovered.winRatePct.toFixed(1)}%
            </span>
            <span>
              <i className="swatch s2" /> Reached 4x: {hovered.goalRatePct.toFixed(1)}%
            </span>
            <span className="muted">
              {hovered.calls.toLocaleString()} exam alerts
              {hovered.perHour !== null ? ` · about ${perHourText(hovered.perHour)} live` : ""}
            </span>
          </div>
        )}
      </div>
    </figure>
  );
}
