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
import { change, signedPct, usd } from "../format";
import {
  autoTimeframe,
  buildSlots,
  slotCandle,
  slotIndex,
  slotOfTime,
  timeframeFits,
  type Slots,
} from "../chartBars";
import { Drawings, type DrawScale, type DrawTool } from "../chartDrawings";
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
import type { WalletMark } from "../walletMarks";
import { atLiveEnd, markAt, type PlacedMark } from "../chartMarkLayout";
import { API_URL } from "../api";
import { openWallet } from "../walletModal";
import {
  ChartOverlay,
  SlotCandleSeries,
  type MarkItem,
  type OverlayColors,
  type OverlayState,
  type SlotCandleData,
} from "./chartPlugins";
import { KolAvatar } from "./KolAvatar";

/** A moment marked on the chart: an alert, a model's call, the screen pass, graduation. */
export interface ChartEvent {
  t: number;
  label: string;
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

/** The indicators the toolbar turns on and off (HolDEX's set). */
type Indicator = "vol" | "ma20" | "ema50" | "bb" | "rsi";
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

/** Per-device conveniences: the candle size, log scale, and the indicators shown. */
const TIMEFRAME_KEY = "ts.chartTimeframe";
const LOG_SCALE_KEY = "ts.chartLogScale";
const INDICATORS_KEY = "ts.chartIndicators";
const DRAWINGS_KEY = "ts.chartDrawings";

function readTimeframe(): number | null {
  try {
    const v = localStorage.getItem(TIMEFRAME_KEY);
    if (v === null || v === "auto") return null;
    const ms = Number(v);
    return TIMEFRAMES.some((f) => f.ms === ms) ? ms : null;
  } catch {
    return null;
  }
}
function keep(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows: the pick holds for this view only.
  }
}
function readIndicators(): Set<Indicator> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(INDICATORS_KEY) ?? '["vol"]');
    if (Array.isArray(v)) return new Set(v.filter((x): x is Indicator => INDICATORS.some((i) => i.id === x)));
  } catch {
    // Unreadable: the default.
  }
  return new Set(["vol"]);
}
function readLog(): boolean {
  try {
    return localStorage.getItem(LOG_SCALE_KEY) === "1";
  } catch {
    return false;
  }
}

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
/** The space past the last candle (px), and the predicted path's zone there. */
const RIGHT_PX = 24;
function pathZoneW(plotW: number): number {
  return Math.round(Math.min(160, Math.max(56, plotW * 0.16)));
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
const ICON_TOOLS_PX = 520;

const NO_MARKS: WalletMark[] = [];
const NO_TRADES: ChartTrade[] = [];

/** Labeled trades the readout lists by name at most; the rest are counted. */
const MAX_TIP_MARKS = 6;

/**
 * The token view's market-cap chart (user ask 2026-10-19: HolDEX's chart, on our own candles):
 * TradingView's Lightweight Charts with a timeframe picker, candles or a baseline line, volume,
 * indicators and drawing tools, and our marks over it (alerts and model calls, the screen pass,
 * labeled wallets' trades, the trader's own trades and entry). The line is green above its
 * baseline and red below it: the trader's entry while they hold the coin, else the first marked
 * moment's market cap, else where the chart starts. A picked candle size stays as picked while
 * zooming (candles widen or thin, up to MAX_BAR_PX), and scrolling over the chart never scrolls
 * the page. On a phone a finger drags the chart along, two pinch it, and a tap reads a candle.
 */
export function TradingChart({
  mint,
  candles,
  ticks,
  events,
  flow = [],
  marks: marksIn = NO_MARKS,
  markPics = true,
  trades: tradesIn = NO_TRADES,
  live = false,
  entry = null,
  extent,
  height,
  kind,
  onKind,
  onTimeframe,
  path = [],
  fileName = "chart",
  ariaLabel,
}: {
  /** The coin, whose drawings are kept on this device. */
  mint: string;
  /** The view's candles, of mixed widths (the 5-minute backfill, minute, 15- and 1-second ones). */
  candles: VolumeCandle[];
  /** Readings after the newest candle (the live curve's ticks), or all of them without candles. */
  ticks: Point[];
  events: ChartEvent[];
  /** The scans' 5-minute buy and sell counts: the readout gives the buy share where one covers. */
  flow?: ScanFlow[];
  /** Labeled wallets' trades (KOLs, their sides, flagged wallets): lettered rings by the price. */
  marks?: WalletMark[];
  /** KOLs' marks as their X pictures, where a mark has one (Customize › Chart wallet trades). */
  markPics?: boolean;
  /** Pro Mode: the trader's own buys and sells. */
  trades?: ChartTrade[];
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
  /** The candle size drawn, so the view reads candles fine enough for it. */
  onTimeframe?: (ms: number) => void;
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

  const [picked, setPicked] = useState<number | null>(readTimeframe);
  const [log, setLog] = useState(readLog);
  const [ind, setInd] = useState(readIndicators);
  const viewMs = Math.max(1, extent.t1 - extent.t0);
  const plotW = Math.max(200, width - 64);
  const autoMs = autoTimeframe(viewMs, plotW);
  const tfMs = picked !== null && timeframeFits(picked, viewMs) ? picked : autoMs;
  const slots = useMemo(() => buildSlots(candles, ticks, tfMs), [candles, ticks, tfMs]);
  useEffect(() => {
    onTimeframe?.(tfMs);
  }, [tfMs, onTimeframe]);
  // A live trade is often read seconds before the candles reach it: drawn at its own time it fell
  // past the last candle, off the plot, and the bubble vanished until the next read (user report
  // 2026-10-19). It sits on the newest candle until then.
  const slotsEnd = slots ? slots.start + slots.bars.length * slots.tfMs : null;
  const marks = useMemo(() => atLiveEnd(marksIn, live ? slotsEnd : null), [marksIn, live, slotsEnd]);
  const trades = useMemo(() => atLiveEnd(tradesIn, live ? slotsEnd : null), [tradesIn, live, slotsEnd]);

  // The baseline (#835): the trader's entry while they hold the coin, else the earliest marked
  // moment (the first alert, filter or model; else the screen pass) at its own market cap or the
  // chart's then, else where the chart starts.
  const lead = useMemo(
    () => events.reduce<ChartEvent | undefined>((a, e) => (a === undefined || e.t < a.t ? e : a), undefined),
    [events],
  );
  const ref = useMemo(() => {
    if (entry !== null && entry > 0) return { v: entry, label: "your entry" };
    if (!slots || !lead) return null;
    const v = lead.mcap ?? (lead.t >= slots.start ? slotCandle(slots, slotIndex(slots, lead.t))?.c : null);
    return v && v > 0 ? { v, label: lead.label.toLowerCase() } : null;
  }, [entry, lead, slots]);
  const base = ref?.v ?? slots?.bars[0]?.o ?? 0;

  // ── The chart ──────────────────────────────────────────────────────────
  const series = useRef<{
    main: ISeriesApi<SeriesType> | null;
    vol: ISeriesApi<"Histogram"> | null;
    lines: ISeriesApi<"Line">[];
    rsi: ISeriesApi<"Line"> | null;
    baseLine: IPriceLine | null;
    entryLine: IPriceLine | null;
  }>({ main: null, vol: null, lines: [], rsi: null, baseLine: null, entryLine: null });
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
  const lastData = useRef<{ start: number; n: number; tf: number; scope: string } | null>(null);

  const [drawTick, setDrawTick] = useState(0);
  const drawings = useMemo(
    () => new Drawings(`${DRAWINGS_KEY}.${mint}`, () => setDrawTick((n) => n + 1)),
    [mint],
  );

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
      series.current = { main: null, vol: null, lines: [], rsi: null, baseLine: null, entryLine: null };
      overlayRef.current = null;
    };
  }, []);

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
    s.baseLine = null;
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
      scaleMargins: { top: 0.12, bottom: ind.has("vol") ? 0.2 : 0.06 },
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
    if (kind === "candles") {
      (s.main as unknown as ISeriesApi<"Custom", Time, SlotCandleData>).setData(
        bars.map((b) => ({
          time: time(b.t),
          o: b.o,
          h: b.h,
          l: b.l,
          c: b.c,
          ...(b.flat ? { flat: true } : {}),
          ...(b.span ? { span: b.span } : {}),
          ...(b.under ? { under: b.under } : {}),
        })),
      );
      const last = bars[bars.length - 1];
      if (last) s.main.applyOptions({ color: last.c >= last.o ? colors.up : colors.down });
    } else {
      // The line runs through each candle's close; a wider candle's at its last slot.
      (s.main as ISeriesApi<"Baseline">).setData(
        bars.map((b, i) => {
          const parent = b.under ? bars[i - b.under] : b;
          const last = !bars[i + 1]?.under;
          return parent && (b.span ?? 1) === 1 && last
            ? { time: time(b.t), value: parent.c }
            : { time: time(b.t) };
        }),
      );
      s.main.applyOptions({ baseValue: { type: "price", price: base } });
    }
    s.vol?.setData(
      bars.map((b) => ({
        time: time(b.t),
        value: b.vol,
        color: hexA(b.c >= b.o ? colors.up : colors.down, 0.38),
      })),
    );
    const closes = bars.map((b) => ({ time: b.t / 1000, close: b.c }));
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

    // The baseline and the trader's entry, as lines across the plot with their tags on the axis.
    if (s.baseLine) s.main.removePriceLine(s.baseLine);
    if (s.entryLine) s.main.removePriceLine(s.entryLine);
    s.baseLine = null;
    s.entryLine = null;
    if (ref && !(entry !== null && entry > 0))
      s.baseLine = s.main.createPriceLine({
        price: ref.v,
        color: colors.muted,
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: true,
        title: phone ? "" : ref.label,
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

    // Which window to show: a new view (or candle size) opens on its newest candles; otherwise
    // the window keeps its moments, and follows the newest candle when it ran to it.
    const scope = `${mint}|${opened}`;
    const n = bars.length;
    if (!prev || prev.tf !== slots.tfMs || prev.scope !== scope || !range) {
      const fit = Math.max(8, Math.floor(plotW / OPEN_BAR_PX));
      ts.setVisibleLogicalRange(n <= fit ? { from: -0.5, to: n - 0.5 } : { from: n - fit, to: n - 0.5 });
      if (n <= fit)
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
    lastData.current = { start: slots.start, n, tf: slots.tfMs, scope };
  }, [slots, built, base, ref, entry, phone, opened]);

  // The overlay: the marks, events, path and drawings, placed through the chart's own scales.
  const dScale = useMemo<DrawScale | null>(() => {
    if (!slots) return null;
    return {
      x: (t) => toX(chartRef.current, slots, t),
      y: (v) => series.current.main?.priceToCoordinate(v) ?? null,
      t: (x) => {
        const l = toLogical(chartRef.current, x);
        return l === null ? null : slots.start + (l + 0.5) * slots.tfMs;
      },
      v: (y) => series.current.main?.coordinateToPrice(y) ?? null,
    };
  }, [slots]);
  const pointedMarks = useMemo(
    () => (pointed ? [pointed.item, ...pointed.more].flatMap((i) => (i.mark ? [i.mark] : [])) : []),
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
    // Candles: a buy hangs under its candle's low, a sale over its high; the line has the price only.
    const rangeAt = (t: number) => {
      const v = valueAt(t);
      if (v === null) return null;
      const k = kind === "candles" ? slotCandle(slots, slotIndex(slots, t)) : null;
      return k && !k.flat ? { lo: Math.min(k.l, v), hi: Math.max(k.h, v) } : { lo: v, hi: v };
    };
    const lastX = dScale.x(slots.start + (slots.bars.length - 0.5) * slots.tfMs);
    const bs = barScale(chartRef.current)?.dx ?? 6;
    o.state = {
      x: dScale.x,
      y: dScale.y,
      valueAt,
      rangeAt,
      // The flags go under the readout's lines.
      flagTop: phone ? 34 : 20,
      events: [...events]
        .sort((a, b) => a.t - b.t)
        .map((e, i) => ({ t: e.t, label: e.label, lead: i === 0 })),
      marks,
      trades,
      path,
      pathZone:
        path.length > 1 && lastX !== null ? { x0: lastX + bs / 2 + 4, w: pathZoneW(plotW) - 8 } : null,
      hot,
      pic: (m) => (markPics ? picOf(m) : null),
      drawings,
      drawScale: dScale,
      label: axisUsd,
      colors: colors.overlay,
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
      if (wallet) {
        setPointed(hit);
        openWallet(wallet);
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
      el.classList.toggle("on-mark", !!hit?.item.mark);
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

  const pickTimeframe = (ms: number | null) => {
    setPicked(ms);
    keep(TIMEFRAME_KEY, ms === null ? "auto" : String(ms));
  };
  const toggle = (id: Indicator) => {
    const next = new Set(ind);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setInd(next);
    keep(INDICATORS_KEY, JSON.stringify([...next]));
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
  fmtRef.current = { seconds: fine, dated };
  const hFlow = cur ? flowAt(flow, curFrom, curTo) : null;
  // The marks under the pointer when it is on one, else those in the candle it is over.
  const onStack = pointed !== null;
  const stack = pointed ? [pointed.item, ...pointed.more] : [];
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
    !onStack && hover !== null && cur ? events.filter((e) => e.t >= curFrom && e.t < curTo) : [];
  const up = cur ? cur.c >= cur.o : true;
  const vsRef = cur && ref ? change(ref.v, cur.c) : null;
  const tool = drawings.tool;
  const hint = tool
    ? drawings.placing
      ? tool === "trend"
        ? `${phone ? "Tap" : "Click"} the second point`
        : `${phone ? "Tap" : "Click"} the end of the move (level 0)`
      : tool === "trend"
        ? `${phone ? "Tap" : "Click"} the start of the trendline`
        : `${phone ? "Tap" : "Click"} the start of the move (level 1)`
    : drawings.selectedId
      ? "Drawing selected. Delete removes it."
      : null;
  const plotH = height + TIME_AXIS_PX + (ind.has("rsi") ? Math.round(height * 0.3) : 0);

  const rail = (
    <div className="tc-rail" role="toolbar" aria-label="Drawing tools">
      <DrawButton
        tool="trend"
        active={tool}
        onPick={(t) => drawings.setTool(t)}
        title="Trendline: click two points"
      >
        <line x1="5" y1="19" x2="19" y2="5" />
        <circle cx="5" cy="19" r="2" fill="currentColor" />
        <circle cx="19" cy="5" r="2" fill="currentColor" />
      </DrawButton>
      <DrawButton
        tool="fib"
        active={tool}
        onPick={(t) => drawings.setTool(t)}
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
        onClick={() => {
          setLog(!log);
          keep(LOG_SCALE_KEY, log ? null : "1");
        }}
      >
        Log
        {fold && <small>Log scale: a big run doesn&apos;t flatten what came before it</small>}
      </button>
    </>
  );

  return (
    <div className={`tc${phone ? " phone" : ""}${fold ? " fold" : ""}`} ref={boxRef}>
      <div className="tc-toolbar" role="toolbar" aria-label="Chart settings">
        <div className="tc-row">
          {tfPicker ? (
            <label className="tc-select" title="Candle size">
              <span className="sr-only">Candle size</span>
              <select
                value={picked === null || !timeframeFits(picked, viewMs) ? "auto" : String(tfMs)}
                onChange={(e) => pickTimeframe(e.target.value === "auto" ? null : Number(e.target.value))}
              >
                <option value="auto">Auto · {timeframeLabel(autoMs)}</option>
                {TIMEFRAMES.map((f) => (
                  <option key={f.ms} value={f.ms} disabled={!timeframeFits(f.ms, viewMs)}>
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
                className={picked === null || !timeframeFits(picked, viewMs) ? "on" : ""}
                title="Auto: a candle size that fits the whole view"
                onClick={() => pickTimeframe(null)}
              >
                {picked === null || !timeframeFits(picked, viewMs)
                  ? `Auto · ${timeframeLabel(autoMs)}`
                  : "Auto"}
              </button>
              {TIMEFRAMES.map((f) => (
                <button
                  key={f.ms}
                  type="button"
                  role="radio"
                  aria-checked={tfMs === f.ms && picked !== null}
                  className={picked !== null && tfMs === f.ms ? "on" : ""}
                  disabled={!timeframeFits(f.ms, viewMs)}
                  title={timeframeFits(f.ms, viewMs) ? `${f.label} candles` : "Wider than this view allows"}
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
                className={`tc-chip tc-menu-btn${ind.size > 0 || log ? " on" : ""}`}
                aria-expanded={menu}
                aria-haspopup="true"
                title="Indicators and scale"
                onClick={() => setMenu(!menu)}
              >
                Indicators
                {ind.size + (log ? 1 : 0) > 0 && <span className="num">{ind.size + (log ? 1 : 0)}</span>}
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
      </div>

      <div className="tc-body">
        {!phone && rail}

        <div className={`tc-wrap${tool ? " drawing" : ""}`} style={{ height: plotH }}>
          <div className="tc-plot" ref={plotRef} role="img" aria-label={ariaLabel} />
          {cur && (
            <div className="tc-legend num" aria-live="off">
              <span className="faint">
                {clock(curFrom, fine, dated)}
                {(cur.span ?? 1) > 1 || (slots?.tfMs ?? 0) > 1_000 ? `–${clock(curTo, fine, false)}` : ""}
              </span>
              {cur.flat ? (
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
              {cur.vol > 0 && <span>Vol {usd(cur.vol)}</span>}
              {hFlow && (
                <span
                  className={hFlow.buys / (hFlow.buys + hFlow.sells) >= 0.5 ? "up" : "down"}
                  title={`${hFlow.buys} buys, ${hFlow.sells} sells in the ${FLOW_WINDOW_MS / 60_000} min to ${clock(hFlow.t, false, false)}`}
                >
                  {Math.round((hFlow.buys / (hFlow.buys + hFlow.sells)) * 100)}% buys
                </span>
              )}
            </div>
          )}
          {(hMarks.length > 0 || hTrades.length > 0 || hEvents.length > 0) && (
            <div className="tc-detail">
              {hEvents.map((e, i) => (
                <span key={`e-${i}`} className="tc-detail-event">
                  {e.label}
                  {e.mcap ? ` at ${usd(e.mcap)}` : ""}
                </span>
              ))}
              {hMarks.slice(0, MAX_TIP_MARKS).map((m, i) => (
                <span key={`m-${i}`} className={`pc-mark-line wk-${m.kind}`}>
                  {markPics && m.avatar ? (
                    <KolAvatar
                      src={m.avatar}
                      className={`tc-mark-pic ${m.side}`}
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
              {hMarks.length > MAX_TIP_MARKS && (
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
      aria-label={tool === "trend" ? "Trendline" : "Fibonacci retracement"}
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

/** A time (ms) to the plot's x (CSS px): between candles too, and past either end. */
function toX(chart: IChartApi | null, slots: Slots, t: number): number | null {
  const s = barScale(chart);
  return s ? s.x0 + slotOfTime(slots, t) * s.dx : null;
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

function emptyOverlay(): OverlayState {
  return {
    x: () => null,
    y: () => null,
    valueAt: () => null,
    rangeAt: () => null,
    pic: () => null,
    events: [],
    flagTop: 20,
    marks: [],
    trades: [],
    path: [],
    pathZone: null,
    hot: new Set(),
    drawings: null,
    drawScale: null,
    label: axisUsd,
    colors: null,
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
