import { z } from "zod";
import { paperStrategyConfigSchema } from "../trading/paper.js";
import type { FdsaExitPlan } from "./exitPlan.js";

/**
 * The FDSA desk (FdsaDesk, one row, id "fdsa"): its mode, its limits and the seam its trades go
 * through (owner decision 2026-10-31).
 *
 * Mode: Paper only for now (decision 6). FDSA_MODES names Live so the tab can show it as not yet
 * available, but FDSA_AVAILABLE_MODES - what readFdsaMode and every write accept - holds "paper"
 * alone, and a CHECK on FdsaDesk.mode refuses anything else in the database too. Nothing in FDSA
 * holds a key, builds a transaction or signs (fdsa.test.ts checks the imports).
 *
 * Limits: the trading bot's own config schema (trading/config.ts via the paper strategy's, with
 * its fill penalty), not a parallel set of settings, with FDSA's paper defaults (decision 4):
 * 0.5 SOL a trade (fixed: the model never sizes), at most 12 open, 100 SOL of entries per 24 h,
 * on a 25 SOL bankroll (6 open on 10 SOL from the owner's update of 2026-11-01 to 2026-11-02,
 * when the owner raised both so the record fills faster: audit FD-4, six open at three hours each
 * skipped a cluster of trade verdicts in every busy window; the migration of the same date lifts
 * the stored desk). The bot's own maxDailySpendSol default of 0.5 would allow one buy a day, so it
 * is overridden here. The reserve, slippage, Jito and fill-penalty defaults are the bot's. What a
 * bot follows (sources, the AI-buy filter) and its exit ladder mean nothing to FDSA - it reviews
 * every curated alert and exits on its own plan - so they are left out.
 */

export const FDSA_DESK_ID = "fdsa";
export const FDSA_MODES = ["paper", "live"] as const;
export type FdsaMode = (typeof FDSA_MODES)[number];
/** The modes that can be selected today. Live joins it in the PR that builds it. */
export const FDSA_AVAILABLE_MODES: readonly FdsaMode[] = ["paper"];

/** What a stored mode reads as: an available mode, else "paper". Never "live" in this build. */
export function readFdsaMode(raw: unknown): FdsaMode {
  return typeof raw === "string" && (FDSA_AVAILABLE_MODES as readonly string[]).includes(raw)
    ? (raw as FdsaMode)
    : "paper";
}

export const DEFAULT_FDSA_BANKROLL_SOL = 25;

export const fdsaDeskConfigSchema = paperStrategyConfigSchema.omit({ sources: true, exitPlan: true }).extend({
  /** SOL per entry - fixed, the model does not size (decision 4). */
  buySol: z.number().positive().default(0.5),
  maxOpenPositions: z.number().int().min(1).default(12),
  /** SOL of entries per rolling 24 hours: 200 buys at 0.5 SOL, so in practice the bankroll binds. */
  maxDailySpendSol: z.number().positive().default(100),
});
export type FdsaDeskConfig = z.infer<typeof fdsaDeskConfigSchema>;
export const DEFAULT_FDSA_DESK_CONFIG: FdsaDeskConfig = fdsaDeskConfigSchema.parse({});

/** A stored desk config; anything unreadable falls back to the defaults. */
export function readFdsaDeskConfig(raw: unknown): FdsaDeskConfig {
  const parsed = fdsaDeskConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_FDSA_DESK_CONFIG;
}

/**
 * The seam FDSA trades through. Review, sizing and exit code talk only to this, so the PR that
 * builds Live points it at the bot engine's real swap path (trading/engine.ts runTradingEngine's
 * buy and sell, with every guard it carries) and nothing above it changes. Paper's implementation
 * fills from live Jupiter quotes less the fill penalty and fees, as trading/paper.ts does.
 *
 * An executor never decides: the desk has already checked the mint (mintRisk), the signal's age,
 * the open-position cap, the 24 h spend, the reserve and the daily loss limit before it asks.
 */
export interface FdsaExecutor {
  readonly mode: FdsaMode;
  /** Buys `lamports` of `mint`. Resolves to the fill, or to a reason it didn't fill. */
  buy(order: FdsaBuyOrder): Promise<FdsaFillResult>;
  /** Sells `tokens` (raw units) of `mint`. A protective sale (stop, floor, hold cap) gets out first. */
  sell(order: FdsaSellOrder): Promise<FdsaFillResult>;
}

export interface FdsaBuyOrder {
  mint: string;
  lamports: bigint;
  config: FdsaDeskConfig;
}

export interface FdsaSellOrder {
  mint: string;
  tokens: bigint;
  decimals: number;
  /** A stop, floor, stall or hold-cap exit: sold with the wider exit slippage. */
  protective: boolean;
  config: FdsaDeskConfig;
}

export type FdsaFillResult =
  | {
      ok: true;
      /** SOL into (buy) or out of (sell) the swap itself. */
      lamports: bigint;
      /** Fees on top: network fee and tip (or priority fee). */
      feeLamports: bigint;
      /** Raw token units bought or sold. */
      tokens: bigint;
      /** Token decimals, known after a buy. */
      decimals: number;
    }
  | { ok: false; error: string; retryable: boolean };

/** The entry plan and the review behind a buy, as the decide stage hands it to the desk. */
export interface FdsaEntryIntent {
  reviewId: string;
  tokenId: string;
  mint: string;
  symbol: string | null;
  candidateOutcomeId: string | null;
  curatedAlertId: string | null;
  /** When the alert went out (the signal's age counts from here) and when the verdict landed. */
  signalAt: Date;
  verdictAt: Date;
  exitPlan: FdsaExitPlan;
}
