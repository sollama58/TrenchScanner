import { useSyncExternalStore, type CSSProperties } from "react";
import {
  CHART_MARK_KINDS,
  CHART_MARKS_REV,
  DEFAULT_CHART_MARK_KINDS,
  reviseChartMarkKinds,
} from "@trenchscanner/core/chartMarks";
import { isGuest } from "./session";
import { put, type CardField, type FeedAppearance, type QuickLink } from "./api";
import {
  CHART_EVENT_EMPHASIS,
  CHART_EVENT_FIRST_KINDS,
  CHART_EVENT_KINDS,
  CHART_EVENT_SCALES,
  CHART_FIB_LEVELS,
  DEFAULT_CHART_EVENT_FIRST,
  DEFAULT_CHART_EVENT_KINDS,
  DEFAULT_CHART_INDICATORS,
  chartEventChoice,
  chartFibChoice,
  chartIndicatorChoice,
  chartPrefsFromDevice,
  chartTimeframeChoice,
  DEVICE_CHART_PREF_KEYS,
} from "./chartEvents";

/**
 * How the Live feed looks: theme, colors, spacing, columns and which card fields show. Saved to
 * the wallet's account (PUT /settings/appearance) so it follows the user to every device, and kept
 * in localStorage too so this device paints it at once, before the settings load, and keeps it if
 * a save fails. apps/api/src/feedAppearance.ts holds the same names and bounds.
 */

/**
 * Which default chartMarkKinds a look was saved against (packages/core/src/chartMarks.ts): 2
 * turned risky wallets off; 3 turns winners off. A list that is still exactly an older default
 * was never changed, and reads as the new one. A list the reader edited keeps winners as they
 * left them. Re-exported so a save stamps the same revision the shared reader checks.
 */
export { CHART_MARKS_REV };
/**
 * Which hideBelowMcap default a look was saved against (apps/api/src/feedAppearance.ts has the
 * same): a look from before it went on at 6k that still holds the old default (off at 5k) was never
 * changed, and reads as the new one (user ask 2026-10-18).
 */
export const HIDE_BELOW_MCAP_REV = 2;
/**
 * Which feesBadge default a look was saved against (apps/api/src/feedAppearance.ts has the same): a
 * look from before the badge went on by default that still holds it off never changed it, and reads
 * as on (user ask 2026-10-19).
 */
export const FEES_BADGE_REV = 2;
/**
 * Which sniperTop10 default a look was saved against (apps/api/src/feedAppearance.ts has the same):
 * a look from before Block 0 took the Snipers tile's default place that still holds it on never
 * changed it, and reads as off (user ask 2026-10-23).
 */
export const SNIPER_TOP10_REV = 2;

