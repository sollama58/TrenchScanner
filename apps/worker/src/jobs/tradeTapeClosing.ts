import {
  CANDIDATE_EXTENDED_WATCH_HOURS,
  createLogger,
  FAST_EXIT_MS,
  orderTrades,
  prisma,
  PUMP_SUPPLY_TOKENS,
  TAPE_TRADES_PER_WALLET,
  tradesFromChainTransactionsPriced,
  walletTrades,
  type HeliusClient,
  type Prisma,
  type SolPriceLookup,
  type StoredTrade,
  type TapeTrade,
} from "@trenchscanner/core";

const logger = createLogger("trade-tape-closing");

/**
 * The trade tape's closing read (user ask 2026-10-16).
 *
 * A coin's tape (tradeTapeJob.ts) covers its trades from the launch to 30 minutes past its call,
 * so a wallet still holding then read as "holding" for good, on the token view's flagged wallets
 * and the wallet pages, however and whenever it sold later. And once a coin is under
 * LOW_CAP_MCAP_USD the scan stops reading it beyond its market cap (lowCap.ts). So when a taped
 * coin is past its tracking window (the call plus the 24-hour extended watch) and still under the
 * floor, its trades from the tape's end to now are read once - Helius getTransactionsForAddress on
 * the mint, oldest first, from the window's end - and folded into the wallets already on its tape:
 * their buys and sells, SOL and tokens, first buy and sell, and their stored trades with each
 * trade's own time and amount. A coin still over the floor is looked at again an hour later.
 *
 * Only wallets already on the tape are updated. A wallet that first bought after the window is not
 * added: the tape's rows are the coin's traders up to its call (what the wallet book scores), and
 * a late buyer of a dead coin is not one of them. What a row says about the call itself (held at
 * the anchor, top 10, sold into the stop, launch roles) is read at the anchor and stays as it was.
 */

/** Taped coins this far back are closed (the tape's own lookback): older ones keep their tape. */
const LOOKBACK_MS = 10 * 24 * 3_600_000;
/** The tracking window after a call: the extended watch of its grading row. */
export const CLOSING_AFTER_ANCHOR_MS = CANDIDATE_EXTENDED_WATCH_HOURS * 3_600_000;
/** 3,000 trades after the window, 300 credits: past it the coin was not dead, and is left as it was. */
export const CLOSING_MAX_PAGES_PER_COIN = 30;
/** A coin still over the floor is looked at again this much later. */
const RECHECK_ALIVE_MS = 60 * 60_000;
const RETRY_FAILED_MS = 30 * 60_000;
/** A live figure this recent stands for the coin's market cap; older ones are asked for afresh. */
const FRESH_MCAP_MS = 30 * 60_000;
/** Coins whose market cap is asked for in one run at most (one DexScreener batch is 30). */
const MCAP_LOOKUPS_PER_RUN = 30;
/** Taped coins looked at per run for one to close. */
const CANDIDATES_PER_RUN = 200;

export interface ClosingCoin {
  tokenId: string;
  mint: string;
  windowEndMs: number;
}

interface ClosingProgress {
  coin: ClosingCoin;
  /** The read stops here: the moment it started. */
  closeAtMs: number;
  trades: TapeTrade[];
  calls: number;
  cursor: string | undefined;
  errors: number;
}

let progress: ClosingProgress | null = null;

/** Test hook. */
export function resetClosingState(): void {
  progress = null;
}

/**
 * The market caps of some mints: null for a mint with no market (delisted, no pair), and a mint
 * whose lookup failed left out (unknown, asked again next run).
 */
export type MarketCapLookup = (mints: string[]) => Promise<ReadonlyMap<string, number | null>>;

/**
 * The next taped coin to close: past its tracking window, within the lookback, not closed yet, and
 * under `floorUsd` by its freshest market cap. Coins found over the floor are marked "waiting" for
 * RECHECK_ALIVE_MS. A coin no market answers for (delisted, its pool pulled) counts as dead.
 */
