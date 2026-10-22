import { createLogger, fetchJson, type DexScreenerClient } from "@trenchscanner/core";
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
export interface QuoteUsd {
  usd: number;
  decimals: number;
}

type QuoteReader = (mint: string) => Promise<QuoteUsd | null>;

/** Jupiter's free price endpoint, which answers a coin's decimals with its price. */
export const jupiterQuote: QuoteReader = async (mint) => {
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
 * DexScreener's USD price for a quote coin (its deepest pair with one, through the API's shared
 * DexScreener client and its rate gate), with the coin's decimals off its mint account, read once
 * per coin: QuotePrice's second source when Jupiter's lite API fails (user ask 2026-10-19, "can we
 * have multiple data sources"; charts audit item 13). Decimals are never guessed: a tokenized
 * stock has 8 where most coins have 6, and a wrong guess is a 100x wrong market cap.
 */
export function dexScreenerQuote(
  dex: Pick<DexScreenerClient, "getTokensByAddresses">,
  decimalsOf: (mints: string[]) => Promise<Map<string, number>>,
): QuoteReader {
  const decimals = new Map<string, number>();
  return async (mint) => {
    const [tokens, known] = await Promise.all([
      dex.getTokensByAddresses([mint], 1, { timeoutMs: 4_000, retries: 0 }),
      decimals.has(mint) ? Promise.resolve(decimals) : decimalsOf([mint]),
    ]);
    const d = known.get(mint);
    if (d === undefined || !Number.isInteger(d) || d < 0 || d > 18) return null;
    if (decimals.size > 1_000) decimals.clear();
    decimals.set(mint, d);
    const usd = Number(tokens.find((t) => t.mintAddress === mint)?.priceUsd);
    return Number.isFinite(usd) && usd > 0 ? { usd, decimals: d } : null;
  };
}

/**
 * The USD price of what a coin-quoted curve or pool pairs with (USD1, a tokenized stock, another
 * coin: user ask 2026-10-18, such charts went delayed), for the live chart, like SolPrice: reused
 * for `ttlMs`, read single-flight per coin, each reader tried in turn until one answers (Jupiter,
 * then DexScreener: user ask 2026-10-19), the last good price kept through failed reads for up to
 * `maxAgeMs`.
 */
export class QuotePrice {
  private readonly values = new Map<string, { value: QuoteUsd; at: number }>();
  private readonly inFlight = new Map<string, Promise<QuoteUsd | null>>();
  private readonly nextTryAt = new Map<string, number>();
  private readonly readers: readonly QuoteReader[];

  constructor(
    read: QuoteReader | readonly QuoteReader[] = jupiterQuote,
    private readonly ttlMs = 30_000,
    private readonly retryMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly maxCoins = 200,
    private readonly maxAgeMs = MAX_PRICE_AGE_MS,
  ) {
    this.readers = typeof read === "function" ? [read] : read;
  }

  /**
   * The coin's price, or null before any read of it has answered (or once the last good one is
   * older than maxAgeMs). A stale one is served while it refreshes.
   */
  async get(mint: string): Promise<QuoteUsd | null> {
    const now = this.now();
    const held = this.values.get(mint);
    if (held && now - held.at < this.ttlMs) return held.value;
    const kept = held && now - held.at <= this.maxAgeMs ? held.value : null;
    if (now < (this.nextTryAt.get(mint) ?? 0)) return kept;
    let flight = this.inFlight.get(mint);
    if (!flight) {
      flight = this.refresh(mint).finally(() => this.inFlight.delete(mint));
      this.inFlight.set(mint, flight);
    }
    return kept ?? flight;
  }

  private async refresh(mint: string): Promise<QuoteUsd | null> {
    for (const [i, read] of this.readers.entries()) {
      try {
        const value = await read(mint);
        if (value) {
          if (!this.values.has(mint) && this.values.size >= this.maxCoins) {
            const oldest = this.values.keys().next().value;
            if (oldest !== undefined) this.values.delete(oldest);
          }
          this.values.set(mint, { value, at: this.now() });
          return value;
        }
      } catch (err) {
        logger.debug("quote price read failed", { mint, reader: i, error: String(err) });
      }
    }
    recordSolPriceFailure();
    this.nextTryAt.set(mint, this.now() + this.retryMs);
    const held = this.values.get(mint);
    if (held && this.now() - held.at > this.maxAgeMs) {
      logger.warn("quote price too old to serve; answering none", { mint, ageMs: this.now() - held.at });
      return null;
    }
    return held?.value ?? null;
  }
}
