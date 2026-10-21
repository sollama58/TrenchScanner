import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import { RateGate, RateGateDeadlineError } from "./rateGate.js";
import { isCurveVenue } from "../launchpads.js";
import { canonicalPairCreatedAt, pickCanonicalPair } from "./dexscreener.js";
import { MARKET_SOURCE } from "../marketSource.js";
import { onCurrentSupplies } from "../mintSupply.js";
import type { CandidateToken } from "../types.js";

const logger = createLogger("geckoterminal");

/** Subset of a GeckoTerminal token resource (GET /networks/solana/tokens/multi/...). */
interface GeckoToken {
  attributes?: {
    address?: string;
    name?: string;
    symbol?: string;
    price_usd?: string | null;
    market_cap_usd?: string | null;
    fdv_usd?: string | null;
  };
  relationships?: { top_pools?: { data?: { id: string }[] } };
}

type Windowed<T> = { m5?: T; h1?: T; h6?: T; h24?: T };

/** Subset of a GeckoTerminal pool resource, as `include=top_pools` returns it. */
interface GeckoPool {
  id: string;
  attributes?: {
    address?: string;
    base_token_price_usd?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string | null;
    pool_created_at?: string | null;
    price_change_percentage?: Windowed<string | null>;
    transactions?: Windowed<{ buys?: number; sells?: number }>;
    volume_usd?: Windowed<string | null>;
  };
  relationships?: {
    base_token?: { data?: { id: string } };
    quote_token?: { data?: { id: string } };
    dex?: { data?: { id: string } };
  };
}

interface GeckoMultiResponse {
  data?: GeckoToken[];
  included?: GeckoPool[];
}

const SOLANA = "solana";
/** GeckoTerminal's multi-token lookup takes up to 30 addresses per call. */
const BATCH_SIZE = 30;
/**
 * GeckoTerminal's free API allows 30 calls a minute per IP. The worker's default split: most for
 * the scan's own refresh, which is what puts a coin in front of the safety screen, and the rest
 * for every other lookup - which would otherwise queue up ahead of it (the outcome watcher alone
 * asks for hundreds of mints a minute). The API process takes its own few.
 */
export const DEFAULT_GECKOTERMINAL_PRIORITY_PER_MINUTE = 16;
export const DEFAULT_GECKOTERMINAL_BACKGROUND_PER_MINUTE = 6;
/** A background lookup is cut to its first this many mints; its budget can't carry more. */
const BACKGROUND_MAX_MINTS = 90;
const GATE_BURST = 4;

export interface GeckoTerminalClientOptions {
  baseUrl?: string;
  /**
   * A CoinGecko paid-plan key (COINGECKO_API_KEY). With one, lookups go to CoinGecko's on-chain
   * API - GeckoTerminal's data and response shape, on the plan's rate limit rather than the free
   * 30 a minute - and background lookups are no longer cut short.
   */
  apiKey?: string;
  /** Calls a minute for lookups marked `priority` (the scan's watchlist refresh). */
  priorityPerMinute?: number;
  /** Calls a minute for every other lookup. */
  backgroundPerMinute?: number;
  /**
   * Keep a Meteora DBC or Raydium LaunchLab curve's age. Off, those ids stay as GeckoTerminal
   * spelled them and a LaunchLab curve is folded into "raydium", which is what shipped.
   */
  launchHomeClock?: boolean;
}

/**
 * Market data from GeckoTerminal, in DexScreener's CandidateToken shape. Only ever a fallback for
 * DexScreenerClient.getTokensByAddresses: on 2026-10-07 DexScreener began answering every token
 * lookup with an empty list (BONK included) while GeckoTerminal still priced the same mints, and
 * with no market cap nothing reached the band, the safety screen or an alert.
 *
 * Its free tier is a tenth of DexScreener's budget, so a lookup gets through only what its
 * deadline and budget allow - callers already put the mints that matter most first.
 */
export class GeckoTerminalClient {
  private readonly baseUrl: string;
  private readonly priorityGate: RateGate;
  private readonly backgroundGate: RateGate;
  private readonly headers: Record<string, string>;
  private readonly backgroundMaxMints: number;
  private readonly launchHomeClock: boolean;

