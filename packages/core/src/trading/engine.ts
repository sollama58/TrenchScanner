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
import {
  NoRouteError,
  RateLimitedError,
  WSOL_MINT,
  type FallbackSwapClient,
  type SwapClient,
} from "./jupiterSwap.js";
import { TransientError } from "./errors.js";
import type { KeyProvider } from "./keyVault.js";
import type { MintInfo, TradingRpc, TransactionFill } from "./rpc.js";
import {
  buildCloseTokenAccount,
  buildSolTransfer,
  CLOSE_COMPUTE_UNITS,
  priorityFeeOf,
  signTransaction,
  TRANSFER_COMPUTE_UNITS,
} from "./transaction.js";
import {
  GuardRefusal,
  guardSwapTransaction,
  PROGRAM,
  type GuardRpc,
  type TradeExpectation,
} from "./txGuard.js";
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
 * Retrying: nothing is ever sent twice while it can still land. A transaction is rebroadcast by
 * its own signature until it lands or its blockhash is safely past expiry; only then is a new one
 * built - from a fresh quote, and with double the priority fee of the one that never landed
 * (feeForRetry). An entry is tried again (a send that expired, a buy that failed on chain, a
 * build that hit a transient error) up to MAX_ENTRY_TRIES times while its signal is fresh, never
 * at a price that ran past its slippage since the first try; a sale until it goes through (more
 * slippage each time a protective exit fails on chain). A dependency that merely didn't answer
 * (TransientError, a rate limit, no price) is retried shortly without counting against anything.
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
/** How long a confirmed buy whose tokens don't show yet is re-read before it's written off. */
const CONFIRMED_BALANCE_WAIT_MS = 10 * 60_000;
/** Failed buys and closed positions are re-checked for tokens this long after they ended... */
const RECOVERY_LOOKBACK_MS = 2 * 3_600_000;
/** ...once they have been over this long (no node still shows the balance from before)... */
const RECOVERY_SETTLE_MS = 2 * 60_000;
/** ...at most this often each. */
const RECOVERY_RECHECK_MS = 5 * 60_000;
/** An entry still "buying" with no order this long after creation was never sent. */
const ORPHAN_ENTRY_MS = 2 * 60_000;
/** Tries at an entry - sends that never landed or failed on chain, builds that failed - before it is given up. */
const MAX_ENTRY_TRIES = 4;
/** An entry is retried this long past its signal's age limit at most (its first try was in time). */
const ENTRY_RETRY_GRACE_MS = 2 * 60_000;
/** A try at an entry that failed before sending (a transient error) is repeated this soon. */
const ENTRY_RETRY_MS = 3_000;
/** A retry after a send that never landed pays at least this priority fee (0.0001 SOL)... */
const MIN_RAISED_FEE_LAMPORTS = 100_000n;
/** The bot's own small transactions (withdrawals, closes) price compute at least this (micro-lamports)... */
const UTILITY_MIN_PRICE = 200_000n;
/** ...and pay at most this in priority fee, whatever recent fees say. */
const UTILITY_MAX_FEE_LAMPORTS = 200_000n;
/** Sends of a withdrawal (each after the last expired unlanded, with a higher fee) before it fails. */
const MAX_WITHDRAWAL_SENDS = 3;
/** An exit failing only on transient errors this long past its hold cap is called stuck. */
const TRANSIENT_STUCK_AFTER_MINUTES = 30;
/** A withdrawal claimed this long ago with no signature recorded was never sent. */
const ORPHAN_WITHDRAWAL_MS = 5 * 60_000;
/** Exits allow at least this slippage (30%): a stop must get out, not wait for a better fill. */
const EXIT_SLIPPAGE_FLOOR_BPS = 3_000;
/** Failed take-profit attempts before the rung is sold with the exit slippage instead. */
const TAKE_PROFIT_TIGHT_ATTEMPTS = 3;
/** Failed exits before a position past its hold time is called stuck (frees its slot). */
const STUCK_AFTER_FAILURES = 5;
const MAX_BACKOFF_MS = 10 * 60_000;
/** A protective exit that failed on chain is retried this soon (with more slippage). */
const PROTECTIVE_RETRY_MS = 15_000;
/** After this many consecutive failures a position is retried only every GIVEN_UP_RETRY_MS. */
const GIVE_UP_AFTER_FAILURES = 20;
const GIVEN_UP_RETRY_MS = 6 * 3_600_000;
/** A fallback sell quote is reused this long (prices for tokens the Price API lacks). */
const QUOTE_CACHE_MS = 15_000;
/** Emptied accounts are closed this long after the position closes (the sale has settled). */
const RENT_RECLAIM_DELAY_MS = 30_000;
const RENT_RECLAIM_GIVE_UP_MS = 24 * 3_600_000;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
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
  | "getMintInfo"
  | "getPriorityFeeEstimate"
> &
  GuardRpc;

