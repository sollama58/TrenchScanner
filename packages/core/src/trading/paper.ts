import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import type { ExitPlan } from "../curation/profitSim.js";
import {
  effectiveExitPlan,
  exitPlanJson,
  readExitPlan,
  solToLamports,
  tradingBotConfigSchema,
  type TradingBotConfig,
} from "./config.js";
import {
  gateOnAiVerdicts,
  loadSignals,
  lossWindowStart,
  netLoss,
  mintRisk,
  positionMultiple,
  signalHorizon,
  TX_FEE_LAMPORTS,
  type TradeSignal,
} from "./engine.js";
import { decideExit, sellAmount, type ExitReason } from "./exitEngine.js";
import { NoRouteError, RateLimitedError, WSOL_MINT, type SwapClient } from "./jupiterSwap.js";
import type { MintInfo } from "./rpc.js";
import { escapeHtml } from "../telegram/format.js";
import { EXIT_REASON_TEXT, signedSol, solAmount, tokenLink, type TradeNote } from "./tradeNotes.js";
import { saleEvent, type TradeAlertEvent } from "./tradeAlerts.js";

/**
 * Paper trading (admin-only): the trading bot's settings run against the same live signals - the
 * filters' matches and the models' calls, through the same AI gate - and filled at live Jupiter
 * quotes, with simulated SOL. Nothing here holds a key, builds a transaction or sends one, so it
 * runs whether or not the real bot is switched on (TRADING_BOT_ENABLED).
 *
 * What the simulation does the way the bot would:
 *   - a signal is bought only while fresh, once per token per strategy, under the strategy's
 *     open-position, 24-hour spend and reserve limits, and never into a mint the bot refuses
 *     (mint or freeze authority, risky Token-2022 extensions: mintRisk);
 *   - the entry and every sale are priced by a Jupiter quote at that moment, so price impact and
 *     "no route" are real, and each swap is charged the network fee plus the Jito tip (or, with no
 *     tip, the most priority fee the settings allow);
 *   - exits follow the exit plan the position opened under (decideExit), priced each pass.
 * What it can't know: whether a real swap would have landed at the quote. `fillPenaltyBps` takes
 * that much off every fill (1% by default), for latency and slippage.
 */

const logger = createLogger("paper-trading");

/** How many of an admin's strategies may buy at once (user decision 2026-10-16). */
export const MAX_RUNNING_PAPER_STRATEGIES = 3;
/** How many an admin may keep, running or not. */
export const MAX_PAPER_STRATEGIES = 10;
export const DEFAULT_PAPER_BANKROLL_SOL = 10;
/** Skips kept on a strategy for the admin to read. */
const RECENT_SKIPS = 30;
/** A sale with no route is tried again each pass; noted on the position meanwhile. */
const MAX_POSITIONS_PER_PASS = 300;
const PAPER_PASS_BUDGET_MS = 60_000;

export const paperStrategyConfigSchema = tradingBotConfigSchema.extend({
  /** Taken off every simulated fill (bps of the quote), for what a real swap loses to latency and slippage. */
  fillPenaltyBps: z.number().int().min(0).max(10_000).default(100),
});
export type PaperStrategyConfig = z.infer<typeof paperStrategyConfigSchema>;
export const DEFAULT_PAPER_CONFIG: PaperStrategyConfig = paperStrategyConfigSchema.parse({});

/** A stored strategy's settings; anything unreadable falls back to the defaults (which follow nothing). */
export function readPaperConfig(raw: unknown): PaperStrategyConfig {
  const parsed = paperStrategyConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_PAPER_CONFIG;
}

/** What one simulated swap is charged: the network fee and the tip, or the priority fee with no tip. */
export function paperSwapFee(config: Pick<TradingBotConfig, "jitoTipSol" | "maxPriorityFeeSol">): bigint {
  return (
    TX_FEE_LAMPORTS + solToLamports(config.jitoTipSol > 0 ? config.jitoTipSol : config.maxPriorityFeeSol)
  );
}

