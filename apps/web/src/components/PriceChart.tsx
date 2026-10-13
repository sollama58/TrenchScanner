import { useEffect, useId, useMemo, useRef, useState } from "react";
import { change, shortAddress, signedPct, usd } from "../format";
import {
  groupMarkers,
  mcapAxis,
  timeLabel,
  type MarkerGroup,
  type MarkerTrade,
  type Point,
} from "../priceChart";

/** A moment marked on the time axis: an alert or a model's call. */
export interface ChartEvent {
  t: number;
  label: string;
  /** Market cap at the moment, when known (the readout shows the move since). */
  mcap?: number | null;
}

const PAD = { l: 8, r: 62, t: 24, b: 24 };

/** What each marker kind is called in its readout. */
export const MARKER_LABEL: Record<MarkerTrade["kind"], string> = {
  dev: "Dev",
  risky: "Risky wallet",
  linked: "Linked wallet",
};

/** A marker's size: bigger for more SOL, within a few pixels so a whale doesn't hide the line. */
function markerSize(sol: number): number {
  return 4.5 + Math.min(4, Math.sqrt(Math.max(0, sol)) * 1.5);
}

/** A triangle pointing up (a buy, under the line) or down (a sell, over it), centred on (x, y). */
function triangle(x: number, y: number, r: number, up: boolean): string {
  const h = r * 1.15;
  return up
    ? `M${x},${y - h} L${x + r},${y + h * 0.75} L${x - r},${y + h * 0.75} Z`
    : `M${x},${y + h} L${x + r},${y - h * 0.75} L${x - r},${y - h * 0.75} Z`;
}

/**
 * The token modal's market-cap chart: one line, green above its baseline and red below it, with
 * the area between them shaded. The baseline is the alert's market cap while the alert is in view,
 * else where the view starts, so the colour always answers "up or down since then?". Sized to its
 * box in real pixels (a ResizeObserver), so text stays crisp at any width. Hover (or drag on a touch
 * screen) reads one point out.
 */
