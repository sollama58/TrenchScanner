import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { normalizeSocialUrl } from "./tokensage.js";

const logger = createLogger("pumpfun");

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
}

/** One coin's Pump.fun livestream as the currently-live feed reports it. */
export interface LiveStream {
  /** People watching right now; null when the feed didn't say. */
  viewers: number | null;
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
}

export interface PumpFunClientOptions {
  baseUrl?: string;
}

/**
 * Coins asked for per page. Pump.fun's /coins sends at most 70 a page whatever `limit` asks
 * (checked 2026-10-08), and the pages here are fetched at once at offsets of page * limit - so a
 * limit above that cap skipped coins 70-99 of every page. Kept under the cap with room to spare.
 */
const PAGE_SIZE = 50;

type SortField = "market_cap" | "created_timestamp" | "last_trade_timestamp";
type SortOrder = "ASC" | "DESC";

export class PumpFunClient {
  private readonly baseUrl: string;

  constructor(options: PumpFunClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://frontend-api-v3.pump.fun";
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
    try {
      return await fetchJson<PumpFunCoin[]>(`${this.baseUrl}/coins?${query.toString()}`, {
        timeoutMs: 8000,
        retries: 1,
      });
    } catch (err) {
      logger.warn("listCoins failed", { params, error: String(err) });
      return [];
    }
  }
}

/** Same caps as the PumpPortal stream applies (discovery/pumpPortalStream.ts). */
const MAX_SYMBOL_CHARS = 40;
const MAX_NAME_CHARS = 120;
const MAX_IMAGE_URL_CHARS = 500;
const clip = (v: string | undefined, max: number): string | undefined =>
  typeof v === "string" ? v.slice(0, max) : undefined;

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
    createdAt: coin.created_timestamp ? new Date(coin.created_timestamp) : undefined,
    graduated: coin.complete ?? false,
    marketCapUsd: coin.usd_market_cap ?? coin.market_cap_usd,
    hasTwitter: Boolean(coin.twitter),
    hasTelegram: Boolean(coin.telegram),
    hasWebsite: Boolean(coin.website),
    twitterUrl: normalizeSocialUrl(coin.twitter, "twitter") ?? undefined,
    websiteUrl: normalizeSocialUrl(coin.website, "website") ?? undefined,
  };
}
