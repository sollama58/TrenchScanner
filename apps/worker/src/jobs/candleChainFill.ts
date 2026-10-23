import {
  createLogger,
  markTapeTrades,
  prisma,
  subtractSpans,
  tradesFromChainTransactions,
  type HeliusClient,
} from "@trenchscanner/core";
import { saveChainCandles, type TapeCandleSink } from "./chainCandles.js";

const logger = createLogger("candle-chain-fill");

/**
 * The chart's chain fill (user decision 2026-10-23, "Free steps first", step 6): the stretches of a
 * charted or called coin's first hours that no source holds at 1 second (the curve tape didn't
 * follow it yet, the trade tape doesn't read it) are read off the chain, Helius
 * getTransactionsForAddress on the mint from the hole's start (10 credits a page of 100), and saved
 * as "tape" candles from each trade's swap event (chainCandles.ts). Stateless: each page's saved
 * cover shrinks the hole, so the next run asks for what is left. A day's credits are capped
 * (CANDLE_CHAIN_FILL_CREDITS_PER_DAY), and so are a coin's pages a day, so a busy coin can't take
 * the day's budget.
 */

/** Credits a page of getTransactionsForAddress costs. */
const PAGE_CREDITS = 10;
/** Coins whose chart opened or which were called within this long are filled. */
const RECENT_MS = 6 * 3_600_000;
/** Candidates looked at a run, the newest asks first. */
const CANDIDATES = 50;
/** A hole shorter than this is left: the chart draws it blank, and it costs a page. */
const MIN_HOLE_MS = 15_000;
/** The newest stretch is the live tapes' to save: the fill stays this far behind now. */
const SETTLE_MS = 3 * 60_000;
/**
 * The store reads chunks starting up to five hours before what it is asked for; their covers can
 * run on past their own span (tapeCandles.ts), so the covers are looked for this far back.
 */
const COVER_LOOKBACK_MS = 5 * 3_600_000;
const DAY_MS = 86_400_000;
/** As tapeCandles.ts: a cover runs on at most this far past its chunk's start. */
const QUIET_COVER_MAX_MS = 4 * 3_600_000;

export interface ChainFillDeps {
  helius: Pick<HeliusClient, "getMintTransactionsPage" | "gtfaUsable"> &
    Partial<Pick<HeliusClient, "getPoolVaultsBatch">>;
  sink: TapeCandleSink;
}

export interface ChainFillOptions {
  creditsPerDay: number;
  pagesPerRun: number;
  maxPagesPerCoin: number;
  /** From the launch, how much of a coin's life is filled. */
  windowMinutes: number;
  now?: () => number;
}

let day = -1;
let spent = 0;
/** Pages read today per coin, and coins left for the day (a page that moved the hole nowhere). */
const coinPages = new Map<string, number>();
const stuck = new Set<string>();
let stats = { pages: 0, rows: 0, coins: 0, failed: 0 };

/**
 * The parts of [from, to) no 1-second chunk of the coin covers, oldest first, those shorter than
 * MIN_HOLE_MS left out. Visible for tests.
 */
