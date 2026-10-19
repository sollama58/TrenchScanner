import { z } from "zod";

/**
 * Tokens a user hid from the Live feed's Cards and Scope views (user ask 2026-10-19), and whether
 * a hidden token comes back by itself when it graduates or reaches a new multiple (2x, 4x, 10x)
 * from the alert it was hidden on. Stored on User.hiddenTokens as JSON so the list follows the
 * account to every device. Read through parseHiddenTokens, which drops anything unreadable.
 *
 * apps/web/src/hiddenTokens.ts mirrors these names and bounds; they are the whole contract.
 */

/** The most tokens one account keeps hidden: past it the oldest hide drops off. */
export const MAX_HIDDEN_TOKENS = 500;

/** Multiples a hidden token's alert reaching unhides it (with auto-unhide on). */
export const UNHIDE_MULTIPLES = [2, 4, 10] as const;

const text = (max: number) => z.string().max(max).nullable().default(null);

export const hiddenTokenSchema = z
  .object({
    tokenId: z.string().min(1).max(64),
    mintAddress: text(64),
    symbol: text(64),
    name: text(128),
    imageUrl: text(512),
    hiddenAt: z.string().datetime(),
    /** The market cap of the alert it was hidden on: the multiples count from it. */
    baseMcapUsd: z.number().nonnegative().nullable().default(null),
    /** The highest of UNHIDE_MULTIPLES it had already reached when hidden (0: none). */
    reachedX: z.number().nonnegative().default(0),
    /** Whether it had already graduated when hidden. */
    graduated: z.boolean().default(false),
  })
  .strict();

export const hiddenTokensSchema = z
  .object({
    autoUnhide: z.boolean().default(true),
    tokens: z.array(hiddenTokenSchema).max(MAX_HIDDEN_TOKENS).default([]),
  })
  .strict();

export type HiddenTokens = z.infer<typeof hiddenTokensSchema>;

export const DEFAULT_HIDDEN_TOKENS: HiddenTokens = { autoUnhide: true, tokens: [] };

/** A stored list as this build reads it: unreadable entries dropped, the rest kept. */
export function parseHiddenTokens(raw: unknown): HiddenTokens {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const autoUnhide = typeof r.autoUnhide === "boolean" ? r.autoUnhide : DEFAULT_HIDDEN_TOKENS.autoUnhide;
  const tokens: HiddenTokens["tokens"] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(r.tokens) ? r.tokens : []) {
    const parsed = hiddenTokenSchema.safeParse(t);
    if (!parsed.success || seen.has(parsed.data.tokenId)) continue;
    seen.add(parsed.data.tokenId);
    tokens.push(parsed.data);
  }
  return { autoUnhide, tokens: tokens.slice(-MAX_HIDDEN_TOKENS) };
}
