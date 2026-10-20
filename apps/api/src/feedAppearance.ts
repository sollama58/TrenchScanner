import { z } from "zod";

/**
 * How the Live feed looks for one user: theme, colors, spacing, columns and which card fields
 * show. Stored on User.feedAppearance as JSON so it follows the wallet to every device; a new
 * option needs no migration. Read through parseFeedAppearance, which fills anything missing or
 * unreadable with the default, so the default look is what an untouched account gets.
 *
 * apps/web/src/appearance.ts mirrors these names and bounds; they are the whole contract.
 */

/** Card fields a user can hide. */
export const CARD_FIELDS = [
  "tokenName",
  "time",
  "modelPill",
  "conviction",
  "calibrated",
  "result",
  "alert",
  "now",
  "peak",
  "ath",
  "vol",
  "score",
  "holders",
  "age",
  "top10",
  "fresh",
  "empty",
  "snipers",
  "sniperTop10",
  "linked",
  "cexFunded",
  "kolBundled",
  "transferred",
  "largest",
  "dev",
  "reasons",
  "mint",
  "links",
  "socials",
  "sage",
  "fees",
] as const;

/** Trading sites a card can link the token to (apps/web/src/appearance.ts has their URLs). */
export const QUICK_LINKS = ["terminal", "axiom", "gmgn"] as const;

/**
 * Kinds of labeled wallet whose trades the token chart can mark (apps/web/src/walletMarks.ts):
 * KOLs, Known Sides, KOL funded wallets, Probable Sides, the dev, risky wallets and dumpers,
 * winners, linked holders.
 */
export const CHART_MARK_KINDS = [
  "kol",
  "known",
  "funded",
  "probable",
  "dev",
  "risky",
  "winner",
  "linked",
] as const;
/** The kinds marked by default: all but risky wallets and dumpers (user ask 2026-10-18). */
export const DEFAULT_CHART_MARK_KINDS = CHART_MARK_KINDS.filter((k) => k !== "risky");

/**
 * Event flags the token chart can draw (apps/web/src/chartEvents.ts). A filter match is the flag
 * labeled "Alert"; model calls include "Model alert" and each model's name.
 */
export const CHART_EVENT_KINDS = ["alert", "screen", "filter", "model", "graduation", "scanned"] as const;
/** Shown by default: every kind but the screen pass. */
export const DEFAULT_CHART_EVENT_KINDS = CHART_EVENT_KINDS.filter((k) => k !== "screen");
/** Kinds that can collapse to the earliest flag. */
export const CHART_EVENT_FIRST_KINDS = ["alert", "filter", "model"] as const;
/** Only the first filter and the first model. Alerts are not collapsed unless the reader asks. */
export const DEFAULT_CHART_EVENT_FIRST = ["filter", "model"] as const;
/** apps/web/src/appearance.ts has the same. */
export const CHART_MARKS_REV = 2;
/**
 * Which hideBelowMcap default a look was saved against (apps/web/src/appearance.ts has the same): a
 * look from before it went on at 6k that still holds the old default (off at 5k) was never changed,
 * and reads as the new one (user ask 2026-10-18).
 */
export const HIDE_BELOW_MCAP_REV = 2;
/**
 * Which feesBadge default a look was saved against (apps/web/src/appearance.ts has the same): a
 * look from before the badge went on by default that still holds it off never changed it, and reads
 * as on (user ask 2026-10-19).
 */
export const FEES_BADGE_REV = 2;
/** The chart marks no trade under this many SOL, whatever the setting (user ask 2026-10-18). */
/**
 * How often an open bubble map may redraw, in seconds (user ask 2026-10-19): the choices
 * Customize offers, 5 seconds to a day (web appearance.ts BUBBLE_REFRESH_CHOICES has the same).
 */
export const BUBBLE_REFRESH_SECONDS = [
  5, 10, 15, 30, 60, 120, 300, 900, 1800, 3600, 21600, 43200, 86400,
] as const;
export const CHART_MARK_MIN_SOL = 0.25;
export const CHART_MARK_MAX_SOL = 1_000;

/** The Live feed's "hide below this market cap" slider: its range and step, in USD. */
export const HIDE_BELOW_MCAP_MIN = 3_000;
export const HIDE_BELOW_MCAP_MAX = 20_000;
export const HIDE_BELOW_MCAP_STEP = 1_000;

