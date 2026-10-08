import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { createLogger } from "../logger.js";
import { contestantSpec } from "../curation/contestants.js";
import type { ExitPlan } from "../curation/profitSim.js";
import {
  effectiveExitPlan,
  exitPlanJson,
  readExitPlan,
  readTradingBotConfig,
  solToLamports,
  type TradingBotConfig,
} from "./config.js";
import { decideExit, sellAmount, type ExitReason } from "./exitEngine.js";
import { WSOL_MINT, type SwapClient } from "./jupiterSwap.js";
import type { KeyProvider } from "./keyVault.js";
import type { TradingRpc } from "./rpc.js";
import { buildSolTransfer, signTransaction } from "./transaction.js";
import { withWalletKey, type TradingWalletRow } from "./wallets.js";

/**
 * The trading bot's engine: one pass, run every few seconds by the trader worker
 * (TRADING_BOT_INTERVAL_SECONDS). Each pass, in order:
 *
 *   1. settles every swap and withdrawal sent earlier (confirmed, failed, or expired unlanded);
 *   2. sends requested withdrawals - always to the user's sign-in wallet;
 *   3. walks every open position through its exit plan (exitEngine.ts) and sells what it says;
 *   4. buys new signals - matches of the filters and calls of the models a bot follows - for
 *      every enabled bot whose owner is an admin, within the bot's guards.
 *
 * Exits and withdrawals run for everyone with a position or a wallet, whatever the bot's switch
 * or the owner's admin status: switching the bot off (or losing admin) stops new entries, never
 * the management of money already in a trade.
 *
 * Every transaction is signed, recorded with its signature, and only then sent. The signature is
 * the transaction's id, so a crash anywhere after the record leaves a row the next pass settles
 * from the chain, and nothing is ever sent that the database doesn't know about. A position's
 * state only advances on a CONFIRMED fill, read back from the transaction itself; a sale that
 * fails is decided again next pass.
 *
 * Before anything a swap API built is sent, it is simulated against the wallet and refused if it
 * would take more SOL than the trade allows: the bot signs what Jupiter returns, and this is the
 * check that a bad or hostile response cannot drain the wallet.
 */

const logger = createLogger("trading");

/** A signal is read only once it is this old: rows commit a moment after their timestamp. */
export const SIGNAL_COMMIT_GRACE_MS = 5_000;
/** The base fee of a one-signature transaction. */
export const TX_FEE_LAMPORTS = 5_000n;
/** An account left with less than this (and more than zero) is not rent-exempt: the chain refuses it. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
/** Room on top of the trade a simulated swap may take: token-account rent (~0.002 SOL) and fees. */
const BUY_SIM_MARGIN_LAMPORTS = 5_000_000n;
const SELL_SIM_MARGIN_LAMPORTS = 3_000_000n;
/** Signals read per bot per pass. */
const MAX_SIGNALS_PER_PASS = 200;

type EngineRpc = Pick<
  TradingRpc,
  | "getBalance"
  | "getBlockHeight"
  | "getLatestBlockhash"
  | "simulate"
  | "send"
  | "getSignatureStatus"
  | "getTransactionFill"
  | "getTokenBalance"
>;

export interface TradingEngineDeps {
  rpc: EngineRpc;
  swap: SwapClient;
  keys: KeyProvider;
  /** Who may open new positions (the admin wallets). */
  canTrade: (walletAddress: string) => boolean;
  /** Server-wide ceiling on one entry, whatever a bot's config says (TRADING_MAX_BUY_SOL). */
  maxBuyLamports: bigint;
  now?: () => Date;
}

export interface TradingRunSummary {
  settled: number;
  withdrawals: number;
  exitsChecked: number;
  sells: number;
  bots: number;
  signals: number;
  buys: number;
  skipped: number;
  errors: number;
}

type Wallet = TradingWalletRow;

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** The advisory lock one pass holds; see runTradingEngine. */
export const TRADING_ENGINE_LOCK = "trading-engine";
/** Past the slowest pass we expect: a handful of quotes, signs, simulations and sends. */
const PASS_TRANSACTION_TIMEOUT_MS = 240_000;

