import { FLAG_IDS, FLAG_LABELS } from "./settings";
import type { FlagId, OverlayBubbleTotals, OverlaySettings, Site } from "./types";
import { BOARD_COLUMNS, type BoardColumn } from "../content/columns";

/**
 * What the rings' tooltip shows, and in what order (user ask 2026-10-25): every line can be
 * turned off or moved. Kept in this browser only (chrome.storage.local), not on the account, so the
 * store build's settings never see it.
 *
 * The default is the tooltip as it was, plus KOL bundled %: the alerts, the market cap since the
 * alert, the flags turned on in Settings, the stats' age and the link. A flag's line follows its
 * Settings switch until the reader picks it here.
 */
export const MAP_LINES = [
  "kolBundledPct",
  "bundledPct",
  "sameMinutePct",
  "devTiedPct",
  "transferredPct",
] as const satisfies readonly (keyof OverlayBubbleTotals)[];
export type MapLine = (typeof MAP_LINES)[number];

export type TipLine =
  | "models"
  | "filters"
  | "ai"
  | "aiReasoning"
  | "mcap"
  | "holders"
  | "safety"
  | `flag:${FlagId}`
  | `map:${MapLine}`
  | "statsAge"
  | "link";

/** Every item of a list in the order shown, and the ones the reader turned on or off. */
export interface ListPrefs<T extends string> {
  order: T[];
  /** Items the reader turned on or off; an item missing here takes its default. */
  on: Partial<Record<T, boolean>>;
}

/**
 * What a ring's pill says, part by part (user ask 2026-10-25). The second pill is an extra one beside
 * the first with more of the coin's numbers, off until the reader turns it on.
 */
export type PillPart =
  "signal" | "odds" | "change" | "mcap" | "age" | "holders" | `flag:${FlagId}` | `map:${MapLine}`;

/**
 * Every colour the overlay draws with (user ask 2026-10-25): the rings' two tones per kind, the
 * pills, the flag levels, the tooltip, and the side panel's matching accents.
 */
