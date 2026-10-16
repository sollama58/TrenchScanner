import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import { RateGate, RateGateDeadlineError, type RateGateStats } from "./rateGate.js";
import { normalizeSocialUrl } from "./tokensage.js";
import type { GeckoTerminalClient } from "./geckoterminal.js";
import type { CandidateToken, WatchlistCandidate } from "../types.js";

const logger = createLogger("dexscreener");

/** Subset of the DexScreener pair shape we actually use. See https://docs.dexscreener.com/api/reference */
interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken: { address: string; symbol?: string };
  priceUsd?: string;
  /** Price in the quote token (SOL for a Pump.fun curve). */
  priceNative?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  /** All four windows ship in every pair response - h24 alone was captured for the first year. */
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
    h24?: { buys?: number; sells?: number };
  };
  /** Percent change per window, e.g. 12.5 for +12.5%. */
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  pairCreatedAt?: number;
  info?: {
    /** DexScreener's own hosted copy of the token's logo. Absent for plenty of new mints. */
    imageUrl?: string;
    websites?: { url: string }[];
    socials?: { type: string; url: string }[];
  };
}

/** Subset of https://api.dexscreener.com/token-profiles/latest/v1 and .../token-boosts/latest/v1 - both share this shape. */
interface DexScreenerDiscoveryEntry {
  chainId: string;
  tokenAddress: string;
  links?: { type?: string; url: string }[];
}

const SOLANA_CHAIN_ID = "solana";
/** DexScreener's batch token lookup caps out at 30 addresses per call. */
const BATCH_SIZE = 30;

/**
 * DexScreener allows 300 token lookups a minute per IP. A process's default share: the worker's,
 * leaving the API's 120 a minute of live refreshes room if the two leave from one address.
 */
export const DEFAULT_DEXSCREENER_REQUESTS_PER_MINUTE = 180;
/**
 * Lookups that may go out back to back before the per-minute pace applies. A full watchlist
 * refresh is 30 batches: at 15 the other half queued at 3 a second, which held the scan's refresh
 * at 5.5 s a cycle (worker health, 2026-10-08) once Jupiter had taken the outcome watcher and the
 * wallet checks off this budget and it was no longer short.
 */
const GATE_BURST = 30;
/**
 * Of that burst, the slots only the scan's band refresh (a `priority` lookup) may take. The other
 * jobs on this client - the outcome watcher's fallback, live prices, fast-match, wallet valuation -
 * leave them, so a refresh starting just after one of their bursts is not paced at 3 a second:
 * on 2026-10-13 that held the refresh at 8-10 s (instead of ~1.3 s) on 2 of 13 sampled cycles.
 */
export const DEXSCREENER_PRIORITY_RESERVE = 20;
/**
 * How long a pair DexScreener returned is reused for another lookup of the same mint.
 *
 * Every job in a process shares this client, and several price the same mints within a minute:
 * the scan's watchlist refresh, fast-match 15s later, live-price 20s later, the outcome watcher,
 * wallet valuation. They shared the rate budget but not the answers, so 10-25% of the budget
 * went on asking again for a quote seconds old. Under fast-match's 15s cadence, so the fast lane
 * still sees a reading newer than the scan's; a caller passing `seenAt` gets the quote's own
 * time, never the reuse time. Only pairs are kept, never "no pair": a mint whose pool appeared a
 * moment ago must not be hidden for the TTL.
 */
export const QUOTE_CACHE_MS = 10_000;
/** Mints held at once; far above a cycle's working set, so pruning is the TTL's job. */
const QUOTE_CACHE_MAX = 5_000;

export interface DexScreenerClientOptions {
  baseUrl?: string;
  /** This client's token-lookup budget a minute - see DEFAULT_DEXSCREENER_REQUESTS_PER_MINUTE. */
  requestsPerMinute?: number;
  /**
   * Answers token lookups while DexScreener answers them blank - see getTokensByAddresses. Unset,
   * a blank DexScreener stays blank.
   */
  fallback?: GeckoTerminalClient;
}

/**
 * A lookup whose answered batches covered at least this many mints and found not one pair reads as
 * DexScreener being blank, not as that many unindexed mints.
 */
const BLANK_MIN_MINTS = 25;
/** The longest the fallback is waited on for unpriced or not-yet-listed mints - see fillFromFallback. */
const FALLBACK_FILL_DEADLINE_MS = 4_000;
/** How long a blank DexScreener is routed around before it must prove blank again. */
const BLANK_HOLD_MS = 10 * 60_000;
/**
 * How long a failing DexScreener (every batch of a lookup erroring or timing out) is routed around
 * before it is tried again. Shorter than BLANK_HOLD_MS: an outage is usually brief, and while
 * routed around one batch still probes it on every lookup.
 */
const DOWN_HOLD_MS = 60_000;

