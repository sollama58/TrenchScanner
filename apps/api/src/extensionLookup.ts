import bs58 from "bs58";
import { Prisma } from "@prisma/client";
import { isFeedCall, prisma, type FeedCalls } from "@trenchscanner/core";

/**
 * What the browser extension's side panel lists: the reader's recent filter matches and followed
 * models' calls, each token with the AI reviewer's verdict and the stat flags.
 *
 * Database only, by design. A mint the scanner never stored comes back in `untracked`; nothing
 * here may start a scan, a price fetch or a holder read, so the overlay costs no Helius or
 * CoinGecko credits however many people run it (provider audit 2026-10-23).
 */

/** Mints per lookup: about what three columns of a trading board show at once, with room. */
export const MAX_LOOKUP_MINTS = 100;
/** Calls, matches and reviews older than this are left off: the boards show young tokens. */
export const LOOKUP_WINDOW_MS = 24 * 60 * 60_000;
/** How long the shared (per-token, same for every reader) half of an answer is reused. */
const SHARED_TTL_MS = 20_000;
/** Tokens the shared cache holds; past it the oldest entry goes. */
const SHARED_CACHE_MAX = 5_000;
/** The AI reviewer's reasoning is cut to this for a tooltip. */
const REASONING_MAX = 280;

/** A Solana address: base58 that decodes to exactly 32 bytes. */
export function isMintAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

/** The latest snapshot's flag fields. Percentages are 0-100. */
export interface OverlayStats {
  takenAt: string;
  marketCapUsd: number;
  holderCount: number | null;
  bundledSupplyPct: number | null;
  sniperTopHolderCount: number | null;
  linkedWalletPct: number | null;
  devWalletPct: number | null;
  top10HolderPct: number | null;
  freshTop10WalletPct: number | null;
  cexFundedPct: number | null;
  kolRecentBuyers: number | null;
  mintAuthorityActive: boolean | null;
}

export interface OverlayModelCall {
  model: string;
  name: string | null;
  tier: string | null;
  confidence: number;
  calibratedPct: number | null;
  at: string;
  mcapUsd: number;
}

export interface OverlayFilterMatch {
  filterId: string;
  filterName: string;
  at: string;
  mcapUsd: number | null;
}

export interface OverlayAiReview {
  decision: string;
  probability2x: number | null;
  reasoning: string | null;
  at: string;
}

export interface OverlayToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  liveMcapUsd: number | null;
  stats: OverlayStats | null;
  modelCalls: OverlayModelCall[];
  filterMatches: OverlayFilterMatch[];
  ai: OverlayAiReview | null;
}

export interface OverlayLookup {
  tokens: OverlayToken[];
  /** Asked for, valid, and never stored by the scanner. */
  untracked: string[];
}

/** The half of an answer that is the same for every reader. Calls are filtered per reader later. */
interface SharedToken {
  tokenId: string;
  token: Omit<OverlayToken, "modelCalls" | "filterMatches">;
  calls: (OverlayModelCall & { modelId: string | null })[];
}

interface CacheEntry {
  at: number;
  value: SharedToken | null;
}

const sharedCache = new Map<string, CacheEntry>();

export function resetOverlayLookupCache(): void {
  sharedCache.clear();
}

interface TokenRow {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  liveMarketCapUsd: number | null;
  takenAt: Date | null;
  marketCapUsd: number | null;
  holderCount: number | null;
  bundledSupplyPct: number | null;
  sniperTopHolderCount: number | null;
  linkedWalletPct: number | null;
  devWalletPct: number | null;
  top10HolderPct: number | null;
  freshTop10WalletPct: number | null;
  cexFundedPct: number | null;
  kolRecentBuyers: number | null;
  mintAuthorityActive: boolean | null;
}