export const DEFAULT_APPEARANCE: FeedAppearance = {
  // Dark until the user picks (user ask 2026-10-14); "auto" (Match device) stays a choice.
  theme: "dark",
  accent: null,
  mine: null,
  win: null,
  loss: null,
  density: "cozy",
  columns: 0,
  cardWidth: "normal",
  phoneColumns: 1,
  textSize: 100,
  corners: "rounded",
  avatar: "normal",
  // Retired (the old colored left edge); kept so an older API build still accepts the save.
  sourceStripe: true,
  learningNote: true,
  volume: false,
  scoreColor: true,
  // Off by default (user ask 2026-10-16); in the theme's win, amber and loss colors when switched on.
  tileColors: false,
  // Only the reading by default; the whole tile is a choice (user ask 2026-10-16).
  tileFill: false,
  tileLow: null,
  tileMid: null,
  tileHigh: null,
  reasons: false,
  // Off by default, Block 0 in its place (user ask 2026-10-23); Customize switches it back on.
  sniperTop10: false,
  sniperTop10Rev: SNIPER_TOP10_REV,
  devTile: false,
  largest: false,
  kolBundled: false,
  transferred: false,
  // On by default (user ask 2026-10-19); Customize › Extras switches it off.
  feesBadge: true,
  // The search control on each card (user ask 2026-10-21); Customize switches it off.
  cardSearch: true,
  feesBadgeRev: FEES_BADGE_REV,
  bubbleCexLinks: false,
  bubbleFunderLabels: false,
  bubbleSideLinks: true,
  bubbleTransferLinks: true,
  // Every 2 seconds by default (user decision 2026-10-24, was 5); the holder list beside it moves
  // with each trade.
  bubbleRefreshSeconds: 2,
  // Off by default (user ask 2026-10-16); KOLs' and exchanges' names always show.
  bubbleNameLabels: false,
  bubbleNamesPumpfun: null,
  bubbleNamesFomo: null,
  bubbleNamesHelius: null,
  narrativeNote: null,
  streamTab: false,
  // On for everyone by default (user ask 2026-10-15); a new key, so the old opt-in's saved "off" doesn't hide it.
  hideLighthouseTab: false,
  // The token view's safety pill shows by default; its Safety section always does (user ask 2026-10-16).
  hideSafetyPill: false,
  // The token window opens in Pro, its terminal layout, on desktop (user ask 2026-10-19).
  tokenView: "pro",
  outline: null,
  // Off by default (user ask 2026-10-14); an account that saved it on keeps it on.
  outlineResult: false,
  // On at 6k by default (user ask 2026-10-18); an account that changed it keeps its choice.
  hideBelowMcap: true,
  hideBelowMcapUsd: 6_000,
  hideBelowMcapRev: HIDE_BELOW_MCAP_REV,
  quickLinks: ["terminal"],
  // The token chart's labeled-wallet trades (user ask 2026-10-18): 0.5 SOL and up, every kind but
  // risky wallets and dumpers (user ask 2026-10-18) and winners (user ask 2026-10-21), which are
  // off by default.
  chartMarks: true,
  chartMarkKinds: [...DEFAULT_CHART_MARK_KINDS],
  chartMarksRev: CHART_MARKS_REV,
  chartMarkMinSol: 0.5,
  // KOLs' trades as their X pictures on the chart, on by default (user ask 2026-10-19).
  chartMarkPics: true,
  // Medium rings and pictures (user ask 2026-10-20); small and large are choices.
  chartMarkScale: "m",
  // A circle, no line to the candle, at the usual distance (user ask 2026-10-20).
  chartMarkShape: "circle",
  chartMarkStem: false,
  chartMarkGap: "m",
  // The token chart draws a line unless the reader picks candles (user ask 2026-10-18).
  chartStyle: "line",
  // The token chart opens on its Trading view, the latest at the right edge (user ask 2026-10-19).
  chartView: "trading",
  // Experimental and off unless the reader turns it on (user ask 2026-10-18).
  chartPathing: false,
  // Which event flags the token chart draws (chartEvents.ts). Passed screen starts off; only the
  // first filter and the first model are drawn. The master switch is the same idea as chart marks:
  // off hides every event flag, vertical and horizontal.
  chartEvents: true,
  chartEventKinds: [...DEFAULT_CHART_EVENT_KINDS],
  chartEventFirst: [...DEFAULT_CHART_EVENT_FIRST],
  // The flag's words, its size, and whether the earliest one uses a palette colour. Medium and
  // labelled, with the brand colour on the earliest, is how the chart already draws them.
  chartEventLabels: true,
  chartEventScale: "m",
  chartEventEmphasis: "brand",
  // Candle size, log scale and indicators used to live in this browser only. Auto, linear, and
  // volume is how the chart opens.
  chartTimeframeMs: null,
  chartLogScale: false,
  chartIndicators: [...DEFAULT_CHART_INDICATORS],
  // Drawings stay per coin on this device. Whether they show, which Fibonacci levels, and whether
  // a trendline runs on are the reader's, on every chart.
  chartShowDrawings: true,
  chartFibLevels: [...CHART_FIB_LEVELS],
  chartTrendExtend: false,
  // Off by default, switchable back on in Customize: the composite score tile, so the stat tiles
  // fill a clean 4 x 2 grid, the TokenSage button (the token view keeps its own) and the 1st Buyers
  // Holding tile, which Snipers replaced (user asks 2026-10-14). The header's calibrated 2x pill
  // shows unless an account saved it hidden. An account that saved its own field list keeps that list.
  // Same list as apps/api/src/feedAppearance.ts.
  hidden: ["score", "sage", "snipers"],
};

/** Trading sites a card can open the token in, as Settings lists them. */
/** A coin's Pump.fun page. */
export const pumpFunHref = (mint: string) => `https://pump.fun/coin/${mint}`;

export const QUICK_LINK_SITES: { id: QuickLink; label: string; href: (mint: string) => string }[] = [
  { id: "terminal", label: "Terminal", href: (m) => `https://trade.padre.gg/trade/solana/${m}` },
  { id: "axiom", label: "Axiom", href: (m) => `https://axiom.trade/t/${m}` },
  { id: "gmgn", label: "GMGN", href: (m) => `https://gmgn.ai/sol/token/${m}` },
];
/**
 * How often an open bubble map may redraw (user ask 2026-10-19): 2 seconds to a day, as Customize
 * offers them (apps/api/src/feedAppearance.ts BUBBLE_REFRESH_SECONDS has the same seconds).
 */
