import type { DexScreenerClient } from "./dexscreener.js";
import { keylessQuoteUsd, type QuoteUsd } from "./jupiter.js";
import { createLogger } from "../logger.js";

const logger = createLogger("quote-price");

/**
 * The USD price of what a coin-quoted curve or pool pairs with (USD1, a tokenized stock, another
 * pump coin), shared by the API's live chart (apps/api solPrice.ts) and the worker's curve candle
 * writer (apps/worker curveCandles.ts). Until 2026-10-24 the worker read Jupiter alone, with no
 * second source: coins quoted in another pump coin (WOJAK, swordcat) came back unpriced on the
 * server while USDC- and stock-quoted ones did, and the writer skipped them without a word, so
 * five of the thirty latest called coins had no 1-second bars at all (chart audit 2026-10-24).
 */

/** How a reader answers: the coin's USD price and its decimals, or null when it has neither. */
export type QuoteReader = (mint: string) => Promise<QuoteUsd | null>;

/** Jupiter's free price endpoint, which answers a coin's decimals with its price. */
export const jupiterQuote: QuoteReader = keylessQuoteUsd;

/** A quote price older than this is not served: the chart would be priced on a stale coin. */
export const QUOTE_PRICE_MAX_AGE_MS = 10 * 60_000;

/**
 * DexScreener's USD price for a quote coin (its deepest pair with one, through a shared DexScreener
 * client and its rate gate), with the coin's decimals off its mint account, read once per coin:
 * the second source when Jupiter's lite API fails or has no price (user ask 2026-10-19, "can we
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
 * A quote coin's price, like the API's SolPrice: reused for `ttlMs`, read single-flight per coin,
 * each reader tried in turn until one answers (Jupiter, then DexScreener), the last good price
 * kept through failed reads for up to `maxAgeMs`. `onFailure` is told each time every reader
 * failed or answered none for a coin (the API counts it on its chart health).
 */
export class QuotePrice {
  private readonly values = new Map<string, { value: QuoteUsd; at: number }>();
  private readonly inFlight = new Map<string, Promise<QuoteUsd | null>>();
  private readonly nextTryAt = new Map<string, number>();
  private readonly readers: readonly QuoteReader[];
  /** Coins every reader failed or answered none for, with when, for the worker's heartbeat (takeMisses). */
  private misses: { mint: string; at: number; error: string | null }[] = [];

  constructor(
    read: QuoteReader | readonly QuoteReader[] = jupiterQuote,
    private readonly ttlMs = 30_000,
    private readonly retryMs = 10_000,
    private readonly now: () => number = Date.now,
    private readonly maxCoins = 200,
    private readonly maxAgeMs = QUOTE_PRICE_MAX_AGE_MS,
    private readonly onFailure?: (mint: string) => void,
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

  /** The coins no reader could price since the last call, newest last; at most the last 50 are kept. */
  takeMisses(): { mint: string; at: number; error: string | null }[] {
    const out = this.misses;
    this.misses = [];
    return out;
  }

  private async refresh(mint: string): Promise<QuoteUsd | null> {
    let lastError: string | null = null;
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
        lastError ??= `reader ${i}: no price`;
      } catch (err) {
        lastError = `reader ${i}: ${String(err)}`;
        logger.debug("quote price read failed", { mint, reader: i, error: String(err) });
      }
    }
    this.onFailure?.(mint);
    if (this.misses.length >= 50) this.misses.shift();
    this.misses.push({ mint, at: this.now(), error: lastError });
    this.nextTryAt.set(mint, this.now() + this.retryMs);
    const held = this.values.get(mint);
    if (held && this.now() - held.at > this.maxAgeMs) {
      logger.warn("quote price too old to serve; answering none", { mint, ageMs: this.now() - held.at });
      return null;
    }
    return held?.value ?? null;
  }
}
