import { fetchJson, HttpError } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { normalizeSocialUrl } from "./tokensage.js";
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
  hasTwitter: boolean;
  hasTelegram: boolean;
  hasWebsite: boolean;
  /** The launcher's X link and website, https only (normalizeSocialUrl). */
  twitterUrl?: string;
  websiteUrl?: string;
  /** Launched in Mayhem Mode, per Pump.fun's own flag; undefined when the coin carries none. */
  mayhemMode?: true;
  /** The launchpad, normalized (launchpads.ts); undefined means Pump.fun's own lists. */
  launchpad?: string;
}

export interface PumpFunClientOptions {
  baseUrl?: string;
  /** Pump.fun's trade API (the chart's candles). */
  swapBaseUrl?: string;
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

  constructor(options: PumpFunClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://frontend-api-v3.pump.fun";
    this.swapBaseUrl = options.swapBaseUrl ?? "https://swap-api.pump.fun";
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
        { timeoutMs, retries: 0 },
      );
      return coin?.mint === mintAddress ? toDiscoveredCoin(coin) : null;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
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
        { timeoutMs: 8000, retries: 1 },
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
        { timeoutMs: 5000, retries: 0 },
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
   * behind (2026-10-12). Null when Pump.fun has no such coin or no usable figure; throws on a
   * transport failure.
   */
  async liveMarketCap(mintAddress: string, timeoutMs = 2_000): Promise<number | null> {
    try {
      const coin = await fetchJson<PumpFunCoin | null>(
        `${this.baseUrl}/coins-v2/${encodeURIComponent(mintAddress)}`,
        { timeoutMs, retries: 0 },
      );
      const mcap = coin?.usd_market_cap ?? coin?.market_cap_usd;
      return typeof mcap === "number" && Number.isFinite(mcap) && mcap > 0 ? mcap : null;
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
        { timeoutMs, retries: 0 },
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
        { timeoutMs: 5000, retries: 0 },
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
    try {
      const body = await fetchJson<unknown>(
        `${this.swapBaseUrl}/v1/coins/${encodeURIComponent(mintAddress)}/candles?interval=1m&limit=${MINUTE_CANDLE_PAGE}&currency=USD`,
        { timeoutMs, retries: 0 },
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
    if (Date.now() < this.listBlockedUntil) {
      this.listStats.skipped += 1;
      return [];
    }
    this.listStats.pages += 1;
    try {
      const coins = await fetchJson<PumpFunCoin[]>(`${this.baseUrl}/coins?${query.toString()}`, {
        timeoutMs: 8000,
        retries: 1,
      });
      if (Array.isArray(coins)) return coins;
      throw new Error("coin list answered with something other than a list");
    } catch (err) {
      this.listStats.failed += 1;
      this.listStats.lastError = listErrorText(err);
      if (err instanceof HttpError && err.status === 403)
        this.listBlockedUntil = Date.now() + LIST_BLOCK_BACKOFF_MS;
      logger.warn("listCoins failed", { params, error: this.listStats.lastError });
      return [];
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
 * The fallback when Pump.fun's own endpoints don't answer. Only IPFS-hosted metadata is read,
 * through Pump.fun's own Pinata gateway (ipfs.io answers 429 to repeated reads): the URI is
 * whatever the launcher wrote, and the worker fetches nothing else a stranger names. Null when the
 * URI isn't an IPFS one or the JSON has nothing usable; throws on a transport failure.
 */
export async function fetchLaunchMetadata(
  mintAddress: string,
  uri: string,
  timeoutMs = 4_000,
): Promise<DiscoveredCoin | null> {
  const cid = ipfsMetadataCid(uri);
  if (!cid) return null;
  const body = await fetchJson<unknown>(`https://pump.mypinata.cloud/ipfs/${cid}`, { timeoutMs, retries: 0 });
  return parseLaunchMetadata(mintAddress, body);
}

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
  };
}