export const COLOR_KEYS = [
  "model",
  "model2",
  "filter",
  "filter2",
  "risk",
  "risk2",
  "pillBg",
  "pillText",
  "ok",
  "mid",
  "hi",
  "tipBg",
  "tipText",
  "link",
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

export const DEFAULT_COLORS: Record<ColorKey, string> = {
  model: "#ff7a35",
  model2: "#ffc35a",
  filter: "#3fd7c9",
  filter2: "#8af1e7",
  risk: "#ff4d6a",
  risk2: "#ff9db0",
  pillBg: "#0d0e12",
  pillText: "#eef0f6",
  ok: "#7ef0ae",
  mid: "#f8d77a",
  hi: "#ff8b9d",
  tipBg: "#111218",
  tipText: "#eef0f6",
  link: "#4fd1e8",
};

export const COLOR_LABELS: Record<ColorKey, string> = {
  model: "Model alert",
  model2: "Model alert, second tone",
  filter: "Filter match",
  filter2: "Filter match, second tone",
  risk: "Past a flag's limit",
  risk2: "Past a flag's limit, second tone",
  pillBg: "Pill background",
  pillText: "Pill text",
  ok: "Good",
  mid: "Near a limit",
  hi: "Past a limit",
  tipBg: "Tooltip background",
  tipText: "Tooltip text",
  link: "Links",
};

/** Only a plain #rrggbb is taken, so nothing stored can reach a stylesheet as anything else. */
const HEX = /^#[0-9a-f]{6}$/i;

/** Every colour, the reader's where they picked one. */
export function colorsOf(prefs: Pick<TooltipPrefs, "colors">): Record<ColorKey, string> {
  const out = { ...DEFAULT_COLORS };
  for (const key of COLOR_KEYS) {
    const picked = prefs.colors[key];
    if (picked && HEX.test(picked)) out[key] = picked;
  }
  return out;
}

/** The colours as CSS custom properties (--c-model and so on), for a style rule's body. */
export function colorVars(colors: Record<ColorKey, string>): string {
  return COLOR_KEYS.map((key) => `--c-${key}: ${colors[key]};`).join(" ");
}

export const TOAST_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;
export type ToastPosition = (typeof TOAST_POSITIONS)[number];
export const TOAST_CLICKS = ["site", "trenchscanner", "none"] as const;
export type ToastClick = (typeof TOAST_CLICKS)[number];

/**
 * The on-page alert (user asks 2026-10-25): a toast on Axiom, Terminal or GMGN when a new alert
 * lands in the reader's feed. Off until turned on; every part of it is the reader's.
 */
export interface ToastPrefs {
  enabled: boolean;
  models: boolean;
  filters: boolean;
  /** Model alerts only at or above these odds to 2x (percent); 0 for any. */
  minOdds: number;
  /** Model alerts only when the AI reviewer says buy (accounts that see its verdicts). */
  aiBuyOnly: boolean;
  position: ToastPosition;
  /** How long a toast stays, in seconds; 0 keeps it until closed. */
  seconds: number;
  /** Toasts on screen at once; the oldest goes first. */
  maxShown: number;
  sound: boolean;
  /** What a click on the toast does: open the coin on this site, on TrenchScanner, or nothing. */
  click: ToastClick;
  sites: Record<Site, boolean>;
  /** What the toast says under its title, part by part. */
  parts: ListPrefs<PillPart>;
}

/** The bubble map tab on a coin's page (user ask 2026-10-25). */
export interface MapTabPrefs {
  enabled: boolean;
}

/**
 * Coins on a board that fail TrenchScanner's safety screen on their newest scan (user ask
 * 2026-10-25): left alone, hidden, or marked with an X. They show again once a scan passes them.
 */
export const SAFETY_MODES = ["off", "hide", "mark"] as const;
export type SafetyMode = (typeof SAFETY_MODES)[number];

export interface SafetyPrefs {
  mode: SafetyMode;
  /** The board columns it applies to (content/columns.ts); "other" is Trending, Discover and the rest. */
  columns: Record<BoardColumn, boolean>;
}

/** Our wallet markers beside the holders on a coin's page (user ask 2026-10-25). */
export interface HolderMarksPrefs {
  enabled: boolean;
}

/** An extra effect on one model's or filter's rings (user ask 2026-10-25). */
export const RING_EFFECTS = ["none", "pulse", "glow", "shimmer", "sparkle", "flash"] as const;
export type RingEffect = (typeof RING_EFFECTS)[number];

export const EFFECT_LABELS: Record<RingEffect, string> = {
  none: "None",
  pulse: "Pulse",
  glow: "Strong glow",
  shimmer: "Shimmer",
  sparkle: "Sparkle",
  flash: "Flash",
};

/** One model's or filter's own ring: its colour (in place of the kind's) and an effect. */
export interface SignalStyle {
  color?: string;
  effect?: RingEffect;
  /** Its name when picked, so Settings can list it while it has no alert in the feed. */
  name?: string;
}

/** A model's key is `model:<id>`, a filter's `filter:<id>`. */
export type SignalKey = `model:${string}` | `filter:${string}`;

/**
 * The panel's own options (user ask 2026-10-25), in both builds: alerts failing the safety screen
 * left out, Chrome's notifications for new alerts (off by default), and the count of unread alerts
 * on the toolbar icon.
 */
export interface PanelPrefs {
  hideUnsafe: boolean;
  notify: boolean;
  badge: boolean;
}

export interface TooltipPrefs extends ListPrefs<TipLine> {
  panel: PanelPrefs;
  toast: ToastPrefs;
  mapTab: MapTabPrefs;
  safety: SafetyPrefs;
  holderMarks: HolderMarksPrefs;
  /** Each model's and filter's own ring, where the reader picked one. */
  signals: Partial<Record<SignalKey, SignalStyle>>;
  /** Colours the reader picked; the rest take DEFAULT_COLORS. */
  colors: Partial<Record<ColorKey, string>>;
  pill: ListPrefs<PillPart>;
  /** The red dot on the pill when a flag is past its limit. */
  riskDot: boolean;
  second: ListPrefs<PillPart> & { enabled: boolean };
}

export const MAP_LABELS: Record<MapLine, { label: string; short: string }> = {
  kolBundledPct: { label: "KOL bundled", short: "KOLB" },
  bundledPct: { label: "Bundled (linked + KOL)", short: "BNDL+" },
  sameMinutePct: { label: "Funded the same minute", short: "SAME" },
  devTiedPct: { label: "Tied to the dev", short: "DEVT" },
  transferredPct: { label: "Transferred supply", short: "XFER" },
};

export const TIP_LINES: TipLine[] = [
  "models",
  "filters",
  "ai",
  "aiReasoning",
  "mcap",
  "holders",
  "safety",
  ...FLAG_IDS.map((id) => `flag:${id}` as const),
  ...MAP_LINES.map((id) => `map:${id}` as const),
  "statsAge",
  "link",
];

const FIXED_LABELS: Record<string, string> = {
  models: "Model calls",
  filters: "Filter matches",
  ai: "AI verdict",
  aiReasoning: "AI reasoning",
  mcap: "Market cap since the alert",
  holders: "Holders",
  safety: "Safety screen, with why it fails",
  statsAge: "Stats' age",
  link: "Open in TrenchScanner link",
};

export function tipLabel(line: TipLine): string {
  if (line.startsWith("flag:")) return FLAG_LABELS[line.slice(5) as FlagId].label;
  if (line.startsWith("map:")) return `${MAP_LABELS[line.slice(4) as MapLine].label} %`;
  return FIXED_LABELS[line] ?? line;
}

export const PILL_PARTS: PillPart[] = [
  "signal",
  "odds",
  "change",
  "mcap",
  "age",
  "holders",
  ...FLAG_IDS.map((id) => `flag:${id}` as const),
  ...MAP_LINES.map((id) => `map:${id}` as const),
];

const PILL_LABELS: Record<string, string> = {
  signal: "Model or filter name",
  odds: "Model's odds to 2x",
  change: "Change since the alert",
  mcap: "Market cap now",
  age: "Time since the alert",
  holders: "Holders",
};

export function pillLabel(part: PillPart): string {
  if (part.startsWith("flag:") || part.startsWith("map:")) return tipLabel(part as TipLine);
  return PILL_LABELS[part] ?? part;
}

const PILL_ON = new Set<PillPart>(["signal", "odds"]);
const SECOND_ON = new Set<PillPart>([
  "change",
  "holders",
  "flag:bundledSupplyPct",
  "flag:linkedWalletPct",
  "map:kolBundledPct",
]);

const TOAST_ON = new Set<PillPart>(["odds", "mcap", "flag:bundledSupplyPct", "flag:linkedWalletPct"]);

export function toastPartOn(part: PillPart, prefs: ListPrefs<PillPart>): boolean {
  return prefs.on[part] ?? TOAST_ON.has(part);
}

export const DEFAULT_TOAST: ToastPrefs = {
  enabled: false,
  models: true,
  filters: true,
  minOdds: 0,
  aiBuyOnly: false,
  position: "top-right",
  seconds: 8,
  maxShown: 3,
  sound: false,
  click: "site",
  sites: { axiom: true, terminal: true, gmgn: true },
  parts: { order: PILL_PARTS, on: {} },
};

export const DEFAULT_TOOLTIP: TooltipPrefs = {
  order: TIP_LINES,
  on: {},
  pill: { order: PILL_PARTS, on: {} },
  riskDot: true,
  second: { order: PILL_PARTS, on: {}, enabled: false },
  colors: {},
  panel: { hideUnsafe: false, notify: false, badge: true },
  toast: DEFAULT_TOAST,
  mapTab: { enabled: true },
  safety: { mode: "off", columns: { new: true, soon: true, graduated: true, other: true } },
  holderMarks: { enabled: true },
  signals: {},
};

export function partOn(part: PillPart, prefs: ListPrefs<PillPart>, second: boolean): boolean {
  return prefs.on[part] ?? (second ? SECOND_ON : PILL_ON).has(part);
}

/** The parts each pill shows, in order; the second pill's is null while it is off. */
export function pillParts(prefs: TooltipPrefs): { main: PillPart[]; more: PillPart[] | null } {
  return {
    main: prefs.pill.order.filter((p) => partOn(p, prefs.pill, false)),
    more: prefs.second.enabled ? prefs.second.order.filter((p) => partOn(p, prefs.second, true)) : null,
  };
}

/** The pills need the coins' bubble map totals for some part. */
export function pillsNeedMap(prefs: TooltipPrefs): boolean {
  const { main, more } = pillParts(prefs);
  return [...main, ...(more ?? [])].some((p) => p.startsWith("map:"));
}

/** Lines on unless the reader turned them off; flags follow Settings; the rest start off. */
const ON_BY_DEFAULT = new Set<TipLine>([
  "models",
  "filters",
  "ai",
  "aiReasoning",
  "mcap",
  "safety",
  "map:kolBundledPct",
  "statsAge",
  "link",
]);

export function lineOn(line: TipLine, prefs: TooltipPrefs, settings: OverlaySettings): boolean {
  const picked = prefs.on[line];
  if (picked !== undefined) return picked;
  if (line.startsWith("flag:")) return settings.flags[line.slice(5) as FlagId].on;
  return ON_BY_DEFAULT.has(line);
}

/** The lines to draw, in order. */
export function shownLines(prefs: TooltipPrefs, settings: OverlaySettings): TipLine[] {
  return prefs.order.filter((line) => lineOn(line, prefs, settings));
}

/** The tooltip needs the coin's bubble map totals for some line. */
export function needsMap(prefs: TooltipPrefs, settings: OverlaySettings): boolean {
  return shownLines(prefs, settings).some((line) => line.startsWith("map:"));
}

/** A stored list made whole: unknown items dropped, new items added at their default place. */
function cleanList<T extends string>(raw: unknown, all: readonly T[]): ListPrefs<T> {
  const known = new Set<string>(all);
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<ListPrefs<T>>;
  const order = (Array.isArray(value.order) ? value.order : []).filter(
    (item, i, list): item is T => typeof item === "string" && known.has(item) && list.indexOf(item) === i,
  );
  for (const [i, item] of all.entries()) {
    if (order.includes(item)) continue;
    // After the item that comes before it by default, so a new one lands near its kin.
    const before = all
      .slice(0, i)
      .reverse()
      .find((l) => order.includes(l));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, item);
  }
  const on: ListPrefs<T>["on"] = {};
  if (typeof value.on === "object" && value.on !== null) {
    for (const [item, v] of Object.entries(value.on))
      if (known.has(item) && typeof v === "boolean") on[item as T] = v;
  }
  return { order, on };
}

