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
  type ChainTx,
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
 *    HELIUS_MAX_PAGES_PER_COIN is left to Pump.fun at once (BUSY_SOURCE), and stays Pump.fun's.
 *  - Pump.fun's trade API, free but quick to answer 429: read backwards from the end of the window
 *    (a cursor at a timestamp skips everything after it), spaced calls a run
 *    (TRADE_TAPE_PUMPFUN_CALLS_PER_RUN), paused for a minute on a 429. Coins Helius couldn't read,
 *    the oldest of the backlog (working from the other end), and one coin in SAMPLE_EVERY from the
 *    uncalled sample. Without Helius it takes every coin.
 * Each lane works one coin at a time and carries it over to the next run until it's read, and a
 * shutdown saves both lanes' reads (TradeTapeProgress) for the next process to finish.
 *
 * When no coin is left for Helius to read from the launch, its pages go to the busy coins (audit
 * 2026-10-19: the lane sat idle in half its runs while ~580 busy coins waited on Pump.fun's few
 * calls a minute and mostly aged out unread): newest first from the window's end, up to
 * HELIUS_NEWEST_MAX_PAGES, stored as partial like Pump.fun's capped reads, or as a whole tape when
 * the read meets the launch side the hand-off had already read.
 */

/** Called coins this far back are read (the backlog goes to Pump.fun). */
const LOOKBACK_MS = 10 * 24 * 3_600_000;
/** Calls within this long of a coin's first call share its tape (and get a stop cause from it). */
const SHARED_CALL_SPAN_MS = 2 * 3_600_000;
/** A window is read this long after it closes, so the indexers have the last trades. */
const SETTLE_MS = 2 * 60_000;
/** 10,000 transactions, 1,000 credits: past it a coin is left to Pump.fun. */
export const HELIUS_MAX_PAGES_PER_COIN = 100;
/**
 * A coin is left to Pump.fun as soon as its read is clearly headed past HELIUS_MAX_PAGES_PER_COIN
 * (user decision 2026-10-17): from HELIUS_ESTIMATE_AFTER_PAGES pages on, the pages its window
 * still needs are estimated at the pace of the last HELIUS_ESTIMATE_SPAN_PAGES, and a read headed
 * for HELIUS_BUSY_MARGIN times the cap goes now. Reaching the cap first cost 1,000 credits a busy
 * coin, all thrown away (2,400 credits for 1 tape on the morning of 10-17). Trading slows after
 * the launch, so the pace overstates what is left: the estimate waits until the launch's burst is
 * read (a coin this far in has 1,000 trades, above the median 700), and the margin keeps a coin that
 * would have just made it on Helius. One handed off by mistake still gets a whole tape from Pump.fun,
 * which reads back to the launch when it has under 6,000 trades.
 */
export const HELIUS_ESTIMATE_AFTER_PAGES = 10;
const HELIUS_ESTIMATE_SPAN_PAGES = 5;
export const HELIUS_BUSY_MARGIN = 2;
/**
 * Pages a newest-first Helius read of a busy coin takes before it is stored as partial: 3,000
 * trades back from the window's end, 300 credits, half what Pump.fun's partial reads hold.
 */
export const HELIUS_NEWEST_MAX_PAGES = 30;
/**
 * Hand-offs whose launch-side pages are kept for the newest-first read to meet (a few hundred KB
 * each). One that meets them makes a whole tape of the two halves.
 */
const MAX_KEPT_HANDOFFS = 20;
/** Pump.fun calls on one coin before it is stored as partial (6,000 trades). */
const PUMPFUN_MAX_CALLS_PER_COIN = 60;
// 8 s: no 429 in 21 runs at 12 s (audit 2026-10-19), and the swap host's shared budget is 240 a minute.
const PUMPFUN_SPACING_MS = 8_000;
const PUMPFUN_PAUSE_ON_429_MS = 60_000;
/** Of every this many coins the Pump.fun lane starts, one is an uncalled sample. */
const SAMPLE_EVERY = 4;
/** While more called coins than this wait, the Pump.fun lane takes no uncalled sample. */
const SAMPLE_PAUSE_PENDING = 100;
const RETRY_FAILED_MS = 30 * 60_000;
const RETRY_UNKNOWN_COIN_MS = 24 * 3_600_000;
/**
 * The failed source of a coin too busy for Helius (audit 2026-10-17). It is handed to Pump.fun on
 * the next run (it waited a day behind RETRY_UNKNOWN_COIN_MS before, and the busy coins are the
 * ones that ran), and keeps this mark through Pump.fun's own failures: marked "pumpfun", the coin
 * went back to Helius, which read its pages from the launch again only to drop them again.
 */
