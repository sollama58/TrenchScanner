import { useEffect, useMemo, useRef, useState } from "react";
import { change, shortAddress, signedPct, usd } from "../format";
import {
  groupMarkers,
  mcapAxis,
  timeLabel,
  type Bar,
  type MarkerGroup,
  type MarkerTrade,
} from "../priceChart";

/** A moment marked on the time axis: an alert or a model's call. */
export interface ChartEvent {
  t: number;
  label: string;
  /** Market cap at the moment, when known (the readout shows the move since). */
  mcap?: number | null;
}

const PAD = { l: 8, r: 58, t: 22, b: 24 };

/** What each marker kind is called in its readout. */
export const MARKER_LABEL: Record<MarkerTrade["kind"], string> = {
  dev: "Dev",
  risky: "Risky wallet",
  linked: "Linked wallet",
};

/** A marker's size: bigger for more SOL, within a few pixels so a whale doesn't hide the candles. */
function markerSize(sol: number): number {
  return 4.5 + Math.min(4, Math.sqrt(Math.max(0, sol)) * 1.5);
}

/** A triangle pointing up (a buy, under the bar) or down (a sell, over it), centred on (x, y). */
function triangle(x: number, y: number, r: number, up: boolean): string {
  const h = r * 1.15;
  return up
    ? `M${x},${y - h} L${x + r},${y + h * 0.75} L${x - r},${y + h * 0.75} Z`
    : `M${x},${y + h} L${x + r},${y - h * 0.75} L${x - r},${y - h * 0.75} Z`;
}

/**
 * The token modal's market-cap chart: candles when Pump.fun sent them, else a line through the
 * scan's readings. Sized to its box in real pixels (a ResizeObserver), so text and candle edges
 * stay crisp at any width. Hover (or drag on a touch screen) reads one bar out.
 */