async function loadShared(mints: string[], now: number): Promise<Map<string, SharedToken>> {
  const out = new Map<string, SharedToken>();
  if (mints.length === 0) return out;
  // One row per token with its latest snapshot. LATERAL rather than a nested Prisma `take: 1`,
  // which reads every snapshot of every token and slices them in memory.
  const rows = await prisma.$queryRaw<TokenRow[]>`
    SELECT t."id", t."mintAddress", t."symbol", t."name", t."liveMarketCapUsd",
           s."takenAt", s."marketCapUsd", s."holderCount", s."bundledSupplyPct",
           s."sniperTopHolderCount", s."linkedWalletPct", s."devWalletPct", s."top10HolderPct",
           s."freshTop10WalletPct", s."cexFundedPct", s."kolRecentBuyers", s."mintAuthorityActive"
    FROM "Token" t
    LEFT JOIN LATERAL (
      SELECT * FROM "TokenSnapshot" ts WHERE ts."tokenId" = t."id" ORDER BY ts."takenAt" DESC LIMIT 1
    ) s ON true
    WHERE t."mintAddress" IN (${Prisma.join(mints)})`;
  if (rows.length === 0) return out;

  const ids = rows.map((r) => r.id);
  const since = new Date(now - LOOKUP_WINDOW_MS);
  const [calls, reviews] = await Promise.all([
    prisma.curatedAlert.findMany({
      where: { tokenId: { in: ids }, createdAt: { gte: since } },
      orderBy: { createdAt: "desc" },
      select: {
        tokenId: true,
        model: true,
        modelName: true,
        tier: true,
        confidence: true,
        calibratedPct: true,
        createdAt: true,
        anchorMcapUsd: true,
      },
    }),
    prisma.aiReview.findMany({
      where: { tokenId: { in: ids }, createdAt: { gte: since }, decision: { not: null }, error: null },
      orderBy: { createdAt: "desc" },
      select: { tokenId: true, decision: true, probability2x: true, reasoning: true, createdAt: true },
    }),
  ]);

  const callsByToken = new Map<string, SharedToken["calls"]>();
  for (const c of calls) {
    const list = callsByToken.get(c.tokenId) ?? [];
    list.push({
      modelId: c.model,
      model: c.model ?? "rules",
      name: c.modelName,
      tier: c.tier,
      confidence: c.confidence,
      calibratedPct: c.calibratedPct,
      at: c.createdAt.toISOString(),
      mcapUsd: c.anchorMcapUsd,
    });
    callsByToken.set(c.tokenId, list);
  }
  const reviewByToken = new Map<string, OverlayAiReview>();
  for (const r of reviews) {
    if (reviewByToken.has(r.tokenId) || r.decision === null) continue;
    reviewByToken.set(r.tokenId, {
      decision: r.decision,
      probability2x: r.probability2x,
      reasoning: r.reasoning === null ? null : r.reasoning.slice(0, REASONING_MAX),
      at: r.createdAt.toISOString(),
    });
  }

  for (const r of rows) {
    out.set(r.mintAddress, {
      tokenId: r.id,
      token: {
        mint: r.mintAddress,
        symbol: r.symbol,
        name: r.name,
        liveMcapUsd: r.liveMarketCapUsd,
        stats:
          r.takenAt === null || r.marketCapUsd === null
            ? null
            : {
                takenAt: r.takenAt.toISOString(),
                marketCapUsd: r.marketCapUsd,
                holderCount: r.holderCount,
                bundledSupplyPct: r.bundledSupplyPct,
                sniperTopHolderCount: r.sniperTopHolderCount,
                linkedWalletPct: r.linkedWalletPct,
                devWalletPct: r.devWalletPct,
                top10HolderPct: r.top10HolderPct,
                freshTop10WalletPct: r.freshTop10WalletPct,
                cexFundedPct: r.cexFundedPct,
                kolRecentBuyers: r.kolRecentBuyers,
                mintAuthorityActive: r.mintAuthorityActive,
              },
        ai: reviewByToken.get(r.id) ?? null,
      },
      calls: callsByToken.get(r.id) ?? [],
    });
  }
  return out;
}

function remember(mint: string, value: SharedToken | null, now: number): void {
  if (sharedCache.size >= SHARED_CACHE_MAX && !sharedCache.has(mint)) {
    const oldest = sharedCache.keys().next().value;
    if (oldest !== undefined) sharedCache.delete(oldest);
  }
  sharedCache.delete(mint);
  sharedCache.set(mint, { at: now, value });
}

/**
 * The overlay's answer for one reader. `mints` must already be valid and unique. `calls` is the
 * reader's feed calls (their followed models); the filter matches are read for them alone.
 */