/** getTokensByAddresses' options. */
export interface TokenLookupOptions {
  timeoutMs?: number;
  retries?: number;
  /**
   * How long the whole lookup may take. Past it, the batches already answered are returned and no
   * more are started; mints are looked up in the order given, so put the important ones first.
   */
  deadlineMs?: number;
  /**
   * When supplied, records the moment each returned mint's batch answered. A lookup of many
   * batches (the outcome watcher's, up to 2000 rows) spans seconds, more with retries: a
   * caller timing price moves against a window reads the time its price was seen from here
   * rather than stamping the whole lookup at its start or end.
   */
  seenAt?: Map<string, Date>;
  /**
   * When supplied, collects the mints whose batch got no answer (an error, or skipped past
   * the deadline) - so a caller can tell "DexScreener has no pair for this" from "we never
   * heard back", which a missing entry in the result can't.
   */
  failed?: Set<string>;
  /**
   * When supplied, collects the mints whose price came from a seconds-old source (Jupiter, via
   * JupiterFirstLookup) rather than DexScreener, whose prices run 45-60 s behind the market. A
   * mint left out was priced by DexScreener (or its fallback).
   */
  freshSources?: Set<string>;
  /**
   * The scan's own watchlist refresh: may take the rate budget's reserved slots (see
   * DEXSCREENER_PRIORITY_RESERVE), and first call on the fallback's budget while DexScreener is
   * blank (see GeckoTerminalClient).
   */
  priority?: boolean;
  /**
   * Mints to ask the fallback (GeckoTerminal) about when DexScreener answers with no pair for them:
   * the scan's newest launches. DexScreener lists a new Pump.fun launch a median ~43 s after it, and
   * GeckoTerminal ~22 s (both measured 2026-10-12), while most launch runs that double do it in the
   * first two minutes. At most one fallback batch (30 mints), in the order given. Only read on a
   * `priority` lookup. A promise is awaited once DexScreener has answered, so the caller can work
   * the list out alongside the lookup (the band refresh's live launch read).
   */
  fallbackIfUnlisted?: string[] | Promise<string[]>;
  /**
   * The mints asked for may well have no pair at all (a holder's other holdings: airdrops,
   * NFTs, dead coins - see walletValuation). An all-empty answer to such a lookup is then not
   * evidence DexScreener is blank, and never switches the process onto the fallback; while the
   * fallback is on, the lookup is not sent at all and every mint counts as failed.
   */
  mayBeUnindexed?: boolean;
  /**
   * Skip the recent-quote cache and ask DexScreener now (the answer is still cached for others).
   * For a caller whose logic needs a reading independent of the one other jobs just took - the
   * outcome watcher's crash-tick guard checks a fetched price against the scan's own snapshot.
   */
  fresh?: boolean;
}

export class DexScreenerClient {
  private readonly baseUrl: string;
  /**
   * Every token lookup this client makes, whichever job asked, shares this budget and backs off
   * together on a 429 - see RateGate. One client per process, so one budget per process.
   */
  private readonly gate: RateGate;
  private readonly fallback?: GeckoTerminalClient;
  /** Until when DexScreener is treated as blank (epoch ms); 0 while it answers. */
  private blankUntil = 0;
  /** Recent pairs by mint, with when they were seen - see QUOTE_CACHE_MS. */
  private readonly quotes = new Map<string, { token: CandidateToken; at: Date }>();
  /** Lookups answered from the quote cache since the last takeQuoteCacheHits(). */
  private quoteHits = 0;
  /**
   * Curves whose re-read found no pool, by mint: when to ask again and how many times in a row it
   * found none - see repairFrozenCurves.
   */
  private readonly curveRechecks = new Map<string, { at: number; misses: number }>();
  /** Quote tokens' USD prices by mint, with when they were read (0 = none found) - see priceInQuoteToken. */
  private readonly quoteUsd = new Map<string, { usd: number; at: number }>();
  /** Mints last priced through their quote coin, so with no USD volume yet - see fillFromFallback. */
  private readonly quotePriced = new Set<string>();

  constructor(options: DexScreenerClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.dexscreener.com";
    this.gate = new RateGate({
      name: "dexscreener",
      perMinute: options.requestsPerMinute ?? DEFAULT_DEXSCREENER_REQUESTS_PER_MINUTE,
      burst: GATE_BURST,
      reserve: DEXSCREENER_PRIORITY_RESERVE,
    });
    this.fallback = options.fallback;
  }

  /** Whether lookups are currently being answered by the fallback. */
  get usingFallback(): boolean {
    return this.fallback !== undefined && Date.now() < this.blankUntil;
  }

  /** Mints answered from the recent-quote cache since the last call, then reset. */
  takeQuoteCacheHits(): number {
    const hits = this.quoteHits;
    this.quoteHits = 0;
    return hits;
  }

  private rememberQuotes(tokens: CandidateToken[], at: Date): void {
    for (const token of tokens) {
      this.quotes.delete(token.mintAddress);
      this.quotes.set(token.mintAddress, { token, at });
    }
    if (this.quotes.size <= QUOTE_CACHE_MAX) return;
    const cutoff = Date.now() - QUOTE_CACHE_MS;
    // Insertion order is age order (re-inserted above), so the oldest go first.
    for (const [mint, q] of this.quotes) {
      if (this.quotes.size <= QUOTE_CACHE_MAX && q.at.getTime() > cutoff) break;
      this.quotes.delete(mint);
    }
  }

  /** Token lookups sent, 429 pauses and time spent queued since the last call, then reset. */
  takeCallStats(): RateGateStats {
    return this.gate.takeStats();
  }

  /**
   * Looks up current market data for a batch of Solana token mint addresses.
   * Splits into chunks of 30 (the API's per-request limit) and merges results.
   * A token can have multiple pairs (e.g. multiple DEXes); we keep the
   * highest-liquidity pair per mint as the canonical price source.
   */
  async getTokensByAddresses(
    mintAddresses: string[],
    concurrency = 5,
    /** Per-batch timeout and retries (fetchJson's defaults when omitted) - see TokenLookupOptions. */
    options: TokenLookupOptions = {},
  ): Promise<CandidateToken[]> {
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];
    const fallback = this.fallback;
    if (!fallback) return this.lookup(unique, concurrency, options);
    const deadline = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs;
    const remaining = () => (deadline === undefined ? undefined : Math.max(0, deadline - Date.now()));

    // On 2026-10-07 DexScreener began answering every token lookup with an empty list - HTTP 200,
    // no error - so nothing had a market cap, nothing reached the band, and the safety screen and
    // alerts went quiet for every user while discovery carried on. While it is blank, one batch
    // probes it and GeckoTerminal answers the lookup; the first probe with a pair in it ends that.
    if (Date.now() < this.blankUntil) {
      // A holder's other holdings (walletValuation) are mostly airdrops and dead coins: on the
      // fallback they spend paid CoinGecko credits and the background budget fast-match needs, to
      // price nothing. They count as unanswered instead, so the caller retries once DexScreener is
      // back; an empty answer from them proves nothing about DexScreener either way.
      if (options.mayBeUnindexed) {
        if (options.failed) for (const mint of unique) options.failed.add(mint);
        return [];
      }
      const [probe, gecko] = await Promise.all([
        this.lookup(unique.slice(0, BATCH_SIZE), concurrency, {
          timeoutMs: options.timeoutMs,
          retries: options.retries,
          deadlineMs: options.deadlineMs,
        }),
        fallback.getTokensByAddresses(unique, { ...options, deadlineMs: remaining() }),
      ]);
      if (probe.length > 0) {
        this.blankUntil = 0;
        logger.info("dexscreener is answering again - back off the fallback");
      } else {
        this.blankUntil = Date.now() + BLANK_HOLD_MS;
      }
      const byMint = new Map(gecko.map((t) => [t.mintAddress, t]));
      for (const t of probe) byMint.set(t.mintAddress, t);
      return [...byMint.values()];
    }

