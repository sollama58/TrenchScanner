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
import { NoRouteError, WSOL_MINT, type FallbackSwapClient, type SwapClient } from "./jupiterSwap.js";
import type { KeyProvider } from "./keyVault.js";
import type { TradingRpc, TransactionFill } from "./rpc.js";
import { buildCloseTokenAccount, buildSolTransfer, signTransaction } from "./transaction.js";
import { GuardRefusal, guardSwapTransaction, type GuardRpc, type TradeExpectation } from "./txGuard.js";
import { withWalletKey, type TradingWalletRow } from "./wallets.js";

/**
 * The trading bot's engine: one pass, run every few seconds by the trader worker
 * (TRADING_BOT_INTERVAL_SECONDS), under an advisory lock so only one pass runs anywhere. Each pass:
 *
 *   1. settles every swap and withdrawal sent earlier - confirmed, failed on chain, or expired
 *      unlanded - and rebroadcasts the ones still in flight;
 *   2. sends requested withdrawals - only ever to the address sealed into the wallet's key;
 *   3. walks every open position through its exit plan (exitEngine.ts) and sells what it says;
 *   4. buys new signals - matches of the filters and calls of the models a bot follows - for
 *      every enabled bot whose owner is an admin, within the bot's and the server's limits;
 *   5. closes the emptied token accounts of sold-out positions, returning their rent.
 *
 * Exits and withdrawals run for everyone with a position or a wallet, whatever the bot's switch
 * or the owner's admin status: switching the bot off (or losing admin) stops new entries, never
 * the management of money already in a trade.
 *
 * Sending, always in this order: build (Jupiter, else PumpPortal for a Pump.fun token Jupiter
 * can't route), check the UNSIGNED transaction with the guard (txGuard.ts: allowed instructions
 * only, and a simulation showing nothing but the trade itself changes), sign, record the order
 * with its signature and the signed bytes, then send. Nothing is signed before it has passed the
 * guard, and nothing is sent that the database doesn't know about.
 *
 * Settling never trusts one reading: a row moves only from the state it was read in (a claim),
 * a transaction is written off only once its blockhash is safely past expiry, a buy written off
 * is checked against the wallet's real balance first (and recovered if its tokens arrived), and
 * a position's holdings after a sale are read back from the chain.
 */

const logger = createLogger("trading");

/** A signal is read only once it is this old: rows commit a moment after their timestamp. */
export const SIGNAL_COMMIT_GRACE_MS = 5_000;
/** ...and never later than this behind: a long transaction elsewhere must not hold entries back. */
const MAX_COMMIT_WAIT_MS = 20_000;
/** The base fee of a one-signature transaction. */
export const TX_FEE_LAMPORTS = 5_000n;
/** An account left with less than this (and more than zero) is not rent-exempt: the chain refuses it. */
export const RENT_EXEMPT_MIN_LAMPORTS = 890_880n;
/** Room on top of a buy the guard allows: token-account rent (~0.002 SOL) and fees. */
const BUY_MARGIN_LAMPORTS = 5_000_000n;
/** Room under a sale's quoted minimum: the base and priority fees. */
const SELL_FEE_ALLOWANCE_LAMPORTS = 100_000n;
/** A blockhash lives 150 blocks; our own bound adds that to the height when we signed. */
const BLOCKHASH_LIFETIME_BLOCKS = 150;
/** Past the bound, this many more blocks before a transaction is written off (RPC nodes lag). */
const EXPIRY_MARGIN_BLOCKS = 32n;
/** A confirmed transaction whose details the RPC still can't serve after this is settled from balances. */
const FILL_READ_GRACE_MS = 120_000;
/** An entry still "buying" with no order this long after creation was never sent. */
const ORPHAN_ENTRY_MS = 2 * 60_000;
/** A withdrawal claimed this long ago with no signature recorded was never sent. */
const ORPHAN_WITHDRAWAL_MS = 5 * 60_000;
/** Exits allow at least this slippage (30%): a stop must get out, not wait for a better fill. */
const EXIT_SLIPPAGE_FLOOR_BPS = 3_000;
/** Failed take-profit attempts before the rung is sold with the exit slippage instead. */
const TAKE_PROFIT_TIGHT_ATTEMPTS = 3;
/** Failed exits before a position past its hold time is called stuck (frees its slot). */
const STUCK_AFTER_FAILURES = 5;
const MAX_BACKOFF_MS = 10 * 60_000;
/** A fallback sell quote is reused this long (prices for tokens the Price API lacks). */
const QUOTE_CACHE_MS = 15_000;
/** Emptied accounts are closed this long after the position closes (the sale has settled). */
const RENT_RECLAIM_DELAY_MS = 30_000;
const RENT_RECLAIM_GIVE_UP_MS = 24 * 3_600_000;
/** Signals read per bot per pass. */
const MAX_SIGNALS_PER_PASS = 200;
/** Each pass starts no new transaction after this long, well inside the lock's timeout. */
const PASS_BUDGET_MS = 90_000;

type EngineRpc = Pick<
  TradingRpc,
  | "getBalance"
  | "getBlockHeight"
  | "getLatestBlockhash"
  | "send"
  | "getSignatureStatus"
  | "getTransactionFill"
  | "getTokenBalance"
> &
  GuardRpc;

export interface TradingEngineDeps {
  rpc: EngineRpc;
  swap: SwapClient;
  /** Second route for Pump.fun tokens Jupiter can't trade (PumpPortal); null for none. */
  fallback?: FallbackSwapClient | null;
  keys: KeyProvider;
  /** Who may open new positions (the admin wallets). */
  canTrade: (walletAddress: string) => boolean;
  /** Server-wide ceilings, whatever a bot's config says (TRADING_MAX_*). */
  maxBuyLamports: bigint;
  maxDailySpendLamports?: bigint;
  maxSlippageBps?: number;
  now?: () => Date;
}