export const BUBBLE_REFRESH_CHOICES: readonly { seconds: number; label: string }[] = [
  { seconds: 2, label: "2 seconds" },
  { seconds: 5, label: "5 seconds" },
  { seconds: 10, label: "10 seconds" },
  { seconds: 15, label: "15 seconds" },
  { seconds: 30, label: "30 seconds" },
  { seconds: 60, label: "1 minute" },
  { seconds: 120, label: "2 minutes" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 1800, label: "30 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 21600, label: "6 hours" },
  { seconds: 43200, label: "12 hours" },
  { seconds: 86400, label: "1 day" },
];
/** The token chart's labeled-wallet trade size bounds, in SOL (apps/api/src/feedAppearance.ts has the same). */
export const CHART_MARK_MIN_SOL = 0.25;
export const CHART_MARK_MAX_SOL = 1_000;
/** The Live feed's "hide below this market cap" slider, in USD (apps/api/src/feedAppearance.ts has the same). */
export const HIDE_BELOW_MCAP = { min: 3_000, max: 20_000, step: 1_000 } as const;

const QUICK_LINK_IDS = new Set<string>(QUICK_LINK_SITES.map((l) => l.id));

/** Every hideable card field, grouped as the Settings tab lists them. */
export const CARD_FIELD_GROUPS: { title: string; fields: { id: CardField; label: string }[] }[] = [
  {
    title: "Header",
    fields: [
      { id: "tokenName", label: "Token name" },
      { id: "time", label: "Time since alert" },
      { id: "modelPill", label: "Model and confidence" },
      { id: "conviction", label: "High conviction" },
      { id: "calibrated", label: "Of alerts like it 2x'd" },
      { id: "result", label: "Result mark (✓ / ✕)" },
    ],
  },
  {
    title: "Price boxes",
    fields: [
      { id: "alert", label: "Alert" },
      { id: "now", label: "Now" },
      { id: "peak", label: "Peak" },
      { id: "ath", label: "ATH under Peak" },
    ],
  },
  {
    title: "Stat tiles",
    fields: [
      { id: "score", label: "Composite score" },
      { id: "holders", label: "Holders" },
      { id: "age", label: "Age" },
      { id: "top10", label: "Top 10" },
      { id: "largest", label: "Largest holder" },
      { id: "fresh", label: "Fresh" },
      { id: "empty", label: "Empty" },
      { id: "snipers", label: "First buyers holding" },
      { id: "sniperTop10", label: "Snipers in top holders" },
      { id: "blockZero", label: "Block 0 snipers" },
      { id: "linked", label: "Linked wallets" },
      { id: "cexFunded", label: "CEX-funded holders" },
      { id: "kolBundled", label: "KOL Bundled %" },
      { id: "transferred", label: "Transferred Supply %" },
      { id: "dev", label: "Dev holding / sold" },
    ],
  },
  {
    title: "Extras",
    fields: [
      { id: "reasons", label: "Model reasons" },
      { id: "mint", label: "Copy mint button" },
      { id: "links", label: "Dex / Pump links" },
      { id: "socials", label: "Website / X pills" },
      { id: "fees", label: "Fees badge" },
    ],
  },
];

// "vol" is listed apart from the groups: it is opt-in (FeedAppearance.volume), not hide-able.
// "sage" is a hideable card field on the API schema. A saved hidden list that names it is kept.
// "reasons", "sniperTop10", "largest", "kolBundled", "transferred" and "dev" are listed in the groups
// but have their own switches too (FeedAppearance.reasons, .sniperTop10, .largest, .kolBundled,
// .transferred, .devTile, and .feesBadge for "fees").
const CARD_FIELDS = new Set<string>([
  ...CARD_FIELD_GROUPS.flatMap((g) => g.fields.map((f) => f.id)),
  "vol",
  "sage",
]);

/** The card fields not to draw: the ones the user hid, plus the opt-in ones not switched on. */
export function cardHideSet(
  look: Pick<
    FeedAppearance,
    | "hidden"
    | "volume"
    | "reasons"
    | "sniperTop10"
    | "devTile"
    | "largest"
    | "kolBundled"
    | "transferred"
    | "feesBadge"
  >,
): ReadonlySet<CardField> {
  const out = new Set<CardField>(look.hidden);
  if (!look.volume) out.add("vol");
  if (!look.reasons) out.add("reasons");
  if (!look.sniperTop10) out.add("sniperTop10");
  if (!look.devTile) out.add("dev");
  if (!look.largest) out.add("largest");
  if (!look.kolBundled) out.add("kolBundled");
  if (!look.transferred) out.add("transferred");
  if (!look.feesBadge) out.add("fees");
  return out;
}

/** Ready-made looks. Each keeps the user's theme and colors and sets the rest. */
export const PRESETS: { id: string; label: string; hint: string; look: Partial<FeedAppearance> }[] = [
  { id: "default", label: "Default", hint: "The standard cards", look: {} },
  {
    id: "compact",
    label: "Compact",
    hint: "Tighter cards, more on screen",
    look: { density: "compact", cardWidth: "narrow", textSize: 95, avatar: "small" },
  },
  {
    id: "minimal",
    label: "Minimal",
    hint: "Price boxes and the key wallet checks",
    look: {
      density: "compact",
      hidden: ["tokenName", "calibrated", "ath", "score", "holders", "age", "top10", "snipers", "mint"],
      learningNote: false,
    },
  },
  {
    id: "big",
    label: "Big and clear",
    hint: "Larger text and images, roomy spacing",
    look: { density: "roomy", cardWidth: "wide", textSize: 115, avatar: "large", corners: "round" },
  },
  {
    id: "wall",
    label: "Trading wall",
    hint: "Four columns of dense cards on desktop, two on phones",
    look: {
      density: "compact",
      columns: 4,
      phoneColumns: 2,
      textSize: 90,
      corners: "square",
      hidden: ["tokenName", "calibrated", "score"],
    },
  },
];

/** Swatches offered beside the color picker. */
export const SWATCHES = [
  "#8b5cf6",
  "#3b82f6",
  "#06b6d4",
  "#22c55e",
  "#eab308",
  "#f97316",
  "#ef4444",
  "#ec4899",
];

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;
const intIn = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const hex = (value: unknown): string | null =>
  typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;

/** Anything read back (localStorage, an API build ahead or behind) as a valid appearance. */
export function normalizeAppearance(raw: unknown): FeedAppearance {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_APPEARANCE;
  return {
    theme: pick(r.theme, ["auto", "dark", "light"] as const, d.theme),
    accent: hex(r.accent),
    mine: hex(r.mine),
    win: hex(r.win),
    loss: hex(r.loss),
    density: pick(r.density, ["compact", "cozy", "roomy"] as const, d.density),
    columns: intIn(r.columns, 0, 4, d.columns),
    cardWidth: pick(r.cardWidth, ["narrow", "normal", "wide"] as const, d.cardWidth),
    phoneColumns: intIn(r.phoneColumns, 1, 2, d.phoneColumns),
    textSize: intIn(r.textSize, 85, 125, d.textSize),
    corners: pick(r.corners, ["square", "rounded", "round"] as const, d.corners),
    avatar: pick(r.avatar, ["small", "normal", "large"] as const, d.avatar),
    sourceStripe: typeof r.sourceStripe === "boolean" ? r.sourceStripe : d.sourceStripe,
    learningNote: typeof r.learningNote === "boolean" ? r.learningNote : d.learningNote,
    volume: typeof r.volume === "boolean" ? r.volume : d.volume,
    scoreColor: typeof r.scoreColor === "boolean" ? r.scoreColor : d.scoreColor,
    tileColors: typeof r.tileColors === "boolean" ? r.tileColors : d.tileColors,
    tileFill: typeof r.tileFill === "boolean" ? r.tileFill : d.tileFill,
    tileLow: hex(r.tileLow),
    tileMid: hex(r.tileMid),
    tileHigh: hex(r.tileHigh),
    reasons: typeof r.reasons === "boolean" ? r.reasons : d.reasons,
    // Saved before Block 0 took its default place, still on: the old default, unchanged.
    sniperTop10:
      typeof r.sniperTop10 === "boolean" && (!r.sniperTop10 || r.sniperTop10Rev === SNIPER_TOP10_REV)
        ? r.sniperTop10
        : d.sniperTop10,
    sniperTop10Rev: SNIPER_TOP10_REV,
    devTile: typeof r.devTile === "boolean" ? r.devTile : d.devTile,
    largest: typeof r.largest === "boolean" ? r.largest : d.largest,
    kolBundled: typeof r.kolBundled === "boolean" ? r.kolBundled : d.kolBundled,
    transferred: typeof r.transferred === "boolean" ? r.transferred : d.transferred,
    // Saved before the badge showed by default, still off: the old default, unchanged.
    feesBadge:
      typeof r.feesBadge === "boolean" && (r.feesBadge || r.feesBadgeRev === FEES_BADGE_REV)
        ? r.feesBadge
        : d.feesBadge,
    feesBadgeRev: FEES_BADGE_REV,
    cardSearch: typeof r.cardSearch === "boolean" ? r.cardSearch : d.cardSearch,
    bubbleCexLinks: typeof r.bubbleCexLinks === "boolean" ? r.bubbleCexLinks : d.bubbleCexLinks,
    bubbleFunderLabels:
      typeof r.bubbleFunderLabels === "boolean" ? r.bubbleFunderLabels : d.bubbleFunderLabels,
    bubbleSideLinks: typeof r.bubbleSideLinks === "boolean" ? r.bubbleSideLinks : d.bubbleSideLinks,
    bubbleTransferLinks:
      typeof r.bubbleTransferLinks === "boolean" ? r.bubbleTransferLinks : d.bubbleTransferLinks,
    bubbleRefreshSeconds: BUBBLE_REFRESH_CHOICES.some((c) => c.seconds === r.bubbleRefreshSeconds)
      ? (r.bubbleRefreshSeconds as number)
      : d.bubbleRefreshSeconds,
    bubbleNameLabels: typeof r.bubbleNameLabels === "boolean" ? r.bubbleNameLabels : d.bubbleNameLabels,
    bubbleNamesPumpfun: typeof r.bubbleNamesPumpfun === "boolean" ? r.bubbleNamesPumpfun : null,
    bubbleNamesFomo: typeof r.bubbleNamesFomo === "boolean" ? r.bubbleNamesFomo : null,
    bubbleNamesHelius: typeof r.bubbleNamesHelius === "boolean" ? r.bubbleNamesHelius : null,
    narrativeNote: typeof r.narrativeNote === "boolean" ? r.narrativeNote : null,
    streamTab: typeof r.streamTab === "boolean" ? r.streamTab : d.streamTab,
    hideLighthouseTab: typeof r.hideLighthouseTab === "boolean" ? r.hideLighthouseTab : d.hideLighthouseTab,
    hideSafetyPill: typeof r.hideSafetyPill === "boolean" ? r.hideSafetyPill : d.hideSafetyPill,
    tokenView: r.tokenView === "pro" || r.tokenView === "classic" ? r.tokenView : d.tokenView,
    outline: hex(r.outline),
    outlineResult: typeof r.outlineResult === "boolean" ? r.outlineResult : d.outlineResult,
    ...hideBelowMcapOf(r),
    quickLinks: Array.isArray(r.quickLinks)
      ? [
          ...new Set(
            r.quickLinks.filter((l): l is QuickLink => typeof l === "string" && QUICK_LINK_IDS.has(l)),
          ),
        ]
      : d.quickLinks,
    chartMarks: typeof r.chartMarks === "boolean" ? r.chartMarks : d.chartMarks,
    chartMarkKinds: chartMarkKindsOf(r),
    chartMarksRev: CHART_MARKS_REV,
    chartMarkMinSol:
      typeof r.chartMarkMinSol === "number" && Number.isFinite(r.chartMarkMinSol)
        ? Math.min(CHART_MARK_MAX_SOL, Math.max(CHART_MARK_MIN_SOL, r.chartMarkMinSol))
        : d.chartMarkMinSol,
    chartMarkPics: typeof r.chartMarkPics === "boolean" ? r.chartMarkPics : d.chartMarkPics,
    chartMarkScale:
      r.chartMarkScale === "s" || r.chartMarkScale === "l" || r.chartMarkScale === "m"
        ? r.chartMarkScale
        : d.chartMarkScale,
    chartMarkShape: pick(r.chartMarkShape, ["circle", "square", "diamond"] as const, d.chartMarkShape),
    chartMarkStem: typeof r.chartMarkStem === "boolean" ? r.chartMarkStem : d.chartMarkStem,
    chartMarkGap: pick(r.chartMarkGap, ["s", "m", "l"] as const, d.chartMarkGap),
    chartStyle: r.chartStyle === "candles" || r.chartStyle === "line" ? r.chartStyle : d.chartStyle,
    chartView: r.chartView === "trading" || r.chartView === "all" ? r.chartView : d.chartView,
    chartPathing: typeof r.chartPathing === "boolean" ? r.chartPathing : d.chartPathing,
    chartEvents: typeof r.chartEvents === "boolean" ? r.chartEvents : d.chartEvents,
    chartEventKinds: chartEventChoice(r.chartEventKinds, CHART_EVENT_KINDS, d.chartEventKinds),
    chartEventFirst: chartEventChoice(r.chartEventFirst, CHART_EVENT_FIRST_KINDS, d.chartEventFirst),
    chartEventLabels: typeof r.chartEventLabels === "boolean" ? r.chartEventLabels : d.chartEventLabels,
    chartEventScale: pick(r.chartEventScale, CHART_EVENT_SCALES, d.chartEventScale),
    chartEventEmphasis: pick(r.chartEventEmphasis, CHART_EVENT_EMPHASIS, d.chartEventEmphasis),
    chartTimeframeMs: chartTimeframeChoice(r.chartTimeframeMs),
    chartLogScale: typeof r.chartLogScale === "boolean" ? r.chartLogScale : d.chartLogScale,
    chartIndicators: chartIndicatorChoice(r.chartIndicators, d.chartIndicators),
    chartShowDrawings: typeof r.chartShowDrawings === "boolean" ? r.chartShowDrawings : d.chartShowDrawings,
    chartFibLevels: chartFibChoice(r.chartFibLevels),
    chartTrendExtend: typeof r.chartTrendExtend === "boolean" ? r.chartTrendExtend : d.chartTrendExtend,
    hidden: Array.isArray(r.hidden)
      ? [...new Set(r.hidden.filter((f): f is CardField => typeof f === "string" && CARD_FIELDS.has(f)))]
      : d.hidden,
  };
}

/** A saved look's low market cap hiding; see HIDE_BELOW_MCAP_REV. */
function hideBelowMcapOf(
  r: Record<string, unknown>,
): Pick<FeedAppearance, "hideBelowMcap" | "hideBelowMcapUsd" | "hideBelowMcapRev"> {
  const d = DEFAULT_APPEARANCE;
  const on = typeof r.hideBelowMcap === "boolean" ? r.hideBelowMcap : d.hideBelowMcap;
  const usd =
    typeof r.hideBelowMcapUsd === "number" && r.hideBelowMcapUsd % HIDE_BELOW_MCAP.step === 0
      ? intIn(r.hideBelowMcapUsd, HIDE_BELOW_MCAP.min, HIDE_BELOW_MCAP.max, d.hideBelowMcapUsd)
      : d.hideBelowMcapUsd;
  const oldDefault = r.hideBelowMcapRev !== HIDE_BELOW_MCAP_REV && !on && usd === 5_000;
  return {
    hideBelowMcap: oldDefault ? d.hideBelowMcap : on,
    hideBelowMcapUsd: oldDefault ? d.hideBelowMcapUsd : usd,
    hideBelowMcapRev: HIDE_BELOW_MCAP_REV,
  };
}

/** A saved look's chart mark kinds, in CHART_MARK_KINDS order; see reviseChartMarkKinds. */
function chartMarkKindsOf(r: Record<string, unknown>): FeedAppearance["chartMarkKinds"] {
  if (!Array.isArray(r.chartMarkKinds)) return DEFAULT_APPEARANCE.chartMarkKinds;
  const saved = r.chartMarkKinds as unknown[];
  // Canonical order, unlike the API, which keeps the order the look was saved in.
  const kinds = CHART_MARK_KINDS.filter((k) => saved.includes(k));
  return reviseChartMarkKinds(kinds, r.chartMarksRev);
}

/** A preset applied on top of the default, keeping the user's theme and colors. */
export function withPreset(current: FeedAppearance, look: Partial<FeedAppearance>): FeedAppearance {
  const {
    theme,
    accent,
    mine,
    win,
    loss,
    outline,
    outlineResult,
    tileColors,
    tileFill,
    tileLow,
    tileMid,
    tileHigh,
    quickLinks,
    narrativeNote,
    streamTab,
    hideLighthouseTab,
    hideSafetyPill,
    tokenView,
    hideBelowMcap,
    hideBelowMcapUsd,
    chartMarks,
    chartMarkKinds,
    chartMarkMinSol,
    chartMarkPics,
    chartMarkScale,
    chartMarkShape,
    chartMarkStem,
    chartMarkGap,
    chartStyle,
    chartView,
    chartPathing,
    chartEvents,
    chartEventKinds,
    chartEventFirst,
    chartEventLabels,
    chartEventScale,
    chartEventEmphasis,
    chartTimeframeMs,
    chartLogScale,
    chartIndicators,
    chartShowDrawings,
    chartFibLevels,
    chartTrendExtend,
    bubbleRefreshSeconds,
  } = current;
  return normalizeAppearance({
    ...DEFAULT_APPEARANCE,
    ...look,
    theme,
    accent,
    mine,
    win,
    loss,
    outline,
    outlineResult,
    tileColors,
    tileFill,
    tileLow,
    tileMid,
    tileHigh,
    quickLinks,
    narrativeNote,
    streamTab,
    hideLighthouseTab,
    hideSafetyPill,
    tokenView,
    hideBelowMcap,
    hideBelowMcapUsd,
    chartMarks,
    chartMarkKinds,
    chartMarkMinSol,
    chartMarkPics,
    chartMarkScale,
    chartMarkShape,
    chartMarkStem,
    chartMarkGap,
    chartStyle,
    chartView,
    chartPathing,
    chartEvents,
    chartEventKinds,
    chartEventFirst,
    chartEventLabels,
    chartEventScale,
    chartEventEmphasis,
    chartTimeframeMs,
    chartLogScale,
    chartIndicators,
    chartShowDrawings,
    chartFibLevels,
    chartTrendExtend,
    bubbleRefreshSeconds,
  });
}

/**
 * The default look, keeping the reader's tab and token-view choices (Settings' switches, not part
 * of how cards look - as withPreset keeps them).
 */
export function defaultLook(current: FeedAppearance): FeedAppearance {
  return {
    ...DEFAULT_APPEARANCE,
    streamTab: current.streamTab,
    hideLighthouseTab: current.hideLighthouseTab,
    hideSafetyPill: current.hideSafetyPill,
    tokenView: current.tokenView,
  };
}

/** Whether two appearances look the same (hidden fields in any order). */
export function sameAppearance(a: FeedAppearance, b: FeedAppearance): boolean {
  const key = (x: FeedAppearance) => JSON.stringify({ ...x, hidden: [...x.hidden].sort() });
  return key(a) === key(b);
}

// ---- The store ----

/** index.html reads this key too, to set the theme before the first paint. */
export const APPEARANCE_KEY = "ts.feedAppearance";
const SAVE_DELAY_MS = 600;

/** "local": kept on this device only (a guest, or before the account's settings have loaded). */
export type SaveState =
  { state: "idle" | "saving" | "saved" | "local" } | { state: "error"; message: string };

/**
 * Fields that used to live only in this browser. When a saved look (this device or the account)
 * does not have one yet, the device value is kept. An account that already saved the field wins.
 */
const LOCAL_CHART_PREF_KEYS = [
  "chartTimeframeMs",
  "chartLogScale",
  "chartIndicators",
  "chartFibLevels",
  "chartTrendExtend",
] as const satisfies readonly (keyof FeedAppearance)[];

function readLocal(): FeedAppearance {
  try {
    const text = localStorage.getItem(APPEARANCE_KEY);
    const raw: unknown = text ? JSON.parse(text) : null;
    const look = raw ? normalizeAppearance(raw) : DEFAULT_APPEARANCE;
    const patch = chartPrefsFromDevice(raw, (key) => localStorage.getItem(key));
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return look;
    const next = normalizeAppearance({ ...look, ...patch });
    writeLocal(next);
    for (const key of DEVICE_CHART_PREF_KEYS) localStorage.removeItem(key);
    return next;
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/**
 * A chart pref this browser already chose, filled in only where the account has not stored that
 * key. Parsing turns a missing key into the default, which is also a real choice (log off, Auto,
 * volume only), so a saved default must win. `storedKeys` is the account JSON's keys when the
 * payload was already parsed. Without it, `saved` itself is checked.
 */
/** Exported for tests. */
export function preferDeviceChartPrefs(
  saved: unknown,
  local: FeedAppearance,
  storedKeys?: readonly string[] | null,
): FeedAppearance {
  const incoming = normalizeAppearance(saved);
  const raw =
    typeof saved === "object" && saved !== null && !Array.isArray(saved)
      ? (saved as Record<string, unknown>)
      : {};
  const listed = storedKeys == null ? null : new Set(storedKeys);
  let changed = false;
  const next = { ...incoming };
  for (const key of LOCAL_CHART_PREF_KEYS) {
    const accountChose = listed !== null ? listed.has(key) : Object.prototype.hasOwnProperty.call(raw, key);
    if (accountChose) continue;
    if (JSON.stringify(local[key]) === JSON.stringify(incoming[key])) continue;
    next[key] = local[key] as never;
    changed = true;
  }
  return changed ? next : incoming;
}

function writeLocal(a: FeedAppearance) {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(a));
  } catch {
    // Storage blocked or full: the account copy still has it.
  }
}

let current: FeedAppearance = readLocal();
let saveState: SaveState = { state: "idle" };
/** Bumped by every local change, so a settings load that started before it doesn't undo it. */
let version = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight = 0;
/**
 * Whether changes go to an account: set once a signed-in settings load lands (adoptAppearance),
 * cleared on sign-out or guest mode (unbindAppearance). Until then the look stays on this device,
 * so a guest's choices never meet a 401 and nothing is saved to whoever signs in next.
 */
let bound = false;
/** A change made while signed in but before the account's look loaded: it goes to the account. */
let pendingLocal = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Puts the theme on the page root: "auto" follows the OS. */
function applyTheme(a: FeedAppearance) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (a.theme === "auto") delete root.dataset.theme;
  else root.dataset.theme = a.theme;
}
applyTheme(current);

