import { useEffect, useState } from "react";

/**
 * The token chart's backup candles, read in the browser (user asks 2026-10-19: "can we change any
 * of the calls to be client-side? especially for the chart", "can we have multiple data
 * sources?"). The server's candle store backfills every coin's history itself (GeckoTerminal
 * included), so this is the last resort only: when neither the store nor the chart's answer has
 * any candles for a coin, or the API can't be reached at all, the chart reads GeckoTerminal's
 * minute candles itself, on the reader's own connection and its own rate limit.
 * Pump.fun's own candle API refuses other sites' pages (CORS), so it can't be read from here.
 *
 * GeckoTerminal prices a pool's token, so the pool and the coin's supply come from DexScreener's
 * pair (its market cap over its price), which both answer to any page.
 */

const DEXSCREENER = "https://api.dexscreener.com";
const GECKOTERMINAL = "https://api.geckoterminal.com/api/v2";
/** GeckoTerminal's free limit is 30 calls a minute per address: one coin's minute page each minute. */
export const BACKUP_POLL_MS = 60_000;
/** A failed round waits longer before the next, up to this. */
const MAX_BACKOFF_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;

/** A minute candle as market cap in USD, as the API's own (apps/api/src/tokenChart.ts McapCandle). */
export interface BackupCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Null when the row omitted volume. A reported 0 stays 0. */
  vol: number | null;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

/** DexScreener's names for the coin's own venues: its Pump.fun bonding curve and its PumpSwap pool. */
const OWN_DEX_IDS = ["pumpfun", "pumpswap"];

/**
 * The coin's own Solana pool with it as the base, and its supply (market cap over price); null when
 * DexScreener lists none. The coin's own pair is the pair its scans price it from (`pairAddress`,
 * Token.pairAddress), else its Pump.fun curve or PumpSwap pool, else the busiest pool. Liquidity
 * alone picked side pools: DexScreener gives the Pump.fun curve pair no liquidity at all, so a
 * Meteora pool holding $6 won, with its own price, its own history and a wrong supply (charts
 * audit CH-7).
 */
export function pickPool(
  mint: string,
  body: unknown,
  pairAddress: string | null = null,
): { pool: string; supply: number } | null {
  const pairs = ((body as { pairs?: unknown } | null)?.pairs ?? []) as DexPair[];
  if (!Array.isArray(pairs)) return null;
  let best: { pool: string; supply: number; rank: number; liq: number } | null = null;
  for (const p of pairs) {
    if (p?.chainId !== "solana" || p.baseToken?.address !== mint || !p.pairAddress) continue;
    const price = Number(p.priceUsd);
    const cap = p.marketCap ?? p.fdv;
    if (!(price > 0) || !(typeof cap === "number" && cap > 0)) continue;
    const liq = p.liquidity?.usd ?? 0;
    const rank = p.pairAddress === pairAddress ? 2 : OWN_DEX_IDS.includes(p.dexId ?? "") ? 1 : 0;
    if (!best || rank > best.rank || (rank === best.rank && liq > best.liq))
      best = { pool: p.pairAddress, supply: cap / price, rank, liq };
  }
  return best ? { pool: best.pool, supply: best.supply } : null;
}

/** GeckoTerminal's OHLCV page ([seconds, o, h, l, c, volume], newest first) as market-cap candles, oldest first. */
export function parseOhlcv(body: unknown, supply: number): BackupCandle[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes
    ?.ohlcv_list;
  if (!Array.isArray(list) || !(supply > 0)) return [];
  const out: BackupCandle[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [s, o, h, l, c] = row.slice(0, 5).map(Number) as number[];
    if (![s, o, h, l, c].every((n) => Number.isFinite(n) && n! > 0)) continue;
    const rawV = row.length > 5 ? row[5] : undefined;
    const v = rawV == null ? null : Number(rawV);
    out.push({
      t: s! * 1_000,
      o: o! * supply,
      h: h! * supply,
      l: l! * supply,
      c: c! * supply,
      vol: v == null ? null : Number.isFinite(v) && v >= 0 ? v : 0,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The backup candles for `mint` while `enabled` (the API has none for the chart), read now and every
 * BACKUP_POLL_MS while the tab is visible. Null until a read lands; the last good one stays up
 * through a failed read.
 */
export function useBackupCandles(
  mint: string,
  enabled: boolean,
  /** The coin's own pair (Token.pairAddress), which the pool is picked by first. */
  pairAddress: string | null = null,
): BackupCandle[] | null {
  const [held, setHeld] = useState<{ mint: string; candles: BackupCandle[] } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: number | undefined;
    let pool: { pool: string; supply: number } | null = null;
    let failures = 0;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          pool ??= pickPool(
            mint,
            await getJson(`${DEXSCREENER}/latest/dex/tokens/${encodeURIComponent(mint)}`),
            pairAddress,
          );
          if (pool) {
            const body = await getJson(
              `${GECKOTERMINAL}/networks/solana/pools/${pool.pool}/ohlcv/minute?aggregate=1&limit=1000&currency=usd&token=${encodeURIComponent(mint)}`,
            );
            const candles = parseOhlcv(body, pool.supply);
            if (!stopped && candles.length > 0) setHeld({ mint, candles });
          }
          failures = 0;
        } catch {
          failures++;
        }
      }
      if (!stopped)
        timer = window.setTimeout(
          () => void poll(),
          Math.min(MAX_BACKOFF_MS, BACKUP_POLL_MS * 2 ** failures),
        );
    };
    void poll();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [mint, enabled, pairAddress]);
  return held && held.mint === mint ? held.candles : null;
}