export function PriceChart({
  bars,
  stepMs,
  mode,
  events,
  markers = [],
  height,
  ariaLabel,
}: {
  bars: Bar[];
  /** Each bar's width (bars can be missing where nothing traded); a line estimates its own. */
  stepMs?: number;
  /** "candles" draws each bar; "line" joins the closes (scan readings have no open/high/low). */
  mode: "candles" | "line";
  events: ChartEvent[];
  /** Flagged wallets' trades, drawn as triangles: buys under the bar, sells over it. */
  markers?: MarkerTrade[];
  height: number;
  ariaLabel: string;
}) {
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
    if (bars.length === 0) return null;
    const t0 = bars[0]!.t;
    const lastT = bars[bars.length - 1]!.t;
    // One bar's width past the last start, so the newest bar isn't drawn on the edge.
    const step = stepMs ?? (bars.length > 1 ? Math.max(1, (lastT - t0) / (bars.length - 1)) : 60_000);
    const t1 = lastT + step;
    const plotW = width - PAD.l - PAD.r;
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0)) * plotW;
    const lo = Math.min(...bars.map((b) => b.l));
    const hi = Math.max(...bars.map((b) => b.h));
    const axis = mcapAxis(lo, hi, PAD.t, height - PAD.b);
    const slot = plotW / Math.max(1, (t1 - t0) / step);
    const body = Math.max(1, Math.min(14, slot * 0.68));
    const hiIdx = bars.reduce((best, b, i) => (b.h > bars[best]!.h ? i : best), 0);
    return { t0, t1, step, x, axis, body, hiIdx };
  }, [bars, stepMs, width, height]);

  const groups = useMemo(
    () => (geo ? groupMarkers(bars, geo.step, mode, markers) : []),
    [bars, geo, mode, markers],
  );

  if (!geo) return null;
  const { x, axis } = geo;
  const span = geo.t1 - geo.t0;
  // Candles sit centred in their slot; a line's points sit on their reading's time.
  const cx = (b: Bar) => (mode === "candles" ? x(b.t + geo.step / 2) : x(b.t));
  const line =
    mode === "line"
      ? bars.map((b, i) => `${i ? "L" : "M"}${cx(b).toFixed(1)},${axis.y(b.c).toFixed(1)}`).join(" ")
      : "";
  const bottom = height - PAD.b;
  const area =
    mode === "line" && bars.length > 1
      ? `${line} L${cx(bars[bars.length - 1]!).toFixed(1)},${bottom} L${cx(bars[0]!).toFixed(1)},${bottom} Z`
      : "";
  const shown = events.filter((e) => e.t >= geo.t0 && e.t <= geo.t1);
  // Five time labels on a desktop, three on a phone, where five would run into each other.
  const fractions = width < 520 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const timeTicks = fractions.map((f) => geo.t0 + f * (geo.t1 - geo.t0 - geo.step));
  const h = hover !== null ? bars[hover] : undefined;
  const hx = h ? cx(h) : 0;
  const peak = bars[geo.hiIdx]!;
  const lead = shown[0];
  // Each bar's markers stack away from it: buys downward from its low, sells upward from its high.
  const stacked = new Map<string, number>();
  const placed = groups.map((g) => {
    const b = bars[g.bar]!;
    const r = markerSize(g.sol);
    const key = `${g.bar}|${g.side}`;
    const offset = stacked.get(key) ?? 0;
    stacked.set(key, offset + r * 2 + 3);
    const base = mode === "candles" ? (g.side === 1 ? axis.y(b.l) : axis.y(b.h)) : axis.y(b.c);
    const y = g.side === 1 ? base + 6 + r + offset : base - 6 - r - offset;
    return { g, x: cx(b), y: Math.min(bottom - r, Math.max(PAD.t - 6 + r, y)), r };
  });
  const mark = hoverMark !== null ? placed[hoverMark] : undefined;

  const pick = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const px = clientX - box.left;
    let best = 0;
    for (let i = 1; i < bars.length; i++) {
      if (Math.abs(cx(bars[i]!) - px) < Math.abs(cx(bars[best]!) - px)) best = i;
    }
    setHover(best);
  };

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
          <linearGradient id="pc-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--series-1)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--series-1)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {axis.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={width - PAD.r} y1={axis.y(v)} y2={axis.y(v)} className="pc-grid" />
            <text x={width - PAD.r + 8} y={axis.y(v)} dy="0.35em" className="pc-tick">
              {axisUsd(v)}
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={width - PAD.r} y1={bottom} y2={bottom} className="pc-axis" />
        {timeTicks.map((t, i) => (
          <text
            key={i}
            x={Math.min(width - PAD.r, Math.max(PAD.l, x(t)))}
            y={height - 6}
            className="pc-tick"
            textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"}
          >
            {timeLabel(t, span)}
          </text>
        ))}

        {shown.map((e, i) => (
          <g key={`${e.t}-${i}`} className={i === 0 ? "pc-event lead" : "pc-event"}>
            <line x1={x(e.t)} x2={x(e.t)} y1={PAD.t - 4} y2={bottom} />
          </g>
        ))}

        {mode === "line" ? (
          <>
            <path d={area} fill="url(#pc-area)" />
            <path d={line} className="pc-line" />
          </>
        ) : (
          bars.map((b, i) => {
            const up = b.c >= b.o;
            const yo = axis.y(b.o);
            const yc = axis.y(b.c);
            const top = Math.min(yo, yc);
            const c = cx(b);
            return (
              <g key={b.t} className={`pc-candle ${up ? "up" : "down"}${hover === i ? " on" : ""}`}>
                <line x1={c} x2={c} y1={axis.y(b.h)} y2={axis.y(b.l)} />
                <rect
                  x={c - geo.body / 2}
                  y={top}
                  width={geo.body}
                  height={Math.max(1, Math.abs(yc - yo))}
                  rx={geo.body > 4 ? 1 : 0}
                />
              </g>
            );
          })
        )}

        {/* The highest point in view, labelled once it is clear of the alert flag. */}
        {bars.length > 2 && (
          <g className="pc-peak">
            <circle cx={cx(peak)} cy={axis.y(peak.h)} r={3} />
            <text
              x={Math.min(width - PAD.r - 4, Math.max(PAD.l + 4, cx(peak)))}
              y={axis.y(peak.h) - 8}
              textAnchor={cx(peak) > width - PAD.r - 40 ? "end" : cx(peak) < PAD.l + 40 ? "start" : "middle"}
            >
              {usd(peak.h)}
            </text>
          </g>
        )}

        {placed.map((p, i) => (
          <path
            key={`${p.g.bar}-${p.g.kind}-${p.g.side}`}
            d={triangle(p.x, p.y, p.r, p.g.side === 1)}
            className={`pc-mark k-${p.g.kind} ${p.g.side === 1 ? "buy" : "sell"}${hoverMark === i ? " on" : ""}`}
            onPointerEnter={() => setHoverMark(i)}
            onPointerLeave={() => setHoverMark(null)}
            onPointerDown={() => setHoverMark(i)}
          />
        ))}

        {h && (
          <g className="pc-cross">
            <line x1={hx} x2={hx} y1={PAD.t - 4} y2={bottom} />
            <line x1={PAD.l} x2={width - PAD.r} y1={axis.y(h.c)} y2={axis.y(h.c)} />
            <rect x={width - PAD.r + 2} y={axis.y(h.c) - 9} width={PAD.r - 4} height={18} rx={4} />
            <text x={width - PAD.r + 8} y={axis.y(h.c)} dy="0.35em">
              {usd(h.c)}
            </text>
          </g>
        )}
      </svg>

      {shown.map((e, i) => (
        <span
          key={`${e.t}-${i}-flag`}
          className={`pc-flag${i === 0 ? " lead" : ""}`}
          style={{ left: Math.min(width - PAD.r, x(e.t)) }}
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
            left: hx > width / 2 ? undefined : hx + 12,
            right: hx > width / 2 ? width - hx + 12 : undefined,
          }}
        >
          <span className="faint">{timeLabel(h.t, span > 36 * 3_600_000 ? span : 0)}</span>
          <strong className="num">{usd(h.c)}</strong>
          {mode === "candles" && (
            <span className="pc-ohlc num">
              H {usd(h.h)} · L {usd(h.l)}
            </span>
          )}
          {lead?.mcap ? (
            <span className={`num ${h.c >= lead.mcap ? "up" : "down"}`}>
              {signedPct(change(lead.mcap, h.c))} vs {lead.label.toLowerCase()}
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
function axisUsd(v: number): string {
  return usd(v)
    .replace(/\.0+(?=[KMB]?$)/, "")
    .replace(/(\.\d*?)0+(?=[KMB]?$)/, "$1");
}