/** A quote's output less the fill penalty. */
export function penalizedFill(outAmount: bigint, fillPenaltyBps: number): bigint {
  const keep = BigInt(10_000 - Math.min(10_000, Math.max(0, Math.round(fillPenaltyBps))));
  return (outAmount * keep) / 10_000n;
}

export interface PaperSkip {
  at: string;
  mint: string;
  symbol: string | null;
  source: string;
  why: string;
}

export interface PaperTradingDeps {
  swap: Pick<SwapClient, "quote" | "pricesUsd">;
  rpc: { getMintInfo(mint: string): Promise<MintInfo | null> };
  /** Whether a wallet is an admin's: a strategy whose owner no longer is stops buying. */
  canTrade: (walletAddress: string) => boolean;
  now?: () => Date;
  /** How far signals may be read (signalHorizon by default). */
  horizon?: (now: Date) => Promise<Date>;
  /** Delivers a pass's Telegram notes (tradeNotes.ts) at its end; omitted sends none. */
  notify?: (notes: TradeNote[]) => Promise<void>;
}

export interface PaperRunSummary {
  strategies: number;
  signals: number;
  entries: number;
  skipped: number;
  exitsChecked: number;
  sells: number;
  errors: number;
}

/** A pass's cash change found the strategy reset under it: the change is dropped with the rest. */
class ResetUnderUs extends Error {}
/** The position changed under this pass (another process sold it first): nothing to book here. */
class SoldUnderUs extends Error {}

/** One pass: exits for every open paper position, then entries for every running strategy. */
export async function runPaperTrading(deps: PaperTradingDeps): Promise<PaperRunSummary> {
  const summary: PaperRunSummary = {
    strategies: 0,
    signals: 0,
    entries: 0,
    skipped: 0,
    exitsChecked: 0,
    sells: 0,
    errors: 0,
  };
  const started = Date.now();
  const inBudget = () => Date.now() - started < PAPER_PASS_BUDGET_MS;
  const now = () => deps.now?.() ?? new Date();
  const notes: TradeNote[] = [];
  await managePaperExits(deps, summary, now, inBudget, notes);
  await openPaperEntries(deps, summary, now, inBudget, notes);
  if (deps.notify && notes.length > 0) {
    await deps.notify(notes).catch((err) => logger.warn("trade notes failed", { error: errText(err) }));
  }
  return summary;
}

/** A note for the strategy's owner, when its settings want them. */
function paperNote(
  notes: TradeNote[],
  strategy: { userId: string; name: string },
  config: PaperStrategyConfig,
  event: TradeAlertEvent,
  html: string,
) {
  if (config.notifyTelegram)
    notes.push({
      userId: strategy.userId,
      html: `📝 <b>Paper · ${escapeHtml(strategy.name)}</b>: ${html}`,
      source: "paper",
      event,
    });
}

// ── Exits ────────────────────────────────────────────────────────────────────────────────────

type PaperPositionRow = Prisma.PaperPositionGetPayload<{
  include: { strategy: { select: { id: true; resetAt: true; config: true; userId: true; name: true } } };
}>;

async function managePaperExits(
  deps: PaperTradingDeps,
  summary: PaperRunSummary,
  now: () => Date,
  inBudget: () => boolean,
  notes: TradeNote[],
) {
  const open = await prisma.paperPosition.findMany({
    where: { status: "open" },
    include: { strategy: { select: { id: true, resetAt: true, config: true, userId: true, name: true } } },
    orderBy: { openedAt: "asc" },
    take: MAX_POSITIONS_PER_PASS,
  });
  if (open.length === 0) return;
  let prices = new Map<string, number>();
  try {
    prices = await deps.swap.pricesUsd([...new Set(open.map((p) => p.mint)), WSOL_MINT]);
  } catch (err) {
    logger.warn("price lookup failed; pricing by quotes", { error: String(err) });
  }
  const solUsd = prices.get(WSOL_MINT);
  for (const position of open) {
    if (!inBudget()) return;
    summary.exitsChecked++;
    try {
      if (await managePaperExit(deps, position, prices.get(position.mint), solUsd, now(), notes))
        summary.sells++;
    } catch (err) {
      if (err instanceof SoldUnderUs) continue;
      summary.errors++;
      if (err instanceof ResetUnderUs) continue;
      await prisma.paperPosition
        .update({ where: { id: position.id }, data: { error: errText(err) } })
        .catch(() => undefined);
      if (err instanceof RateLimitedError) return;
    }
  }
}

