/**
 * Which event flags the token chart draws (Customize › Chart events). The chart builds one flag per
 * moment in ChartCard; this decides which of those are drawn, for both orientations: the vertical
 * line and its flag along the top, and the horizontal price line at that moment's market cap.
 * One list feeds both, so a kind that is off is absent from each. apps/api/src/feedAppearance.ts
 * holds the same kind names and defaults.
 */

/** Every kind ChartCard can put on a flag. */
export const CHART_EVENT_KINDS = ["alert", "screen", "filter", "model", "graduation", "scanned"] as const;
export type ChartEventKind = (typeof CHART_EVENT_KINDS)[number];

/** Kinds that can be collapsed to their earliest flag. Passed screen, graduation and scanned are one each. */
export const CHART_EVENT_FIRST_KINDS = ["alert", "filter", "model"] as const;
export type ChartEventFirstKind = (typeof CHART_EVENT_FIRST_KINDS)[number];

/** How Customize lists them. Passed screen is the one that starts off. */
export const CHART_EVENT_KIND_OPTIONS: readonly { kind: ChartEventKind; label: string }[] = [
  { kind: "alert", label: "Alert" },
  { kind: "screen", label: "Passed screen" },
  { kind: "filter", label: "Filter match" },
  { kind: "model", label: "Model call" },
  { kind: "graduation", label: "Graduation" },
  { kind: "scanned", label: "Scanned" },
];

/** Shown by default: everything ChartCard emits except the screen pass. */
export const DEFAULT_CHART_EVENT_KINDS: readonly ChartEventKind[] = CHART_EVENT_KINDS.filter(
  (k) => k !== "screen",
);

/** Only the first filter and the first model. Alerts are not collapsed unless the reader asks. */
export const DEFAULT_CHART_EVENT_FIRST: readonly ChartEventFirstKind[] = ["filter", "model"];

const FIRST_LABEL: Record<ChartEventFirstKind, string> = {
  alert: "Alert",
  filter: "Filter",
  model: "Model",
};

export const CHART_EVENT_FIRST_OPTIONS: readonly { kind: ChartEventFirstKind; label: string }[] =
  CHART_EVENT_FIRST_KINDS.map((kind) => ({ kind, label: FIRST_LABEL[kind] }));

/**
 * The kind of a flag ChartCard builds.
 * A filter match is the flag labeled "Alert". "Model alert" and each model's name are model calls.
 * The screen pass, graduation and a utility scan are their own kinds. Anything else is an alert.
 */
export function chartFlagKind(
  label: string,
  source: "primary" | "screen" | "model",
  cardKind?: "match" | "curated" | "stream",
): ChartEventKind {
  if (source === "screen" || label === "Passed screen") return "screen";
  if (label === "Graduated") return "graduation";
  if (label === "Scanned") return "scanned";
  if (source === "model" || label === "Model alert") return "model";
  if (source === "primary" && cardKind === "match") return "filter";
  return "alert";
}

/**
 * A saved list of kinds. A missing list, or one with a value that is not a kind (or a repeat), is
 * the default. A real list is returned in `allowed` order, so an empty list stays empty.
 */
export function chartEventChoice<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  if (!Array.isArray(raw) || new Set(raw).size !== raw.length) return [...fallback];
  if (raw.some((k) => typeof k !== "string" || !(allowed as readonly string[]).includes(k)))
    return [...fallback];
  const picked = new Set(raw as T[]);
  return allowed.filter((k) => picked.has(k));
}

export interface ChartEventPrefs {
  /**
   * Master switch, the same idea as chart marks. False draws nothing. Absent is on, so a caller
   * that only passes kinds still filters by kind.
   */
  on?: boolean;
  /** Kinds that may be drawn. */
  kinds: readonly ChartEventKind[];
  /** Of these kinds, only the earliest flag is drawn. */
  first: readonly ChartEventFirstKind[];
}

/**
 * The flags to draw, earliest first. The vertical lines and the horizontal price lines both use
 * this list. A kind that is off is dropped (no vertical line, no flag, no horizontal price line).
 * When the master switch is off, nothing is drawn. When only-first is on for a kind, later flags
 * of that kind are dropped. Alerts stay, unless alert itself is in `first` or the alert kind is off.
 */