export async function oneSecondHoles(mint: string, from: number, to: number): Promise<[number, number][]> {
  if (!(to > from)) return [];
  const rows = await prisma.candleChunk.findMany({
    where: {
      mint,
      res: 1,
      startAt: { gte: new Date(from - COVER_LOOKBACK_MS), lt: new Date(to) },
      coverTo: { gt: new Date(from) },
    },
    select: { coverFrom: true, coverTo: true },
    orderBy: { coverFrom: "asc" },
  });
  const covers: [number, number][] = [];
  for (const r of rows) {
    const span: [number, number] = [r.coverFrom.getTime(), r.coverTo.getTime()];
    const last = covers[covers.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else covers.push(span);
  }
  return subtractSpans([[from, to]], covers).filter(([a, b]) => b - a >= MIN_HOLE_MS);
}

/** Coins to fill: called or charted lately, the newest asks first. */
async function candidates(now: number) {
  const rows = await prisma.candleBackfill.findMany({
    where: { requestedAt: { gte: new Date(now - RECENT_MS) } },
    orderBy: { requestedAt: "desc" },
    take: CANDIDATES,
    select: { mint: true },
  });
  const tokens = await prisma.token.findMany({
    where: { mintAddress: { in: rows.map((r) => r.mint) } },
    select: { mintAddress: true, launchedAt: true, firstSeenAt: true },
  });
  const born = new Map(tokens.map((t) => [t.mintAddress, (t.launchedAt ?? t.firstSeenAt).getTime()]));
  return rows.flatMap((r) => (born.has(r.mint) ? [{ mint: r.mint, bornAt: born.get(r.mint)! }] : []));
}

/** One run: up to `pagesPerRun` pages, each the start of a coin's oldest hole. Never rejects. */
export async function runCandleChainFill(deps: ChainFillDeps, opts: ChainFillOptions): Promise<void> {
  const now = (opts.now ?? Date.now)();
  const today = Math.floor(now / DAY_MS);
  if (today !== day) {
    day = today;
    spent = 0;
    coinPages.clear();
    stuck.clear();
  }
  if (!deps.helius.gtfaUsable || opts.creditsPerDay <= 0) return;
  let pages = 0;
  try {
    for (const coin of await candidates(now)) {
      if (pages >= opts.pagesPerRun || spent + PAGE_CREDITS > opts.creditsPerDay) break;
      if (stuck.has(coin.mint)) continue;
      const end = Math.min(coin.bornAt + opts.windowMinutes * 60_000, now - SETTLE_MS);
      const holes = await oneSecondHoles(coin.mint, coin.bornAt, end);
      let filled = false;
      for (const [from, to] of holes) {
        if (pages >= opts.pagesPerRun || spent + PAGE_CREDITS > opts.creditsPerDay) break;
        if ((coinPages.get(coin.mint) ?? 0) >= opts.maxPagesPerCoin) break;
        const moved = await fillPage(deps, coin.mint, from, to);
        pages += 1;
        // Helius bills no failed answer.
        if (moved !== "failed") spent += PAGE_CREDITS;
        coinPages.set(coin.mint, (coinPages.get(coin.mint) ?? 0) + 1);
        filled = true;
        // One page a coin a run unless it closed the hole whole: the next run sees what is left.
        if (moved !== "closed") {
          if (moved === "stuck") stuck.add(coin.mint);
          break;
        }
      }
      if (filled) stats.coins += 1;
    }
  } catch (err) {
    stats.failed += 1;
    logger.warn("chart chain fill failed", { error: String(err) });
  }
  stats.pages += pages;
}

/**
 * Reads one page of the coin's trades from `from` and saves them over what it read: to the hole's
 * end when the page held the rest, else to the newest second it reached. A stretch with no trade
 * (before the first bar it saved, or the whole page) is vouched for by the chunk the hole starts
 * after, its cover run on over it. "closed": the hole is filled; "moved": part of it; "failed":
 * no answer; "stuck": nothing could be saved from where the hole starts, so the coin waits a day.
 */
async function fillPage(
  deps: ChainFillDeps,
  mint: string,
  from: number,
  to: number,
): Promise<"closed" | "moved" | "failed" | "stuck"> {
  const page = await deps.helius.getMintTransactionsPage(mint, {
    fromBlockTime: Math.floor(from / 1_000),
    untilBlockTime: Math.ceil(to / 1_000),
  });
  if (page.status !== "ok") return "failed";
  const txs = page.txs.filter((t) => typeof t.blockTime === "number");
  const newest = Math.max(0, ...txs.map((t) => t.blockTime! * 1_000));
  const whole = page.paginationToken === null || newest >= to;
  const coverTo = whole ? to : newest;
  if (!(coverTo > from)) return "stuck";
  const { trades } = tradesFromChainTransactions(mint, txs);
  markTapeTrades(mint, txs, trades);
  const rows = await saveChainCandles(mint, trades, { from, to: coverTo }, deps.sink, deps.helius);
  stats.rows += rows.length;
  const savedFrom = rows[0]?.coverFrom ?? coverTo;
  if (savedFrom > from && !(await coverQuiet(mint, from, savedFrom))) return "stuck";
  return whole ? "closed" : "moved";
}

/**
 * Runs the cover of the 1-second chunk ending where a hole starts (`from`) on to `to`: the chain
 * holds no trade between. Only a chunk starting within four hours of `to`, so the store still finds
 * it (tapeCandles.ts). False when there is none.
 */
async function coverQuiet(mint: string, from: number, to: number): Promise<boolean> {
  const moved = await prisma.candleChunk.updateMany({
    where: { mint, res: 1, coverTo: new Date(from), startAt: { gte: new Date(to - QUIET_COVER_MAX_MS) } },
    data: { coverTo: new Date(to) },
  });
  return moved.count > 0;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

/** Starts the minute run; returns its stop. */
export function startCandleChainFill(deps: ChainFillDeps, opts: ChainFillOptions) {
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void runCandleChainFill(deps, opts).finally(() => {
      busy = false;
    });
  }, 60_000);
  timer.unref?.();
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/** Counts since the last call, with the day's credits, for the scan's heartbeat; null while off. */
export function takeCandleChainFillStats() {
  if (!timer) return null;
  const out = { ...stats, creditsToday: spent };
  stats = { pages: 0, rows: 0, coins: 0, failed: 0 };
  return out;
}

/** Tests: a clean slate. */
export function resetCandleChainFill(): void {
  if (timer) clearInterval(timer);
  timer = null;
  busy = false;
  day = -1;
  spent = 0;
  coinPages.clear();
  stuck.clear();
  stats = { pages: 0, rows: 0, coins: 0, failed: 0 };
}
