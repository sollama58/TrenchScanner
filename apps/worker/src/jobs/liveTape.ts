import {
  chainLaunchBags,
  chainWindowFlow,
  createLogger,
  liveFlags,
  liveTraders,
  STREAM_PAGE_TRADES,
  tradesFromChainTransactionsPriced,
  walletScoreReading,
  winnerFollowReading,
  type HeliusClient,
  type LaunchBags,
  type LiveFlagsReading,
  type LiveTraderCounts,
  type ScoredWallet,
  type SolPriceLookup,
  type StreamTapePage,
  type TapeTrade,
  type TradeFlowFeatures,
  type WalletScoreReading,
  type WinnerFollowReading,
} from "@trenchscanner/core";

const logger = createLogger("live-tape");

/**
 * The live tape: each coin close to a call has its newest page of trades read from Helius (one
 * 10-credit getTransactionsForAddress, up to 100 trades), so the flagged wallets trading it
 * (core's wallets/liveFlags.ts) are known before the decision, not half an hour after it as on
 * the post-call trade tape. User decision 2026-10-13: Helius, for coins close to a call.
 *
 * Contenders and alerts held for a wallet figure come first, as in the wallet stage. A coin's
 * page is read again once it is LIVE_TAPE_REFRESH_SECONDS old, unless the trade stream says the
 * coin has not traded since (user decision 2026-10-20 (Helius audit)), and at most
 * LIVE_TAPE_PAGES_PER_CYCLE pages go out a minute: that cap is the credit ceiling. The cycle and
 * the entry fast path's scans draw on one page budget (pageBudget) refilled at that many a minute,
 * so 15 means 15 however many fast scans run; read per call, each fast scan's pages came on top of
 * the cycle's (audit 2026-10-27, DA-8: 18 pages in one heartbeat under a cap of 15).
 *
 * A coin still on its bonding curve takes its page from the PumpPortal trade stream instead
 * (user decision 2026-10-24: "PumpPortal while bonding, Helius after"): the worker already
 * follows every band coin's trades there, so the page costs nothing and is as fresh as the last
 * block. The stream's page stands in for Helius's only where it says as much: the coin's whole
 * history (its launch was seen, no stream gap since), a full page's worth of trades, or at least
 * STREAM_COVERAGE_MS of following. Once the coin graduates, or the stream can't vouch for it,
 * Helius is read as before.
 */

/** A stream page short of a full page or the coin's whole history must cover at least this long. */
export const STREAM_COVERAGE_MS = 15 * 60_000;

/** A page older than this says nothing about now: the reading is unknown again. */
const MAX_PAGE_AGE_MS = 15 * 60_000;
const MAX_ENTRIES = 2_000;

/** A coin's newest page: its trades, and whether they are its whole history (no older page). */
const pages = new Map<string, { atMs: number; trades: TapeTrade[]; complete: boolean }>();
let pagesRead = 0;
/**
 * The page budget the cycle and the fast scans share: a bucket holding at most a minute's pages,
 * refilled continuously at that rate, so a fast scan between two cycles takes its page out of the
 * next cycle's share rather than adding one. A page that goes unbilled (not served, or failed)
 * goes back in.
 */
const pageBudget = { tokens: Number.NaN, atMs: 0 };

/** Takes up to `want` pages from the shared budget of `perMinute` a minute; returns how many it got. */
function takePages(want: number, perMinute: number, nowMs: number): number {
  if (Number.isNaN(pageBudget.tokens)) {
    pageBudget.tokens = perMinute;
    pageBudget.atMs = nowMs;
  }
  const elapsed = Math.max(0, nowMs - pageBudget.atMs);
  pageBudget.tokens = Math.min(perMinute, pageBudget.tokens + (elapsed * perMinute) / 60_000);
  pageBudget.atMs = Math.max(pageBudget.atMs, nowMs);
  const got = Math.max(0, Math.min(want, Math.floor(pageBudget.tokens)));
  pageBudget.tokens -= got;
  return got;
}

/** A page taken from the budget that Helius did not bill. */
function returnPage(perMinute: number): void {
  pageBudget.tokens = Math.min(perMinute, pageBudget.tokens + 1);
}
let pagesFailed = 0;
/** Coins whose page came off the trade stream since the last call: no Helius page for them. */
let streamed = 0;

/**
 * Pages read and failed since the last call, for the scan's heartbeat: 10 credits a page read.
 * A failed page costs nothing, as Helius bills no failed getTransactionsForAddress answer.
 */
export function takeLiveTapeStats(): {
  pages: number;
  failed: number;
  credits: number;
  coins: number;
  streamed: number;
} {
  const out = {
    pages: pagesRead,
    failed: pagesFailed,
    credits: 10 * pagesRead,
    coins: pages.size,
    streamed,
  };
  pagesRead = 0;
  pagesFailed = 0;
  streamed = 0;
  return out;
}