export interface TradingRunSummary {
  settled: number;
  rebroadcast: number;
  recovered: number;
  withdrawals: number;
  exitsChecked: number;
  sells: number;
  stuck: number;
  bots: number;
  signals: number;
  buys: number;
  skipped: number;
  reclaimed: number;
  errors: number;
  /** Stages that threw; the job reports the run as failed when any did. */
  failedStages: string[];
}

type Wallet = TradingWalletRow;

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/** The advisory lock one pass holds; see runTradingEngine. */
export const TRADING_ENGINE_LOCK = "trading-engine";
/** The lock's transaction outlives the pass budget with room for the last send to finish. */
const PASS_TRANSACTION_TIMEOUT_MS = 240_000;

/**
 * One pass, under a Postgres advisory lock. A deploy runs the old trader and the new one side by
 * side for a moment, and two passes at once would read the same signals and the same exit
 * decisions: two buys of one token, two sales of one rung. The lock is transaction-scoped, so it
 * is released however the pass ends (a crash included); a process that doesn't get it skips. The
 * pass stops starting transactions after PASS_BUDGET_MS, and every state change is a claim on the
 * row's current state besides, so even a pass that outlived its lock can't apply a step twice.
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
    rebroadcast: 0,
    recovered: 0,
    withdrawals: 0,
    exitsChecked: 0,
    sells: 0,
    stuck: 0,
    bots: 0,
    signals: 0,
    buys: 0,
    skipped: 0,
    reclaimed: 0,
    errors: 0,
    failedStages: [],
  };
}

interface PassContext {
  deps: TradingEngineDeps;
  now: () => Date;
  walletFor: (userId: string) => Promise<Wallet | null>;
  summary: TradingRunSummary;
  /** Whether there is still time to start a transaction this pass. */
  inBudget: () => boolean;
  /** Sell quotes for tokens without a Price API price, by mint+amount. */
  quoteCache: Map<string, { at: number; out: bigint }>;
}

const quoteCache = new Map<string, { at: number; out: bigint }>();

async function tradingPass(deps: TradingEngineDeps): Promise<TradingRunSummary> {
  const now = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  const summary = emptySummary();
  const wallets = new Map<string, Wallet>();
  const walletFor = async (userId: string) => {
    if (!wallets.has(userId)) {
      const w = await prisma.tradingWallet.findUnique({ where: { userId } });
      if (w) wallets.set(userId, w);
    }
    return wallets.get(userId) ?? null;
  };
  const ctx: PassContext = {
    deps,
    now,
    walletFor,
    summary,
    inBudget: () => Date.now() - startedAt < PASS_BUDGET_MS,
    quoteCache,
  };

  await stage(ctx, "settle-orders", () => settleOrders(ctx));
  await stage(ctx, "settle-withdrawals", () => settleWithdrawals(ctx));
  await stage(ctx, "send-withdrawals", () => sendWithdrawals(ctx));
  await stage(ctx, "exits", () => manageExits(ctx));
  await stage(ctx, "entries", () => openEntries(ctx));
  await stage(ctx, "reclaim-rent", () => reclaimRent(ctx));
  return summary;
}

async function stage(ctx: PassContext, name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    ctx.summary.errors++;
    ctx.summary.failedStages.push(name);
    logger.error(`trading pass stage failed: ${name}`, { error: errText(err) });
  }
}

// ── Sending ──────────────────────────────────────────────────────────────────────────────────

/** Our own expiry bound: never below the route's, never below the height we signed at + 150. */
async function expiryBound(ctx: PassContext, routeBound: number | null): Promise<bigint> {
  const height = await ctx.deps.rpc.getBlockHeight();
  if (height === null) throw new Error("block height unavailable; not sending");
  return BigInt(Math.max(routeBound ?? 0, height + BLOCKHASH_LIFETIME_BLOCKS));
}

/** Signs already-checked bytes with the wallet's key (opened for this one signature). */
async function sign(ctx: PassContext, wallet: Wallet, unsigned: Uint8Array) {
  const { signed, signature } = await withWalletKey(wallet, ctx.deps.keys, (seed) =>
    signTransaction(unsigned, seed, wallet.publicKey),
  );
  return { rawTx: Buffer.from(signed).toString("base64"), signature };
}

interface SwapRequest {
  side: "buy" | "sell";
  mint: string;
  /** Buy: lamports in. Sell: raw token units in. */
  amount: bigint;
  decimals: number | null;
  slippageBps: number;
  maxPriorityFeeLamports: bigint;
}

interface BuiltSwap {
  transaction: Uint8Array;
  lastValidBlockHeight: number | null;
  route: "jupiter" | "pumpportal";
  quotedOut: string;
  expect: TradeExpectation;
}

