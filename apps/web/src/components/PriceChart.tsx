import { useEffect, useId, useMemo, useRef, useState } from "react";
import { change, signedPct, usd } from "../format";
import {
  FLOW_WINDOW_MS,
  flowAt,
  mcapAxis,
  timeLabel,
  volumeBars,
  type Point,
  type ScanFlow,
  type VolumeBar,
  type VolumeCandle,
} from "../priceChart";

/** A moment marked on the time axis: an alert or a model's call. */
export interface ChartEvent {
  t: number;
  label: string;
  /** Market cap at the moment, when known (the readout shows the move since). */
  mcap?: number | null;
}

const PAD = { l: 8, r: 62, t: 24, b: 24 };

/** The height of the volume lane under the plot, when there are candles to sum. */
const LANE = 40;

/**
 * The token modal's market-cap chart: one line, green above its baseline and red below it, with
 * the area between them shaded. The baseline is the alert's market cap while the alert is in view,
 * else where the view starts, so the colour always answers "up or down since then?". Sized to its
 * box in real pixels (a ResizeObserver), so text stays crisp at any width. Hover (or drag on a touch
 * screen) reads one point out; hovering (or tapping) a bar in the volume lane reads out its minutes.
 */
export function PriceChart({
  points,
  stepMs,
  events,
  candles = [],
  flow = [],
  seenUntil,
  scans = [],
  live = true,
  now,
  height,
  ariaLabel,
}: {
  points: Point[];
  /**
   * The spacing the points were thinned to; scan readings, which come unevenly, estimate their own.
   * Under a minute (the first-minutes view's 1- and 15-second candles), the readout shows seconds.
   */
  stepMs?: number;
  events: ChartEvent[];
  /** Minute candles with their USD volume, summed into bars in a lane under the plot. */
  candles?: VolumeCandle[];
  /** The scans' 5-minute buy and sell counts: the readouts give the buy share where one covers. */
  flow?: ScanFlow[];
  /** Model View: the call's time. Everything after it is shaded as what the model didn't see. */
  seenUntil?: number;
  /** Model View: the scan readings the model read, drawn as dots on their market caps. */
  scans?: Point[];
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
  /** The volume bar under the pointer (or last tapped): its slice. */
  const [bar, setBar] = useState<number | null>(null);

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

  // About one bar per 6px of plot, and no more bars than the view has minutes.
  const plotW = width - PAD.l - PAD.r;
  const slices = geo
    ? Math.max(1, Math.min(Math.round(plotW / 6), Math.round((geo.t1 - geo.t0) / 60_000)))
    : 1;
  const vols = useMemo(
    () => (geo && candles.some((k) => k.vol > 0) ? volumeBars(candles, geo.t0, geo.t1, slices) : null),
    [geo, candles, slices],
  );

  if (!geo) return null;
  const { x, axis } = geo;
  const span = geo.t1 - geo.t0;
  const bottom = height - PAD.b;
  const lane = vols ? LANE : 0;
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
  // Above its point the label would sit under a flag along the top ("Called"), so it goes below.
  const peakBelow = py(peak) - 9 < PAD.t + 6 && shown.some((e) => Math.abs(x(e.t) - px(peak)) < 70);

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
  // The volume lane: a bar per slice rising from its floor, green where the price rose across it.
  const laneTop = bottom + 8;
  const laneBottom = laneTop + LANE - 10;
  const volMax = vols ? Math.max(1e-9, ...vols.map((b) => b?.usd ?? 0)) : 1;
  const sliceW = plotW / slices;
  const mark = bar !== null && vols ? (vols[bar] ?? undefined) : undefined;
  const hFlow = h ? flowAt(flow, h.t - 60_000, h.t) : null;

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
              y={peakBelow ? py(peak) + 17 : py(peak) - 9}
              textAnchor={px(peak) > width - PAD.r - 50 ? "end" : px(peak) < PAD.l + 50 ? "start" : "middle"}
            >
              Peak {usd(peak.v)}
            </text>
          </g>
        )}

        {vols && (
          <g className="pc-vol">
            <line x1={PAD.l} x2={width - PAD.r} y1={laneBottom} y2={laneBottom} className="pc-vol-floor" />
            {vols.map((b, i) => {
              if (!b || b.usd <= 0) return null;
              const hb = Math.max(2, (b.usd / volMax) * (laneBottom - laneTop));
              // Thin bars even when a short view has few minutes: a wide block reads as a level, not a bar.
              const bw = Math.min(14, Math.max(1.5, sliceW - 1.5));
              return (
                <g key={i}>
                  <rect
                    className={`pc-vol-bar ${b.c >= b.o ? "up" : "down"}${bar === i ? " on" : ""}`}
                    x={PAD.l + i * sliceW + (sliceW - bw) / 2}
                    width={bw}
                    y={laneBottom - hb}
                    height={hb}
                    rx={1}
                  />
                  {/* The hit target spans the whole lane, so a short bar is as easy to find as a tall one. */}
                  <rect
                    className="pc-vol-hit"
                    x={PAD.l + i * sliceW}
                    width={sliceW}
                    y={laneTop - 4}
                    height={LANE - 4}
                    onPointerEnter={(e) => e.pointerType === "mouse" && setBar(i)}
                    onPointerLeave={(e) => e.pointerType === "mouse" && setBar(null)}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setHover(null);
                      setBar(i);
                    }}
                  />
                </g>
              );
            })}
            <text x={width - PAD.r + 10} y={laneTop + 4} dy="0.35em" className="pc-tick pc-vol-label">
              Vol
            </text>
            <text x={width - PAD.r + 10} y={laneTop + 16} dy="0.35em" className="pc-tick pc-vol-label">
              {axisUsd(volMax)}
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

      {mark && bar !== null && (
        <BarTip
          bar={mark}
          flow={flowAt(flow, mark.from, mark.to)}
          x={PAD.l + (bar + 0.5) * sliceW}
          bottom={fullH - laneTop + 6}
          width={width}
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
          <span className="faint">
            {timeLabel(h.t, span > 36 * 3_600_000 ? span : 0, stepMs !== undefined && stepMs < 60_000)}
          </span>
          <strong className="num">{usd(h.v)}</strong>
          {lead?.mcap ? (
            <span className={`num ${h.v >= lead.mcap ? "up" : "down"}`}>
              {signedPct(change(lead.mcap, h.v))} vs {lead.label.toLowerCase()}
            </span>
          ) : null}
          {hFlow && <FlowLine flow={hFlow} />}
        </div>
      )}
    </div>
  );
}