const BUSY_SOURCE = "helius:busy";
/**
 * The failed source of a coin Helius failed on twice: from the launch after a first "helius"
 * failure, or newest first as a busy coin. Left to Pump.fun for good. A first failure is mostly a
 * slow page, so it gets one more Helius read after RETRY_FAILED_MS (it went to Pump.fun's queue at
 * once before, audit 2026-10-19).
 */
const HELIUS_GAVE_UP = "helius:failed";
/** Whether Helius has failed a coin: Pump.fun takes these first. */
const heliusFailed = (c: TapeCoin) =>
  c.failedSource === "helius" || c.failedSource === BUSY_SOURCE || c.failedSource === HELIUS_GAVE_UP;
/** Whether Helius reads a coin from its launch. */
const heliusFromLaunch = (c: TapeCoin) => c.failedSource !== BUSY_SOURCE && c.failedSource !== HELIUS_GAVE_UP;

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
  /** Helius: each page's newest trade time, for the pace (see HELIUS_ESTIMATE_AFTER_PAGES). */
  pageEnds?: number[];
  /** Helius: a busy coin's read, newest first from the window's end. */
  newest?: boolean;
}

/** The launch-side read a busy coin's hand-off already paid for (see MAX_KEPT_HANDOFFS). */
interface Handoff {
  trades: TapeTrade[];
  launch: { atMs: number | null; creator: string | null } | null;
  /** The newest trade time it read through. */
  throughMs: number;
}

