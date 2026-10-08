import {
  prisma,
  createLogger,
  buildScoredToken,
  scoreToken,
  refreshScoreWeights,
  forEachWithConcurrency,
  EMPTY_TRADE_FLOW,
  type Env,
  type DexScreenerClient,
  type OnChainProfile,
  type NarrativeRead,
} from "@trenchscanner/core";
import { createMatchesForTargets, resolveAlertTargets, type FilterWithUser } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";
import { recentScanVerdicts, type VettedEntry } from "./vettedTokens.js";
import { noteFreshMarketData } from "./matchPeaks.js";
import { noteAlertWallets } from "./walletPriority.js";
import { loadNarrativeReads } from "../tokensage/narrativeReads.js";

const logger = createLogger("fast-match");

/**
 * The fast lane between "the market moved" and "the person who asked to know about it knows".
 *
 * The full scan cycle runs once a minute, so a token that becomes matchable a second after a
 * cycle starts waits almost a full minute to be noticed - the single largest term in the alert
 * latency budget, larger than every other stage combined. That interval is set by how expensive
 * the cycle is (discovery across two sources, a 900-mint watchlist refresh, RugCheck, Helius),
 * none of which is what makes a token match a filter. A filter is evaluated against MARKET data:
 * price, market cap, volume, buy pressure, age.
 *
 * So this pass does only that. It re-prices tokens the full cycle has recently vetted, rebuilds
 * their on-chain half from the last snapshot rather than asking anyone, re-scores, and alerts.
 * One batched DexScreener call per 30 tokens, and NOT ONE call to RugCheck or Helius - the
 * on-chain facts it carries forward are the same ones the full cycle would have served from its
 * own caches anyway (RugCheck is cached for RUGCHECK_CACHE_TTL_MINUTES, Mayhem permanently,
 * authorities for MINT_AUTHORITY_ACTIVE_TTL_MINUTES).
 *
 * What it deliberately does NOT do: discover new mints, re-run the rug screen against fresh
 * on-chain data, bank training samples, or emit curated alerts. Those all stay on the full
 * cycle. This pass exists to shorten one specific path - a user's own filter matching - and
 * every extra responsibility would put something back in front of it.
 */

/**
 * How recently the full cycle must have vetted a token for this pass to re-price it. Two things
 * at once: a freshness bound on the carried-forward on-chain data, and the definition of "in
 * play" - a token the last few cycles found in band and rug-screen-clean.
 */
const VETTED_WITHIN_MINUTES = 12;

/** Safety cap on how many tokens one pass re-prices, so a busy market can't turn a 15-second
 *  job into a DexScreener hammer. At 30 mints per batched call this is a handful of requests. */
const MAX_TRACKED = 300;

/**
 * How many priced tokens are matched at once. Each is a handful of queries (the cooldown read,
 * and only on a real alert the snapshot and match writes), and they touch different tokens' rows -
 * the one cross-lane race, the scan cycle alerting the same token at the same moment, is already
 * serialized per token by createMatchesForTargets' advisory lock. One at a time put every query
 * for the first tokens in front of the last token's alert; this stays well inside the worker's
 * connection pool, which the scan cycle shares.
 */
const MATCH_CONCURRENCY = 4;

/**
 * Rebuilds the on-chain half of a candidate from its last full-scan snapshot.
 *
 * Every field the rug screen and the filters read was persisted at scan time, so this needs no
 * network at all. isMayhemMode is the load-bearing one: it is null when the check never ran,
 * and the rug screen rejects an unverified mint - so a snapshot that never resolved it produces
 * a profile that fails the screen here exactly as it did there, rather than being waved through.
 */