/**
 * Whether a stream page can stand in for a Helius page: the coin is still bonding (Helius after),
 * and the page says as much as Helius's newest page would - the coin's whole history, a full
 * page's worth, or at least STREAM_COVERAGE_MS of following.
 */
export function streamPageUsable(page: StreamTapePage, nowMs: number): boolean {
  if (!page.bonding) return false;
  return (
    page.complete || page.trades.length >= STREAM_PAGE_TRADES || nowMs - page.sinceMs >= STREAM_COVERAGE_MS
  );
}

/** Test hook. */
export function resetLiveTape(): void {
  pages.clear();
  pageBudget.tokens = Number.NaN;
  takeLiveTapeStats();
}

/**
 * Reads the newest page for the first of `mints` (priority order) whose page is missing or older
 * than `refreshMs`, the missing ones first, as many as the shared budget of `maxPages` a minute has
 * left (pageBudget). A page due whose coin `quietSince` says has had no trade since
 * it was read is still the coin's newest: it is kept, as of now, so it doesn't age out of
 * livePageOf while the coin stays quiet. Never rejects.
 */
export async function readLiveTape(
  mints: readonly string[],
  helius: Pick<HeliusClient, "getMintTransactionsPage" | "gtfaUsable">,
  opts: {
    maxPages: number;
    refreshMs: number;
    nowMs?: number;
    /** Prices the coins a trade was paid in other than SOL (a coin-paired launch's quote coin). */
    solPrices?: SolPriceLookup;
    /** Whether a mint has had no trade since then, as far as the trade stream can vouch. */
    quietSince?: (mint: string, sinceMs: number) => boolean;
    /** A mint's newest trades off the trade stream (PumpPortalStream.recentTrades), when it can vouch for them. */
    streamed?: (mint: string) => StreamTapePage | null | undefined;
  },
): Promise<void> {
  if (opts.maxPages <= 0) return;
  const now = opts.nowMs ?? Date.now();
  const missing: string[] = [];
  const stale: string[] = [];
  for (const m of mints) {
    // A bonding coin's page comes off the stream, every cycle, for nothing: the stream's trades
    // are the block's, so the page is never stale, and Helius is kept for after graduation. Read
    // through a Helius stand-down too, as nothing is asked of Helius for it.
    const fromStream = opts.streamed?.(m);
    if (fromStream && streamPageUsable(fromStream, now)) {
      pages.delete(m);
      pages.set(m, { atMs: now, trades: fromStream.trades, complete: fromStream.complete });
      streamed += 1;
      continue;
    }
    if (!helius.gtfaUsable) continue;
    const page = pages.get(m);
    if (!page) missing.push(m);
    else if (now - page.atMs < opts.refreshMs) continue;
    else if (!opts.quietSince?.(m, page.atMs)) stale.push(m);
    else pages.set(m, { ...page, atMs: now });
  }
  // A coin with no page yet goes before a re-read: without one its decision has no winner or
  // flagged-wallet reading at all (and the Winners seat skips it), where a re-read only makes a
  // reading fresher. Most decisions are a coin's first (2026-10-23 thread "Winners model signal").
  const queued = [...missing, ...stale];
  const due = queued.slice(0, takePages(queued.length, opts.maxPages, now));
  await Promise.all(
    due.map(async (mint) => {
      let billed = false;
      try {
        const page = await helius.getMintTransactionsPage(mint, { newest: true });
        if (page.status !== "ok") {
          if (page.status === "failed") pagesFailed += 1;
          returnPage(opts.maxPages);
          return;
        }
        pagesRead += 1;
        billed = true;
        pages.delete(mint);
        const { trades } = await tradesFromChainTransactionsPriced(mint, page.txs, opts.solPrices);
        pages.set(mint, { atMs: now, trades, complete: page.paginationToken === null });
        if (pages.size > MAX_ENTRIES) {
          const oldest = pages.keys().next().value;
          if (oldest !== undefined) pages.delete(oldest);
        }
      } catch (err) {
        pagesFailed += 1;
        if (!billed) returnPage(opts.maxPages);
        logger.warn("live tape page failed", { mint, error: String(err) });
      }
    }),
  );
}

/** A coin's newest page as livePageOf hands it out. */
export type LiveTapePage = Readonly<{ atMs: number; trades: readonly TapeTrade[]; complete: boolean }>;

/**
 * A coin's recent page, or undefined without one. readLiveTape replaces a coin's page (deleting
 * it while the new one is priced) while a cycle runs, so the scan takes each candidate's page
 * once and hands the same page to every reading of the cycle (the own-tape buyers and the Wallet
 * Score especially: read apart, a new page's buyers could escape the own-tape exclusion).
 */
export function livePageOf(mint: string, nowMs = Date.now()): LiveTapePage | undefined {
  const page = pages.get(mint);
  return page && nowMs - page.atMs <= MAX_PAGE_AGE_MS ? page : undefined;
}

/** How many wallets matching `is` traded in a coin's recent page, or null without a recent page. */
export function liveTradersOf(
  mint: string,
  is: ((wallet: string) => boolean) | undefined,
  nowMs = Date.now(),
): LiveTraderCounts | null {
  return liveTradersOn(livePageOf(mint, nowMs), is);
}