function holdCapMinutes(position: Pick<PaperPositionRow, "rungsTaken">, plan: ExitPlan): number {
  return position.rungsTaken > 0 && plan.trail.length > 0 ? plan.trailMaxHoldMinutes : plan.maxHoldMinutes;
}

/** Walks one position through its exit plan; true when it sold. */
async function managePaperExit(
  deps: PaperTradingDeps,
  position: PaperPositionRow,
  tokenUsd: number | undefined,
  solUsd: number | undefined,
  now: Date,
  notes: TradeNote[],
): Promise<boolean> {
  const config = readPaperConfig(position.strategy.config);
  const plan = readExitPlan(position.exitPlan);
  const bought = BigInt(position.tokensBought);
  const held = BigInt(position.tokensHeld);
  if (held <= 0n) {
    await prisma.paperPosition.update({
      where: { id: position.id },
      data: { status: "closed", closedAt: now, closeReason: position.closeReason ?? "empty" },
    });
    return false;
  }

  let decision: { all: boolean; fraction: number; reason: ExitReason; rung?: number };
  let multiple: number | null = null;
  if (position.closeRequested) {
    decision = { all: true, fraction: 1, reason: "manual" };
  } else {
    multiple = positionMultiple(position, tokenUsd, solUsd);
    if (multiple === null) multiple = await quotedMultiple(deps, position, held, bought);
    if (multiple === null) {
      const ageMinutes = (now.getTime() - position.openedAt.getTime()) / 60_000;
      if (ageMinutes < holdCapMinutes(position, plan)) {
        await prisma.paperPosition.update({
          where: { id: position.id },
          data: { error: "no price for the token right now" },
        });
        return false;
      }
      decision = { all: true, fraction: 1, reason: position.rungsTaken > 0 ? "trail_max_hold" : "max_hold" };
    } else {
      const d = decideExit(
        { openedAt: position.openedAt, rungsTaken: position.rungsTaken, highMultiple: position.highMultiple },
        multiple,
        now,
        plan,
      );
      await prisma.paperPosition.update({
        where: { id: position.id },
        data: {
          lastMultiple: multiple,
          lastPricedAt: now,
          highMultiple: d.highMultiple,
          peakMultiple: Math.max(position.peakMultiple ?? multiple, multiple),
          error: null,
        },
      });
      if (d.action === "hold") return false;
      decision = { all: d.all, fraction: d.fraction, reason: d.reason, rung: d.rung };
    }
  }

  const amount = sellAmount(decision, bought, held);
  if (amount <= 0n) return false;
  const slippageBps =
    decision.reason === "take_profit"
      ? config.slippageBps
      : Math.max(config.slippageBps, config.exitSlippageBps);
  let out: bigint;
  try {
    const quote = await deps.swap.quote({
      inputMint: position.mint,
      outputMint: WSOL_MINT,
      amount,
      slippageBps,
    });
    out = penalizedFill(BigInt(quote.outAmount), config.fillPenaltyBps);
  } catch (err) {
    if (err instanceof NoRouteError) {
      // As a real sale would: no route, nothing sold. Tried again next pass.
      await prisma.paperPosition.update({
        where: { id: position.id },
        data: { error: `no route to sell (${decision.reason})` },
      });
      return false;
    }
    throw err;
  }
  const fee = paperSwapFee(config);
  const net = out > fee ? out - fee : 0n;
  const left = held - amount;
  await prisma.$transaction(async (tx) => {
    // A claim on the holding as this pass read it. A deploy runs the old scanner and the new one
    // side by side, and nothing else stops both passes reading the same position as due; without
    // the claim both booked the sale, and the strategy's cash and the position's proceeds were
    // credited twice. The sale's fee is inside `net`; feesLamports keeps the entry's fee only.
    const claimed = await tx.paperPosition.updateMany({
      where: { id: position.id, status: "open", tokensHeld: position.tokensHeld },
      data: {
        tokensHeld: left.toString(),
        proceedsLamports: { increment: net },
        ...(decision.reason === "take_profit" ? { rungsTaken: { increment: 1 } } : {}),
        // The trail rides from the price it sold at, as the bot's settled sale does.
        highMultiple: Math.max(position.highMultiple ?? 0, multiple ?? 0) || null,
        ...(left <= 0n ? { status: "closed", closedAt: now, closeReason: decision.reason } : {}),
        error: null,
      },
    });
    if (claimed.count !== 1) throw new SoldUnderUs("position sold by another pass");
    await tx.paperFill.create({
      data: {
        positionId: position.id,
        side: "sell",
        reason: decision.reason,
        rung: decision.reason === "take_profit" ? (decision.rung ?? null) : null,
        lamports: out,
        feeLamports: fee,
        tokens: amount.toString(),
        multiple,
      },
    });
    const credited = await tx.paperStrategy.updateMany({
      where: { id: position.strategy.id, resetAt: position.strategy.resetAt },
      data: { cashLamports: { increment: net } },
    });
    if (credited.count === 0) throw new ResetUnderUs("strategy reset during the pass");
  });
  // Each fee once: `net` is this sale's SOL after its fee, feesLamports the entry's fee.
  const result =
    left <= 0n
      ? `; closed ${signedSol(position.proceedsLamports + net - position.swapInLamports - position.feesLamports)}`
      : "";
  paperNote(
    notes,
    position.strategy,
    config,
    saleEvent(decision.reason),
    `sold ${tokenLink(position.symbol, position.mint)} (${EXIT_REASON_TEXT[decision.reason] ?? escapeHtml(decision.reason)}), ${solAmount(net)} back${result}`,
  );
  return true;
}