function profileFromSnapshot(
  mintAddress: string,
  snapshot: {
    mintAuthorityActive: boolean | null;
    freezeAuthorityActive: boolean | null;
    lpBurned: boolean | null;
    isMayhemMode: boolean | null;
    holderCount: number | null;
    top10HolderPct: number | null;
    devWalletPct: number | null;
    riskScore: number | null;
    riskFlags: string[];
    freshTop10WalletPct: number | null;
    emptyTop10WalletPct: number | null;
    sniperTop10WalletPct: number | null;
    devHolding: boolean | null;
  },
): OnChainProfile | null {
  // The three the screen treats as hard requirements. Unknown means the snapshot predates the
  // data or the lookup failed, and inventing a value here would admit a token the full cycle
  // rejected - so it simply isn't a candidate for the fast path.
  if (
    snapshot.mintAuthorityActive === null ||
    snapshot.freezeAuthorityActive === null ||
    snapshot.lpBurned === null
  ) {
    return null;
  }
  return {
    mintAddress,
    mintAuthorityActive: snapshot.mintAuthorityActive,
    freezeAuthorityActive: snapshot.freezeAuthorityActive,
    lpBurned: snapshot.lpBurned,
    isMayhemMode: snapshot.isMayhemMode ?? undefined,
    holderCount: snapshot.holderCount ?? undefined,
    top10HolderPct: snapshot.top10HolderPct ?? undefined,
    devWalletPct: snapshot.devWalletPct ?? undefined,
    riskScore: snapshot.riskScore ?? undefined,
    riskFlags: snapshot.riskFlags,
    freshTop10WalletPct: snapshot.freshTop10WalletPct ?? undefined,
    emptyTop10WalletPct: snapshot.emptyTop10WalletPct ?? undefined,
    sniperTop10WalletPct: snapshot.sniperTop10WalletPct ?? undefined,
    // The scan's resolved answer, carried forward; the fast path has no trade-stream view of its own.
    creatorHolding: snapshot.devHolding ?? undefined,
  };
}