    const answered = new Set<string>();
    // Collected here, not straight into the caller's set: a mint the fallback prices didn't fail.
    const dexFailed = new Set<string>();
    let results = await this.lookup(unique, concurrency, { ...options, failed: dexFailed }, answered);
    if (dexFailed.size > 0 && !options.mayBeUnindexed) {
      results = await this.answerFailedFromFallback(
        fallback,
        results,
        dexFailed,
        answered,
        options,
        remaining(),
      );
    }
    if (options.failed) for (const mint of dexFailed) options.failed.add(mint);
    if (results.length > 0 || answered.size < BLANK_MIN_MINTS || options.mayBeUnindexed) {
      return options.priority
        ? this.fillFromFallback(fallback, results, answered, options, remaining())
        : results;
    }
    this.blankUntil = Date.now() + BLANK_HOLD_MS;
    logger.warn("dexscreener answered a lookup with no pairs at all - using geckoterminal", {
      answered: answered.size,
    });
    // The mints DexScreener answered blank were marked heard-from; GeckoTerminal decides now.
    const geckoFailed = new Set<string>();
    const gecko = await fallback.getTokensByAddresses(unique, {
      ...options,
      deadlineMs: remaining(),
      failed: geckoFailed,
    });
    if (options.failed) for (const mint of geckoFailed) options.failed.add(mint);
    return gecko;
  }

  /**
   * Asks the fallback about the mints whose DexScreener batch failed (a 5xx, a timeout, a network
   * error) rather than leaving them unpriced for the cycle: on a DexScreener outage the band
   * refresh priced only what Jupiter's newest-launch read covered, so older watchlist coins fell
   * out of the band (audit 2026-10-14, L6-4). When no batch answered at all, DexScreener is
   * routed around for DOWN_HOLD_MS like a blank one, so the next lookups don't each wait out its
   * timeouts first. Mints the fallback answers leave `failed`; the rest stay in it. Never throws.
   */
  private async answerFailedFromFallback(
    fallback: GeckoTerminalClient,
    results: CandidateToken[],
    failed: Set<string>,
    answered: Set<string>,
    options: TokenLookupOptions,
    remainingMs: number | undefined,
  ): Promise<CandidateToken[]> {
    if (answered.size === 0 && failed.size >= Math.min(BLANK_MIN_MINTS, BATCH_SIZE)) {
      this.blankUntil = Date.now() + DOWN_HOLD_MS;
      logger.warn("dexscreener lookups are failing - using geckoterminal", { failed: failed.size });
    }
    if (remainingMs !== undefined && remainingMs <= 0) return results;
    const ask = [...failed];
    const geckoFailed = new Set<string>();
    const gecko = await fallback
      .getTokensByAddresses(ask, {
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        deadlineMs: remainingMs,
        seenAt: options.seenAt,
        priority: options.priority,
        failed: geckoFailed,
      })
      .catch((err: unknown) => {
        logger.warn("fallback lookup for failed mints failed", { error: String(err) });
        for (const mint of ask) geckoFailed.add(mint);
        return [] as CandidateToken[];
      });
    // Answered by the fallback, priced or not: no longer unheard-from.
    for (const mint of ask) if (!geckoFailed.has(mint)) failed.delete(mint);
    if (gecko.length === 0) return results;
    this.rememberQuotes(gecko, new Date());
    return [...results, ...gecko.map((t) => ({ ...t }))];
  }

  /**
   * Asks the fallback for what DexScreener answered without a price: pairs quoted in another
   * token rather than SOL or a dollar (Pump.fun lets a launch pair with any coin - PEPE, ASTER -
   * and DexScreener reports those with no USD price, market cap or volume, so the scan never saw
   * them: 4 of 135 young runners on 2026-10-12, each doubling over 8-17 minutes), and the caller's
   * `fallbackIfUnlisted` mints DexScreener has no pair for yet. One batch, inside what is left of the
   * lookup's deadline; when the fallback can't answer, DexScreener's answer stands.
   */
  private async fillFromFallback(
    fallback: GeckoTerminalClient,
    results: CandidateToken[],
    answered: Set<string>,
    options: TokenLookupOptions,
    remainingMs: number | undefined,
  ): Promise<CandidateToken[]> {
    const listed = new Set(results.map((t) => t.mintAddress));
    const startedAt = Date.now();
    const unlisted = options.fallbackIfUnlisted ? await options.fallbackIfUnlisted : [];
    if (remainingMs !== undefined) remainingMs -= Date.now() - startedAt;
    const ask = [
      ...results.filter((t) => t.priceUsd <= 0 && t.marketCapUsd <= 0).map((t) => t.mintAddress),
      ...unlisted.filter((m) => answered.has(m) && !listed.has(m)),
      // Priced through its quote coin (priceInQuoteToken), but with no volume or price change.
      ...results
        .filter((t) => this.quotePriced.has(t.mintAddress) && t.volume1hUsd === undefined)
        .map((t) => t.mintAddress),
    ].slice(0, BATCH_SIZE);
    if (ask.length === 0 || (remainingMs !== undefined && remainingMs <= 0)) return results;
    const priced = await fallback
      .getTokensByAddresses(ask, {
        priority: true,
        timeoutMs: options.timeoutMs,
        retries: 0,
        deadlineMs: Math.min(remainingMs ?? FALLBACK_FILL_DEADLINE_MS, FALLBACK_FILL_DEADLINE_MS),
        seenAt: options.seenAt,
      })
      .catch((err: unknown) => {
        logger.warn("fallback lookup for unpriced mints failed", { error: String(err) });
        return [] as CandidateToken[];
      });
    if (priced.length === 0) return results;
    // Other jobs reading these mints in the next few seconds get the priced answer too.
    this.rememberQuotes(priced, new Date());
    const byMint = new Map(results.map((t) => [t.mintAddress, t]));
    for (const t of priced) {
      // GeckoTerminal has no socials, logo or graduation time; DexScreener's pair keeps them.
      const dex = byMint.get(t.mintAddress);
      byMint.set(t.mintAddress, {
        ...t,
        hasTwitter: t.hasTwitter ?? dex?.hasTwitter,
        hasTelegram: t.hasTelegram ?? dex?.hasTelegram,
        hasWebsite: t.hasWebsite ?? dex?.hasWebsite,
        imageUrl: t.imageUrl ?? dex?.imageUrl,
        graduatedAt: t.graduatedAt ?? dex?.graduatedAt,
      });
    }
    return [...byMint.values()];
  }

  /**
   * When a graduated Pump.fun mint's PumpSwap pool was created, read from DexScreener's per-token
   * pairs endpoint. The batch lookup (/tokens/v1) can list only a graduated mint's old curve pair -
   * seen on every coin whose curve filled in its launch second (2026-10-11) - while this endpoint
   * lists the pool. Null when no PumpSwap pool is listed; throws when DexScreener can't answer.
   */
  async pumpSwapGraduation(mintAddress: string): Promise<Date | null> {
    const gate = {
      acquire: () => this.gate.acquire(),
      throttled: (delayMs: number) => this.gate.throttled(delayMs),
    };
    return pumpSwapPoolCreatedAt(await this.tokenPairs(mintAddress, gate)) ?? null;
  }

  /**
   * Coins' prices in SOL (SOL per whole token), for valuing a trade paid in another coin - see
   * tradesFromChainTransactions. Any coin DexScreener prices, directly or through its own quote
   * coin, on the same short-lived cache as priceInQuoteToken. A coin it can't price is left out;
   * never throws.
   */
  async solPricesOf(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const ask = [...new Set(mints)].filter((m) => m !== WRAPPED_SOL_MINT);
    if (ask.length === 0) return out;
    const gate = {
      acquire: () => this.gate.acquire(),
      throttled: (delayMs: number) => this.gate.throttled(delayMs),
    };
    const usd = await this.quoteUsdPrices([WRAPPED_SOL_MINT, ...ask], gate);
    const solUsd = usd.get(WRAPPED_SOL_MINT);
    if (!solUsd) return out;
    for (const mint of ask) {
      const price = usd.get(mint);
      if (price) out.set(mint, price / solUsd);
    }
    return out;
  }

  /**
   * Re-reads, from the per-token pairs endpoint, each mint whose batch answer is a Pump.fun curve
   * at its graduation price. The batch lookup can go on listing only a graduated mint's old curve -
   * frozen at the graduation price forever, with no PumpSwap pool beside it - so the scan priced
   * such a coin at ~$45k for as long as it stayed on the watchlist, whatever its pool traded at
   * (2026-10-11/12: seven coins, one of them dead at $2.7k and still read in band). The per-token
   * endpoint lists the pool. A curve with no pool listed keeps its answer and is not re-read
   * again until its backoff passes (see noteCurveWithoutPool). Bounded per batch; a failed
   * re-read keeps the batch's answer.
   */
  private async repairFrozenCurves(
    pairs: DexScreenerPair[],
    tokens: CandidateToken[],
    gate: { acquire: () => Promise<void>; throttled: (delayMs: number) => void },
  ): Promise<CandidateToken[]> {
    const atGraduation = new Set(
      pairs
        .filter(
          (p) =>
            p.chainId === SOLANA_CHAIN_ID &&
            p.dexId === "pumpfun" &&
            p.quoteToken?.address === WRAPPED_SOL_MINT &&
            Number(p.priceNative) >= CURVE_GRADUATION_PRICE_SOL,
        )
        .map((p) => p.baseToken?.address),
    );
    const now = Date.now();
    const suspects = tokens
      .filter(
        (t) =>
          t.dexId === "pumpfun" &&
          atGraduation.has(t.mintAddress) &&
          (this.curveRechecks.get(t.mintAddress)?.at ?? 0) <= now,
      )
      .slice(0, MAX_CURVE_REPAIRS_PER_BATCH);
    if (suspects.length === 0) return tokens;
    const repaired = new Map<string, CandidateToken>();
    await Promise.all(
      suspects.map(async (t) => {
        try {
          const own = await this.tokenPairs(t.mintAddress, gate);
          // The curve is known to be at its graduation price, so any PumpSwap pool above dust is
          // the market - even a drained one beside a curve whose last hour still shows the bundle.
          const pools = own.filter(
            (p) => p.dexId === "pumpswap" && (p.liquidity?.usd ?? 0) >= MIN_DRAINED_PUMPSWAP_LIQUIDITY_USD,
          );
          if (pools.length === 0) {
            this.noteCurveWithoutPool(t.mintAddress, now);
            return;
          }
          this.curveRechecks.delete(t.mintAddress);
          const [token] = this.selectCanonicalPairs(own.filter((p) => p.dexId !== "pumpfun"));
          if (token) repaired.set(t.mintAddress, token);
        } catch (err) {
          logger.warn("frozen-curve re-read failed", { error: String(err) });
        }
      }),
    );
    return tokens.map((t) => repaired.get(t.mintAddress) ?? t);
  }

  /**
   * A re-read found no pool beside the curve: most such curves are ordinary graduates whose pool
   * DexScreener lists nowhere, quiet for hours, and re-reading each of them in every lookup cost
   * the scan's refresh ~30 requests a cycle and its 10 s deadline (worker health, 2026-10-12: 4
   * batches given up every cycle). The next re-read waits CURVE_RECHECK_FIRST_MS, doubling with
   * each miss up to CURVE_RECHECK_MAX_MS, so a pool that is only slow to be indexed is still found
   * within a minute or two.
   */
  private noteCurveWithoutPool(mint: string, now: number): void {
    const misses = (this.curveRechecks.get(mint)?.misses ?? 0) + 1;
    const wait = Math.min(CURVE_RECHECK_MAX_MS, CURVE_RECHECK_FIRST_MS * 2 ** (misses - 1));
    this.curveRechecks.delete(mint);
    this.curveRechecks.set(mint, { at: now + wait, misses });
    if (this.curveRechecks.size <= CURVE_RECHECK_MAX_MINTS) return;
    // Insertion order is last-miss order (re-inserted above), so the longest quiet go first.
    for (const key of this.curveRechecks.keys()) {
      if (this.curveRechecks.size <= CURVE_RECHECK_MAX_MINTS) break;
      this.curveRechecks.delete(key);
    }
  }

  /**
   * Prices the pairs DexScreener answered without a USD price because they are quoted in another
   * coin rather than SOL or a dollar: Pump.fun lets a launch pair its curve with any coin (PUMP,
   * SPYx, another launch), and DexScreener then sends priceNative alone - no priceUsd, market cap,
   * liquidity or volume. Every lookup but the scan's band refresh used to read such a coin as $0
   * (the outcome watcher, live prices, fast-match, peaks): 301 of the 7,408 coins graded in the week
   * to 2026-10-14. The price is priceNative times the quote coin's own USD price; the cap is that
   * on Pump.fun's fixed 1B supply. Off Pump.fun the supply is unknown, so the cap stays 0 for the
   * fallback to fill. Never throws: a quote that can't be priced leaves its pairs as they were.
   */
  private async priceInQuoteToken(
    pairs: DexScreenerPair[],
    tokens: CandidateToken[],
    gate: { acquire: () => Promise<void>; throttled: (delayMs: number) => void },
  ): Promise<CandidateToken[]> {
    const byPair = new Map(pairs.map((p) => [p.pairAddress, p]));
    const unpriced = tokens.flatMap((t) => {
      const pair = t.priceUsd > 0 || !t.pairAddress ? undefined : byPair.get(t.pairAddress);
      const quote = pair?.quoteToken?.address;
      const native = Number(pair?.priceNative);
      if (!quote || USD_PRICED_QUOTES.has(quote) || !(native > 0)) return [];
      return [{ token: t, quote, native }];
    });
    if (unpriced.length === 0) return tokens;
    const quoteUsd = await this.quoteUsdPrices([...new Set(unpriced.map((u) => u.quote))], gate);
    const priced = new Map<string, CandidateToken>();
    for (const { token, quote, native } of unpriced) {
      const usd = quoteUsd.get(quote);
      if (!usd) continue;
      const priceUsd = native * usd;
      const onPump = token.dexId === "pumpfun" || token.dexId === "pumpswap";
      if (this.quotePriced.size >= QUOTE_PRICE_MAX_MINTS) this.quotePriced.clear();
      this.quotePriced.add(token.mintAddress);
      priced.set(token.mintAddress, {
        ...token,
        priceUsd,
        marketCapUsd: onPump ? priceUsd * PUMP_FUN_SUPPLY : token.marketCapUsd,
      });
    }
    return tokens.map((t) => priced.get(t.mintAddress) ?? t);
  }

  /**
   * USD prices of quote coins, each off its deepest pair that has one. Reused for
   * QUOTE_PRICE_TTL_MS: a handful of coins (PUMP, SPYx) quote most of these pairs, so a lookup
   * rarely asks for one. A coin with no USD price is remembered as such for the same time.
   */
  private async quoteUsdPrices(
    mints: string[],
    gate: { acquire: () => Promise<void>; throttled: (delayMs: number) => void },
    hops = 0,
  ): Promise<Map<string, number>> {
    const now = Date.now();
    const out = new Map<string, number>();
    const ask: string[] = [];
    for (const mint of mints) {
      const known = this.quoteUsd.get(mint);
      if (known && now - known.at < QUOTE_PRICE_TTL_MS) {
        if (known.usd > 0) out.set(mint, known.usd);
      } else ask.push(mint);
    }
    if (ask.length === 0) return out;
    const batch = ask.slice(0, BATCH_SIZE);
    try {
      const pairs = await fetchJson<DexScreenerPair[]>(
        `${this.baseUrl}/tokens/v1/${SOLANA_CHAIN_ID}/${batch.join(",")}`,
        { timeoutMs: 5000, retries: 0, gate },
      );
      if (this.quoteUsd.size > QUOTE_PRICE_MAX_MINTS) this.quoteUsd.clear();
      // A quote coin can itself trade only against another coin (2XLONGINU on LONGINU, on SOL):
      // it is priced through that coin in turn, up to MAX_QUOTE_HOPS deep.
      const chained = new Map<string, { quote: string; native: number }>();
      for (const mint of batch) {
        let best: DexScreenerPair | undefined;
        let viaQuote: DexScreenerPair | undefined;
        for (const p of pairs ?? []) {
          if (p.chainId !== SOLANA_CHAIN_ID || p.baseToken?.address !== mint) continue;
          if (Number(p.priceUsd) > 0) {
            if (!best || (p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = p;
          } else if (Number(p.priceNative) > 0 && p.quoteToken?.address && p.quoteToken.address !== mint) {
            viaQuote ??= p;
          }
        }
        const usd = best ? Number(best.priceUsd) : 0;
        if (usd <= 0 && viaQuote && hops < MAX_QUOTE_HOPS) {
          chained.set(mint, { quote: viaQuote.quoteToken.address, native: Number(viaQuote.priceNative) });
          continue;
        }
        this.quoteUsd.set(mint, { usd, at: now });
        if (usd > 0) out.set(mint, usd);
      }
      if (chained.size > 0) {
        const next = await this.quoteUsdPrices(
          [...new Set([...chained.values()].map((c) => c.quote))],
          gate,
          hops + 1,
        );
        for (const [mint, { quote, native }] of chained) {
          const usd = native * (next.get(quote) ?? 0);
          this.quoteUsd.set(mint, { usd, at: now });
          if (usd > 0) out.set(mint, usd);
        }
      }
    } catch (err) {
      logger.warn("quote-token price lookup failed", { error: String(err) });
    }
    return out;
  }

  /** Every pair DexScreener lists for one mint as its base token (/token-pairs/v1). */
  private async tokenPairs(
    mintAddress: string,
    gate: { acquire: () => Promise<void>; throttled: (delayMs: number) => void },
  ): Promise<DexScreenerPair[]> {
    const pairs = await fetchJson<DexScreenerPair[]>(
      `${this.baseUrl}/token-pairs/v1/${SOLANA_CHAIN_ID}/${encodeURIComponent(mintAddress)}`,
      { timeoutMs: 5000, retries: 0, gate },
    );
    return (pairs ?? []).filter((p) => p.chainId === SOLANA_CHAIN_ID && p.baseToken?.address === mintAddress);
  }

  /** One DexScreener lookup; `answeredOut` collects the mints whose batch came back. */
  private async lookup(
    unique: string[],
    concurrency: number,
    options: TokenLookupOptions,
    answeredOut?: Set<string>,
  ): Promise<CandidateToken[]> {
    const {
      deadlineMs,
      seenAt,
      failed,
      priority,
      fresh,
      fallbackIfUnlisted: _fallbackIfUnlisted,
      freshSources: _freshSources,
      ...fetchOptions
    } = options;

    // Mints another job priced moments ago are answered from that reading, at its own time.
    const results: CandidateToken[] = [];
    // Mints whose batch came back (or the cache answered), for `failed` - see the note at the return.
    const settled = new Set<string>();
    let toFetch = unique;
    if (!fresh) {
      const cutoff = Date.now() - QUOTE_CACHE_MS;
      toFetch = [];
      for (const mint of unique) {
        const q = this.quotes.get(mint);
        if (!q || q.at.getTime() <= cutoff) {
          toFetch.push(mint);
          continue;
        }
        // A copy: callers decorate what they get back, and the next reader must not see that.
        results.push({ ...q.token });
        seenAt?.set(mint, q.at);
        settled.add(mint);
        answeredOut?.add(mint);
        this.quoteHits += 1;
      }
    }

    const chunks: string[][] = [];
    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      chunks.push(toFetch.slice(i, i + BATCH_SIZE));
    }

    // Bounded-concurrency worker pool (same shared helper as RugCheckClient.getProfiles):
    // fetching chunks one at a time made the watchlist refresh step scale linearly with
    // watchlist size - at the default WATCHLIST_MAX_TRACKED that's up to 30 sequential round
    // trips, adding real wall-clock time to every scan cycle. A modest concurrency cap gets most
    // of the speedup without hammering a public, unauthenticated API with 30 simultaneous requests.
    const deadline = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
    let skipped = 0;
    const gate = {
      acquire: () => this.gate.acquire(deadline, priority === true),
      throttled: (delayMs: number) => this.gate.throttled(delayMs),
    };
    const work = forEachWithConcurrency(chunks, concurrency, async (chunk) => {
      if (Date.now() >= deadline) {
        skipped += chunk.length;
        for (const mint of chunk) failed?.add(mint);
        return;
      }
      try {
        const pairs = await fetchJson<DexScreenerPair[]>(
          `${this.baseUrl}/tokens/v1/${SOLANA_CHAIN_ID}/${chunk.join(",")}`,
          { ...fetchOptions, gate },
        );
        const answered = new Date();
        for (const mint of chunk) settled.add(mint);
        for (const mint of chunk) answeredOut?.add(mint);
        const tokens = await this.priceInQuoteToken(
          pairs ?? [],
          await this.repairFrozenCurves(
            pairs ?? [],
            this.selectCanonicalPairs(pairs ?? [], new Set(chunk)),
            gate,
          ),
          gate,
        );
        if (seenAt) for (const t of tokens) seenAt.set(t.mintAddress, answered);
        this.rememberQuotes(tokens, answered);
        results.push(...tokens.map((t) => ({ ...t })));
      } catch (err) {
        for (const mint of chunk) failed?.add(mint);
        // Queued behind the budget past the deadline: the same as reaching the deadline unsent.
        if (err instanceof RateGateDeadlineError) {
          skipped += chunk.length;
          return;
        }
        logger.warn("failed to fetch token batch", { chunkSize: chunk.length, error: String(err) });
      }
    });
    if (deadline === Infinity) {
      await work;
      return results;
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = await Promise.race([
      work.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), Math.max(0, deadline - Date.now()));
      }),
    ]).finally(() => clearTimeout(timer));
    if (expired || skipped > 0) {
      logger.warn("token lookup past its deadline - returning what answered", {
        answered: results.length,
        requested: unique.length,
        deadlineMs,
      });
    }
    // Batches still in flight past the deadline never reach the caller, so they count as failed.
    if (failed) for (const mint of unique) if (!settled.has(mint)) failed.add(mint);
    // A copy: batches still in flight past the deadline keep pushing into `results`.
    return [...results];
  }

  /**
   * Secondary discovery source, alongside Pump.fun: mints DexScreener itself has recently seen a
   * profile update or a paid boost for. This exists for resilience (Pump.fun's API is unofficial
   * and undocumented - if it changes or blocks us, discovery shouldn't stop entirely) and for
   * coverage (catches tokens that launched directly on a DEX rather than through a pump.fun
   * bonding curve, which the Pump.fun-only discovery path would never see at all).
   *
   * Neither endpoint returns market data or a symbol/name, only the mint address and social
   * links - callers add these to the watchlist bare and let the next cycle's DexScreener batch
   * lookup (getTokensByAddresses) fill in the rest, same as freshly-discovered Pump.fun mints do.
   */
  async discoverTrendingMints(): Promise<WatchlistCandidate[]> {
    const [profiles, boosts] = await Promise.all([
      this.fetchDiscoveryEndpoint("/token-profiles/latest/v1"),
      this.fetchDiscoveryEndpoint("/token-boosts/latest/v1"),
    ]);

    // Boosts are paid placements; which mints bought one is recorded (Token.dexBoosted) so the
    // learner can find out whether a paid boost helps or hurts a call.
    const boosted = new Set(boosts.filter((b) => b.chainId === SOLANA_CHAIN_ID).map((b) => b.tokenAddress));
    const byMint = new Map<string, WatchlistCandidate>();
    for (const entry of [...profiles, ...boosts]) {
      if (entry.chainId !== SOLANA_CHAIN_ID || !entry.tokenAddress) continue;
      const links = entry.links ?? [];
      byMint.set(entry.tokenAddress, {
        mintAddress: entry.tokenAddress,
        hasTwitter: links.some((l) => l.type === "twitter"),
        hasTelegram: links.some((l) => l.type === "telegram"),
        hasWebsite: links.some((l) => !l.type || l.type === "website"),
        twitterUrl: normalizeSocialUrl(links.find((l) => l.type === "twitter")?.url, "twitter") ?? undefined,
        websiteUrl:
          normalizeSocialUrl(links.find((l) => !l.type || l.type === "website")?.url, "website") ?? undefined,
        discoverySource: "dexscreener",
        boosted: boosted.has(entry.tokenAddress),
      });
    }
    return [...byMint.values()];
  }

  private async fetchDiscoveryEndpoint(path: string): Promise<DexScreenerDiscoveryEntry[]> {
    try {
      return await fetchJson<DexScreenerDiscoveryEntry[]>(`${this.baseUrl}${path}`, {
        timeoutMs: 8000,
        retries: 1,
      });
    } catch (err) {
      logger.warn("discovery endpoint failed", { path, error: String(err) });
      return [];
    }
  }

  /** Free-text search, mainly useful for manual lookups / debugging rather than the scan loop. */
  async search(query: string): Promise<CandidateToken[]> {
    try {
      const data = await fetchJson<{ pairs?: DexScreenerPair[] }>(
        `${this.baseUrl}/latest/dex/search?q=${encodeURIComponent(query)}`,
      );
      return this.selectCanonicalPairs((data.pairs ?? []).filter((p) => p.chainId === SOLANA_CHAIN_ID));
    } catch (err) {
      logger.warn("search failed", { query, error: String(err) });
      return [];
    }
  }

  /**
   * Collapses multiple pairs-per-mint down to one CandidateToken. When `requested` is given, only
   * pairs whose base token is one of those mints count - DexScreener also returns pairs where a
   * requested mint is the quote token, and those carry the other token's price and mcap.
   */
  private selectCanonicalPairs(pairs: DexScreenerPair[], requested?: Set<string>): CandidateToken[] {
    const byMint = new Map<string, DexScreenerPair[]>();
    for (const pair of pairs) {
      if (pair.chainId !== SOLANA_CHAIN_ID) continue;
      const mint = pair.baseToken?.address;
      if (!mint || (requested && !requested.has(mint))) continue;
      const list = byMint.get(mint);
      if (list) list.push(pair);
      else byMint.set(mint, [pair]);
    }
    return [...byMint.values()].map((list) => {
      const token = toCandidateToken(pickCanonicalPair(list));
      const graduatedAt = deriveGraduated(token.dexId) ? pumpSwapPoolCreatedAt(list) : undefined;
      return graduatedAt ? { ...token, graduatedAt } : token;
    });
  }
}