/** Builds the swap on Jupiter, else (a Pump.fun token) PumpPortal, with what the guard must see. */
async function buildSwap(ctx: PassContext, wallet: Wallet, req: SwapRequest): Promise<BuiltSwap> {
  const buy = req.side === "buy";
  const maxSolDrop = req.amount + req.maxPriorityFeeLamports + BUY_MARGIN_LAMPORTS + req.amount / 100n;
  const feeAllowance = req.maxPriorityFeeLamports + SELL_FEE_ALLOWANCE_LAMPORTS;
  try {
    const quote = await ctx.deps.swap.quote({
      inputMint: buy ? WSOL_MINT : req.mint,
      outputMint: buy ? req.mint : WSOL_MINT,
      amount: req.amount,
      slippageBps: req.slippageBps,
    });
    const built = await ctx.deps.swap.swapTransaction({
      quote,
      userPublicKey: wallet.publicKey,
      maxPriorityFeeLamports: Number(req.maxPriorityFeeLamports),
    });
    const minOut = BigInt(quote.otherAmountThreshold);
    return {
      ...built,
      route: "jupiter",
      quotedOut: quote.outAmount,
      expect: buy
        ? { kind: "buy", mint: req.mint, minOut, maxSolDrop }
        : { kind: "sell", mint: req.mint, amount: req.amount, minSolOut: minOut, feeAllowance },
    };
  } catch (err) {
    const fallback = ctx.deps.fallback;
    if (!fallback || !fallback.handles(req.mint)) throw err;
    logger.info("jupiter could not build the swap; trying the fallback route", {
      mint: req.mint,
      side: req.side,
      error: errText(err),
    });
    const built = await fallback.build({
      side: req.side,
      mint: req.mint,
      wallet: wallet.publicKey,
      amount: req.amount,
      decimals: req.decimals,
      slippageBps: req.slippageBps,
      maxPriorityFeeLamports: Number(req.maxPriorityFeeLamports),
    });
    // No quote to hold it to: any tokens for a buy, and for a sale no worse than the fees.
    return {
      ...built,
      route: "pumpportal",
      quotedOut: "0",
      expect: buy
        ? { kind: "buy", mint: req.mint, minOut: 1n, maxSolDrop }
        : { kind: "sell", mint: req.mint, amount: req.amount, minSolOut: 0n, feeAllowance },
    };
  }
}

/** Build, guard, sign, record, send - for a position's buy or sale. */
async function executeSwap(
  ctx: PassContext,
  wallet: Wallet,
  position: Pick<PositionRow, "id" | "userId">,
  meta: { reason: string; rung: number | null },
  req: SwapRequest,
): Promise<void> {
  if (!ctx.inBudget()) throw new Error("pass time budget spent; next pass");
  const built = await buildSwap(ctx, wallet, req);
  await guardSwapTransaction(ctx.deps.rpc, built.transaction, wallet.publicKey, built.expect);
  const lastValidBlockHeight = await expiryBound(ctx, built.lastValidBlockHeight);
  const { rawTx, signature } = await sign(ctx, wallet, built.transaction);
  await prisma.tradingOrder.create({
    data: {
      positionId: position.id,
      userId: position.userId,
      side: req.side,
      reason: meta.reason,
      rung: meta.rung,
      signature,
      lastValidBlockHeight,
      rawTx,
      route: built.route,
      inAmount: req.amount.toString(),
      quotedOut: built.quotedOut,
    },
  });
  const sendError = await ctx.deps.rpc.send(rawTx);
  // A send error doesn't prove it wasn't forwarded: the order stays pending and settles from the chain.
  if (sendError) {
    await prisma.tradingOrder.updateMany({
      where: { signature, status: "pending" },
      data: { error: `send: ${sendError}`.slice(0, 500) },
    });
  }
}

// ── Settling ─────────────────────────────────────────────────────────────────────────────────

type OrderWithPosition = Prisma.TradingOrderGetPayload<{ include: { position: true } }>;
type PositionRow = Prisma.TradingPositionGetPayload<object>;

async function settleOrders(ctx: PassContext): Promise<void> {
  await settleOrphanEntries(ctx);
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

/** "buying" positions with no order were never sent; recovered if tokens are somehow there. */
async function settleOrphanEntries(ctx: PassContext) {
  const orphans = await prisma.tradingPosition.findMany({
    where: {
      status: "buying",
      orders: { none: {} },
      createdAt: { lt: new Date(ctx.now().getTime() - ORPHAN_ENTRY_MS) },
    },
    take: 50,
  });
  for (const p of orphans) {
    await endEntry(ctx, p, null, "the entry was never sent");
    ctx.summary.settled++;
  }
}

/**
 * Ends an entry that didn't fill as recorded - unless the wallet holds the token anyway (a buy
 * that landed although its status said otherwise), in which case the position opens from the
 * real balance rather than leaving tokens no exit will ever manage.
 */
async function endEntry(ctx: PassContext, position: PositionRow, orderId: string | null, why: string) {
  const wallet = await ctx.walletFor(position.userId);
  const held = wallet ? await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint) : null;
  if (held === null && wallet) return; // can't tell yet; next pass
  const at = ctx.now();
  if (held && held.raw > 0n) {
    await prisma.$transaction(async (tx) => {
      if (orderId) {
        const claimed = await tx.tradingOrder.updateMany({
          where: { id: orderId, status: "pending" },
          data: { status: "confirmed", settledAt: at, error: `recovered from the wallet balance (${why})` },
        });
        if (claimed.count !== 1) return;
      }
      await tx.tradingPosition.updateMany({
        where: { id: position.id, status: "buying" },
        data: {
          status: "open",
          tokensBought: held.raw.toString(),
          tokensHeld: held.raw.toString(),
          decimals: held.decimals,
          entryLamports: position.swapInLamports,
          openedAt: at,
          error: `recovered from the wallet balance (${why}); entry cost estimated`,
        },
      });
    });
    ctx.summary.recovered++;
    logger.warn("entry recovered from the wallet balance", { positionId: position.id, why });
    return;
  }
  await prisma.$transaction(async (tx) => {
    if (orderId) {
      const claimed = await tx.tradingOrder.updateMany({
        where: { id: orderId, status: "pending" },
        data: { status: "expired", error: why, settledAt: at },
      });
      if (claimed.count !== 1) return;
    }
    await tx.tradingPosition.updateMany({
      where: { id: position.id, status: "buying" },
      data: { status: "failed", error: why, closedAt: at },
    });
  });
}

