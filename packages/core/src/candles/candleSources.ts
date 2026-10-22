import { fetchJson, HttpError } from "../datasources/httpClient.js";
import { pumpFunSwapGate } from "../datasources/pumpfunGate.js";
import { PUMP_SUPPLY_TOKENS } from "../wallets/tradeTape.js";
import type { StoredBar } from "./candleChunk.js";

/**
 * The upstream candle pages the store is filled from, parsed to stored bars (USD market cap on
 * Pump.fun's launch billion). The API's chart reads Pump.fun through its own caches
 * (apps/api/src/tokenChart.ts); these are for the worker's backfill.
 */

/** Candles a page of Pump.fun's swap API holds at most: its newest intervals with a trade. */
export const PUMP_CANDLE_PAGE = 1_000;
/** Minutes a GeckoTerminal OHLCV page holds at most. */
export const GECKO_CANDLE_PAGE = 1_000;

const num = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) : Number.NaN);

/**
 * Pump.fun's USD candles as market-cap bars, oldest first (the same reading as the API's
 * parseMcapCandles): a candle with a missing or non-positive price is dropped, absent volume is
 * null, an unreadable one 0.
 */
export function parsePumpCandles(body: unknown, supply = PUMP_SUPPLY_TOKENS): StoredBar[] {
  if (!Array.isArray(body)) return [];
  const out: StoredBar[] = [];
  for (const raw of body as Record<string, unknown>[]) {
    const t = typeof raw?.timestamp === "number" ? raw.timestamp : Number.NaN;
    const o = num(raw?.open);
    const h = num(raw?.high);
    const l = num(raw?.low);
    const c = num(raw?.close);
    const hasVol = raw != null && Object.prototype.hasOwnProperty.call(raw, "volume") && raw.volume != null;
    const vol = hasVol ? num(raw.volume) : Number.NaN;
    if (![t, o, h, l, c].every(Number.isFinite) || Math.min(o, h, l, c) <= 0) continue;
    out.push({
      t,
      o: o * supply,
      h: Math.max(h, o, c) * supply,
      l: Math.min(l, o, c) * supply,
      c: c * supply,
      vol: !hasVol ? null : Number.isFinite(vol) && vol >= 0 ? vol : 0,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * GeckoTerminal's OHLCV list ([unix seconds, o, h, l, c, USD volume], newest first, empty minutes
 * left out) as market-cap bars on the launch billion, oldest first.
 */
export function parseGeckoOhlcv(body: unknown, supply = PUMP_SUPPLY_TOKENS): StoredBar[] {
  const list = (body as { data?: { attributes?: { ohlcv_list?: unknown } } } | null)?.data?.attributes
    ?.ohlcv_list;
  if (!Array.isArray(list)) return [];
  const out: StoredBar[] = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const [ts, o, h, l, c, v] = row.map(num) as number[];
    if (![ts, o, h, l, c].every((x) => Number.isFinite(x)) || Math.min(o!, h!, l!, c!) <= 0) continue;
    out.push({
      t: ts! * 1_000,
      o: o! * supply,
      h: Math.max(h!, o!, c!) * supply,
      l: Math.min(l!, o!, c!) * supply,
      c: c! * supply,
      vol: v !== undefined && Number.isFinite(v) && v >= 0 ? v : null,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * A coin's Pump.fun candle page of `interval` (its newest PUMP_CANDLE_PAGE with a trade), on the
 * process's swap-api gate. Null when Pump.fun has no such coin.
 */
export async function fetchPumpCandles(
  mint: string,
  interval: "1m" | "5m",
  baseUrl = "https://swap-api.pump.fun",
): Promise<StoredBar[] | null> {
  try {
    const body = await fetchJson<unknown>(
      `${baseUrl}/v1/coins/${encodeURIComponent(mint)}/candles?interval=${interval}&limit=${PUMP_CANDLE_PAGE}&currency=USD`,
      { timeoutMs: 8_000, retries: 0, gate: pumpFunSwapGate },
    );
    return parsePumpCandles(body);
  } catch (err) {
    if (err instanceof HttpError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}
