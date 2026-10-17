import {
  prisma,
  createLogger,
  HttpError,
  Prisma,
  keepWalletRow,
  walletTrades,
  orderTrades,
  pumpFunCursorBefore,
  stopCauseOf,
  summarizeTape,
  tradesFromChainTransactionsPriced,
  TAPE_WINDOW_AFTER_ANCHOR_MS,
  type HeliusClient,
  type PumpFunClient,
  type SolPriceLookup,
  type TapeTrade,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";
import {
  resetClosingState,
  runClosingLane,
  type ClosingCounts,
  type ClosingHelius,
  type MarketCapLookup,
} from "./tradeTapeClosing.js";

const logger = createLogger("trade-tape");

/**
 * The trade tape of called coins (brief: notes/hit-catch-2026-10-13/wallet-risk-brief.md, part 1).
 *
 * For every coin a seat called, and a sample of uncalled decision moments for comparison, this
 * reads every trade from the launch to 30 minutes past the call once the call's row is final, and
 * stores what each wallet did in the coin (TokenWalletActivity) and, for each stopped call, who
 * sold between the call and the stop (CandidateOutcome.stopCause). It runs on the scanner worker,
 * the service that holds the Helius key (on the trainer, which has none, it fell back to Pump.fun
 * alone and the backlog never drained), behind the scan: no decision waits on it.
 *
 * Two sources, each its own lane, run side by side:
 *  - Helius getTransactionsForAddress on the mint, oldest first (10 credits a page of 100), the
 *    main source (user decision 2026-10-13, over the cost below): every coin, newest call first, so
 *    new calls are read within minutes and the backlog with what is left.
 *    TRADE_TAPE_HELIUS_PAGES_PER_RUN caps the pages a one-minute run. A full read
 *    averages 20+ pages a coin (2026-10-13 sample of 26 called coins: median ~700 trades, a quarter
 *    over 4,000), so at ~600 called coins a day this is ~125k+ credits a day. A coin past
 *    HELIUS_MAX_PAGES_PER_COIN is left to Pump.fun.
 *  - Pump.fun's trade API, free but quick to answer 429: read backwards from the end of the window
 *    (a cursor at a timestamp skips everything after it), spaced calls a run
 *    (TRADE_TAPE_PUMPFUN_CALLS_PER_RUN), paused for a minute on a 429. Coins Helius couldn't read,
 *    the oldest of the backlog (working from the other end), and one coin in SAMPLE_EVERY from the
 *    uncalled sample. Without Helius it takes every coin.
 * Each lane works one coin at a time and carries it over to the next run until it's read.
 */

/** Called coins this far back are read (the backlog goes to Pump.fun). */
const LOOKBACK_MS = 10 * 24 * 3_600_000;
/** Calls within this long of a coin's first call share its tape (and get a stop cause from it). */
const SHARED_CALL_SPAN_MS = 2 * 3_600_000;
/** A window is read this long after it closes, so the indexers have the last trades. */
const SETTLE_MS = 2 * 60_000;
/** 10,000 transactions, 1,000 credits: past it a coin is left to Pump.fun. */
export const HELIUS_MAX_PAGES_PER_COIN = 100;
/** Pump.fun calls on one coin before it is stored as partial (6,000 trades). */
const PUMPFUN_MAX_CALLS_PER_COIN = 60;
const PUMPFUN_SPACING_MS = 12_000;
const PUMPFUN_PAUSE_ON_429_MS = 60_000;
/** Of every this many coins the Pump.fun lane starts, one is an uncalled sample. */
const SAMPLE_EVERY = 4;
const RETRY_FAILED_MS = 30 * 60_000;
const RETRY_UNKNOWN_COIN_MS = 24 * 3_600_000;

export interface TapeCoin {
  tokenId: string;
  mint: string;
  reason: "called" | "sample";
  /** The reference row: roles at its anchor; and every row the tape gives a stop cause. */
  refOutcomeId: string;
  anchorAtMs: number;
  outcomeIds: string[];
  windowEndMs: number;
  /** The source whose read failed last time, when one did. */
  failedSource?: string | null;
}

interface Progress {
  coin: TapeCoin;
  trades: TapeTrade[];
  calls: number;
  cursor: string | undefined;
  errors: number;
  launch: { atMs: number | null; creator: string | null } | null;
  /** Helius: whether the first page was read (it holds the launch). */
  started: boolean;
}

interface LaneState {
  helius: Progress | null;
  pumpFun: Progress | null;
  pumpFunPausedUntil: number;
  coinsStarted: number;
}

const state: LaneState = {
  helius: null,
  pumpFun: null,
  pumpFunPausedUntil: 0,
  coinsStarted: 0,
};

/** Test hook. */
export function resetTradeTapeState(): void {
  state.helius = null;
  state.pumpFun = null;
  state.pumpFunPausedUntil = 0;
  state.coinsStarted = 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Called coins whose window has closed and whose tape isn't read, newest first. */
export async function pendingCalledCoins(nowMs: number): Promise<TapeCoin[]> {
  const alerts = await prisma.curatedAlert.findMany({
    where: {
      createdAt: { gte: new Date(nowMs - LOOKBACK_MS) },
      candidateOutcomeId: { not: null },
      token: {
        OR: [
          { tradeTape: { is: null } },
          { tradeTape: { is: { status: "failed", retryAt: { lte: new Date(nowMs) } } } },
        ],
      },
    },
    select: {
      tokenId: true,
      token: { select: { mintAddress: true, tradeTape: { select: { source: true } } } },
      candidateOutcome: { select: { id: true, anchorAt: true, finalizedAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 3_000,
  });
  const byToken = new Map<
    string,
    { mint: string; failedSource: string | null; rows: { id: string; anchorAtMs: number; final: boolean }[] }
  >();
  for (const a of alerts) {
    if (!a.candidateOutcome) continue;
    const entry = byToken.get(a.tokenId) ?? {
      mint: a.token.mintAddress,
      failedSource: a.token.tradeTape?.source ?? null,
      rows: [],
    };
    if (!entry.rows.some((r) => r.id === a.candidateOutcome!.id)) {
      entry.rows.push({
        id: a.candidateOutcome.id,
        anchorAtMs: a.candidateOutcome.anchorAt.getTime(),
        final: a.candidateOutcome.finalizedAt !== null,
      });
    }
    byToken.set(a.tokenId, entry);
  }
  const out: TapeCoin[] = [];
  for (const [tokenId, { mint, failedSource, rows }] of byToken) {
    rows.sort((a, b) => a.anchorAtMs - b.anchorAtMs);
    const first = rows[0]!;
    const shared = rows.filter((r) => r.anchorAtMs - first.anchorAtMs <= SHARED_CALL_SPAN_MS);
    const windowEndMs = shared[shared.length - 1]!.anchorAtMs + TAPE_WINDOW_AFTER_ANCHOR_MS;
    if (windowEndMs + SETTLE_MS > nowMs || shared.some((r) => !r.final)) continue;
    out.push({
      tokenId,
      mint,
      reason: "called",
      refOutcomeId: first.id,
      anchorAtMs: first.anchorAtMs,
      outcomeIds: shared.map((r) => r.id),
      windowEndMs,
      failedSource,
    });
  }
  return out.sort((a, b) => b.anchorAtMs - a.anchorAtMs);
}

/** One uncalled decision moment whose window has closed, picked at random from the newest. */
export async function pendingSampleCoin(nowMs: number): Promise<TapeCoin | null> {
  const rows = await prisma.$queryRaw<{ id: string; tokenId: string; anchorAt: Date; mintAddress: string }[]>`
    SELECT co.id, co."tokenId", co."anchorAt", t."mintAddress"
    FROM "CandidateOutcome" co JOIN "Token" t ON t.id = co."tokenId"
    WHERE co."sampleKind" = 'event'
      AND co."finalizedAt" IS NOT NULL
      AND co."anchorAt" >= ${new Date(nowMs - LOOKBACK_MS)}
      AND co."anchorAt" <= ${new Date(nowMs - TAPE_WINDOW_AFTER_ANCHOR_MS - SETTLE_MS)}
      AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" a WHERE a."tokenId" = co."tokenId")
      AND NOT EXISTS (SELECT 1 FROM "TokenTradeTape" tt WHERE tt."tokenId" = co."tokenId")
    ORDER BY co."anchorAt" DESC
    LIMIT 200`;
  if (rows.length === 0) return null;
  const r = rows[Math.floor(Math.random() * rows.length)]!;
  return {
    tokenId: r.tokenId,
    mint: r.mintAddress,
    reason: "sample",
    refOutcomeId: r.id,
    anchorAtMs: r.anchorAt.getTime(),
    outcomeIds: [r.id],
    windowEndMs: r.anchorAt.getTime() + TAPE_WINDOW_AFTER_ANCHOR_MS,
  };
}

/** A row's stop on the grade training reads: its rule-4 re-grade when it has one. */
export function stoppedAtOf(row: { stoppedAt: Date | null; rule4Grade: Prisma.JsonValue }): Date | null {
  const r4 = row.rule4Grade;
  if (r4 && typeof r4 === "object" && !Array.isArray(r4)) {
    const v = (r4 as Record<string, unknown>).stoppedAt;
    if (typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return row.stoppedAt;
}

async function markFailed(coin: TapeCoin, source: string, calls: number, retryMs: number, nowMs: number) {
  const data = {
    outcomeId: coin.refOutcomeId,
    anchorAt: new Date(coin.anchorAtMs),
    reason: coin.reason,
    status: "failed",
    source,
    windowEnd: new Date(coin.windowEndMs),
    calls,
    readAt: new Date(nowMs),
    retryAt: new Date(nowMs + retryMs),
  };
  await prisma.tokenTradeTape.upsert({
    where: { tokenId: coin.tokenId },
    create: { tokenId: coin.tokenId, ...data },
    update: data,
  });
}

/** Builds the per-wallet rows and the stop causes from a finished read, and stores them. */
export async function storeTape(
  coin: TapeCoin,
  read: {
    trades: TapeTrade[];
    complete: boolean;
    launchAtMs: number | null;
    creator: string | null;
    source: "helius" | "pumpfun";
    calls: number;
  },
  nowMs: number,
): Promise<{ wallets: number; stopCauses: number }> {
  const trades = orderTrades(read.trades).filter((t) => t.atMs <= coin.windowEndMs);
  const outcomes = await prisma.candidateOutcome.findMany({
    where: { id: { in: coin.outcomeIds } },
    select: { id: true, anchorAt: true, stoppedAt: true, rule4Grade: true },
  });
  const ref = outcomes.find((o) => o.id === coin.refOutcomeId);
  const refStop = ref ? stoppedAtOf(ref) : null;
  const summaries = summarizeTape(trades, {
    anchorAtMs: coin.anchorAtMs,
    stoppedAtMs: refStop?.getTime() ?? null,
    complete: read.complete,
    launchAtMs: read.launchAtMs,
    creator: read.creator,
  });
  const byWallet = new Map(summaries.map((s) => [s.wallet, s]));
  const kept = summaries.filter(keepWalletRow);
  const tradesOf = walletTrades(trades);
  const causes: { id: string; cause: Prisma.InputJsonValue }[] = [];
  for (const o of outcomes) {
    const stop = stoppedAtOf(o);
    if (!stop || stop.getTime() > coin.windowEndMs) continue;
    const cause = stopCauseOf(trades, byWallet, {
      anchorAtMs: o.anchorAt.getTime(),
      stoppedAtMs: stop.getTime(),
      complete: read.complete,
    });
    causes.push({ id: o.id, cause: cause as unknown as Prisma.InputJsonValue });
  }
  const tape = {
    outcomeId: coin.refOutcomeId,
    anchorAt: new Date(coin.anchorAtMs),
    reason: coin.reason,
    status: read.complete ? "done" : "partial",
    source: read.source,
    windowEnd: new Date(coin.windowEndMs),
    launchAt: read.launchAtMs !== null ? new Date(read.launchAtMs) : null,
    creator: read.creator,
    trades: trades.length,
    wallets: kept.length,
    calls: read.calls,
    readAt: new Date(nowMs),
    retryAt: null,
  };
  const date = (ms: number | null) => (ms === null ? null : new Date(ms));
  await prisma.$transaction(
    async (tx) => {
      await tx.tokenTradeTape.upsert({
        where: { tokenId: coin.tokenId },
        create: { tokenId: coin.tokenId, ...tape },
        update: tape,
      });
      if (read.creator) {
        await tx.token.updateMany({
          where: { id: coin.tokenId, creator: null },
          data: { creator: read.creator },
        });
      }
      await tx.tokenWalletActivity.deleteMany({ where: { tokenId: coin.tokenId } });
      for (let i = 0; i < kept.length; i += 1_000) {
        await tx.tokenWalletActivity.createMany({
          data: kept.slice(i, i + 1_000).map((w) => ({
            tokenId: coin.tokenId,
            wallet: w.wallet,
            buys: w.buys,
            sells: w.sells,
            solIn: w.solIn,
            solOut: w.solOut,
            tokensBought: w.tokensBought,
            tokensSold: w.tokensSold,
            firstBuyAt: date(w.firstBuyAtMs),
            firstSellAt: date(w.firstSellAtMs),
            heldAtAnchor: w.heldAtAnchor,
            heldPctAtAnchor: w.heldPctAtAnchor,
            boughtPct: w.boughtPct,
            isCreator: w.isCreator,
            firstBuyerRank: w.firstBuyerRank,
            launchSniper: w.launchSniper,
            top10AtAnchor: w.top10AtAnchor,
            fastExit: w.fastExit,
            dumpedIntoStop: w.dumpedIntoStop,
            dumpSol: w.dumpSol,
            trades: (tradesOf.get(w.wallet) ?? []) as unknown as Prisma.InputJsonValue,
            createdAt: new Date(nowMs),
          })),
          skipDuplicates: true,
        });
      }
      for (const c of causes) {
        await tx.candidateOutcome.update({ where: { id: c.id }, data: { stopCause: c.cause } });
      }
    },
    // maxWait as the scanner's other write transactions have it: at Prisma's 2 s default, a pool
    // stall during a scan burst failed the store, and the next run re-read the coin from page one.
    { maxWait: 10_000, timeout: 30_000 },
  );
  return { wallets: kept.length, stopCauses: causes.length };
}

export interface TradeTapeDeps {
  helius: Pick<HeliusClient, "getMintTransactionsPage" | "gtfaUsable" | "takeCallStats">;
  pumpFun: Pick<PumpFunClient, "coinTrades" | "coinOrigin">;
  /** Prices the coins a trade was paid in other than SOL (a coin-paired launch's quote coin). */
  solPrices?: SolPriceLookup;
  /** The closing read's calls (tradeTapeClosing.ts); without them it doesn't run. */
  closingHelius?: ClosingHelius;
  /** Current market caps, for the closing read's "still dead?". */
  marketCaps?: MarketCapLookup;
}

export interface TradeTapeOptions {
  heliusPagesPerRun: number;
  pumpFunCallsPerRun: number;
  /** Helius credits a run for closing reads (tradeTapeClosing.ts); 0 or absent: none. */
  closingCreditsPerRun?: number;
  /** LOW_CAP_MCAP_USD: under it a taped coin past its tracking window is closed. 0: none is. */
  lowCapMcapUsd?: number;
  spacingMs?: number;
  now?: () => number;
}

interface RunCounts {
  done: number;
  partial: number;
  failed: number;
  wallets: number;
  stopCauses: number;
  heliusPages: number;
  pumpFunCalls: number;
  throttled: number;
}

async function finish(
  p: Progress,
  source: "helius" | "pumpfun",
  complete: boolean,
  counts: RunCounts,
  nowMs: number,
) {
  if (p.trades.length === 0) {
    await markFailed(p.coin, source, p.calls, RETRY_UNKNOWN_COIN_MS, nowMs);
    counts.failed += 1;
    return;
  }
  const stored = await storeTape(
    p.coin,
    {
      trades: p.trades,
      complete,
      launchAtMs: p.launch?.atMs ?? null,
      creator: p.launch?.creator ?? null,
      source,
      calls: p.calls,
    },
    nowMs,
  );
  counts[complete ? "done" : "partial"] += 1;
  counts.wallets += stored.wallets;
  counts.stopCauses += stored.stopCauses;
}

async function runHeliusLane(
  deps: TradeTapeDeps,
  called: TapeCoin[],
  budget: number,
  counts: RunCounts,
  now: () => number,
) {
  while (budget > 0 && deps.helius.gtfaUsable) {
    if (!state.helius) {
      // Newest first (`called` is), so new calls are read within minutes and the backlog with
      // what's left of the budget.
      const coin = called.find(
        (c) => c.failedSource !== "helius" && state.pumpFun?.coin.tokenId !== c.tokenId,
      );
      if (!coin) return;
      called.splice(called.indexOf(coin), 1);
      state.helius = {
        coin,
        trades: [],
        calls: 0,
        cursor: undefined,
        errors: 0,
        launch: null,
        started: false,
      };
    }
    const p = state.helius;
    const page = await deps.helius.getMintTransactionsPage(p.coin.mint, {
      paginationToken: p.cursor,
      untilBlockTime: Math.floor(p.coin.windowEndMs / 1000),
    });
    budget -= 1;
    counts.heliusPages += 1;
    p.calls += 1;
    if (page.status === "unsupported") {
      state.helius = null;
      return;
    }
    if (page.status === "failed") {
      p.errors += 1;
      if (p.errors >= 3) {
        await markFailed(p.coin, "helius", p.calls, RETRY_FAILED_MS, now());
        counts.failed += 1;
        state.helius = null;
      }
      continue;
    }
    const parsed = await tradesFromChainTransactionsPriced(p.coin.mint, page.txs, deps.solPrices);
    if (!p.started) {
      p.started = true;
      p.launch = parsed.launch;
    }
    p.trades.push(...parsed.trades);
    p.cursor = page.paginationToken ?? undefined;
    const lastAtMs = Math.max(0, ...page.txs.map((t) => (t.blockTime ?? 0) * 1000));
    if (!page.paginationToken || lastAtMs > p.coin.windowEndMs) {
      // The tape runs from the launch when the first page started at it.
      await finish(p, "helius", p.launch !== null, counts, now());
      state.helius = null;
    } else if (p.calls >= HELIUS_MAX_PAGES_PER_COIN) {
      // Too busy to read in full within the cap: left to Pump.fun.
      await markFailed(p.coin, "helius", p.calls, RETRY_UNKNOWN_COIN_MS, now());
      counts.failed += 1;
      state.helius = null;
    }
  }
}

async function runPumpFunLane(
  deps: TradeTapeDeps,
  called: TapeCoin[],
  heliusOn: boolean,
  calls: number,
  spacingMs: number,
  counts: RunCounts,
  now: () => number,
) {
  let first = true;
  while (calls > 0) {
    if (now() < state.pumpFunPausedUntil) return;
    if (!state.pumpFun) {
      let coin: TapeCoin | null | undefined;
      if (state.coinsStarted % SAMPLE_EVERY === SAMPLE_EVERY - 1) coin = await pendingSampleCoin(now());
      const free = called.filter((c) => state.helius?.coin.tokenId !== c.tokenId);
      // Beside Helius: the coins Helius couldn't read, else the oldest of the backlog, so the two
      // lanes work from opposite ends. Without Helius: every coin, newest first.
      coin ??= heliusOn ? (free.find((c) => c.failedSource === "helius") ?? free.at(-1)) : free[0];
      if (!coin) return;
      state.coinsStarted += 1;
      if (called.includes(coin)) called.splice(called.indexOf(coin), 1);
      state.pumpFun = {
        coin,
        trades: [],
        calls: 0,
        cursor: pumpFunCursorBefore(coin.windowEndMs + 1_000),
        errors: 0,
        launch: null,
        started: false,
      };
    }
    const p = state.pumpFun;
    if (!first) await sleep(spacingMs);
    first = false;
    calls -= 1;
    counts.pumpFunCalls += 1;
    p.calls += 1;
    try {
      if (!p.started) {
        const origin = await deps.pumpFun.coinOrigin(p.coin.mint);
        if (!origin) {
          await markFailed(p.coin, "pumpfun", p.calls, RETRY_UNKNOWN_COIN_MS, now());
          counts.failed += 1;
          state.pumpFun = null;
          continue;
        }
        p.started = true;
        p.launch = { atMs: origin.createdAt?.getTime() ?? null, creator: origin.creator };
        continue;
      }
      const page = await deps.pumpFun.coinTrades(p.coin.mint, p.cursor!);
      if (!page) {
        await markFailed(p.coin, "pumpfun", p.calls, RETRY_UNKNOWN_COIN_MS, now());
        counts.failed += 1;
        state.pumpFun = null;
        continue;
      }
      // Newest first: the pages are kept in chain order by reversing each and putting it in front.
      p.trades.unshift(...page.trades.reverse());
      p.cursor = page.nextCursor ?? undefined;
      if (!page.nextCursor) {
        await finish(p, "pumpfun", true, counts, now());
        state.pumpFun = null;
      } else if (p.calls >= PUMPFUN_MAX_CALLS_PER_COIN) {
        await finish(p, "pumpfun", false, counts, now());
        state.pumpFun = null;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) {
        counts.throttled += 1;
        state.pumpFunPausedUntil = now() + PUMPFUN_PAUSE_ON_429_MS;
        return;
      }
      p.errors += 1;
      logger.warn("pump.fun trades read failed", { mint: p.coin.mint, error: String(err) });
      if (p.errors >= 3) {
        await markFailed(p.coin, "pumpfun", p.calls, RETRY_FAILED_MS, now());
        counts.failed += 1;
        state.pumpFun = null;
      }
    }
  }
}

export async function runTradeTapeJob(deps: TradeTapeDeps, opts: TradeTapeOptions): Promise<JobRunMeta> {
  const now = opts.now ?? Date.now;
  const counts: RunCounts = {
    done: 0,
    partial: 0,
    failed: 0,
    wallets: 0,
    stopCauses: 0,
    heliusPages: 0,
    pumpFunCalls: 0,
    throttled: 0,
  };
  // A coin carried over from the last run stays with its lane, and out of the lists for new picks.
  const inProgress = new Set([state.helius?.coin.tokenId, state.pumpFun?.coin.tokenId]);
  const called = (await pendingCalledCoins(now())).filter((c) => !inProgress.has(c.tokenId));
  const pending = called.length + (inProgress.size - (inProgress.has(undefined) ? 1 : 0));
  const heliusOn = opts.heliusPagesPerRun > 0 && deps.helius.gtfaUsable;
  const closing: ClosingCounts = {
    closingDone: 0,
    closingFailed: 0,
    closingSellers: 0,
    closingWallets: 0,
    closingCredits: 0,
  };
  await Promise.all([
    opts.heliusPagesPerRun > 0
      ? runHeliusLane(deps, called, opts.heliusPagesPerRun, counts, now)
      : Promise.resolve(),
    opts.pumpFunCallsPerRun > 0
      ? runPumpFunLane(
          deps,
          called,
          heliusOn,
          opts.pumpFunCallsPerRun,
          opts.spacingMs ?? PUMPFUN_SPACING_MS,
          counts,
          now,
        )
      : Promise.resolve(),
    // A tape is only closed once it is read, so the coin is never one the lanes above have open.
    (opts.closingCreditsPerRun ?? 0) > 0 && deps.closingHelius
      ? runClosingLane(
          { helius: deps.closingHelius, solPrices: deps.solPrices, marketCaps: deps.marketCaps },
          { budget: opts.closingCreditsPerRun!, floorUsd: opts.lowCapMcapUsd ?? 0 },
          closing,
          now,
        ).catch((err: unknown) => {
          // Started afresh next run: a half-stored coin is simply read again.
          resetClosingState();
          logger.warn("closing read failed", { error: String(err) });
        })
      : Promise.resolve(),
  ]);
  const rpc = deps.helius.takeCallStats();
  const meta: JobRunMeta = {
    pendingCalledCoins: pending,
    // False means Helius can't serve the read here (no key, or the method stood down): the tape
    // then runs on Pump.fun alone, a few coins an hour.
    heliusUsable: deps.helius.gtfaUsable,
    ...counts,
    // Closing reads (tradeTapeClosing.ts): coins closed or failed, sellers found, wallets updated, credits.
    ...closing,
    // The trade tape's own reads; closingCredits counts the closing reads' 1-credit calls.
    heliusCredits: (rpc.getTransactionsForAddress ?? 0) * 10,
  };
  if (counts.done + counts.partial + counts.failed + closing.closingDone > 0)
    logger.info("trade tapes read", meta);
  return meta;
}