async function settleOrder(ctx: PassContext, order: OrderWithPosition, height: number | null) {
  const wallet = await ctx.walletFor(order.userId);
  if (!wallet) return;
  const status = await ctx.deps.rpc.getSignatureStatus(order.signature);
  if (status === null) return;
  if (!status.seen) {
    if (height === null) return;
    if (BigInt(height) > order.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS) {
      if (order.side === "buy") {
        await endEntry(ctx, order.position, order.id, "the buy expired without landing");
      } else {
        await prisma.tradingOrder.updateMany({
          where: { id: order.id, status: "pending" },
          data: { status: "expired", error: "the sale expired without landing", settledAt: ctx.now() },
        });
      }
      ctx.summary.settled++;
      return;
    }
    // Still live: send it again (same signature, so it can only land once).
    if (order.rawTx && ctx.inBudget()) {
      await ctx.deps.rpc.send(order.rawTx);
      ctx.summary.rebroadcast++;
    }
    return;
  }
  if (!status.confirmed) return;
  const fill = await ctx.deps.rpc.getTransactionFill(order.signature, wallet.publicKey, order.position.mint);
  if (status.error || fill?.failed) {
    await settleFailed(ctx, order, `failed on chain: ${status.error ?? fill?.error ?? "unknown"}`, fill);
    ctx.summary.settled++;
    return;
  }
  if (!fill) {
    // Confirmed, but the RPC can't serve the details yet. Past the grace, settle from balances.
    if (ctx.now().getTime() - order.createdAt.getTime() < FILL_READ_GRACE_MS) return;
    await settleFromBalances(ctx, wallet, order);
    ctx.summary.settled++;
    return;
  }
  if (order.side === "buy") await settleBuy(ctx, wallet, order, fill);
  else await settleSale(ctx, wallet, order, fill);
  ctx.summary.settled++;
}

async function settleFailed(
  ctx: PassContext,
  order: OrderWithPosition,
  error: string,
  fill: TransactionFill | null,
) {
  const at = ctx.now();
  const fee = fill ? fill.lamportsDelta : null; // what the failed attempt cost (negative)
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.tradingOrder.updateMany({
      where: { id: order.id, status: "pending" },
      data: { status: "failed", error, settledAt: at, lamportsDelta: fee },
    });
    if (claimed.count !== 1) return;
    if (order.side === "buy") {
      // Failed on chain: nothing was bought. One try per token.
      await tx.tradingPosition.updateMany({
        where: { id: order.positionId, status: "buying" },
        data: { status: "failed", error, closedAt: at, proceedsLamports: { increment: fee ?? 0n } },
      });
    } else {
      await tx.tradingPosition.update({
        where: { id: order.positionId },
        data: { error, proceedsLamports: { increment: fee ?? 0n }, ...failureBackoff(order.position, at) },
      });
    }
  });
}

async function settleBuy(ctx: PassContext, wallet: Wallet, order: OrderWithPosition, fill: TransactionFill) {
  let bought = fill.tokenDelta;
  let decimals = fill.decimals;
  let note: string | null = null;
  if (bought <= 0n) {
    // The fill didn't show the token (an unusual account layout): read what is held, and say so.
    const held = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, order.position.mint);
    if (!held) return;
    bought = held.raw;
    decimals = held.decimals;
    note = "fill read from the wallet balance";
  }
  const at = ctx.now();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.tradingOrder.updateMany({
      where: { id: order.id, status: "pending" },
      data: {
        status: "confirmed",
        settledAt: at,
        lamportsDelta: fill.lamportsDelta,
        tokenDelta: fill.tokenDelta.toString(),
      },
    });
    if (claimed.count !== 1) return;
    await tx.tradingPosition.updateMany({
      where: { id: order.positionId, status: "buying" },
      data:
        bought > 0n
          ? {
              status: "open",
              entryLamports: -fill.lamportsDelta,
              tokensBought: bought.toString(),
              tokensHeld: bought.toString(),
              decimals,
              // Hold caps count from the fill itself, not from when this pass noticed it.
              openedAt: fill.blockTime ?? at,
              error: note,
            }
          : { status: "failed", error: "the buy confirmed but no tokens arrived", closedAt: at },
    });
  });
}

async function settleSale(ctx: PassContext, wallet: Wallet, order: OrderWithPosition, fill: TransactionFill) {
  const position = order.position;
  // Holdings after a sale come from the chain; the fill's token change is only the fallback.
  const chain = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint);
  const sold = fill.tokenDelta < 0n ? -fill.tokenDelta : 0n;
  let held = chain ? chain.raw : BigInt(position.tokensHeld) - sold;
  if (held < 0n) held = 0n;
  const at = ctx.now();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.tradingOrder.updateMany({
      where: { id: order.id, status: "pending" },
      data: {
        status: "confirmed",
        settledAt: at,
        lamportsDelta: fill.lamportsDelta,
        tokenDelta: fill.tokenDelta.toString(),
      },
    });
    if (claimed.count !== 1) return;
    await tx.tradingPosition.update({
      where: { id: position.id },
      data: saleOutcome(position, order, held, fill.lamportsDelta, at),
    });
  });
}