export function PriceChart({
  points,
  stepMs,
  events,
  markers = [],
  height,
  ariaLabel,
}: {
  points: Point[];
  /** The spacing the points were thinned to; scan readings, which come unevenly, estimate their own. */
  stepMs?: number;
  events: ChartEvent[];
  /** Flagged wallets' trades, drawn as triangles: buys under the line, sells over it. */
  markers?: MarkerTrade[];
  height: number;
  ariaLabel: string;
}) {
  const id = useId().replace(/:/g, "");
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [hoverMark, setHoverMark] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t;
    const step = stepMs ?? Math.max(1, (t1 - t0) / (points.length - 1));
    const plotW = width - PAD.l - PAD.r;
    const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
    const lead = events[0];
    const leadShown = lead !== undefined && lead.t >= t0 && lead.t <= t1;
    const base = leadShown && lead.mcap ? lead.mcap : points[0]!.v;
    const values = points.map((p) => p.v);
    const lo = Math.min(...values, base);
    const hi = Math.max(...values, base);
    const axis = mcapAxis(lo, hi, PAD.t, height - PAD.b);
    const hiIdx = points.reduce((best, p, i) => (p.v > points[best]!.v ? i : best), 0);
    return { t0, t1, step, x, axis, base, fromAlert: leadShown && !!lead.mcap, hiIdx };
  }, [points, stepMs, width, height, events]);

  const groups = useMemo(() => (geo ? groupMarkers(points, geo.step, markers) : []), [points, geo, markers]);

  if (!geo) return null;
  const { x, axis } = geo;
  const span = geo.t1 - geo.t0;
  const bottom = height - PAD.b;
  const px = (p: Point) => x(p.t);
  const py = (p: Point) => axis.y(p.v);
  const line = points.map((p, i) => `${i ? "L" : "M"}${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(" ");
  const baseY = axis.y(geo.base);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const area = `${line} L${px(last).toFixed(1)},${baseY.toFixed(1)} L${px(first).toFixed(1)},${baseY.toFixed(1)} Z`;
  // Where the baseline falls in the plot's height, for the colour split of the line and the area.
  const split = Math.min(1, Math.max(0, (baseY - PAD.t) / (bottom - PAD.t)));
  const up = last.v >= geo.base;
  const lastY = py(last);
  const shown = events.filter((e) => e.t >= geo.t0 && e.t <= geo.t1);
  const lead = shown[0];
  // Five time labels on a desktop, three on a phone, where five would run into each other.
  const fractions = width < 520 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const timeTicks = fractions.map((f) => geo.t0 + f * span);
  // Value ticks that would sit under the latest value's or the baseline's tag are left out.
  const tags = [lastY, ...(geo.fromAlert ? [baseY] : [])];
  const ticks = axis.ticks.filter((v) => tags.every((y) => Math.abs(axis.y(v) - y) > 14));
  const h = hover !== null ? points[hover] : undefined;
  const peak = points[geo.hiIdx]!;
  // The peak gets a label unless it is the latest point (its tag already says it) or right by it.
  const showPeak = points.length > 2 && geo.hiIdx < points.length - 1 && Math.abs(py(peak) - lastY) > 16;
  // Each point's markers stack away from the line: buys downward, sells upward.
  const stacked = new Map<string, number>();
  const placed = groups.map((g) => {
    const p = points[g.at]!;
    const r = markerSize(g.sol);
    const key = `${g.at}|${g.side}`;
    const offset = stacked.get(key) ?? 0;
    stacked.set(key, offset + r * 2 + 3);
    const ly = py(p);
    const y = g.side === 1 ? ly + 9 + r + offset : ly - 9 - r - offset;
    return { g, x: px(p), ly, y: Math.min(bottom - r, Math.max(PAD.t - 8 + r, y)), r };
  });
  const mark = hoverMark !== null ? placed[hoverMark] : undefined;

  const pick = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const cx = clientX - box.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(px(points[i]!) - cx) < Math.abs(px(points[best]!) - cx)) best = i;
    }
    setHover(best);
  };
  const hx = h ? px(h) : 0;
  const hUp = h ? h.v >= geo.base : true;

  return (
    <div className="pc" ref={boxRef}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="pc-svg"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient
            id={`${id}-stroke`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={PAD.t}
            x2="0"
            y2={bottom}
          >
            <stop offset={split} stopColor="var(--good)" />
            <stop offset={split} stopColor="var(--bad)" />
          </linearGradient>
          <linearGradient
            id={`${id}-area`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            y1={PAD.t}
            x2="0"
            y2={bottom}
          >
            <stop offset="0" stopColor="var(--good)" stopOpacity="0.34" />
            <stop offset={split} stopColor="var(--good)" stopOpacity="0.03" />
            <stop offset={split} stopColor="var(--bad)" stopOpacity="0.03" />
            <stop offset="1" stopColor="var(--bad)" stopOpacity="0.34" />
          </linearGradient>
        </defs>

        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={width - PAD.r} y1={axis.y(v)} y2={axis.y(v)} className="pc-grid" />
            <text x={width - PAD.r + 10} y={axis.y(v)} dy="0.35em" className="pc-tick">
              {axisUsd(v)}
            </text>
          </g>
        ))}
        {timeTicks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={height - 6}
            className="pc-tick"
            textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"}
          >
            {timeLabel(t, span)}
          </text>
        ))}

        {shown.map((e, i) => (
          <line
            key={`${e.t}-${i}`}
            className={i === 0 ? "pc-event lead" : "pc-event"}
            x1={x(e.t)}
            x2={x(e.t)}
            y1={PAD.t - 6}
            y2={bottom}
          />
        ))}

        <path d={area} fill={`url(#${id}-area)`} />
        <line x1={PAD.l} x2={width - PAD.r} y1={baseY} y2={baseY} className="pc-base" />
        <path d={line} className="pc-glow" stroke={`url(#${id}-stroke)`} />
        <path d={line} className="pc-line" stroke={`url(#${id}-stroke)`} />

        {showPeak && (
          <g className="pc-peak">
            <circle cx={px(peak)} cy={py(peak)} r={3.5} />
            <text
              x={Math.min(width - PAD.r - 4, Math.max(PAD.l + 4, px(peak)))}
              y={py(peak) - 9}
              textAnchor={px(peak) > width - PAD.r - 50 ? "end" : px(peak) < PAD.l + 50 ? "start" : "middle"}
            >
              Peak {usd(peak.v)}
            </text>
          </g>
        )}

        {placed.map((p, i) => (
          <g
            key={`${p.g.at}-${p.g.kind}-${p.g.side}`}
            className={`pc-mark k-${p.g.kind}${hoverMark === i ? " on" : ""}`}
            onPointerEnter={() => setHoverMark(i)}
            onPointerLeave={() => setHoverMark(null)}
            onPointerDown={() => setHoverMark(i)}
          >
            <line x1={p.x} x2={p.x} y1={p.ly} y2={p.y} className="pc-stem" />
            <path d={triangle(p.x, p.y, p.r, p.g.side === 1)} />
          </g>
        ))}

        {/* The latest reading: a dot on the line's end and its value on the axis. */}
        <g className={`pc-last ${up ? "up" : "down"}`}>
          <circle cx={px(last)} cy={lastY} r={8} className="pc-halo" />
          <circle cx={px(last)} cy={lastY} r={3.5} />
          <rect x={width - PAD.r + 3} y={lastY - 10} width={PAD.r - 4} height={20} rx={5} />
          <text x={width - PAD.r + 10} y={lastY} dy="0.35em">
            {axisUsd(last.v)}
          </text>
        </g>
        {geo.fromAlert && Math.abs(baseY - lastY) > 14 && (
          <g className="pc-base-tag">
            <rect x={width - PAD.r + 3} y={baseY - 10} width={PAD.r - 4} height={20} rx={5} />
            <text x={width - PAD.r + 10} y={baseY} dy="0.35em">
              {axisUsd(geo.base)}
            </text>
          </g>
        )}

        {h && (
          <g className={`pc-cross ${hUp ? "up" : "down"}`}>
            <line x1={hx} x2={hx} y1={PAD.t - 6} y2={bottom} />
            <circle cx={hx} cy={py(h)} r={4.5} />
          </g>
        )}
      </svg>

      {shown.map((e, i) => (
        <span
          key={`${e.t}-${i}-flag`}
          className={`pc-flag${i === 0 ? " lead" : ""}`}
          style={{ left: Math.min(width - PAD.r, Math.max(PAD.l + 24, x(e.t))) }}
          title={e.mcap ? `${e.label} at ${usd(e.mcap)}` : e.label}
        >
          {e.label}
        </span>
      ))}

      {mark && <MarkerTip group={mark.g} x={mark.x} y={mark.y} width={width} />}

      {h && !mark && (
        <div
          className="pc-tip"
          style={{
            left: hx > width / 2 ? undefined : hx + 14,
            right: hx > width / 2 ? width - hx + 14 : undefined,
          }}
        >
          <span className="faint">{timeLabel(h.t, span > 36 * 3_600_000 ? span : 0)}</span>
          <strong className="num">{usd(h.v)}</strong>
          {lead?.mcap ? (
            <span className={`num ${h.v >= lead.mcap ? "up" : "down"}`}>
              {signedPct(change(lead.mcap, h.v))} vs {lead.label.toLowerCase()}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** What one marker stands for: who traded, which way, and how much. */
function MarkerTip({ group: g, x, y, width }: { group: MarkerGroup; x: number; y: number; width: number }) {
  const known = g.trades.some((t) => t.sol !== null);
  // The wallets in it, the biggest traders first.
  const byWallet = new Map<string, number>();
  for (const t of g.trades) byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + (t.sol ?? 0));
  const wallets = [...byWallet.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div
      className={`pc-tip pc-mark-tip k-${g.kind}`}
      style={{
        top: Math.max(0, y - 30),
        left: x > width / 2 ? undefined : x + 14,
        right: x > width / 2 ? width - x + 14 : undefined,
      }}
    >
      <span className="pc-mark-head">
        <i className={`pc-swatch k-${g.kind}`} aria-hidden="true" />
        {MARKER_LABEL[g.kind]} {g.side === 1 ? "bought" : "sold"}
      </span>
      <strong className="num">
        {known ? `${g.sol.toFixed(g.sol >= 10 ? 0 : 2)} SOL` : "Amount not recorded"}
      </strong>
      <span className="faint">
        {g.trades.length} trade{g.trades.length === 1 ? "" : "s"}
        {g.wallets > 1 ? ` by ${g.wallets} wallets` : ""} · {timeLabel(g.trades[0]!.t, 0)}
      </span>
      {wallets.slice(0, 3).map(([w, sol]) => (
        <span key={w} className="pc-mark-wallet num">
          {shortAddress(w)}
          {known ? ` · ${sol.toFixed(sol >= 10 ? 0 : 2)} SOL` : ""}
        </span>
      ))}
      {wallets.length > 3 && <span className="faint">and {wallets.length - 3} more</span>}
    </div>
  );
}

/** An axis label: usd() without the trailing zeros ($5K, $12.5K, $1M). */
export function axisUsd(v: number): string {
  return usd(v)
    .replace(/\.0+(?=[KMB]?$)/, "")
    .replace(/(\.\d*?)0+(?=[KMB]?$)/, "$1");
}