/** A color the user picked, as #rrggbb; null keeps the theme's own. */
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "colors are #rrggbb")
  .transform((c) => c.toLowerCase())
  .nullable();

export const feedAppearanceSchema = z
  .object({
    theme: z.enum(["auto", "dark", "light"]),
    accent: color,
    mine: color,
    win: color,
    loss: color,
    density: z.enum(["compact", "cozy", "roomy"]),
    /** Desktop columns; 0 fits as many cards as the width allows. */
    columns: z.number().int().min(0).max(4),
    /** How wide a card is when columns is 0. */
    cardWidth: z.enum(["narrow", "normal", "wide"]),
    phoneColumns: z.number().int().min(1).max(2),
    /** Card text and boxes, in percent. */
    textSize: z.number().int().min(85).max(125),
    corners: z.enum(["square", "rounded", "round"]),
    avatar: z.enum(["small", "normal", "large"]),
    /**
     * The retired colored left edge for your filter vs model calls (replaced by the card outline,
     * 2026-10-14). Still sent by every dashboard build, so it stays accepted; nothing reads it.
     */
    sourceStripe: z.boolean(),
    /** The "Learning from N graded moments" note under the feed. */
    learningNote: z.boolean(),
    // Options added after launch take a default when missing, so a dashboard tab still running an
    // older build (which doesn't send them) can keep saving.
    /** Volume tiles (5m / 1h / 24h) on the cards; off by default. */
    volume: z.boolean().default(false),
    /** Color the Score tile red to green against recent alerts' scores; on by default. */
    scoreColor: z.boolean().default(true),
    /** Shade the stat tiles on a lower / median / upper scale, upper at the safety screen's cut; off by default. */
    tileColors: z.boolean().default(false),
    /** Color the whole tile, not only its reading; off by default. */
    tileFill: z.boolean().default(false),
    /** The tile scale's colors; null keeps the theme's win, amber and loss colors. */
    tileLow: color.default(null),
    tileMid: color.default(null),
    tileHigh: color.default(null),
    /** The model's reasons under a model call; hidden by default, as are accounts saved before it. */
    reasons: z.boolean().default(false),
    /** The Snipers tile (launch snipers in the top holders); on by default since 2026-10-14, in place of 1st Buyers Holding. */
    sniperTop10: z.boolean().default(true),
    /**
     * The opt-in CEX-funded switch from before the tile took the Dev tile's default place (user ask
     * 2026-10-13): accepted from older tabs, ignored. CEX-funded is a default tile now, hidden like
     * any other through `hidden`.
     */
    cexFunded: z.boolean().optional(),
    /** The Dev Holding / Dev Sold tile; hidden by default since CEX-funded took its place. */
    devTile: z.boolean().default(false),
    /** The Largest holder tile (one wallet's share of supply, pools aside); hidden by default. */
    largest: z.boolean().default(false),
    /** The KOL Bundled % tile (supply held by KOLs and the holders tied to them); hidden by default. */
    kolBundled: z.boolean().default(false),
    /** The Transferred tile (supply moved holder to holder among the top 25); hidden by default. */
    transferred: z.boolean().default(false),
    /** The card footer's FEES badge (where the creator fee goes); hidden by default (user ask 2026-10-16). */
    feesBadge: z.boolean().default(true),
    /** Which default feesBadge was saved against; see FEES_BADGE_REV and parseFeedAppearance. */
    feesBadgeRev: z.literal(FEES_BADGE_REV).default(FEES_BADGE_REV),
    /** On bubble maps, ties between holders the same exchange funded (drawn only); off by default. */
    bubbleCexLinks: z.boolean().default(false),
    /** On bubble maps, a funder's name on a label by its diamond (the diamond and its lines always show); off by default. */
    bubbleFunderLabels: z.boolean().default(false),
    /** On bubble maps, ties from KOLs' possible side wallets (drawn only, never counted); on by default. */
    bubbleSideLinks: z.boolean().default(true),
    /** On bubble maps, arrows between holders that sent the coin to each other (drawn only); on by default. */
    bubbleTransferLinks: z.boolean().default(true),
    /** How often an open bubble map redraws, in seconds (BUBBLE_REFRESH_SECONDS); every 5 by default. */
    bubbleRefreshSeconds: z
      .number()
      .int()
      .refine((v) => (BUBBLE_REFRESH_SECONDS as readonly number[]).includes(v), "not an offered interval")
      .default(5),
    /** On bubble maps, Pump.fun, FOMO and Helius names on the wallets (KOLs' always show); off by default. */
    bubbleNameLabels: z.boolean().default(false),
    /**
     * Each kind's own choice, overriding bubbleNameLabels (user ask 2026-10-16): null follows it.
     * Any set hides the one switch, in Settings and on the map.
     */
    bubbleNamesPumpfun: z.boolean().nullable().default(null),
    bubbleNamesFomo: z.boolean().nullable().default(null),
    bubbleNamesHelius: z.boolean().nullable().default(null),
    /** The retired Bundled tile (folded into Linked, 2026-10-13): accepted from older tabs, ignored. */
    bundled: z.boolean().optional(),
    /**
     * The Narrative seat's "agrees"/"warns" note on other models' cards and Telegram alerts. Null
     * (the default) follows curation/narrativeNote.ts: off until the seat proves itself live.
     */
    narrativeNote: z.boolean().nullable().default(null),
    /** The Stream tab (every new token that passes the safety screen in the band); off by default. */
    streamTab: z.boolean().default(false),
    /** The retired opt-in Lighthouse switch (replaced 2026-10-15): accepted from older tabs, ignored. */
    lighthouseTab: z.boolean().optional(),
    /**
     * Hide the Lighthouse tab; off by default, so every account has the tab (user ask 2026-10-15). A
     * new key rather than lighthouseTab flipped, since that one's stored "off" was mostly the old default.
     */
    hideLighthouseTab: z.boolean().default(false),
    /** Hide the safety screen's pill in the token view's header; the Safety section stays (user ask 2026-10-16). */
    hideSafetyPill: z.boolean().default(false),
    /**
     * The token window's layout on a wide (desktop) window: Pro, the terminal with the chart, bubble
     * map and trading rail side by side, or Classic, the one scrolling page (user ask 2026-10-19). Pro by
     * default; a phone always gets the Classic page.
     */
    tokenView: z.enum(["pro", "classic"]).default("pro"),
    /** The card outline's color before the alert resolves; null keeps the theme's neutral one. */
    outline: color.default(null),
    /**
     * Mark a graded card green on a pass and red on a fail (a heavier outline with a halo); off by
     * default since 2026-10-14 (user ask), so an account that saved it on keeps it on.
     */
    outlineResult: z.boolean().default(false),
    /**
     * Hide Live feed alerts whose current market cap has fallen below hideBelowMcapUsd. Display only:
     * stats, grading and every count still include them. On at 6k by default (user ask 2026-10-18).
     */
    hideBelowMcap: z.boolean().default(true),
    /** The market cap, in USD, below which an alert is hidden when hideBelowMcap is on (3k-20k, 1k steps). */
    hideBelowMcapUsd: z
      .number()
      .int()
      .min(HIDE_BELOW_MCAP_MIN)
      .max(HIDE_BELOW_MCAP_MAX)
      .refine((v) => v % HIDE_BELOW_MCAP_STEP === 0, "not a whole step")
      .default(6_000),
    /** Which default hideBelowMcap was saved against; see HIDE_BELOW_MCAP_REV and parseFeedAppearance. */
    hideBelowMcapRev: z.literal(HIDE_BELOW_MCAP_REV).default(HIDE_BELOW_MCAP_REV),
    /** Trading sites each card links to, in this order; Padre's Trading Terminal by default. */
    quickLinks: z
      .array(z.enum(QUICK_LINKS))
      .max(QUICK_LINKS.length)
      .refine((l) => new Set(l).size === l.length, "quick links repeat")
      .default(["terminal"]),
    /** The token chart marks labeled wallets' trades (user ask 2026-10-18); on by default. */
    chartMarks: z.boolean().default(true),
    /** Which kinds of labeled wallet it marks; every kind but risky wallets and dumpers by default. */
    chartMarkKinds: z
      .array(z.enum(CHART_MARK_KINDS))
      .max(CHART_MARK_KINDS.length)
      .refine((k) => new Set(k).size === k.length, "chart mark kinds repeat")
      .default([...DEFAULT_CHART_MARK_KINDS]),
    /**
     * Which default chartMarkKinds was saved against: 2 from the build that turned risky wallets
     * off by default (user ask 2026-10-18). A list saved before it with every kind still on was
     * never changed, so reading it drops "risky" (parseFeedAppearance).
     */
    chartMarksRev: z.literal(CHART_MARKS_REV).default(CHART_MARKS_REV),
    /** The smallest trade it marks, in SOL: 0.5 by default, never under CHART_MARK_MIN_SOL. */
    chartMarkMinSol: z.number().min(CHART_MARK_MIN_SOL).max(CHART_MARK_MAX_SOL).default(0.5),
    /** KOLs' trades are marked with their X pictures rather than a letter (user ask 2026-10-19); on by default. */
    chartMarkPics: z.boolean().default(true),
    /** How big those marks draw: small, medium or large (user ask 2026-10-20); medium by default. */
    chartMarkScale: z.enum(["s", "m", "l"]).default("m"),
    /** The token chart draws a line or candles (user ask 2026-10-18); a line by default. */
    chartStyle: z.enum(["line", "candles"]).default("line"),
    /** The view the token chart opens on (user ask 2026-10-19): Trading, the latest at the right edge, or All. */
    chartView: z.enum(["trading", "all"]).default("trading"),
    /** Experimental: the token chart's dotted predicted price path (user ask 2026-10-18); off by default. */
    chartPathing: z.boolean().default(false),
    /**
     * Which event flags the token chart draws. Passed screen is off unless the reader turns it on.
     * Missing on a save from before this field: the default, so an older save still parses.
     */
    chartEventKinds: z
      .array(z.enum(CHART_EVENT_KINDS))
      .max(CHART_EVENT_KINDS.length)
      .refine((k) => new Set(k).size === k.length, "chart event kinds repeat")
      .default([...DEFAULT_CHART_EVENT_KINDS]),
    /**
     * Draw only the earliest flag of these kinds. Filter and model by default; alert is offered
     * and starts off. Missing on an older save: that default.
     */
    chartEventFirst: z
      .array(z.enum(CHART_EVENT_FIRST_KINDS))
      .max(CHART_EVENT_FIRST_KINDS.length)
      .refine((k) => new Set(k).size === k.length, "chart event first repeats")
      .default([...DEFAULT_CHART_EVENT_FIRST]),
    /** Card fields not shown. */
    hidden: z
      .array(z.enum(CARD_FIELDS))
      .max(CARD_FIELDS.length)
      .refine((h) => new Set(h).size === h.length, "hidden fields repeat"),
  })
  .strict();

