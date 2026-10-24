import {
  orderTrades,
  pumpSwapPoolOf,
  saveCandleChunks,
  tapeCandleRows,
  WRAPPED_SOL_MINT,
  type CandleChunkRow,
  type HeliusClient,
  type TapeTrade,
} from "@trenchscanner/core";
import type { SolUsdHistory } from "./solUsdHistory.js";

/** Where chain-read trades are saved as candles: SOL's USD price, and the store's write. */
export interface TapeCandleSink {
  solUsd: () => Promise<number | null>;
  /**
   * SOL's USD price minute by minute (solUsdHistory.ts): each trade is priced at SOL's price when
   * it happened, `solUsd` standing in for a minute it doesn't hold. Absent: all at `solUsd`.
   */
  solHistory?: Pick<SolUsdHistory, "prepare" | "at">;
  save?: (rows: CandleChunkRow[]) => Promise<unknown>;
}

/**
 * Saves chain-read trades over `cover` as the candle store's "tape" rows (core's tapeCandles.ts),
 * for the trade tape (tradeTapeJob.ts) and the chart's chain fill (candleChainFill.ts). A coin that
 * traded on its PumpSwap pool needs the pool's virtual quote reserve for its price (one account
 * read): without it only the stretch before the pool is saved. Returns the rows written, oldest
 * first; throws when the write fails.
 */
export async function saveChainCandles(
  mint: string,
  trades: readonly TapeTrade[],
  cover: { from: number; to: number },
  sink: TapeCandleSink,
  helius: Partial<Pick<HeliusClient, "getPoolVaultsBatch">>,
): Promise<CandleChunkRow[]> {
  if (!trades.some((t) => t.mark)) return [];
  const solUsd = await sink.solUsd();
  if (solUsd === null || !(solUsd > 0)) return [];
  const ordered = orderTrades(trades);
  const firstPool = ordered.find((t) => t.mark && !("curve" in t.mark));
  let virtualQuote = 0;
  if (firstPool) {
    const pool = pumpSwapPoolOf(mint);
    const read =
      pool && helius.getPoolVaultsBatch
        ? (await helius.getPoolVaultsBatch(new Map([[pool, { mint, quoteMint: WRAPPED_SOL_MINT }]]))).get(
            pool,
          )
        : undefined;
    if (read && read !== "failed") virtualQuote = read.virtualQuote;
    else cover = { from: cover.from, to: Math.min(cover.to, Math.floor(firstPool.atMs / 1_000) * 1_000) };
  }
  const history = sink.solHistory;
  if (history) await history.prepare(cover.from, cover.to);
  const rows = tapeCandleRows(
    mint,
    ordered,
    cover,
    history ? (atMs) => history.at(atMs) ?? solUsd : solUsd,
    virtualQuote,
  );
  if (rows.length > 0) await (sink.save ?? saveCandleChunks)(rows);
  return rows;
}
