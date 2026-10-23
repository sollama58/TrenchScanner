import { fetchJson, HttpError } from "./httpClient.js";
import { pumpFunFrontendGate, pumpFunSwapGate, type PumpFunGate } from "./pumpfunGate.js";
import { createLogger } from "../logger.js";
import { mintSupplies, onCurrentSupply } from "../mintSupply.js";
import { normalizeSocialUrl } from "./tokensage.js";
import { looksLikeSolanaAddress } from "../solana.js";
import type { MinuteCandle } from "../curation/regrade.js";
import { tradesFromPumpFun, type PumpFunTradesPage } from "../wallets/tradeTape.js";

const logger = createLogger("pumpfun");

/** Candles per answer of Pump.fun's candle API: its most recent minutes with trades. */
export const MINUTE_CANDLE_PAGE = 1000;

/** Exported for tests. Candles with a usable start and close, oldest first. */
export function parseMinuteCandles(body: unknown): MinuteCandle[] {
  if (!Array.isArray(body)) return [];
  const out: MinuteCandle[] = [];
  for (const c of body as { timestamp?: unknown; close?: unknown }[]) {
    const startMs = typeof c?.timestamp === "number" ? c.timestamp : Number.NaN;
    const close = typeof c?.close === "string" || typeof c?.close === "number" ? Number(c.close) : Number.NaN;
    if (Number.isFinite(startMs) && Number.isFinite(close) && close > 0) out.push({ startMs, close });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * Pump.fun's frontend API is unofficial/undocumented (no public API contract),
 * used here purely for *discovery* - finding candidate mint addresses to feed
 * into DexScreener + rug screening. Field names come from observed responses
 * and may drift if pump.fun changes their frontend; every call here is
 * wrapped so a failure just yields fewer discovered candidates, never a crash.
 */
interface PumpFunCoin {
  mint: string;
  name?: string;
  symbol?: string;
  description?: string;
  /** The token's artwork, usually an IPFS gateway URL. Present on essentially every coin. */
  image_uri?: string;
  created_timestamp?: number; // epoch ms
  complete?: boolean; // true once the bonding curve has graduated to an AMM pool
  usd_market_cap?: number;
  market_cap_usd?: number;
  twitter?: string;
  telegram?: string;
  website?: string;
  /** True while the coin's Pump.fun livestream is on. */
  is_currently_live?: boolean;
  /** People watching the livestream right now (the currently-live feed only). */
  num_participants?: number;
  /** "active", "paused" or "completed" on a Mayhem Mode coin; null on every other. */
  mayhem_state?: string | null;
  /**
   * True when the creator picked a donate.gg charity in the Pump.fun app (coins-v2, captured
   * 2026-06-17). The organization's name is not in that capture. A later payload can name the
   * organization and omit this flag; see charityNameFromPumpCoin.
   */
  is_charity?: boolean | null;
  /** CamelCase twin of is_charity, when a payload uses it. */
  isCharity?: boolean | null;
  /**
   * The charity's name. frontend-api-v3 was blocked here (2026-10-22), so the live coin was not
   * re-read. Payloads have used charity_name, charityName, and a nested charity object.
   */
  charity_name?: string | null;
  charityName?: string | null;
  /**
   * The organization as its own object: name, charity_name, or charityName, or those same keys
   * one level further down on charity.
   */
  charity?:
    | {
        name?: string | null;
        charity_name?: string | null;
        charityName?: string | null;
        charity?:
          { name?: string | null; charity_name?: string | null; charityName?: string | null } | string | null;
      }
    | string
    | null;
  /** The wallet that launched the coin. */
  creator?: string;
}

/** One coin's Pump.fun livestream as the currently-live feed reports it. */
export interface LiveStream {
  /** People watching right now; null when the feed didn't say. */
  viewers: number | null;
  /**
   * The coin as the feed reports it (market cap, description, socials): with the coin list
   * blocked, the one Pump.fun list still answering, so it also feeds discovery and revival.
   */
  coin?: DiscoveredCoin;
}

export interface DiscoveredCoin {
  mintAddress: string;
  symbol?: string;
  name?: string;
  imageUrl?: string;
  description?: string;
  createdAt?: Date;
  graduated: boolean;
  marketCapUsd?: number;
  /**
   * Undefined when the source carries no socials at all (Jupiter's lists): unknown, not "none".
   * A source that does carry them (Pump.fun's coin details, the launch metadata) says true/false.
   */
  hasTwitter?: boolean;
  hasTelegram?: boolean;
  hasWebsite?: boolean;
  /** The launcher's X link and website, https only (normalizeSocialUrl). */
  twitterUrl?: string;
  websiteUrl?: string;
  /** Launched in Mayhem Mode, per Pump.fun's own flag; undefined when the coin carries none. */
  mayhemMode?: true;
  /** The launchpad, normalized (launchpads.ts); undefined means Pump.fun's own lists. */
  launchpad?: string;
  /** The wallet that launched the coin, when the source names one - recorded as Token.creator. */
  creator?: string;
}

export interface PumpFunClientOptions {
  baseUrl?: string;
  /** Pump.fun's trade API (the chart's candles). */
  swapBaseUrl?: string;
  /** Each host's budget (pumpfunGate.ts): the process's own unless a test brings its own. */
  gates?: {
    frontend: Pick<PumpFunGate, "acquire" | "throttled">;
    swap: Pick<PumpFunGate, "acquire" | "throttled">;
  };
}

/**
 * Coins asked for per page. Pump.fun's /coins sends at most 70 a page whatever `limit` asks
 * (checked 2026-10-08), and the pages here are fetched at once at offsets of page * limit - so a
 * limit above that cap skipped coins 70-99 of every page. Kept under the cap with room to spare.
 */
const PAGE_SIZE = 50;

type SortField = "market_cap" | "created_timestamp" | "last_trade_timestamp";
type SortOrder = "ASC" | "DESC";

/** How the coin-list pages fared since the last takeListStats - see PumpFunClient.takeListStats. */
export interface PumpFunListStats {
  pages: number;
  failed: number;
  /** Pages not asked: the list answered with a block (HTTP 403) less than LIST_BLOCK_BACKOFF_MS ago. */
  skipped: number;
  lastError?: string;
}

/**
 * How long a blocked coin list (HTTP 403, a Cloudflare challenge) is left alone before it is asked
 * again. A blocked page fails at once with nothing in it, so skipping it costs no coins; the wait
 * only spares nine certain failures a cycle and is kept short so a lifted block is noticed within
 * a minute. One page is then tried, and the rest follow on the next cycle when it answers.
 */
export const LIST_BLOCK_BACKOFF_MS = 60_000;

export class PumpFunClient {
  private readonly baseUrl: string;
  private readonly swapBaseUrl: string;
  private listStats: PumpFunListStats = { pages: 0, failed: 0, skipped: 0 };
  private listBlockedUntil = 0;
  /** A page is asking whether the block has lifted: the others stay skipped until it answers. */
  private listProbing = false;
  private readonly frontendGate: Pick<PumpFunGate, "acquire" | "throttled">;
  private readonly swapGate: Pick<PumpFunGate, "acquire" | "throttled">;

  constructor(options: PumpFunClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://frontend-api-v3.pump.fun";
    this.swapBaseUrl = options.swapBaseUrl ?? "https://swap-api.pump.fun";
    this.frontendGate = options.gates?.frontend ?? pumpFunFrontendGate;
    this.swapGate = options.gates?.swap ?? pumpFunSwapGate;
  }

  /**
   * Discovers newly-created mints, newest first. This is deliberately NOT
   * filtered by market cap: pump.fun's `sort=market_cap&order=ASC` was
   * tried and found useless for finding our target band - the vast
   * majority of tokens sit at ~0 mcap (freshly launched, untraded) or
   * exactly at pump.fun's bonding-curve starting value, so ascending pages
   * are dominated by dead-on-arrival tokens and rarely reach five figures
   * within any reasonable page depth. `order=DESC` is just as useless from
   * the top (hundreds of millions in mcap, thousands of pages to page
   * through). There is no market-cap range filter in this API.
   *
   * Instead, the caller (the worker's scan job) is expected to add every
   * newly-seen mint to a persistent watchlist and re-check its live mcap
   * via DexScreener on every subsequent cycle - that's what actually
   * catches a token as it climbs from ~$2k at launch into the 50k-500k
   * band, rather than needing this snapshot to catch it mid-band by luck.
   */
  async discoverNewMints(opts: { pages?: number; limit?: number } = {}): Promise<DiscoveredCoin[]> {
    const { pages = 6, limit = PAGE_SIZE } = opts;
    const seen = new Map<string, DiscoveredCoin>();

    const fetches: Promise<PumpFunCoin[]>[] = [];
    for (let page = 0; page < pages; page++) {
      fetches.push(this.listCoins({ offset: page * limit, limit, sort: "created_timestamp", order: "DESC" }));
    }

    const settled = await Promise.allSettled(fetches);
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const coin of result.value) {
        if (!coin.mint) continue;
        seen.set(coin.mint, toDiscoveredCoin(coin));
      }
    }
    return [...seen.values()];
  }

  /**
   * The mints traded most recently, whatever their age - Pump.fun's "currently live" ordering.
   * The newest-mints feed only ever shows launches from the last few minutes; this one surfaces
   * a two-hour-old token the moment it starts trading again, which is exactly the slow climber
   * a launch-ordered watchlist loses. Each entry carries Pump.fun's own current market cap, so
   * the caller can put an already-known mint back in front of the scan without waiting for a
   * DexScreener refresh to notice it. Same failure posture as discoverNewMints: a failed page is
   * just fewer results.
   */
  async discoverActiveMints(opts: { pages?: number; limit?: number } = {}): Promise<DiscoveredCoin[]> {
    const { pages = 3, limit = PAGE_SIZE } = opts;
    const settled = await Promise.allSettled(
      Array.from({ length: pages }, (_, page) =>
        this.listCoins({ offset: page * limit, limit, sort: "last_trade_timestamp", order: "DESC" }),
      ),
    );
    const seen = new Map<string, DiscoveredCoin>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const coin of result.value) {
        if (coin.mint) seen.set(coin.mint, toDiscoveredCoin(coin));
      }
    }
    return [...seen.values()];
  }

  /**
   * The coin-list pages (newest and recently-traded feeds) asked for and failed since the last
   * call, for the scan's heartbeat. A failed page only logs a warning and reads as an empty page,
   * so without this a blocked list looks like a quiet minute: from 2026-10-14 about 21:00 UTC the
   * list answered every page with a Cloudflare challenge (HTTP 403) and launches reached the scan
   * from the PumpPortal stream alone, with no description or socials.
   */
  takeListStats(): PumpFunListStats {
    const out = this.listStats;
    this.listStats = { pages: 0, failed: 0, skipped: 0 };
    return out;
  }

  /**
   * One coin as the single-coin endpoint reports it - the same fields the coin list gives
   * (description, socials, image, launch time, Mayhem flag), for a launch the list didn't show.
   * Null when Pump.fun has no such coin; throws on a transport failure.
   */
  async coinDetails(mintAddress: string, timeoutMs = 4_000): Promise<DiscoveredCoin | null> {
    try {
      const coin = await fetchJson<PumpFunCoin | null>(
        `${this.baseUrl}/coins-v2/${encodeURIComponent(mintAddress)}`,
        {
          gate: this.frontendGate,
          timeoutMs,
          retries: 0,
        },
      );
      return coin?.mint === mintAddress ? toDiscoveredCoin(coin) : null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * The charity a Pump.fun charity coin names (user ask 2026-10-21), from the same single-coin
   * endpoint as coinDetails. Null when Pump.fun has no such coin or the payload names no charity.
   * Throws on a transport failure, including a 429 from our own budget.
   */
  /**
   * Every charity this coin names, with the fee percent when the payload gave one.
   * An empty list is "no charity named", including a 404. Throws on a transport failure.
   */
  async charityShares(mintAddress: string, timeoutMs = 2_500): Promise<PumpCharityShare[]> {
    try {
      const coin = await fetchJson<PumpFunCoin | null>(
        `${this.baseUrl}/coins-v2/${encodeURIComponent(mintAddress)}`,
        {
          gate: this.frontendGate,
          timeoutMs,
          retries: 0,
        },
      );
      if (!coin || typeof coin !== "object" || Array.isArray(coin)) return [];
      // A different mint is someone else's coin. A payload that names the charity and leaves
      // mint off still belongs to this request: the path is already the mint.
      if (typeof coin.mint === "string" && coin.mint !== mintAddress) return [];
      return charitySharesFromPumpCoin(coin);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return [];
      throw err;
    }
  }

  async charityName(mintAddress: string, timeoutMs = 2_500): Promise<string | null> {
    const shares = await this.charityShares(mintAddress, timeoutMs);
    // One organization is the name. Several organizations are not one name: callers that
    // need each share use charityShares.
    return shares.length === 1 ? shares[0]!.name : null;
  }

  /**
   * Pump.fun's "king of the hill": the bonding-curve token currently closest to graduating. One
   * coin, refreshed by Pump.fun as the race changes - the strongest single "about to bond"
   * signal the site publishes. Null when the endpoint fails or returns nothing usable.
   */
  async kingOfTheHill(): Promise<DiscoveredCoin | null> {
    try {
      const coin = await fetchJson<PumpFunCoin | null>(
        `${this.baseUrl}/coins/king-of-the-hill?includeNsfw=false`,
        {
          gate: this.frontendGate,
          timeoutMs: 8000,
          retries: 1,
        },
      );
      return coin?.mint ? toDiscoveredCoin(coin) : null;
    } catch (err) {
      logger.warn("king-of-the-hill failed", { error: String(err) });
      return null;
    }
  }

  /**
   * When a coin was launched on its bonding curve (Pump.fun's `created_timestamp`, read from the
   * single-coin endpoint). Null when Pump.fun has no such coin or no usable timestamp - not a
   * Pump.fun launch, so there is nothing to ask again. Throws on a transport failure, so the
   * caller can tell "no answer" from "no launch time".
   */
  async launchTime(mintAddress: string): Promise<Date | null> {
    try {
      const coin = await fetchJson<PumpFunCoin | null>(
        `${this.baseUrl}/coins-v2/${encodeURIComponent(mintAddress)}`,
        {
          gate: this.frontendGate,
          timeoutMs: 5000,
          retries: 0,
        },
      );
      return launchDate(coin?.created_timestamp) ?? null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * The market cap Pump.fun reports for a coin right now, in USD. Read from the coin's own bonding
   * curve or pool state, it tracks the last trade within seconds, where DexScreener's runs 45-60s
   * behind (2026-10-12). On the coin's supply now: Pump.fun's own figure counts the launch billion.
   * Null when Pump.fun has no such coin or no usable figure; throws on a transport failure.
   */
  async liveMarketCap(mintAddress: string, timeoutMs = 2_000): Promise<number | null> {
    try {
      const coin = await fetchJson<PumpFunCoin | null>(
        `${this.baseUrl}/coins-v2/${encodeURIComponent(mintAddress)}`,
        {
          gate: this.frontendGate,
          timeoutMs,
          retries: 0,
        },
      );
      const mcap = coin?.usd_market_cap ?? coin?.market_cap_usd;
      if (!(typeof mcap === "number" && Number.isFinite(mcap) && mcap > 0)) return null;
      // Pump.fun prices every coin on its launch billion; burns are put back in (mintSupply.ts).
      const supplies = await mintSupplies()
        .get([mintAddress], Math.min(timeoutMs, 1_000))
        .catch(() => new Map<string, number>());
      const supply = supplies.get(mintAddress);
      return onCurrentSupply(mcap, supply);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * One page of a coin's trades, newest first, starting before `cursor` (pumpFunCursorBefore for a
   * point in time, or the last page's nextCursor) - the trade tape's free source. Rate-limited
   * hard (429 after a burst, Retry-After 10-50 s), so callers space their calls. Null when Pump.fun
   * has no such coin; throws on a transport failure (a 429 included).
   */
  async coinTrades(
    mintAddress: string,
    cursor: string,
    timeoutMs = 10_000,
  ): Promise<PumpFunTradesPage | null> {
    try {
      const body = await fetchJson<unknown>(
        `${this.swapBaseUrl}/v2/coins/${encodeURIComponent(mintAddress)}/trades?limit=100&cursor=${encodeURIComponent(cursor)}`,
        {
          gate: this.swapGate,
          timeoutMs,
          retries: 0,
        },
      );
      return tradesFromPumpFun(body);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * A coin's creator and launch time, from the single-coin endpoint. Null when Pump.fun has no
   * such coin; throws on a transport failure.
   */
  async coinOrigin(mintAddress: string): Promise<{ creator: string | null; createdAt: Date | null } | null> {
    try {
      const coin = await fetchJson<(PumpFunCoin & { creator?: unknown }) | null>(
        `${this.baseUrl}/coins-v2/${encodeURIComponent(mintAddress)}`,
        {
          gate: this.frontendGate,
          timeoutMs: 5000,
          retries: 0,
        },
      );
      if (!coin) return null;
      return {
        creator: typeof coin.creator === "string" && coin.creator ? coin.creator : null,
        createdAt: launchDate(coin.created_timestamp) ?? null,
      };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * The coin's one-minute USD candles from its own trades, curve and PumpSwap pool alike (the
   * chart on its Pump.fun page): the most recent MINUTE_CANDLE_PAGE minutes that had a trade,
   * oldest first, as each minute's start and closing price. A minute with no trade has no candle.
   * The API takes no time range, so a list shorter than the page is the coin's whole history.
   * Null when Pump.fun has no such coin; throws on a transport failure (a 429 included).
   */
  async minuteCandles(mintAddress: string, timeoutMs = 10_000): Promise<MinuteCandle[] | null> {
    return this.candlePage(mintAddress, "1m", timeoutMs);
  }

  /**
   * The same chart in five-minute candles, which reach about five times further back: for a coin
   * that has traded past MINUTE_CANDLE_PAGE minutes since the moment wanted. Each candle is put on
   * the minute grid as its last minute (start + 4 minutes), so its close counts only once the five
   * minutes are over, the way a minute candle's does.
   */
  async fiveMinuteCandles(mintAddress: string, timeoutMs = 10_000): Promise<MinuteCandle[] | null> {
    const candles = await this.candlePage(mintAddress, "5m", timeoutMs);
    return candles?.map((c) => ({ ...c, startMs: c.startMs + 4 * 60_000 })) ?? null;
  }

  private async candlePage(
    mintAddress: string,
    interval: "1m" | "5m",
    timeoutMs: number,
  ): Promise<MinuteCandle[] | null> {
    try {
      const body = await fetchJson<unknown>(
        `${this.swapBaseUrl}/v1/coins/${encodeURIComponent(mintAddress)}/candles?interval=${interval}&limit=${MINUTE_CANDLE_PAGE}&currency=USD`,
        {
          gate: this.swapGate,
          timeoutMs,
          retries: 0,
        },
      );
      return parseMinuteCandles(body);
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Which coins have a Pump.fun livestream on right now, with how many people are watching each
   * (`num_participants`). About 75 coins were live at once on 2026-10-08, so two pages on most
   * cycles; a further page is read only while one comes back full. The page size stays under the
   * 70 a page this API actually returns (asked for 100, it sends 70), or a short page would read
   * as the last one. Null when any page fails, or when the last allowed page is still full, so
   * the caller records "unknown" rather than "not live" for every token.
   */
  async currentlyLive(
    opts: { limit?: number; maxPages?: number } = {},
  ): Promise<Map<string, LiveStream> | null> {
    const { limit = 50, maxPages = 4 } = opts;
    const live = new Map<string, LiveStream>();
    for (let page = 0; page < maxPages; page++) {
      const query = new URLSearchParams({
        offset: String(page * limit),
        limit: String(limit),
        // NSFW coins too: this only sets a model input, nothing is shown, and the watchlist holds
        // coins the PumpPortal stream and DexScreener feeds added with no NSFW filter. Left out,
        // a streaming NSFW coin read as a known "not live".
        includeNsfw: "true",
      });
      let coins: PumpFunCoin[];
      try {
        coins = await fetchJson<PumpFunCoin[]>(`${this.baseUrl}/coins/currently-live?${query.toString()}`, {
          gate: this.frontendGate,
          timeoutMs: 8000,
          retries: 1,
        });
      } catch (err) {
        logger.warn("currently-live failed", { page, error: String(err) });
        // A later page failing still leaves the first page's coins known live; the rest of the
        // set is unknown, so the answer as a whole is.
        return null;
      }
      if (!Array.isArray(coins)) return page === 0 ? null : live;
      for (const coin of coins) {
        // The feed lists coins whose stream just ended for a moment; only a coin it says is live
        // counts.
        if (!coin.mint || coin.is_currently_live === false) continue;
        const viewers = coin.num_participants;
        live.set(coin.mint, {
          viewers: typeof viewers === "number" && Number.isFinite(viewers) && viewers >= 0 ? viewers : null,
          coin: toDiscoveredCoin(coin),
        });
      }
      if (coins.length < limit) return live;
    }
    // The last page allowed came back full: more coins may be live past it, and reading the
    // missing ones as "not live" is worse than not knowing.
    logger.warn("currently-live hit the page cap", { maxPages, limit });
    return null;
  }

  private async listCoins(params: {
    offset: number;
    limit: number;
    sort: SortField;
    order: SortOrder;
  }): Promise<PumpFunCoin[]> {
    const query = new URLSearchParams({
      offset: String(params.offset),
      limit: String(params.limit),
      sort: params.sort,
      order: params.order,
      includeNsfw: "false",
    });
    if (Date.now() < this.listBlockedUntil || this.listProbing) {
      this.listStats.skipped += 1;
      return [];
    }
    // Past a block, one page asks first (LIST_BLOCK_BACKOFF_MS): all nine at once was nine 403s.
    const probing = this.listBlockedUntil > 0;
    if (probing) this.listProbing = true;
    this.listStats.pages += 1;
    try {
      const coins = await fetchJson<PumpFunCoin[]>(`${this.baseUrl}/coins?${query.toString()}`, {
        gate: this.frontendGate,
        timeoutMs: 8000,
        retries: 1,
      });
      if (Array.isArray(coins)) {
        this.listBlockedUntil = 0;
        return coins;
      }
      throw new Error("coin list answered with something other than a list");
    } catch (err) {
      this.listStats.failed += 1;
      this.listStats.lastError = listErrorText(err);
      if (err instanceof HttpError && err.status === 403)
        this.listBlockedUntil = Date.now() + LIST_BLOCK_BACKOFF_MS;
      logger.warn("listCoins failed", { params, error: this.listStats.lastError });
      return [];
    } finally {
      if (probing) this.listProbing = false;
    }
  }
}

/** A failed list page, named so a Cloudflare block reads as one on the heartbeat. */
function listErrorText(err: unknown): string {
  if (err instanceof HttpError && err.status === 403)
    return `${err.message} (blocked - likely a Cloudflare challenge)`;
  return String(err instanceof Error ? err.message : err).slice(0, 200);
}

/**
 * The launch's metadata JSON (the token's on-chain URI, which the PumpPortal stream carries as
 * `uri`): name, symbol, description, image and the launcher's socials, written once at launch.
 * The fallback when Pump.fun's own endpoints don't answer. Only IPFS-hosted metadata is read, by
 * its CID through fixed gateways (LAUNCH_METADATA_GATEWAYS): the URI is whatever the launcher
 * wrote, and the worker fetches nothing else a stranger names. Pump.fun's own Pinata gateway comes
 * first, but it serves only what Pump.fun pinned (other launchers' CIDs answer 403), and on
 * 2026-10-23, with the rest of Pump.fun refusing this service, it answered none of the worker's
 * reads: launches reached the models with no description or socials; the public gateways after it are slower or rate limited
 * (ipfs.io answers 429 to repeated reads; gateway.pinata.cloud took about 4 s a read on
 * 2026-10-23, so each gets 8 s) but answer for any CID. Null when the URI isn't an IPFS
 * one or the JSON has nothing usable; throws the last gateway's failure when none answered.
 */
export async function fetchLaunchMetadata(
  mintAddress: string,
  uri: string,
  timeoutMs = 8_000,
): Promise<DiscoveredCoin | null> {
  const cid = ipfsMetadataCid(uri);
  if (!cid) return null;
  let lastError: unknown;
  for (const gateway of LAUNCH_METADATA_GATEWAYS) {
    try {
      const body = await fetchJson<unknown>(`${gateway}/ipfs/${cid}`, { timeoutMs, retries: 0 });
      return parseLaunchMetadata(mintAddress, body);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** The IPFS gateways fetchLaunchMetadata tries, in order - see its note. Exported for tests. */
export const LAUNCH_METADATA_GATEWAYS = [
  "https://pump.mypinata.cloud",
  "https://gateway.pinata.cloud",
  "https://ipfs.io",
  "https://dweb.link",
] as const;

/** The IPFS CID an https metadata URI points at, or undefined for any other URI. Exported for tests. */
export function ipfsMetadataCid(uri: string): string | undefined {
  return (
    /^https:\/\/[^/]+\/ipfs\/([A-Za-z0-9]{46,})\/?$/.exec(uri)?.[1] ??
    /^https:\/\/([A-Za-z0-9]{46,})\.ipfs\.[^/]+\/?$/.exec(uri)?.[1]
  );
}

/** A launch's metadata JSON as a discovered coin; null when it isn't an object. Exported for tests. */
export function parseLaunchMetadata(mintAddress: string, body: unknown): DiscoveredCoin | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const m = body as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return toDiscoveredCoin({
    mint: mintAddress,
    name: str(m.name),
    symbol: str(m.symbol),
    // A Pump.fun launch writes the key even when empty; a missing one is the same known "none".
    description: str(m.description) ?? "",
    image_uri: str(m.image),
    twitter: str(m.twitter),
    telegram: str(m.telegram),
    website: str(m.website),
  });
}

/** Same caps as the PumpPortal stream applies (discovery/pumpPortalStream.ts). */
const MAX_SYMBOL_CHARS = 40;
const MAX_NAME_CHARS = 120;
const MAX_IMAGE_URL_CHARS = 500;
const clip = (v: string | undefined, max: number): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;

/**
 * The coin's creation time, or undefined unless it is a real date no later than now (a minute of
 * clock skew allowed). One Invalid Date reached the watchlist's createMany and failed the whole
 * scan cycle, every cycle the coin stayed on a discovery page.
 */
/** How long a charity name shown on a card may be. Longer ones are cut, not rejected. */
const MAX_CHARITY_NAME_CHARS = 80;

/**
 * Strings on a charity object that can be the organization's name, including one nested
 * charity object. The coin's own name is not one of them.
 */
function charityNameCandidates(value: unknown, depth = 0): unknown[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return [];
  const obj = value as Record<string, unknown>;
  return [obj.charity_name, obj.charityName, obj.name, ...charityNameCandidates(obj.charity, depth + 1)];
}

/**
 * The charity a Pump.fun charity coin names (user ask 2026-10-21: the heart's tooltip, and a
 * line in the token details).
 *
 * frontend-api-v3 was blocked from this environment (2026-10-22), so this was not checked
 * against a live response that day. The coins-v2 capture of 2026-06-17 names `is_charity` and
 * no display name. Payloads since then have carried the organization as `charity_name`,
 * `charityName`, `charity.name`, or those same keys on a nested `charity` object. A present
 * name is enough: the live coin can omit `is_charity`. An explicit false still means this is
 * not a charity coin. The coin's own name is not used. A missing or unusable name stays blank
 * rather than a guessed organization.
 */
export function charityNameFromPumpCoin(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const coin = body as Record<string, unknown>;
  if (coin.is_charity === false || coin.isCharity === false) return null;
  const candidates = [coin.charity_name, coin.charityName, ...charityNameCandidates(coin.charity)];
  for (const value of candidates) {
    const name = clipCharityName(value);
    if (name) return name;
  }
  return null;
}

function clipCharityName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim();
  // A pubkey is the donate.gg config id, not the organization's name. A name needs a letter.
  if (!name || !/\p{L}/u.test(name) || looksLikeSolanaAddress(name)) return null;
  return name.length > MAX_CHARITY_NAME_CHARS ? name.slice(0, MAX_CHARITY_NAME_CHARS).trimEnd() : name;
}

/** One organization receiving a share of a charity coin's creator fee. */
export interface PumpCharityShare {
  name: string;
  /** Basis points of the creator fee, when the payload gave a share. Null when it didn't. */
  bps: number | null;
  /** Wallet the share pays, when the payload gave one. Used to match a chain recipient. */
  address: string | null;
}

function shortFeeAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function wholeBps(value: unknown): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(n) || n <= 0 || n > 10_000) return null;
  return n;
}

/** A share field as basis points. `share` of 0.99 is 99%. `percent` of 60 is 60%. */
function readShareBps(row: Record<string, unknown>, keys?: readonly string[]): number | null {
  const bpsKeys = keys ?? ["share_bps", "shareBps", "bps", "fee_bps", "feeBps"];
  for (const key of bpsKeys) {
    if (!(key in row)) continue;
    const n = wholeBps(row[key]);
    if (n != null) return n;
  }
  if (keys) return null;
  for (const key of ["percent", "percentage", "pct"] as const) {
    const n = row[key];
    if (typeof n === "number" && n > 0 && n <= 100) return Math.round(n * 100);
  }
  const share = row.share;
  if (typeof share !== "number" || !(share > 0)) return null;
  if (share <= 1) return Math.round(share * 10_000);
  if (share <= 100) return Math.round(share * 100);
  return wholeBps(share);
}

function feeAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  return looksLikeSolanaAddress(address) ? address : null;
}

/** One list entry: a name, or the address shortened when the payload named no organization. */
function oneCharityShare(item: unknown): PumpCharityShare | null {
  if (typeof item === "string") {
    const name = clipCharityName(item);
    if (name) return { name, bps: null, address: null };
    const address = feeAddress(item);
    return address ? { name: shortFeeAddress(address), bps: null, address } : null;
  }
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const row = item as Record<string, unknown>;
  const address = feeAddress(row.address) ?? feeAddress(row.wallet);
  const name =
    clipCharityName(row.charity_name) ??
    clipCharityName(row.charityName) ??
    clipCharityName(row.organization) ??
    clipCharityName(row.name);
  const label = name ?? (address ? shortFeeAddress(address) : null);
  if (!label) return null;
  return { name: label, bps: readShareBps(row), address };
}

function charityLists(coin: Record<string, unknown>): unknown[][] {
  const lists: unknown[][] = [];
  if (Array.isArray(coin.charity)) lists.push(coin.charity);
  for (const key of ["charities", "charity_recipients", "charityRecipients"] as const) {
    if (Array.isArray(coin[key])) lists.push(coin[key] as unknown[]);
  }
  // A fee-split list is only the charities when the coin is marked a charity coin.
  // Otherwise it is some other split, and TokenSage's recipients are the source.
  if (coin.is_charity === true || coin.isCharity === true) {
    for (const key of ["shareholders", "fee_recipients", "feeRecipients"] as const) {
      if (Array.isArray(coin[key])) lists.push(coin[key] as unknown[]);
    }
  }
  return lists;
}

function sharesFromList(list: readonly unknown[]): PumpCharityShare[] {
  const out: PumpCharityShare[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const share = oneCharityShare(item);
    if (!share) continue;
    const key = `${share.address ?? ""}:${share.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(share);
    if (out.length >= 10) break;
  }
  return out;
}

function bpsOnSingleCharity(coin: Record<string, unknown>): number | null {
  const direct = readShareBps(coin, ["charity_bps", "charityBps", "charity_share_bps", "charityShareBps"]);
  if (direct != null) return direct;
  if (coin.charity && typeof coin.charity === "object" && !Array.isArray(coin.charity)) {
    return readShareBps(coin.charity as Record<string, unknown>);
  }
  return null;
}

/**
 * Each charity a Pump.fun coin names, and the percent of the fee when the payload gave one.
 * A list (`charities`, or `charity` as an array) is each entry. One name stays one entry.
 * An address with no organization is shortened. Nothing is invented when the payload is silent.
 */
export function charitySharesFromPumpCoin(body: unknown): PumpCharityShare[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const coin = body as Record<string, unknown>;
  if (coin.is_charity === false || coin.isCharity === false) return [];
  let fromLists: PumpCharityShare[] = [];
  for (const list of charityLists(coin)) {
    const parsed = sharesFromList(list);
    if (parsed.length) {
      fromLists = parsed;
      break;
    }
  }
  if (fromLists.length > 1) return fromLists;
  const single = charityNameFromPumpCoin(body);
  if (single && fromLists.length === 1) {
    return [
      { name: single, bps: fromLists[0]!.bps ?? bpsOnSingleCharity(coin), address: fromLists[0]!.address },
    ];
  }
  if (fromLists.length === 1) return fromLists;
  if (!single) return [];
  return [{ name: single, bps: bpsOnSingleCharity(coin), address: null }];
}

function launchDate(ms: unknown, now = Date.now()): Date | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0 || ms > now + 60_000) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toDiscoveredCoin(coin: PumpFunCoin): DiscoveredCoin {
  const imageUrl = clip(coin.image_uri, MAX_IMAGE_URL_CHARS);
  return {
    mintAddress: coin.mint,
    symbol: clip(coin.symbol, MAX_SYMBOL_CHARS),
    name: clip(coin.name, MAX_NAME_CHARS),
    // Only an https image is ever rendered (the dashboard refuses anything else), so nothing else
    // is stored.
    imageUrl: imageUrl?.startsWith("https://") ? imageUrl : undefined,
    description: coin.description,
    createdAt: launchDate(coin.created_timestamp),
    graduated: coin.complete ?? false,
    marketCapUsd: coin.usd_market_cap ?? coin.market_cap_usd,
    hasTwitter: Boolean(coin.twitter),
    hasTelegram: Boolean(coin.telegram),
    hasWebsite: Boolean(coin.website),
    twitterUrl: normalizeSocialUrl(coin.twitter, "twitter") ?? undefined,
    websiteUrl: normalizeSocialUrl(coin.website, "website") ?? undefined,
    ...(typeof coin.mayhem_state === "string" && coin.mayhem_state !== ""
      ? { mayhemMode: true as const }
      : {}),
    ...(typeof coin.creator === "string" && looksLikeSolanaAddress(coin.creator)
      ? { creator: coin.creator }
      : {}),
  };
}