function cleanToast(raw: unknown): ToastPrefs {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<ToastPrefs>;
  const d = DEFAULT_TOAST;
  const bool = (x: unknown, fallback: boolean) => (typeof x === "boolean" ? x : fallback);
  const num = (x: unknown, fallback: number, min: number, max: number) =>
    typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, Math.round(x))) : fallback;
  const sites = (typeof v.sites === "object" && v.sites !== null ? v.sites : {}) as Partial<
    Record<Site, unknown>
  >;
  return {
    enabled: bool(v.enabled, d.enabled),
    models: bool(v.models, d.models),
    filters: bool(v.filters, d.filters),
    minOdds: num(v.minOdds, d.minOdds, 0, 100),
    aiBuyOnly: bool(v.aiBuyOnly, d.aiBuyOnly),
    position: TOAST_POSITIONS.includes(v.position as ToastPosition)
      ? (v.position as ToastPosition)
      : d.position,
    seconds: num(v.seconds, d.seconds, 0, 600),
    maxShown: num(v.maxShown, d.maxShown, 1, 10),
    sound: bool(v.sound, d.sound),
    click: TOAST_CLICKS.includes(v.click as ToastClick) ? (v.click as ToastClick) : d.click,
    sites: {
      axiom: bool(sites.axiom, true),
      terminal: bool(sites.terminal, true),
      gmgn: bool(sites.gmgn, true),
    },
    parts: cleanList(v.parts, PILL_PARTS),
  };
}

