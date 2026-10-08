import { fetchJson } from "./httpClient.js";
import { createLogger } from "../logger.js";
import { forEachWithConcurrency } from "../concurrency.js";
import { RateGate, RateGateDeadlineError, type RateGateStats } from "./rateGate.js";
import type { DexScreenerClient, TokenLookupOptions } from "./dexscreener.js";
import type { CandidateToken } from "../types.js";

const logger = createLogger("jupiter");

/** Subset of a Jupiter Tokens API v2 MintInformation (GET /tokens/v2/search). */
interface JupiterStats {
  priceChange?: number | null;
  buyVolume?: number | null;
  sellVolume?: number | null;
  numBuys?: number | null;
  numSells?: number | null;
}

interface JupiterToken {
  id?: string;
  name?: string;
  symbol?: string;
  usdPrice?: number | null;
  mcap?: number | null;
  fdv?: number | null;
  liquidity?: number | null;
  stats24h?: JupiterStats | null;
}

/** The search endpoint takes up to 100 comma-separated mints a call. */
const BATCH_SIZE = 100;
/** The free plan allows 60 calls a minute per account; this leaves a little room. */
export const DEFAULT_JUPITER_REQUESTS_PER_MINUTE = 50;
const GATE_BURST = 5;

export interface JupiterClientOptions {
  apiKey: string;
  baseUrl?: string;
  requestsPerMinute?: number;
}

/**
 * Prices from Jupiter's Tokens API, in DexScreener's CandidateToken shape - only the fields the
 * price-only callers read (price, market cap, liquidity, 24h volume and counts).
 *
 * It exists to take load off DexScreener's per-IP budget (2026-10-08: the scan's refresh spent
 * 6.5-10 s of every cycle queued behind the other jobs, and half the cycles ended at it with
 * nothing in band). Jupiter answers 100 mints a call against DexScreener's 30, on a per-account
 * limit rather than a per-IP one that other Render tenants share.
 */
export class JupiterClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly gate: RateGate;

  constructor(options: JupiterClientOptions) {
    this.baseUrl = options.baseUrl ?? "https://api.jup.ag";
    this.headers = { accept: "application/json", "x-api-key": options.apiKey };
    this.gate = new RateGate({
      name: "jupiter",
      perMinute: options.requestsPerMinute ?? DEFAULT_JUPITER_REQUESTS_PER_MINUTE,
      burst: GATE_BURST,
    });
  }

  /** Calls sent, 429 pauses and time spent queued since the last call, then reset. */
  takeCallStats(): RateGateStats {
    return this.gate.takeStats();
  }

  /** Same contract as DexScreenerClient.getTokensByAddresses (deadline, seenAt, failed). */
  async getTokensByAddresses(
    mintAddresses: string[],
    concurrency = 2,
    options: TokenLookupOptions = {},
  ): Promise<CandidateToken[]> {
    const {
      deadlineMs,
      seenAt,
      failed,
      priority: _priority,
      mayBeUnindexed: _unindexed,
      ...fetchOptions
    } = options;
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) chunks.push(unique.slice(i, i + BATCH_SIZE));

    const deadline = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
    const gate = {
      acquire: () => this.gate.acquire(deadline),
      throttled: (delayMs: number) => this.gate.throttled(delayMs),
    };
    const results: CandidateToken[] = [];
    const settled = new Set<string>();
    const work = forEachWithConcurrency(chunks, concurrency, async (chunk) => {
      if (Date.now() >= deadline) return;
      try {
        const body = await fetchJson<JupiterToken[]>(
          `${this.baseUrl}/tokens/v2/search?query=${chunk.join(",")}`,
          { ...fetchOptions, gate, headers: this.headers },
        );
        const answered = new Date();
        for (const mint of chunk) settled.add(mint);
        const tokens = parseJupiterTokens(body, new Set(chunk));
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
    return [...results];
  }
}

const finite = (v: number | null | undefined): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Exported for tests. Only the requested mints, each once. */
export function parseJupiterTokens(body: unknown, requested: Set<string>): CandidateToken[] {
  if (!Array.isArray(body)) return [];
  const out = new Map<string, CandidateToken>();
  for (const t of body as JupiterToken[]) {
    if (!t || typeof t.id !== "string" || !requested.has(t.id) || out.has(t.id)) continue;
    const stats = t.stats24h ?? undefined;
    const buyVolume = finite(stats?.buyVolume);
    const sellVolume = finite(stats?.sellVolume);
    out.set(t.id, {
      mintAddress: t.id,
      symbol: t.symbol,
      name: t.name,
      // No price reads as 0, the same "no price" DexScreener's parser gives a pair without one.
      priceUsd: finite(t.usdPrice) ?? 0,
      marketCapUsd: finite(t.mcap) ?? finite(t.fdv) ?? 0,
      // Jupiter's liquidity reads about half of DexScreener's for the same pools (2026-10-08: 0.47
      // to 0.50 of it on four pumpswap pools), one side of the pool where DexScreener counts both.
      // Doubled, so the empty-wallet check's cap (half the liquidity) means what it always has.
      liquidityUsd: finite(t.liquidity) === undefined ? undefined : finite(t.liquidity)! * 2,
      volume24hUsd:
        buyVolume === undefined && sellVolume === undefined
          ? undefined
          : (buyVolume ?? 0) + (sellVolume ?? 0),
      buys24h: finite(stats?.numBuys),
      sells24h: finite(stats?.numSells),
      priceChange24hPct: finite(stats?.priceChange),
    });
  }
  return [...out.values()];
}

/**
 * Price lookups for the jobs that only need a price (the outcome watcher, the empty-wallet
 * valuation): Jupiter first, DexScreener for what it didn't answer, so DexScreener's per-IP budget
 * is left to the scan and fast-match, whose model inputs are DexScreener's numbers.
 *
 * DexScreener is asked again for every mint Jupiter's batch never answered, and - unless the
 * lookup says its mints may be unindexed (a holder's airdrops and dead coins, which DexScreener
 * won't know either) - for every mint Jupiter answered without a token.
 */
export class JupiterFirstLookup {
  constructor(
    private readonly jupiter: Pick<JupiterClient, "getTokensByAddresses">,
    private readonly dexScreener: Pick<DexScreenerClient, "getTokensByAddresses">,
  ) {}

  async getTokensByAddresses(
    mintAddresses: string[],
    concurrency?: number,
    options: TokenLookupOptions = {},
  ): Promise<CandidateToken[]> {
    const unique = [...new Set(mintAddresses)];
    if (unique.length === 0) return [];
    const deadline = options.deadlineMs === undefined ? undefined : Date.now() + options.deadlineMs;
    const jupiterFailed = new Set<string>();
    const found = await this.jupiter.getTokensByAddresses(unique, 2, {
      ...options,
      failed: jupiterFailed,
    });
    const priced = new Set(found.filter((t) => t.priceUsd > 0).map((t) => t.mintAddress));
    const rest = unique.filter(
      (mint) => jupiterFailed.has(mint) || (!options.mayBeUnindexed && !priced.has(mint)),
    );
    if (rest.length === 0) return found;
    const remaining = deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
    if (remaining === 0) {
      if (options.failed) for (const mint of jupiterFailed) options.failed.add(mint);
      return found;
    }
    const fromDex = await this.dexScreener.getTokensByAddresses(rest, concurrency, {
      ...options,
      deadlineMs: remaining,
    });
    const byMint = new Map(found.map((t) => [t.mintAddress, t]));
    for (const t of fromDex) if (!priced.has(t.mintAddress)) byMint.set(t.mintAddress, t);
    return [...byMint.values()];
  }
}
