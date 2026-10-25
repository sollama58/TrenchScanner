import { FLAG_IDS, FLAG_LABELS } from "./settings";
import type { FlagId, OverlayBubbleTotals, OverlaySettings } from "./types";

/**
 * What the rings build's tooltip shows, and in what order (user ask 2026-10-25): every line can be
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

export interface TooltipPrefs extends ListPrefs<TipLine> {
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

export const DEFAULT_TOOLTIP: TooltipPrefs = {
  order: TIP_LINES,
  on: {},
  pill: { order: PILL_PARTS, on: {} },
  riskDot: true,
  second: { order: PILL_PARTS, on: {}, enabled: false },
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
  };
}
