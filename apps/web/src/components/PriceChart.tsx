import { useEffect, useId, useMemo, useRef, useState } from "react";
import { change, signedPct, usd } from "../format";
import { isPumpfunName, walletText, type WalletNames } from "../walletNames";
import { mcapAxis, timeLabel, type MarkerTrade, type Point } from "../priceChart";

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
  kol: "KOL",
  winner: "Winner wallet",
  linked: "Linked wallet",
};

/** The height of the flow lane under the plot, when there are marked trades. */
const LANE = 40;

/** One slice of the flow lane: what the flagged wallets bought and sold in it, and the trades behind each. */
interface FlowBucket {
  buy: number;
  sell: number;
  buys: MarkerTrade[];
  sells: MarkerTrade[];
}

/**
 * The marked trades summed into `n` even slices of [t0, t1], weighed by SOL; by trade count when
 * no amount is known, so the lane still shows which way they traded.
 */
function flowBuckets(trades: readonly MarkerTrade[], t0: number, t1: number, n: number): FlowBucket[] {
  const out = Array.from({ length: n }, (): FlowBucket => ({ buy: 0, sell: 0, buys: [], sells: [] }));
  const inView = trades.filter((t) => t.t >= t0 && t.t <= t1);
  const bySol = inView.some((t) => (t.sol ?? 0) > 0);
  for (const t of inView) {
    const i = Math.min(n - 1, Math.floor(((t.t - t0) / Math.max(1, t1 - t0)) * n));
    const w = bySol ? (t.sol ?? 0) : 1;
    const b = out[i]!;
    if (t.side === 1) {
      b.buy += w;
      b.buys.push(t);
    } else {
      b.sell += w;
      b.sells.push(t);
    }
  }
  return out;
}

/**
 * The token modal's market-cap chart: one line, green above its baseline and red below it, with
 * the area between them shaded. The baseline is the alert's market cap while the alert is in view,
 * else where the view starts, so the colour always answers "up or down since then?". Sized to its
 * box in real pixels (a ResizeObserver), so text stays crisp at any width. Hover (or drag on a touch
 * screen) reads one point out; hovering (or tapping) a bar in the flow lane reads out its trades.
 */