  constructor(options: GeckoTerminalClientOptions = {}) {
    const keyed = Boolean(options.apiKey);
    this.baseUrl =
      options.baseUrl ??
      (keyed ? "https://pro-api.coingecko.com/api/v3/onchain" : "https://api.geckoterminal.com/api/v2");
    this.headers = keyed
      ? { accept: "application/json", "x-cg-pro-api-key": options.apiKey! }
      : { accept: "application/json" };
    this.backgroundMaxMints = keyed ? Infinity : BACKGROUND_MAX_MINTS;
    this.launchHomeClock = options.launchHomeClock === true;
    this.priorityGate = new RateGate({
      name: "geckoterminal",
      perMinute: options.priorityPerMinute ?? DEFAULT_GECKOTERMINAL_PRIORITY_PER_MINUTE,
      burst: GATE_BURST,
    });
    this.backgroundGate = new RateGate({
      name: "geckoterminal-background",
      perMinute: options.backgroundPerMinute ?? DEFAULT_GECKOTERMINAL_BACKGROUND_PER_MINUTE,
      burst: GATE_BURST,
    });
  }

  /**
   * Same contract as DexScreenerClient.getTokensByAddresses (deadline, seenAt, failed). A lookup
   * not marked `priority` is cut to its first BACKGROUND_MAX_MINTS without a key; the rest count
   * as failed.
   */
  async getTokensByAddresses(
    mintAddresses: string[],
    options: {
      timeoutMs?: number;
      retries?: number;
      deadlineMs?: number;
      seenAt?: Map<string, Date>;
      failed?: Set<string>;
      priority?: boolean;
    } = {},
  ): Promise<CandidateToken[]> {
    const { deadlineMs, seenAt, failed, priority, ...fetchOptions } = options;
    const all = [...new Set(mintAddresses)];
    const unique = priority ? all : all.slice(0, this.backgroundMaxMints);
    if (failed) for (const mint of all.slice(unique.length)) failed.add(mint);
    if (unique.length === 0) return [];
    const budget = priority ? this.priorityGate : this.backgroundGate;
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) chunks.push(unique.slice(i, i + BATCH_SIZE));

    const deadline = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
    const gate = {
      acquire: () => budget.acquire(deadline),
      // A 429 is the provider's limit on both budgets.
      throttled: (delayMs: number) => {
        this.priorityGate.throttled(delayMs);
        this.backgroundGate.throttled(delayMs);
      },
    };
    const results: CandidateToken[] = [];
    const settled = new Set<string>();
    const work = forEachWithConcurrency(chunks, 3, async (chunk) => {
      if (Date.now() >= deadline) return;
      try {
        const body = await fetchJson<GeckoMultiResponse>(
          `${this.baseUrl}/networks/${SOLANA}/tokens/multi/${chunk.join(",")}?include=top_pools`,
          { ...fetchOptions, gate, headers: this.headers },
        );
        const answered = new Date();
        for (const mint of chunk) settled.add(mint);
        const tokens = parseGeckoTokens(body, new Set(chunk), this.launchHomeClock);
        if (seenAt) for (const t of tokens) seenAt.set(t.mintAddress, answered);
        results.push(...tokens);
      } catch (err) {
        if (err instanceof RateGateDeadlineError) return;
        logger.warn("failed to fetch token batch", { chunkSize: chunk.length, error: String(err) });
      }
    });
    if (deadline !== Infinity) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
    } else {
      await work;
    }
    if (failed) for (const mint of unique) if (!settled.has(mint)) failed.add(mint);
    // GeckoTerminal's fdv counts a Pump.fun coin's launch billion, burns and all (0.9999B on a coin
    // with 0.95B left on 2026-10-19): each cap is re-made on the supply now (mintSupply.ts).
    return onCurrentSupplies(results, {
      waitMs: deadline === Infinity ? undefined : Math.max(0, deadline - Date.now()),
    });
  }
}

const num = (v: string | number | null | undefined): number | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * GeckoTerminal's dex ids in DexScreener's spelling where the scan reads them: "pumpfun" is a
 * pre-bond curve (deriveGraduated), "pumpswap" is the same on both.
 */
function toDexId(id: string | undefined, launchHomeClock: boolean): string | undefined {
  if (id === undefined) return undefined;
  if (id === "pump-fun") return "pumpfun";
  // Launch homes stay their own venues when the owner turns the clock on. Folding
  // raydium-launchlab into "raydium" let a deeper side pool become the pair, and meteora-dbc
  // is not the "meteora" AMM the clock refuses. DexScreener spells these meteoradbc and launchlab.
  if (launchHomeClock && id === "raydium-launchlab") return "launchlab";
  if (launchHomeClock && id === "meteora-dbc") return "meteoradbc";
  // GeckoTerminal names each Raydium program ("raydium-clmm", "raydium-cpmm"); DexScreener calls
  // them all "raydium", which is where a Stonks coin graduates.
  if (id.startsWith("raydium")) return "raydium";
  return id;
}