/** A scan's buy share: "64% buys · 120 buys, 68 sells in the 5 min to 4:32 AM". */
function FlowLine({ flow }: { flow: ScanFlow }) {
  const share = flow.buys / (flow.buys + flow.sells);
  return (
    <span className="pc-flow-line">
      <span className={`num ${share >= 0.5 ? "up" : "down"}`}>{Math.round(share * 100)}% buys</span>
      <span className="faint">
        {flow.buys} buys, {flow.sells} sells in the {FLOW_WINDOW_MS / 60_000} min to {timeLabel(flow.t, 0)}
      </span>
    </span>
  );
}

/** What one volume bar stands for: its minutes, their volume, the move across them, and the buy share. */
function BarTip({
  bar,
  flow,
  x,
  bottom,
  width,
}: {
  bar: VolumeBar;
  flow: ScanFlow | null;
  x: number;
  /** Distance from the chart box's bottom edge, so the readout sits above the lane. */
  bottom: number;
  width: number;
}) {
  const mins = Math.round((bar.to - bar.from) / 60_000);
  return (
    <div
      className="pc-tip"
      style={{
        top: "auto",
        bottom,
        left: x > width / 2 ? undefined : x + 10,
        right: x > width / 2 ? width - x + 10 : undefined,
      }}
    >
      <span className="faint">
        {timeLabel(bar.from, 0)}
        {mins > 1 ? `–${timeLabel(bar.to, 0)}` : ""}
      </span>
      <strong className="num">{usd(bar.usd)} volume</strong>
      <span className={`num ${bar.c >= bar.o ? "up" : "down"}`}>
        {signedPct(change(bar.o, bar.c))} market cap{mins > 1 ? ` over ${mins} min` : ""}
      </span>
      {flow ? <FlowLine flow={flow} /> : <span className="faint">No buy/sell count from a scan here</span>}
    </div>
  );
}

/** An axis label: usd() without the trailing zeros ($5K, $12.5K, $1M). */
export function axisUsd(v: number): string {
  return usd(v)
    .replace(/\.0+(?=[KMB]?$)/, "")
    .replace(/(\.\d*?)0+(?=[KMB]?$)/, "$1");
}
