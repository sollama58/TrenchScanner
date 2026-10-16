import {
  CANDIDATE_EXTENDED_WATCH_HOURS,
  createLogger,
  FAST_EXIT_MS,
  orderTrades,
  prisma,
  PUMP_SUPPLY_TOKENS,
  TAPE_TRADES_PER_WALLET,
  associatedTokenAddress,
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
 * floor, it is closed once:
 *  1. Its holders now are read (getProgramAccountsV2 on the mint, 1 credit a page), and each wallet
 *     on its tape that held tokens at the window's end and holds less now is a seller.
 *  2. Each seller's token account of the coin lists every transaction that moved it
 *     (getSignaturesForAddress, 1 credit; both token programs' associated account for a wallet
 *     whose account is gone), and those after the window are read (getTransaction, 1 credit each).
 *  3. Their trades are folded into the sellers' rows: buys and sells, SOL and tokens, first buy and
 *     sell, and the stored trades, each with its own time and amount.
 * A wallet that still holds what it held needs nothing read: "holding" is right for it.
 *
 * It reads by wallet, not the mint's whole tape after the window, on purpose: a called coin's
 * first day after its call often runs to thousands of trades (the first coin the mint-wide read
 * met in production took its whole 30-page cap and stored nothing), while the tape's holders who
 * sold are a few dozen accounts. MAX_SELLERS_PER_COIN (largest holdings first) and
 * MAX_TX_PER_COIN bound one coin to about 150 credits; a wallet whose transactions don't all fit
 * is left as it was rather than given part of its trades.
 *
 * Only wallets already on the tape are updated. A wallet that first bought after the window is not
 * added: the tape's rows are the coin's traders up to its call (what the wallet book scores), and
 * a late buyer of a dead coin is not one of them. What a row says about the call itself (held at
 * the anchor, top 10, sold into the stop, launch roles) is read at the anchor and stays as it was.
 * A coin still over the floor is looked at again an hour later.
 */

/** Taped coins this far back are closed (the tape's own lookback): older ones keep their tape. */
const LOOKBACK_MS = 10 * 24 * 3_600_000;
/** The tracking window after a call: the extended watch of its grading row. */
export const CLOSING_AFTER_ANCHOR_MS = CANDIDATE_EXTENDED_WATCH_HOURS * 3_600_000;
/** The tape's sellers read per coin, largest holding at the window's end first. */
export const MAX_SELLERS_PER_COIN = 40;
/** Transactions read per coin (1 credit each). */
export const MAX_TX_PER_COIN = 100;
/** A holding this many whole tokens or less (a millionth of a Pump.fun supply) counts as none. */
const DUST_TOKENS = 1_000;
/** A coin still over the floor is looked at again this much later. */
const RECHECK_ALIVE_MS = 60 * 60_000;
const RETRY_FAILED_MS = 30 * 60_000;
/** A live figure this recent stands for the coin's market cap; older ones are asked for afresh. */
const FRESH_MCAP_MS = 30 * 60_000;
/** Coins whose market cap is asked for in one run at most (one DexScreener batch is 30). */
const MCAP_LOOKUPS_PER_RUN = 30;
/** Taped coins looked at per run for one to close. */
const CANDIDATES_PER_RUN = 200;
/** Both token programs: a closed account's program is not known, so both associated accounts are read. */
const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as const;

/** Runs' worth of budget the lane may save up while there is nothing to close. */
const MAX_BALANCE_RUNS = 5;

export interface ClosingCoin {
  tokenId: string;
  mint: string;
  windowEndMs: number;
}

/**
 * Credits the lane may still spend: each run adds its budget and a coin's reads take theirs, so
 * a coin dearer than one run's budget is paid off over the next runs and the long-run spend
 * stays at the budget (capped at a few runs' worth while there is nothing to close).
 */
let creditBalance = 0;

/** Test hook. */
export function resetClosingState(): void {
  creditBalance = 0;
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
      // "busy": left by the first, mint-wide version of this read; this one can close it.
      OR: [
        { closeStatus: null },
        { closeStatus: "busy" },
        { closeStatus: { in: ["waiting", "failed"] }, closeRetryAt: { lte: now } },
      ],
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

/** The figures of a tape row the closing read needs to find its sellers and fold their trades. */
const ROW_SELECT = {
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
} as const;

type TapeRow = ClosingRow & { id: string; wallet: string };

/** What the tape says a wallet held at the window's end, in whole tokens. */
export function heldAtWindowEnd(row: Pick<ClosingRow, "tokensBought" | "tokensSold">): number {
  return Math.max(0, row.tokensBought - row.tokensSold);
}

/**
 * The tape's wallets that held tokens at the window's end and hold less now (`nowTokens`: whole
 * tokens by wallet; a wallet missing holds none), largest holding first, at most
 * MAX_SELLERS_PER_COIN. Exported for tests.
 */
export function sellersOf<R extends Pick<TapeRow, "wallet" | "tokensBought" | "tokensSold">>(
  rows: readonly R[],
  nowTokens: ReadonlyMap<string, number>,
): R[] {
  return rows
    .filter((r) => {
      const held = heldAtWindowEnd(r);
      return held > DUST_TOKENS && (nowTokens.get(r.wallet) ?? 0) < held - Math.max(DUST_TOKENS, held * 0.01);
    })
    .sort((a, b) => heldAtWindowEnd(b) - heldAtWindowEnd(a))
    .slice(0, MAX_SELLERS_PER_COIN);
}

/**
 * Folds the sellers' trades into their rows and marks the tape closed. `tradesOf`: each wallet's
 * trades after the window, for the wallets read in full (an empty list for one that moved the coin
 * without trading it, a transfer).
 */
export async function storeClosing(
  coin: ClosingCoin,
  rows: readonly TapeRow[],
  tradesOf: ReadonlyMap<string, TapeTrade[]>,
  read: { closeAtMs: number; credits: number },
): Promise<{ wallets: number; trades: number }> {
  let wallets = 0;
  let trades = 0;
  await prisma.$transaction(
    async (tx) => {
      for (const row of rows) {
        const own = orderTrades(tradesOf.get(row.wallet) ?? []).filter(
          (t) => t.wallet === row.wallet && t.atMs > coin.windowEndMs && t.atMs <= read.closeAtMs,
        );
        if (own.length === 0) continue;
        const next = foldClosingTrades(row, own);
        await tx.tokenWalletActivity.update({
          where: { id: row.id },
          data: { ...next, trades: next.trades as unknown as Prisma.InputJsonValue },
        });
        wallets += 1;
        trades += own.length;
      }
      await tx.tokenTradeTape.update({
        where: { tokenId: coin.tokenId },
        data: {
          closeStatus: "done",
          closeRetryAt: null,
          closedThrough: new Date(read.closeAtMs),
          closeTrades: trades,
          closeCalls: read.credits,
        },
      });
    },
    { timeout: 30_000 },
  );
  return { wallets, trades };
}

async function markFailed(coin: ClosingCoin, credits: number, nowMs: number) {
  await prisma.tokenTradeTape.update({
    where: { tokenId: coin.tokenId },
    data: { closeStatus: "failed", closeRetryAt: new Date(nowMs + RETRY_FAILED_MS), closeCalls: credits },
  });
}

/** A wallet's associated account of a coin under either program; none for an address that won't derive. */
function associatedAccountsOf(wallet: string, mint: string): string[] {
  try {
    return TOKEN_PROGRAMS.map((p) => associatedTokenAddress(wallet, mint, p));
  } catch {
    return [];
  }
}

export interface ClosingCounts {
  closingDone: number;
  closingFailed: number;
  /** Tape wallets found to have sold since the window, and those whose trades were folded in. */
  closingSellers: number;
  closingWallets: number;
  closingCredits: number;
}

export type ClosingHelius = Pick<
  HeliusClient,
  "getTopHoldersBatch" | "getAccountSignaturesBatch" | "getTransactionsBatch"
>;

/**
 * Closes one coin (see the note at the top). Returns the credits spent, or "failed" with them when
 * a read got no usable answer (the coin is retried later).
 */
export async function closeCoin(
  coin: ClosingCoin,
  helius: ClosingHelius,
  solPrices: SolPriceLookup | undefined,
  counts: ClosingCounts,
  nowMs: number,
): Promise<number> {
  let credits = 0;
  const holders = (await helius.getTopHoldersBatch([coin.mint], Number.MAX_SAFE_INTEGER)).get(coin.mint);
  // A mint's program and supply (getMultipleAccounts), then its token accounts: a page in nearly all cases.
  credits += 2;
  if (!holders || holders.status !== "found") {
    await markFailed(coin, credits, nowMs);
    counts.closingFailed += 1;
    return credits;
  }
  const nowTokens = new Map(holders.holders.map((h) => [h.owner, (h.pct / 100) * PUMP_SUPPLY_TOKENS]));
  const accountsNow = new Map(holders.holders.map((h) => [h.owner, h.accounts ?? []]));
  const rows: TapeRow[] = await prisma.tokenWalletActivity.findMany({
    where: { tokenId: coin.tokenId },
    select: ROW_SELECT,
  });
  const sellers = sellersOf(rows, nowTokens);
  counts.closingSellers += sellers.length;

  // Each seller's accounts of the coin: the ones it still has, else its associated account under
  // either program (the history of a closed account can still be read).
  const accountsOf = new Map(
    sellers.map((r) => {
      const own = accountsNow.get(r.wallet) ?? [];
      return [r.wallet, own.length > 0 ? own : associatedAccountsOf(r.wallet, coin.mint)] as const;
    }),
  );
  const reads = [...accountsOf.values()].flat().map((address) => ({ address }));
  const pages = reads.length > 0 ? await helius.getAccountSignaturesBatch(reads) : new Map();
  credits += reads.length;

  // The transactions after the window, a whole wallet at a time within MAX_TX_PER_COIN.
  // A read with no usable answer fails the coin whole (retried later): stored part-way, a retry
  // would fold the same trades in twice.
  if (
    [...pages.values()].some((p) => p.status !== "found") ||
    pages.size < new Set(reads.map((r) => r.address)).size
  ) {
    await markFailed(coin, credits, nowMs);
    counts.closingFailed += 1;
    return credits;
  }
  const sigsOf = new Map<string, string[]>();
  let txBudget = MAX_TX_PER_COIN;
  for (const r of sellers) {
    const sigs = new Set<string>();
    let readable = true;
    for (const a of accountsOf.get(r.wallet)!) {
      const page = pages.get(a);
      if (!page || page.status !== "found") {
        readable = false;
        break;
      }
      for (const sig of page.signatures) {
        if (sig.ok && sig.atMs !== null && sig.atMs > coin.windowEndMs) sigs.add(sig.signature);
      }
      // A full page may have dropped older signatures that still fall after the window.
      const oldest = page.signatures.at(-1)?.atMs ?? null;
      if (page.full && (oldest === null || oldest > coin.windowEndMs)) readable = false;
    }
    if (!readable || sigs.size > txBudget) continue;
    txBudget -= sigs.size;
    sigsOf.set(r.wallet, [...sigs]);
  }
  const wanted = [...new Set([...sigsOf.values()].flat())];
  const txs = wanted.length > 0 ? await helius.getTransactionsBatch(wanted) : new Map();
  credits += wanted.length;
  const tradesOf = new Map<string, TapeTrade[]>();
  const byWallet = new Map<string, TapeTrade[]>();
  const found = wanted.flatMap((sig) => {
    const tx = txs.get(sig);
    return tx && tx !== "failed" ? [tx] : [];
  });
  if (found.length > 0) {
    const parsed = await tradesFromChainTransactionsPriced(coin.mint, found, solPrices);
    for (const t of parsed.trades) {
      const list = byWallet.get(t.wallet);
      if (list) list.push(t);
      else byWallet.set(t.wallet, [t]);
    }
  }
  if (wanted.some((sig) => txs.get(sig) === "failed" || txs.get(sig) === undefined)) {
    await markFailed(coin, credits, nowMs);
    counts.closingFailed += 1;
    return credits;
  }
  for (const wallet of sigsOf.keys()) tradesOf.set(wallet, byWallet.get(wallet) ?? []);
  const stored = await storeClosing(
    coin,
    rows.filter((r) => tradesOf.has(r.wallet)),
    tradesOf,
    { closeAtMs: nowMs, credits },
  );
  counts.closingDone += 1;
  counts.closingWallets += stored.wallets;
  return credits;
}

/**
 * Closes coins while the lane has credits (see creditBalance): `budget` a run, and up to
 * MAX_BALANCE_RUNS runs' worth saved while there was nothing to close.
 */
export async function runClosingLane(
  deps: {
    helius: ClosingHelius;
    solPrices?: SolPriceLookup;
    marketCaps?: MarketCapLookup;
  },
  opts: { budget: number; floorUsd: number },
  counts: ClosingCounts,
  now: () => number,
): Promise<void> {
  if (opts.floorUsd <= 0 || opts.budget <= 0) return;
  creditBalance = Math.min(creditBalance + opts.budget, opts.budget * MAX_BALANCE_RUNS);
  const tried = new Set<string>();
  while (creditBalance > 0) {
    const coin = await nextClosingCoin(now(), opts.floorUsd, deps.marketCaps, tried);
    if (!coin) return;
    tried.add(coin.tokenId);
    const spent = await closeCoin(coin, deps.helius, deps.solPrices, counts, now());
    creditBalance -= spent;
    counts.closingCredits += spent;
  }
}