export interface TradingEngineDeps {
  rpc: EngineRpc;
  swap: SwapClient;
  /** Second route for Pump.fun tokens Jupiter can't trade (PumpPortal); null for none. */
  fallback?: FallbackSwapClient | null;
  /** Opens the custodial wallets (KMS); null when this process has none (the server wallet still trades). */
  keys: KeyProvider | null;
  /** Server-wide ceiling on any swap's priority fee (TRADING_MAX_PRIORITY_FEE_SOL). */
  maxPriorityFeeLamports?: bigint;
  /** Who may open new positions (the admin wallets). */
  canTrade: (walletAddress: string) => boolean;
  /**
   * The server wallet (serverWallet.ts), when the trader holds its key: the reserved account it
   * trades for, its key, and where its withdrawals may go (null: nowhere). Its bot is controlled
   * by the admins, so it may open positions whatever canTrade says.
   */
  serverWallet?: { userId: string; publicKey: string; seed: Uint8Array; withdrawTo: string | null } | null;
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

/**
 * A wallet the engine trades from: a user's custodial wallet (key sealed under KMS, `row`), or
 * the server wallet (key from the environment, `row` null). `withdrawTo` is the only address its
 * withdrawals may go to - sealed into the key for custodial wallets, configured for the server's.
 */
interface Wallet {
  userId: string;
  publicKey: string;
  withdrawTo: string | null;
  row: TradingWalletRow | null;
}

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
  const server = deps.serverWallet ?? null;
  const walletFor = async (userId: string) => {
    if (!wallets.has(userId)) {
      if (server && userId === server.userId) {
        wallets.set(userId, {
          userId,
          publicKey: server.publicKey,
          withdrawTo: server.withdrawTo,
          row: null,
        });
      } else if (deps.keys) {
        // A custodial wallet is only usable with the key service to open it.
        const w = await prisma.tradingWallet.findUnique({ where: { userId } });
        if (w) wallets.set(userId, { userId, publicKey: w.publicKey, withdrawTo: w.withdrawTo, row: w });
      }
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
  await stage(ctx, "recover", () => recoverPositions(ctx));
  await stage(ctx, "settle-withdrawals", () => settleWithdrawals(ctx));
  await stage(ctx, "send-withdrawals", () => sendWithdrawals(ctx));
  await stage(ctx, "exits", () => manageExits(ctx));
  await stage(ctx, "retry-entries", () => retryEntries(ctx));
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
  if (height === null) throw new TransientError("block height unavailable; not sending");
  return BigInt(Math.max(routeBound ?? 0, height + BLOCKHASH_LIFETIME_BLOCKS));
}

/** Signs already-checked bytes with the wallet's key (opened for this one signature). */
async function sign(ctx: PassContext, wallet: Wallet, unsigned: Uint8Array) {
  const server = ctx.deps.serverWallet;
  let out: { signed: Uint8Array; signature: string };
  if (wallet.row) {
    if (!ctx.deps.keys) throw new Error("the key service is not configured; custodial wallets can't sign");
    out = await withWalletKey(wallet.row, ctx.deps.keys, (seed) =>
      signTransaction(unsigned, seed, wallet.publicKey),
    );
  } else if (server && server.publicKey === wallet.publicKey) {
    out = signTransaction(unsigned, server.seed, wallet.publicKey);
  } else {
    throw new Error("no key for this wallet");
  }
  const { signed, signature } = out;
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
  /** Exactly this priority fee, not the route's estimate: a retry after a send that never landed. */
  priorityFeeLamports?: bigint;
  /** Buy only: refuse a route that would deliver less (a retry must not chase the price). */
  minQuotedOut?: bigint;
  /**
   * Sell only: what `amount` is worth in lamports by the latest price, or by its cost when there
   * is none - the base for how much SOL the route may send elsewhere (its fee, a tip).
   */
  valueHintLamports?: bigint;
}

interface BuiltSwap {
  transaction: Uint8Array;
  lastValidBlockHeight: number | null;
  route: "jupiter" | "pumpportal";
  quotedOut: string;
  expect: TradeExpectation;
}

/** The most any one trade may send to anyone but the wallet, whatever the trade's size or price. */
const MAX_EXTERNAL_LAMPORTS = 50_000_000n;

/**
 * SOL a route may send to anyone but the wallet: 2% of the trade (fees, tips) plus 0.001 SOL,
 * never more than 0.05 SOL - a sale's size comes from a price the route itself reports, so the
 * allowance must not grow with it.
 */
function externalAllowance(tradeLamports: bigint): bigint {
  const share = tradeLamports / 50n;
  return (share > MAX_EXTERNAL_LAMPORTS ? MAX_EXTERNAL_LAMPORTS : share) + 1_000_000n;
}

/** The priority fee a bot may pay: its own setting, under the server's ceiling. */
function priorityFee(ctx: PassContext, config: TradingBotConfig): bigint {
  const own = solToLamports(config.maxPriorityFeeSol);
  const cap = ctx.deps.maxPriorityFeeLamports;
  return cap !== undefined && cap < own ? cap : own;
}

/**
 * The priority fee for the next try at a swap, given the last try on the same side: undefined -
 * the route's own estimate from recent fees, under the cap - unless the last try expired without
 * landing. Then the estimate plainly wasn't enough: double what that try paid (at least
 * MIN_RAISED_FEE_LAMPORTS), never over the cap. A try that landed and failed on chain paid
 * enough to land, so its retry isn't raised.
 */
export function feeForRetry(
  cap: bigint,
  last: { status: string; priorityFeeLamports: bigint | null } | null,
): bigint | undefined {
  if (!last || last.status !== "expired" || cap <= 0n) return undefined;
  let fee = last.priorityFeeLamports !== null ? last.priorityFeeLamports * 2n : cap / 2n;
  if (fee < MIN_RAISED_FEE_LAMPORTS) fee = MIN_RAISED_FEE_LAMPORTS;
  return fee > cap ? cap : fee;
}

/**
 * The compute-unit price (micro-lamports) for the bot's own small transactions - withdrawals and
 * token-account closes: recent fees for the accounts they write (75th percentile), at least
 * UTILITY_MIN_PRICE (an uncontended wallet's recent minimum is usually zero, which lands slowly),
 * doubled for each earlier send that never landed, and never more than UTILITY_MAX_FEE_LAMPORTS
 * in total for `units` compute units.
 */
async function utilityPrice(
  ctx: PassContext,
  accounts: string[],
  units: number,
  tries: number,
): Promise<bigint> {
  const estimate = (await ctx.deps.rpc.getPriorityFeeEstimate(accounts)) ?? 0n;
  let price = estimate > UTILITY_MIN_PRICE ? estimate : UTILITY_MIN_PRICE;
  price *= 2n ** BigInt(Math.min(Math.max(tries, 0), 8));
  const cap = (UTILITY_MAX_FEE_LAMPORTS * 1_000_000n) / BigInt(units);
  return price > cap ? cap : price;
}

/** A retry's route would deliver less than the first try's quote, less the slippage: the price ran. */
class PriceMovedError extends Error {}

/**
 * A floor for a trade the fallback route built without a quote: what the Price API says it's
 * worth, less the slippage and another tenth (the pool's price is not the index's). Buy: raw
 * tokens; sell: lamports. The lowest acceptable (1 token, 0 lamports) when there is no price -
 * the external-transfer cap still bounds what a hostile build could take.
 */
async function fallbackFloor(ctx: PassContext, req: SwapRequest): Promise<bigint> {
  const none = req.side === "buy" ? 1n : 0n;
  let prices: Map<string, number>;
  try {
    prices = await ctx.deps.swap.pricesUsd([req.mint, WSOL_MINT]);
  } catch {
    return none;
  }
  const tokenUsd = prices.get(req.mint);
  const solUsd = prices.get(WSOL_MINT);
  if (!tokenUsd || !solUsd) return none;
  // Pump.fun tokens (the only ones the fallback trades) have 6 decimals.
  const lamportsPerRaw = ((tokenUsd / solUsd) * 1e9) / 10 ** (req.decimals ?? 6);
  if (!(lamportsPerRaw > 0)) return none;
  const keep = Math.max(0, 1 - req.slippageBps / 10_000) * 0.9;
  const fair = req.side === "buy" ? Number(req.amount) / lamportsPerRaw : Number(req.amount) * lamportsPerRaw;
  const floor = BigInt(Math.floor(fair * keep));
  return floor > none ? floor : none;
}

/** Builds the swap on Jupiter, else (a Pump.fun token) PumpPortal, with what the guard must see. */
async function buildSwap(ctx: PassContext, wallet: Wallet, req: SwapRequest): Promise<BuiltSwap> {
  const buy = req.side === "buy";
  const tradeLamports = buy ? req.amount : (req.valueHintLamports ?? 0n);
  const limits = {
    maxExternalLamports: externalAllowance(tradeLamports),
    maxPriorityFeeLamports: req.maxPriorityFeeLamports,
  };
  const maxSolDrop =
    req.amount + req.maxPriorityFeeLamports + BUY_MARGIN_LAMPORTS + limits.maxExternalLamports;
  const feeAllowance = req.maxPriorityFeeLamports + SELL_FEE_ALLOWANCE_LAMPORTS + limits.maxExternalLamports;
  try {
    const quote = await ctx.deps.swap.quote({
      inputMint: buy ? WSOL_MINT : req.mint,
      outputMint: buy ? req.mint : WSOL_MINT,
      amount: req.amount,
      slippageBps: req.slippageBps,
    });
    if (req.minQuotedOut !== undefined && BigInt(quote.outAmount) < req.minQuotedOut) {
      throw new PriceMovedError(
        `the price ran: ${quote.outAmount} tokens quoted now, under ${req.minQuotedOut} (the first try's quote less the slippage)`,
      );
    }
    const built = await ctx.deps.swap.swapTransaction({
      quote,
      userPublicKey: wallet.publicKey,
      maxPriorityFeeLamports: Number(req.maxPriorityFeeLamports),
      priorityFeeLamports:
        req.priorityFeeLamports !== undefined ? Number(req.priorityFeeLamports) : undefined,
    });
    const minOut = BigInt(quote.otherAmountThreshold);
    return {
      ...built,
      route: "jupiter",
      quotedOut: quote.outAmount,
      expect: buy
        ? { kind: "buy", mint: req.mint, minOut, maxSolDrop, ...limits }
        : { kind: "sell", mint: req.mint, amount: req.amount, minSolOut: minOut, feeAllowance, ...limits },
    };
  } catch (err) {
    const fallback = ctx.deps.fallback;
    if (!fallback || !fallback.handles(req.mint) || err instanceof PriceMovedError) throw err;
    logger.info("jupiter could not build the swap; trying the fallback route", {
      mint: req.mint,
      side: req.side,
      error: errText(err),
    });
    const [built, quotedFloor] = await Promise.all([
      fallback.build({
        side: req.side,
        mint: req.mint,
        wallet: wallet.publicKey,
        amount: req.amount,
        decimals: req.decimals,
        slippageBps: req.slippageBps,
        maxPriorityFeeLamports: Number(req.maxPriorityFeeLamports),
        priorityFeeLamports:
          req.priorityFeeLamports !== undefined ? Number(req.priorityFeeLamports) : undefined,
      }),
      fallbackFloor(ctx, req),
    ]);
    // A retry's floor is never under the first try's quote less the slippage (no chasing).
    const floor =
      req.minQuotedOut !== undefined && quotedFloor < req.minQuotedOut ? req.minQuotedOut : quotedFloor;
    return {
      ...built,
      route: "pumpportal",
      quotedOut: floor.toString(),
      expect: buy
        ? { kind: "buy", mint: req.mint, minOut: floor, maxSolDrop, ...limits }
        : { kind: "sell", mint: req.mint, amount: req.amount, minSolOut: floor, feeAllowance, ...limits },
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
  if (!ctx.inBudget()) throw new TransientError("pass time budget spent; next pass");
  const built = await buildSwap(ctx, wallet, req);
  const totals = await guardSwapTransaction(ctx.deps.rpc, built.transaction, wallet.publicKey, built.expect);
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
      // What this try pays to land: a retry after it never landed doubles it (feeForRetry).
      priorityFeeLamports: totals.priorityFeeLamports,
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

/**
 * Ends an entry that didn't fill as recorded - unless the wallet holds the token anyway (a buy
 * that landed although its status said otherwise), in which case the position opens from the
 * real balance rather than leaving tokens no exit will ever manage. With `retry`, an entry
 * whose send expired unlanded stays "buying" for the retry stage (retryEntries) to try again or
 * give up on, instead of failing here.
 */
async function endEntry(
  ctx: PassContext,
  position: PositionRow,
  order: { id: string; createdAt: Date; confirmedOnChain: boolean } | null,
  why: string,
  retry = false,
) {
  const orderId = order?.id ?? null;
  const wallet = await ctx.walletFor(position.userId);
  const held = wallet ? await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint) : null;
  if (held === null && wallet) return; // can't tell yet; next pass
  const at = ctx.now();
  // A buy the chain CONFIRMED is never written off on one zero balance: a lagging node can read
  // the wallet from before it. Read again on later passes, for a while, before giving up.
  if (
    order?.confirmedOnChain &&
    (!held || held.raw === 0n) &&
    at.getTime() - order.createdAt.getTime() < CONFIRMED_BALANCE_WAIT_MS
  )
    return;
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
          failCount: 0,
          nextAttemptAt: null,
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
      data: retry
        ? { failCount: { increment: 1 }, nextAttemptAt: at, error: why }
        : { status: "failed", error: why, closedAt: at },
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
        await endEntry(
          ctx,
          order.position,
          { id: order.id, createdAt: order.createdAt, confirmedOnChain: false },
          "the buy expired without landing",
          true,
        );
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
      // Failed on chain: nothing was bought. The retry stage tries again while the signal is
      // fresh and the price hasn't run (retryEntries), or gives up.
      await tx.tradingPosition.updateMany({
        where: { id: order.positionId, status: "buying" },
        data: {
          error,
          failCount: { increment: 1 },
          nextAttemptAt: new Date(at.getTime() + ENTRY_RETRY_MS),
          proceedsLamports: { increment: fee ?? 0n },
        },
      });
    } else {
      await tx.tradingPosition.update({
        where: { id: order.positionId },
        data: {
          error,
          proceedsLamports: { increment: fee ?? 0n },
          ...failureBackoff(order.position, at, order.reason !== "take_profit"),
          // Failing on chain again and again: it no longer holds an open slot.
          ...(order.position.status === "open" && order.position.failCount + 1 >= STUCK_AFTER_FAILURES
            ? { status: "stuck" }
            : {}),
        },
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
              failCount: 0,
              nextAttemptAt: null,
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
  // The chain can only lower what the fill says is left: a lagging node reading the balance from
  // before the sale must not undo it (and get the same rung sold twice).
  let held = BigInt(position.tokensHeld) - sold;
  if (chain && chain.raw < held) held = chain.raw;
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
    await endEntry(
      ctx,
      order.position,
      { id: order.id, createdAt: order.createdAt, confirmedOnChain: true },
      "confirmed, but its details could not be read",
    );
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

const recoveryCheckedAt = new Map<string, number>();

/**
 * The backstop for every place a balance read can lag: failed buys (that had a transaction) and
 * closed positions from the last two hours are re-checked every few minutes, and one whose token
 * is in the wallet after all (more than dust) is reopened, so no tokens sit unmanaged.
 */
async function recoverPositions(ctx: PassContext): Promise<void> {
  const now = ctx.now().getTime();
  const since = new Date(now - RECOVERY_LOOKBACK_MS);
  const rows = await prisma.tradingPosition.findMany({
    where: {
      // Past the window a lagging node could still show the balance from before the sale.
      closedAt: { gt: since, lt: new Date(now - RECOVERY_SETTLE_MS) },
      OR: [{ status: "failed", orders: { some: {} } }, { status: "closed" }],
    },
    orderBy: { closedAt: "desc" },
    take: 50,
  });
  for (const row of rows) {
    if (!ctx.inBudget()) return;
    if ((recoveryCheckedAt.get(row.id) ?? 0) > now - RECOVERY_RECHECK_MS) continue;
    recoveryCheckedAt.set(row.id, now);
    const wallet = await ctx.walletFor(row.userId);
    if (!wallet) continue;
    const held = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, row.mint);
    if (!held || held.raw === 0n) continue;
    const bought = BigInt(row.tokensBought ?? "0");
    if (bought > 0n && held.raw * 1000n < bought) continue; // dust left by a sale
    const reopened = await prisma.tradingPosition.updateMany({
      where: { id: row.id, status: row.status },
      data: {
        status: "open",
        tokensHeld: held.raw.toString(),
        tokensBought: row.tokensBought ?? held.raw.toString(),
        decimals: row.decimals ?? held.decimals,
        entryLamports: row.entryLamports ?? row.swapInLamports,
        openedAt: row.openedAt ?? ctx.now(),
        closedAt: null,
        closeReason: null,
        accountClosedAt: null,
        failCount: 0,
        nextAttemptAt: null,
        error: `reopened: ${held.raw} tokens found in the wallet after it was ${row.status}`,
      },
    });
    if (reopened.count === 1) {
      ctx.summary.recovered++;
      logger.warn("position reopened: tokens found in the wallet", { positionId: row.id, was: row.status });
    }
  }
  if (recoveryCheckedAt.size > 5_000) recoveryCheckedAt.clear();
}

/**
 * The next attempt's time after one more failure: exponential up to 10 minutes - or, for a
 * protective exit (stop, trail, time, manual) that failed on chain, a quick retry (each with
 * more slippage, see manageExit) while there are tries left. Past GIVE_UP_AFTER_FAILURES the
 * position is retried only every few hours, so a sale that can never succeed stops paying fees.
 */
function failureBackoff(position: Pick<PositionRow, "failCount">, at: Date, protective = false) {
  const failCount = position.failCount + 1;
  let wait = Math.min(MAX_BACKOFF_MS, 5_000 * 3 ** (failCount - 1));
  if (protective && failCount < STUCK_AFTER_FAILURES) wait = Math.min(wait, PROTECTIVE_RETRY_MS);
  if (failCount >= GIVE_UP_AFTER_FAILURES) wait = GIVEN_UP_RETRY_MS;
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
        // It can no longer land: send it again with a higher fee (sendWithdrawals), a few times.
        data =
          w.attempts + 1 < MAX_WITHDRAWAL_SENDS
            ? {
                status: "requested",
                attempts: { increment: 1 },
                signature: null,
                rawTx: null,
                lastValidBlockHeight: null,
                error: `send ${w.attempts + 1} expired without landing (${w.signature}); sending again with a higher fee`,
              }
            : {
                status: "failed",
                error: `the transaction expired without landing, ${w.attempts + 1} times`,
                settledAt: ctx.now(),
              };
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
  /** The transaction's priority fee, on top of the base fee. */
  priorityFeeLamports = 0n,
): { lamports: bigint } | { error: string } {
  const fees = TX_FEE_LAMPORTS + priorityFeeLamports;
  const spendable = balance - fees - keep;
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
  const left = balance - fees - requested;
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
      // A custodial wallet's destination is the address sealed into its key (opening it below
      // proves the row wasn't altered), and it must still be the owner's sign-in wallet. The
      // server wallet's is the configured one, from this process's environment.
      const destination = wallet?.withdrawTo ?? null;
      const ownerMatches = wallet?.row ? destination === user?.walletAddress : true;
      if (!wallet || !user || !destination || !ownerMatches || w.destination !== destination) {
        await fail(
          wallet && !wallet.row && !destination
            ? "server wallet withdrawals are off (TRADING_SERVER_WALLET_WITHDRAW_TO is not set on the trader)"
            : "destination is not this wallet's withdrawal address",
        );
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
      const price = await utilityPrice(ctx, [wallet.publicKey], TRANSFER_COMPUTE_UNITS, w.attempts);
      const amount = withdrawalAmount(
        balance,
        w.requestedLamports,
        keep,
        priorityFeeOf(TRANSFER_COMPUTE_UNITS, price),
      );
      if ("error" in amount) {
        await fail(amount.error);
        continue;
      }
      const unsigned = buildSolTransfer({
        from: wallet.publicKey,
        to: destination,
        lamports: amount.lamports,
        recentBlockhash: blockhash.blockhash,
        microLamportsPerUnit: price,
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
  let solUsd = prices.get(WSOL_MINT);
  if (!solUsd) {
    // One SOL->USDC quote stands in for the Price API's SOL price, rather than a quote per position.
    try {
      const q = await ctx.deps.swap.quote({
        inputMint: WSOL_MINT,
        outputMint: USDC_MINT,
        amount: 1_000_000_000n,
        slippageBps: 100,
      });
      const usd = Number(q.outAmount) / 1e6;
      if (usd > 0) solUsd = usd;
    } catch {
      /* priced per position below, by quote */
    }
  }
  let unmanaged = 0;
  for (const position of due) {
    if (!ctx.inBudget()) return;
    ctx.summary.exitsChecked++;
    if (!(await ctx.walletFor(position.userId))) {
      // No key to sign with (KMS not configured, or the server key missing): nothing can sell it.
      unmanaged++;
      await prisma.tradingPosition
        .update({
          where: { id: position.id },
          data: { error: "no key available to manage this position (check the trader's key settings)" },
        })
        .catch(() => undefined);
      continue;
    }
    try {
      await manageExit(ctx, position, prices.get(position.mint), solUsd);
    } catch (err) {
      ctx.summary.errors++;
      await recordExitFailure(ctx, position, err);
    }
  }
  if (unmanaged > 0) throw new Error(`${unmanaged} open position(s) have no key to sell with`);
}

/** The position couldn't be priced this pass (no index price, no quote): not a failed sale. */
class PricingError extends Error {}

/** The hold cap that applies to a position now: the trail's once something has sold. */
function holdCapMinutes(position: Pick<PositionRow, "rungsTaken">, plan: ExitPlan): number {
  return position.rungsTaken > 0 && plan.trail.length > 0 ? plan.trailMaxHoldMinutes : plan.maxHoldMinutes;
}

/**
 * An exit that couldn't be priced or sold. Not being able to PRICE it, being rate limited, or a
 * dependency not answering (TransientError) just retries shortly - it says nothing about whether
 * it can be sold, and the hold caps still close it on time; only a position that has failed
 * that way for half an hour past its hold cap is called stuck (so it frees its slot). A failed
 * SALE backs off, and once the position plainly can't be sold (no
 * route, or failing well past its hold time) it is called stuck so it stops holding an open
 * slot. Stuck positions keep following their plan, retried at most every 10 minutes.
 */
async function recordExitFailure(ctx: PassContext, position: PositionRow, err: unknown) {
  const at = ctx.now();
  const plan = readExitPlan(position.exitPlan);
  const ageMinutes = position.openedAt ? (at.getTime() - position.openedAt.getTime()) / 60_000 : 0;
  if (err instanceof PricingError || err instanceof RateLimitedError || err instanceof TransientError) {
    const wait = err instanceof RateLimitedError ? 30_000 : err instanceof PricingError ? 15_000 : 5_000;
    const stuck =
      position.status === "open" &&
      ageMinutes > holdCapMinutes(position, plan) + TRANSIENT_STUCK_AFTER_MINUTES;
    await prisma.tradingPosition
      .update({
        where: { id: position.id },
        data: {
          error: errText(err),
          nextAttemptAt: new Date(at.getTime() + wait),
          ...(stuck ? { status: "stuck" } : {}),
        },
      })
      .catch(() => undefined);
    if (stuck) ctx.summary.stuck++;
    return;
  }
  const backoff = failureBackoff(position, at);
  const noRoute = err instanceof NoRouteError;
  const stuck =
    position.status === "open" &&
    ((noRoute && backoff.failCount >= 3) ||
      (backoff.failCount >= STUCK_AFTER_FAILURES && ageMinutes > holdCapMinutes(position, plan)));
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
  let multiple: number | null = null;
  if (position.closeRequested) {
    // The owner asked: sell everything, no price needed (a failing price lookup must never block it).
    decision = { all: true, fraction: 1, reason: "manual" };
  } else {
    multiple = positionMultiple(position, tokenUsd, solUsd);
    if (multiple === null) {
      try {
        multiple = await quotedMultiple(ctx, position, held, bought);
      } catch (err) {
        if (err instanceof RateLimitedError) throw err;
        multiple = null;
      }
    }
    if (multiple === null) {
      // No price at all: the plan's price rules can't run, but its clock still can.
      const ageMinutes = (now.getTime() - position.openedAt.getTime()) / 60_000;
      if (ageMinutes < holdCapMinutes(position, plan))
        throw new PricingError("no price for the token right now");
      decision = { all: true, fraction: 1, reason: position.rungsTaken > 0 ? "trail_max_hold" : "max_hold" };
    } else {
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
  }

  // A full exit sells what the chain says is held, not what the books say.
  let amount = sellAmount(decision, bought, held);
  if (decision.all) {
    const chain = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint);
    if (!chain) throw new TransientError("could not read the token balance");
    amount = chain.raw;
    if (amount === 0n) {
      // The books say tokens are held: read again before believing a zero (a lagging node).
      const again = await ctx.deps.rpc.getTokenBalance(wallet.publicKey, position.mint);
      if (!again) throw new TransientError("could not read the token balance");
      amount = again.raw;
    }
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
  // Each failed attempt at a protective exit widens it by 5 points, up to 50%.
  const slippageBps =
    decision.reason === "take_profit" && position.failCount < TAKE_PROFIT_TIGHT_ATTEMPTS
      ? configured
      : Math.min(5_000, exitSlippage + 500 * Math.min(position.failCount, 4));
  // What the tokens being sold are worth: by the price when there is one, else by their cost.
  const costOfAmount =
    position.swapInLamports && bought > 0n ? (position.swapInLamports * amount) / bought : 0n;
  const valueHintLamports =
    multiple !== null ? BigInt(Math.floor(Number(costOfAmount) * multiple)) : costOfAmount;
  // The last sale sent for this position: if it never landed, this one pays more to.
  const lastSale = await prisma.tradingOrder.findFirst({
    where: { positionId: position.id, side: "sell" },
    orderBy: { createdAt: "desc" },
    select: { status: true, priorityFeeLamports: true },
  });
  const maxFee = priorityFee(ctx, config);
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
      maxPriorityFeeLamports: maxFee,
      priorityFeeLamports: feeForRetry(maxFee, lastSale),
      valueHintLamports,
    },
  );
  ctx.summary.sells++;
  logger.info("exit sent", {
    positionId: position.id,
    mint: position.mint,
    reason: decision.reason,
    multiple: multiple !== null ? Number(multiple.toFixed(3)) : null,
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
  /** Whose matches: the bot's owner, or null for the server bot (its filters are admins'). */
  userId: string | null,
  config: TradingBotConfig,
  from: Date,
  to: Date,
  configSavedAt: Date = new Date(8.64e15),
): Promise<{ signals: TradeSignal[]; through: Date }> {
  const { filterIds, models, highConvictionOnly } = config.sources;
  const [matches, calls] = await Promise.all([
    filterIds.length === 0
      ? []
      : prisma.match.findMany({
          where: {
            ...(userId !== null ? { userId } : {}),
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
  // A source that filled its page may have more: read only up to its last row this time, and the
  // rest next pass, instead of skipping past it.
  let through = to;
  for (const page of [matches.map((m) => m.matchedAt), calls.map((c) => c.createdAt)]) {
    if (page.length === MAX_SIGNALS_PER_PASS && page[page.length - 1]! < through)
      through = page[page.length - 1]!;
  }
  const inWindow = signals.filter((s) => s.at <= through).sort((a, b) => a.at.getTime() - b.at.getTime());
  const seen = new Set<string>();
  return {
    signals: inWindow.filter((s) => (seen.has(s.mint) ? false : (seen.add(s.mint), true))),
    through,
  };
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
        AND backend_type = 'client backend' AND state <> 'idle'
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
    const isServer = bot.userId === ctx.deps.serverWallet?.userId;
    if (!isServer && !ctx.deps.canTrade(bot.user.walletAddress)) continue;
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
  // The server bot follows admins' filters: only those whose owner is still an admin count.
  let sourceConfig = config;
  const isServer = bot.userId === ctx.deps.serverWallet?.userId;
  if (isServer && config.sources.filterIds.length > 0) {
    const owners = await prisma.userFilter.findMany({
      where: { id: { in: config.sources.filterIds } },
      select: { id: true, user: { select: { walletAddress: true } } },
    });
    const allowed = owners.filter((f) => ctx.deps.canTrade(f.user.walletAddress)).map((f) => f.id);
    sourceConfig = { ...config, sources: { ...config.sources, filterIds: allowed } };
  }
  const { signals, through } = await loadSignals(
    isServer ? null : bot.userId,
    sourceConfig,
    bot.signalsFrom,
    horizon,
    bot.configSavedAt,
  );
  // The window is consumed whatever happens to its signals: a skipped signal is never bought later.
  await prisma.tradingBot.update({ where: { id: bot.id }, data: { signalsFrom: through } });
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
          // Not the retry stage's until this try has had time to record its order (a pass that
          // outlived its lock may still be sending it).
          nextAttemptAt: new Date(now.getTime() + ORPHAN_ENTRY_MS),
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
    if (await attemptEntry(ctx, wallet, position, { slippageBps, maxFee: priorityFee(ctx, config) })) {
      logger.info("entry sent", { userId: bot.userId, mint: signal.mint, source: signal.label });
    }
  }
}

/**
 * One try at an entry: build, guard, sign, record, send (executeSwap). True when it was sent;
 * whether it lands is for settling. Otherwise the position says why: failed, when the token
 * can't be bought (a guard refusal, no route, the price ran); or still "buying" with a short
 * wait, when something merely didn't answer - for the retry stage to try again.
 */
async function attemptEntry(
  ctx: PassContext,
  wallet: Wallet,
  position: PositionRow,
  opts: { slippageBps: number; maxFee: bigint; exactFee?: bigint; minQuotedOut?: bigint },
): Promise<boolean> {
  try {
    await executeSwap(
      ctx,
      wallet,
      position,
      { reason: "entry", rung: null },
      {
        side: "buy",
        mint: position.mint,
        amount: position.swapInLamports ?? 0n,
        decimals: null,
        slippageBps: opts.slippageBps,
        maxPriorityFeeLamports: opts.maxFee,
        priorityFeeLamports: opts.exactFee,
        minQuotedOut: opts.minQuotedOut,
      },
    );
    ctx.summary.buys++;
    return true;
  } catch (err) {
    const at = ctx.now();
    const final =
      err instanceof GuardRefusal || err instanceof NoRouteError || err instanceof PriceMovedError;
    if (final) {
      await prisma.tradingPosition.updateMany({
        where: { id: position.id, status: "buying", orders: { none: { status: "pending" } } },
        data: { status: "failed", error: errText(err), closedAt: at },
      });
    } else {
      ctx.summary.errors++;
      const wait = err instanceof RateLimitedError ? 15_000 : ENTRY_RETRY_MS;
      await prisma.tradingPosition.updateMany({
        where: { id: position.id, status: "buying" },
        data: {
          error: errText(err),
          failCount: { increment: 1 },
          nextAttemptAt: new Date(at.getTime() + wait),
        },
      });
    }
    logger.warn("entry not sent", { mint: position.mint, final, error: errText(err) });
    return false;
  }
}

/**
 * Entries whose last try didn't fill - it failed before sending, expired without landing, or
 * failed on chain - and that aren't waiting on a send: tried again, or given up. A retry needs
 * the bot still on and its owner still allowed to trade, fewer than MAX_ENTRY_TRIES failed tries,
 * and the signal no older than its age limit plus ENTRY_RETRY_GRACE_MS; it re-reads the wallet
 * first (an earlier try that landed after all is recovered, never bought twice), pays double the
 * fee of a try that never landed, and refuses a price more than the slippage past the first
 * try's quote. Given up: deleted when nothing was ever sent (a later signal may buy the token),
 * else failed - unless its tokens are in the wallet (recovered).
 */
async function retryEntries(ctx: PassContext): Promise<void> {
  const now = ctx.now();
  const due = await prisma.tradingPosition.findMany({
    where: {
      status: "buying",
      orders: { none: { status: "pending" } },
      OR: [
        { nextAttemptAt: { lte: now } },
        // Created before entries were scheduled: due once surely past its first try.
        { nextAttemptAt: null, createdAt: { lt: new Date(now.getTime() - ORPHAN_ENTRY_MS) } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  for (const position of due) {
    if (!ctx.inBudget()) return;
    try {
      await retryEntry(ctx, position, now);
    } catch (err) {
      ctx.summary.errors++;
      logger.warn("could not retry an entry", { positionId: position.id, error: errText(err) });
    }
  }
}

async function retryEntry(ctx: PassContext, position: PositionRow, now: Date) {
  const [wallet, orders, bot] = await Promise.all([
    ctx.walletFor(position.userId),
    prisma.tradingOrder.findMany({
      where: { positionId: position.id, side: "buy" },
      orderBy: { createdAt: "asc" },
      select: { status: true, route: true, quotedOut: true, priorityFeeLamports: true },
    }),
    prisma.tradingBot.findUnique({
      where: { userId: position.userId },
      include: { user: { select: { walletAddress: true } } },
    }),
  ]);
  const config = readTradingBotConfig(bot?.config);
  const isServer = position.userId === ctx.deps.serverWallet?.userId;
  const signalAge = now.getTime() - position.signalAt.getTime();
  let why: string | null = null;
  if (!wallet) why = "no key available to buy with";
  else if (!bot?.enabled) why = "the bot was switched off before the entry filled";
  else if (!isServer && !ctx.deps.canTrade(bot.user.walletAddress)) why = "the owner may no longer trade";
  else if (position.failCount >= MAX_ENTRY_TRIES) why = `the entry failed ${position.failCount} times`;
  else if (signalAge > config.maxSignalAgeSeconds * 1000 + ENTRY_RETRY_GRACE_MS)
    why = "the signal went stale before an entry filled";
  if (why) {
    if (orders.length === 0) {
      // Never sent: nothing can have been bought. Gone, so a later signal can still buy it.
      await prisma.tradingPosition.deleteMany({
        where: { id: position.id, status: "buying", orders: { none: {} } },
      });
      logger.info("entry given up", { positionId: position.id, mint: position.mint, why });
    } else {
      await endEntry(ctx, position, null, `${why}: ${position.error ?? "no fill"}`.slice(0, 500));
    }
    ctx.summary.settled++;
    return;
  }
  if (orders.length > 0) {
    // An earlier try was sent: make sure it didn't land after all before buying again.
    const held = await ctx.deps.rpc.getTokenBalance(wallet!.publicKey, position.mint);
    if (!held) return; // can't tell; next pass
    if (held.raw > 0n) {
      await endEntry(ctx, position, null, "an earlier try landed after all");
      return;
    }
  }
  const slippageBps = Math.min(config.slippageBps, ctx.deps.maxSlippageBps ?? config.slippageBps);
  const first = orders.find((o) => o.route === "jupiter");
  const maxFee = priorityFee(ctx, config);
  const sent = await attemptEntry(ctx, wallet!, position, {
    slippageBps,
    maxFee,
    exactFee: feeForRetry(maxFee, orders[orders.length - 1] ?? null),
    minQuotedOut: first ? (BigInt(first.quotedOut) * BigInt(10_000 - slippageBps)) / 10_000n : undefined,
  });
  if (sent) {
    logger.info("entry retried", {
      positionId: position.id,
      mint: position.mint,
      tries: position.failCount + 1,
    });
  }
}

/** Token-2022 extensions a Pump.fun-style token carries and that can't hurt a holder. */
const HARMLESS_MINT_EXTENSIONS = new Set([
  "metadataPointer",
  "tokenMetadata",
  "groupPointer",
  "groupMemberPointer",
  "tokenGroup",
  "tokenGroupMember",
]);

/**
 * Why a mint is not safe to hold, or null. Refused: a live mint authority (supply can be printed
 * out from under the position) or freeze authority (the position can be frozen unsellable), and
 * any Token-2022 extension beyond metadata - a permanent delegate can take the tokens, a transfer
 * hook or pausable config can block the sale, a transfer fee takes a cut of it.
 */
export function mintRisk(mint: MintInfo): string | null {
  if (!TOKEN_PROGRAM_IDS.has(mint.program)) return "not a token mint";
  if (mint.mintAuthority) return "mint authority not revoked";
  if (mint.freezeAuthority) return "freeze authority not revoked";
  const risky = mint.extensions.filter((e) => !HARMLESS_MINT_EXTENSIONS.has(e));
  if (risky.length > 0) return `risky token extensions: ${risky.join(", ")}`;
  return null;
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
  const mint = await ctx.deps.rpc.getMintInfo(signal.mint);
  if (!mint) return "mint unreadable";
  const risk = mintRisk(mint);
  if (risk) return risk;
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

const TOKEN_PROGRAM_IDS = new Set<string>([PROGRAM.token, PROGRAM.token2022]);
const closeSentAt = new Map<string, number>();
/** A close that was sent is not sent again for this long (it lands or its blockhash expires). */
const CLOSE_RESEND_MS = 3 * 60_000;

/** Closes the emptied token accounts of sold-out positions: ~0.002 SOL back per trade. */
async function reclaimRent(ctx: PassContext): Promise<void> {
  const now = ctx.now();
  const closed = await prisma.tradingPosition.findMany({
    where: {
      status: "closed",
      accountClosedAt: null,
      closedAt: { lt: new Date(now.getTime() - RENT_RECLAIM_DELAY_MS) },
    },
    orderBy: { closedAt: "asc" },
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
    const price = await utilityPrice(
      ctx,
      [wallet.publicKey, ...empty.map((a) => a.address)],
      CLOSE_COMPUTE_UNITS,
      0,
    );
    for (const account of empty) {
      // Only ever a close by a real token program of an empty account the wallet owns: the
      // program comes from the RPC's listing, and this transaction is not checked by the guard.
      if (!TOKEN_PROGRAM_IDS.has(account.programId)) continue;
      const lastSent = closeSentAt.get(account.address) ?? 0;
      if (Date.now() - lastSent < CLOSE_RESEND_MS) continue;
      const [state] = (await ctx.deps.rpc.getParsedAccounts([account.address])) ?? [];
      if (
        !state ||
        !TOKEN_PROGRAM_IDS.has(state.owner) ||
        state.owner !== account.programId ||
        state.token?.owner !== wallet.publicKey ||
        state.token.amount !== 0n
      )
        continue;
      try {
        const build = (microLamportsPerUnit: bigint) =>
          buildCloseTokenAccount({
            owner: wallet.publicKey,
            account: account.address,
            tokenProgram: account.programId,
            recentBlockhash: blockhash.blockhash,
            microLamportsPerUnit,
          });
        const simulate = (tx: Uint8Array) =>
          ctx.deps.rpc.simulateParsed(Buffer.from(tx).toString("base64"), [wallet.publicKey]);
        let unsigned = build(price);
        let sim = await simulate(unsigned);
        if (sim?.error) {
          // Not with a priority fee (its unit limit too tight for this account, say): plain.
          unsigned = build(0n);
          sim = await simulate(unsigned);
        }
        if (!sim) continue;
        if (sim.error) {
          // This account can't be closed (Token-2022 withheld fees, say): stop trying, so it
          // doesn't hold up the others.
          await prisma.tradingPosition.update({
            where: { id: position.id },
            data: { accountClosedAt: now, error: `token account not closed: ${sim.error}`.slice(0, 500) },
          });
          break;
        }
        const { rawTx } = await sign(ctx, wallet, unsigned);
        // Not tracked as an order: if it doesn't land, the account is still there later - and it is
        // not sent again for a while, so a lagging read can't make it pay a fee per pass.
        closeSentAt.set(account.address, Date.now());
        if (closeSentAt.size > 5_000) closeSentAt.clear();
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
