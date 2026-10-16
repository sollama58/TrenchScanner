import { z } from "zod";
import { EXIT_PLAN, type ExitPlan } from "../curation/profitSim.js";

/**
 * A trading bot's settings (TradingBot.config): what it buys on, how much, the guards, and the
 * exit plan. Validated here on every write and re-validated on every read, so a row edited by
 * hand or written by an older build can never hand the engine a value it would trade on blindly.
 */

export const LAMPORTS_PER_SOL = 1_000_000_000;

const exitPlanSchema = z
  .object({
    takeProfits: z
      .array(
        z.object({
          multiple: z.number().gt(1).max(1_000_000),
          sellFraction: z.number().gt(0).max(1),
        }),
      )
      .max(20),
    stopFraction: z.number().min(0).lt(1),
    maxHoldMinutes: z
      .number()
      .positive()
      .max(365 * 24 * 60),
    trail: z
      .array(
        z.object({
          fromMultiple: z.number().gt(0).max(1_000_000),
          fraction: z.number().gt(0).lt(1),
        }),
      )
      .max(20),
    trailMaxHoldMinutes: z
      .number()
      .positive()
      .max(365 * 24 * 60),
  })
  .refine((p) => p.takeProfits.reduce((s, tp) => s + tp.sellFraction, 0) <= 1 + 1e-9, {
    message: "take-profit sell fractions add up to more than the whole position",
    path: ["takeProfits"],
  })
  .refine((p) => new Set(p.takeProfits.map((tp) => tp.multiple)).size === p.takeProfits.length, {
    message: "two take-profit rungs at the same multiple",
    path: ["takeProfits"],
  });

/**
 * Bounds here are only what keeps a value meaningful (a slippage can't pass 100%, a count is a
 * whole number); the size of a bet is the admin's call (user decision 2026-10-15: no caps for
 * admins). Optional TRADING_MAX_* ceilings on the server still bound it where they are set.
 */
export const tradingBotConfigSchema = z.object({
  sources: z
    .object({
      /** The user's own filters (UserFilter ids) whose matches it buys. */
      filterIds: z.array(z.string().min(1).max(64)).max(100).default([]),
      /** Model contestants (CuratedAlert.model) whose calls it buys. */
      models: z.array(z.string().min(1).max(64)).max(100).default([]),
      /** Only model calls that cleared the model's high-conviction line. */
      highConvictionOnly: z.boolean().default(false),
      /**
       * Buy only what the AI judge reviewed and called "buy" (AiReview.decision). A signal waits
       * for its review while it is fresh (maxSignalAgeSeconds); one with a "no_buy", or with no
       * review by then, is skipped. The judge reviews high-conviction picks, so a source it never
       * reviews (most filter matches) never buys with this on.
       */
      requireAiBuy: z.boolean().default(true),
      /** With requireAiBuy: also skip a "buy" whose own 2x estimate is under this (0-1; 0 = any). */
      minAiProbability2x: z.number().min(0).max(1).default(0),
    })
    .default({}),
  /** SOL spent per entry. */
  buySol: z.number().positive().default(0.05),
  /** Positions held (or being bought) at once; signals past it are skipped, not queued. */
  maxOpenPositions: z.number().int().min(1).default(3),
  /** SOL spent on entries per rolling 24 hours. */
  maxDailySpendSol: z.number().positive().default(0.5),
  /** A signal older than this when the bot reaches it is not bought: the move it called is gone. */
  maxSignalAgeSeconds: z.number().int().min(5).max(86_400).default(120),
  /** Swap slippage tolerance in basis points (100 = 1%). Memecoins move; default 15%. */
  slippageBps: z.number().int().min(1).max(10_000).default(1500),
  /** The least slippage a stop, trail or timed exit sells with, so it gets out (bps). */
  exitSlippageBps: z.number().int().min(1).max(10_000).default(3000),
  /** How wide a protective exit that keeps failing may widen its slippage (bps). */
  exitSlippageMaxBps: z.number().int().min(1).max(10_000).default(5000),
  /** Tries at one entry before it is given up. */
  maxEntryTries: z.number().int().min(1).max(20).default(4),
  /** The most priority fee one swap may pay, in SOL (Jupiter sizes it under this cap). */
  maxPriorityFeeSol: z.number().min(0).default(0.002),
  /**
   * Send swaps through Jito's block engine with this tip (SOL) instead of a priority fee, so
   * they can't be sandwiched on the way in or out; 0 sends them to the RPC as before.
   */
  jitoTipSol: z.number().min(0).default(0.0001),
  /** Never spend the wallet below this, in SOL: fees and token-account rent come out of it. */
  reserveSol: z.number().min(0).default(0.02),
  /**
   * Stop buying once positions closed in the last 24 hours (since it was last started) lost this
   * much SOL between them, fees included; 0 is off. Open positions keep following their exits.
   */
  dailyLossLimitSol: z.number().min(0).default(0),
  /** Tell the owner's private Telegram chats about each buy, sale and automatic pause. */
  notifyTelegram: z.boolean().default(true),
  /** The exit plan; omitted means the project's default plan (EXIT_PLAN). */
  exitPlan: exitPlanSchema.nullable().default(null),
});

export type TradingBotConfig = z.infer<typeof tradingBotConfigSchema>;

export const DEFAULT_TRADING_BOT_CONFIG: TradingBotConfig = tradingBotConfigSchema.parse({});

/** Parses a stored config; anything unreadable falls back to the defaults with the bot's sources cleared. */
export function readTradingBotConfig(raw: unknown): TradingBotConfig {
  const parsed = tradingBotConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_TRADING_BOT_CONFIG;
}

/** The plan a config trades under: its own, or the default. */
export function effectiveExitPlan(config: Pick<TradingBotConfig, "exitPlan">): ExitPlan {
  return config.exitPlan ?? EXIT_PLAN;
}

/** Copies the plan into plain JSON, for the position's snapshot of the plan it was opened under. */
export function exitPlanJson(plan: ExitPlan): ExitPlan {
  return {
    takeProfits: plan.takeProfits.map((tp) => ({ multiple: tp.multiple, sellFraction: tp.sellFraction })),
    stopFraction: plan.stopFraction,
    maxHoldMinutes: plan.maxHoldMinutes,
    trail: plan.trail.map((t) => ({ fromMultiple: t.fromMultiple, fraction: t.fraction })),
    trailMaxHoldMinutes: plan.trailMaxHoldMinutes,
  };
}

/** Reads a position's stored plan; an unreadable one falls back to the default plan. */
export function readExitPlan(raw: unknown): ExitPlan {
  const parsed = exitPlanSchema.safeParse(raw);
  return parsed.success ? parsed.data : EXIT_PLAN;
}

export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}