/**
 * When a graduated Pump.fun mint left its bonding curve: the creation time of its PumpSwap pool,
 * which Pump.fun's migration opens in the same transaction that completes the curve. The earliest
 * pool counts - a pool someone opened by hand before graduation only makes the curve look longer,
 * never shorter. Undefined without a PumpSwap pool (an older Raydium graduation, or none listed).
 */
export function pumpSwapPoolCreatedAt(
  pairs: Pick<DexScreenerPair, "dexId" | "pairCreatedAt">[],
): Date | undefined {
  const times = pairs
    .filter((p) => p.dexId === "pumpswap" && typeof p.pairCreatedAt === "number" && p.pairCreatedAt > 0)
    .map((p) => p.pairCreatedAt as number);
  return times.length > 0 ? new Date(Math.min(...times)) : undefined;
}

const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
/** Quotes DexScreener prices a pair in USD against: SOL, USDC and USDT. */
const USD_PRICED_QUOTES = new Set([
  WRAPPED_SOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
/** Every Pump.fun mint's supply: its market cap is its price on this many tokens. */
const PUMP_FUN_SUPPLY = 1_000_000_000;
/** How long a quote coin's USD price is reused - see quoteUsdPrices. */
const QUOTE_PRICE_TTL_MS = 30_000;
/** How many coins deep a quote coin is priced through its own quote coin - see quoteUsdPrices. */
const MAX_QUOTE_HOPS = 2;
/** Quote coins' prices remembered at once. */
const QUOTE_PRICE_MAX_MINTS = 2_000;
/**
 * A Pump.fun curve at or above this price (SOL per token) is at its graduation price or within a
 * few percent of it: a completed curve stops at about 4.11e-7 (85 SOL raised), and DexScreener's
 * frozen curves read 3.94e-7 to 4.11e-7 - the last bundle buy can stop short of the top.
 */
const CURVE_GRADUATION_PRICE_SOL = 3.8e-7;
/** Frozen-curve re-reads one batch of 30 may make (see repairFrozenCurves). */
const MAX_CURVE_REPAIRS_PER_BATCH = 5;
/** The wait before re-reading a curve whose last re-read found no pool, doubling per miss. */
const CURVE_RECHECK_FIRST_MS = 60_000;
const CURVE_RECHECK_MAX_MS = 15 * 60_000;
/** Curves whose re-read backoff is remembered at once. */
const CURVE_RECHECK_MAX_MINTS = 5_000;

/** Below this, a non-curve pool is too thin to be a trustworthy price source. */
const MIN_CANONICAL_POOL_LIQUIDITY_USD = 1000;
/**
 * A pumpswap pool this thin beside a quiet curve is a dust pool someone opened on a coin still on
 * its curve, not a drained graduation pool. Pump.fun's LP is burned at graduation, so a real pool
 * keeps both sides: even with the whole remaining supply sold into it, it holds about a fifth of
 * the SOL it was seeded with, worth well over this.
 */
const MIN_DRAINED_PUMPSWAP_LIQUIDITY_USD = 250;

/**
 * The pair a mint's market data is read from. A pre-bond Pump.fun curve pair reports no
 * liquidity object at all, so "deepest liquidity" alone let any $1 side pool someone opened for
 * the mint outrank the curve - mispricing it and flipping deriveGraduated to true. So:
 *  - a funded pumpswap pool (Pump.fun's graduation target) means the mint has graduated, and the
 *    deepest real pool is canonical;
 *  - otherwise a curve that is still trading is canonical, whatever side pools exist;
 *  - otherwise a drained pumpswap pool (under the funded threshold but above dust) beats the
 *    quiet curve, which DexScreener keeps listing frozen at the graduation price;
 *  - otherwise (a non-Pump.fun token, or an older Raydium graduation) the deepest real pool,
 *    falling back to the deepest pair of any size.
 */
export function pickCanonicalPair<
  P extends Pick<DexScreenerPair, "dexId" | "liquidity" | "volume"> &
    Partial<Pick<DexScreenerPair, "txns" | "quoteToken">>,
>(pairs: P[]): P {
  const liq = (p: P) => p.liquidity?.usd ?? 0;
  const deepest = (list: P[]) => list.reduce((best, p) => (liq(p) > liq(best) ? p : best));
  // A pair quoted in another coin reports no USD volume (0) while it trades, so its trade count
  // says whether it is active.
  const trades1h = (p: P) => (p.txns?.h1?.buys ?? 0) + (p.txns?.h1?.sells ?? 0);
  const active = (p: P) => (p.volume?.h1 ?? 0) > 0 || trades1h(p) > 0;
  const pools = pairs.filter((p) => p.dexId !== "pumpfun" && liq(p) >= MIN_CANONICAL_POOL_LIQUIDITY_USD);
  if (pools.some((p) => p.dexId === "pumpswap")) return deepest(pools);
  // A curve quoted in another coin graduates into a pumpswap pool quoted in that coin, which
  // DexScreener can't value either (no liquidity figure): once it trades, it is the market.
  const quote = (p: P) => p.quoteToken?.address;
  const tokenQuotedPools = pairs.filter(
    (p) =>
      p.dexId === "pumpswap" &&
      p.liquidity?.usd === undefined &&
      trades1h(p) > 0 &&
      quote(p) !== undefined &&
      !USD_PRICED_QUOTES.has(quote(p)!) &&
      pairs.some((c) => c.dexId === "pumpfun" && quote(c) === quote(p)),
  );
  if (tokenQuotedPools.length > 0) {
    return tokenQuotedPools.reduce((best, p) => (trades1h(p) > trades1h(best) ? p : best));
  }
  const curve = pairs.find((p) => p.dexId === "pumpfun" && active(p));
  if (curve) return curve;
  // A quiet curve beside a drained pumpswap pool is a graduated coin: DexScreener keeps listing the
  // old curve frozen at the graduation price, so it must not win. A dust pool is still no signal.
  const drained = pairs.filter((p) => p.dexId === "pumpswap" && liq(p) >= MIN_DRAINED_PUMPSWAP_LIQUIDITY_USD);
  if (drained.length > 0) return deepest([...pools, ...drained]);
  if (pools.length > 0) return deepest(pools);
  // No real pool and a quiet curve: the curve is still where the token lives. Falling through to
  // the deepest pair of any size let a few dollars in a side pool outrank it - pricing the token
  // off that pool and reading it as graduated.
  const quietCurve = pairs.find((p) => p.dexId === "pumpfun");
  return quietCurve ?? deepest(pairs);
}

function toCandidateToken(pair: DexScreenerPair): CandidateToken {
  const socials = pair.info?.socials ?? [];
  // A pair DexScreener can't price in USD (one quoted in another coin) reports its USD volume as
  // 0 however much it trades: unknown, not a dead coin.
  const usd = pair.priceUsd === undefined ? undefined : pair.volume;
  return {
    mintAddress: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    pairAddress: pair.pairAddress,
    priceUsd: Number(pair.priceUsd ?? 0),
    marketCapUsd: pair.marketCap ?? pair.fdv ?? 0,
    liquidityUsd: pair.liquidity?.usd,
    volume24hUsd: usd?.h24,
    buys24h: pair.txns?.h24?.buys,
    sells24h: pair.txns?.h24?.sells,
    priceChange5mPct: pair.priceChange?.m5,
    priceChange1hPct: pair.priceChange?.h1,
    priceChange6hPct: pair.priceChange?.h6,
    priceChange24hPct: pair.priceChange?.h24,
    volume5mUsd: usd?.m5,
    volume1hUsd: usd?.h1,
    buys5m: pair.txns?.m5?.buys,
    sells5m: pair.txns?.m5?.sells,
    buys1h: pair.txns?.h1?.buys,
    sells1h: pair.txns?.h1?.sells,
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : undefined,
    hasTwitter: socials.some((s) => s.type === "twitter"),
    hasTelegram: socials.some((s) => s.type === "telegram"),
    hasWebsite: (pair.info?.websites?.length ?? 0) > 0,
    imageUrl: pair.info?.imageUrl,
    dexId: pair.dexId,
  };
}

/**
 * Whether a Pump.fun mint has graduated off its bonding curve, derived from which DEX its
 * DexScreener pair currently trades on - the reliable, current signal, unlike Pump.fun's own
 * `complete` flag (only known at discovery time, and discarded well before a mint reaches
 * scoring - see WatchlistCandidate's comment). Confirmed live: a pre-bond mint's pair reports
 * `dexId: "pumpfun"` with no liquidity object at all (the bonding curve isn't a discrete pool);
 * a graduated one reports `dexId: "pumpswap"` (Pump.fun's own AMM, their current graduation
 * target) with real liquidity. Undefined dexId (no pair at all, e.g. a mint DexScreener hasn't
 * indexed) means unknown, not "not graduated" - deliberately not assumed either way.
 */
export function deriveGraduated(dexId: string | undefined): boolean | undefined {
  return dexId === undefined ? undefined : dexId !== "pumpfun";
}
