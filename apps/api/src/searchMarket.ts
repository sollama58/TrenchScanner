import { prisma, type CandidateToken } from "@trenchscanner/core";

/**
 * How old a search row's market reading may be before another upstream lookup is worth it.
 * 60s is the long end of the window the search may show (30–60s): the worker's live prices, the
 * outside search's cache and a quote this process already holds are all reused inside it.
 * DexScreener's own quote cache is only 10s, so this gate sits in front of that client.
 */
export const SEARCH_MARKET_FRESH_MS = 60_000;

/** One DexScreener batch. Visible search rows are far under this; the rest keep their cached reading. */
export const SEARCH_MARKET_FETCH_MAX = 30;

/** How long a search waits on that batch before answering with what it already has. */
export const SEARCH_MARKET_FETCH_WAIT_MS = 2_000;

const REMEMBER_MAX = 4_000;

export type MarketSource = "memory" | "hit";

/** One cached reading of a mint. `at` is epoch ms; 0 means it has no time and cannot skip a fetch. */
export interface MarketReading {
  at: number;
  source: MarketSource;
  marketCapUsd?: number | null;
  volume24hUsd?: number | null;
  liquidityUsd?: number | null;
  holderCount?: number | null;
  imageUrl?: string | null;
  symbol?: string | null;
  name?: string | null;
}

export interface CoalescedMarket {
  marketCapUsd: number | null;
  /** When the market cap was read; null when no reading had one. */
  marketCapAt: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
  imageUrl: string | null;
  symbol: string | null;
  name: string | null;
  /**
   * True when the freshest timestamped reading is inside the window, so another DexScreener,
   * Jupiter or RPC read would only repeat it. Missing fields are already filled from older readings.
   */
  skipFetch: boolean;
}

const SOURCE_RANK: Record<MarketSource, number> = { memory: 0, hit: 1 };

const num = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const mcap = (value: number | null | undefined): number | null => {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
};

const text = (value: string | null | undefined): string | null => {
  const t = value?.trim();
  return t ? t : null;
};

/**
 * The best cached reading for one mint.
 *
 * The freshest timestamp wins each market field. A tie prefers an in-memory quote over the
 * search hit (the hit is already the newer of Token.live* and the latest snapshot). A field the
 * winner lacks is taken from the next reading that has it, however old. Name, ticker and image
 * already on the hit stay: a quote only fills those when the hit has none.
 * A fetch is skipped when the newest timestamp is within `freshMs` (default 60s).
 */
