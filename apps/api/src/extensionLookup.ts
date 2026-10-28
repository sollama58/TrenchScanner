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
/** A failed verdict's reasons, at most this many, for a tooltip. */
const REASONS_MAX = 6;

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
  /**
   * How many of the top 10 holders hold nothing else worth $25 (the scan's empty-wallet check,
   * re-measured each cycle against the current top 10): the newest reading, or the last known
   * one when the newest scan's lookups didn't all land. Absent before 0.8.1's API.
   */
  emptyTop10WalletCount: number | null;
  cexFundedPct: number | null;
  kolRecentBuyers: number | null;
  mintAuthorityActive: boolean | null;
  /**
   * The same numbers from the newest snapshot at least EARLIER_MS before this one, so the overlay
   * can show which way each moved (user ask 2026-10-27: a bundle forming shows as EMPTY 3↑). Null
   * when the coin has no snapshot that old; a field is null when that snapshot didn't measure it.
   */
  earlier: OverlayEarlier | null;
}

/** A coin's flag numbers some minutes back (OverlayStats.earlier). */
export interface OverlayEarlier {
  takenAt: string;
  holderCount: number | null;
  bundledSupplyPct: number | null;
  sniperTopHolderCount: number | null;
  linkedWalletPct: number | null;
  devWalletPct: number | null;
  top10HolderPct: number | null;
  freshTop10WalletPct: number | null;
  emptyTop10WalletCount: number | null;
  cexFundedPct: number | null;
  kolRecentBuyers: number | null;
}

/**
 * The coin's creator and how its other launches went (user ask 2026-10-27), from the hourly
 * DevLaunchRisk rebuild (the token modal's Dev card reads the same rows, tokenProfile.ts). `record`
 * is null when the creator has no row: fewer than two launches in 14 days and none in the band.
 * `family` pools every creator the same funder paid for, when there are two or more.
 */
export interface OverlayDev {
  wallet: string;
  record: OverlayLaunchRecord | null;
  family: (OverlayLaunchRecord & { creators: number }) | null;
}

export interface OverlayLaunchRecord {
  /** Dev launch score, 0-100, higher is riskier. */
  score: number;
  launches: number;
  inBand: number;
  wins: number;
  stops: number;
}

export interface OverlayModelCall {
  model: string;
  name: string | null;
  tier: string | null;
  confidence: number;
  calibratedPct: number | null;
  at: string;
  mcapUsd: number;
  /** The highest market cap seen since the call (the track record's peak); null before one. */
  peakMcapUsd: number | null;
}

export interface OverlayFilterMatch {
  filterId: string;
  filterName: string;
  at: string;
  mcapUsd: number | null;
  /** The highest market cap seen since the match; null before one. */
  peakMcapUsd: number | null;
}

export interface OverlayAiReview {
  decision: string;
  probability2x: number | null;
  reasoning: string | null;
  at: string;
}

/**
 * The safety screen's verdict on the newest scan (user ask 2026-10-25), as the site's token view
 * pill reads it (web safetyScreen.ts): a coin that passed at its alert can fail later, and back.
 */
export interface OverlaySafety {
  passed: boolean;
  /** Why it failed, in the screen's words; empty when it passed. */
  reasons: string[];
  at: string;
}

