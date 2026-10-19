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

  /**
   * The price in USD, or null before any source has ever answered. Once there is a price, a stale
   * one is served while the refresh runs: every live chart poll waits on this, and three slow
   * sources would otherwise hold them all for seconds.
   */
  async get(): Promise<number | null> {
    const now = this.now();
    if (this.value && now - this.value.at < this.ttlMs) return this.value.usd;
    if (now < this.nextTryAt) return this.value?.usd ?? null;
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    return this.value ? this.value.usd : this.inFlight;
  }

  /** Which source the price in use came from, for the chart's source line. */
  source(): string | null {
    return this.value?.source ?? null;
  }

  /** When the price in use was read (ISO), so a screen can say it is old once every source has failed for a while. */
  readAt(): string | null {
    return this.value ? new Date(this.value.at).toISOString() : null;
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

/**
 * The api's one SOL price: every route and the live chart share it, so they agree and only one
 * of them asks the providers each minute.
 */
export const sharedSolPrice = new SolPrice();

/** A quote coin's USD price and decimals (QuotePrice.get). */
export interface QuoteUsd {
  usd: number;
  decimals: number;
}

type QuoteReader = (mint: string) => Promise<QuoteUsd | null>;

/** Jupiter's free price endpoint, which answers a coin's decimals with its price. */
const jupiterQuote: QuoteReader = async (mint) => {
  const body = await fetchJson<Record<string, { usdPrice?: unknown; decimals?: unknown }>>(
    `https://lite-api.jup.ag/price/v3?ids=${mint}`,
    { timeoutMs: 4_000, retries: 0 },
  );
  const usd = Number(body?.[mint]?.usdPrice);
  const decimals = Number(body?.[mint]?.decimals);
  return Number.isFinite(usd) && usd > 0 && Number.isInteger(decimals) && decimals >= 0 && decimals <= 18
    ? { usd, decimals }
    : null;
};

/**
 * The USD price of what a coin-quoted curve or pool pairs with (USD1, a tokenized stock, another
 * coin: user ask 2026-10-18, such charts went delayed), for the live chart, like SolPrice: reused
 * for `ttlMs`, read single-flight per coin, the last good price kept through a failed read.
 */
export class QuotePrice {
  private readonly values = new Map<string, { value: QuoteUsd; at: number }>();
  private readonly inFlight = new Map<string, Promise<QuoteUsd | null>>();
  private readonly nextTryAt = new Map<string, number>();

  constructor(
    private readonly read: QuoteReader = jupiterQuote,
    private readonly ttlMs = 30_000,
    private readonly retryMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly maxCoins = 200,
  ) {}

  /** The coin's price, or null before any read of it has answered. A stale one is served while it refreshes. */
  async get(mint: string): Promise<QuoteUsd | null> {
    const now = this.now();
    const held = this.values.get(mint);
    if (held && now - held.at < this.ttlMs) return held.value;
    if (now < (this.nextTryAt.get(mint) ?? 0)) return held?.value ?? null;
    let flight = this.inFlight.get(mint);
    if (!flight) {
      flight = this.refresh(mint).finally(() => this.inFlight.delete(mint));
      this.inFlight.set(mint, flight);
    }
    return held ? held.value : flight;
  }

  private async refresh(mint: string): Promise<QuoteUsd | null> {
    try {
      const value = await this.read(mint);
      if (value) {
        if (!this.values.has(mint) && this.values.size >= this.maxCoins) {
          const oldest = this.values.keys().next().value;
          if (oldest !== undefined) this.values.delete(oldest);
        }
        this.values.set(mint, { value, at: this.now() });
        return value;
      }
    } catch (err) {
      logger.debug("quote price read failed", { mint, error: String(err) });
    }
    this.nextTryAt.set(mint, this.now() + this.retryMs);
    return this.values.get(mint)?.value ?? null;
  }
}