/** Pages a Helius read still needs to reach its window's end, at the pace of its last pages. */
export function heliusPagesLeft(pageEnds: readonly number[], windowEndMs: number): number | null {
  if (pageEnds.length <= HELIUS_ESTIMATE_SPAN_PAGES) return null;
  const last = pageEnds[pageEnds.length - 1]!;
  const from = pageEnds[pageEnds.length - 1 - HELIUS_ESTIMATE_SPAN_PAGES]!;
  // Block times are whole seconds: a span under one reads as one.
  const msPerPage = Math.max(1_000, last - from) / HELIUS_ESTIMATE_SPAN_PAGES;
  return Math.max(0, windowEndMs - last) / msPerPage;
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
const handoffs = new Map<string, Handoff>();

/** Test hook. */
export function resetTradeTapeState(): void {
  state.helius = null;
  state.pumpFun = null;
  state.pumpFunPausedUntil = 0;
  state.coinsStarted = 0;
  handoffs.clear();
}

const LANES = ["helius", "pumpFun"] as const;

/**
 * Saves both lanes' reads in progress, for the next process's first run (restoreProgress): a deploy
 * mid-read cost a busy Pump.fun read up to 15 runs and a Helius read up to 1,000 credits, started
 * again from the first page. Called by the worker's shutdown once the jobs have settled.
 */
export async function saveTradeTapeProgress(): Promise<number> {
  let saved = 0;
  for (const lane of LANES) {
    const p = state[lane];
    if (!p) continue;
    const data = p as unknown as Prisma.InputJsonValue;
    await prisma.tradeTapeProgress.upsert({
      where: { lane },
      create: { lane, tokenId: p.coin.tokenId, data },
      update: { tokenId: p.coin.tokenId, data, savedAt: new Date() },
    });
    saved += 1;
  }
  return saved;
}

/**
 * Takes a saved read back into its idle lane while its coin still waits (`waiting`), and drops one
 * whose coin no longer does. Asked every run, not only the first: in a deploy the new process
 * starts before the old one saves, and its lanes may be busy then.
 */
async function restoreProgress(waiting: TapeCoin[]): Promise<void> {
  const rows = await prisma.tradeTapeProgress.findMany();
  const done: string[] = [];
  for (const row of rows) {
    const lane = LANES.find((l) => l === row.lane);
    const coin = waiting.find((c) => c.tokenId === row.tokenId);
    if (!lane || !coin) {
      done.push(row.lane);
      continue;
    }
    const other = state[lane === "helius" ? "pumpFun" : "helius"];
    if (state[lane] || other?.coin.tokenId === coin.tokenId) continue;
    state[lane] = { ...(row.data as unknown as Progress), coin };
    done.push(row.lane);
  }
  if (done.length > 0) await prisma.tradeTapeProgress.deleteMany({ where: { lane: { in: done } } });
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
  /** Coins left to Pump.fun as too busy for Helius (BUSY_SOURCE), also counted in failed. */
  handedOff: number;
}

async function finish(
  p: Progress,
  source: "helius" | "pumpfun",
  complete: boolean,
  counts: RunCounts,
  nowMs: number,
) {
  if (p.trades.length === 0) {
    await markFailed(
      p.coin,
      source === "pumpfun" ? pumpFunFailSource(p.coin) : source,
      p.calls,
      RETRY_UNKNOWN_COIN_MS,
      nowMs,
    );
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
      const free = called.filter((c) => state.pumpFun?.coin.tokenId !== c.tokenId);
      // Newest first (`called` is), so new calls are read within minutes and the backlog with
      // what's left of the budget. Then the busy coins, oldest first (Pump.fun takes the newest),
      // newest first from their window's end.
      const fromLaunch = free.find(heliusFromLaunch);
      const coin = fromLaunch ?? [...free].reverse().find((c) => c.failedSource === BUSY_SOURCE);
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
        ...(fromLaunch ? {} : { newest: true }),
      };
    }
    const p = state.helius;
    const page = await deps.helius.getMintTransactionsPage(p.coin.mint, {
      paginationToken: p.cursor,
      untilBlockTime: Math.floor(p.coin.windowEndMs / 1000),
      ...(p.newest ? { newest: true } : {}),
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
        const source = p.newest || p.coin.failedSource === "helius" ? HELIUS_GAVE_UP : "helius";
        await markFailed(p.coin, source, p.calls, RETRY_FAILED_MS, now());
        counts.failed += 1;
        state.helius = null;
        continue;
      }
      // The coin is carried over and the page asked again next run: asked again at once, a failing
      // page took the run's whole budget in a few seconds (each one billed when it timed out).
      return;
    }
    // Three failures in a row fail the coin; spread over a long read they no longer throw it away.
    p.errors = 0;
    const parsed = await tradesFromChainTransactionsPriced(p.coin.mint, page.txs, deps.solPrices);
    if (p.newest) {
      await readNewestPage(p, page, parsed, counts, now);
      continue;
    }
    if (!p.started) {
      p.started = true;
      p.launch = parsed.launch;
    }
    p.trades.push(...parsed.trades);
    p.cursor = page.paginationToken ?? undefined;
    const lastAtMs = Math.max(0, ...page.txs.map((t) => (t.blockTime ?? 0) * 1000));
    (p.pageEnds ??= []).push(lastAtMs);
    const left =
      p.calls >= HELIUS_ESTIMATE_AFTER_PAGES ? heliusPagesLeft(p.pageEnds, p.coin.windowEndMs) : null;
    if (!page.paginationToken || lastAtMs > p.coin.windowEndMs) {
      // The tape runs from the launch when the first page started at it.
      await finish(p, "helius", p.launch !== null, counts, now());
      state.helius = null;
    } else if (
      p.calls >= HELIUS_MAX_PAGES_PER_COIN ||
      (left !== null && p.calls + left > HELIUS_MAX_PAGES_PER_COIN * HELIUS_BUSY_MARGIN)
    ) {
      // Too busy to read in full within the cap: Pump.fun's from the next run on, or this lane's
      // newest first, which keeps what was read here to meet.
      keepHandoff(p.coin.tokenId, { trades: p.trades, launch: p.launch, throughMs: lastAtMs });
      await markFailed(p.coin, BUSY_SOURCE, p.calls, 0, now());
      counts.failed += 1;
      counts.handedOff += 1;
      state.helius = null;
    }
  }
}