export function chartEventsToDraw<T extends { t: number; kind: ChartEventKind }>(
  events: readonly T[],
  prefs: ChartEventPrefs,
): T[] {
  if (prefs.on === false) return [];
  const shown = new Set(prefs.kinds);
  const firstOf = new Set<string>(prefs.first);
  const seen = new Set<string>();
  const indexed = events.map((e, i) => ({ e, i }));
  indexed.sort((a, b) => a.e.t - b.e.t || a.i - b.i);
  const out: T[] = [];
  for (const { e } of indexed) {
    if (!shown.has(e.kind)) continue;
    if (firstOf.has(e.kind)) {
      if (seen.has(e.kind)) continue;
      seen.add(e.kind);
    }
    out.push(e);
  }
  return out;
}

/**
 * Vertical flags and horizontal price flags are this same list. Named apart from chartEventsToDraw
 * so a chart call site cannot filter one orientation and forget the other.
 */
export function chartFlagsToDraw<T extends { t: number; kind: ChartEventKind }>(
  events: readonly T[],
  prefs: ChartEventPrefs,
): T[] {
  return chartEventsToDraw(events, prefs);
}

/**
 * Where a shown flag's horizontal price line sits. The event's own market cap wins; otherwise the
 * candle close at that time. Null when neither is a price, so the line is not drawn. Callers pass
 * flags from chartFlagsToDraw: this does not look at kinds.
 */
export function chartFlagPrice(mcap: number | null | undefined, closeAt: number | null): number | null {
  if (typeof mcap === "number" && Number.isFinite(mcap) && mcap > 0) return mcap;
  if (typeof closeAt === "number" && Number.isFinite(closeAt) && closeAt > 0) return closeAt;
  return null;
}

/** Horizontal price lines for the flags the reader is showing, earliest first. */
export function horizontalFlagPrices<T extends { mcap?: number | null }>(
  shown: readonly T[],
  closeAt: (event: T) => number | null,
): { event: T; price: number }[] {
  const out: { event: T; price: number }[] = [];
  for (const event of shown) {
    const price = chartFlagPrice(event.mcap, closeAt(event));
    if (price !== null) out.push({ event, price });
  }
  return out;
}

/**
 * The price the line is coloured from. A hidden screen pass still counts, so a graduated coin
 * stays coloured from the pass (the flag and its lines do not: those follow chartFlagsToDraw).
 */
export function chartColorReference<T extends { t: number }>(events: readonly T[]): T | undefined {
  return events.reduce<T | undefined>((a, e) => (a === undefined || e.t < a.t ? e : a), undefined);
}

/** How big an event flag draws. The factors match wallet-mark sizes (walletMarks.ts MARK_SCALE). */
export const CHART_EVENT_SCALES = ["s", "m", "l"] as const;
export type ChartEventScale = (typeof CHART_EVENT_SCALES)[number];

/** Lead-flag colour from the chart's existing palette. Off draws every flag the same. */
export const CHART_EVENT_EMPHASIS = ["off", "brand", "win", "loss", "mine"] as const;
export type ChartEventEmphasis = (typeof CHART_EVENT_EMPHASIS)[number];

export interface EventFlagMetrics {
  /** Multiplier on the medium size the chart already draws. */
  factor: number;
  /**
   * Horizontal price-line width. Lightweight Charts draws these as whole pixels and will not go
   * under 1, so small and medium stay 1 and large is 2. The vertical line uses `factor` instead.
   */
  line: 1 | 2;
}

/** Size of the event flags. Medium is the size the chart already draws. */
export function eventFlagMetrics(scale: ChartEventScale): EventFlagMetrics {
  if (scale === "s") return { factor: 0.75, line: 1 };
  if (scale === "l") return { factor: 1.35, line: 2 };
  return { factor: 1, line: 1 };
}

/** The lead colour, or null when emphasis is off and every flag uses the plain ink. */
export function eventEmphasisColor(
  emphasis: ChartEventEmphasis,
  palette: { brand: string; win: string; loss: string; mine: string },
): string | null {
  if (emphasis === "off") return null;
  if (emphasis === "win") return palette.win;
  if (emphasis === "loss") return palette.loss;
  if (emphasis === "mine") return palette.mine;
  return palette.brand;
}

/** Indicators the token chart can draw (TradingChart's toolbar). Volume on by default. */
export const CHART_INDICATOR_IDS = ["vol", "ma20", "ema50", "bb", "rsi"] as const;
export type ChartIndicatorId = (typeof CHART_INDICATOR_IDS)[number];
export const DEFAULT_CHART_INDICATORS: readonly ChartIndicatorId[] = ["vol"];

