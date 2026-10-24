import { createLogger, fetchJson } from "@trenchscanner/core";

const logger = createLogger("sol-usd-history");

/**
 * SOL's USD price minute by minute, for candles built from trades read off the chain hours after
 * they happened (the chart's chain fill and the trade tape, chainCandles.ts): priced at SOL's price
 * when they were saved, a SOL move since showed as a step at every seam with the bars around them
 * (audit 2026-10-23 CE-7). Coinbase's public minute candles (keyless, no credits), 300 a call,
 * each minute kept for KEEP_MS once read.
 */

const MINUTE_MS = 60_000;
/** Minutes per Coinbase answer at most. */
const PAGE_MINUTES = 300;
/** How long a minute's price is kept: the chain fill reads coins asked within 6 h, their first 2 h. */
const KEEP_MS = 12 * 3_600_000;
/** Minutes kept at most. */
const MAX_MINUTES = 24 * 60;
/** A stretch whose read failed is not asked again for this long. */
const RETRY_MS = 5 * MINUTE_MS;
/** The newest minutes are left to the spot price: Coinbase's newest candle may still be forming. */
const SETTLE_MS = 2 * MINUTE_MS;

/** One page of minute closes over [fromMs, toMs): minute start (ms) to its close in USD. */
export type SolMinuteReader = (fromMs: number, toMs: number) => Promise<Map<number, number>>;

/** Coinbase's SOL-USD minute candles ([unix s, low, high, open, close, volume], newest first). */
export const coinbaseSolMinutes: SolMinuteReader = async (fromMs, toMs) => {
  const body = await fetchJson<unknown>(
    `https://api.exchange.coinbase.com/products/SOL-USD/candles?granularity=60` +
      `&start=${new Date(fromMs).toISOString()}&end=${new Date(toMs).toISOString()}`,
    { timeoutMs: 6_000, retries: 0 },
  );
  return parseCoinbaseMinutes(body);
};

/** Exported for tests. Coinbase's candle list as minute start (ms) to close, the bad rows left out. */
export function parseCoinbaseMinutes(body: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!Array.isArray(body)) return out;
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const t = Number(row[0]) * 1_000;
    const close = Number(row[4]);
    if (Number.isFinite(t) && t % MINUTE_MS === 0 && Number.isFinite(close) && close > 0) out.set(t, close);
  }
  return out;
}

export class SolUsdHistory {
  private readonly minutes = new Map<number, number>();
  /** Page starts whose read failed lately, and when. */
  private readonly failedAt = new Map<number, number>();

  constructor(
    private readonly read: SolMinuteReader = coinbaseSolMinutes,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * SOL's USD price at `atMs`'s minute, from the minutes held; null for one not held (too new,
   * or not read). Read `prepare` first for a stretch.
   */
  at(atMs: number): number | null {
    return this.minutes.get(Math.floor(atMs / MINUTE_MS) * MINUTE_MS) ?? null;
  }

  /**
   * Reads the minutes of [fromMs, toMs) not held yet, a page at a time, up to SETTLE_MS ago and no
   * further back than KEEP_MS. Never rejects: a failed page leaves its minutes to the spot price.
   */
  async prepare(fromMs: number, toMs: number): Promise<void> {
    const now = this.now();
    const from = Math.floor(Math.max(fromMs, now - KEEP_MS) / MINUTE_MS) * MINUTE_MS;
    const to = Math.min(toMs, Math.floor((now - SETTLE_MS) / MINUTE_MS) * MINUTE_MS);
    for (let page = from; page < to; page += PAGE_MINUTES * MINUTE_MS) {
      const end = Math.min(to, page + PAGE_MINUTES * MINUTE_MS);
      let missing = false;
      for (let m = page; m < end; m += MINUTE_MS) if (!this.minutes.has(m)) missing = true;
      if (!missing || now - (this.failedAt.get(page) ?? -Infinity) < RETRY_MS) continue;
      try {
        const got = await this.read(page, end);
        this.failedAt.delete(page);
        // A minute Coinbase has no trade in holds the close before it.
        let last: number | null = null;
        for (let m = page; m < end; m += MINUTE_MS) {
          const close: number | null = got.get(m) ?? last;
          if (close !== null) this.minutes.set(m, close);
          last = close;
        }
      } catch (err) {
        this.failedAt.set(page, now);
        if (this.failedAt.size > 100) this.failedAt.clear();
        logger.debug("SOL minutes not read", { from: page, error: String(err) });
      }
    }
    this.prune(now);
  }

  private prune(now: number): void {
    const cutoff = now - KEEP_MS;
    for (const m of this.minutes.keys()) if (m < cutoff) this.minutes.delete(m);
    if (this.minutes.size <= MAX_MINUTES) return;
    const keys = [...this.minutes.keys()].sort((a, b) => a - b);
    for (const m of keys.slice(0, keys.length - MAX_MINUTES)) this.minutes.delete(m);
  }
}