export type FeedAppearance = z.infer<typeof feedAppearanceSchema>;

export const DEFAULT_FEED_APPEARANCE: FeedAppearance = {
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
  sourceStripe: true,
  learningNote: true,
  volume: false,
  scoreColor: true,
  tileColors: false,
  tileFill: false,
  tileLow: null,
  tileMid: null,
  tileHigh: null,
  reasons: false,
  sniperTop10: true,
  devTile: false,
  largest: false,
  kolBundled: false,
  transferred: false,
  feesBadge: true,
  feesBadgeRev: FEES_BADGE_REV,
  bubbleCexLinks: false,
  bubbleFunderLabels: false,
  bubbleSideLinks: true,
  bubbleTransferLinks: true,
  bubbleRefreshSeconds: 5,
  bubbleNameLabels: false,
  bubbleNamesPumpfun: null,
  bubbleNamesFomo: null,
  bubbleNamesHelius: null,
  narrativeNote: null,
  streamTab: false,
  hideLighthouseTab: false,
  hideSafetyPill: false,
  tokenView: "pro",
  outline: null,
  outlineResult: false,
  hideBelowMcap: true,
  hideBelowMcapUsd: 6_000,
  hideBelowMcapRev: HIDE_BELOW_MCAP_REV,
  quickLinks: ["terminal"],
  chartMarks: true,
  chartMarkKinds: [...DEFAULT_CHART_MARK_KINDS],
  chartMarksRev: CHART_MARKS_REV,
  chartMarkMinSol: 0.5,
  chartMarkPics: true,
  chartMarkScale: "m",
  chartStyle: "line",
  chartView: "trading",
  chartPathing: false,
  chartEventKinds: [...DEFAULT_CHART_EVENT_KINDS],
  chartEventFirst: [...DEFAULT_CHART_EVENT_FIRST],
  // Off by default, all switchable back on in Customize: the composite score tile, so the stat tiles
  // fill a clean 4 x 2 grid, the TokenSage button (the token view keeps its own), the header's
  // "≈N% 2x" pill and the 1st Buyers Holding tile, which Snipers replaced (user asks 2026-10-14).
  // An account that saved its own field list keeps that list.
  hidden: ["score", "sage", "calibrated", "snipers"],
};