/**
 * Candle widths the toolbar offers, in ms (priceChart.ts TIMEFRAMES). Null in a saved look means
 * Auto. apps/api/src/feedAppearance.ts holds the same numbers.
 */
export const CHART_TIMEFRAME_MS = [
  1_000, 5_000, 15_000, 30_000, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 14_400_000,
] as const;

/** Fibonacci levels a drawing can show (chartDrawings.ts FIB_LEVELS). All of them by default. */
export const CHART_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const;

const FIB_EPS = 1e-6;

/** A saved list of indicator ids, in CHART_INDICATOR_IDS order. A bad list is the default. Empty stays empty. */
export function chartIndicatorChoice(
  raw: unknown,
  fallback: readonly ChartIndicatorId[],
): ChartIndicatorId[] {
  if (!Array.isArray(raw)) return [...fallback];
  if (raw.some((k) => typeof k !== "string" || !(CHART_INDICATOR_IDS as readonly string[]).includes(k)))
    return [...fallback];
  const picked = new Set(raw as ChartIndicatorId[]);
  return CHART_INDICATOR_IDS.filter((k) => picked.has(k));
}

/** A saved candle width, or null for Auto. Anything else is null. */
export function chartTimeframeChoice(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "number" && (CHART_TIMEFRAME_MS as readonly number[]).includes(raw) ? raw : null;
}

/**
 * Fibonacci levels the reader left on, in CHART_FIB_LEVELS order. A bad or empty list is every
 * level: a fib drawing with no level would draw nothing.
 */
export function chartFibChoice(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0) return [...CHART_FIB_LEVELS];
  if (raw.some((n) => typeof n !== "number" || !CHART_FIB_LEVELS.some((lv) => Math.abs(lv - n) < FIB_EPS)))
    return [...CHART_FIB_LEVELS];
  const picked = raw as number[];
  const on = CHART_FIB_LEVELS.filter((lv) => picked.some((n) => Math.abs(n - lv) < FIB_EPS));
  return on.length ? [...on] : [...CHART_FIB_LEVELS];
}

/** Keys the chart used to keep on this device, before they moved into the appearance. */
export const DEVICE_CHART_PREF_KEYS = [
  "ts.chartTimeframe",
  "ts.chartLogScale",
  "ts.chartIndicators",
  "ts.chartFibLevels",
  "ts.chartTrendExtend",
] as const;

export interface DeviceChartPrefPatch {
  chartTimeframeMs?: number | null;
  chartLogScale?: boolean;
  chartIndicators?: ChartIndicatorId[];
  chartFibLevels?: number[];
  chartTrendExtend?: boolean;
}

/**
 * Device conveniences saved before they lived on the appearance. A field the saved look already
 * has is left alone, so an account choice wins. A missing field takes the device value when one
 * was stored. Returns only the fields to fill in.
 */
export function chartPrefsFromDevice(
  savedAppearance: unknown,
  read: (key: string) => string | null,
): DeviceChartPrefPatch {
  const saved =
    typeof savedAppearance === "object" && savedAppearance !== null
      ? (savedAppearance as Record<string, unknown>)
      : {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(saved, key);
  const patch: DeviceChartPrefPatch = {};
  if (!has("chartTimeframeMs")) {
    const v = read("ts.chartTimeframe");
    if (v === "auto") patch.chartTimeframeMs = null;
    else if (v !== null && (CHART_TIMEFRAME_MS as readonly number[]).includes(Number(v)))
      patch.chartTimeframeMs = Number(v);
  }
  if (!has("chartLogScale")) {
    const v = read("ts.chartLogScale");
    if (v === "1" || v === "0") patch.chartLogScale = v === "1";
  }
  if (!has("chartIndicators")) {
    const v = read("ts.chartIndicators");
    if (v !== null) {
      try {
        patch.chartIndicators = chartIndicatorChoice(JSON.parse(v), DEFAULT_CHART_INDICATORS);
      } catch {
        // Unreadable: leave the appearance default.
      }
    }
  }
  if (!has("chartFibLevels")) {
    const v = read("ts.chartFibLevels");
    if (v !== null) {
      try {
        const raw: unknown = JSON.parse(v);
        if (Array.isArray(raw)) patch.chartFibLevels = chartFibChoice(raw);
      } catch {
        // Unreadable: leave the appearance default.
      }
    }
  }
  if (!has("chartTrendExtend")) {
    const v = read("ts.chartTrendExtend");
    if (v === "1" || v === "0") patch.chartTrendExtend = v === "1";
  }
  return patch;
}
