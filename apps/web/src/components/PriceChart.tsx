import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { change, signedPct, usd } from "../format";
import {
  AUTO_TIMEFRAMES_MS,
  candleTimeframe,
  clipPoints,
  FLOW_WINDOW_MS,
  flowAt,
  MIN_ZOOM_MS,
  mcapAxis,
  fillFlat,
  liveCandles,
  ohlcBars,
  panBy,
  zoomBy,
  zoomWindow,
  sinceLabel,
  TIMEFRAMES,
  timeframeLabel,
  timeframeSlots,
  timeLabel,
  timeTicks,
  valueAt,
  volumeBars,
  type Point,
  type ScanFlow,
  type VolumeBar,
  type VolumeCandle,
  type Zoom,
} from "../priceChart";
import type { PathStep } from "../pricePathing";
import { markRadius, type WalletMark } from "../walletMarks";

/** A moment marked on the time axis: an alert or a model's call. */
export interface ChartEvent {
  t: number;
  label: string;
  /** Market cap at the moment, when known (the readout shows the move since). */
  mcap?: number | null;
}

/** One of the Pro trader's own trades, marked on the line at its time (Pro Mode only). */
export interface ChartTrade {
  t: number;
  side: "buy" | "sell";
  /** The readout's line for it ("Bought 0.5 SOL"). */
  text: string;
}

/** How the chart draws the market cap: a line (the default) or candles. */
export type ChartKind = "line" | "candles";

/** The candle view's picked timeframe in ms, or null for Auto (as many as fit), kept on this device. */
const TIMEFRAME_KEY = "ts.chartTimeframe";
function readTimeframe(): number | null {
  try {
    const ms = Number(localStorage.getItem(TIMEFRAME_KEY));
    return TIMEFRAMES.some((f) => f.ms === ms) ? ms : null;
  } catch {
    return null;
  }
}
function keepTimeframe(ms: number | null): void {
  try {
    if (ms === null) localStorage.removeItem(TIMEFRAME_KEY);
    else localStorage.setItem(TIMEFRAME_KEY, String(ms));
  } catch {
    // Private windows: the pick holds for this view only.
  }
}
/** A timeframe picked draws candles this wide on screen, about; the window zooms to fit them. */
const PICKED_CANDLE_PX = 8;
/** Candles thinner than this would smear together: the view draws a wider timeframe instead. */
const MIN_CANDLE_PX = 3;
/** Auto draws candles about this wide, at least: the narrowest timeframe that leaves them room. */
const AUTO_CANDLE_PX = 8;

const PAD = { l: 8, r: 62, t: 24, b: 24 };

/** The height of the volume lane under the plot, when there are candles to sum. */
const LANE = 40;
/** A finger held this long on a zoomed chart reads it out instead of panning it. */
const HOLD_MS = 320;
/** A finger moved this far (px) on a zoomed chart pans it; less is a tap. */
const DRAG_PX = 6;

/** The site's phone breakpoint (styles.css): the readout docks under the chart there. */
const PHONE_QUERY = "(max-width: 640px)";
function subscribePhone(cb: () => void): () => void {
  const mq = window.matchMedia?.(PHONE_QUERY);
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
}
function isPhone(): boolean {
  return window.matchMedia?.(PHONE_QUERY).matches ?? false;
}