export interface OverlayToken {
  mint: string;
  symbol: string | null;
  name: string | null;
  /** The token's logo as DexScreener hosts it; null when it has none. */
  image: string | null;
  liveMcapUsd: number | null;
  stats: OverlayStats | null;
  /** Null until the scanner has a snapshot of the coin. */
  safety: OverlaySafety | null;
  /** Null when the scanner doesn't know who created the coin. */
  dev: OverlayDev | null;
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

/** Drops the coins' shared halves (a new snapshot was written), or all of them with null. */
export function forgetOverlayTokens(mints: readonly string[] | null): void {
  if (mints === null) sharedCache.clear();
  else for (const mint of mints) sharedCache.delete(mint);
}

interface TokenRow {
  id: string;
  mintAddress: string;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
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
  emptyTop10WalletPct: number | null;
  top10WalletsChecked: number | null;
  cexFundedPct: number | null;
  kolRecentBuyers: number | null;
  mintAuthorityActive: boolean | null;
  rugScreenPassed: boolean | null;
  rugScreenReasons: string[] | null;
  eTakenAt: Date | null;
  eHolderCount: number | null;
  eBundledSupplyPct: number | null;
  eSniperTopHolderCount: number | null;
  eLinkedWalletPct: number | null;
  eDevWalletPct: number | null;
  eTop10HolderPct: number | null;
  eFreshTop10WalletPct: number | null;
  eEmptyTop10WalletPct: number | null;
  eTop10WalletsChecked: number | null;
  eCexFundedPct: number | null;
  eKolRecentBuyers: number | null;
  devWallet: string | null;
  dScore: number | null;
  dLaunches: number | null;
  dInBand: number | null;
  dWins: number | null;
  dStops: number | null;
  fCreators: number | null;
  fScore: number | null;
  fLaunches: number | null;
  fInBand: number | null;
  fWins: number | null;
  fStops: number | null;
}

/** How far back the trend compares (OverlayStats.earlier): a few scans, so one noisy read can't flip it. */
export const EARLIER_MS = 5 * 60_000;

/** An empty-wallet share as a count of the top 10 checked (what the overlay shows). */
function emptyCount(pct: number | null, checked: number | null): number | null {
  return pct === null ? null : Math.round((pct / 100) * (checked ?? 10));
}

function devOf(r: TokenRow): OverlayDev | null {
  if (!r.devWallet) return null;
  return {
    wallet: r.devWallet,
    record:
      r.dScore === null
        ? null
        : {
            score: r.dScore,
            launches: r.dLaunches ?? 0,
            inBand: r.dInBand ?? 0,
            wins: r.dWins ?? 0,
            stops: r.dStops ?? 0,
          },
    family:
      r.fScore === null
        ? null
        : {
            creators: r.fCreators ?? 0,
            score: r.fScore,
            launches: r.fLaunches ?? 0,
            inBand: r.fInBand ?? 0,
            wins: r.fWins ?? 0,
            stops: r.fStops ?? 0,
          },
  };
}

async function loadShared(mints: string[], now: number): Promise<Map<string, SharedToken>> {
  const out = new Map<string, SharedToken>();
  if (mints.length === 0) return out;
  // One row per token with its latest snapshot. LATERAL rather than a nested Prisma `take: 1`,
  // which reads every snapshot of every token and slices them in memory.
  const rows = await prisma.$queryRaw<TokenRow[]>`
    SELECT t."id", t."mintAddress", t."symbol", t."name", t."imageUrl", t."liveMarketCapUsd",
           s."takenAt", s."marketCapUsd", s."holderCount", s."bundledSupplyPct",
           s."sniperTopHolderCount", s."linkedWalletPct", s."devWalletPct", s."top10HolderPct",
           s."freshTop10WalletPct", s."cexFundedPct", s."kolRecentBuyers", s."mintAuthorityActive",
           s."emptyTop10WalletPct",
           s."top10WalletsChecked",
           s."rugScreenPassed", s."rugScreenReasons",
           e."takenAt" AS "eTakenAt", e."holderCount" AS "eHolderCount",
           e."bundledSupplyPct" AS "eBundledSupplyPct", e."sniperTopHolderCount" AS "eSniperTopHolderCount",
           e."linkedWalletPct" AS "eLinkedWalletPct", e."devWalletPct" AS "eDevWalletPct",
           e."top10HolderPct" AS "eTop10HolderPct", e."freshTop10WalletPct" AS "eFreshTop10WalletPct",
           e."emptyTop10WalletPct" AS "eEmptyTop10WalletPct", e."top10WalletsChecked" AS "eTop10WalletsChecked",
           e."cexFundedPct" AS "eCexFundedPct", e."kolRecentBuyers" AS "eKolRecentBuyers",
           COALESCE(t."deployer", t."creator") AS "devWallet",
           d."score" AS "dScore", d."launches" AS "dLaunches", d."inBand" AS "dInBand",
           d."wins" AS "dWins", d."stops" AS "dStops",
           f."creators" AS "fCreators", f."score" AS "fScore", f."launches" AS "fLaunches",
           f."inBand" AS "fInBand", f."wins" AS "fWins", f."stops" AS "fStops"
    FROM "Token" t
    LEFT JOIN LATERAL (
      SELECT * FROM "TokenSnapshot" ts WHERE ts."tokenId" = t."id" ORDER BY ts."takenAt" DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT * FROM "TokenSnapshot" es
      WHERE es."tokenId" = t."id" AND es."takenAt" <= s."takenAt" - ${EARLIER_MS} * interval '1 millisecond'
      ORDER BY es."takenAt" DESC LIMIT 1
    ) e ON true
    LEFT JOIN "DevLaunchRisk" d ON d."wallet" = COALESCE(t."deployer", t."creator")
    LEFT JOIN "DevFunderRisk" f ON f."funder" = d."funder"
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
        liveMcapUsd: true,
        peakMcapUsd: true,
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
      // Pump.fun's cap as the call went out, when it answered, as the web's card shows it: the
      // anchor runs 45-60 s behind the market (audit 2026-10-27, EX-7). Grades still use the anchor.
      mcapUsd: c.liveMcapUsd ?? c.anchorMcapUsd,
      peakMcapUsd: c.peakMcapUsd,
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
        image: r.imageUrl,
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
                emptyTop10WalletCount: emptyCount(r.emptyTop10WalletPct, r.top10WalletsChecked),
                cexFundedPct: r.cexFundedPct,
                kolRecentBuyers: r.kolRecentBuyers,
                mintAuthorityActive: r.mintAuthorityActive,
                earlier:
                  r.eTakenAt === null
                    ? null
                    : {
                        takenAt: r.eTakenAt.toISOString(),
                        holderCount: r.eHolderCount,
                        bundledSupplyPct: r.eBundledSupplyPct,
                        sniperTopHolderCount: r.eSniperTopHolderCount,
                        linkedWalletPct: r.eLinkedWalletPct,
                        devWalletPct: r.eDevWalletPct,
                        top10HolderPct: r.eTop10HolderPct,
                        freshTop10WalletPct: r.eFreshTop10WalletPct,
                        emptyTop10WalletCount: emptyCount(r.eEmptyTop10WalletPct, r.eTop10WalletsChecked),
                        cexFundedPct: r.eCexFundedPct,
                        kolRecentBuyers: r.eKolRecentBuyers,
                      },
              },
        safety:
          r.takenAt === null || r.rugScreenPassed === null
            ? null
            : {
                passed: r.rugScreenPassed,
                reasons: r.rugScreenPassed ? [] : (r.rugScreenReasons ?? []).slice(0, REASONS_MAX),
                at: r.takenAt.toISOString(),
              },
        dev: devOf(r),
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

/** Each mint's shared half, from the cache where it is fresh enough; null for an untracked mint. */
async function sharedFor(mints: readonly string[], now: number): Promise<Map<string, SharedToken | null>> {
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
  return shared;
}

/**
 * The safety verdicts of the coins on a board, for the extension's option that hides or marks the
 * ones failing the screen (user ask 2026-10-25). The same for every reader, so it reads only the
 * shared half; a coin the scanner never stored, or never screened, is left out.
 */
export async function safetyOverlay(
  mints: readonly string[],
  now = Date.now(),
): Promise<Record<string, OverlaySafety>> {
  const shared = await sharedFor(mints, now);
  const out: Record<string, OverlaySafety> = {};
  for (const [mint, value] of shared) if (value?.token.safety) out[mint] = value.token.safety;
  return out;
}

/**
 * The stats of the coins on a board, for the extension's option that puts the ring's pill on every
 * coin TrenchScanner has numbers for (user ask 2026-10-26): the shared half only (no reader's calls
 * or matches, no AI review), the same for every reader. A coin the scanner never stored, or never
 * snapshotted, is left out.
 */
export async function statsOverlay(
  mints: readonly string[],
  now = Date.now(),
): Promise<Record<string, Omit<OverlayToken, "modelCalls" | "filterMatches" | "ai">>> {
  const shared = await sharedFor(mints, now);
  const out: Record<string, Omit<OverlayToken, "modelCalls" | "filterMatches" | "ai">> = {};
  for (const [mint, value] of shared) {
    if (!value?.token.stats) continue;
    const { ai: _ai, ...token } = value.token;
    out[mint] = token;
  }
  return out;
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
  const shared = await sharedFor(mints, now);
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
          orderBy: { matchedAt: "asc" },
          select: {
            tokenId: true,
            matchedAt: true,
            alertMcapUsd: true,
            peakMcapUsd: true,
            filter: { select: { id: true, name: true } },
          },
        });
  const matchesByToken = new Map<string, OverlayFilterMatch[]>();
  for (const m of matches) {
    const list = matchesByToken.get(m.tokenId) ?? [];
    // Oldest first, one entry per filter: its first match, the one that alerted the reader.
    if (list.some((x) => x.filterId === m.filter.id)) continue;
    list.push({
      filterId: m.filter.id,
      filterName: m.filter.name,
      at: m.matchedAt.toISOString(),
      mcapUsd: m.alertMcapUsd,
      peakMcapUsd: m.peakMcapUsd,
    });
    matchesByToken.set(m.tokenId, list);
  }

  return {
    tokens: tracked.map((t) => {
      const seen = new Set<string>();
      const modelCalls: OverlayModelCall[] = [];
      // Oldest first, one entry per model: its first call, the one that alerted the reader. A later
      // call (another model's, or a re-call at a higher cap) must not stand in for the alert.
      for (const c of [...t.calls].reverse()) {
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
  /** Settings' "only alerts both caught": only coins with both a match and a followed call (EX-6). */
  bothOnly = false,
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
  const called = new Set(alerts.map((a) => a.token.mintAddress));
  const matched = new Set(matches.map((m) => m.token.mintAddress));
  for (const m of matches)
    if (!bothOnly || called.has(m.token.mintAddress)) note(m.token.mintAddress, m.matchedAt);
  for (const a of alerts)
    if (!bothOnly || matched.has(a.token.mintAddress)) note(a.token.mintAddress, a.createdAt);
  const mints = [...latest]
    .sort((a, b) => b[1] - a[1])
    .slice(0, FEED_MAX)
    .map(([mint]) => mint);
  const { tokens } = await lookupOverlay(userId, mints, calls, now);
  const byMint = new Map(tokens.map((t) => [t.mint, t]));
  return mints.flatMap((m) => byMint.get(m) ?? []);
}