/**
 * A saved list of chart-event kinds. Missing, repeated, or holding a value that is not a kind: the
 * default. Otherwise the reader's list, in `allowed` order (an empty list stays empty).
 */
function chosenKinds<T extends string>(raw: unknown, allowed: readonly T[], fallback: readonly T[]): T[] {
  if (!Array.isArray(raw) || new Set(raw).size !== raw.length) return [...fallback];
  if (raw.some((k) => typeof k !== "string" || !(allowed as readonly string[]).includes(k)))
    return [...fallback];
  const picked = new Set(raw as T[]);
  return allowed.filter((k) => picked.has(k));
}

/** The stored JSON as an appearance, field by field: a bad or missing field takes its default. */
export function parseFeedAppearance(stored: unknown): FeedAppearance {
  const raw = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_FEED_APPEARANCE) as (keyof FeedAppearance)[]) {
    if (
      key === "hidden" ||
      key === "quickLinks" ||
      key === "chartMarkKinds" ||
      key === "chartMarksRev" ||
      key === "chartEventKinds" ||
      key === "chartEventFirst" ||
      key === "hideBelowMcapRev" ||
      key === "feesBadgeRev"
    )
      continue;
    const parsed = feedAppearanceSchema.shape[key].safeParse(raw[key]);
    out[key] = parsed.success ? parsed.data : DEFAULT_FEED_APPEARANCE[key];
  }
  // Unknown or repeated field names (from a newer or older build) are dropped, not the whole list.
  const known = new Set<string>(CARD_FIELDS);
  out.hidden = Array.isArray(raw.hidden)
    ? [...new Set(raw.hidden.filter((f): f is string => typeof f === "string" && known.has(f)))]
    : DEFAULT_FEED_APPEARANCE.hidden;
  const sites = new Set<string>(QUICK_LINKS);
  out.quickLinks = Array.isArray(raw.quickLinks)
    ? [...new Set(raw.quickLinks.filter((l): l is string => typeof l === "string" && sites.has(l)))]
    : DEFAULT_FEED_APPEARANCE.quickLinks;
  const markKinds = new Set<string>(CHART_MARK_KINDS);
  const kinds = Array.isArray(raw.chartMarkKinds)
    ? [...new Set(raw.chartMarkKinds.filter((k): k is string => typeof k === "string" && markKinds.has(k)))]
    : DEFAULT_FEED_APPEARANCE.chartMarkKinds;
  // Saved before risky wallets went off by default, with every kind on: the old default, unchanged.
  out.chartMarkKinds =
    raw.chartMarksRev !== CHART_MARKS_REV && kinds.length === CHART_MARK_KINDS.length
      ? kinds.filter((k) => k !== "risky")
      : kinds;
  out.chartMarksRev = CHART_MARKS_REV;
  // A bad or repeated kind falls back to the default list; a real list is kept, in the listed order.
  out.chartEventKinds = chosenKinds(raw.chartEventKinds, CHART_EVENT_KINDS, DEFAULT_CHART_EVENT_KINDS);
  out.chartEventFirst = chosenKinds(raw.chartEventFirst, CHART_EVENT_FIRST_KINDS, DEFAULT_CHART_EVENT_FIRST);
  // Saved before low market caps were hidden by default, still off at 5k: the old default, unchanged.
  if (
    raw.hideBelowMcapRev !== HIDE_BELOW_MCAP_REV &&
    out.hideBelowMcap === false &&
    out.hideBelowMcapUsd === 5_000
  ) {
    out.hideBelowMcap = DEFAULT_FEED_APPEARANCE.hideBelowMcap;
    out.hideBelowMcapUsd = DEFAULT_FEED_APPEARANCE.hideBelowMcapUsd;
  }
  out.hideBelowMcapRev = HIDE_BELOW_MCAP_REV;
  // Saved before the fees badge showed by default, still off: the old default, unchanged.
  if (raw.feesBadgeRev !== FEES_BADGE_REV && out.feesBadge === false) out.feesBadge = true;
  out.feesBadgeRev = FEES_BADGE_REV;
  return out as FeedAppearance;
}