export function coalesceMarketReadings(
  readings: readonly MarketReading[],
  now: number,
  freshMs = SEARCH_MARKET_FRESH_MS,
): CoalescedMarket {
  const timed = readings.filter((r) => r.at > 0 && Number.isFinite(r.at));
  const byFreshness = [...timed].sort((a, b) => b.at - a.at || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
  const marketCapUsd = first(byFreshness, (r) => mcap(r.marketCapUsd));
  const capFrom = byFreshness.find((r) => mcap(r.marketCapUsd) !== null);
  const identity = [
    ...readings.filter((r) => r.source === "hit"),
    ...byFreshness.filter((r) => r.source !== "hit"),
  ];
  return {
    marketCapUsd,
    marketCapAt: capFrom?.at ?? null,
    volume24hUsd: first(byFreshness, (r) => num(r.volume24hUsd)),
    liquidityUsd: first(byFreshness, (r) => num(r.liquidityUsd)),
    holderCount: first(byFreshness, (r) => num(r.holderCount)),
    imageUrl: first(identity, (r) => text(r.imageUrl)),
    symbol: first(identity, (r) => text(r.symbol)),
    name: first(identity, (r) => text(r.name)),
    skipFetch: byFreshness.length > 0 && now - byFreshness[0]!.at <= freshMs,
  };
}

function first<T>(readings: readonly MarketReading[], pick: (r: MarketReading) => T | null): T | null {
  for (const r of readings) {
    const value = pick(r);
    if (value !== null) return value;
  }
  return null;
}

/** The fields a search row shows that a cached quote can fill. */
export interface SearchMarketHit {
  mint: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  marketCapUsd: number | null;
  marketCapAt: Date | string | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
}

/** The in-memory quote cache, peeked without a network call, plus one batched lookup. */
export interface SearchQuoteSource {
  cachedQuotes(
    mints: readonly string[],
    maxAgeMs: number,
    now?: number,
  ): Map<string, { token: CandidateToken; at: Date }>;
  getTokensByAddresses(
    mints: string[],
    concurrency?: number,
    options?: { deadlineMs?: number },
  ): Promise<CandidateToken[]>;
}

interface Remembered {
  at: number;
  token: CandidateToken | null;
}

const remembered = new Map<string, Remembered>();
const inflight = new Map<string, Promise<void>>();

/** Forgets quotes this process stored for search (tests). */
export function clearSearchMarketMemory(): void {
  remembered.clear();
}

function remember(mint: string, token: CandidateToken | null, at: number): void {
  remembered.delete(mint);
  remembered.set(mint, { token, at });
  while (remembered.size > REMEMBER_MAX) {
    const oldest = remembered.keys().next().value;
    if (oldest === undefined) break;
    remembered.delete(oldest);
  }
}

function atOf(value: Date | string | null): number {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function quoteReading(token: CandidateToken, at: number): MarketReading {
  return {
    at,
    source: "memory",
    marketCapUsd: token.marketCapUsd,
    volume24hUsd: token.volume24hUsd ?? null,
    liquidityUsd: token.liquidityUsd ?? null,
    imageUrl: token.imageUrl?.startsWith("https://") ? token.imageUrl : null,
    symbol: token.symbol ?? null,
    name: token.name ?? null,
  };
}

function hitReading(hit: SearchMarketHit): MarketReading {
  return {
    at: atOf(hit.marketCapAt),
    source: "hit",
    marketCapUsd: hit.marketCapUsd,
    volume24hUsd: hit.volume24hUsd,
    liquidityUsd: hit.liquidityUsd,
    holderCount: hit.holderCount,
    imageUrl: hit.imageUrl,
    symbol: hit.symbol,
    name: hit.name,
  };
}

function readingsFor(
  hit: SearchMarketHit,
  cached: { token: CandidateToken; at: Date } | undefined,
  held: Remembered | undefined,
): MarketReading[] {
  const out: MarketReading[] = [hitReading(hit)];
  if (cached) out.push(quoteReading(cached.token, cached.at.getTime()));
  if (held?.token) out.push(quoteReading(held.token, held.at));
  else if (held) out.push({ at: held.at, source: "memory" });
  return out;
}

function tokenFrom(mint: string, merged: CoalescedMarket): CandidateToken {
  return {
    mintAddress: mint,
    symbol: merged.symbol ?? undefined,
    name: merged.name ?? undefined,
    priceUsd: 0,
    marketCapUsd: merged.marketCapUsd ?? 0,
    volume24hUsd: merged.volume24hUsd ?? undefined,
    liquidityUsd: merged.liquidityUsd ?? undefined,
    imageUrl: merged.imageUrl ?? undefined,
  };
}

function apply<T extends SearchMarketHit>(hit: T, merged: CoalescedMarket): T {
  return {
    ...hit,
    symbol: merged.symbol,
    name: merged.name,
    imageUrl: merged.imageUrl,
    marketCapUsd: merged.marketCapUsd,
    marketCapAt: merged.marketCapAt === null ? null : new Date(merged.marketCapAt),
    volume24hUsd: merged.volume24hUsd,
    liquidityUsd: merged.liquidityUsd,
    holderCount: merged.holderCount,
  };
}

/**
 * Fills each hit from the freshest quote this process already holds, then asks DexScreener once
 * for the mints whose newest reading is older than the window (at most one batch). A mint read
 * inside the window, including a read that came back empty, is not asked again.
 */
export async function fillSearchMarketHits<T extends SearchMarketHit>(
  hits: readonly T[],
  dex: SearchQuoteSource,
  now = Date.now(),
): Promise<T[]> {
  try {
    return await fillSearchMarketHitsInner(hits, dex, now);
  } catch {
    // A quote read must not fail the search. The rows keep the snapshot they already had.
    return [...hits];
  }
}

async function fillSearchMarketHitsInner<T extends SearchMarketHit>(
  hits: readonly T[],
  dex: SearchQuoteSource,
  now: number,
): Promise<T[]> {
  if (hits.length === 0) return [];
  const mints = hits.map((h) => h.mint);
  const cached = dex.cachedQuotes(mints, SEARCH_MARKET_FRESH_MS, now);
  const plan = hits.map((hit) => {
    const merged = coalesceMarketReadings(
      readingsFor(hit, cached.get(hit.mint), remembered.get(hit.mint)),
      now,
    );
    return { hit, merged };
  });

  const need = plan
    .filter((p) => !p.merged.skipFetch)
    .sort((a, b) => {
      const empty = (p: (typeof plan)[number]) => (p.merged.marketCapUsd === null ? 0 : 1);
      return empty(a) - empty(b) || (a.merged.marketCapAt ?? 0) - (b.merged.marketCapAt ?? 0);
    })
    .slice(0, SEARCH_MARKET_FETCH_MAX)
    .map((p) => p.hit.mint);

  if (need.length > 0) await fetchFresh(dex, need);

  return plan.map(({ hit }) => {
    const merged = coalesceMarketReadings(
      readingsFor(
        hit,
        dex.cachedQuotes([hit.mint], SEARCH_MARKET_FRESH_MS, Date.now()).get(hit.mint),
        remembered.get(hit.mint),
      ),
      Date.now(),
    );
    if (merged.skipFetch && merged.marketCapAt !== null) {
      const prev = remembered.get(hit.mint);
      if (!prev || prev.at < merged.marketCapAt)
        remember(hit.mint, tokenFrom(hit.mint, merged), merged.marketCapAt);
    }
    return apply(hit, merged);
  });
}

async function fetchFresh(dex: SearchQuoteSource, mints: string[]): Promise<void> {
  const wait: Promise<void>[] = [];
  const start: string[] = [];
  for (const mint of mints) {
    const running = inflight.get(mint);
    if (running) wait.push(running);
    else start.push(mint);
  }
  if (start.length > 0) {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const mint of start) inflight.set(mint, gate);
    const job = (async () => {
      try {
        const tokens = await dex.getTokensByAddresses(start, 1, { deadlineMs: SEARCH_MARKET_FETCH_WAIT_MS });
        const at = Date.now();
        const byMint = new Map(tokens.map((t) => [t.mintAddress, t]));
        for (const mint of start) remember(mint, byMint.get(mint) ?? null, at);
      } catch {
        const at = Date.now();
        for (const mint of start) remember(mint, null, at);
      } finally {
        for (const mint of start) inflight.delete(mint);
        release();
      }
    })();
    wait.push(job);
  }
  await Promise.all(wait);
}

interface ShellRow {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  liveMarketCapUsd: number | null;
  liveDataAt: Date | null;
}

interface LatestScan {
  tokenId: string;
  takenAt: Date;
  marketCapUsd: number;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  holderCount: number | null;
}

/**
 * A search-shaped market row for each mint, from Token.live* and the newest snapshot only.
 * A mint the scanner doesn't track comes back empty so a cached quote can still fill it.
 */
export async function loadSearchMarketHits(mints: readonly string[]): Promise<SearchMarketHit[]> {
  if (mints.length === 0) return [];
  const rows = await prisma.token.findMany({
    where: { mintAddress: { in: [...mints] } },
    select: {
      id: true,
      mintAddress: true,
      symbol: true,
      name: true,
      imageUrl: true,
      liveMarketCapUsd: true,
      liveDataAt: true,
    },
  });
  const ids = rows.map((r) => r.id);
  const scans =
    ids.length === 0
      ? []
      : await prisma.$queryRaw<LatestScan[]>`
          SELECT s."tokenId", s."takenAt", s."marketCapUsd", s."volume24hUsd", s."liquidityUsd", s."holderCount"
          FROM unnest(${ids}::text[]) AS t(id)
          CROSS JOIN LATERAL (
            SELECT "tokenId", "takenAt", "marketCapUsd", "volume24hUsd", "liquidityUsd", "holderCount"
            FROM "TokenSnapshot" WHERE "tokenId" = t.id ORDER BY "takenAt" DESC LIMIT 1
          ) s`;
  const rowOf = new Map(rows.map((r) => [r.mintAddress, r]));
  const scanOf = new Map(scans.map((s) => [s.tokenId, s]));
  return mints.map((mint) => shell(mint, rowOf.get(mint), scanOf));
}

function shell(mint: string, row: ShellRow | undefined, scanOf: Map<string, LatestScan>): SearchMarketHit {
  const empty: SearchMarketHit = {
    mint,
    symbol: null,
    name: null,
    imageUrl: null,
    marketCapUsd: null,
    marketCapAt: null,
    volume24hUsd: null,
    liquidityUsd: null,
    holderCount: null,
  };
  if (!row) return empty;
  const scan = scanOf.get(row.id);
  const liveAt = row.liveDataAt?.getTime() ?? -Infinity;
  const live =
    row.liveMarketCapUsd != null &&
    row.liveMarketCapUsd > 0 &&
    liveAt >= (scan?.takenAt.getTime() ?? -Infinity);
  return {
    mint,
    symbol: row.symbol,
    name: row.name,
    imageUrl: row.imageUrl,
    marketCapUsd: live ? row.liveMarketCapUsd : mcap(scan?.marketCapUsd),
    marketCapAt: live ? row.liveDataAt : (scan?.takenAt ?? null),
    volume24hUsd: scan?.volume24hUsd ?? null,
    liquidityUsd: scan?.liquidityUsd ?? null,
    holderCount: scan?.holderCount ?? null,
  };
}