export async function nextClosingCoin(
  nowMs: number,
  floorUsd: number,
  marketCaps: MarketCapLookup | undefined,
  skip: ReadonlySet<string> = new Set(),
): Promise<ClosingCoin | null> {
  const now = new Date(nowMs);
  const tapes = await prisma.tokenTradeTape.findMany({
    where: {
      status: { in: ["done", "partial"] },
      anchorAt: { gte: new Date(nowMs - LOOKBACK_MS), lte: new Date(nowMs - CLOSING_AFTER_ANCHOR_MS) },
      OR: [{ closeStatus: null }, { closeStatus: { in: ["waiting", "failed"] }, closeRetryAt: { lte: now } }],
    },
    select: {
      tokenId: true,
      windowEnd: true,
      token: {
        select: {
          mintAddress: true,
          liveMarketCapUsd: true,
          liveDataAt: true,
          lastMcapUsd: true,
          lastLiveAt: true,
        },
      },
    },
    orderBy: { anchorAt: "desc" },
    take: CANDIDATES_PER_RUN,
  });
  const open = tapes.filter((t) => !skip.has(t.tokenId));
  if (open.length === 0) return null;
  const fresh = (at: Date | null) => at !== null && nowMs - at.getTime() <= FRESH_MCAP_MS;
  const known = new Map<string, number>();
  for (const t of open) {
    const live = fresh(t.token.liveDataAt) ? t.token.liveMarketCapUsd : null;
    const last = fresh(t.token.lastLiveAt) ? t.token.lastMcapUsd : null;
    const newest =
      live !== null && last !== null
        ? t.token.liveDataAt!.getTime() >= t.token.lastLiveAt!.getTime()
          ? live
          : last
        : (live ?? last);
    if (newest !== null && newest > 0) known.set(t.tokenId, newest);
  }
  const unknown = open.filter((t) => !known.has(t.tokenId)).slice(0, MCAP_LOOKUPS_PER_RUN);
  if (unknown.length > 0 && marketCaps) {
    try {
      const caps = await marketCaps(unknown.map((t) => t.token.mintAddress));
      // A source answering every lookup with nothing (DexScreener did on 2026-10-07) says nothing
      // about the coins: none is judged dead on it.
      const blank = unknown.length >= 5 && ![...caps.values()].some((c) => c !== null && c > 0);
      if (blank) logger.warn("no market cap came back for any coin - judging none dead this run");
      for (const t of unknown) {
        if (blank || !caps.has(t.token.mintAddress)) continue;
        // No market at all: nothing trades it any more.
        known.set(t.tokenId, caps.get(t.token.mintAddress) ?? 0);
      }
    } catch (err) {
      logger.warn("market caps for closing reads failed - trying again next run", { error: String(err) });
    }
  }
  const alive = open.filter((t) => known.has(t.tokenId) && known.get(t.tokenId)! >= floorUsd);
  if (alive.length > 0) {
    await prisma.tokenTradeTape.updateMany({
      where: { tokenId: { in: alive.map((t) => t.tokenId) } },
      data: { closeStatus: "waiting", closeRetryAt: new Date(nowMs + RECHECK_ALIVE_MS) },
    });
  }
  const dead = open.find((t) => known.has(t.tokenId) && known.get(t.tokenId)! < floorUsd);
  return dead
    ? { tokenId: dead.tokenId, mint: dead.token.mintAddress, windowEndMs: dead.windowEnd.getTime() }
    : null;
}

/** The figures a TokenWalletActivity row carries that later trades change. */
export interface ClosingRow {
  buys: number;
  sells: number;
  solIn: number;
  solOut: number;
  tokensBought: number;
  tokensSold: number;
  firstBuyAt: Date | null;
  firstSellAt: Date | null;
  boughtPct: number | null;
  fastExit: boolean;
  trades: Prisma.JsonValue;
}

export type ClosingUpdate = Omit<ClosingRow, "trades"> & { trades: StoredTrade[] };

/**
 * A wallet's row with its trades after the window folded in (`trades`: that wallet's, oldest
 * first). Exported for tests. The stored trades keep the first and last halves past
 * TAPE_TRADES_PER_WALLET, as the tape does. A row read before the tape kept every trade (null
 * trades) keeps only the later ones.
 */
export function foldClosingTrades(row: ClosingRow, trades: readonly TapeTrade[]): ClosingUpdate {
  const out: ClosingUpdate = {
    buys: row.buys,
    sells: row.sells,
    solIn: row.solIn,
    solOut: row.solOut,
    tokensBought: row.tokensBought,
    tokensSold: row.tokensSold,
    firstBuyAt: row.firstBuyAt,
    firstSellAt: row.firstSellAt,
    boughtPct: row.boughtPct,
    fastExit: row.fastExit,
    trades: [],
  };
  let bought = 0;
  for (const t of trades) {
    if (t.side === "buy") {
      out.buys += 1;
      out.solIn += t.sol;
      out.tokensBought += t.tokens;
      bought += t.tokens;
      out.firstBuyAt ??= new Date(t.atMs);
    } else {
      out.sells += 1;
      out.solOut += t.sol;
      out.tokensSold += t.tokens;
      out.firstSellAt ??= new Date(t.atMs);
    }
  }
  if (bought > 0) out.boughtPct = (row.boughtPct ?? 0) + (bought / PUMP_SUPPLY_TOKENS) * 100;
  out.fastExit =
    out.firstBuyAt !== null &&
    out.firstSellAt !== null &&
    out.firstSellAt.getTime() - out.firstBuyAt.getTime() <= FAST_EXIT_MS;
  const before = Array.isArray(row.trades) ? (row.trades as unknown as StoredTrade[]) : [];
  const after = walletTrades(trades).get(trades[0]?.wallet ?? "") ?? [];
  const all = [...before, ...after];
  const half = TAPE_TRADES_PER_WALLET / 2;
  out.trades = all.length > TAPE_TRADES_PER_WALLET ? [...all.slice(0, half), ...all.slice(-half)] : all;
  return out;
}