/** Exported for tests. Only the requested mints, priced off a top pool they are the base of. */
export function parseGeckoTokens(
  body: GeckoMultiResponse,
  requested: Set<string>,
  launchHomeClock = false,
): CandidateToken[] {
  const pools = new Map((body.included ?? []).map((p) => [p.id, p]));
  const out: CandidateToken[] = [];
  for (const token of body.data ?? []) {
    const a = token.attributes;
    const mint = a?.address;
    if (!a || !mint || !requested.has(mint)) continue;
    // A pool where the mint is the quote token carries the other token's price. Among the pools
    // it is the base of, the same pair the scan prices on DexScreener (pickCanonicalPair): a
    // deeper Meteora pool listed first must not become the pair or its clock.
    const basePools = (token.relationships?.top_pools?.data ?? [])
      .map((ref) => pools.get(ref.id))
      .filter((p): p is GeckoPool => p?.relationships?.base_token?.data?.id === `${SOLANA}_${mint}`);
    const selectable = basePools.map((pool) => {
      const quote = pool.relationships?.quote_token?.data?.id?.replace(`${SOLANA}_`, "");
      return {
        pool,
        dexId: toDexId(pool.relationships?.dex?.data?.id, launchHomeClock) ?? "",
        liquidity: { usd: num(pool.attributes?.reserve_in_usd) },
        volume: { h1: num(pool.attributes?.volume_usd?.h1) },
        txns: { h1: pool.attributes?.transactions?.h1 },
        ...(quote ? { quoteToken: { address: quote } } : {}),
      };
    });
    const pool = selectable.length > 0 ? pickCanonicalPair(selectable, launchHomeClock).pool : undefined;
    const p = pool?.attributes;
    const marketCapUsd =
      num(a.market_cap_usd) ?? num(a.fdv_usd) ?? num(p?.market_cap_usd) ?? num(p?.fdv_usd) ?? 0;
    const priceUsd = num(p?.base_token_price_usd) ?? num(a.price_usd) ?? 0;
    if (marketCapUsd <= 0 && priceUsd <= 0) continue;
    const dexId = toDexId(pool?.relationships?.dex?.data?.id, launchHomeClock);
    const createdAt = p?.pool_created_at ? new Date(p.pool_created_at) : undefined;
    out.push({
      mintAddress: mint,
      symbol: a.symbol,
      name: a.name,
      pairAddress: p?.address,
      priceUsd,
      marketCapUsd,
      // DexScreener reports no liquidity for a pre-bond curve (Pump.fun's or Stonks'); GeckoTerminal reports the curve's
      // reserves. Kept the same as DexScreener so the scan reads a curve the same either way.
      liquidityUsd: isCurveVenue(dexId) ? undefined : num(p?.reserve_in_usd),
      volume24hUsd: num(p?.volume_usd?.h24),
      buys24h: p?.transactions?.h24?.buys,
      sells24h: p?.transactions?.h24?.sells,
      priceChange5mPct: num(p?.price_change_percentage?.m5),
      priceChange1hPct: num(p?.price_change_percentage?.h1),
      priceChange6hPct: num(p?.price_change_percentage?.h6),
      priceChange24hPct: num(p?.price_change_percentage?.h24),
      volume5mUsd: num(p?.volume_usd?.m5),
      volume1hUsd: num(p?.volume_usd?.h1),
      buys5m: p?.transactions?.m5?.buys,
      sells5m: p?.transactions?.m5?.sells,
      buys1h: p?.transactions?.h1?.buys,
      sells1h: p?.transactions?.h1?.sells,
      // Same rule as DexScreener: a Meteora (or other non-canonical) pool does not supply the clock.
      pairCreatedAt: canonicalPairCreatedAt(
        dexId,
        createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : undefined,
        launchHomeClock,
      ),
      dexId,
      // "solana_<mint>"; the symbol isn't in the response, so the cards name it from the mint.
      quoteMint: pool?.relationships?.quote_token?.data?.id.replace(`${SOLANA}_`, "") || undefined,
      marketSource: MARKET_SOURCE.gecko,
    });
  }
  return out;
}
