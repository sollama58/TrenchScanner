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
  "sage",
  "fees",
] as const;

/** Trading sites a card can link the token to (apps/web/src/appearance.ts has their URLs). */
export const QUICK_LINKS = ["terminal", "axiom", "gmgn"] as const;

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
    feesBadge: z.boolean().default(false),
    /** On bubble maps, ties between holders the same exchange funded (drawn only); off by default. */
    bubbleCexLinks: z.boolean().default(false),
    /** On bubble maps, ties from KOLs' possible side wallets (drawn only, never counted); on by default. */
    bubbleSideLinks: z.boolean().default(true),
    /** On bubble maps, arrows between holders that sent the coin to each other (drawn only); on by default. */
    bubbleTransferLinks: z.boolean().default(true),
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
    /** The card outline's color before the alert resolves; null keeps the theme's neutral one. */
    outline: color.default(null),
    /**
     * Mark a graded card green on a pass and red on a fail (a heavier outline with a halo); off by
     * default since 2026-10-14 (user ask), so an account that saved it on keeps it on.
     */
    outlineResult: z.boolean().default(false),
    /**
     * Hide Live feed alerts whose current market cap has fallen below hideBelowMcapUsd. Display only:
     * stats, grading and every count still include them. Off by default.
     */
    hideBelowMcap: z.boolean().default(false),
    /** The market cap, in USD, below which an alert is hidden when hideBelowMcap is on (3k-20k, 1k steps). */
    hideBelowMcapUsd: z
      .number()
      .int()
      .min(HIDE_BELOW_MCAP_MIN)
      .max(HIDE_BELOW_MCAP_MAX)
      .refine((v) => v % HIDE_BELOW_MCAP_STEP === 0, "not a whole step")
      .default(5_000),
    /** Trading sites each card links to, in this order; Padre's Trading Terminal by default. */
    quickLinks: z
      .array(z.enum(QUICK_LINKS))
      .max(QUICK_LINKS.length)
      .refine((l) => new Set(l).size === l.length, "quick links repeat")
      .default(["terminal"]),
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
  feesBadge: false,
  bubbleCexLinks: false,
  bubbleSideLinks: true,
  bubbleTransferLinks: true,
  bubbleNameLabels: false,
  bubbleNamesPumpfun: null,
  bubbleNamesFomo: null,
  bubbleNamesHelius: null,
  narrativeNote: null,
  streamTab: false,
  hideLighthouseTab: false,
  hideSafetyPill: false,
  outline: null,
  outlineResult: false,
  hideBelowMcap: false,
  hideBelowMcapUsd: 5_000,
  quickLinks: ["terminal"],
  // Off by default, all switchable back on in Customize: the composite score tile, so the stat tiles
  // fill a clean 4 x 2 grid, the TokenSage button (the token view keeps its own), the header's
  // "≈N% 2x" pill and the 1st Buyers Holding tile, which Snipers replaced (user asks 2026-10-14).
  // An account that saved its own field list keeps that list.
  hidden: ["score", "sage", "calibrated", "snipers"],
};

/** The stored JSON as an appearance, field by field: a bad or missing field takes its default. */
export function parseFeedAppearance(stored: unknown): FeedAppearance {
  const raw = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_FEED_APPEARANCE) as (keyof FeedAppearance)[]) {
    if (key === "hidden" || key === "quickLinks") continue;
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
  return out as FeedAppearance;
}
