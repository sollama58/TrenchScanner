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

export interface TooltipPrefs {
  /** Every line, in the order shown. */
  order: TipLine[];
  /** Lines the reader turned on or off; a line missing here takes its default. */
  on: Partial<Record<TipLine, boolean>>;
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

export const DEFAULT_TOOLTIP: TooltipPrefs = { order: TIP_LINES, on: {} };

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

/** Stored prefs made whole: unknown lines dropped, new lines added at their default place. */
export function cleanTooltip(raw: unknown): TooltipPrefs {
  const known = new Set<string>(TIP_LINES);
  const value = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<TooltipPrefs>;
  const order = (Array.isArray(value.order) ? value.order : []).filter(
    (line, i, all): line is TipLine => typeof line === "string" && known.has(line) && all.indexOf(line) === i,
  );
  for (const [i, line] of TIP_LINES.entries()) {
    if (order.includes(line)) continue;
    // After the line that comes before it by default, so a new line lands near its kin.
    const before = TIP_LINES.slice(0, i)
      .reverse()
      .find((l) => order.includes(l));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, line);
  }
  const on: TooltipPrefs["on"] = {};
  if (typeof value.on === "object" && value.on !== null) {
    for (const [line, v] of Object.entries(value.on))
      if (known.has(line) && typeof v === "boolean") on[line as TipLine] = v;
  }
  return { order, on };
}
