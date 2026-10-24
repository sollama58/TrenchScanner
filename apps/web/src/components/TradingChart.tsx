import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  BaselineSeries,
  createChart,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  PriceScaleMode,
  TickMarkType,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { setAppearance, useAppearance } from "../appearance";
import {
  CHART_INDICATOR_IDS,
  chartColorReference,
  chartFlagPrice,
  chartFlagsToDraw,
  eventEmphasisColor,
  eventFlagMetrics,
  horizontalFlagPrices,
  type ChartEventKind,
  type ChartIndicatorId,
} from "../chartEvents";
import { change, signedPct, usd } from "../format";
import { flowApartFromCandle } from "../marketClock";
import { ClockIcon } from "./Icons";
import {
  autoTimeframe,
  drawTimeframe,
  buildSlots,
  closeTimeMs,
  finestCoverMs,
  fineSpan,
  slotCandle,
  slotIndex,
  slotOfTime,
  timeframeFits,
  timeframeOffered,
  type Slots,
} from "../chartBars";
import { Drawings, FIB_LEVELS, type DrawScale, type DrawTool } from "../chartDrawings";
import { bollinger, ema, rsi, sma } from "../chartIndicators";
import {
  flowAt,
  FLOW_WINDOW_MS,
  TIMEFRAMES,
  timeframeLabel,
  type Point,
  type ScanFlow,
  type VolumeCandle,
} from "../priceChart";
import type { PathStep } from "../pricePathing";
import {
  BUBBLE_GRID_STEPS,
  MARK_SCALE,
  type MarkGap,
  type MarkScale,
  type MarkShape,
  type WalletMark,
} from "../walletMarks";
import {
  atLiveEnd,
  bubbleHeadroomPx,
  bubbleItems,
  gridIntervalAt,
  markAt,
  ownTradeExtentPx,
  priceGridStep,
  type PlacedMark,
} from "../chartMarkLayout";
import { API_URL } from "../api";
import { chartHistoryGrew, openingLogicalRange } from "../chartViewport";
import { openWallet } from "../walletModal";
import {
  ChartOverlay,
  picRadius,
  SlotCandleSeries,
  type MarkItem,
  type OverlayDexInfo,
  type OverlayColors,
  type OverlayState,
  type SlotCandleData,
} from "./chartPlugins";
import { slotGaps } from "./chartFeeds";
import { fillLine, type FillState } from "../browserFill";
import { KolAvatar } from "./KolAvatar";

/** A moment marked on the chart: an alert, a model's call, a filter match, the screen pass, graduation. */
export interface ChartEvent {
  t: number;
  label: string;
  /** Which Customize › Chart events switch this flag follows (chartEvents.ts). */
  kind: ChartEventKind;
  /** Market cap at the moment, when known (the readout shows the move since). */
  mcap?: number | null;
}

/** One of the Pro trader's own trades, marked at its time (Pro Mode only). */
export interface ChartTrade {
  t: number;
  side: "buy" | "sell";
  /** The readout's line for it ("You bought 1.2M for 0.5 SOL"). */
  text: string;
}

/** How the chart draws the market cap: a line (the default) or candles. */
export type ChartKind = "line" | "candles";

/** The indicators the toolbar turns on and off (HolDEX's set). Ids match chartEvents.ts. */
type Indicator = ChartIndicatorId;
const INDICATORS: { id: Indicator; label: string; title: string }[] = [
  { id: "vol", label: "Vol", title: "Volume bars" },
  { id: "ma20", label: "MA 20", title: "20-candle simple moving average" },
  { id: "ema50", label: "EMA 50", title: "50-candle exponential moving average" },
  { id: "bb", label: "BB", title: "Bollinger Bands (20, 2)" },
  { id: "rsi", label: "RSI", title: "Relative Strength Index (14), in a pane under the chart" },
];

/** A KOL picture that failed to load is tried this many times, waiting this long times the failures. */
const PIC_TRIES = 4;
const PIC_RETRY_MS = 15_000;

/** Drawings are per coin on this device. Whether they show is the appearance. */
const DRAWINGS_KEY = "ts.chartDrawings";

/** The site's phone breakpoint (styles.css). */
const PHONE_QUERY = "(max-width: 640px)";
function subscribePhone(cb: () => void): () => void {
  const mq = window.matchMedia?.(PHONE_QUERY);
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
}
function isPhone(): boolean {
  return window.matchMedia?.(PHONE_QUERY).matches ?? false;
}

/** The theme changes (Settings › Feed appearance, or the device's): the chart re-reads its colours. */
function subscribeTheme(cb: () => void): () => void {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  mq?.addEventListener("change", cb);
  return () => {
    mo.disconnect();
    mq?.removeEventListener("change", cb);
  };
}
function themeKey(): string {
  const light = window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false;
  return `${document.documentElement.dataset.theme ?? ""}|${light}`;
}

/** The time axis under the plot (the library's, at its 11px font). */
const TIME_AXIS_PX = 28;
/** The widest a candle draws when zoomed in (px), and the narrowest when zoomed out. */
const MAX_BAR_PX = 48;
const MIN_BAR_PX = 0.5;
/** A view opens with candles about this wide (px), on its newest candles when they all won't fit. */
const OPEN_BAR_PX = 4;
/** Scrolled to within this many candles (or a quarter of the view) of the oldest, the page before it is read. */
const OLDER_EDGE_BARS = 20;
/** The space past the last candle (px), and the predicted path's zone there. */
const RIGHT_PX = 24;
function pathZoneW(plotW: number): number {
  return Math.round(Math.min(160, Math.max(56, plotW * 0.16)));
}

/** The earliest candle start (ms). */
function firstStart(candles: readonly VolumeCandle[]): number {
  let t = Infinity;
  for (const k of candles) if (k.t < t) t = k.t;
  return t;
}

/** The price axis's labels: none below zero, where the axis's padding can reach. */
function scaleLabel(v: number): string {
  return v < 0 ? "" : axisUsd(v);
}

/** An axis label: usd() without the trailing zeros ($5K, $12.5K, $1M). */
export function axisUsd(v: number): string {
  return usd(v)
    .replace(/\.0+(?=[KMB]?$)/, "")
    .replace(/(\.\d*?)0+(?=[KMB]?$)/, "$1");
}

/** A time (ms) as the readout gives it: with seconds for candles under a minute, a date for long views. */
function clock(t: number, seconds: boolean, dated: boolean): string {
  const d = new Date(t);
  return d.toLocaleString([], {
    ...(dated ? { month: "short", day: "numeric" } : {}),
    hour: "numeric",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
  });
}

/** The browser's language when the date formatter takes it (some report tags it refuses). */
function safeLocale(): string {
  try {
    const l = navigator.language;
    new Intl.DateTimeFormat(l);
    return l;
  } catch {
    return "en-US";
  }
}

/**
 * Below these chart widths (px) the toolbar folds so every control stays in view: the indicators
 * into one menu, then the candle sizes into a picker.
 */
const FOLD_INDICATORS_PX = 900;
const SELECT_TIMEFRAME_PX = 600;

/**
 * A candle size button's tooltip: why a greyed-out one is (wider than the view allows, or finer
 * than the data recorded: the stretch with 1-second data is named when there is one).
 */
function timeframeTitle(
  label: string,
  ms: number,
  viewMs: number,
  offered: boolean,
  fine: { from: number; to: number } | null,
): string {
  if (offered) return `${label} candles`;
  if (!timeframeFits(ms, viewMs)) return "Wider than this view allows";
  if (!fine) return "Nothing recorded this fine for this coin yet";
  return `Recorded this fine only from ${clockLabel(fine.from)} to ${clockLabel(fine.to)}`;
}