export function PriceChart({
  points,
  stepMs,
  events,
  markers = [],
  seenUntil,
  scans = [],
  live = true,
  now,
  names,
  height,
  ariaLabel,
}: {
  points: Point[];
  /** The spacing the points were thinned to; scan readings, which come unevenly, estimate their own. */
  stepMs?: number;
  events: ChartEvent[];
  /** Flagged wallets' trades, summed into buy and sell bars in a lane under the plot. */
  markers?: MarkerTrade[];
  /** Model View: the call's time. Everything after it is shaded as what the model didn't see. */
  seenUntil?: number;
  /** Model View: the scan readings the model read, drawn as dots on their market caps. */
  scans?: Point[];
  /** Names for the markers' wallets (KOLs, exchanges), shown in place of their addresses. */
  names?: WalletNames;
  /** Whether the line runs to the latest reading; false when the view ends earlier (Model View). */
  live?: boolean;
  /** The latest reading, tagged "NOW:" under the end tag when the view ends before it. */
  now?: number;
  height: number;
  ariaLabel: string;
}) {
  const id = useId().replace(/:/g, "");
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  /** The flow bar under the pointer: its slice and side. */
  const [bar, setBar] = useState<{ i: number; side: 1 | -1 } | null>(null);

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

  // About one flow bar per 10px of plot.
  const slices = Math.max(12, Math.round((width - PAD.l - PAD.r) / 10));
  const flow = useMemo(
    () => (geo && markers.length > 0 ? flowBuckets(markers, geo.t0, geo.t1, slices) : null),
    [geo, markers, slices],
  );

  if (!geo) return null;
  const { x, axis } = geo;
  const span = geo.t1 - geo.t0;
  const bottom = height - PAD.b;
  const lane = flow ? LANE : 0;
  const fullH = height + lane;
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
  // Model View cut off before now: the latest reading goes under the end tag, or over it when
  // the baseline's tag sits below.
  const nowTag =
    !live && now !== undefined && now > 0
      ? (() => {
          const text = `NOW: ${axisUsd(now)}`;
          const w = Math.max(PAD.r - 4, Math.round(text.length * 6.1 + 14));
          const below = lastY + 22;
          const clash = geo.fromAlert && Math.abs(baseY - below) < 20;
          const y = clash || below > bottom ? lastY - 22 : below;
          return { text, w, y, up: now >= geo.base };
        })()
      : null;
  const tags = [lastY, ...(geo.fromAlert ? [baseY] : []), ...(nowTag ? [nowTag.y] : [])];
  const ticks = axis.ticks.filter((v) => tags.every((y) => Math.abs(axis.y(v) - y) > 18));
  const h = hover !== null ? points[hover] : undefined;
  const peak = points[geo.hiIdx]!;
  // The peak gets a label unless it is the latest point (its tag already says it) or right by it,
  // and not in Model View, where the window's high isn't the coin's peak.
  const showPeak =
    seenUntil === undefined &&
    points.length > 2 &&
    geo.hiIdx < points.length - 1 &&
    Math.abs(py(peak) - lastY) > 16;

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
  // The flow lane: buys rise green from its middle, sells drop red, per slice of time.
  const laneTop = bottom + 8;
  const laneMid = laneTop + (LANE - 8) / 2;
  const laneHalf = (LANE - 8) / 2 - 2;
  const flowMax = flow ? Math.max(1e-9, ...flow.map((b) => Math.max(b.buy, b.sell))) : 1;
  const sliceW = (width - PAD.l - PAD.r) / slices;
  const barTrades = bar && flow ? (bar.side === 1 ? flow[bar.i]?.buys : flow[bar.i]?.sells) : undefined;
  const mark = barTrades && barTrades.length > 0 ? barTrades : undefined;

  return (
    <div className="pc" ref={boxRef}>
      <svg
        width={width}
        height={fullH}
        viewBox={`0 0 ${width} ${fullH}`}
        className="pc-svg"
        role="img"
        aria-label={ariaLabel}
        onPointerMove={(e) => pick(e.clientX)}
        onPointerDown={(e) => {
          setBar(null);
          pick(e.clientX);
        }}
        onPointerLeave={(e) => {
          setHover(null);
          // A tapped bar's readout stays up after the finger lifts, until the next tap.
          if (e.pointerType === "mouse") setBar(null);
        }}
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
            <stop offset="0" stopColor="var(--good)" stopOpacity="0.2" />
            <stop offset={split} stopColor="var(--good)" stopOpacity="0.03" />
            <stop offset={split} stopColor="var(--bad)" stopOpacity="0.03" />
            <stop offset="1" stopColor="var(--bad)" stopOpacity="0.2" />
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
            y={fullH - 6}
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

        {seenUntil !== undefined && seenUntil >= geo.t0 && seenUntil < geo.t1 && (
          <g className="pc-unseen" aria-hidden="true">
            <rect
              x={x(seenUntil)}
              y={PAD.t - 6}
              width={width - PAD.r - x(seenUntil)}
              height={bottom - PAD.t + 6}
            />
          </g>
        )}

        <path d={area} fill={`url(#${id}-area)`} />
        <line x1={PAD.l} x2={width - PAD.r} y1={baseY} y2={baseY} className="pc-base" />
        <path d={line} className="pc-line" stroke={`url(#${id}-stroke)`} />

        {scans
          .filter((s) => s.t >= geo.t0 && s.t <= geo.t1)
          .map((s) => (
            <circle key={`scan-${s.t}`} cx={x(s.t)} cy={axis.y(s.v)} r={3.5} className="pc-scan">
              <title>{`Scan at ${timeLabel(s.t, 0)}: ${usd(s.v)}`}</title>
            </circle>
          ))}

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

        {flow && (
          <g className="pc-flow">
            <line x1={PAD.l} x2={width - PAD.r} y1={laneMid} y2={laneMid} className="pc-flow-mid" />
            {flow.map((b, i) => {
              const bx = PAD.l + i * sliceW + 1;
              const bw = Math.max(1.5, sliceW - 2);
              const hb = (b.buy / flowMax) * laneHalf;
              const hs = (b.sell / flowMax) * laneHalf;
              const on = (side: 1 | -1) => (bar?.i === i && bar.side === side ? " on" : "");
              // Hit targets span the slice and the whole half of the lane, so a thin bar is easy to find.
              const hit = (side: 1 | -1) => (
                <rect
                  className="pc-flow-hit"
                  x={PAD.l + i * sliceW}
                  width={sliceW}
                  y={side === 1 ? laneTop : laneMid}
                  height={LANE / 2 - 4}
                  onPointerEnter={(e) => e.pointerType === "mouse" && setBar({ i, side })}
                  onPointerLeave={(e) => e.pointerType === "mouse" && setBar(null)}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    setHover(null);
                    setBar({ i, side });
                  }}
                />
              );
              return (
                <g key={i}>
                  {b.buy > 0 && (
                    <rect
                      className={`pc-flow-buy${on(1)}`}
                      x={bx}
                      width={bw}
                      y={laneMid - Math.max(2, hb)}
                      height={Math.max(2, hb)}
                      rx={1.5}
                    />
                  )}
                  {b.sell > 0 && (
                    <rect
                      className={`pc-flow-sell${on(-1)}`}
                      x={bx}
                      width={bw}
                      y={laneMid}
                      height={Math.max(2, hs)}
                      rx={1.5}
                    />
                  )}
                  {b.buy > 0 && hit(1)}
                  {b.sell > 0 && hit(-1)}
                </g>
              );
            })}
            <text
              x={width - PAD.r + 10}
              y={laneMid - laneHalf / 2}
              dy="0.35em"
              className="pc-tick pc-flow-label buy"
            >
              Buys
            </text>
            <text
              x={width - PAD.r + 10}
              y={laneMid + laneHalf / 2}
              dy="0.35em"
              className="pc-tick pc-flow-label sell"
            >
              Sells
            </text>
          </g>
        )}

        {/* The latest reading: a dot on the line's end and its value on the axis. A view that ends
            before the latest reading (Model View) tags its end plainly, so it doesn't read as now. */}
        <g className={`pc-last ${up ? "up" : "down"}${live ? "" : " end"}`}>
          {live && <circle cx={px(last)} cy={lastY} r={8} className="pc-halo" />}
          <circle cx={px(last)} cy={lastY} r={3.5} />
          <rect x={width - PAD.r + 3} y={lastY - 10} width={PAD.r - 4} height={20} rx={5} />
          <text x={width - PAD.r + 10} y={lastY} dy="0.35em">
            {axisUsd(last.v)}
          </text>
        </g>
        {nowTag && (
          <g className={`pc-now ${nowTag.up ? "up" : "down"}`}>
            <rect x={width - 1 - nowTag.w} y={nowTag.y - 10} width={nowTag.w} height={20} rx={5} />
            <text x={width - 1 - nowTag.w / 2} y={nowTag.y} dy="0.35em" textAnchor="middle">
              {nowTag.text}
            </text>
          </g>
        )}
        {geo.fromAlert && Math.abs(baseY - lastY) > 14 && (
          <g className="pc-base-tag">
            <rect x={width - PAD.r + 3} y={baseY - 10} width={PAD.r - 4} height={20} rx={5} />
            <text x={width - PAD.r + 10} y={baseY} dy="0.35em">
              {axisUsd(geo.base)}
            </text>
          </g>
        )}

        {h && !mark && (
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

      {mark && bar && (
        <BarTip
          trades={mark}
          side={bar.side}
          x={PAD.l + (bar.i + 0.5) * sliceW}
          bottom={fullH - laneTop + 6}
          width={width}
          names={names}
        />
      )}

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

/** What one flow bar stands for: who traded, which way, and how much. */
function BarTip({
  trades,
  side,
  x,
  bottom,
  width,
  names,
}: {
  trades: readonly MarkerTrade[];
  side: 1 | -1;
  x: number;
  /** Distance from the chart box's bottom edge, so the readout sits above the lane. */
  bottom: number;
  width: number;
  names?: WalletNames;
}) {
  const known = trades.some((t) => t.sol !== null);
  const sol = trades.reduce((s, t) => s + (t.sol ?? 0), 0);
  // The wallets in it, the biggest traders first.
  const byWallet = new Map<string, { sol: number; kind: MarkerTrade["kind"] }>();
  for (const t of trades) {
    const w = byWallet.get(t.wallet);
    byWallet.set(t.wallet, { sol: (w?.sol ?? 0) + (t.sol ?? 0), kind: w?.kind ?? t.kind });
  }
  const wallets = [...byWallet.entries()].sort((a, b) => b[1].sol - a[1].sol);
  const kinds = new Set(trades.map((t) => t.kind));
  const kind = kinds.size === 1 ? trades[0]!.kind : null;
  const ts = trades.map((t) => t.t);
  const from = Math.min(...ts);
  const to = Math.max(...ts);
  return (
    <div
      className={`pc-tip pc-mark-tip${kind ? ` k-${kind}` : ""}`}
      style={{
        top: "auto",
        bottom,
        left: x > width / 2 ? undefined : x + 10,
        right: x > width / 2 ? width - x + 10 : undefined,
      }}
    >
      <span className="pc-mark-head">
        {kind && <i className={`pc-swatch k-${kind}`} aria-hidden="true" />}
        {kind ? MARKER_LABEL[kind] : "Flagged wallets"} {side === 1 ? "bought" : "sold"}
      </span>
      <strong className="num">
        {known ? `${sol.toFixed(sol >= 10 ? 0 : 2)} SOL` : "Amount not recorded"}
      </strong>
      <span className="faint">
        {trades.length} trade{trades.length === 1 ? "" : "s"}
        {wallets.length > 1 ? ` by ${wallets.length} wallets` : ""} · {timeLabel(from, 0)}
        {to - from >= 60_000 ? `–${timeLabel(to, 0)}` : ""}
      </span>
      {wallets.slice(0, 3).map(([w, v]) => (
        <span
          key={w}
          className={`pc-mark-wallet${names?.[w] ? "" : " num"}${isPumpfunName(names?.[w]) ? " pumpfun-name" : ""}`}
        >
          {!kind && <i className={`pc-swatch k-${v.kind}`} aria-hidden="true" />}
          {walletText(w, names)}
          {known ? ` · ${v.sol.toFixed(v.sol >= 10 ? 0 : 2)} SOL` : ""}
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
