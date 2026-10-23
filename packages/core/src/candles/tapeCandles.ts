import { pumpSwapPoolOf } from "../datasources/pumpSwapPool.js";
import { tradesFromLogs } from "../wallets/pumpTradeEvents.js";
import { PUMP_SUPPLY_TOKENS, type ChainTx, type TapeTrade, type TradeMark } from "../wallets/tradeTape.js";
import { chunkBars, type CandleChunkRow, type StoredBar } from "./candleChunk.js";

/**
 * Candles from the trade tape (user decision 2026-10-23, "Free steps first"): the trade tape job
 * (apps/worker tradeTapeJob.ts) already reads every trade of a called coin from its launch to 30
 * minutes past the call off the chain, so those trades are folded into 1-second bars and saved to
 * the candle store under "tape", for no call of their own. Each trade's price is the one its swap
 * event logged (pumpTradeEvents.ts), not what the trader paid: fees and tips are in that, and a buy
 * and a sell in the same second would read a few percent apart.
 */

const LAMPORTS_PER_SOL = 1e9;
/** Pump.fun coins have 6 decimals. */
const TOKEN_UNITS = 1e6;
/**
 * A quiet stretch after a chunk is vouched for by that chunk's cover, run on to the next chunk, for
 * at most this long past its start: the store reads chunks starting up to five hours before what
 * it is asked for (candleStore.ts), so a cover running on further would not be found.
 */
const QUIET_COVER_MAX_MS = 4 * 3_600_000;

/**
 * Sets `mark` on each of `trades` whose transaction logged a swap of `mint` (on its bonding curve,
 * or on its SOL PumpSwap pool): the last such event in the transaction. A coin quoted in another
 * coin gets none. Returns how many trades were marked.
 */
export function markTapeTrades(mint: string, txs: readonly ChainTx[], trades: TapeTrade[]): number {
  const pool = pumpSwapPoolOf(mint) ?? null;
  const marks = new Map<string, TradeMark>();
  for (const tx of txs) {
    const sig = tx?.transaction?.signatures?.[0];
    const logs = tx?.meta?.logMessages;
    if (!sig || !Array.isArray(logs) || tx.meta?.err) continue;
    let mark: TradeMark | null = null;
    for (const d of tradesFromLogs(logs, { mint, pool })) {
      if (d.sol === null) continue;
      if (d.pool) mark = { quote: d.pool.quoteReserve, base: d.pool.baseReserve };
      else if (d.priceSol !== null && d.priceSol > 0) mark = { curve: d.priceSol };
    }
    if (mark) marks.set(sig, mark);
  }
  let marked = 0;
  for (const t of trades) {
    const mark = marks.get(t.tx);
    if (!mark) continue;
    t.mark = mark;
    marked += 1;
  }
  return marked;
}

/** SOL per whole token a mark says, the pool's virtual quote reserve (lamports) added; null if none. */
export function markPriceSol(mark: TradeMark, poolVirtualQuote = 0): number | null {
  if ("curve" in mark) return mark.curve > 0 ? mark.curve : null;
  if (!(mark.base > 0) || !(mark.quote + poolVirtualQuote > 0)) return null;
  return (mark.quote + poolVirtualQuote) / LAMPORTS_PER_SOL / (mark.base / TOKEN_UNITS);
}

/**
 * The candle store's rows for a tape: 1-second market-cap bars (USD, on the launch billion) over
 * `cover` ([from, to) ms, what the read covered) from the marked trades, in chain order. Each bar
 * opens at the price the trade before it left, so bars join up; a second with no marked trade has
 * no bar. Volume: every trade's SOL in that second, at `solUsd`. Each chunk's cover runs on to the
 * next one's start, so a quiet stretch the tape read through reads as quiet, not unread.
 */
export function tapeCandleRows(
  mint: string,
  trades: readonly TapeTrade[],
  cover: { from: number; to: number },
  solUsd: number,
  poolVirtualQuote = 0,
): CandleChunkRow[] {
  if (!(solUsd > 0) || !(cover.to > cover.from)) return [];
  const second = (atMs: number) => Math.floor(atMs / 1_000) * 1_000;
  const volume = new Map<number, number>();
  for (const t of trades) {
    if (t.sol > 0) volume.set(second(t.atMs), (volume.get(second(t.atMs)) ?? 0) + t.sol * solUsd);
  }
  const bars: StoredBar[] = [];
  let prev: number | null = null;
  for (const t of trades) {
    const price = t.mark ? markPriceSol(t.mark, poolVirtualQuote) : null;
    if (price === null) continue;
    const v = price * PUMP_SUPPLY_TOKENS * solUsd;
    const at = second(t.atMs);
    const open = prev ?? v;
    prev = v;
    if (at < second(cover.from) || at >= cover.to) continue;
    let bar = bars[bars.length - 1];
    if (!bar || bar.t !== at) {
      bar = { t: at, o: open, h: Math.max(open, v), l: Math.min(open, v), c: v, vol: volume.get(at) ?? 0 };
      bars.push(bar);
    }
    bar.h = Math.max(bar.h, v);
    bar.l = Math.min(bar.l, v);
    bar.c = v;
  }
  const rows = chunkBars(mint, 1, "tape", bars, cover);
  rows.forEach((row, i) => {
    const next = rows[i + 1]?.startAt ?? cover.to;
    row.coverTo = Math.max(row.coverTo, Math.min(next, cover.to, row.startAt + QUIET_COVER_MAX_MS));
  });
  return rows;
}