/** Hour and minute of a moment, in the reader's clock. */
function clockLabel(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
const ICON_TOOLS_PX = 520;

const NO_MARKS: WalletMark[] = [];
const NO_TRADES: ChartTrade[] = [];
const NO_HOLES: readonly (readonly [number, number])[] = [];

/** Labeled trades the readout lists by name at most; the rest are counted. */
const MAX_TIP_MARKS = 6;

/**
 * The token view's market-cap chart (user ask 2026-10-19: HolDEX's chart, on our own candles):
 * TradingView's Lightweight Charts with a timeframe picker, candles or a baseline line, volume,
 * indicators and drawing tools, and our marks over it (alerts and model calls, the screen pass,
 * labeled wallets' trades, the trader's own trades and entry). The line is green above its
 * baseline and red below it: the trader's entry while they hold the coin, else the first marked
 * moment's market cap, else where the chart starts. A picked candle size stays as picked while
 * zooming (candles widen or thin, up to MAX_BAR_PX), for this view only: it isn't saved, so a 1s
 * picked on one coin doesn't open every coin after it on 1s (charts audit CH-2). Auto goes no finer
 * than the candles that cover most of the view. Scrolling over the chart never scrolls
 * the page. On a phone a finger drags the chart along, two pinch it, and a tap reads a candle.
 */
export function TradingChart({
  mint,
  candles,
  candlesMs,
  ticks,
  holes = NO_HOLES,
  fill = null,
  events,
  flow = [],
  marks: marksIn = NO_MARKS,
  markPics = true,
  markScale = "m",
  markShape = "circle",
  markStem = false,
  markGap = "m",
  trades: tradesIn = NO_TRADES,
  dexInfo = null,
  live = false,
  entry = null,
  extent,
  height,
  kind,
  onKind,
  onTimeframe,
  onOlder,
  path = [],
  fileName = "chart",
  ariaLabel,
}: {
  /** The coin, whose drawings are kept on this device. */
  mint: string;
  /**
   * The view's candles at the timeframe read (GET /tokens/:mint/candles), each with its width:
   * the timeframe's, or wider where only coarser data covers a stretch (drawn shaded at that width).
   */
  candles: VolumeCandle[];
  /**
   * The size `candles` were read at (GET /tokens/:mint/candles `tf`); absent for candles from
   * elsewhere. Unlike the size wanted (onTimeframe), they are the last size's until its page lands.
   */
  candlesMs?: number;
  /**
   * Readings from the newest candle's start on (the live curve's ticks, which move that forming
   * candle and run on past it), or all of them without candles.
   */
  ticks: Point[];
  /**
   * Stretches the candle store says nobody read, [from, to) in ms (GET /tokens/:mint/candles
   * `holes`): drawn blank, never flat across trades nobody recorded.
   */
  holes?: readonly (readonly [number, number])[];
  /**
   * The browser's reading of those stretches (browserFill.ts): one progress bar top left while it
   * reads, and the stretches it found nothing for (`dead`) labelled "No data recorded".
   */
  fill?: FillState | null;
  events: ChartEvent[];
  /** The scans' 5-minute buy and sell counts: the readout gives the buy share where one covers. */
  flow?: ScanFlow[];
  /** Labeled wallets' trades (KOLs, their sides, flagged wallets): lettered marks by the price. */
  marks?: WalletMark[];
  /** KOLs' marks as their X pictures, where a mark has one (Customize › Chart wallet trades). */
  markPics?: boolean;
  /** How big those marks draw: the lettered marks and the pictures (Customize › Chart wallet trades). */
  markScale?: MarkScale;
  /** Lettered wallet marks: a circle, a square or a diamond. Pictures stay round; B and S stay arrows. */
  markShape?: MarkShape;
  /** A line from each mark to the candle. Off unless the reader turns it on. */
  markStem?: boolean;
  /** How far marks sit from the candle, apart from their size. */
  markGap?: MarkGap;
  /** Pro Mode: the trader's own buys and sells. */
  trades?: ChartTrade[];
  /**
   * DexScreener token-info payment, when the orders response gave a time (user ask 2026-10-21).
   * Drawn in the same band as the trade bubbles, at that time. No bubble without a time.
   */
  dexInfo?: OverlayDexInfo | null;
  /** The view runs to now: a trade read before its candle is drawn sits on the newest candle. */
  live?: boolean;
  /** Pro Mode: the average market cap the held position was bought at, a dashed line. */
  entry?: number | null;
  /** The view's span: which timeframes fit it. */
  extent: { t0: number; t1: number };
  /** The plot's height (px), without the toolbar and the time axis. */
  height: number;
  kind: ChartKind;
  onKind: (kind: ChartKind) => void;
  /**
   * The candle size wanted (picked, or Auto's by the view's span alone), which the view reads its
   * candles at: Auto then draws no finer than the candles of that read that aren't coarse.
   */
  onTimeframe?: (ms: number) => void;
  /**
   * The reader scrolled back near the oldest candle held: read the page before it. Called again
   * on each move there; the reader drops calls while a page is on its way or none is left.
   */
  onOlder?: () => void;
  /** Experimental: the predicted price path from the latest reading, past the last candle. */
  path?: PathStep[];
  /** The saved image's name. */
  fileName?: string;
  ariaLabel: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);
  const theme = useSyncExternalStore(subscribeTheme, themeKey, () => "");
  const [width, setWidth] = useState(640);
  // The chart's own width, not the window's: a column beside it (Pro's bubble map) narrows it, and
  // the toolbar folds to fit rather than running off its edge (user ask 2026-10-19).
  const [boxW, setBoxW] = useState(1_000);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setBoxW(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fold = phone || boxW < FOLD_INDICATORS_PX;
  const tfPicker = phone || boxW < SELECT_TIMEFRAME_PX;
  // Narrower still (a wide column beside the chart), the chart type and Reset go to icons.
  const tight = !phone && boxW < ICON_TOOLS_PX;
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // The indicators' menu closes on a click outside it, and Escape closes it, not the token view.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMenu(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);
  useEffect(() => {
    if (!fold) setMenu(false);
  }, [fold]);
  /** How the crosshair's time reads, set on each render (the chart's formatter reads it). */
  const fmtRef = useRef({ seconds: false, dated: false });

  // Customize › Chart events. Vertical flags and horizontal price lines share this list: a kind
  // that is off, or the master switch, drops the flag from both.
  const look = useAppearance();
  const eventPrefs = useMemo(
    () => ({ on: look.chartEvents, kinds: look.chartEventKinds, first: look.chartEventFirst }),
    [look.chartEvents, look.chartEventKinds, look.chartEventFirst],
  );
  const shownEvents = useMemo(() => chartFlagsToDraw(events, eventPrefs), [events, eventPrefs]);
  // The candle size picked here, for this coin's view only; null (Auto) until one is picked.
  const [pick, setPick] = useState<{ mint: string; ms: number | null }>({ mint, ms: null });
  const picked = pick.mint === mint ? pick.ms : null;
  const log = look.chartLogScale;
  const ind = useMemo(() => new Set(look.chartIndicators), [look.chartIndicators]);
  const viewMs = Math.max(1, extent.t1 - extent.t0);
  const plotW = Math.max(200, width - 64);
  const finestMs = useMemo(
    () => finestCoverMs(candles, extent.t0, extent.t1),
    [candles, extent.t0, extent.t1],
  );
  const autoMs = autoTimeframe(viewMs, plotW, 6, finestMs);
  // Where the candles finer than a minute reach: a sub-minute size is offered only where there is
  // data that fine (timeframeOffered; user decision 2026-10-24).
  const fineRecorded = useMemo(() => fineSpan(candles), [candles]);
  const offered = (ms: number) =>
    timeframeFits(ms, viewMs) && timeframeOffered(ms, finestMs, fineRecorded, Date.now());
  // A picked size the view can't take (wider than it allows, or finer than its data) draws as Auto.
  const pickedMs = picked !== null && offered(picked) ? picked : null;
  // The size picked, or Auto's: what the picker shows.
  const shownMs = pickedMs ?? autoMs;
  // The view reads its candles at the size the view alone would take, not only the one drawn: the
  // store answers each stretch at that size, or coarse where it holds only wider bars, so Auto
  // draws the finest size whose candles mostly aren't coarse (finestMs). Read at the size drawn,
  // a coin whose finer candles land later would stay on the wider size.
  const wantMs = pickedMs ?? autoTimeframe(viewMs, plotW);
  // While a newly picked size's first page is on its way, the candles held stay at the size they
  // were drawn at (drawTimeframe); the chart draws the size picked once it has its candles.
  const drawnRef = useRef<number | null>(null);
  const tfMs = drawTimeframe(shownMs, wantMs, candlesMs, drawnRef.current);
  if (candlesMs === undefined || candlesMs === wantMs) drawnRef.current = tfMs;
  const slots = useMemo(
    () => buildSlots(candles, ticks, tfMs, undefined, holes),
    [candles, ticks, tfMs, holes],
  );
  useEffect(() => {
    onTimeframe?.(wantMs);
  }, [wantMs, onTimeframe]);
  // Scrolled back near the oldest candle: the page before it (full history at any timeframe, charts
  // audit 2026-10-22). Not once the slots stop short of the oldest candle (MAX_SLOTS): what came
  // before them couldn't be drawn.
  // The stretches with no data, as runs of unknown slots, for the overlay's shading and label.
  const dead = fill?.dead;
  const gaps = useMemo(() => (slots ? slotGaps(slots, dead) : []), [slots, dead]);
  const olderRef = useRef<{ ask?: () => void; whole: boolean }>({ whole: false });
  olderRef.current = {
    ask: onOlder,
    whole: !!slots && candles.length > 0 && slots.start <= Math.floor(firstStart(candles) / tfMs) * tfMs,
  };
  // A live trade is often read seconds before the candles reach it: drawn at its own time it fell
  // past the last candle, off the plot, and the bubble vanished until the next read (user report
  // 2026-10-19). It sits on the newest candle until then.
  const slotsEnd = slots ? slots.start + slots.bars.length * slots.tfMs : null;
  const marks = useMemo(() => atLiveEnd(marksIn, live ? slotsEnd : null), [marksIn, live, slotsEnd]);
  const trades = useMemo(() => atLiveEnd(tradesIn, live ? slotsEnd : null), [tradesIn, live, slotsEnd]);

  // Horizontal price flags: the same events as the vertical flags. A kind that is off is in
  // neither. The colour baseline and the "vs" readout (#835) are separate: a hidden screen pass
  // still colours the line, and the readout still names it, with no flag and no price line.
  const colorLead = useMemo(() => chartColorReference(events), [events]);
  const priceFlags = useMemo(
    () =>
      horizontalFlagPrices(shownEvents, (e) =>
        slots && e.t >= slots.start ? (slotCandle(slots, slotIndex(slots, e.t))?.c ?? null) : null,
      ),
    [shownEvents, slots],
  );
  const ref = useMemo(() => {
    if (entry !== null && entry > 0) return { v: entry, label: "your entry" };
    if (!colorLead) return null;
    const close =
      slots && colorLead.t >= slots.start
        ? (slotCandle(slots, slotIndex(slots, colorLead.t))?.c ?? null)
        : null;
    const v = chartFlagPrice(colorLead.mcap, close);
    return v !== null ? { v, label: colorLead.label.toLowerCase() } : null;
  }, [entry, colorLead, slots]);
  const base = ref?.v ?? slots?.bars[0]?.o ?? 0;

  // ── The chart ──────────────────────────────────────────────────────────
  const series = useRef<{
    main: ISeriesApi<SeriesType> | null;
    vol: ISeriesApi<"Histogram"> | null;
    lines: ISeriesApi<"Line">[];
    rsi: ISeriesApi<"Line"> | null;
    priceLines: IPriceLine[];
    entryLine: IPriceLine | null;
  }>({ main: null, vol: null, lines: [], rsi: null, priceLines: [], entryLine: null });
  const overlayRef = useRef<ChartOverlay | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  /** The mark under the mouse, or tapped (its stack: the mark and those folded into it). */
  const [pointed, setPointed] = useState<PlacedMark<MarkItem> | null>(null);
  // KOLs' pictures for the marks, loaded once each; the overlay redraws as each one lands. Loaded
  // with CORS so the canvas stays readable for the saved image.
  const pics = useRef(new Map<string, HTMLImageElement | { failed: number; at: number } | "loading">());
  const picOf = (m: WalletMark): CanvasImageSource | null => {
    const src = m.avatar;
    if (!src) return null;
    const hit = pics.current.get(src);
    if (hit instanceof HTMLImageElement) return hit;
    if (hit === "loading") return null;
    // A failed picture is tried again a while later (a busy minute's error, a dropped connection),
    // a few times: failing for good kept most KOLs as letters (user report 2026-10-20).
    if (hit && (hit.failed >= PIC_TRIES || Date.now() - hit.at < PIC_RETRY_MS * hit.failed)) return null;
    const failed = hit?.failed ?? 0;
    pics.current.set(src, "loading");
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.onload = () => {
      pics.current.set(src, img);
      overlayRef.current?.update();
    };
    img.onerror = () => pics.current.set(src, { failed: failed + 1, at: Date.now() });
    // Its own address for the CORS read: a copy the page's plain <img> (the readout, the KOL lists)
    // cached without CORS headers otherwise failed the canvas's read in some browsers.
    img.src = `${API_URL}${src}${src.includes("?") ? "&" : "?"}cors=1`;
    return null;
  };
  /** Bumped when the series are rebuilt, so the data is handed to the new ones. */
  const [built, setBuilt] = useState(0);
  const [mounted, setMounted] = useState(false);
  const lastData = useRef<{ start: number; n: number; tf: number; scope: string; extentT0: number } | null>(
    null,
  );

  const [drawTick, setDrawTick] = useState(0);
  const drawings = useMemo(
    () => new Drawings(`${DRAWINGS_KEY}.${mint}`, () => setDrawTick((n) => n + 1)),
    [mint],
  );
  const fibOn = look.chartFibLevels;
  const extendTrend = look.chartTrendExtend;
  useEffect(() => {
    drawings.setFibLevels(fibOn);
  }, [drawings, fibOn]);
  useEffect(() => {
    drawings.setExtendTrend(extendTrend);
  }, [drawings, extendTrend]);
  const markFactor = MARK_SCALE[markScale] ?? 1;
  const bubbleSteps = BUBBLE_GRID_STEPS[markGap] ?? 1;
  // The chart is rebuilt without these in its deps. The margin effect below reads them live,
  // and a rebuild reads whatever size is current.
  const markLayoutRef = useRef({ factor: markFactor, own: trades.length > 0 });
  markLayoutRef.current = { factor: markFactor, own: trades.length > 0 };
  // Headroom for the bubble band only while something is drawn there. A chart with no bubbles
  // keeps the flag margin it had (2026-10-21).
  const bubbles = marks.length > 0 || trades.length > 0 || dexInfo !== null;
  const bubblesRef = useRef(bubbles);
  bubblesRef.current = bubbles;

  const colors = useMemo(
    () => (mounted && boxRef.current ? readColors(boxRef.current) : null),
    [theme, mounted],
  );

  // Created once; the series are rebuilt when the style, the scale or the indicators change.
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        fontSize: 11,
        attributionLogo: true,
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderVisible: false, minimumWidth: 56 },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: true,
        rightOffsetPixels: RIGHT_PX,
        minBarSpacing: MIN_BAR_PX,
        maxBarSpacing: MAX_BAR_PX,
        tickMarkFormatter: (t: Time, type: TickMarkType) => tickLabel(Number(t) * 1000, type),
      },
      localization: {
        locale: safeLocale(),
        priceFormatter: scaleLabel,
        // The crosshair's time, in the viewer's own time zone.
        timeFormatter: (t: Time) => clock(Number(t) * 1000, fmtRef.current.seconds, fmtRef.current.dated),
      },
      // A vertical drag on a phone scrolls the page; a sideways one moves along the chart.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });
    chartRef.current = chart;
    // Scrolling over the chart zooms it and never scrolls the page (#851), even at the zoom's
    // limits, where the library leaves the wheel alone.
    const onWheel = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    ro.observe(el);
    setMounted(true);
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      chart.remove();
      chartRef.current = null;
      series.current = { main: null, vol: null, lines: [], rsi: null, priceLines: [], entryLine: null };
      overlayRef.current = null;
    };
  }, []);

  useEffect(() => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    const onRange = (r: LogicalRange | null) => {
      const { ask, whole } = olderRef.current;
      if (!r || !ask || !whole) return;
      if (r.from < Math.max(OLDER_EDGE_BARS, (r.to - r.from) * 0.25)) ask();
    };
    ts.subscribeVisibleLogicalRangeChange(onRange);
    return () => ts.unsubscribeVisibleLogicalRangeChange(onRange);
  }, [mounted]);

  const indKey = [...ind].sort().join(",");
  // The theme's colours, the style and the indicators: the series are made afresh.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !colors) return;
    const s = series.current;
    for (const x of [s.main, s.vol, s.rsi, ...s.lines]) if (x) chart.removeSeries(x);
    s.lines = [];
    s.vol = null;
    s.rsi = null;
    s.priceLines = [];
    s.entryLine = null;
    try {
      while (chart.panes().length > 1) chart.removePane(chart.panes().length - 1);
    } catch {
      // Nothing to remove.
    }
    chart.applyOptions({
      layout: { textColor: colors.muted, fontFamily: colors.mono },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: {
        vertLine: { color: colors.axis, labelBackgroundColor: colors.surface3 },
        horzLine: { color: colors.axis, labelBackgroundColor: colors.surface3 },
      },
    });
    const priceFormat = { type: "custom" as const, formatter: scaleLabel, minMove: 1 };
    const main =
      kind === "candles"
        ? chart.addCustomSeries(new SlotCandleSeries(), {
            upColor: colors.up,
            downColor: colors.down,
            flatColor: colors.muted,
            priceFormat,
            priceLineVisible: true,
            priceLineStyle: LineStyle.Dotted,
          })
        : chart.addSeries(BaselineSeries, {
            baseValue: { type: "price", price: 0 },
            topLineColor: colors.up,
            topFillColor1: hexA(colors.up, 0.22),
            topFillColor2: hexA(colors.up, 0.03),
            bottomLineColor: colors.down,
            bottomFillColor1: hexA(colors.down, 0.03),
            bottomFillColor2: hexA(colors.down, 0.22),
            lineWidth: 2,
            priceFormat,
            priceLineStyle: LineStyle.Dotted,
          });
    s.main = main as ISeriesApi<SeriesType>;
    const overlay = new ChartOverlay(emptyOverlay());
    main.attachPrimitive(overlay);
    overlayRef.current = overlay;
    chart.priceScale("right").applyOptions({
      mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal,
      // Headroom for the highest bubble and, when the reader has trades, the triangles under the low.
      scaleMargins: chartMargins(height, {
        bubbles: bubblesRef.current,
        vol: ind.has("vol"),
        factor: markLayoutRef.current.factor,
        own: markLayoutRef.current.own,
      }),
    });
    if (ind.has("vol")) {
      const v = chart.addSeries(HistogramSeries, {
        priceScaleId: "vol",
        priceFormat: { type: "custom", formatter: axisUsd, minMove: 1 },
        lastValueVisible: false,
        priceLineVisible: false,
      });
      v.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      s.vol = v;
    }
    const line = (color: string, style: LineStyle = LineStyle.Solid) => {
      const l = chart.addSeries(LineSeries, {
        color,
        lineWidth: 1,
        lineStyle: style,
        priceFormat,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      s.lines.push(l);
      return l;
    };
    if (ind.has("ma20")) line(colors.warn);
    if (ind.has("ema50")) line(colors.series5);
    if (ind.has("bb")) {
      line(hexA(colors.series1, 0.8));
      line(hexA(colors.series1, 0.45), LineStyle.Dashed);
      line(hexA(colors.series1, 0.8));
    }
    if (ind.has("rsi")) {
      const r = chart.addSeries(
        LineSeries,
        {
          color: colors.series1,
          lineWidth: 1,
          priceLineVisible: false,
          priceFormat: { type: "price", precision: 0, minMove: 1 },
          autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
        },
        1,
      );
      r.createPriceLine({
        price: 70,
        color: hexA(colors.down, 0.5),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
      r.createPriceLine({
        price: 30,
        color: hexA(colors.up, 0.5),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
      });
      s.rsi = r;
      try {
        chart.panes()[0]?.setStretchFactor(1);
        chart.panes()[1]?.setStretchFactor(0.3);
      } catch {
        // Older layouts: the library's split.
      }
    }
    lastData.current = null;
    setBuilt((n) => n + 1);
  }, [colors, kind, indKey, log]);

  // Headroom for the highest bubble, and room under the lowest candle for the reader's triangles.
  // Rebuilt charts set this too; this keeps a size change from waiting on a rebuild.
  useEffect(() => {
    chartRef.current?.priceScale("right").applyOptions({
      scaleMargins: chartMargins(height, {
        bubbles,
        vol: ind.has("vol"),
        factor: markFactor,
        own: trades.length > 0,
      }),
    });
  }, [built, markFactor, height, ind, bubbles, trades.length]);

  useEffect(() => {
    chartRef.current?.timeScale().applyOptions({
      rightOffsetPixels: path.length > 1 ? RIGHT_PX + pathZoneW(plotW) : RIGHT_PX,
      secondsVisible: tfMs < 60_000,
    });
  }, [path.length > 1, plotW, tfMs]);

  // The data, handed to the series; the window shown stays on the same moments as candles land.
  const [opened, setOpened] = useState(0);
  useEffect(() => {
    const chart = chartRef.current;
    const s = series.current;
    if (!chart || !s.main || !slots || !colors) return;
    const ts = chart.timeScale();
    const prev = lastData.current;
    const range = ts.getVisibleLogicalRange();
    const time = (t: number) => (t / 1000) as UTCTimestamp;
    const bars = slots.bars;
    // The line draws each close at the bucket end. Candles stay stamped at the open.
    const barTime = (t: number) => time(kind === "line" ? closeTimeMs(t, slots.tfMs) : t);
    if (kind === "candles") {
      (s.main as unknown as ISeriesApi<"Custom", Time, SlotCandleData>).setData(
        bars.map((b) =>
          b.unknown
            ? // Nobody read it: blank (whitespace), not a flat candle.
              ({ time: time(b.t) } as SlotCandleData)
            : {
                time: time(b.t),
                o: b.o,
                h: b.h,
                l: b.l,
                c: b.c,
                ...(b.flat ? { flat: true } : {}),
                ...(b.span ? { span: b.span } : {}),
                ...(b.under ? { under: b.under } : {}),
                ...(b.coarse ? { coarse: true } : {}),
              },
        ),
      );
      const last = bars[bars.length - 1];
      if (last) s.main.applyOptions({ color: last.c >= last.o ? colors.up : colors.down });
    } else {
      // The line runs through each candle's close at the end of its bucket. A wider
      // candle's close is at the end of its last slot. Plotting the close at the open put the next
      // close under a mark that sits on the real trade time.
      (s.main as ISeriesApi<"Baseline">).setData(
        bars.map((b, i) => {
          const parent = b.under ? bars[i - b.under] : b;
          const last = !bars[i + 1]?.under;
          // An unread slot breaks the line rather than drawing it flat.
          return parent && (b.span ?? 1) === 1 && last && !b.unknown
            ? { time: barTime(b.t), value: parent.c }
            : { time: barTime(b.t) };
        }),
      );
      s.main.applyOptions({ baseValue: { type: "price", price: base } });
    }
    s.vol?.setData(
      bars.flatMap((b) =>
        b.vol == null || b.unknown
          ? []
          : [
              {
                time: barTime(b.t),
                value: b.vol,
                color: hexA(b.c >= b.o ? colors.up : colors.down, 0.38),
              },
            ],
      ),
    );
    const closes = bars.map((b) => ({ time: Number(barTime(b.t)), close: b.c }));
    const asLine = (pts: { time: number; value: number }[]) =>
      pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
    // In the order the lines were added.
    const bb = ind.has("bb") ? bollinger(closes, 20, 2) : null;
    const lineData = [
      ...(ind.has("ma20") ? [sma(closes, 20)] : []),
      ...(ind.has("ema50") ? [ema(closes, 50)] : []),
      ...(bb ? [bb.upper, bb.mid, bb.lower] : []),
    ];
    lineData.forEach((d, i) => s.lines[i]?.setData(asLine(d)));
    s.rsi?.setData(asLine(rsi(closes, 14)));

    // Horizontal price flags: the same events as the vertical flags. A kind that is off is not
    // here. The earliest shown one takes the lead colour; the rest stay quiet. Labels follow
    // the same switch as the flags along the top.
    for (const line of s.priceLines) s.main.removePriceLine(line);
    if (s.entryLine) s.main.removePriceLine(s.entryLine);
    s.priceLines = [];
    s.entryLine = null;
    const emphasis = eventEmphasisColor(look.chartEventEmphasis, {
      brand: colors.overlay.eventLead,
      win: colors.up,
      loss: colors.down,
      mine: colors.series1,
    });
    const flagWidth = eventFlagMetrics(look.chartEventScale).line;
    priceFlags.forEach((flag, i) => {
      const lead = emphasis !== null && i === 0;
      s.priceLines.push(
        s.main!.createPriceLine({
          price: flag.price,
          color: lead ? emphasis : colors.muted,
          lineWidth: flagWidth,
          lineStyle: i === 0 ? LineStyle.Dotted : LineStyle.Dashed,
          axisLabelVisible: true,
          title: look.chartEventLabels && !phone ? flag.event.label : "",
        }),
      );
    });
    if (entry !== null && entry > 0)
      s.entryLine = s.main.createPriceLine({
        price: entry,
        color: colors.warn,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Your entry",
      });

    // Which window to show: a new view opens with enough history before now on screen; later reads
    // that reach further back keep the live end anchored instead of snapping to a short tail.
    const scope = `${mint}|${opened}`;
    const n = bars.length;
    const historyGrew = prev && chartHistoryGrew(prev.extentT0, extent.t0, slots.tfMs / 2);
    const tfChanged = prev && prev.tf !== slots.tfMs;
    const reset = !prev || prev.scope !== scope || !range || (tfChanged && !historyGrew);
    if (reset) {
      const { from, to } = openingLogicalRange(n, plotW, slots.tfMs, extent);
      ts.setVisibleLogicalRange({ from, to });
      if (n <= Math.ceil(to - from))
        ts.applyOptions({ rightOffsetPixels: path.length > 1 ? RIGHT_PX + pathZoneW(plotW) : RIGHT_PX });
    } else {
      const shift = (prev.start - slots.start) / slots.tfMs;
      let next: LogicalRange = {
        from: (range.from + shift) as LogicalRange["from"],
        to: (range.to + shift) as LogicalRange["to"],
      };
      if (range.to >= prev.n - 1.5) {
        const grow = n - prev.n - shift;
        next = {
          from: (next.from + grow) as LogicalRange["from"],
          to: (next.to + grow) as LogicalRange["to"],
        };
      }
      if (shift !== 0 || n !== prev.n) ts.setVisibleLogicalRange(next);
    }
    lastData.current = { start: slots.start, n, tf: slots.tfMs, scope, extentT0: extent.t0 };
  }, [
    slots,
    built,
    base,
    ref,
    entry,
    phone,
    opened,
    kind,
    extent,
    plotW,
    path.length,
    priceFlags,
    look.chartEventLabels,
    look.chartEventScale,
    look.chartEventEmphasis,
    colors,
  ]);

  // The overlay: the marks, events, path and drawings, placed through the chart's own scales.
  const closeAtEnd = kind === "line";
  const dScale = useMemo<DrawScale | null>(() => {
    if (!slots) return null;
    return {
      x: (t) => toX(chartRef.current, slots, t, closeAtEnd),
      y: (v) => series.current.main?.priceToCoordinate(v) ?? null,
      t: (x) => {
        const l = toLogical(chartRef.current, x);
        return l === null ? null : slots.start + (l + (closeAtEnd ? 1 : 0.5)) * slots.tfMs;
      },
      v: (y) => series.current.main?.coordinateToPrice(y) ?? null,
    };
  }, [slots, closeAtEnd]);
  const pointedMarks = useMemo(
    () => (pointed ? bubbleItems(pointed).flatMap((i) => (i.mark ? [i.mark] : [])) : []),
    [pointed],
  );
  const hot = useMemo(() => {
    if (pointedMarks.length > 0) return new Set(pointedMarks);
    if (hover === null || !slots) return new Set<WalletMark>();
    const from = slots.start + hover * slots.tfMs;
    return new Set(marks.filter((m) => m.t >= from && m.t < from + slots.tfMs));
  }, [hover, slots, marks, pointedMarks]);
  useEffect(() => {
    const o = overlayRef.current;
    if (!o || !slots || !colors || !dScale) return;
    const valueAt = (t: number) => {
      const end = slots.start + slots.bars.length * slots.tfMs;
      if (t < slots.start - slots.tfMs || t > end + 60_000) return null;
      return slotCandle(slots, slotIndex(slots, t))?.c ?? null;
    };
    // The candle's high is what a bubble must clear. The line has the price for both.
    const rangeAt = (t: number) => {
      const v = valueAt(t);
      if (v === null) return null;
      const k = kind === "candles" ? slotCandle(slots, slotIndex(slots, t)) : null;
      return k && !k.flat ? { lo: Math.min(k.l, v), hi: Math.max(k.h, v) } : { lo: v, hi: v };
    };
    const barsOnScreen = barScale(chartRef.current);
    const bs = barsOnScreen?.dx ?? 6;
    // The last bar's centre. On the line chart that centre is the bucket-end close.
    const lastX = barsOnScreen ? barsOnScreen.x0 + (slots.bars.length - 1) * barsOnScreen.dx : null;
    o.state = {
      x: dScale.x,
      y: dScale.y,
      valueAt,
      rangeAt,
      seriesTop: () => seriesTopY(chartRef.current, series.current.main, slots),
      column: (t) => slotIndex(slots, t),
      gridStep: (atPrice) =>
        readGridStep(
          chartRef.current,
          series.current.main,
          atPrice,
          chartRef.current?.paneSize(0).height ?? height,
        ),
      bubbleSteps,
      // The flags go under the readout's lines. Lead colour matches the horizontal price line.
      flagTop: phone ? 34 : 20,
      events: shownEvents.map((e, i) => ({
        t: e.t,
        label: e.label,
        lead: look.chartEventEmphasis !== "off" && i === 0,
      })),
      eventLabels: look.chartEventLabels,
      eventScale: eventFlagMetrics(look.chartEventScale).factor,
      marks,
      trades,
      dexInfo: dexInfo ? (atLiveEnd([dexInfo], live ? slotsEnd : null)[0] ?? null) : null,
      path,
      pathZone:
        path.length > 1 && lastX !== null ? { x0: lastX + bs / 2 + 4, w: pathZoneW(plotW) - 8 } : null,
      hot,
      pic: (m) => (markPics ? picOf(m) : null),
      markScale: markFactor,
      markShape,
      markStem,
      markGap: 1,
      // Hidden drawings stay on this device. A tool in hand still previews, or the click would
      // land on nothing.
      drawings: look.chartShowDrawings || drawings.tool || drawings.placing ? drawings : null,
      drawScale: dScale,
      label: axisUsd,
      gaps,
      edgeX: (t) => {
        const sc = barScale(chartRef.current);
        return sc ? sc.x0 + ((t - slots.start) / slots.tfMs - 0.5) * sc.dx : null;
      },
      colors: {
        ...colors.overlay,
        eventLead:
          eventEmphasisColor(look.chartEventEmphasis, {
            brand: colors.overlay.eventLead,
            win: colors.up,
            loss: colors.down,
            mine: colors.series1,
          }) ?? colors.overlay.event,
      },
    };
    o.update();
  });

  // The readout follows the crosshair; a click or tap places a drawing's point or selects one.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const onMove = (p: MouseEventParams<Time>) => {
      const l = p.logical;
      setHover(p.point && l !== undefined && l !== null ? Math.round(l) : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [built]);
  useEffect(() => {
    const el = plotRef.current;
    if (!el || !dScale) return;
    let down: { x: number; y: number; at: number; id: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const chart = chartRef.current;
      const w = chart?.timeScale().width() ?? r.width;
      const h = chart?.paneSize(0).height ?? r.height;
      return x < 0 || y < 0 || x > w || y > h ? null : { x, y };
    };
    // The library holds a second click back to see whether it is a double click, so taps are read
    // from the pointer events themselves.
    const onDown = (e: PointerEvent) => {
      if (e.button === 0) down = { x: e.clientX, y: e.clientY, at: Date.now(), id: e.pointerId };
    };
    const placedAt = (p: { x: number; y: number } | null) =>
      p ? markAt(overlayRef.current?.placed ?? [], p.x, p.y, 4) : null;
    const onUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d || d.id !== e.pointerId) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || Date.now() - d.at > 700) return;
      const p = local(e);
      if (!p) return;
      if (drawings.tool) {
        drawings.click(p.x, p.y, dScale, e.pointerType === "touch");
        return;
      }
      // A labeled wallet's mark opens that wallet (user ask 2026-10-19: marks you can act on).
      const hit = placedAt(p);
      const wallet = hit?.item.mark?.wallet;
      if (wallet || hit?.item.dex) {
        setPointed(hit);
        if (wallet) openWallet(wallet);
        return;
      }
      setPointed(null);
      if (drawings.count) drawings.click(p.x, p.y, dScale, e.pointerType === "touch");
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const p = local(e);
      if (drawings.placing) {
        if (p && drawings.move(p.x, p.y, dScale)) overlayRef.current?.update();
        return;
      }
      const hit = drawings.tool ? null : placedAt(p);
      el.classList.toggle("on-mark", !!hit?.item.mark || !!hit?.item.dex);
      setPointed((was) => (was?.item === hit?.item ? was : hit));
    };
    const onLeave = () => {
      el.classList.remove("on-mark");
      setPointed(null);
    };
    const onCancel = () => (down = null);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointercancel", onCancel);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointercancel", onCancel);
    };
  }, [dScale, drawings]);
  // Escape drops the tool in hand or the selection before it closes the token view; Delete
  // removes the selected drawing.
  const busy = !!drawings.tool || !!drawings.selectedId;
  useEffect(() => {
    if (!busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawings.cancel()) {
        e.preventDefault();
        e.stopPropagation();
      } else if ((e.key === "Delete" || e.key === "Backspace") && drawings.selectedId) {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        drawings.deleteSelected();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [busy, drawings, drawTick]);

  const pickTimeframe = (ms: number | null) => setPick({ mint, ms });
  const toggle = (id: Indicator) => {
    const has = ind.has(id);
    setAppearance({
      chartIndicators: CHART_INDICATOR_IDS.filter((k) => (k === id ? !has : ind.has(k))),
    });
  };
  const reset = () => {
    chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
    setOpened((n) => n + 1);
  };
  const saveImage = () => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.takeScreenshot().toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${fileName}-${timeframeLabel(tfMs)}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5_000);
    }, "image/png");
  };

  // ── The readout ────────────────────────────────────────────────────────
  const n = slots?.bars.length ?? 0;
  const hi = hover !== null && hover >= 0 && hover < n ? hover : n - 1;
  const cur = slots && hi >= 0 ? slotCandle(slots, hi) : null;
  const curFrom = cur && slots ? cur.t : 0;
  const curTo = cur && slots ? cur.t + (cur.span ?? 1) * slots.tfMs : 0;
  const fine = tfMs < 60_000;
  const dated = viewMs > 36 * 3_600_000;
  // The line's vertex is the bucket-end close. A one-second line labels that close; a wider
  // bucket still shows its span, which ends on the same close.
  const lineCloseLabel = closeAtEnd && (cur?.span ?? 1) === 1 && tfMs <= 1_000;
  const legendSpan = !lineCloseLabel && ((cur?.span ?? 1) > 1 || tfMs > 1_000);
  fmtRef.current = { seconds: fine, dated };
  const hFlow = cur ? flowAt(flow, curFrom, curTo) : null;
  const flowLags = hFlow != null && flowApartFromCandle(hFlow.t, curTo);
  // The marks under the pointer when it is on one, else those in the candle it is over.
  const onStack = pointed !== null;
  const stack = pointed ? bubbleItems(pointed) : [];
  const hMarks = onStack
    ? stack.flatMap((i) => (i.mark ? [i.mark] : []))
    : hover !== null && cur
      ? marks.filter((m) => m.t >= curFrom && m.t < curTo)
      : [];
  const hTrades = onStack
    ? trades.filter((tr) => stack.some((i) => i.trade?.t === tr.t && i.trade.side === tr.side))
    : hover !== null && cur
      ? trades.filter((tr) => tr.t >= curFrom && tr.t < curTo)
      : [];
  const hEvents =
    !onStack && hover !== null && cur ? shownEvents.filter((e) => e.t >= curFrom && e.t < curTo) : [];
  const hDex = onStack
    ? stack.flatMap((i) => (i.dex ? [i.dex.text] : []))
    : dexInfo && hover !== null && cur && dexInfo.t >= curFrom && dexInfo.t < curTo
      ? [dexInfo.text]
      : [];
  const up = cur ? cur.c >= cur.o : true;
  const vsRef = cur && ref ? change(ref.v, cur.c) : null;
  const tool = drawings.tool;
  const hint = tool
    ? tool === "level"
      ? `${phone ? "Tap" : "Click"} the price`
      : drawings.placing
        ? tool === "trend"
          ? `${phone ? "Tap" : "Click"} the second point`
          : `${phone ? "Tap" : "Click"} the end of the move (level 0)`
        : tool === "trend"
          ? `${phone ? "Tap" : "Click"} the start of the trendline`
          : `${phone ? "Tap" : "Click"} the start of the move (level 1)`
    : drawings.selectedId
      ? "Drawing selected. Delete removes it."
      : null;
  const showFib = tool === "fib" || drawings.selectedType === "fib";
  const showExtend = tool === "trend" || drawings.selectedType === "trend";
  // Starting a drawing shows the saved ones. Otherwise the new line would vanish when the tool
  // finished, and the click would look like it did nothing.
  const pickTool = (t: DrawTool) => {
    drawings.setTool(t);
    if (drawings.tool && !look.chartShowDrawings) setAppearance({ chartShowDrawings: true });
  };
  const toggleFib = (lv: number) => {
    const has = fibOn.some((n) => Math.abs(n - lv) < 1e-6);
    const next = has ? fibOn.filter((n) => Math.abs(n - lv) >= 1e-6) : [...fibOn, lv].sort((a, b) => a - b);
    if (!next.length) return;
    setAppearance({ chartFibLevels: next });
  };
  const toggleExtend = () => setAppearance({ chartTrendExtend: !extendTrend });
  const plotH = height + TIME_AXIS_PX + (ind.has("rsi") ? Math.round(height * 0.3) : 0);

  const rail = (
    <div className="tc-rail" role="toolbar" aria-label="Drawing tools">
      <DrawButton tool="trend" active={tool} onPick={pickTool} title="Trendline: click two points">
        <line x1="5" y1="19" x2="19" y2="5" />
        <circle cx="5" cy="19" r="2" fill="currentColor" />
        <circle cx="19" cy="5" r="2" fill="currentColor" />
      </DrawButton>
      <DrawButton
        tool="level"
        active={tool}
        onPick={pickTool}
        title={phone ? "Price level: tap the price" : "Price level: click the price"}
      >
        <line x1="3" y1="12" x2="21" y2="12" />
        <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      </DrawButton>
      <DrawButton
        tool="fib"
        active={tool}
        onPick={pickTool}
        title="Fibonacci retracement: click the start, then the end of a move"
      >
        <line x1="3" y1="4" x2="21" y2="4" />
        <line x1="3" y1="9" x2="21" y2="9" opacity=".7" />
        <line x1="3" y1="13" x2="21" y2="13" opacity=".7" />
        <line x1="3" y1="16.5" x2="21" y2="16.5" opacity=".7" />
        <line x1="3" y1="20" x2="21" y2="20" />
      </DrawButton>
      <button
        type="button"
        className="tc-tool"
        disabled={!drawings.selectedId}
        title="Delete the selected drawing (Delete key)"
        aria-label="Delete the selected drawing"
        onClick={() => drawings.deleteSelected()}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
        </svg>
      </button>
      <button
        type="button"
        className="tc-tool"
        disabled={!drawings.count}
        title="Remove all drawings on this coin"
        aria-label="Remove all drawings on this coin"
        onClick={() => {
          if (window.confirm("Remove all drawings on this coin?")) drawings.clearAll();
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );

  const indicatorChips = (
    <>
      {INDICATORS.map((i) => (
        <button
          key={i.id}
          type="button"
          className={`tc-chip${ind.has(i.id) ? " on" : ""}`}
          aria-pressed={ind.has(i.id)}
          title={i.title}
          onClick={() => toggle(i.id)}
        >
          {i.label}
          {fold && <small>{i.title.replace(/, in a pane under the chart$/, "")}</small>}
        </button>
      ))}
      <button
        type="button"
        className={`tc-chip${log ? " on" : ""}`}
        aria-pressed={log}
        title="Log scale: a big run doesn't flatten what came before it"
        onClick={() => setAppearance({ chartLogScale: !log })}
      >
        Log
        {fold && <small>Log scale: a big run doesn&apos;t flatten what came before it</small>}
      </button>
      <button
        type="button"
        className={`tc-chip${look.chartShowDrawings ? " on" : ""}`}
        aria-pressed={look.chartShowDrawings}
        title="Show trendlines, price levels and Fibonacci drawings"
        onClick={() => setAppearance({ chartShowDrawings: !look.chartShowDrawings })}
      >
        Draw
        {fold && <small>Show trendlines, price levels and Fibonacci drawings</small>}
      </button>
    </>
  );
  const toolCount = ind.size + (log ? 1 : 0) + (look.chartShowDrawings ? 1 : 0);

  return (
    <div className={`tc${phone ? " phone" : ""}${fold ? " fold" : ""}`} ref={boxRef}>
      <div className="tc-toolbar" role="toolbar" aria-label="Chart settings">
        <div className="tc-row">
          {tfPicker ? (
            <label className="tc-select" title="Candle size">
              <span className="sr-only">Candle size</span>
              <select
                value={pickedMs === null ? "auto" : String(shownMs)}
                onChange={(e) => pickTimeframe(e.target.value === "auto" ? null : Number(e.target.value))}
              >
                <option value="auto">Auto · {timeframeLabel(autoMs)}</option>
                {TIMEFRAMES.map((f) => (
                  <option key={f.ms} value={f.ms} disabled={!offered(f.ms)}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="tc-seg" role="radiogroup" aria-label="Candle size">
              <button
                type="button"
                role="radio"
                aria-checked={picked === null}
                className={pickedMs === null ? "on" : ""}
                title="Auto: a candle size that fits the whole view"
                onClick={() => pickTimeframe(null)}
              >
                {pickedMs === null ? `Auto · ${timeframeLabel(autoMs)}` : "Auto"}
              </button>
              {TIMEFRAMES.map((f) => (
                <button
                  key={f.ms}
                  type="button"
                  role="radio"
                  aria-checked={pickedMs === f.ms}
                  className={pickedMs === f.ms ? "on" : ""}
                  disabled={!offered(f.ms)}
                  title={timeframeTitle(f.label, f.ms, viewMs, offered(f.ms), fineRecorded)}
                  onClick={() => pickTimeframe(f.ms)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}
          <div className="tc-seg" role="radiogroup" aria-label="Chart type">
            {(
              [
                ["candles", "Candles"],
                ["line", "Line"],
              ] as const
            ).map(([k, text]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                aria-label={tight ? text : undefined}
                title={tight ? text : undefined}
                className={`${kind === k ? "on" : ""}${tight ? " tc-icon-btn" : ""}`}
                onClick={() => onKind(k)}
              >
                {tight ? <KindIcon kind={k} /> : text}
              </button>
            ))}
          </div>
        </div>
        <div className="tc-row">
          {fold ? (
            <div className="tc-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className={`tc-chip tc-menu-btn${toolCount > 0 ? " on" : ""}`}
                aria-expanded={menu}
                aria-haspopup="true"
                title="Indicators, scale and drawings"
                onClick={() => setMenu(!menu)}
              >
                Indicators
                {toolCount > 0 && <span className="num">{toolCount}</span>}
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  aria-hidden="true"
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
              {menu && (
                <div className="tc-menu" role="group" aria-label="Indicators">
                  {indicatorChips}
                </div>
              )}
            </div>
          ) : (
            <div className="tc-chips" role="group" aria-label="Indicators">
              {indicatorChips}
            </div>
          )}
          <div className="tc-chips">
            <button
              type="button"
              className={`tc-chip${tight ? " tc-icon" : ""}`}
              title="Back to the newest candles, price fitted"
              aria-label={tight ? "Reset the view" : undefined}
              onClick={reset}
            >
              {tight ? (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
                </svg>
              ) : (
                "Reset"
              )}
            </button>
            <button
              type="button"
              className="tc-chip tc-icon"
              title="Save the chart as an image"
              aria-label="Save the chart as an image"
              onClick={saveImage}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
              </svg>
            </button>
          </div>
          {phone && rail}
        </div>
        {(showFib || showExtend) && (
          <div className="tc-draw-opts" role="group" aria-label="Drawing options">
            {showExtend && (
              <button
                type="button"
                className={`tc-chip${extendTrend ? " on" : ""}`}
                aria-pressed={extendTrend}
                title="Run the trendline past both points"
                onClick={toggleExtend}
              >
                Extend
              </button>
            )}
            {showFib &&
              FIB_LEVELS.map((lv) => {
                const on = fibOn.some((n) => Math.abs(n - lv) < 1e-6);
                return (
                  <button
                    key={lv}
                    type="button"
                    className={`tc-chip${on ? " on" : ""}`}
                    aria-pressed={on}
                    title={`Fibonacci ${lv}`}
                    onClick={() => toggleFib(lv)}
                  >
                    {lv}
                  </button>
                );
              })}
          </div>
        )}
      </div>

      <div className="tc-body">
        {!phone && rail}

        <div className={`tc-wrap${tool ? " drawing" : ""}`} style={{ height: plotH }}>
          <div className="tc-plot" ref={plotRef} role="img" aria-label={ariaLabel} />
          {fill && <FillBar fill={fill} top={phone ? 38 : 22} />}
          {cur && (
            <div className="tc-legend num" aria-live="off">
              <span className="faint">
                {clock(lineCloseLabel ? curTo : curFrom, fine, dated)}
                {legendSpan ? `–${clock(curTo, fine, false)}` : ""}
              </span>
              {cur.unknown ? (
                <span className="faint">
                  {fill?.dead.some(([a, b]) => a <= curFrom && curFrom < b) || !fill?.doneAt
                    ? "No data recorded"
                    : "Backfilling…"}
                </span>
              ) : cur.flat ? (
                <span className="faint">
                  No trades · <b>{axisUsd(cur.c)}</b>
                </span>
              ) : (
                <>
                  <span>
                    O <b className={up ? "up" : "down"}>{axisUsd(cur.o)}</b>
                  </span>
                  <span>
                    H <b className={up ? "up" : "down"}>{axisUsd(cur.h)}</b>
                  </span>
                  <span>
                    L <b className={up ? "up" : "down"}>{axisUsd(cur.l)}</b>
                  </span>
                  <span>
                    C <b className={up ? "up" : "down"}>{axisUsd(cur.c)}</b>
                  </span>
                </>
              )}
              {vsRef !== null && ref && (
                <span className={vsRef >= 0 ? "up" : "down"}>
                  {signedPct(vsRef, 1)} vs {ref.label}
                </span>
              )}
              {cur.vol != null && cur.vol > 0 && <span>Vol {usd(cur.vol)}</span>}
              {hFlow && (
                <span
                  className={`${hFlow.buys / (hFlow.buys + hFlow.sells) >= 0.5 ? "up" : "down"}${flowLags ? " lags" : ""}`}
                  title={`${hFlow.buys} buys, ${hFlow.sells} sells in the ${FLOW_WINDOW_MS / 60_000} min to ${clock(hFlow.t, false, false)}`}
                >
                  {Math.round((hFlow.buys / (hFlow.buys + hFlow.sells)) * 100)}% buys
                  {flowLags && (
                    <span className="lag-mark">
                      <ClockIcon size={11} />
                    </span>
                  )}
                </span>
              )}
            </div>
          )}
          {(hMarks.length > 0 || hTrades.length > 0 || hEvents.length > 0 || hDex.length > 0) && (
            <div className="tc-detail">
              {hDex.map((text, i) => (
                <span key={`dex-${i}`} className="tc-detail-event">
                  {text}
                </span>
              ))}
              {hEvents.map((e, i) => (
                <span key={`e-${i}`} className="tc-detail-event">
                  {e.label}
                  {e.mcap ? ` at ${usd(e.mcap)}` : ""}
                </span>
              ))}
              {(onStack ? hMarks : hMarks.slice(0, MAX_TIP_MARKS)).map((m, i) => (
                <span key={`m-${i}`} className={`pc-mark-line wk-${m.kind}`}>
                  {markPics && m.avatar ? (
                    <KolAvatar
                      src={m.avatar}
                      className={`tc-mark-pic ${m.side} sz-${markScale}`}
                      fallback={<i className={`pc-mark-dot ${m.side}`} aria-hidden="true" />}
                    />
                  ) : (
                    <i className={`pc-mark-dot ${m.side}`} aria-hidden="true" />
                  )}{" "}
                  {m.text}
                </span>
              ))}
              {onStack && hMarks.length > 0 && (
                <span className="faint tc-detail-hint">{phone ? "Tap" : "Click"} to open the wallet</span>
              )}
              {!onStack && hMarks.length > MAX_TIP_MARKS && (
                <span className="faint">+{hMarks.length - MAX_TIP_MARKS} more labeled trades here</span>
              )}
              {hTrades.map((tr, i) => (
                <span key={`t-${i}`} className={tr.side === "buy" ? "up" : "down"}>
                  {tr.text}
                </span>
              ))}
            </div>
          )}
          {hint && <div className="tc-hint">{hint}</div>}
        </div>
      </div>
    </div>
  );
}

/** The chart type's icon, where the toolbar is too narrow for its words. */
function KindIcon({ kind }: { kind: ChartKind }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "candles" ? (
        <path d="M7 3v4M7 17v4M17 3v2M17 15v6M5 7h4v10H5zM15 5h4v10h-4z" />
      ) : (
        <path d="m3 17 6-6 4 4 8-8" />
      )}
    </svg>
  );
}

function DrawButton({
  tool,
  active,
  onPick,
  title,
  children,
}: {
  tool: DrawTool;
  active: DrawTool | null;
  onPick: (t: DrawTool) => void;
  title: string;
  children: React.ReactNode;
}) {
  const on = active === tool;
  return (
    <button
      type="button"
      className={`tc-tool${on ? " on" : ""}`}
      aria-pressed={on}
      title={title}
      aria-label={tool === "trend" ? "Trendline" : tool === "level" ? "Price level" : "Fibonacci retracement"}
      onClick={() => onPick(tool)}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/**
 * The bar scale on screen: where bar 0 sits and how far apart bars are (CSS px). The library maps
 * whole bars only, so a time between two (a trade inside a minute candle) is placed from these.
 */
function barScale(chart: IChartApi | null): { x0: number; dx: number } | null {
  const ts = chart?.timeScale();
  const a = ts?.logicalToCoordinate(0 as LogicalRange["from"]);
  const b = ts?.logicalToCoordinate(1 as LogicalRange["from"]);
  return a == null || b == null || !(b > a) ? null : { x0: a, dx: b - a };
}

/**
 * The chart's one progress bar for its missing minutes, top left (user ask 2026-10-24): the share
 * of them the browser has read or found empty, and the time left at the pace its reads go out.
 * Gone once nothing is left to read.
 */
function FillBar({ fill, top }: { fill: FillState; top: number }) {
  const [now, setNow] = useState(() => Date.now());
  const active = fill.doneAt !== null && fill.totalMs > 0;
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [active]);
  if (!active) return null;
  const { done, total, leftMs } = fillLine(fill, now);
  const share = Math.min(1, fill.doneMs / fill.totalMs);
  return (
    <div className="tc-fill" style={{ top }} role="status" aria-live="polite">
      <div className="tc-fill-line">
        <b>Backfilling missing data</b>
        <span className="num">
          {done.toLocaleString()} / {total.toLocaleString()} min
          {leftMs !== null && ` · ${fillEta(leftMs)}`}
        </span>
      </div>
      <div
        className="tc-fill-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <div className="tc-fill-bar" style={{ width: `${Math.max(2, share * 100)}%` }} />
      </div>
    </div>
  );
}

/** The time left as the bar shows it. */
function fillEta(ms: number): string {
  if (ms < 1_000) return "finishing";
  if (ms < 60_000) return `${Math.ceil(ms / 1_000)}s left`;
  return `${Math.floor(ms / 60_000)}m ${Math.ceil((ms % 60_000) / 1_000)}s left`;
}

/** A time (ms) to the plot's x (CSS px): between candles too, and past either end. */
function toX(chart: IChartApi | null, slots: Slots, t: number, closeAtEnd = false): number | null {
  const s = barScale(chart);
  return s ? s.x0 + slotOfTime(slots, t, closeAtEnd) * s.dx : null;
}

/** The plot's x (CSS px) to the bar scale, fractional. */
function toLogical(chart: IChartApi | null, x: number): number | null {
  const s = barScale(chart);
  return s ? (x - s.x0) / s.dx : null;
}

/** The time axis's labels, in the viewer's own time zone. */
function tickLabel(t: number, type: TickMarkType): string {
  const d = new Date(t);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getFullYear());
    case TickMarkType.Month:
      return d.toLocaleString([], { month: "short" });
    case TickMarkType.DayOfMonth:
      return d.toLocaleString([], { month: "short", day: "numeric" });
    case TickMarkType.TimeWithSeconds:
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    default:
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
}

/**
 * Price-scale margins. The top fits the highest bubble (one large grid offset) and the event
 * flags. It does not reserve a band that pins every bubble to the top of the pane. The bottom
 * grows when the reader's triangles sit under the lowest candle.
 */
function chartMargins(
  plotHeight: number,
  opts: { bubbles: boolean; vol: boolean; factor: number; own: boolean },
): { top: number; bottom: number } {
  const h = Math.max(160, plotHeight > 0 ? plotHeight : 160);
  const scale = opts.factor > 0 ? opts.factor : 1;
  const top = opts.bubbles
    ? Math.min(0.32, Math.max(0.08, bubbleHeadroomPx(BUBBLE_GRID_STEPS.l, scale, picRadius(1e9)) / h))
    : 0.12;
  const ownPx = opts.own ? ownTradeExtentPx(scale) : 0;
  // Volume already occupies the bottom of the pane. The triangles need their own room above that,
  // or the lowest candle's marks draw through the volume bars.
  const bottom = Math.min(0.42, (opts.vol ? 0.2 : 0.06) + (opts.own ? ownPx / h : 0));
  return { top, bottom };
}

/**
 * One horizontal grid line at `atPrice`. Linear: the pane's tick span. Log: one tick-mark of
 * pixels through the chart's own scale, so it is not a linear tick of the wrong range.
 */
function readGridStep(
  chart: IChartApi | null,
  main: ISeriesApi<SeriesType> | null,
  atPrice: number,
  plotHeight: number,
): number {
  if (!chart || !main || !(atPrice > 0) || !(plotHeight > 1)) return 0;
  const log = chart.priceScale("right").options().mode === PriceScaleMode.Logarithmic;
  if (!log) {
    const top = main.coordinateToPrice(0);
    const bottom = main.coordinateToPrice(plotHeight);
    if (top != null && bottom != null && Number.isFinite(top) && Number.isFinite(bottom)) {
      const low = Math.min(top, bottom);
      const high = Math.max(top, bottom);
      const step = priceGridStep(low, high, plotHeight);
      if (step > 0) return step;
    }
  }
  return gridIntervalAt(
    atPrice,
    (p) => main.priceToCoordinate(p),
    (y) => main.coordinateToPrice(y),
  );
}

/**
 * Y of the highest candle currently in view. Called while the overlay draws, so the price scale
 * (including the band's top margin) is the one the bubbles clear.
 */
function seriesTopY(
  chart: IChartApi | null,
  main: ISeriesApi<SeriesType> | null,
  slots: Slots | null,
): number | null {
  if (!chart || !main || !slots) return null;
  const range = chart.timeScale().getVisibleLogicalRange();
  if (!range) return null;
  const from = Math.max(0, Math.floor(range.from) - 1);
  const to = Math.min(slots.bars.length - 1, Math.ceil(range.to) + 1);
  let top: number | null = null;
  for (let i = from; i <= to; i++) {
    const bar = slots.bars[i];
    if (!bar) continue;
    const high = bar.flat ? bar.c : Math.max(bar.h, bar.o, bar.c);
    if (!(high > 0)) continue;
    const y = main.priceToCoordinate(high);
    if (y === null || !Number.isFinite(y)) continue;
    if (top === null || y < top) top = y;
  }
  return top;
}

function emptyOverlay(): OverlayState {
  return {
    x: () => null,
    y: () => null,
    valueAt: () => null,
    rangeAt: () => null,
    seriesTop: () => null,
    column: () => 0,
    gridStep: () => 0,
    bubbleSteps: 1,
    pic: () => null,
    events: [],
    flagTop: 20,
    eventLabels: true,
    eventScale: 1,
    marks: [],
    trades: [],
    dexInfo: null,
    path: [],
    pathZone: null,
    hot: new Set(),
    markScale: 1,
    markShape: "circle",
    markStem: false,
    markGap: 1,
    drawings: null,
    drawScale: null,
    label: axisUsd,
    colors: null,
    gaps: [],
    edgeX: () => null,
  };
}

/** A colour with an alpha (a hex or rgb() colour from the theme). */
function hexA(color: string, a: number): string {
  const c = color.trim();
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (rgb) {
    const [r, g, b] = rgb[1]!.split(",").map((x) => x.trim());
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

/** The theme's colours, read from the page's tokens (styles.css) for the chart's canvas. */
function readColors(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  const up = v("--good-ink", "#4ade80");
  const down = v("--bad-ink", "#ff8080");
  const font = v("--font", "Inter, system-ui, sans-serif");
  const page = v("--page", "#07080c");
  const surface = v("--surface-solid", "#11131a");
  const ink2 = v("--ink-2", "#aab1c2");
  const muted = v("--muted", "#8c94a7");
  const brand = v("--brand-ink", "#c4825f");
  const wkCache = new Map<string, { fill: string; ink: string }>();
  const wk = (kind: string) => {
    let hit = wkCache.get(kind);
    if (!hit) {
      const probe = document.createElement("span");
      probe.className = `wk-${kind}`;
      probe.style.display = "none";
      el.appendChild(probe);
      const ps = getComputedStyle(probe);
      hit = {
        fill: ps.getPropertyValue("--wk").trim() || brand,
        ink: ps.getPropertyValue("--wk-ink").trim() || brand,
      };
      probe.remove();
      wkCache.set(kind, hit);
    }
    return hit;
  };
  const overlay: OverlayColors = {
    event: hexA(ink2, 0.45),
    eventLead: brand,
    eventText: ink2,
    labelBg: surface,
    buy: up,
    sell: down,
    page,
    surface,
    path: v("--series-1", "#3987e5"),
    pathBand: hexA(v("--series-1", "#3987e5"), 0.14),
    font,
    dex: v("--series-3", "#199e70"),
    gap: hexA(v("--warn", "#fab219"), 0.08),
    gapEdge: hexA(v("--warn", "#fab219"), 0.55),
    gapDead: hexA(muted, 0.1),
    gapDeadEdge: hexA(muted, 0.5),
    wk,
    draw: {
      trend: v("--series-1", "#3987e5"),
      select: v("--ink", "#f3f5fa"),
      handleFill: page,
      diagonal: hexA(ink2, 0.5),
      fib: [
        muted,
        down,
        v("--warn", "#fab219"),
        up,
        v("--series-3", "#199e70"),
        v("--series-1", "#3987e5"),
        muted,
      ],
      font: v("--mono", "monospace"),
    },
  };
  return {
    up,
    down,
    muted,
    grid: v("--grid", "#232735"),
    axis: v("--axis", "#343a4b"),
    surface3: v("--surface-3", "#1f2330"),
    warn: v("--warn", "#fab219"),
    series1: v("--series-1", "#3987e5"),
    series5: v("--series-5", "#d55181"),
    mono: v("--mono", "monospace"),
    overlay,
  };
}