/** Confirmed, details unreadable: the sale's effect from balances, the buy recovered from holdings. */
async function settleFromBalances(ctx: PassContext, wallet: Wallet, order: OrderWithPosition) {
  if (order.side === "buy") {
    await endEntry(ctx, order.position, order.id, "confirmed, but its details could not be read");
    return;
  }
  const chain = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, order.position.mint);
  if (!chain) return;
  const at = ctx.now();
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.tradingOrder.updateMany({
      where: { id: order.id, status: "pending" },
      data: {
        status: "confirmed",
        settledAt: at,
        error: "details unreadable; settled from the wallet balance",
      },
    });
    if (claimed.count !== 1) return;
    await tx.tradingPosition.update({
      where: { id: order.positionId },
      data: saleOutcome(order.position, order, chain.raw, 0n, at),
    });
  });
}

function saleOutcome(
  position: PositionRow,
  order: { reason: string; rung: number | null },
  held: bigint,
  lamportsDelta: bigint,
  at: Date,
): Prisma.TradingPositionUpdateInput {
  const sold = held < BigInt(position.tokensHeld);
  const tookRung = sold && order.reason === "take_profit" && order.rung !== null;
  const closed = held === 0n;
  return {
    tokensHeld: held.toString(),
    // Net SOL back, fees included: a sale's change is the money that came back.
    proceedsLamports: { increment: lamportsDelta },
    ...(tookRung
      ? {
          rungsTaken: Math.max(position.rungsTaken, order.rung! + 1),
          // The trail arms at the sale, from the multiple it sold at.
          highMultiple: Math.max(position.highMultiple ?? 0, position.lastMultiple ?? 0) || null,
        }
      : {}),
    ...(closed ? { status: "closed", closedAt: at, closeReason: order.reason } : {}),
    failCount: 0,
    nextAttemptAt: null,
    error: null,
  };
}

/** The next attempt's time after one more failure. */
function failureBackoff(position: Pick<PositionRow, "failCount">, at: Date) {
  const failCount = position.failCount + 1;
  const wait = Math.min(MAX_BACKOFF_MS, 5_000 * 3 ** (failCount - 1));
  return { failCount, nextAttemptAt: new Date(at.getTime() + wait) };
}

// ── Withdrawals ──────────────────────────────────────────────────────────────────────────────

async function settleWithdrawals(ctx: PassContext): Promise<void> {
  // Claimed and never recorded: never sent (the signature is recorded before sending).
  await prisma.tradingWithdrawal.updateMany({
    where: {
      status: "sending",
      signature: null,
      createdAt: { lt: new Date(ctx.now().getTime() - ORPHAN_WITHDRAWAL_MS) },
    },
    data: { status: "failed", error: "the withdrawal was never sent", settledAt: ctx.now() },
  });
  const pending = await prisma.tradingWithdrawal.findMany({ where: { status: "pending" }, take: 50 });
  if (pending.length === 0) return;
  const height = await ctx.deps.rpc.getBlockHeight();
  for (const w of pending) {
    if (!w.signature) continue;
    const status = await ctx.deps.rpc.getSignatureStatus(w.signature);
    if (status === null) continue;
    let data: Prisma.TradingWithdrawalUpdateManyMutationInput | null = null;
    if (!status.seen) {
      if (
        height !== null &&
        w.lastValidBlockHeight !== null &&
        BigInt(height) > w.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS
      ) {
        data = { status: "failed", error: "the transaction expired without landing", settledAt: ctx.now() };
      } else if (w.rawTx && ctx.inBudget()) {
        await ctx.deps.rpc.send(w.rawTx);
        ctx.summary.rebroadcast++;
      }
    } else if (status.confirmed) {
      data = status.error
        ? { status: "failed", error: `failed on chain: ${status.error}`, settledAt: ctx.now() }
        : { status: "confirmed", settledAt: ctx.now() };
    }
    if (!data) continue;
    const claimed = await prisma.tradingWithdrawal.updateMany({
      where: { id: w.id, status: "pending" },
      data,
    });
    ctx.summary.settled += claimed.count;
  }
}

/**
 * How much a withdrawal sends from a balance, or why it can't. `keep` is what must stay behind:
 * while positions are open, enough to pay for selling them (fees and the temporary wSOL account).
 */
