import { createLogger, fetchJson } from "@trenchscanner/core";

const logger = createLogger("sol-price");

/** One place a SOL price is read from: its name, and the price in USD (or a throw). */
export interface SolPriceSource {
  name: string;
  read: () => Promise<number>;
}

const WSOL = "So11111111111111111111111111111111111111112";

/**
 * Jupiter's free price endpoint, then Coinbase's spot price, then CoinGecko's: three unrelated
 * providers, so one being down or throttling us never leaves the chart without a SOL price.
 */
export const DEFAULT_SOL_PRICE_SOURCES: SolPriceSource[] = [
  {
    name: "jupiter",
    read: async () => {
      const body = await fetchJson<Record<string, { usdPrice?: unknown }>>(
        `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
        { timeoutMs: 4_000, retries: 0 },
      );
      return Number(body?.[WSOL]?.usdPrice);
    },
  },
  {
    name: "coinbase",
    read: async () => {
      const body = await fetchJson<{ data?: { amount?: unknown } }>(
        "https://api.coinbase.com/v2/prices/SOL-USD/spot",
        { timeoutMs: 4_000, retries: 0 },
      );
      return Number(body?.data?.amount);
    },
  },
  {
    name: "coingecko",
    read: async () => {
      const body = await fetchJson<{ solana?: { usd?: unknown } }>(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
        { timeoutMs: 4_000, retries: 0 },
      );
      return Number(body?.solana?.usd);
    },
  },
];

/** A SOL price within these bounds is believed; anything else is a broken answer. */
const SANE_MIN = 1;
const SANE_MAX = 100_000;

/**
 * SOL's USD price for the live chart, which reads curve prices in SOL: reused for `ttlMs`, read
 * single-flight, each source tried in turn until one answers. When every source fails, the last
 * good price is kept (SOL moves a percent or two in an hour; a chart that stops is worse), and
 * the next reader tries again after `retryMs`.
 */
export class SolPrice {
  private value: { usd: number; source: string; at: number } | null = null;
  private inFlight: Promise<number | null> | null = null;
  private nextTryAt = 0;

  constructor(
    private readonly sources: readonly SolPriceSource[] = DEFAULT_SOL_PRICE_SOURCES,
    private readonly ttlMs = 60_000,
    private readonly retryMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The price in USD, or null before any source has ever answered. */
  async get(): Promise<number | null> {
    const now = this.now();
    if (this.value && now - this.value.at < this.ttlMs) return this.value.usd;
    if (now < this.nextTryAt) return this.value?.usd ?? null;
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** Which source the price in use came from, for the chart's source line. */
  source(): string | null {
    return this.value?.source ?? null;
  }

  private async refresh(): Promise<number | null> {
    for (const s of this.sources) {
      try {
        const usd = await s.read();
        if (Number.isFinite(usd) && usd >= SANE_MIN && usd <= SANE_MAX) {
          this.value = { usd, source: s.name, at: this.now() };
          return usd;
        }
      } catch (err) {
        logger.debug("sol price source failed", { source: s.name, error: String(err) });
      }
    }
    logger.warn("every sol price source failed; keeping the last price", { last: this.value?.usd ?? null });
    this.nextTryAt = this.now() + this.retryMs;
    return this.value?.usd ?? null;
  }
}