/** Signals this many at most are kept, so storage can't grow without bound. */
const MAX_SIGNALS = 100;
const SIGNAL_KEY = /^(model|filter):[\w.:-]{1,80}$/;

function cleanSignals(raw: unknown): TooltipPrefs["signals"] {
  const out: TooltipPrefs["signals"] = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw).slice(0, MAX_SIGNALS)) {
    if (!SIGNAL_KEY.test(key) || typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    const style: SignalStyle = {};
    if (typeof v.color === "string" && HEX.test(v.color)) style.color = v.color.toLowerCase();
    if (RING_EFFECTS.includes(v.effect as RingEffect) && v.effect !== "none")
      style.effect = v.effect as RingEffect;
    if (!style.color && !style.effect) continue;
    if (typeof v.name === "string" && v.name.length > 0) style.name = v.name.slice(0, 60);
    out[key as SignalKey] = style;
  }
  return out;
}

/** A picked colour's second tone: the colour taken 45% of the way to white. */
export function lighter(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const v = (n >> shift) & 255;
    return Math.round(v + (255 - v) * 0.45)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

/** The ring's colours and effect for a row: the kind's, with its model's and filter's own on top. */
export function signalLook(
  prefs: Pick<TooltipPrefs, "colors" | "signals">,
  modelId: string | null,
  filterId: string | null,
): { colors: Record<ColorKey, string>; effect: RingEffect } {
  const colors = colorsOf(prefs);
  const model = modelId === null ? undefined : prefs.signals[`model:${modelId}`];
  const filter = filterId === null ? undefined : prefs.signals[`filter:${filterId}`];
  if (model?.color) {
    colors.model = model.color;
    colors.model2 = lighter(model.color);
  }
  if (filter?.color) {
    colors.filter = filter.color;
    colors.filter2 = lighter(filter.color);
  }
  return { colors, effect: model?.effect ?? filter?.effect ?? "none" };
}

function cleanSafety(raw: unknown): SafetyPrefs {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<SafetyPrefs>;
  const columns = (typeof v.columns === "object" && v.columns !== null ? v.columns : {}) as Partial<
    Record<BoardColumn, unknown>
  >;
  return {
    mode: SAFETY_MODES.includes(v.mode as SafetyMode) ? (v.mode as SafetyMode) : "off",
    columns: Object.fromEntries(BOARD_COLUMNS.map((c) => [c, columns[c] !== false])) as Record<
      BoardColumn,
      boolean
    >,
  };
}

function cleanColors(raw: unknown): TooltipPrefs["colors"] {
  const out: TooltipPrefs["colors"] = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const key of COLOR_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && HEX.test(value)) out[key] = value.toLowerCase();
  }
  return out;
}