export function withdrawalAmount(
  balance: bigint,
  requested: bigint | null,
  keep = 0n,
): { lamports: bigint } | { error: string } {
  const spendable = balance - TX_FEE_LAMPORTS - keep;
  if (spendable <= 0n) {
    return {
      error:
        keep > 0n
          ? "everything left is kept to pay for selling open positions"
          : "the wallet holds nothing to withdraw",
    };
  }
  if (requested === null) return { lamports: spendable };
  if (requested <= 0n) return { error: "the amount must be positive" };
  if (requested > spendable) {
    return {
      error:
        keep > 0n
          ? "the amount is more than the wallet can spare while positions are open (sell them first)"
          : "the amount is more than the wallet holds (less the fee)",
    };
  }
  const left = balance - TX_FEE_LAMPORTS - requested;
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
    if (!ctx.inBudget()) return;
    // Claim it first: only the pass that moves it to "sending" may send it.
    const claimed = await prisma.tradingWithdrawal.updateMany({
      where: { id: w.id, status: "requested" },
      data: { status: "sending" },
    });
    if (claimed.count !== 1) continue;
    const fail = (error: string) =>
      prisma.tradingWithdrawal.updateMany({
        where: { id: w.id, status: "sending" },
        data: { status: "failed", error: error.slice(0, 500), settledAt: ctx.now() },
      });
    try {
      const wallet = await ctx.walletFor(w.userId);
      const user = await prisma.user.findUnique({ where: { id: w.userId }, select: { walletAddress: true } });
      // The destination is the address sealed into the wallet's key (opening it below proves the
      // row wasn't altered), and it must still be the owner's sign-in wallet.
      if (
        !wallet ||
        !user ||
        wallet.withdrawTo !== user.walletAddress ||
        w.destination !== wallet.withdrawTo
      ) {
        await fail("destination is not the account's sign-in wallet");
        continue;
      }
      const [balance, blockhash, open, bot] = await Promise.all([
        ctx.deps.rpc.getBalance(wallet.publicKey),
        ctx.deps.rpc.getLatestBlockhash(),
        prisma.tradingPosition.count({
          where: { userId: w.userId, status: { in: ["buying", "open", "stuck"] } },
        }),
        prisma.tradingBot.findUnique({ where: { userId: w.userId }, select: { config: true } }),
      ]);
      if (balance === null || !blockhash) {
        // Release the claim: try again next pass.
        await prisma.tradingWithdrawal.updateMany({
          where: { id: w.id, status: "sending" },
          data: { status: "requested" },
        });
        continue;
      }
      const keep = open > 0 ? solToLamports(readTradingBotConfig(bot?.config).reserveSol) : 0n;
      const amount = withdrawalAmount(balance, w.requestedLamports, keep);
      if ("error" in amount) {
        await fail(amount.error);
        continue;
      }
      const unsigned = buildSolTransfer({
        from: wallet.publicKey,
        to: wallet.withdrawTo,
        lamports: amount.lamports,
        recentBlockhash: blockhash.blockhash,
      });
      const sim = await ctx.deps.rpc.simulateParsed(Buffer.from(unsigned).toString("base64"), [
        wallet.publicKey,
      ]);
      if (!sim) throw new Error("simulation unavailable");
      if (sim.error) throw new Error(`simulation failed: ${sim.error}`);
      const { rawTx, signature } = await sign(ctx, wallet, unsigned);
      const recorded = await prisma.tradingWithdrawal.updateMany({
        where: { id: w.id, status: "sending" },
        data: {
          status: "pending",
          signature,
          rawTx,
          sentLamports: amount.lamports,
          lastValidBlockHeight: BigInt(blockhash.lastValidBlockHeight),
        },
      });
      if (recorded.count !== 1) continue; // written off meanwhile: not sending
      await ctx.deps.rpc.send(rawTx);
      ctx.summary.withdrawals++;
      logger.info("withdrawal sent", { userId: w.userId, lamports: amount.lamports.toString() });
    } catch (err) {
      ctx.summary.errors++;
      await fail(errText(err)).catch(() => undefined);
    }
  }
}

// ── Exits ────────────────────────────────────────────────────────────────────────────────────

/**
 * What the tokens still held are worth against what was paid for them: the exit plan's multiple.
 * Measured in SOL (the token's USD price over SOL's), so SOL's own moves don't read as the
 * token's, and against the SOL that went into the swap (fees and rent aside: the plan's "2x" is
 * the token's move, as the Lighthouse simulates it). Null when there is no price.
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
  const now = ctx.now();
  const due = await prisma.tradingPosition.findMany({
    where: {
      status: { in: ["open", "stuck"] },
      orders: { none: { status: "pending" } },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { openedAt: "asc" },
    take: 200,
  });
  if (due.length === 0) return;
  let prices = new Map<string, number>();
  try {
    prices = await ctx.deps.swap.pricesUsd([...due.map((p) => p.mint), WSOL_MINT]);
  } catch (err) {
    logger.warn("price lookup failed; falling back to quotes", { error: errText(err) });
  }
  const solUsd = prices.get(WSOL_MINT);
  for (const position of due) {
    if (!ctx.inBudget()) return;
    ctx.summary.exitsChecked++;
    try {
      await manageExit(ctx, position, prices.get(position.mint), solUsd);
    } catch (err) {
      ctx.summary.errors++;
      await recordExitFailure(ctx, position, err);
    }
  }
}

/**
 * An exit that couldn't be priced or sold: back off, and once it plainly can't be sold (no route,
 * or failing well past its hold time) call it stuck so it stops holding an open slot. Stuck
 * positions keep being retried, at most every 10 minutes.
 */
async function recordExitFailure(ctx: PassContext, position: PositionRow, err: unknown) {
  const at = ctx.now();
  const backoff = failureBackoff(position, at);
  const plan = readExitPlan(position.exitPlan);
  const ageMinutes = position.openedAt ? (at.getTime() - position.openedAt.getTime()) / 60_000 : 0;
  const noRoute = err instanceof NoRouteError;
  const stuck =
    position.status === "open" &&
    ((noRoute && backoff.failCount >= 3) ||
      (backoff.failCount >= STUCK_AFTER_FAILURES && ageMinutes > plan.maxHoldMinutes));
  await prisma.tradingPosition
    .update({
      where: { id: position.id },
      data: { error: errText(err), ...backoff, ...(stuck ? { status: "stuck" } : {}) },
    })
    .catch(() => undefined);
  if (stuck) ctx.summary.stuck++;
  logger.warn("exit attempt failed", {
    positionId: position.id,
    failCount: backoff.failCount,
    stuck,
    error: errText(err),
  });
}

/** The token's multiple from a sell quote, cached briefly (the Price API has no price for it). */
async function quotedMultiple(
  ctx: PassContext,
  position: PositionRow,
  held: bigint,
  bought: bigint,
): Promise<number | null> {
  if (!position.swapInLamports || bought <= 0n) return null;
  const key = `${position.mint}:${held}`;
  const cached = ctx.quoteCache.get(key);
  let out: bigint;
  if (cached && Date.now() - cached.at < QUOTE_CACHE_MS) out = cached.out;
  else {
    const quote = await ctx.deps.swap.quote({
      inputMint: position.mint,
      outputMint: WSOL_MINT,
      amount: held,
      slippageBps: 5000,
    });
    out = BigInt(quote.outAmount);
    ctx.quoteCache.set(key, { at: Date.now(), out });
    if (ctx.quoteCache.size > 500) ctx.quoteCache.clear();
  }
  const costOfHeld = (Number(position.swapInLamports) * Number(held)) / Number(bought);
  return costOfHeld > 0 ? Number(out) / costOfHeld : null;
}

