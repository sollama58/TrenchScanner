import {
  chainWindowFlow,
  createLogger,
  liveFlags,
  liveTraders,
  tradesFromChainTransactionsPriced,
  type HeliusClient,
  type LiveFlagsReading,
  type LiveTraderCounts,
  type ScoredWallet,
  type SolPriceLookup,
  type TapeTrade,
  type TradeFlowFeatures,
} from "@trenchscanner/core";

const logger = createLogger("live-tape");

/**
 * The live tape: each coin close to a call has its newest page of trades read from Helius (one
 * 10-credit getTransactionsForAddress, up to 100 trades), so the flagged wallets trading it
 * (core's wallets/liveFlags.ts) are known before the decision, not half an hour after it as on
 * the post-call trade tape. User decision 2026-10-13: Helius, for coins close to a call.
 *
 * Contenders and alerts held for a wallet figure come first, as in the wallet stage. A coin's
 * page is read again once it is LIVE_TAPE_REFRESH_SECONDS old, and at most
 * LIVE_TAPE_PAGES_PER_CYCLE pages go out a cycle: that cap is the credit ceiling.
 */

/** A page older than this says nothing about now: the reading is unknown again. */
const MAX_PAGE_AGE_MS = 15 * 60_000;
const MAX_ENTRIES = 2_000;

/** A coin's newest page: its trades, and whether they are its whole history (no older page). */
const pages = new Map<string, { atMs: number; trades: TapeTrade[]; complete: boolean }>();
let pagesRead = 0;
let pagesFailed = 0;

/** Pages read and failed since the last call, for the scan's heartbeat (10 credits a page read). */
export function takeLiveTapeStats(): { pages: number; failed: number; credits: number; coins: number } {
  const out = {
    pages: pagesRead,
    failed: pagesFailed,
    credits: 10 * (pagesRead + pagesFailed),
    coins: pages.size,
  };
  pagesRead = 0;
  pagesFailed = 0;
  return out;
}

/** Test hook. */
export function resetLiveTape(): void {
  pages.clear();
  takeLiveTapeStats();
}

/**
 * Reads the newest page for the first `maxPages` of `mints` (priority order) whose page is
 * missing or older than `refreshMs`. Never rejects.
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
  },
): Promise<void> {
  if (!helius.gtfaUsable || opts.maxPages <= 0) return;
  const now = opts.nowMs ?? Date.now();
  const due = mints
    .filter((m) => {
      const page = pages.get(m);
      return !page || now - page.atMs >= opts.refreshMs;
    })
    .slice(0, opts.maxPages);
  await Promise.all(
    due.map(async (mint) => {
      try {
        const page = await helius.getMintTransactionsPage(mint, { newest: true });
        if (page.status !== "ok") {
          if (page.status === "failed") pagesFailed += 1;
          return;
        }
        pagesRead += 1;
        pages.delete(mint);
        const { trades } = await tradesFromChainTransactionsPriced(mint, page.txs, opts.solPrices);
        pages.set(mint, { atMs: now, trades, complete: page.paginationToken === null });
        if (pages.size > MAX_ENTRIES) {
          const oldest = pages.keys().next().value;
          if (oldest !== undefined) pages.delete(oldest);
        }
      } catch (err) {
        pagesFailed += 1;
        logger.warn("live tape page failed", { mint, error: String(err) });
      }
    }),
  );
}

/** How many wallets matching `is` traded in a coin's recent page, or null without a recent page. */
export function liveTradersOf(
  mint: string,
  is: ((wallet: string) => boolean) | undefined,
  nowMs = Date.now(),
): LiveTraderCounts | null {
  const page = pages.get(mint);
  if (!is || !page || nowMs - page.atMs > MAX_PAGE_AGE_MS) return null;
  return liveTraders(page.trades, is);
}

/** The flagged-wallet reading for a coin, or null without a recent page or the risk scores. */
export function liveFlagsOf(
  mint: string,
  lookup: ((wallet: string) => ScoredWallet | undefined) | undefined,
  nowMs = Date.now(),
): LiveFlagsReading | null {
  const page = pages.get(mint);
  if (!lookup || !page || nowMs - page.atMs > MAX_PAGE_AGE_MS) return null;
  return liveFlags(page.trades, lookup);
}

/** A window reading older than this is no longer the last five minutes. */
const MAX_WINDOW_PAGE_AGE_MS = 5 * 60_000;

/**
 * The 5m order flow read from a coin's recent page (core's chainWindowFlow), for a coin the
 * PumpPortal stream doesn't carry (a Stonks coin); null without a page read in the last five
 * minutes. Read as of when the page was read.
 */
export function liveWindowFlowOf(mint: string, nowMs = Date.now()): TradeFlowFeatures | null {
  const page = pages.get(mint);
  if (!page || nowMs - page.atMs > MAX_WINDOW_PAGE_AGE_MS) return null;
  return chainWindowFlow(page.trades, page.atMs, page.complete);
}
