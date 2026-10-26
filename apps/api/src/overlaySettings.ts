import { z } from "zod";

/**
 * What the browser extension's side panel shows: which alerts, which flags, and which sites it
 * offers to open a token on (`sites`). `style` is the in-page ring's, kept for stored settings. Stored on
 * User.overlaySettings as JSON so a new setting needs no migration; read through
 * parseOverlaySettings, which fills anything missing or unreadable with the defaults.
 *
 * The flag ids are the contract with the extension: each names a TokenSnapshot field the lookup
 * returns (extensionLookup.ts), and `threshold` is the value past which the token is marked risky.
 */
export const OVERLAY_SITES = ["axiom", "terminal", "gmgn"] as const;
export const OVERLAY_RING_STYLES = ["halo", "brackets", "rail"] as const;

/** Each flag, its default, and whether a higher value is the risky side (all of them today). */
export const OVERLAY_FLAGS = {
  bundledSupplyPct: { on: true, threshold: 20 },
  sniperTopHolderCount: { on: true, threshold: 2 },
  linkedWalletPct: { on: true, threshold: 25 },
  devWalletPct: { on: false, threshold: 5 },
  top10HolderPct: { on: false, threshold: 30 },
  freshTop10WalletPct: { on: false, threshold: 40 },
  emptyTop10WalletCount: { on: false, threshold: 3 },
  cexFundedPct: { on: false, threshold: 40 },
  kolRecentBuyers: { on: false, threshold: null },
  mintAuthorityActive: { on: false, threshold: null },
} as const satisfies Record<string, { on: boolean; threshold: number | null }>;

export type OverlayFlagId = keyof typeof OVERLAY_FLAGS;
export const OVERLAY_FLAG_IDS = Object.keys(OVERLAY_FLAGS) as OverlayFlagId[];

const flagSchema = z.object({
  on: z.boolean(),
  threshold: z.number().finite().min(0).max(1_000_000).nullable(),
});

export const overlaySettingsSchema = z
  .object({
    rings: z
      .object({
        modelAlerts: z.boolean(),
        filterMatches: z.boolean(),
        /** Model rings only when the AI reviewer said buy. */
        aiBuyOnly: z.boolean(),
        /** A red ring when an enabled flag is past its threshold. */
        riskRing: z.boolean(),
      })
      .strict(),
    flags: z.object(
      Object.fromEntries(OVERLAY_FLAG_IDS.map((id) => [id, flagSchema])) as Record<
        OverlayFlagId,
        typeof flagSchema
      >,
    ),
    sites: z.object(
      Object.fromEntries(OVERLAY_SITES.map((s) => [s, z.boolean()])) as Record<
        (typeof OVERLAY_SITES)[number],
        z.ZodBoolean
      >,
    ),
    style: z.object({ ring: z.enum(OVERLAY_RING_STYLES), calmMotion: z.boolean() }).strict(),
  })
  .strict();

export type OverlaySettings = z.infer<typeof overlaySettingsSchema>;

export const DEFAULT_OVERLAY_SETTINGS: OverlaySettings = {
  rings: { modelAlerts: true, filterMatches: true, aiBuyOnly: false, riskRing: true },
  flags: Object.fromEntries(
    OVERLAY_FLAG_IDS.map((id) => [id, { ...OVERLAY_FLAGS[id] }]),
  ) as OverlaySettings["flags"],
  sites: { axiom: true, terminal: true, gmgn: true },
  // Halo by default (user decision 2026-10-23).
  style: { ring: "halo", calmMotion: false },
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Each field of a section on its own: a bad or missing field takes its default. */
function section<T extends Record<string, unknown>>(
  schema: z.ZodObject<z.ZodRawShape>,
  stored: unknown,
  fallback: T,
): T {
  const raw = record(stored);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fallback)) {
    const parsed = (schema.shape[key] as z.ZodType).safeParse(raw[key]);
    out[key] = parsed.success ? parsed.data : fallback[key];
  }
  return out as T;
}

/** The stored JSON as settings, field by field. */
export function parseOverlaySettings(stored: unknown): OverlaySettings {
  const raw = record(stored);
  const shape = overlaySettingsSchema.shape;
  return {
    rings: section(shape.rings, raw.rings, DEFAULT_OVERLAY_SETTINGS.rings),
    flags: section(shape.flags, raw.flags, DEFAULT_OVERLAY_SETTINGS.flags),
    sites: section(shape.sites, raw.sites, DEFAULT_OVERLAY_SETTINGS.sites),
    style: section(shape.style, raw.style, DEFAULT_OVERLAY_SETTINGS.style),
  };
}