async function manageExit(ctx: PassContext, position: PositionRow, tokenUsd?: number, solUsd?: number) {
  const wallet = await ctx.walletFor(position.userId);
  if (!wallet || !position.openedAt) return;
  const bought = BigInt(position.tokensBought ?? "0");
  const held = BigInt(position.tokensHeld);
  const now = ctx.now();
  if (held <= 0n) {
    await prisma.tradingPosition.update({
      where: { id: position.id },
      data: { status: "closed", closedAt: now, closeReason: position.closeReason ?? "empty" },
    });
    return;
  }
  const bot = await prisma.tradingBot.findUnique({ where: { userId: position.userId } });
  const config = readTradingBotConfig(bot?.config);
  const plan = readExitPlan(position.exitPlan);

  let decision: { all: boolean; fraction: number; reason: ExitReason; rung?: number };
  if (position.closeRequested || position.status === "stuck") {
    // The owner asked, or it's stuck: sell everything, no price needed (a failing price lookup
    // must never block a manual sale).
    decision = { all: true, fraction: 1, reason: position.closeRequested ? "manual" : "max_hold" };
  } else {
    let multiple = positionMultiple(position, tokenUsd, solUsd);
    if (multiple === null) multiple = await quotedMultiple(ctx, position, held, bought);
    if (multiple === null) throw new Error("no price for the token");
    const d = decideExit(
      { openedAt: position.openedAt, rungsTaken: position.rungsTaken, highMultiple: position.highMultiple },
      multiple,
      now,
      plan,
    );
    await prisma.tradingPosition.update({
      where: { id: position.id },
      data: { lastMultiple: multiple, lastPricedAt: now, highMultiple: d.highMultiple },
    });
    if (d.action === "hold") return;
    decision = { all: d.all, fraction: d.fraction, reason: d.reason, rung: d.rung };
    position.lastMultiple = multiple;
  }

  // A full exit sells what the chain says is held, not what the books say.
  let amount = sellAmount(decision, bought, held);
  if (decision.all) {
    const chain = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint);
    if (!chain) throw new Error("could not read the token balance");
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

  const configured = Math.min(config.slippageBps, ctx.deps.maxSlippageBps ?? config.slippageBps);
  const exitSlippage = Math.max(configured, EXIT_SLIPPAGE_FLOOR_BPS);
  // A take-profit sells at the configured slippage; one that keeps failing (the price moved
  // before it landed) and every protective exit sells with room to get out.
  const slippageBps =
    decision.reason === "take_profit" && position.failCount < TAKE_PROFIT_TIGHT_ATTEMPTS
      ? configured
      : exitSlippage;
  await executeSwap(
    ctx,
    wallet,
    position,
    { reason: decision.reason, rung: decision.reason === "take_profit" ? (decision.rung ?? null) : null },
    {
      side: "sell",
      mint: position.mint,
      amount,
      decimals: position.decimals,
      slippageBps,
      maxPriorityFeeLamports: solToLamports(config.maxPriorityFeeSol),
    },
  );
  ctx.summary.sells++;
  logger.info("exit sent", {
    positionId: position.id,
    mint: position.mint,
    reason: decision.reason,
    multiple: position.lastMultiple !== null ? Number(position.lastMultiple.toFixed(3)) : null,
  });
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

/**
 * The new signals a bot follows in (from, to]: its filters' matches and its models' calls, oldest
 * first, one per token. A filter edited (re-armed) after the bot's settings were last saved is
 * left out: what it matches changed, so the owner confirms by saving the settings again.
 */
export async function loadSignals(
  userId: string,
  config: TradingBotConfig,
  from: Date,
  to: Date,
  configSavedAt: Date = new Date(8.64e15),
): Promise<TradeSignal[]> {
  const { filterIds, models, highConvictionOnly } = config.sources;
  const [matches, calls] = await Promise.all([
    filterIds.length === 0
      ? []
      : prisma.match.findMany({
          where: {
            userId,
            filterId: { in: filterIds },
            matchedAt: { gt: from, lte: to },
            filter: { armedAt: { lte: configSavedAt } },
          },
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
  const seen = new Set<string>();
  return signals.filter((s) => (seen.has(s.mint) ? false : (seen.add(s.mint), true)));
}

/**
 * How far signals may be read: a few seconds behind now, and behind the oldest transaction still
 * open elsewhere (it may yet commit a row stamped earlier) - but never more than 20s behind. Our
 * own lock's transaction is left out of that.
 */
async function signalHorizon(now: Date): Promise<Date> {
  const grace = new Date(now.getTime() - SIGNAL_COMMIT_GRACE_MS);
  try {
    const [row] = await prisma.$queryRaw<{ oldest: Date | null }[]>`
      SELECT min(xact_start) AS oldest FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
        AND query NOT ILIKE '%pg_try_advisory_xact_lock%'`;
    const oldest = row?.oldest ?? null;
    if (!oldest) return grace;
    const floor = new Date(now.getTime() - MAX_COMMIT_WAIT_MS);
    const held = oldest < floor ? floor : oldest;
    return held < grace ? held : grace;
  } catch {
    return grace;
  }
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
  bot: { id: string; userId: string; config: Prisma.JsonValue; signalsFrom: Date; configSavedAt: Date },
  wallet: Wallet,
) {
  const config = readTradingBotConfig(bot.config);
  const now = ctx.now();
  const horizon = await signalHorizon(now);
  if (horizon <= bot.signalsFrom) return;
  const signals = await loadSignals(bot.userId, config, bot.signalsFrom, horizon, bot.configSavedAt);
  // The window is consumed whatever happens to its signals: a skipped signal is never bought later.
  await prisma.tradingBot.update({ where: { id: bot.id }, data: { signalsFrom: horizon } });
  if (signals.length === 0) return;
  ctx.summary.signals += signals.length;

  let buyLamports = solToLamports(config.buySol);
  if (buyLamports > ctx.deps.maxBuyLamports) buyLamports = ctx.deps.maxBuyLamports;
  const slippageBps = Math.min(config.slippageBps, ctx.deps.maxSlippageBps ?? config.slippageBps);
  const plan: ExitPlan = effectiveExitPlan(config);

  for (const signal of signals) {
    if (!ctx.inBudget()) {
      ctx.summary.skipped++;
      continue;
    }
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
      await executeSwap(
        ctx,
        wallet,
        position,
        { reason: "entry", rung: null },
        {
          side: "buy",
          mint: signal.mint,
          amount: buyLamports,
          decimals: null,
          slippageBps,
          maxPriorityFeeLamports: solToLamports(config.maxPriorityFeeSol),
        },
      );
      ctx.summary.buys++;
      logger.info("entry sent", { userId: bot.userId, mint: signal.mint, source: signal.label });
    } catch (err) {
      // Nothing was signed or sent (executeSwap only throws before recording): the entry is over.
      await prisma.tradingPosition.updateMany({
        where: { id: position.id, status: "buying", orders: { none: {} } },
        data: { status: "failed", error: errText(err), closedAt: ctx.now() },
      });
      if (!(err instanceof GuardRefusal) && !(err instanceof NoRouteError)) ctx.summary.errors++;
      logger.warn("entry not sent", { mint: signal.mint, error: errText(err) });
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
  const [open, spent, inFlight, existing] = await Promise.all([
    prisma.tradingPosition.count({ where: { userId, status: { in: ["buying", "open"] } } }),
    prisma.tradingPosition.aggregate({
      where: {
        userId,
        status: { not: "failed" },
        createdAt: { gt: new Date(now.getTime() - 24 * 3600_000) },
      },
      _sum: { swapInLamports: true },
    }),
    // Buys sent but not settled: the balance may not show them yet.
    prisma.tradingPosition.aggregate({ where: { userId, status: "buying" }, _sum: { swapInLamports: true } }),
    prisma.tradingPosition.findUnique({
      where: { userId_mint: { userId, mint: signal.mint } },
      select: { id: true },
    }),
  ]);
  if (existing) return "already traded this token";
  if (open >= config.maxOpenPositions) return "at the open-position limit";
  let dailyCap = solToLamports(config.maxDailySpendSol);
  if (ctx.deps.maxDailySpendLamports !== undefined && ctx.deps.maxDailySpendLamports < dailyCap)
    dailyCap = ctx.deps.maxDailySpendLamports;
  if ((spent._sum.swapInLamports ?? 0n) + buyLamports > dailyCap) return "at the 24h spend limit";
  const balance = await ctx.deps.rpc.getBalance(wallet.publicKey);
  if (balance === null) return "balance unavailable";
  const committed = inFlight._sum.swapInLamports ?? 0n;
  const needed =
    buyLamports +
    solToLamports(config.reserveSol) +
    solToLamports(config.maxPriorityFeeSol) +
    BUY_MARGIN_LAMPORTS;
  if (balance - committed < needed) return "not enough SOL above the reserve";
  return null;
}

// ── Rent ─────────────────────────────────────────────────────────────────────────────────────

/** Closes the emptied token accounts of sold-out positions: ~0.002 SOL back per trade. */
async function reclaimRent(ctx: PassContext): Promise<void> {
  const now = ctx.now();
  const closed = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      accountClosedAt: null,
      closedAt: { lt: new Date(now.getTime() - RENT_RECLAIM_DELAY_MS) },
    },
    take: 5,
  });
  for (const position of closed) {
    if (!ctx.inBudget()) return;
    const wallet = await ctx.walletFor(position.userId);
    if (!wallet) continue;
    const held = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint);
    if (!held) continue;
    const empty = held.accounts.filter((a) => a.raw === 0n);
    const giveUp =
      position.closedAt !== null && now.getTime() - position.closedAt.getTime() > RENT_RECLAIM_GIVE_UP_MS;
    if (empty.length === 0 || held.raw > 0n || giveUp) {
      // Nothing to close, or tokens remain (dust, an airdrop) that a close would refuse anyway.
      await prisma.tradingPosition.update({ where: { id: position.id }, data: { accountClosedAt: now } });
      continue;
    }
    const blockhash = await ctx.deps.rpc.getLatestBlockhash();
    if (!blockhash) continue;
    for (const account of empty) {
      try {
        const unsigned = buildCloseTokenAccount({
          owner: wallet.publicKey,
          account: account.address,
          tokenProgram: account.programId,
          recentBlockhash: blockhash.blockhash,
        });
        const sim = await ctx.deps.rpc.simulateParsed(Buffer.from(unsigned).toString("base64"), [
          wallet.publicKey,
        ]);
        if (!sim || sim.error) continue;
        const { rawTx } = await sign(ctx, wallet, unsigned);
        // Not tracked as an order: if it doesn't land, the account is still there next pass.
        await ctx.deps.rpc.send(rawTx);
        ctx.summary.reclaimed++;
      } catch (err) {
        logger.warn("could not close an empty token account", {
          positionId: position.id,
          error: errText(err),
        });
      }
    }
  }
}