export async function lookupOverlay(
  userId: string,
  mints: readonly string[],
  calls: FeedCalls,
  now = Date.now(),
): Promise<OverlayLookup> {
  const shared = new Map<string, SharedToken | null>();
  const missing: string[] = [];
  for (const mint of mints) {
    const hit = sharedCache.get(mint);
    if (hit && now - hit.at < SHARED_TTL_MS) shared.set(mint, hit.value);
    else missing.push(mint);
  }
  const loaded = await loadShared(missing, now);
  for (const mint of missing) {
    const value = loaded.get(mint) ?? null;
    remember(mint, value, now);
    shared.set(mint, value);
  }

  const tracked = mints.flatMap((m) => {
    const value = shared.get(m);
    return value ? [value] : [];
  });
  const matches =
    tracked.length === 0
      ? []
      : await prisma.match.findMany({
          where: {
            userId,
            tokenId: { in: tracked.map((t) => t.tokenId) },
            matchedAt: { gte: new Date(now - LOOKUP_WINDOW_MS) },
          },
          orderBy: { matchedAt: "desc" },
          select: {
            tokenId: true,
            matchedAt: true,
            alertMcapUsd: true,
            filter: { select: { id: true, name: true } },
          },
        });
  const matchesByToken = new Map<string, OverlayFilterMatch[]>();
  for (const m of matches) {
    const list = matchesByToken.get(m.tokenId) ?? [];
    // One entry per filter: its latest match.
    if (list.some((x) => x.filterId === m.filter.id)) continue;
    list.push({
      filterId: m.filter.id,
      filterName: m.filter.name,
      at: m.matchedAt.toISOString(),
      mcapUsd: m.alertMcapUsd,
    });
    matchesByToken.set(m.tokenId, list);
  }

  return {
    tokens: tracked.map((t) => {
      const seen = new Set<string>();
      const modelCalls: OverlayModelCall[] = [];
      for (const c of t.calls) {
        // One entry per model: its latest call, and only models this reader follows.
        if (seen.has(c.model) || !isFeedCall(calls, { model: c.modelId, tier: c.tier })) continue;
        seen.add(c.model);
        const { modelId: _modelId, ...call } = c;
        modelCalls.push(call);
      }
      return { ...t.token, modelCalls, filterMatches: matchesByToken.get(t.tokenId) ?? [] };
    }),
    untracked: mints.filter((m) => !shared.get(m)),
  };
}

/** How far back the side panel's list reaches, and how many tokens it holds. */
export const FEED_WINDOW_MS = 6 * 60 * 60_000;
export const FEED_MAX = 50;

/**
 * The reader's latest alerts for the side panel, newest first: tokens their filters matched and
 * tokens their followed models called, each answered as lookupOverlay answers it.
 */
export async function recentOverlay(
  userId: string,
  calls: FeedCalls,
  now = Date.now(),
): Promise<OverlayToken[]> {
  const since = new Date(now - FEED_WINDOW_MS);
  const [matches, alerts] = await Promise.all([
    prisma.match.findMany({
      where: { userId, matchedAt: { gte: since } },
      orderBy: { matchedAt: "desc" },
      take: FEED_MAX * 4,
      select: { matchedAt: true, token: { select: { mintAddress: true } } },
    }),
    calls.models.length === 0
      ? []
      : prisma.curatedAlert.findMany({
          where: {
            createdAt: { gte: since },
            model: { in: calls.models },
            ...(calls.tier === null ? {} : { tier: calls.tier }),
          },
          orderBy: { createdAt: "desc" },
          take: FEED_MAX * 4,
          select: { createdAt: true, token: { select: { mintAddress: true } } },
        }),
  ]);
  const latest = new Map<string, number>();
  const note = (mint: string, at: Date) => latest.set(mint, Math.max(latest.get(mint) ?? 0, at.getTime()));
  for (const m of matches) note(m.token.mintAddress, m.matchedAt);
  for (const a of alerts) note(a.token.mintAddress, a.createdAt);
  const mints = [...latest]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FEED_MAX)
    .map(([mint]) => mint);
  const { tokens } = await lookupOverlay(userId, mints, calls, now);
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  return mints.flatMap((m) => byMint.get(m) ?? []);
}