/** Folds a finished closing read into the tape's wallets and marks the tape closed. */
export async function storeClosing(
  coin: ClosingCoin,
  read: { trades: TapeTrade[]; closeAtMs: number; calls: number },
): Promise<{ wallets: number; trades: number }> {
  const trades = orderTrades(read.trades).filter(
    (t) => t.atMs > coin.windowEndMs && t.atMs <= read.closeAtMs,
  );
  const byWallet = new Map<string, TapeTrade[]>();
  for (const t of trades) {
    const list = byWallet.get(t.wallet);
    if (list) list.push(t);
    else byWallet.set(t.wallet, [t]);
  }
  const rows = await prisma.tokenWalletActivity.findMany({
    where: { tokenId: coin.tokenId, wallet: { in: [...byWallet.keys()] } },
    select: {
      id: true,
      wallet: true,
      buys: true,
      sells: true,
      solIn: true,
      solOut: true,
      tokensBought: true,
      tokensSold: true,
      firstBuyAt: true,
      firstSellAt: true,
      boughtPct: true,
      fastExit: true,
      trades: true,
    },
  });
  await prisma.$transaction(
    async (tx) => {
      for (const row of rows) {
        const next = foldClosingTrades(row, byWallet.get(row.wallet)!);
        await tx.tokenWalletActivity.update({
          where: { id: row.id },
          data: { ...next, trades: next.trades as unknown as Prisma.InputJsonValue },
        });
      }
      await tx.tokenTradeTape.update({
        where: { tokenId: coin.tokenId },
        data: {
          closeStatus: "done",
          closeRetryAt: null,
          closedThrough: new Date(read.closeAtMs),
          closeTrades: trades.length,
          closeCalls: read.calls,
        },
      });
    },
    { timeout: 30_000 },
  );
  return { wallets: rows.length, trades: trades.length };
}

async function markClosing(coin: ClosingCoin, status: "busy" | "failed", calls: number, nowMs: number) {
  await prisma.tokenTradeTape.update({
    where: { tokenId: coin.tokenId },
    data: {
      closeStatus: status,
      closeRetryAt: status === "failed" ? new Date(nowMs + RETRY_FAILED_MS) : null,
      closeCalls: calls,
    },
  });
}

export interface ClosingCounts {
  closingDone: number;
  closingBusy: number;
  closingFailed: number;
  closingWallets: number;
  closingPages: number;
}

/**
 * Spends up to `budget` Helius pages on closing reads, one coin at a time; a coin not finished
 * carries over to the next run. `skip`: coins another lane is reading right now.
 */
export async function runClosingLane(
  deps: {
    helius: Pick<HeliusClient, "getMintTransactionsPage" | "gtfaUsable">;
    solPrices?: SolPriceLookup;
    marketCaps?: MarketCapLookup;
  },
  opts: { budget: number; floorUsd: number; skip?: ReadonlySet<string> },
  counts: ClosingCounts,
  now: () => number,
): Promise<void> {
  let budget = opts.budget;
  if (opts.floorUsd <= 0) return;
  while (budget > 0 && deps.helius.gtfaUsable) {
    if (!progress) {
      const coin = await nextClosingCoin(now(), opts.floorUsd, deps.marketCaps, opts.skip);
      if (!coin) return;
      progress = { coin, closeAtMs: now(), trades: [], calls: 0, cursor: undefined, errors: 0 };
    }
    const p = progress;
    const page = await deps.helius.getMintTransactionsPage(p.coin.mint, {
      paginationToken: p.cursor,
      sinceBlockTime: Math.floor(p.coin.windowEndMs / 1000),
      untilBlockTime: Math.ceil(p.closeAtMs / 1000),
    });
    budget -= 1;
    counts.closingPages += 1;
    p.calls += 1;
    if (page.status === "unsupported") {
      progress = null;
      return;
    }
    if (page.status === "failed") {
      p.errors += 1;
      if (p.errors >= 3) {
        await markClosing(p.coin, "failed", p.calls, now());
        counts.closingFailed += 1;
        progress = null;
      }
      continue;
    }
    const parsed = await tradesFromChainTransactionsPriced(p.coin.mint, page.txs, deps.solPrices);
    p.trades.push(...parsed.trades);
    p.cursor = page.paginationToken ?? undefined;
    const lastAtMs = Math.max(0, ...page.txs.map((t) => (t.blockTime ?? 0) * 1000));
    if (!page.paginationToken || lastAtMs > p.closeAtMs) {
      const stored = await storeClosing(p.coin, { trades: p.trades, closeAtMs: p.closeAtMs, calls: p.calls });
      counts.closingDone += 1;
      counts.closingWallets += stored.wallets;
      progress = null;
    } else if (p.calls >= CLOSING_MAX_PAGES_PER_COIN) {
      await markClosing(p.coin, "busy", p.calls, now());
      counts.closingBusy += 1;
      progress = null;
    }
  }
}

/** The coin the closing lane is part way through, if any. */
export function closingInProgress(): string | undefined {
  return progress?.coin.tokenId;
}