export async function runFastMatchCycle(
  dexScreener: DexScreenerClient,
  env: Env,
): Promise<{ stagesMs: Record<string, number>; tracked?: number; matches?: number }> {
  const startedAt = Date.now();
  await refreshScoreWeights();
  const stagesMs: Record<string, number> = {};
  let lapStartedAt = startedAt;
  const lap = (stage: string) => {
    const now = Date.now();
    stagesMs[stage] = now - lapStartedAt;
    lapStartedAt = now;
  };

  // Nothing to be fast about if nobody is filtering. Checked first because it is the cheapest
  // question and it short-circuits the whole pass on a deployment with no active users.
  const activeFilters: FilterWithUser[] = await prisma.userFilter.findMany({ where: { isActive: true } });
  if (activeFilters.length === 0) return { stagesMs };

  const vettedSince = new Date(startedAt - VETTED_WITHIN_MINUTES * 60_000);
  // The candidate set: tokens whose most recent full-scan snapshot passed the rug screen.
  //
  // Two things here are load-bearing, and this query had both wrong. It only considers rows the
  // SCAN wrote (see TokenSnapshot.source): this pass carries the on-chain half forward rather
  // than re-resolving it, so counting its own rows as vetting let a token re-arm its window
  // every 15 seconds off restatements of a verdict the scan had since reversed. And the newest
  // row per token is taken FIRST, with the screen applied after - filtering to passing rows
  // inside the query made a newer failing snapshot invisible, so a token whose LP had just
  // unlocked kept being alerted from the older passing row underneath it, for the full 12
  // minutes. The screen is a hard gate; the freshest verdict is the only one that counts.
  //
  // Taken newest-first so a flood can only ever cost us the least recently seen.
  //
  // The newest row per token is picked in SQL. Prisma's `distinct` is applied in memory after
  // the query, with no LIMIT on the SQL, so it used to pull every scan snapshot of the last 12
  // minutes - one per watched token per cycle, thousands of full rows - four times a minute,
  // which is a large share of what pushed the worker past its memory limit.
  // From the scan cycle's own in-memory record (vettedTokens.ts); the database only until the
  // first cycle after a restart has filled it.
  // The cap is applied to PASSING verdicts. Most verdicts recorded in a cycle are failing ones
  // (hundreds in band, a few dozen passing), and capping before the screen let them push the
  // older passing tokens past the cap - those were then not re-priced at all, so the fast lane
  // quietly fell back to the scan's cadence for whichever tokens a cycle had reached last.
  const recent =
    recentScanVerdicts(vettedSince, Number.POSITIVE_INFINITY) ??
    (await newestScanVerdictsFromDb(vettedSince, env));
  const vetted = recent.filter((v) => v.snapshot.rugScreenPassed).slice(0, MAX_TRACKED);
  lap("select");
  if (vetted.length === 0) return { stagesMs };

  const byMint = new Map(vetted.map((v) => [v.token.mintAddress, v]));
  // Alongside the price fetch: one primary-key read, empty while TokenSage is off.
  const narrativesPromise = loadNarrativeReads([...byMint.keys()], env).catch((err: unknown) => {
    logger.warn("fast match narrative read failed", { error: String(err) });
    return new Map<string, NarrativeRead>();
  });
  let fresh;
  try {
    // Bounded like the scan's own refresh: this lane runs every 15 seconds and a throttled
    // DexScreener (Retry-After up to 10s, twice, per batch) could hold one pass for most of a minute.
    fresh = await dexScreener.getTokensByAddresses([...byMint.keys()], undefined, {
      timeoutMs: 5_000,
      retries: 1,
      deadlineMs: 10_000,
    });
  } catch (err) {
    // The full cycle is still running underneath this; a failed fast pass costs latency, never
    // an alert.
    logger.warn("fast match price fetch failed", { error: String(err) });
    return { stagesMs };
  }
  lap("price");
  const narratives = await narrativesPromise;

  let matched = 0;
  let evaluated = 0;
  await forEachWithConcurrency(fresh, MATCH_CONCURRENCY, async (candidate) => {
    const entry = byMint.get(candidate.mintAddress);
    if (!entry) return;

    const onChain = profileFromSnapshot(candidate.mintAddress, entry.snapshot);
    if (!onChain) return;

    const scored = buildScoredToken(candidate, onChain, {
      // The earlier of the two, as the scan does: a graduated token's canonical pair is its
      // PumpSwap pool, created at graduation, not at launch.
      createdAt:
        candidate.pairCreatedAt && candidate.pairCreatedAt < entry.token.firstSeenAt
          ? candidate.pairCreatedAt
          : entry.token.firstSeenAt,
      // Holder growth needs a baseline the full cycle owns; leaving it unset records "not
      // measured" rather than a fabricated 0, and matchesFilter treats an unknown growth as
      // failing a minHolderGrowthPct filter - so this pass can never alert on a criterion it
      // did not actually evaluate.
    });
    // The first-buyers count comes from the scan's trade stream, carried forward like the
    // on-chain half so a filter rule on it is applied here too and the alert's snapshot keeps it.
    if (entry.snapshot.firstBuyersHolding !== null) {
      scored.tradeFlow = {
        ...EMPTY_TRADE_FLOW,
        firstBuyersHolding: entry.snapshot.firstBuyersHolding,
        firstBuyersSeen: entry.snapshot.firstBuyersSeen,
      };
    }
    // TokenSage's read too, so a narrative criterion and the score's narrative part are applied
    // here exactly as the full cycle applies them (a narrative criterion fails closed without it).
    const narrative = narratives.get(candidate.mintAddress);
    if (narrative) scored.narrative = narrative;
    if (scored.tradeFlow || narrative) scored.score = scoreToken(scored);
    evaluated += 1;
    if (!scored.rugScreen.passed) return;

    try {
      // Read-after-await, so the increment can't be lost between two tokens finishing together.
      const created = await alertForToken(entry.token, scored, activeFilters, env);
      matched += created;
    } catch (err) {
      logger.warn("fast match failed for token", { mint: candidate.mintAddress, error: String(err) });
    }
  });
  lap("match");

  if (matched > 0) {
    logger.info("fast match pass alerted", {
      durationMs: Date.now() - startedAt,
      tracked: byMint.size,
      evaluated,
      matches: matched,
      stagesMs,
    });
  }
  return { stagesMs, tracked: byMint.size, matches: matched };
}

