import {
  createLogger,
  fetchJson,
  jupiterQuote,
  QuotePrice as CoreQuotePrice,
  type QuoteReader,
  type QuoteUsd as CoreQuoteUsd,
} from "@trenchscanner/core";
import { recordSolPriceFailure } from "./chartHealth.js";

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
 * The longest a last good price is served once every source has failed (user ask 2026-10-19, "fix
 * all"; charts audit item 13). SOL moves a percent or two in an hour, so a few minutes of an old
 * price beats a chart that stops, but past this the chart says "pending" rather than draw a price
 * that may be well off.
 */
export const MAX_PRICE_AGE_MS = 10 * 60_000;

/**
 * SOL's USD price for the live chart, which reads curve prices in SOL: reused for `ttlMs`, read
 * single-flight, each source tried in turn until one answers. When every source fails, the last
 * good price is kept for up to `maxAgeMs` (then null), and the next reader tries again after
 * `retryMs`.
 */
export class SolPrice {
  private value: { usd: number; source: string; at: number } | null = null;
  private inFlight: Promise<number | null> | null = null;
  private nextTryAt = 0;
  /** When an over-age price was last refused, so the warning is logged once a minute, not per read. */
  private warnedAt = -Infinity;

  constructor(
    private readonly sources: readonly SolPriceSource[] = DEFAULT_SOL_PRICE_SOURCES,
    private readonly ttlMs = 60_000,
    private readonly retryMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly maxAgeMs = MAX_PRICE_AGE_MS,
  ) {}

  /**
   * The price in USD, or null before any source has ever answered (or once the last good one is
   * older than maxAgeMs). Once there is a price, a stale one is served while the refresh runs:
   * every live chart poll waits on this, and three slow sources would otherwise hold them all.
   */
  async get(): Promise<number | null> {
    const now = this.now();
    if (this.value && now - this.value.at < this.ttlMs) return this.value.usd;
    if (now >= this.nextTryAt)
      this.inFlight ??= this.refresh().finally(() => {
        this.inFlight = null;
      });
    const kept = this.kept(now);
    if (kept !== null || !this.inFlight) return kept;
    // Nothing to serve meanwhile: this read waits for the refresh.
    return this.inFlight.then(() => this.kept(this.now()));
  }

  /** Starts the first read early (server start), so the first chart answers don't wait on it. */
  warm(): Promise<number | null> {
    return this.get().catch(() => null);
  }

  /** The price already kept, or null. Does not ask a provider. */
  current(): number | null {
    return this.kept(this.now());
  }

  /** The kept price if it is young enough to serve, else null (logged). */
  private kept(now: number): number | null {
    if (!this.value) return null;
    if (now - this.value.at <= this.maxAgeMs) return this.value.usd;
    if (now - this.warnedAt > 60_000) {
      this.warnedAt = now;
      logger.warn("sol price too old to serve; answering none", {
        last: this.value.usd,
        ageMs: now - this.value.at,
      });
    }
    return null;
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
    recordSolPriceFailure();
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
export type QuoteUsd = CoreQuoteUsd;

/**
 * The quote coin price readers live in core now (datasources/quotePrice.ts), shared with the
 * worker's curve candle writer: Jupiter's free endpoint, then DexScreener with the decimals off the
 * mint. The API's QuotePrice counts a coin every reader failed for on its chart health.
 */
export { dexScreenerQuote, jupiterQuote } from "@trenchscanner/core";

export class QuotePrice extends CoreQuotePrice {
  constructor(
    read: QuoteReader | readonly QuoteReader[] = jupiterQuote,
    ttlMs = 30_000,
    retryMs = 10_000,
    now: () => number = Date.now,
    maxCoins = 200,
    maxAgeMs = MAX_PRICE_AGE_MS,
  ) {
    super(read, ttlMs, retryMs, now, maxCoins, maxAgeMs, () => recordSolPriceFailure());
  }
}
