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
  "dev",
  "reasons",
  "mint",
  "links",
] as const;

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
    /** The colored edge saying whether a card came from your filter or a model. */
    sourceStripe: z.boolean(),
    /** The "Learning from N graded moments" note under the feed. */
    learningNote: z.boolean(),
    /** Volume tiles (5m / 1h / 24h) on the cards; off by default. */
    volume: z.boolean(),
    /** Card fields not shown. */
    hidden: z
      .array(z.enum(CARD_FIELDS))
      .max(CARD_FIELDS.length)
      .refine((h) => new Set(h).size === h.length, "hidden fields repeat"),
  })
  .strict();

export type FeedAppearance = z.infer<typeof feedAppearanceSchema>;

export const DEFAULT_FEED_APPEARANCE: FeedAppearance = {
  theme: "auto",
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
  hidden: [],
};

/** The stored JSON as an appearance, field by field: a bad or missing field takes its default. */
export function parseFeedAppearance(stored: unknown): FeedAppearance {
  const raw = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_FEED_APPEARANCE) as (keyof FeedAppearance)[]) {
    if (key === "hidden") continue;
    const parsed = feedAppearanceSchema.shape[key].safeParse(raw[key]);
    out[key] = parsed.success ? parsed.data : DEFAULT_FEED_APPEARANCE[key];
  }
  // Unknown or repeated field names (from a newer or older build) are dropped, not the whole list.
  const known = new Set<string>(CARD_FIELDS);
  out.hidden = Array.isArray(raw.hidden)
    ? [...new Set(raw.hidden.filter((f): f is string => typeof f === "string" && known.has(f)))]
    : [];
  return out as FeedAppearance;
}