/**
 * The same answer as recentScanVerdicts, from the database: the newest scan snapshot per token
 * since `since`. Only used until the first scan cycle in this process has filled the in-memory
 * record - it is the slow query that record exists to avoid.
 *
 * Starts from the tokens the scan could have written a snapshot for - the watchlist (first seen
 * inside WATCHLIST_TTL_HOURS) and the actively-viewed set - through Token's own indexes, then
 * probes TokenSnapshot(tokenId, takenAt) once per token. Asking TokenSnapshot directly for "scan
 * rows since X" has no index to use in production (no (source, takenAt) index was ever built
 * there), so it was a full scan of the largest table in the database, four times a minute, for
 * the first minute or two after every deploy.
 */
async function newestScanVerdictsFromDb(since: Date, env: Env): Promise<VettedEntry[]> {
  const watchlistSince = new Date(Date.now() - env.WATCHLIST_TTL_HOURS * 3_600_000);
  const viewedSince = new Date(since.getTime() - env.ACTIVE_VIEW_WINDOW_MINUTES * 60_000);
  const newestIds = await prisma.$queryRaw<{ id: string }[]>`
    SELECT s.id
    FROM "Token" t
    CROSS JOIN LATERAL (
      SELECT id, "takenAt", "rugScreenPassed"
      FROM "TokenSnapshot"
      WHERE "tokenId" = t.id AND "takenAt" > ${since} AND source = 'scan'
      ORDER BY "takenAt" DESC
      LIMIT 1
    ) s
    WHERE (t."firstSeenAt" > ${watchlistSince} OR t."lastViewedAt" > ${viewedSince})
      AND s."rugScreenPassed"
    ORDER BY s."takenAt" DESC
    LIMIT ${MAX_TRACKED}`;
  if (newestIds.length === 0) return [];
  const rows = await prisma.tokenSnapshot.findMany({
    where: { id: { in: newestIds.map((r) => r.id) } },
    include: { token: { select: { id: true, mintAddress: true, firstSeenAt: true } } },
  });
  return rows.map(({ token, ...snapshot }) => ({ token, snapshot }));
}

/**
 * Writes the fresh snapshot and creates the matches - but only once something is actually going
 * to be alerted on.
 *
 * The snapshot is written lazily on purpose. This pass runs four times a minute over hundreds of
 * tokens; minting a row every time would quadruple TokenSnapshot for readings nobody reads. A
 * match needs a snapshot to point at, so one is written exactly when a match is about to exist -
 * and it carries this moment's real market data with the on-chain half carried forward, which is
 * the same staleness profile the full cycle's own cached lookups produce.
 */
async function alertForToken(
  token: { id: string; mintAddress: string; firstSeenAt: Date },
  scored: Parameters<typeof createMatchesForTargets>[0]["scored"],
  activeFilters: FilterWithUser[],
  env: Env,
): Promise<number> {
  // The cooldown is part of "is an alert about to exist", so it is resolved before the write and
  // not after it. Matching alone is not enough: a hot token keeps matching the same filters for
  // hours after their 12-hour cooldown started, and writing on a match meant four snapshots a
  // minute per such token, every one of them unreferenced by any Match.
  const toAlert = await resolveAlertTargets({
    tokenId: token.id,
    tokenFirstSeenAt: token.firstSeenAt,
    scored,
    activeFilters,
    guard: env.MATCH_ALERT_GUARD,
    walletWaitMs: env.FILTER_WALLET_MAX_WAIT_SECONDS * 1000,
  });
  if (toAlert.length === 0) return 0;

  const fullToken = await prisma.token.findUnique({ where: { id: token.id } });
  if (!fullToken) return 0;

  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scored, "fast"),
  });
  noteFreshMarketData([token.id]);
  const created = await createMatchesForTargets({ token: fullToken, snapshot, scored, toAlert, env });
  noteAlertWallets(token.mintAddress, created > 0, scored.emptyTop10WalletPct !== undefined);
  return created;
}