/**
 * The token modal's market-cap chart: one line, green above its baseline and red below it, with
 * the area between them shaded. The baseline is the alert's market cap while the alert is in view,
 * else where the view starts, so the colour always answers "up or down since then?". Sized to its
 * box in real pixels (a ResizeObserver), so text stays crisp at any width. Hover (or drag on a touch
 * screen) reads one point out; hovering (or tapping) a bar in the volume lane reads out its minutes.
 * On a phone the readout sits under the chart instead of over it (user ask 2026-10-18), showing the
 * latest reading until a finger picks another; a finger drags a zoomed chart along, and a hold reads it.
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
  origin,
  height,
  ariaLabel,
  marks = [],
  trades = [],
  entry = null,
  extent,
  zoom: zoomProp,
  onZoom,
  kind = "line",
  onKind,
  path = [],
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
  /**
   * Model View: the scans the model read before the call. Each is a small dot on the line at the
   * scan's time (its own market cap came from another source, often a few seconds behind, so drawn
   * at that it sat off the line); the readout near one gives what the scan read.
   */
  scans?: Point[];
  /** Whether the line runs to the latest reading; false when the view ends earlier (Model View). */
  live?: boolean;
  /** The latest reading, tagged "NOW:" under the end tag when the view ends before it. */
  now?: number;
  /** The First 15m view's launch: the time axis counts from it ("2:30") instead of the clock. */
  origin?: number;
  height: number;
  ariaLabel: string;
  /**
   * Labeled wallets' trades (KOLs, their sides, flagged wallets): lettered rings on the line, filled
   * for a buy and hollow for a sale, sized by SOL. Apart from a Pro trader's own arrows.
   */
  marks?: WalletMark[];
  /** Pro Mode: the trader's own buys and sells, marked on the line. */
  trades?: ChartTrade[];
  /** Pro Mode: the average market cap the held position was bought at, drawn as a dashed line. */
  entry?: number | null;
  /**
   * The whole view's span, when `points` cover only the zoomed window of it (the token view reads
   * them finer as it zooms); the points' own span without it.
   */
  extent?: { t0: number; t1: number };
  /** The zoomed window, when the caller keeps it (with onZoom); else the chart keeps its own. */
  zoom?: Zoom | null;
  onZoom?: (zoom: Zoom | null) => void;
  /** A line, or candles from the candles' highs and lows (user ask 2026-10-18). */
  kind?: ChartKind;
  /** Shows the Line / Candles switch under the chart. */
  onKind?: (kind: ChartKind) => void;
  /**
   * Experimental (Customize › Token chart): the predicted price path from the latest reading,
   * drawn dotted with its band past the line's end. The time axis makes room for it.
   */
  path?: PathStep[];
}) {
  const id = useId().replace(/:/g, "");
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(640);
  /** The point under the pointer, and the pointer's x in the box (the candle view reads the candle there). */
  const [hover, setHover] = useState<{ i: number; cx: number } | null>(null);
  /** The volume bar under the pointer (or last tapped): its slice. */
  const [bar, setBar] = useState<number | null>(null);
  // Zoom (user ask 2026-10-18): the wheel, a drag, a pinch or the buttons under the chart.
  const [ownZoom, setOwnZoom] = useState<Zoom | null>(null);
  // Candle timeframes (user ask 2026-10-18): null draws as many candles as fit (Auto).
  const [timeframe, setTimeframe] = useState<number | null>(readTimeframe);
  const zoom = onZoom ? (zoomProp ?? null) : ownZoom;
  const setZoom = onZoom ?? setOwnZoom;
  /** Phones dock the readout under the chart. */
  const docked = useSyncExternalStore(subscribePhone, isPhone, () => false);
  /**
   * A drag panning the zoomed window, or a two-finger pinch: where it started. "touch" is one finger
   * down on a zoomed chart, not yet a pan (it moves), a tap (it lifts) or a read (it holds).
   */
  const gesture = useRef<
    | { kind: "pan"; x: number; win: { from: number; to: number } }
    | { kind: "touch"; x: number; win: { from: number; to: number } }
    | { kind: "pinch"; dist: number; mid: number; win: { from: number; to: number } }
    | null
  >(null);
  /** The touches down on the chart, by pointer, for a pinch. */
  const touches = useRef(new Map<number, { x: number; y: number }>());
  /** The hold that turns a finger on a zoomed chart into a read. */
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endHold = () => {
    if (hold.current !== null) clearTimeout(hold.current);
    hold.current = null;
  };
  useEffect(() => endHold, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(260, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ext0 = extent?.t0 ?? points[0]?.t ?? 0;
  const pathShown = live && path.length > 1;
  const ext1 = extent?.t1 ?? points[points.length - 1]?.t ?? 0;
  const plotW = width - PAD.l - PAD.r;

  const geo = useMemo(() => {
    if (points.length < 2) return null;
    const { from: t0, to: t1 } = zoomWindow(zoom, ext0, ext1);
    const pts = clipPoints(points, t0, t1);
    if (pts.length < 2) return null;
    const zoomed = zoom !== null;
    const step = stepMs ?? Math.max(1, (t1 - t0) / (pts.length - 1));
    const lead = events[0];
    const leadShown = lead !== undefined && lead.t >= t0 && lead.t <= t1;
    const base = leadShown && lead.mcap ? lead.mcap : pts[0]!.v;
    // The candles and the volume lane share slots of one timeframe on round times (since the
    // epoch, or the First 15m view's launch), so each candle sits over its volume and keeps its
    // place as new readings arrive: only the slot now forming changes (user ask 2026-10-18: on All
    // the candles re-cut every second while the slots were even slices of the moving window).
    // Auto picks the narrowest timeframe that fits about AUTO_CANDLE_PX per candle (6px per bar
    // for the line's volume lane), never finer than the finest candles in view; a picked one
    // draws as itself unless the data or the screen can't.
    const inView = candles.filter((k) => k.t + (k.w ?? 60_000) > t0 && k.t < t1);
    const finest = inView.reduce((w, k) => Math.min(w, k.w ?? 60_000), inView.length ? 60_000 : 1_000);
    const maxBars = Math.max(1, Math.floor(plotW / (kind === "candles" ? AUTO_CANDLE_PX : 6)));
    let tfMs = candleTimeframe(finest, finest, t1 - t0, maxBars, AUTO_TIMEFRAMES_MS);
    /** Why the drawn timeframe is wider than the one picked: coarser data in view, or too many. */
    let tfWider: "data" | "fit" | null = null;
    if (kind === "candles" && timeframe !== null) {
      tfMs = candleTimeframe(timeframe, finest, t1 - t0, Math.max(1, Math.floor(plotW / MIN_CANDLE_PX)));
      if (tfMs > timeframe)
        tfWider = finest > timeframe && tfMs === candleTimeframe(finest, 0, 0, 1) ? "data" : "fit";
    }
    // The whole view's candles start with the coin's first candle, which opens before the line's
    // first point (a close, at its candle's end).
    const atStart = !zoomed || t0 <= ext0 + 1;
    const firstStart = candles.reduce((m, k) => Math.min(m, k.t), Infinity);
    const c0 = kind === "candles" && atStart && firstStart < t0 && firstStart > t0 - tfMs ? firstStart : t0;
    const { start: slot0, n: slices } = timeframeSlots(c0, t1, tfMs, origin);
    const slotMs = tfMs;
    // The candle view's time axis runs over whole slots, so the candles fill the plot edge to edge
    // (user ask 2026-10-18); the line's runs over the window itself.
    const d0 = kind === "candles" ? slot0 : t0;
    const d1 = kind === "candles" ? slot0 + slices * slotMs : t1;
    // A predicted path gets a zone of its own past the view's end (user ask 2026-10-18): drawn to
    // the same time scale its minute was a sliver on any view longer than a few minutes.
    const future = pathShown && t1 >= ext1 - 1;
    const futureW = future ? Math.round(Math.min(160, Math.max(56, plotW * 0.16))) : 0;
    const histW = plotW - futureW;
    const x = (t: number) => PAD.l + ((t - d0) / Math.max(1, d1 - d0)) * histW;
    // Candles: the real ones with the live curve's ticks folded into the one forming and run on
    // past it; without real ones (scan readings), the readings alone. Quiet slots between them
    // are drawn flat, so the candles run unbroken.
    const bars =
      kind === "candles"
        ? fillFlat(ohlcBars(liveCandles(candles, pts), slot0, d1, slices), slot0, slotMs)
        : null;
    const values = pts.map((p) => p.v);
    const wicks = bars ? bars.flatMap((b) => (b ? [b.h, b.l] : [])) : [];
    // Zoomed, the axis fits what is in the window alone; the whole view also keeps the baseline
    // and the trader's entry (what their PnL is measured from) in sight.
    const extra = zoomed ? [] : [base, ...(entry !== null && entry > 0 ? [entry] : [])];
    // The predicted line stays in sight; its band may run off the plot.
    const guessed = future ? path.map((s) => s.v) : [];
    const lo = Math.min(...values, ...wicks, ...extra, ...guessed);
    const hi = Math.max(...values, ...wicks, ...extra, ...guessed);
    const axis = mcapAxis(lo, hi, PAD.t, height - PAD.b);
    const hiIdx = pts.reduce((best, p, i) => (p.v > pts[best]!.v ? i : best), 0);
    return {
      t0,
      t1,
      d0,
      d1,
      future,
      histW,
      pts,
      zoomed,
      step,
      x,
      axis,
      base,
      fromAlert: leadShown && !!lead.mcap,
      hiIdx,
      slices,
      slot0,
      slotMs,
      tfMs: kind === "candles" && timeframe !== null ? tfMs : null,
      /** The width Auto draws, named in the picker. */
      autoMs: tfMs,
      tfWider,
      bars,
    };
  }, [
    points,
    zoom,
    ext0,
    ext1,
    stepMs,
    plotW,
    height,
    events,
    entry,
    candles,
    kind,
    timeframe,
    origin,
    path,
    pathShown,
  ]);

  const vols = useMemo(
    () =>
      geo && candles.some((k) => k.vol > 0)
        ? volumeBars(candles, geo.slot0, geo.slot0 + geo.slices * geo.slotMs, geo.slices)
        : null,
    [geo, candles],
  );

  // The window as the wheel handler reads it: set on each render, and by the handler itself, so
  // wheel events between renders build on each other.
  const winRef = useRef({ from: 0, to: 0, t0: 0, t1: 0 });
  const setZoomRef = useRef(setZoom);
  useEffect(() => {
    setZoomRef.current = setZoom;
    if (geo) winRef.current = { from: geo.t0, to: geo.t1, t0: ext0, t1: ext1 };
  });
  const hasGeo = geo !== null;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const w = winRef.current;
      const box = el.getBoundingClientRect();
      const pw = box.width - PAD.l - PAD.r;
      if (pw <= 0 || w.t1 <= w.t0) return;
      const zoomed = w.to - w.from < w.t1 - w.t0 - 1;
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      let next: Zoom | null;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // A sideways swipe on a trackpad pans a zoomed window.
        if (!zoomed) return;
        next = panBy(w, w.t0, w.t1, ((e.deltaX * unit) / pw) * (w.to - w.from));
      } else {
        // Zoomed all the way out, scrolling down scrolls the page as before.
        if (e.deltaY === 0 || (e.deltaY > 0 && !zoomed)) return;
        const at = Math.min(1, Math.max(0, (e.clientX - box.left - PAD.l) / pw));
        const factor = Math.exp(Math.max(-1, Math.min(1, (e.deltaY * unit) / 300)));
        next = zoomBy(w, w.t0, w.t1, factor, at);
      }
      e.preventDefault();
      winRef.current = { ...w, from: next?.from ?? w.t0, to: next?.to ?? w.t1 };
      setHover(null);
      setZoomRef.current(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasGeo]);

  if (!geo) return null;
  const { x, axis, pts } = geo;
  const span = geo.t1 - geo.t0;
  const win = { from: geo.t0, to: geo.t1 };
  const zoomed = geo.zoomed;
  const atMin = span <= Math.min(MIN_ZOOM_MS, ext1 - ext0) + 1;
  // Whether the window runs to the view's end: zoomed off it, the end tag is the window's last
  // reading and the latest goes under it as "NOW:".
  const atEnd = geo.t1 >= ext1 - 1;
  const bottom = height - PAD.b;
  const lane = vols ? LANE : 0;
  const fullH = height + lane;
  const px = (p: Point) => x(p.t);
  const py = (p: Point) => axis.y(p.v);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(" ");
  const baseY = axis.y(geo.base);
  // Zoomed in, the baseline can sit outside the window: the area then runs to the plot's edge.
  const baseIn = baseY >= PAD.t - 2 && baseY <= bottom + 2;
  const areaY = Math.min(bottom, Math.max(PAD.t, baseY));
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const area = `${line} L${px(last).toFixed(1)},${areaY.toFixed(1)} L${px(first).toFixed(1)},${areaY.toFixed(1)} Z`;
  // Where the baseline falls in the plot's height, for the colour split of the line and the area.
  const split = Math.min(1, Math.max(0, (baseY - PAD.t) / (bottom - PAD.t)));
  const up = last.v >= geo.base;
  const lastY = py(last);
  const ended = !live || !atEnd;

  const shown = events.filter((e) => e.t >= geo.t0 && e.t <= geo.t1);
  const lead = shown[0];
  // Round times along the axis (on the minute, the quarter hour...), as many as fit their labels:
  // seconds on a view of seconds, the time since launch on the First 15m view.
  const fine = stepMs !== undefined && stepMs < 60_000;
  const tickLabel = (t: number, step: number) =>
    origin !== undefined ? sinceLabel(t - origin) : timeLabel(t, span, step < 60_000);
  // A label's width, from its length at the axis's 12px (a little generous, so they never touch).
  const textW = (text: string) => text.length * 7.4 + 6;
  const labelW = textW(tickLabel(geo.t0, stepMs ?? 60_000)) + 16;
  // With a predicted path, the history's axis ends where the path's zone begins.
  const edge = geo.future ? PAD.l + geo.histW : width - PAD.r;
  const right = geo.future ? edge - 4 : width;
  const axisTicks = (() => {
    const { ticks: all, step } = timeTicks(
      geo.d0,
      geo.d1,
      Math.max(2, Math.floor(geo.histW / labelW)),
      origin,
    );
    // A label that would run off the chart's edge is pinned to it; one that would then touch the
    // label before it is left out.
    let prevEnd = -Infinity;
    return all
      .map((t) => ({ t, x: x(t), text: tickLabel(t, step) }))
      .filter((k) => k.x >= PAD.l - 1 && k.x <= edge + 1)
      .map((k) => {
        const w = textW(k.text);
        const anchor: "start" | "end" | "middle" =
          k.x - w / 2 < 0 ? "start" : k.x + w / 2 > right ? "end" : "middle";
        const lo = anchor === "start" ? k.x - 4 : anchor === "end" ? k.x - w : k.x - w / 2;
        return { ...k, anchor, lo, hi: lo + w };
      })
      .filter((k) => {
        if (k.lo < prevEnd + 8) return false;
        prevEnd = k.hi;
        return true;
      });
  })();
  // Value ticks that would sit under the latest value's or the baseline's tag are left out.
  // Model View cut off before now: the latest reading goes under the end tag, or over it when
  // the baseline's tag sits below.
  const nowTag =
    ended && now !== undefined && now > 0
      ? (() => {
          const text = `NOW: ${axisUsd(now)}`;
          const w = Math.max(PAD.r - 4, Math.round(text.length * 6.1 + 14));
          const below = lastY + 22;
          const clash = geo.fromAlert && Math.abs(baseY - below) < 20;
          const y = clash || below > bottom ? lastY - 22 : below;
          return { text, w, y, up: now >= geo.base };
        })()
      : null;
  const tags = [lastY, ...(geo.fromAlert && baseIn ? [baseY] : []), ...(nowTag ? [nowTag.y] : [])];
  const ticks = axis.ticks.filter((v) => tags.every((y) => Math.abs(axis.y(v) - y) > 18));
  const h = hover !== null ? pts[hover.i] : undefined;
  const peak = pts[geo.hiIdx]!;
  // The peak gets a label unless it is the latest point (its tag already says it) or right by it,
  // and not in Model View, where the window's high isn't the coin's peak.
  const showPeak =
    seenUntil === undefined &&
    !zoomed &&
    pts.length > 2 &&
    geo.hiIdx < pts.length - 1 &&
    Math.abs(py(peak) - lastY) > 16;
  // Above its point the label would sit under a flag along the top ("Called"), so it goes below.
  const peakBelow = py(peak) - 9 < PAD.t + 6 && shown.some((e) => Math.abs(x(e.t) - px(peak)) < 70);

  const pick = (clientX: number) => {
    const box = boxRef.current?.getBoundingClientRect();
    if (!box) return;
    const cx = clientX - box.left;
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(px(pts[i]!) - cx) < Math.abs(px(pts[best]!) - cx)) best = i;
    }
    setHover({ i: best, cx });
  };
  // A slot's width on screen, and where slot i starts (the volume lane and the candles share them).
  const sliceW = (geo.slotMs / Math.max(1, geo.d1 - geo.d0)) * geo.histW;
  const slotX = (i: number) => x(geo.slot0 + i * geo.slotMs);
  // The candle view reads out the candle under the pointer: its open, high, low and close.
  const hBarIdx =
    hover && geo.bars
      ? Math.min(geo.slices - 1, Math.max(0, Math.floor((hover.cx - slotX(0)) / sliceW)))
      : null;
  const hb = hBarIdx !== null ? (geo.bars?.[hBarIdx] ?? null) : null;
  const hx = hb && hBarIdx !== null ? slotX(hBarIdx + 0.5) : h ? px(h) : 0;
  const hv = hb ? hb.c : (h?.v ?? 0);
  const hUp = h ? hv >= geo.base : true;
  const winTo = (z: Zoom | null) => {
    setHover(null);
    setZoom(z);
  };
  // The buttons zoom about the middle, or hold the latest reading in view when the window ends on it.
  const anchorAt = atEnd && live ? 1 : 0.5;
  // A picked timeframe zooms the window to fit its candles, about PICKED_CANDLE_PX wide, holding
  // the latest in view when the window ends on it.
  const pickTimeframe = (ms: number | null) => {
    setTimeframe(ms);
    keepTimeframe(ms);
    if (ms === null) return;
    const target = Math.max(MIN_ZOOM_MS, ms * Math.max(8, Math.round(plotW / PICKED_CANDLE_PX)));
    winTo(zoomBy(win, ext0, ext1, target / Math.max(1, span), atEnd ? 1 : 0.5));
  };
  // The volume lane: a bar per slice rising from its floor, green where the price rose across it.
  const laneTop = bottom + 8;
  const laneBottom = laneTop + LANE - 10;
  const volMax = vols ? Math.max(1e-9, ...vols.map((b) => b?.usd ?? 0)) : 1;
  const mark = bar !== null && vols ? (vols[bar] ?? undefined) : undefined;
  const hFlow = h ? flowAt(flow, h.t - 60_000, h.t) : null;
  // The model's scans in view, and the one nearest the hovered point (within a point's width or so).
  const shownScans = scans.filter((s) => s.t >= geo.t0 && s.t <= geo.t1);
  const hScan = h
    ? (shownScans
        .filter((s) => Math.abs(s.t - h.t) <= Math.max(geo.step, 15_000))
        .sort((a, b) => Math.abs(a.t - h.t) - Math.abs(b.t - h.t))[0] ?? null)
    : null;

  // The labeled wallets' trades in view, and those by the hovered point.
  const shownMarks = marks.filter((m) => m.t >= geo.t0 && m.t <= geo.t1);
  const hMarks = h ? shownMarks.filter((m) => Math.abs(m.t - h.t) <= Math.max(geo.step, 5_000)) : [];
  // The trader's own trades in view, and those by the hovered point.
  const shownTrades = trades.filter((tr) => tr.t >= geo.t0 && tr.t <= geo.t1);
  const hTrades = h ? shownTrades.filter((tr) => Math.abs(tr.t - h.t) <= Math.max(geo.step, 5_000)) : [];
  // The predicted path in view, from the line's end: the dotted guess and its band, clipped to the plot.
  // The predicted path in its zone past the view's end: the dotted guess and its band, clipped to
  // the plot, from the latest reading (in the candle view, from the forming candle's slot end).
  const guess = (() => {
    if (!geo.future) return null;
    const p0 = path[0]!;
    const steps = path.slice(1).filter((s) => s.t > p0.t);
    if (steps.length === 0) return null;
    const end = steps[steps.length - 1]!;
    const zx = PAD.l + geo.histW;
    const fx = (t: number) => zx + ((t - p0.t) / Math.max(1, end.t - p0.t)) * (plotW - geo.histW);
    const clampY = (v: number) => Math.min(bottom, Math.max(PAD.t, axis.y(v)));
    const at = (t: number, y: number) => `${fx(t).toFixed(1)},${y.toFixed(1)}`;
    const head = `${zx.toFixed(1)},${lastY.toFixed(1)}`;
    const lead = px(last) < zx - 1 ? `M${px(last).toFixed(1)},${lastY.toFixed(1)} L${head}` : `M${head}`;
    return {
      zx,
      line: `${lead} ${steps.map((s) => `L${at(s.t, axis.y(s.v))}`).join(" ")}`,
      band: `M${head} ${steps.map((s) => `L${at(s.t, clampY(s.hi))}`).join(" ")} ${[...steps]
        .reverse()
        .map((s) => `L${at(s.t, clampY(s.lo))}`)
        .join(" ")} Z`,
      dots: steps.map((s) => ({ cx: fx(s.t), cy: axis.y(s.v) })),
      endX: fx(end.t),
      // The label sits under the band's end, or over it when the band runs to the plot's foot.
      labelY: clampY(end.lo) + 14 <= bottom ? clampY(end.lo) + 14 : clampY(end.hi) - 6,
      secs: Math.round((end.t - p0.t) / 1_000),
      change: end.v / p0.v - 1,
    };
  })();
  const entryAt = entry !== null && entry > 0 ? axis.y(entry) : null;
  // What the point under the pointer reads: in a box beside it, or on a phone, under the chart.
  const hoverLines =
    h && !mark ? (
      <>
        <span className="faint">
          {origin !== undefined && <span className="num">{sinceLabel(h.t - origin)} after launch · </span>}
          {hb
            ? `${timeLabel(hb.from, span > 36 * 3_600_000 ? span : 0, fine)}–${timeLabel(hb.to, 0, fine)}`
            : timeLabel(h.t, span > 36 * 3_600_000 ? span : 0, fine)}
        </span>
        <strong className="num">{usd(hv)}</strong>
        {lead?.mcap ? (
          <span className={`num pc-chg ${hv >= lead.mcap ? "up" : "down"}`}>
            {signedPct(change(lead.mcap, hv))} vs {lead.label.toLowerCase()}
          </span>
        ) : null}
        {hb &&
          (hb.flat ? (
            <span className="faint">No trades: the price held</span>
          ) : (
            <span className="num faint">
              O {axisUsd(hb.o)} · H {axisUsd(hb.h)} · L {axisUsd(hb.l)} · C {axisUsd(hb.c)}
            </span>
          ))}
        {hScan && (
          <span className="pc-scan-line">
            <i className="tm-scan-dot" aria-hidden="true" /> Scan the model read: {usd(hScan.v)} at{" "}
            {timeLabel(hScan.t, 0, true)}
          </span>
        )}
        {hMarks.slice(0, MAX_TIP_MARKS).map((m, i) => (
          <span key={`m-${i}`} className={`pc-mark-line wk-${m.kind}`}>
            <i className={`pc-mark-dot ${m.side}`} aria-hidden="true" /> {m.text}
          </span>
        ))}
        {hMarks.length > MAX_TIP_MARKS && (
          <span className="faint small">+{hMarks.length - MAX_TIP_MARKS} more labeled trades here</span>
        )}
        {hTrades.map((tr, i) => (
          <span key={i} className={`num pc-trade-line ${tr.side === "buy" ? "up" : "down"}`}>
            {tr.text}
          </span>
        ))}
        {hFlow && <FlowLine flow={hFlow} />}
      </>
    ) : null;
  const entryY = entryAt !== null && entryAt >= PAD.t - 2 && entryAt <= bottom + 2 ? entryAt : null;

  return (
    <div className="pc" ref={boxRef}>
      <svg
        ref={svgRef}
        width={width}
        height={fullH}
        viewBox={`0 0 ${width} ${fullH}`}
        className={`pc-svg${zoomed ? " zoomed" : ""}`}
        role="img"
        aria-label={ariaLabel}
        onPointerMove={(e) => {
          let g = gesture.current;
          if (g?.kind === "touch") {
            // Still a tap until the finger moves: then it drags the window along.
            if (Math.abs(e.clientX - g.x) < DRAG_PX) return;
            endHold();
            g = gesture.current = { kind: "pan", x: g.x, win: g.win };
            setHover(null);
          }
          if (g?.kind === "pan") {
            const dt = -((e.clientX - g.x) / plotW) * (g.win.to - g.win.from);
            setZoom(panBy(g.win, ext0, ext1, dt));
            return;
          }
          if (touches.current.has(e.pointerId))
            touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (g?.kind === "pinch") {
            const [a, b] = [...touches.current.values()];
            const box = boxRef.current?.getBoundingClientRect();
            if (!a || !b || !box) return;
            // The moment under the fingers' first middle stays under their middle as they move.
            const mid = (a.x + b.x) / 2;
            const at = Math.min(1, Math.max(0, (g.mid - box.left - PAD.l) / plotW));
            const z = zoomBy(g.win, ext0, ext1, g.dist / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), at);
            const w = z ?? { from: ext0, to: ext1 };
            setZoom(z && panBy(w, ext0, ext1, -((mid - g.mid) / plotW) * (w.to - w.from)));
            return;
          }
          pick(e.clientX);
        }}
        onPointerDown={(e) => {
          setBar(null);
          if (e.pointerType === "touch") {
            touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
            const [a, b] = [...touches.current.values()];
            if (a && b && touches.current.size === 2) {
              endHold();
              gesture.current = {
                kind: "pinch",
                dist: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
                mid: (a.x + b.x) / 2,
                win,
              };
              setHover(null);
              return;
            }
            if (zoomed && touches.current.size === 1) {
              // One finger on a zoomed chart drags it along; held still, it reads the chart instead.
              const at = e.clientX;
              gesture.current = { kind: "touch", x: at, win };
              endHold();
              hold.current = setTimeout(() => {
                hold.current = null;
                if (gesture.current?.kind !== "touch") return;
                gesture.current = null;
                pick(at);
              }, HOLD_MS);
              return;
            }
          } else if (e.button === 0 && zoomed) {
            // A mouse drag on a zoomed chart pans it.
            e.currentTarget.setPointerCapture?.(e.pointerId);
            gesture.current = { kind: "pan", x: e.clientX, win };
            setHover(null);
            return;
          }
          pick(e.clientX);
        }}
        onPointerUp={(e) => {
          touches.current.delete(e.pointerId);
          endHold();
          // A finger lifted before it moved or held: a tap, which reads the point under it.
          if (gesture.current?.kind === "touch") pick(e.clientX);
          if (gesture.current?.kind !== "pinch" || touches.current.size < 2) gesture.current = null;
        }}
        onPointerCancel={(e) => {
          touches.current.delete(e.pointerId);
          endHold();
          gesture.current = null;
        }}
        onDoubleClick={() => winTo(null)}
        onPointerLeave={(e) => {
          // A tapped readout (price or bar) stays up after the finger lifts, until the next tap.
          if (e.pointerType !== "mouse") return;
          setHover(null);
          setBar(null);
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
        {axisTicks.map((k) => (
          <g key={k.t}>
            <line x1={k.x} x2={k.x} y1={bottom} y2={bottom + 4} className="pc-grid" />
            <text
              x={k.anchor === "start" ? Math.max(0, k.x - 4) : k.x}
              y={fullH - 6}
              className="pc-tick"
              textAnchor={k.anchor}
            >
              {k.text}
            </text>
          </g>
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

        {seenUntil !== undefined && seenUntil < geo.t1 && (
          <g className="pc-unseen" aria-hidden="true">
            <rect
              x={Math.max(PAD.l, x(seenUntil))}
              y={PAD.t - 6}
              width={width - PAD.r - Math.max(PAD.l, x(seenUntil))}
              height={bottom - PAD.t + 6}
            />
          </g>
        )}

        {!geo.bars && <path d={area} fill={`url(#${id}-area)`} />}
        {baseIn && <line x1={PAD.l} x2={width - PAD.r} y1={baseY} y2={baseY} className="pc-base" />}
        {geo.bars ? (
          <g className="pc-candles" aria-hidden="true">
            {geo.bars.map((b, i) => {
              if (!b) return null;
              const cx = slotX(i + 0.5);
              // A timeframe's first or last slot can start before the window or end after it.
              if (cx < PAD.l || cx > width - PAD.r) return null;
              const bw = candleBodyW(sliceW);
              const yo = axis.y(b.o);
              const yc = axis.y(b.c);
              const dir = b.flat ? "flat" : b.c >= b.o ? "up" : "down";
              return (
                <g key={i} className={`pc-candle ${dir}${hBarIdx === i ? " on" : ""}`}>
                  <line x1={cx} x2={cx} y1={axis.y(b.h)} y2={axis.y(b.l)} />
                  <rect
                    x={cx - bw / 2}
                    y={Math.min(yo, yc)}
                    width={bw}
                    height={Math.max(1, Math.abs(yo - yc))}
                  />
                </g>
              );
            })}
          </g>
        ) : (
          <path d={line} className="pc-line" stroke={`url(#${id}-stroke)`} />
        )}

        {guess && (
          <g className="pc-path">
            <title>
              {`Experimental predicted path: ${signedPct(guess.change * 100, 1)} over the next ${guess.secs}s in 5-second steps, with the band the price landed in about 8 times in 10 in testing. A statistical guess from the last minute's trading, often wrong; not advice.`}
            </title>
            <line x1={guess.zx} x2={guess.zx} y1={PAD.t - 6} y2={bottom} className="pc-path-edge" />
            <text x={(guess.zx + guess.endX) / 2} y={fullH - 6} textAnchor="middle" className="pc-tick">
              {plotW - geo.histW >= 90 ? `next ${guess.secs}s` : `+${guess.secs}s`}
            </text>
            <path d={guess.band} className="pc-path-band" />
            <path d={guess.line} className="pc-path-line" />
            {guess.dots.map((d, i) => (
              <circle key={i} cx={d.cx} cy={d.cy} r={1.6} className="pc-path-dot" />
            ))}
            {/* Too narrow to label without covering the line: the caption under the chart says it. */}
            {guess.endX - guess.zx >= 110 && (
              <text
                x={Math.min(width - PAD.r - 4, guess.endX)}
                y={Math.max(PAD.t + 8, guess.labelY)}
                textAnchor="end"
                className="pc-path-label"
              >
                Predicted (experimental)
              </text>
            )}
          </g>
        )}

        {shownScans.map((s) => (
          <circle
            key={`scan-${s.t}`}
            cx={x(s.t)}
            cy={axis.y(valueAt(pts, s.t) ?? s.v)}
            r={hScan === s ? 3.5 : 2.5}
            className="pc-scan"
          />
        ))}

        {shownMarks.length > 0 && (
          <g className="pc-marks" aria-hidden="true">
            {shownMarks.map((m, i) => {
              const r = markRadius(m.sol);
              const on = hMarks.includes(m);
              return (
                <g
                  key={`mark-${m.t}-${m.wallet}-${i}`}
                  className={`pc-mark wk-${m.kind} ${m.side}${on ? " on" : ""}`}
                  transform={`translate(${x(m.t).toFixed(1)},${axis.y(valueAt(pts, m.t) ?? last.v).toFixed(1)})`}
                >
                  <circle r={r} />
                  <text dy="0.35em" textAnchor="middle" fontSize={r >= 8 ? 9.5 : 8}>
                    {m.letter}
                  </text>
                </g>
              );
            })}
          </g>
        )}

        {entryY !== null && (
          <g className="pc-entry">
            <line x1={PAD.l} x2={width - PAD.r} y1={entryY} y2={entryY} />
            <text x={PAD.l + 4} y={entryY - 5}>
              Your entry {axisUsd(entry!)}
            </text>
          </g>
        )}

        {shownTrades.map((tr, i) => {
          const cx = x(tr.t);
          const cy = axis.y(valueAt(pts, tr.t) ?? last.v);
          const buy = tr.side === "buy";
          // A buy's arrow points up at the line from below it, a sale's down at it from above.
          const tip = buy ? cy + 4 : cy - 4;
          const base = buy ? cy + 13 : cy - 13;
          return (
            <g key={`trade-${tr.t}-${i}`} className={`pc-trade ${buy ? "buy" : "sell"}`}>
              <path d={`M${cx},${tip} L${cx - 5.5},${base} L${cx + 5.5},${base} Z`} />
              <text x={cx} y={buy ? base + 10 : base - 4} textAnchor="middle">
                {buy ? "B" : "S"}
              </text>
            </g>
          );
        })}

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
              const sx = slotX(i);
              if (sx + sliceW / 2 < PAD.l || sx + sliceW / 2 > width - PAD.r) return null;
              const hb = Math.max(2, (b.usd / volMax) * (laneBottom - laneTop));
              // Thin bars even when a short view has few minutes: a wide block reads as a level, not a bar.
              // As wide as the candle over it in the candle view; thin bars under a line.
              const bw = geo.bars ? candleBodyW(sliceW) : Math.min(14, Math.max(1.5, sliceW - 1.5));
              return (
                <g key={i}>
                  <rect
                    className={`pc-vol-bar ${b.c >= b.o ? "up" : "down"}${bar === i ? " on" : ""}`}
                    x={sx + (sliceW - bw) / 2}
                    width={bw}
                    y={laneBottom - hb}
                    height={hb}
                    rx={1}
                  />
                  {/* The hit target spans the whole lane, so a short bar is as easy to find as a tall one. */}
                  <rect
                    className="pc-vol-hit"
                    x={sx}
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
        <g className={`pc-last ${up ? "up" : "down"}${ended ? " end" : ""}`}>
          {!ended && <circle cx={px(last)} cy={lastY} r={8} className="pc-halo" />}
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
        {geo.fromAlert && baseIn && Math.abs(baseY - lastY) > 14 && (
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
            {!hb && <circle cx={hx} cy={py(h)} r={4.5} />}
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

      {!docked && mark && bar !== null && (
        <BarTip
          bar={mark}
          flow={flowAt(flow, mark.from, mark.to)}
          x={slotX(bar + 0.5)}
          bottom={fullH - laneTop + 6}
          width={width}
        />
      )}

      {!docked && hoverLines && (
        <div className="pc-tip" style={tipPlace(hx, width)}>
          {hoverLines}
        </div>
      )}

      {docked && (
        <div className="pc-readout">
          {mark && bar !== null ? (
            <BarLines bar={mark} flow={flowAt(flow, mark.from, mark.to)} />
          ) : (
            (hoverLines ?? (
              <>
                <span className="faint">
                  {ended ? "End of view" : "Latest"} ·{" "}
                  {timeLabel(last.t, span > 36 * 3_600_000 ? span : 0, fine)}
                </span>
                <strong className="num">{usd(last.v)}</strong>
                {lead?.mcap ? (
                  <span className={`num pc-chg ${last.v >= lead.mcap ? "up" : "down"}`}>
                    {signedPct(change(lead.mcap, last.v))} vs {lead.label.toLowerCase()}
                  </span>
                ) : null}
                <span className="faint small pc-readout-hint">
                  {zoomed
                    ? "Drag to move along · hold a finger still to read a point · pinch to zoom"
                    : "Drag across the chart to read any point · pinch to zoom"}
                </span>
              </>
            ))
          )}
        </div>
      )}

      <div className="pc-tools">
        {onKind && (
          <div className="segmented small" role="radiogroup" aria-label="Chart type">
            {(
              [
                ["line", "Line"],
                ["candles", "Candles"],
              ] as const
            ).map(([k, text]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                className={kind === k ? "on" : ""}
                onClick={() => onKind(k)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        {onKind && kind === "candles" && (
          <label className="pc-tf" title="Each candle's width. Zooms to fit; Auto draws as many as fit">
            <span className="sr-only">Candle timeframe</span>
            <select
              value={timeframe ?? "auto"}
              onChange={(e) => pickTimeframe(e.target.value === "auto" ? null : Number(e.target.value))}
            >
              <option value="auto">
                {timeframe === null ? `Auto · ${timeframeLabel(geo.autoMs)}` : "Auto"}
              </option>
              {TIMEFRAMES.map((f) => (
                <option key={f.ms} value={f.ms}>
                  {f.label}
                </option>
              ))}
            </select>
            {geo.tfMs !== null && geo.tfWider && (
              <span
                className="faint small"
                title={
                  geo.tfWider === "data"
                    ? "Pump.fun's finest candles this far back"
                    : "Too many candles for this window: zoom in for the timeframe picked"
                }
              >
                {" "}
                showing {timeframeLabel(geo.tfMs)}
              </span>
            )}
          </label>
        )}
        <span className="pc-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="tm-range"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={!zoomed}
            onClick={() => winTo(zoomBy(win, ext0, ext1, 2, anchorAt))}
          >
            −
          </button>
          <button
            type="button"
            className="tm-range"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={atMin}
            onClick={() => winTo(zoomBy(win, ext0, ext1, 0.5, anchorAt))}
          >
            +
          </button>
          {zoomed && (
            <button
              type="button"
              className="tm-range"
              title="Show the whole range"
              onClick={() => winTo(null)}
            >
              Reset
            </button>
          )}
        </span>
        <span className="faint small pc-zoom-hint">
          {zoomed ? "Drag or swipe with two fingers to move along" : "Scroll or pinch on the chart to zoom"}
        </span>
      </div>
    </div>
  );
}

/**
 * A candle's body width in a slot `sliceW` px wide: the slot less a gap of about a sixth (1 to 4
 * px), so neighbours sit close and the row fills the plot, as an exchange chart's do; slots too
 * thin for a gap draw edge to edge.
 */
export function candleBodyW(sliceW: number): number {
  const gap = sliceW >= 3 ? Math.min(4, Math.max(1, sliceW / 6)) : 0;
  return Math.max(0.6, sliceW - gap);
}

/** Labeled trades the readout lists by name at most; the rest are counted. */
const MAX_TIP_MARKS = 6;

/**
 * Where a readout goes beside the point at `hx`: on its far side from the nearer edge, and on a
 * narrow chart pinned to the far corner instead, so it never runs off the screen.
 */
function tipPlace(hx: number, width: number): { left?: number; right?: number } {
  if (width < 520) return hx > width / 2 ? { left: 4 } : { right: 4 };
  return hx > width / 2 ? { right: width - hx + 14 } : { left: hx + 14 };
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
  return (
    <div className="pc-tip" style={{ top: "auto", bottom, ...tipPlace(x, width) }}>
      <BarLines bar={bar} flow={flow} />
    </div>
  );
}

/** A volume bar's readout lines: in BarTip's box, or docked under the chart on a phone. */
function BarLines({ bar, flow }: { bar: VolumeBar; flow: ScanFlow | null }) {
  const ms = bar.to - bar.from;
  // A bar of seconds reads in seconds; one of minutes, as before.
  const secs = ms < 60_000;
  const over = secs ? `${Math.round(ms / 1_000)}s` : `${Math.round(ms / 60_000)} min`;
  const many = secs ? ms > 1_000 : ms > 60_000;
  return (
    <>
      <span className="faint">
        {timeLabel(bar.from, 0, secs)}
        {many ? `–${timeLabel(bar.to, 0, secs)}` : ""}
      </span>
      <strong className="num">{usd(bar.usd)} volume</strong>
      <span className={`num pc-chg ${bar.c >= bar.o ? "up" : "down"}`}>
        {signedPct(change(bar.o, bar.c))} market cap{many ? ` over ${over}` : ""}
      </span>
      {flow ? <FlowLine flow={flow} /> : <span className="faint">No buy/sell count from a scan here</span>}
    </>
  );
}

/** An axis label: usd() without the trailing zeros ($5K, $12.5K, $1M). */
export function axisUsd(v: number): string {
  return usd(v)
    .replace(/\.0+(?=[KMB]?$)/, "")
    .replace(/(\.\d*?)0+(?=[KMB]?$)/, "$1");
}