// Another window of the dashboard (the Stream's pop-out) changed it: show the same look here. Only
// shown - that window saves it to the account.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== APPEARANCE_KEY) return;
    const next = readLocal();
    if (sameAppearance(next, current)) return;
    current = next;
    applyTheme(current);
    emit();
  });
}

export function useAppearance(): FeedAppearance {
  return useSyncExternalStore(subscribe, () => current);
}

export function useAppearanceSave(): SaveState {
  return useSyncExternalStore(subscribe, () => saveState);
}

/** The local version now; pass it to adoptAppearance with what a settings load returned. */
export function appearanceVersion(): number {
  return version;
}

/**
 * Takes the account's saved appearance (from GET /settings), unless this device changed it since
 * that request went out or still has a save on the way. An API build without it sends nothing.
 */
export function adoptAppearance(
  saved: unknown,
  sinceVersion: number,
  storedKeys?: readonly string[] | null,
): void {
  if (saved === undefined) return;
  const wasBound = bound;
  bound = true;
  if (pendingLocal || version !== sinceVersion || timer !== null || inflight > 0) {
    // Changed on this device before the account was known: that change goes to the account now.
    if ((!wasBound || pendingLocal) && timer === null && inflight === 0) scheduleSave();
    pendingLocal = false;
    return;
  }
  // A chart pref this device already chose stays when the account has not stored that key. A key
  // the account did store wins, including when the stored value is the default. The next change
  // of the look saves the whole thing.
  const next = preferDeviceChartPrefs(saved, current, storedKeys);
  if (sameAppearance(next, current)) return;
  current = next;
  writeLocal(current);
  applyTheme(current);
  emit();
}