/** The multiple from a sell quote for what is held, when the price sources have no price. */
async function quotedMultiple(
  deps: PaperTradingDeps,
  position: PaperPositionRow,
  held: bigint,
  bought: bigint,
): Promise<number | null> {
  if (bought <= 0n) return null;
  try {
    const quote = await deps.swap.quote({
      inputMint: position.mint,
      outputMint: WSOL_MINT,
      amount: held,
      slippageBps: 5000,
    });
    const costOfHeld = (Number(position.swapInLamports) * Number(held)) / Number(bought);
    return costOfHeld > 0 ? Number(quote.outAmount) / costOfHeld : null;
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    return null;
  }
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

async function openPaperEntries(
  deps: PaperTradingDeps,
  summary: PaperRunSummary,
  now: () => Date,
  inBudget: () => boolean,
  notes: TradeNote[],
) {
  const strategies = await prisma.paperStrategy.findMany({
    where: { running: true },
    include: { user: { select: { walletAddress: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (strategies.length === 0) return;
  const horizon = await (deps.horizon ?? signalHorizon)(now());
  // Shared by the strategies in this pass: one mint read and one entry quote per token and size.
  const mints = new Map<string, Promise<MintInfo | null>>();
  const quotes = new Map<string, Promise<bigint>>();
  for (const strategy of strategies) {
    if (!inBudget()) return;
    if (!deps.canTrade(strategy.user.walletAddress)) {
      await prisma.paperStrategy.update({
        where: { id: strategy.id },
        data: { running: false, lastError: "stopped: its owner is no longer an admin" },
      });
      continue;
    }
    summary.strategies++;
    try {
      if (await pausedForLoss(strategy, now(), notes)) continue;
      await runStrategyEntries(deps, summary, strategy, horizon, now(), { mints, quotes }, notes);
      await prisma.paperStrategy.update({
        where: { id: strategy.id },
        data: { lastRunAt: now(), lastError: null },
      });
    } catch (err) {
      summary.errors++;
      await prisma.paperStrategy
        .update({ where: { id: strategy.id }, data: { lastRunAt: now(), lastError: errText(err) } })
        .catch(() => undefined);
      logger.warn("paper strategy entries failed", { strategyId: strategy.id, error: errText(err) });
    }
  }
}

type StrategyRow = Prisma.PaperStrategyGetPayload<object>;

/** The daily loss limit, as the bot applies it (engine.ts pausedForLoss): stops the strategy. */
async function pausedForLoss(strategy: StrategyRow, now: Date, notes: TradeNote[]): Promise<boolean> {
  const config = readPaperConfig(strategy.config);
  if (!(config.dailyLossLimitSol > 0)) return false;
  const closed = await prisma.paperPosition.findMany({
    where: {
      strategyId: strategy.id,
      status: "closed",
      closedAt: { gt: lossWindowStart(now, strategy.lossWindowFrom) },
    },
    select: { swapInLamports: true, feesLamports: true, proceedsLamports: true },
  });
  const lost = netLoss(
    closed.map((p) => ({ paid: p.swapInLamports + p.feesLamports, back: p.proceedsLamports })),
  );
  if (lost < solToLamports(config.dailyLossLimitSol)) return false;
  const why = `stopped: lost ${solAmount(lost)} in the last 24 hours (limit ${config.dailyLossLimitSol} SOL)`;
  await prisma.paperStrategy.update({ where: { id: strategy.id }, data: { running: false, lastError: why } });
  paperNote(
    notes,
    strategy,
    config,
    "loss_limit",
    `⏸ ${escapeHtml(why)}. Open positions keep their exit plans.`,
  );
  return true;
}

async function runStrategyEntries(
  deps: PaperTradingDeps,
  summary: PaperRunSummary,
  strategy: StrategyRow,
  horizon: Date,
  now: Date,
  shared: { mints: Map<string, Promise<MintInfo | null>>; quotes: Map<string, Promise<bigint>> },
  notes: TradeNote[],
) {
  if (horizon <= strategy.signalsFrom) return;
  const config = readPaperConfig(strategy.config);
  const loaded = await loadSignals(
    strategy.userId,
    config,
    strategy.signalsFrom,
    horizon,
    strategy.configSavedAt,
  );
  const { outcomes, through } = await gateOnAiVerdicts(
    strategy.id,
    loaded.signals,
    loaded.through,
    config,
    now,
  );
  // Consumed whatever happens to its signals; never moved back over a start or save made meanwhile.
  await prisma.paperStrategy.updateMany({
    where: { id: strategy.id, signalsFrom: { lt: through } },
    data: { signalsFrom: through },
  });
  if (outcomes.length === 0) return;
  summary.signals += outcomes.length;

  const skips: PaperSkip[] = [];
  const skip = (signal: TradeSignal, why: string) => {
    summary.skipped++;
    skips.push({
      at: now.toISOString(),
      mint: signal.mint,
      symbol: signal.symbol,
      source: signal.label,
      why,
    });
  };
  const buyLamports = solToLamports(config.buySol);
  const fee = paperSwapFee(config);
  const reserve = solToLamports(config.reserveSol);
  const plan: ExitPlan = effectiveExitPlan(config);
  let cash = strategy.cashLamports;

  for (const outcome of outcomes) {
    const { signal } = outcome;
    if (outcome.verdict === "skip") {
      skip(signal, outcome.why);
      continue;
    }
    if (now.getTime() - signal.at.getTime() > config.maxSignalAgeSeconds * 1000) {
      skip(signal, "signal too old");
      continue;
    }
    const [open, spent, existing] = await Promise.all([
      prisma.paperPosition.count({ where: { strategyId: strategy.id, status: "open" } }),
      prisma.paperPosition.aggregate({
        where: { strategyId: strategy.id, createdAt: { gt: new Date(now.getTime() - 24 * 3_600_000) } },
        _sum: { swapInLamports: true },
      }),
      prisma.paperPosition.findUnique({
        where: { strategyId_mint: { strategyId: strategy.id, mint: signal.mint } },
        select: { id: true },
      }),
    ]);
    if (existing) {
      skip(signal, "already traded this token");
      continue;
    }
    if (open >= config.maxOpenPositions) {
      skip(signal, "at the open-position limit");
      continue;
    }
    if ((spent._sum.swapInLamports ?? 0n) + buyLamports > solToLamports(config.maxDailySpendSol)) {
      skip(signal, "at the 24h spend limit");
      continue;
    }
    if (cash - buyLamports - fee < reserve) {
      skip(signal, "not enough paper SOL above the reserve");
      continue;
    }
    let mintInfo = shared.mints.get(signal.mint);
    if (!mintInfo) {
      mintInfo = deps.rpc.getMintInfo(signal.mint).catch(() => null);
      shared.mints.set(signal.mint, mintInfo);
    }
    const mint = await mintInfo;
    if (!mint || mint.decimals === undefined) {
      skip(signal, "mint unreadable");
      continue;
    }
    const risk = mintRisk(mint);
    if (risk) {
      skip(signal, risk);
      continue;
    }
    const quoteKey = `${signal.mint}:${buyLamports}:${config.slippageBps}`;
    let quoted = shared.quotes.get(quoteKey);
    if (!quoted) {
      quoted = deps.swap
        .quote({
          inputMint: WSOL_MINT,
          outputMint: signal.mint,
          amount: buyLamports,
          slippageBps: config.slippageBps,
        })
        .then((q) => BigInt(q.outAmount));
      shared.quotes.set(quoteKey, quoted);
    }
    let tokens: bigint;
    try {
      tokens = penalizedFill(await quoted, config.fillPenaltyBps);
    } catch (err) {
      skip(signal, err instanceof NoRouteError ? "no route to buy" : `quote failed: ${errText(err)}`);
      continue;
    }
    if (tokens <= 0n) {
      skip(signal, "the quote buys nothing");
      continue;
    }
    try {
      await prisma.$transaction(async (tx) => {
        const position = await tx.paperPosition.create({
          data: {
            strategyId: strategy.id,
            mint: signal.mint,
            symbol: signal.symbol,
            sourceKind: signal.kind,
            sourceRef: signal.ref,
            sourceLabel: signal.label,
            signalAt: signal.at,
            status: "open",
            swapInLamports: buyLamports,
            feesLamports: fee,
            tokensBought: tokens.toString(),
            tokensHeld: tokens.toString(),
            decimals: mint.decimals!,
            exitPlan: exitPlanJson(plan) as unknown as Prisma.InputJsonValue,
            lastMultiple: 1,
            peakMultiple: 1,
            openedAt: now,
          },
        });
        await tx.paperFill.create({
          data: {
            positionId: position.id,
            side: "buy",
            reason: "entry",
            lamports: buyLamports,
            feeLamports: fee,
            tokens: tokens.toString(),
            multiple: 1,
          },
        });
        const debited = await tx.paperStrategy.updateMany({
          where: { id: strategy.id, resetAt: strategy.resetAt },
          data: { cashLamports: { decrement: buyLamports + fee } },
        });
        if (debited.count === 0) throw new ResetUnderUs("strategy reset during the pass");
      });
    } catch (err) {
      if (err instanceof ResetUnderUs) return;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        skip(signal, "already traded this token");
        continue;
      }
      throw err;
    }
    cash -= buyLamports + fee;
    summary.entries++;
    logger.info("paper entry", { strategyId: strategy.id, mint: signal.mint, source: signal.label });
    paperNote(
      notes,
      strategy,
      config,
      "buy",
      `bought ${tokenLink(signal.symbol, signal.mint)} for ${solAmount(buyLamports)} (${escapeHtml(signal.label)})`,
    );
  }

  if (skips.length > 0) await recordSkips(strategy.id, skips);
}

async function recordSkips(strategyId: string, skips: PaperSkip[]) {
  const row = await prisma.paperStrategy.findUnique({
    where: { id: strategyId },
    select: { recentSkips: true },
  });
  const before = Array.isArray(row?.recentSkips) ? (row.recentSkips as unknown as PaperSkip[]) : [];
  const next = [...skips.reverse(), ...before].slice(0, RECENT_SKIPS);
  await prisma.paperStrategy.update({
    where: { id: strategyId },
    data: { recentSkips: next as unknown as Prisma.InputJsonValue },
  });
}

// ── Results ──────────────────────────────────────────────────────────────────────────────────

export interface PaperStats {
  /** Cash plus what open positions are worth at their last multiple. */
  equityLamports: bigint;
  openValueLamports: bigint;
  pnlLamports: bigint;
  pnlPct: number;
  entries: number;
  open: number;
  closed: number;
  /** Closed positions that returned more than they cost, fees included. */
  wins: number;
  winRate: number | null;
  /**
   * Entries whose signal won the project's 2x verdict: hit2xIn1h and not disqualified, as every
   * other hit rate grades it (curation/labels.ts). Out of the graded entries only: a signal whose
   * win window is still open counts in neither.
   */
  hit2x: number;
  graded: number;
  hit2xRate: number | null;
}

export function paperStats(
  strategy: { bankrollLamports: bigint; cashLamports: bigint },
  positions: {
    status: string;
    swapInLamports: bigint;
    feesLamports: bigint;
    proceedsLamports: bigint;
    tokensBought: string;
    tokensHeld: string;
    lastMultiple: number | null;
    /** The signal's 2x verdict (paperSignalVerdicts); null while it is ungraded. */
    hit2x: boolean | null;
  }[],
): PaperStats {
  let openValue = 0n;
  let open = 0;
  let closed = 0;
  let wins = 0;
  let hit2x = 0;
  let graded = 0;
  for (const p of positions) {
    if (p.hit2x !== null) {
      graded++;
      if (p.hit2x) hit2x++;
    }
    if (p.status === "open") {
      open++;
      const bought = Number(p.tokensBought);
      const costOfHeld = bought > 0 ? (Number(p.swapInLamports) * Number(p.tokensHeld)) / bought : 0;
      openValue += BigInt(Math.floor(costOfHeld * (p.lastMultiple ?? 1)));
    } else {
      closed++;
      if (p.proceedsLamports > p.swapInLamports + p.feesLamports) wins++;
    }
  }
  const equity = strategy.cashLamports + openValue;
  const pnl = equity - strategy.bankrollLamports;
  return {
    equityLamports: equity,
    openValueLamports: openValue,
    pnlLamports: pnl,
    pnlPct: strategy.bankrollLamports > 0n ? (Number(pnl) / Number(strategy.bankrollLamports)) * 100 : 0,
    entries: positions.length,
    open,
    closed,
    wins,
    winRate: closed > 0 ? wins / closed : null,
    hit2x,
    graded,
    hit2xRate: graded > 0 ? hit2x / graded : null,
  };
}

/**
 * Each position's signal verdict, by position id: the 2x verdict graded on the alert it followed
 * (the filter's Match or the model's CuratedAlert, by source, coin and signal time), as
 * `"hit2xIn1h" AND NOT COALESCE("disqualified", false)`. Null while the alert is ungraded or gone.
 */
export async function paperSignalVerdicts(
  positionIds: readonly string[],
): Promise<Map<string, boolean | null>> {
  if (positionIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ id: string; hit2x: boolean | null }[]>`
    SELECT p."id",
           CASE WHEN v."hit2xIn1h" IS NULL THEN NULL
                ELSE v."hit2xIn1h" AND NOT COALESCE(v."disqualified", false) END AS hit2x
    FROM "PaperPosition" p
    JOIN "Token" t ON t."mintAddress" = p."mint"
    LEFT JOIN LATERAL (
      SELECT m."hit2xIn1h", m."disqualified" FROM "Match" m
      WHERE p."sourceKind" = 'filter' AND m."tokenId" = t."id"
        AND m."filterId" = p."sourceRef" AND m."matchedAt" = p."signalAt"
      UNION ALL
      SELECT a."hit2xIn1h", a."disqualified" FROM "CuratedAlert" a
      WHERE p."sourceKind" = 'model' AND a."tokenId" = t."id"
        AND a."model" = p."sourceRef" AND a."createdAt" = p."signalAt"
      LIMIT 1
    ) v ON true
    WHERE p."id" = ANY(${[...positionIds]})
  `;
  return new Map(rows.map((r) => [r.id, r.hit2x]));
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