function keepHandoff(tokenId: string, h: Handoff) {
  handoffs.delete(tokenId);
  handoffs.set(tokenId, h);
  while (handoffs.size > MAX_KEPT_HANDOFFS) handoffs.delete(handoffs.keys().next().value!);
}

/**
 * One page of a busy coin's newest-first read: it ends at the launch (a whole tape), at the
 * launch side the hand-off read (the two halves make a whole tape), or after
 * HELIUS_NEWEST_MAX_PAGES (partial: who sold after the anchor is right, launch roles unknown).
 */
async function readNewestPage(
  p: Progress,
  page: { txs: ChainTx[]; paginationToken: string | null },
  parsed: { trades: TapeTrade[]; launch: Progress["launch"] },
  counts: RunCounts,
  now: () => number,
) {
  // Chain order kept, as the Pump.fun lane does: each page reversed and put in front.
  p.trades.unshift(...[...parsed.trades].reverse());
  p.cursor = page.paginationToken ?? undefined;
  const times = page.txs.map((t) => (t.blockTime ?? 0) * 1000).filter((t) => t > 0);
  const oldestAtMs = times.length > 0 ? Math.min(...times) : 0;
  const handoff = handoffs.get(p.coin.tokenId);
  if (!page.paginationToken) {
    p.launch = parsed.launch;
    await finish(p, "helius", p.launch !== null, counts, now());
  } else if (handoff && oldestAtMs > 0 && oldestAtMs < handoff.throughMs) {
    // Strictly older: every trade in the hand-off's last second is on this side too.
    p.trades = [...handoff.trades, ...p.trades];
    p.launch = handoff.launch;
    await finish(p, "helius", p.launch !== null, counts, now());
  } else if (p.calls >= HELIUS_NEWEST_MAX_PAGES) {
    p.launch = handoff?.launch ?? null;
    await finish(p, "helius", false, counts, now());
  } else {
    return;
  }
  handoffs.delete(p.coin.tokenId);
  state.helius = null;
}

/** Pump.fun's failure keeps a coin Helius gave up on away from Helius. */
const pumpFunFailSource = (c: TapeCoin) =>
  c.failedSource === BUSY_SOURCE || c.failedSource === HELIUS_GAVE_UP ? c.failedSource : "pumpfun";

async function runPumpFunLane(
  deps: TradeTapeDeps,
  called: TapeCoin[],
  pending: number,
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
      if (pending <= SAMPLE_PAUSE_PENDING && state.coinsStarted % SAMPLE_EVERY === SAMPLE_EVERY - 1)
        coin = await pendingSampleCoin(now());
      const free = called.filter((c) => state.helius?.coin.tokenId !== c.tokenId);
      // Beside Helius: the coins Helius couldn't read, else the oldest of the backlog, so the two
      // lanes work from opposite ends. Without Helius: every coin, newest first.
      coin ??= heliusOn ? (free.find(heliusFailed) ?? free.at(-1)) : free[0];
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
          await markFailed(p.coin, pumpFunFailSource(p.coin), p.calls, RETRY_UNKNOWN_COIN_MS, now());
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
        await markFailed(p.coin, pumpFunFailSource(p.coin), p.calls, RETRY_UNKNOWN_COIN_MS, now());
        counts.failed += 1;
        state.pumpFun = null;
        continue;
      }
      p.errors = 0;
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
        await markFailed(p.coin, pumpFunFailSource(p.coin), p.calls, RETRY_FAILED_MS, now());
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
    handedOff: 0,
  };
  const waiting = await pendingCalledCoins(now());
  // The reads a shutdown saved go back to their lanes.
  await restoreProgress(waiting);
  // A coin carried over from the last run stays with its lane, and out of the lists for new picks.
  const inProgress = new Set([state.helius?.coin.tokenId, state.pumpFun?.coin.tokenId]);
  const called = waiting.filter((c) => !inProgress.has(c.tokenId));
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
          pending,
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