/** Changes the appearance: shown at once, kept on this device, saved to the account shortly. */
export function setAppearance(change: Partial<FeedAppearance>): void {
  current = normalizeAppearance({ ...current, ...change });
  version++;
  writeLocal(current);
  applyTheme(current);
  if (!bound) {
    // A guest's look is this device's alone; a signed-in page still loading saves it once it can.
    if (!isGuest()) pendingLocal = true;
    saveState = { state: "local" };
    emit();
    return;
  }
  scheduleSave();
}

function scheduleSave() {
  saveState = { state: "saving" };
  emit();
  if (timer) clearTimeout(timer);
  // Sliders and quick clicks settle first; the whole appearance goes in one save.
  timer = setTimeout(() => {
    timer = null;
    void save();
  }, SAVE_DELAY_MS);
}

/**
 * Stops saving to an account (signed out, or browsing as a guest). The look stays on this device:
 * it is how this browser looks, and the next account's own look replaces it when it loads.
 */
export function unbindAppearance(): void {
  bound = false;
  pendingLocal = false;
  if (timer) clearTimeout(timer);
  timer = null;
  saveState = { state: "idle" };
  emit();
}

/** Whether appearance changes are being saved to an account. */
export function appearanceSynced(): boolean {
  return bound;
}

async function save() {
  const sending = current;
  const sentAt = version;
  inflight++;
  try {
    await put<{ appearance: FeedAppearance }>("/settings/appearance", sending);
    if (version === sentAt) saveState = { state: "saved" };
  } catch (e) {
    // Kept on this device either way; the next change tries the account again.
    if (version === sentAt)
      saveState = { state: "error", message: e instanceof Error ? e.message : String(e) };
  } finally {
    inflight--;
    emit();
  }
}