/** liveTradersOf on a page already taken (livePageOf). */
export function liveTradersOn(
  page: LiveTapePage | undefined,
  is: ((wallet: string) => boolean) | undefined,
): LiveTraderCounts | null {
  if (!is || !page) return null;
  return liveTraders(page.trades, is);
}

/** The flagged-wallet reading for a coin, or null without a recent page or the risk scores. */
export function liveFlagsOf(
  mint: string,
  lookup: ((wallet: string) => ScoredWallet | undefined) | undefined,
  nowMs = Date.now(),
): LiveFlagsReading | null {
  return liveFlagsOn(livePageOf(mint, nowMs), lookup);
}

/** liveFlagsOf on a page already taken (livePageOf). */
export function liveFlagsOn(
  page: LiveTapePage | undefined,
  lookup: ((wallet: string) => ScoredWallet | undefined) | undefined,
): LiveFlagsReading | null {
  if (!lookup || !page) return null;
  return liveFlags(page.trades, lookup);
}

/** The wallets buying in a coin's recent page, or none without one (for the own-tape read). */
export function liveBuyersOf(mint: string, nowMs = Date.now()): string[] {
  return liveBuyersOn(livePageOf(mint, nowMs));
}

/** liveBuyersOf on a page already taken (livePageOf). */
export function liveBuyersOn(page: LiveTapePage | undefined): string[] {
  if (!page) return [];
  return [...new Set(page.trades.filter((t) => t.side === "buy").map((t) => t.wallet))];
}

/**
 * The hidden Wallet Score of the wallets buying in a coin's recent page (core's
 * walletScoreReading), or null without a recent page or the scores. Wallets in `ownTape` (rows
 * on this coin's own tape already in the scores) are left out.
 */
export function liveWalletScoreOf(
  mint: string,
  lookup: ((wallet: string) => ScoredWallet | undefined) | undefined,
  ownTape: { has(wallet: string): boolean } | null | undefined,
  nowMs = Date.now(),
): WalletScoreReading | null {
  return liveWalletScoreOn(livePageOf(mint, nowMs), lookup, ownTape);
}

/** liveWalletScoreOf on a page already taken (livePageOf): the page whose buyers `ownTape` was read for. */
export function liveWalletScoreOn(
  page: LiveTapePage | undefined,
  lookup: ((wallet: string) => ScoredWallet | undefined) | undefined,
  ownTape: { has(wallet: string): boolean } | null | undefined,
): WalletScoreReading | null {
  if (!lookup || !page) return null;
  return walletScoreReading(page.trades, (wallet) => lookup(wallet)?.walletScore, ownTape);
}

/**
 * The newest buyers read through the clean winner wallets' records (core's winnerFollowReading,
 * learner inputs; the Winners seat still requires the tape), or null without the coin's recent page
 * (livePageOf) or the wallet book. Wallets in
 * `ownTape` (rows on this coin's own tape already in the book) count as buyers but are read as
 * unknown.
 */
export function liveWinnerFollowOn(
  page: LiveTapePage | undefined,
  lookup: ((wallet: string) => ScoredWallet | undefined) | undefined,
  ownTape: { has(wallet: string): boolean } | null | undefined,
): WinnerFollowReading | null {
  if (!lookup || !page) return null;
  return winnerFollowReading(page.trades, lookup, ownTape);
}

/** A window reading older than this is no longer the last five minutes. */
const MAX_WINDOW_PAGE_AGE_MS = 5 * 60_000;

/**
 * The 5m order flow read from a coin's recent page (core's chainWindowFlow), for a coin the
 * PumpPortal stream doesn't carry trades for: a Stonks coin, and on the stream's free tier
 * (launches and graduations only) every coin - model audit 2026-10-26, §16. Null without a page
 * read in the last five minutes. Read as of when the page was read.
 */
export function liveWindowFlowOf(mint: string, nowMs = Date.now()): TradeFlowFeatures | null {
  const page = pages.get(mint);
  if (!page || nowMs - page.atMs > MAX_WINDOW_PAGE_AGE_MS) return null;
  return chainWindowFlow(page.trades, page.atMs, page.complete);
}

/**
 * The launch's bags (early buyers, dev) read from a coin's recent page when it is the coin's whole
 * history (core's chainLaunchBags), for a coin whose launch the PumpPortal stream saw no trades of
 * (its free tier; model audit 2026-10-26, §16). `creator` is the coin's creator wallet off the
 * on-chain profile, unknown without which the dev's bag stays null. Null without a recent page
 * (livePageOf) or on a page with an older page behind it.
 */
export function liveLaunchBagsOf(
  mint: string,
  creator: string | null | undefined,
  nowMs = Date.now(),
): LaunchBags | null {
  const page = livePageOf(mint, nowMs);
  if (!page) return null;
  return chainLaunchBags(page.trades, creator, page.complete);
}
