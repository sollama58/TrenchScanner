import { z } from "zod";

/**
 * The account's synced preferences beyond the feed's look (feedAppearance.ts), its hidden tokens
 * and Scope (scopeSettings.ts): everything else the dashboard's Customize window sets that should
 * follow the wallet to every device. Stored on User.uiPrefs as JSON, one key per section, so a new
 * section needs no migration. Each section is saved whole on its own (PUT /settings/prefs/:section),
 * so a save from one part of Customize never undoes another's.
 *
 * Read through parseUserPrefs: a section that is missing or no longer passes its schema reads as
 * null, and the dashboard then keeps its own defaults (or this browser's choice). The schemas bound
 * what an account can store; apps/web/src/proTrade.ts and src/layoutPrefs.ts hold the same names
 * and bounds. Meant to be read by other clients of the same account too (the browser extension).
 */

/** The Pro Trade panel's defaults and the cards' quick-buy pill (apps/web/src/proTrade.ts). */
export const QUICK_BUY_POSITIONS = ["top-right", "top-left", "bottom-right", "bottom-left"] as const;
export const QUICK_BUY_COLORS = ["green", "blue", "purple", "amber", "pink", "gray"] as const;
/** Each custom fee's ceiling, SOL; the trade routes refuse more whatever is saved here. */
export const MAX_CUSTOM_FEE_SOL = 0.01;

const sol = z.number().finite();

export const tradePrefsSchema = z
  .object({
    buyPresets: z.array(sol.min(0.01).max(100)).min(1).max(10),
    sellPresets: z.array(sol.gt(0).max(100)).max(6),
    slippagePct: sol.min(0.1).max(50),
    speed: z.enum(["eco", "turbo"]),
    mevProtect: z.boolean(),
    priorityMode: z.enum(["auto", "custom"]),
    customPrioritySol: sol.min(0).max(MAX_CUSTOM_FEE_SOL),
    customTipSol: sol.gt(0).max(MAX_CUSTOM_FEE_SOL).nullable(),
    buyRows: z.union([z.literal(1), z.literal(2)]),
    quickBuy: z
      .object({
        enabled: z.boolean(),
        // 0 is a blank amount: the pill stays hidden until one is set.
        amountSol: sol.min(0).max(100),
        position: z.enum(QUICK_BUY_POSITIONS),
        size: z.enum(["s", "m", "l"]),
        color: z.enum(QUICK_BUY_COLORS),
      })
      .strict(),
    alwaysShowHeld: z.boolean(),
  })
  .strict();

/** The token window's views that can sit beside the Pro chart (apps/web TokenModal TERM_VIEWS). */
export const TOKEN_SIDE_VIEWS = [
  "none",
  "map",
  "trades",
  "holders",
  "wallets",
  "flow",
  "dev",
  "sage",
] as const;

/**
 * Layout choices that used to stay in one browser: whether the Live feed opens on Cards or Scope,
 * and what sits beside the Pro token chart. Sizes in pixels stay per device, as screens differ.
 */
export const layoutPrefsSchema = z
  .object({
    liveView: z.enum(["cards", "scope"]),
    tokenSide: z.enum(TOKEN_SIDE_VIEWS),
  })
  .strict();

export const USER_PREF_SECTIONS = {
  trade: tradePrefsSchema,
  layout: layoutPrefsSchema,
} as const;

export type UserPrefSection = keyof typeof USER_PREF_SECTIONS;
export type UserPrefs = { [K in UserPrefSection]: z.infer<(typeof USER_PREF_SECTIONS)[K]> | null };

export function isUserPrefSection(s: string): s is UserPrefSection {
  return Object.prototype.hasOwnProperty.call(USER_PREF_SECTIONS, s);
}

/** The stored JSON as the API hands it out: each section parsed, or null when absent or broken. */
export function parseUserPrefs(raw: unknown): UserPrefs {
  const obj =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<UserPrefSection, unknown>;
  for (const section of Object.keys(USER_PREF_SECTIONS) as UserPrefSection[]) {
    const parsed = USER_PREF_SECTIONS[section].safeParse(obj[section]);
    out[section] = parsed.success ? parsed.data : null;
  }
  return out as UserPrefs;
}