// ---- Applying it ----

const COLOR_SLOTS = ["win", "loss", "accent", "mine", "outline", "tileLow", "tileMid", "tileHigh"] as const;
const TILE_VARS = { tileLow: "--tile-low", tileMid: "--tile-mid", tileHigh: "--tile-high" } as const;

/**
 * The attributes and CSS variables the feed's card grid takes. Only what differs from the default
 * is set, so the default look is exactly the stylesheet's own. Colors go in as the theme's
 * variables, with the text shades mixed toward the theme's ink so they read in dark and light.
 */
export function feedGridProps(a: FeedAppearance): Record<string, string | CSSProperties | undefined> {
  const style: Record<string, string> = {};
  for (const slot of COLOR_SLOTS) {
    const c = a[slot];
    if (!c) continue;
    if (slot === "win") {
      style["--good"] = c;
      style["--good-ink"] = `color-mix(in srgb, ${c} 72%, var(--ink))`;
      style["--good-wash"] = `color-mix(in srgb, ${c} 12%, transparent)`;
    } else if (slot === "loss") {
      style["--bad"] = c;
      style["--bad-ink"] = `color-mix(in srgb, ${c} 72%, var(--ink))`;
      style["--bad-wash"] = `color-mix(in srgb, ${c} 12%, transparent)`;
    } else if (slot === "accent") {
      style["--brand-a"] = c;
      style["--brand-ink"] = `color-mix(in srgb, ${c} 65%, var(--ink))`;
    } else if (slot === "outline") {
      style["--card-outline"] = c;
    } else if (slot === "tileLow" || slot === "tileMid" || slot === "tileHigh") {
      style[TILE_VARS[slot]] = c;
    } else {
      style["--series-1"] = c;
    }
  }
  if (a.textSize !== 100) style["--card-zoom"] = String(a.textSize / 100);
  const d = DEFAULT_APPEARANCE;
  return {
    "data-density": a.density !== d.density ? a.density : undefined,
    "data-cols": a.columns !== d.columns ? String(a.columns) : undefined,
    "data-width": a.columns === 0 && a.cardWidth !== d.cardWidth ? a.cardWidth : undefined,
    "data-phone-cols": a.phoneColumns !== d.phoneColumns ? String(a.phoneColumns) : undefined,
    "data-corners": a.corners !== d.corners ? a.corners : undefined,
    "data-avatar": a.avatar !== d.avatar ? a.avatar : undefined,
    "data-outline-result": a.outlineResult ? undefined : "off",
    style: style as CSSProperties,
  };
}