/**
 * One pass, under a Postgres advisory lock. A deploy runs the old trader and the new one side by
 * side for a moment, and two passes at once would read the same signals and the same exit
 * decisions: two buys of one token, two sales of one rung. The lock is transaction-scoped, so it
 * is released however the pass ends (a crash included); a process that doesn't get it skips.
 */
export async function runTradingEngine(
  deps: TradingEngineDeps,
): Promise<TradingRunSummary & { locked: boolean }> {
  return prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${TRADING_ENGINE_LOCK})) AS locked`;
      if (!lock?.locked) return { ...emptySummary(), locked: false };
      return { ...(await tradingPass(deps)), locked: true };
    },
    { maxWait: 10_000, timeout: PASS_TRANSACTION_TIMEOUT_MS },
  );
}

function emptySummary(): TradingRunSummary {
  return {
    settled: 0,
    withdrawals: 0,
    exitsChecked: 0,
    sells: 0,
    bots: 0,
    signals: 0,
    buys: 0,
    skipped: 0,
    errors: 0,
  };
}

async function tradingPass(deps: TradingEngineDeps): Promise<TradingRunSummary> {
  const now = deps.now ?? (() => new Date());
  const summary = emptySummary();
  const wallets = new Map<string, Wallet>();
  const walletFor = async (userId: string) => {
    if (!wallets.has(userId)) {
      const w = await prisma.tradingWallet.findUnique({ where: { userId } });
      if (w) wallets.set(userId, w);
    }
    return wallets.get(userId) ?? null;
  };
  const ctx: PassContext = { deps, now, walletFor, summary };

  await guard(summary, "settle orders", () => settleOrders(ctx));
  await guard(summary, "settle withdrawals", () => settleWithdrawals(ctx));
  await guard(summary, "send withdrawals", () => sendWithdrawals(ctx));
  await guard(summary, "exits", () => manageExits(ctx));
  await guard(summary, "entries", () => openEntries(ctx));
  return summary;
}

interface PassContext {
  deps: TradingEngineDeps;
  now: () => Date;
  walletFor: (userId: string) => Promise<Wallet | null>;
  summary: TradingRunSummary;
}

async function guard(summary: TradingRunSummary, stage: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    summary.errors++;
    logger.error(`trading pass stage failed: ${stage}`, { error: errText(err) });
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────

/**
 * Signs a transaction, checks its simulated effect on the wallet's SOL, lets `record` persist the
 * signature, then sends it. Returns the signature, or throws without having sent anything.
 */
async function signCheckAndSend(
  ctx: PassContext,
  wallet: Wallet,
  unsigned: Uint8Array,
  maxSolDrop: bigint,
  record: (signature: string) => Promise<void>,
): Promise<string> {
  const { signed, signature } = await withWalletKey(wallet, ctx.deps.keys, (seed) =>
    signTransaction(unsigned, seed, wallet.publicKey),
  );
  const base64 = Buffer.from(signed).toString("base64");
  const before = await ctx.deps.rpc.getBalance(wallet.publicKey);
  if (before === null) throw new Error("could not read the wallet balance before sending");
  const sim = await ctx.deps.rpc.simulate(base64, wallet.publicKey);
  if (!sim) throw new Error("simulation unavailable; not sending blind");
  if (sim.error) throw new Error(`simulation failed: ${sim.error}`);
  if (sim.lamportsAfter === null) throw new Error("simulation did not report the wallet's balance");
  if (before - sim.lamportsAfter > maxSolDrop) {
    throw new Error(
      `refused: the transaction would take ${before - sim.lamportsAfter} lamports, more than the ${maxSolDrop} allowed`,
    );
  }
  await record(signature);
  try {
    await ctx.deps.rpc.send(base64);
  } catch (err) {
    throw new SendRejectedError(signature, errText(err));
  }
  return signature;
}

/** The RPC definitely refused a recorded transaction: it was never sent, so its row is failed now. */
export class SendRejectedError extends Error {
  constructor(
    readonly signature: string,
    reason: string,
  ) {
    super(`send refused: ${reason}`);
  }
}

// ── Settling ─────────────────────────────────────────────────────────────────────────────────

type OrderWithPosition = Prisma.TradingOrderGetPayload<{ include: { position: true } }>;

/**
 * An entry still "buying" with no order this long after it was created was never sent: the order
 * is recorded before sending, so the process died between the two. It is over.
 */
const ORPHAN_ENTRY_MS = 2 * 60_000;

async function settleOrders(ctx: PassContext): Promise<void> {
  const orphaned = await prisma.tradingPosition.updateMany({
    where: {
      status: "buying",
      orders: { none: {} },
      createdAt: { lt: new Date(ctx.now().getTime() - ORPHAN_ENTRY_MS) },
    },
    data: { status: "failed", error: "the entry was never sent", closedAt: ctx.now() },
  });
  ctx.summary.settled += orphaned.count;
  const pending = await prisma.tradingOrder.findMany({
    where: { status: "pending" },
    include: { position: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  if (pending.length === 0) return;
  const height = await ctx.deps.rpc.getBlockHeight();
  for (const order of pending) {
    try {
      await settleOrder(ctx, order, height);
    } catch (err) {
      ctx.summary.errors++;
      logger.warn("could not settle order", { orderId: order.id, error: errText(err) });
    }
  }
}

async function settleOrder(ctx: PassContext, order: OrderWithPosition, height: number | null) {
  const wallet = await ctx.walletFor(order.userId);
  if (!wallet) return;
  const status = await ctx.deps.rpc.getSignatureStatus(order.signature);
  if (status === null) return;
  const settledAt = ctx.now();
  if (!status.seen) {
    // Never landed. Only once its blockhash has expired is that final.
    if (height === null || BigInt(height) <= order.lastValidBlockHeight) return;
    await failOrder(order, "expired", "the transaction expired without landing", settledAt);
    ctx.summary.settled++;
    return;
  }
  if (!status.confirmed) return;
  if (status.error) {
    await failOrder(order, "failed", `failed on chain: ${status.error}`, settledAt);
    ctx.summary.settled++;
    return;
  }
  const fill = await ctx.deps.rpc.getTransactionFill(order.signature, wallet.publicKey, order.position.mint);
  if (!fill) return;
  if (fill.failed) {
    await failOrder(order, "failed", `failed on chain: ${fill.error ?? "unknown"}`, settledAt);
    ctx.summary.settled++;
    return;
  }
  const position = order.position;
  if (order.side === "buy") {
    let bought = fill.tokenDelta;
    let decimals = fill.decimals;
    if (bought <= 0n) {
      // The fill didn't show the token (an unusual account layout): ask the chain what is held.
      const held = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint);
      if (!held) return;
      bought = held.raw;
      decimals = held.decimals;
    }
    await prisma.$transaction([
      prisma.tradingOrder.update({
        where: { id: order.id },
        data: {
          status: "confirmed",
          settledAt,
          lamportsDelta: fill.lamportsDelta,
          tokenDelta: fill.tokenDelta.toString(),
        },
      }),
      prisma.tradingPosition.update({
        where: { id: position.id },
        data:
          bought > 0n
            ? {
                status: "open",
                entryLamports: -fill.lamportsDelta,
                tokensBought: bought.toString(),
                tokensHeld: bought.toString(),
                decimals,
                openedAt: settledAt,
                error: null,
              }
            : { status: "failed", error: "the buy confirmed but no tokens arrived", closedAt: settledAt },
      }),
    ]);
  } else {
    const sold = fill.tokenDelta < 0n ? -fill.tokenDelta : 0n;
    let held = BigInt(position.tokensHeld) - sold;
    if (held < 0n) held = 0n;
    const tookRung = order.reason === "take_profit" && order.rung !== null;
    const closed = held === 0n;
    await prisma.$transaction([
      prisma.tradingOrder.update({
        where: { id: order.id },
        data: {
          status: "confirmed",
          settledAt,
          lamportsDelta: fill.lamportsDelta,
          tokenDelta: fill.tokenDelta.toString(),
        },
      }),
      prisma.tradingPosition.update({
        where: { id: position.id },
        data: {
          tokensHeld: held.toString(),
          proceedsLamports: { increment: fill.lamportsDelta > 0n ? fill.lamportsDelta : 0n },
          ...(tookRung
            ? {
                rungsTaken: Math.max(position.rungsTaken, order.rung! + 1),
                // The trail arms at the sale, from the multiple it sold at.
                highMultiple: Math.max(position.highMultiple ?? 0, position.lastMultiple ?? 0) || null,
              }
            : {}),
          ...(closed ? { status: "closed", closedAt: settledAt, closeReason: order.reason } : {}),
          error: null,
        },
      }),
    ]);
  }
  ctx.summary.settled++;
}

async function failOrder(order: OrderWithPosition, status: "failed" | "expired", error: string, at: Date) {
  await prisma.$transaction([
    prisma.tradingOrder.update({ where: { id: order.id }, data: { status, error, settledAt: at } }),
    // A failed entry ends the position (one try per token); a failed sale leaves it open to retry.
    order.side === "buy"
      ? prisma.tradingPosition.update({
          where: { id: order.positionId },
          data: { status: "failed", error, closedAt: at },
        })
      : prisma.tradingPosition.update({ where: { id: order.positionId }, data: { error } }),
  ]);
}

// ── Withdrawals ──────────────────────────────────────────────────────────────────────────────

async function settleWithdrawals(ctx: PassContext): Promise<void> {
  const pending = await prisma.tradingWithdrawal.findMany({ where: { status: "pending" }, take: 50 });
  if (pending.length === 0) return;
  const height = await ctx.deps.rpc.getBlockHeight();
  for (const w of pending) {
    if (!w.signature) continue;
    const status = await ctx.deps.rpc.getSignatureStatus(w.signature);
    if (status === null) continue;
    if (!status.seen) {
      if (height === null || w.lastValidBlockHeight === null || BigInt(height) <= w.lastValidBlockHeight)
        continue;
      await prisma.tradingWithdrawal.update({
        where: { id: w.id },
        data: { status: "failed", error: "the transaction expired without landing", settledAt: ctx.now() },
      });
    } else if (status.confirmed) {
      await prisma.tradingWithdrawal.update({
        where: { id: w.id },
        data: status.error
          ? { status: "failed", error: `failed on chain: ${status.error}`, settledAt: ctx.now() }
          : { status: "confirmed", settledAt: ctx.now() },
      });
    } else continue;
    ctx.summary.settled++;
  }
}

/** How much a withdrawal sends from a balance, or why it can't. */
export function withdrawalAmount(
  balance: bigint,
  requested: bigint | null,
): { lamports: bigint } | { error: string } {
  const spendable = balance - TX_FEE_LAMPORTS;
  if (spendable <= 0n) return { error: "the wallet holds nothing to withdraw" };
  if (requested === null) return { lamports: spendable };
  if (requested <= 0n) return { error: "the amount must be positive" };
  if (requested > spendable) return { error: "the amount is more than the wallet holds (less the fee)" };
  const left = spendable - requested;
  if (left > 0n && left < RENT_EXEMPT_MIN_LAMPORTS) {
    return {
      error: "that would leave the wallet below the rent-exempt minimum; withdraw everything or less",
    };
  }
  return { lamports: requested };
}

async function sendWithdrawals(ctx: PassContext): Promise<void> {
  const requested = await prisma.tradingWithdrawal.findMany({
    where: { status: "requested" },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  for (const w of requested) {
    try {
      const wallet = await ctx.walletFor(w.userId);
      const user = await prisma.user.findUnique({ where: { id: w.userId }, select: { walletAddress: true } });
      // The destination is always the sign-in wallet, read again here rather than trusted.
      if (!wallet || !user || user.walletAddress !== w.destination) {
        await prisma.tradingWithdrawal.update({
          where: { id: w.id },
          data: {
            status: "failed",
            error: "destination is not the account's sign-in wallet",
            settledAt: ctx.now(),
          },
        });
        continue;
      }
      const balance = await ctx.deps.rpc.getBalance(wallet.publicKey);
      const blockhash = await ctx.deps.rpc.getLatestBlockhash();
      if (balance === null || !blockhash) continue; // try again next pass
      const amount = withdrawalAmount(balance, w.requestedLamports);
      if ("error" in amount) {
        await prisma.tradingWithdrawal.update({
          where: { id: w.id },
          data: { status: "failed", error: amount.error, settledAt: ctx.now() },
        });
        continue;
      }
      const unsigned = buildSolTransfer({
        from: wallet.publicKey,
        to: user.walletAddress,
        lamports: amount.lamports,
        recentBlockhash: blockhash.blockhash,
      });
      await signCheckAndSend(ctx, wallet, unsigned, amount.lamports + TX_FEE_LAMPORTS, async (signature) => {
        await prisma.tradingWithdrawal.update({
          where: { id: w.id },
          data: {
            status: "pending",
            signature,
            sentLamports: amount.lamports,
            lastValidBlockHeight: BigInt(blockhash.lastValidBlockHeight),
          },
        });
      });
      ctx.summary.withdrawals++;
      logger.info("withdrawal sent", { userId: w.userId, lamports: amount.lamports.toString() });
    } catch (err) {
      ctx.summary.errors++;
      // Not sent (signCheckAndSend throws before sending, or the RPC refused it): record why.
      await prisma.tradingWithdrawal
        .updateMany({
          where: { id: w.id, status: err instanceof SendRejectedError ? "pending" : "requested" },
          data: { status: "failed", error: errText(err), settledAt: ctx.now() },
        })
        .catch(() => undefined);
    }
  }
}

// ── Exits ────────────────────────────────────────────────────────────────────────────────────

type PositionRow = Prisma.TradingPositionGetPayload<object>;

/**
 * What the tokens still held are worth against what was paid for them: the exit plan's multiple.
 * Measured in SOL (the token's USD price over SOL's), so SOL's own moves don't read as the
 * token's. Null when there is no price.
 */
export function positionMultiple(
  position: Pick<PositionRow, "swapInLamports" | "tokensBought" | "decimals">,
  tokenUsd: number | undefined,
  solUsd: number | undefined,
): number | null {
  if (
    !tokenUsd ||
    !solUsd ||
    position.decimals === null ||
    !position.swapInLamports ||
    !position.tokensBought
  )
    return null;
  const bought = Number(position.tokensBought);
  if (!(bought > 0)) return null;
  const entryLamportsPerRaw = Number(position.swapInLamports) / bought;
  const nowLamportsPerRaw = ((tokenUsd / solUsd) * 1e9) / 10 ** position.decimals;
  return nowLamportsPerRaw / entryLamportsPerRaw;
}

async function manageExits(ctx: PassContext): Promise<void> {
  const open = await prisma.tradingPosition.findMany({
    where: { status: "open", orders: { none: { status: "pending" } } },
    orderBy: { openedAt: "asc" },
    take: 200,
  });
  if (open.length === 0) return;
  let prices = new Map<string, number>();
  try {
    prices = await ctx.deps.swap.pricesUsd([...open.map((p) => p.mint), WSOL_MINT]);
  } catch (err) {
    logger.warn("price lookup failed; falling back to quotes", { error: errText(err) });
  }
  const solUsd = prices.get(WSOL_MINT);
  for (const position of open) {
    ctx.summary.exitsChecked++;
    try {
      await manageExit(ctx, position, prices.get(position.mint), solUsd);
    } catch (err) {
      ctx.summary.errors++;
      await prisma.tradingPosition
        .update({ where: { id: position.id }, data: { error: errText(err) } })
        .catch(() => undefined);
      logger.warn("exit check failed", { positionId: position.id, error: errText(err) });
    }
  }
}

async function manageExit(ctx: PassContext, position: PositionRow, tokenUsd?: number, solUsd?: number) {
  const wallet = await ctx.walletFor(position.userId);
  if (!wallet || !position.openedAt) return;
  const bought = BigInt(position.tokensBought ?? "0");
  const held = BigInt(position.tokensHeld);
  if (held <= 0n) {
    await prisma.tradingPosition.update({
      where: { id: position.id },
      data: { status: "closed", closedAt: ctx.now(), closeReason: position.closeReason ?? "empty" },
    });
    return;
  }

  let multiple = positionMultiple(position, tokenUsd, solUsd);
  if (multiple === null && position.swapInLamports && bought > 0n) {
    // No reliable price (a token too new or thin for the Price API): what selling would fetch.
    const quote = await ctx.deps.swap.quote({
      inputMint: position.mint,
      outputMint: WSOL_MINT,
      amount: held,
      slippageBps: 5000,
    });
    const costOfHeld = (Number(position.swapInLamports) * Number(held)) / Number(bought);
    multiple = costOfHeld > 0 ? Number(quote.outAmount) / costOfHeld : null;
  }
  if (multiple === null) return;

  const plan = readExitPlan(position.exitPlan);
  const now = ctx.now();
  const decision = position.closeRequested
    ? {
        action: "sell" as const,
        fraction: 1,
        all: true,
        reason: "manual" as ExitReason,
        highMultiple: position.highMultiple,
      }
    : decideExit(
        { openedAt: position.openedAt, rungsTaken: position.rungsTaken, highMultiple: position.highMultiple },
        multiple,
        now,
        plan,
      );
  await prisma.tradingPosition.update({
    where: { id: position.id },
    data: { lastMultiple: multiple, lastPricedAt: now, highMultiple: decision.highMultiple },
  });
  if (decision.action === "hold") return;

  // A full exit sells what the chain says is held, not what the books say.
  let amount = sellAmount(decision, bought, held);
  if (decision.all) {
    const chain = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint);
    if (!chain) return;
    amount = chain.raw;
    if (amount === 0n) {
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: { status: "closed", tokensHeld: "0", closedAt: now, closeReason: decision.reason },
      });
      return;
    }
  }
  if (amount <= 0n) return;

  const bot = await prisma.tradingBot.findUnique({ where: { userId: position.userId } });
  const config = readTradingBotConfig(bot?.config);
  await swapAndRecord(ctx, wallet, config, {
    position,
    side: "sell",
    reason: decision.reason,
    rung: decision.reason === "take_profit" ? ((decision as { rung?: number }).rung ?? null) : null,
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
    // A stop or a trailing exit must get out: the slippage cap widens for anything but a take-profit.
    slippageBps: decision.reason === "take_profit" ? config.slippageBps : Math.max(config.slippageBps, 3000),
    maxSolDrop: solToLamports(config.maxPriorityFeeSol) + SELL_SIM_MARGIN_LAMPORTS,
  });
  ctx.summary.sells++;
  logger.info("exit sent", {
    positionId: position.id,
    mint: position.mint,
    reason: decision.reason,
    multiple: Number(multiple.toFixed(3)),
  });
}

async function swapAndRecord(
  ctx: PassContext,
  wallet: Wallet,
  config: TradingBotConfig,
  order: {
    position: Pick<PositionRow, "id" | "userId">;
    side: "buy" | "sell";
    reason: string;
    rung: number | null;
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    maxSolDrop: bigint;
  },
): Promise<string> {
  const quote = await ctx.deps.swap.quote({
    inputMint: order.inputMint,
    outputMint: order.outputMint,
    amount: order.amount,
    slippageBps: order.slippageBps,
  });
  const built = await ctx.deps.swap.swapTransaction({
    quote,
    userPublicKey: wallet.publicKey,
    maxPriorityFeeLamports: Number(solToLamports(config.maxPriorityFeeSol)),
  });
  try {
    return await signCheckAndSend(ctx, wallet, built.transaction, order.maxSolDrop, async (signature) => {
      await prisma.tradingOrder.create({
        data: {
          positionId: order.position.id,
          userId: order.position.userId,
          side: order.side,
          reason: order.reason,
          rung: order.rung,
          signature,
          lastValidBlockHeight: BigInt(built.lastValidBlockHeight),
          inAmount: order.amount.toString(),
          quotedOut: quote.outAmount,
        },
      });
    });
  } catch (err) {
    if (err instanceof SendRejectedError) {
      await prisma.tradingOrder.update({
        where: { signature: err.signature },
        data: { status: "failed", error: err.message, settledAt: ctx.now() },
      });
    }
    throw err;
  }
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

export interface TradeSignal {
  mint: string;
  symbol: string | null;
  at: Date;
  kind: "filter" | "model";
  ref: string;
  label: string;
}

/** The new signals a bot follows in (from, to]: its filters' matches and its models' calls, oldest first. */
export async function loadSignals(
  userId: string,
  config: TradingBotConfig,
  from: Date,
  to: Date,
): Promise<TradeSignal[]> {
  const { filterIds, models, highConvictionOnly } = config.sources;
  const [matches, calls] = await Promise.all([
    filterIds.length === 0
      ? []
      : prisma.match.findMany({
          where: { userId, filterId: { in: filterIds }, matchedAt: { gt: from, lte: to } },
          select: {
            matchedAt: true,
            filterId: true,
            filter: { select: { name: true } },
            token: { select: { mintAddress: true, symbol: true } },
          },
          orderBy: { matchedAt: "asc" },
          take: MAX_SIGNALS_PER_PASS,
        }),
    models.length === 0
      ? []
      : prisma.curatedAlert.findMany({
          where: {
            model: { in: models },
            createdAt: { gt: from, lte: to },
            ...(highConvictionOnly ? { tier: "high" } : {}),
          },
          select: {
            createdAt: true,
            model: true,
            modelName: true,
            token: { select: { mintAddress: true, symbol: true } },
          },
          orderBy: { createdAt: "asc" },
          take: MAX_SIGNALS_PER_PASS,
        }),
  ]);
  const signals: TradeSignal[] = [
    ...matches.map((m) => ({
      mint: m.token.mintAddress,
      symbol: m.token.symbol,
      at: m.matchedAt,
      kind: "filter" as const,
      ref: m.filterId,
      label: `Filter: ${m.filter.name}`,
    })),
    ...calls.map((c) => ({
      mint: c.token.mintAddress,
      symbol: c.token.symbol,
      at: c.createdAt,
      kind: "model" as const,
      ref: c.model ?? "",
      label: `Model: ${c.modelName ?? contestantSpec(c.model ?? "")?.name ?? c.model ?? "?"}`,
    })),
  ];
  signals.sort((a, b) => a.at.getTime() - b.at.getTime());
  // One entry per token: the first signal on it wins.
  const seen = new Set<string>();
  return signals.filter((s) => (seen.has(s.mint) ? false : (seen.add(s.mint), true)));
}

async function openEntries(ctx: PassContext): Promise<void> {
  const bots = await prisma.tradingBot.findMany({
    where: { enabled: true },
    include: { user: { select: { walletAddress: true } } },
  });
  for (const bot of bots) {
    if (!ctx.deps.canTrade(bot.user.walletAddress)) continue;
    const wallet = await ctx.walletFor(bot.userId);
    if (!wallet) continue;
    ctx.summary.bots++;
    try {
      await runBotEntries(ctx, bot, wallet);
      await prisma.tradingBot.update({
        where: { id: bot.id },
        data: { lastRunAt: ctx.now(), lastError: null },
      });
    } catch (err) {
      ctx.summary.errors++;
      await prisma.tradingBot
        .update({ where: { id: bot.id }, data: { lastRunAt: ctx.now(), lastError: errText(err) } })
        .catch(() => undefined);
      logger.warn("bot entries failed", { botId: bot.id, error: errText(err) });
    }
  }
}

async function runBotEntries(
  ctx: PassContext,
  bot: { id: string; userId: string; config: Prisma.JsonValue; signalsFrom: Date },
  wallet: Wallet,
) {
  const config = readTradingBotConfig(bot.config);
  const now = ctx.now();
  const horizon = new Date(now.getTime() - SIGNAL_COMMIT_GRACE_MS);
  if (horizon <= bot.signalsFrom) return;
  const signals = await loadSignals(bot.userId, config, bot.signalsFrom, horizon);
  // The window is consumed whatever happens to its signals: a skipped signal is never bought later.
  await prisma.tradingBot.update({ where: { id: bot.id }, data: { signalsFrom: horizon } });
  if (signals.length === 0) return;
  ctx.summary.signals += signals.length;

  let buyLamports = solToLamports(config.buySol);
  if (buyLamports > ctx.deps.maxBuyLamports) buyLamports = ctx.deps.maxBuyLamports;
  const plan: ExitPlan = effectiveExitPlan(config);

  for (const signal of signals) {
    const skip = await entryBlocker(ctx, bot.userId, wallet, config, signal, buyLamports, now);
    if (skip) {
      ctx.summary.skipped++;
      logger.info("signal skipped", { userId: bot.userId, mint: signal.mint, why: skip });
      continue;
    }
    let position: PositionRow;
    try {
      position = await prisma.tradingPosition.create({
        data: {
          userId: bot.userId,
          mint: signal.mint,
          symbol: signal.symbol,
          sourceKind: signal.kind,
          sourceRef: signal.ref,
          sourceLabel: signal.label,
          signalAt: signal.at,
          status: "buying",
          swapInLamports: buyLamports,
          exitPlan: exitPlanJson(plan) as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      // Already entered this token (the unique key): one entry per token, ever.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        ctx.summary.skipped++;
        continue;
      }
      throw err;
    }
    try {
      await swapAndRecord(ctx, wallet, config, {
        position,
        side: "buy",
        reason: "entry",
        rung: null,
        inputMint: WSOL_MINT,
        outputMint: signal.mint,
        amount: buyLamports,
        slippageBps: config.slippageBps,
        maxSolDrop: buyLamports + solToLamports(config.maxPriorityFeeSol) + BUY_SIM_MARGIN_LAMPORTS,
      });
      ctx.summary.buys++;
      logger.info("entry sent", { userId: bot.userId, mint: signal.mint, source: signal.label });
    } catch (err) {
      // Nothing was sent (signCheckAndSend throws before sending): the entry is over.
      await prisma.tradingPosition.update({
        where: { id: position.id },
        data: { status: "failed", error: errText(err), closedAt: ctx.now() },
      });
      ctx.summary.errors++;
    }
  }
}

/** Why a signal can't be bought right now, or null when it can. */
async function entryBlocker(
  ctx: PassContext,
  userId: string,
  wallet: Wallet,
  config: TradingBotConfig,
  signal: TradeSignal,
  buyLamports: bigint,
  now: Date,
): Promise<string | null> {
  if (now.getTime() - signal.at.getTime() > config.maxSignalAgeSeconds * 1000) return "signal too old";
  const [open, spent, existing] = await Promise.all([
    prisma.tradingPosition.count({ where: { userId, status: { in: ["buying", "open"] } } }),
    prisma.tradingPosition.aggregate({
      where: {
        userId,
        status: { not: "failed" },
        createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) },
      },
      _sum: { swapInLamports: true },
    }),
    prisma.tradingPosition.findUnique({
      where: { userId_mint: { userId, mint: signal.mint } },
      select: { id: true },
    }),
  ]);
  if (existing) return "already traded this token";
  if (open >= config.maxOpenPositions) return "at the open-position limit";
  if ((spent._sum.swapInLamports ?? 0n) + buyLamports > solToLamports(config.maxDailySpendSol))
    return "at the 24h spend limit";
  const balance = await ctx.deps.rpc.getBalance(wallet.publicKey);
  if (balance === null) return "balance unavailable";
  if (balance < buyLamports + solToLamports(config.reserveSol) + solToLamports(config.maxPriorityFeeSol))
    return "not enough SOL above the reserve";
  return null;
}