function cleanPanel(raw: unknown): PanelPrefs {
  const v = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<PanelPrefs>;
  return { hideUnsafe: v.hideUnsafe === true, notify: v.notify === true, badge: v.badge !== false };
}

/** Stored prefs made whole, whatever was stored (or nothing). */
export function cleanTooltip(raw: unknown): TooltipPrefs {
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<TooltipPrefs>;
  const second = (typeof value.second === "object" && value.second !== null ? value.second : {}) as Partial<
    TooltipPrefs["second"]
  >;
  return {
    ...cleanList(value, TIP_LINES),
    pill: cleanList(value.pill, PILL_PARTS),
    riskDot: typeof value.riskDot === "boolean" ? value.riskDot : true,
    second: { ...cleanList(second, PILL_PARTS), enabled: second.enabled === true },
    colors: cleanColors(value.colors),
    panel: cleanPanel(value.panel),
    toast: cleanToast(value.toast),
    mapTab: { enabled: (value.mapTab as Partial<MapTabPrefs> | undefined)?.enabled !== false },
    safety: cleanSafety(value.safety),
    holderMarks: {
      enabled: (value.holderMarks as Partial<HolderMarksPrefs> | undefined)?.enabled !== false,
    },
    signals: cleanSignals(value.signals),
  };
}
