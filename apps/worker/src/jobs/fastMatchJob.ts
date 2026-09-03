import {
  prisma,
  createLogger,
  buildScoredToken,
  type Env,
  type DexScreenerClient,
  type OnChainProfile,
} from "@trenchscanner/core";
import type { AlertBot } from "../telegram/bot.js";
import { createMatchesForTargets, resolveAlertTargets, type FilterWithUser } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";

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
  };
}

export async function runFastMatchCycle(
  dexScreener: DexScreenerClient,
  env: Env,
  bot: AlertBot,
): Promise<void> {
  const startedAt = Date.now();

  // Nothing to be fast about if nobody is filtering. Checked first because it is the cheapest
  // question and it short-circuits the whole pass on a deployment with no active users.
  const activeFilters = (await prisma.userFilter.findMany({
    where: { isActive: true },
    include: { user: { select: { id: true, telegramLink: true } } },
  })) as FilterWithUser[];
  if (activeFilters.length === 0) return;

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
  const recent = await prisma.tokenSnapshot.findMany({
    where: { takenAt: { gt: vettedSince }, source: "scan" },
    orderBy: { takenAt: "desc" },
    distinct: ["tokenId"],
    take: MAX_TRACKED,
    include: { token: true },
  });
  const vetted = recent.filter((snapshot) => snapshot.rugScreenPassed);
  if (vetted.length === 0) return;

  const byMint = new Map(vetted.map((s) => [s.token.mintAddress, s]));
  let fresh;
  try {
    fresh = await dexScreener.getTokensByAddresses([...byMint.keys()]);
  } catch (err) {
    // The full cycle is still running underneath this; a failed fast pass costs latency, never
    // an alert.
    logger.warn("fast match price fetch failed", { error: String(err) });
    return;
  }

  let matched = 0;
  let evaluated = 0;
  for (const candidate of fresh) {
    const snapshot = byMint.get(candidate.mintAddress);
    if (!snapshot) continue;

    const onChain = profileFromSnapshot(candidate.mintAddress, snapshot);
    if (!onChain) continue;

    const scored = buildScoredToken(candidate, onChain, {
      createdAt: candidate.pairCreatedAt ?? snapshot.token.firstSeenAt,
      // Holder growth needs a baseline the full cycle owns; leaving it unset records "not
      // measured" rather than a fabricated 0, and matchesFilter treats an unknown growth as
      // failing a minHolderGrowthPct filter - so this pass can never alert on a criterion it
      // did not actually evaluate.
    });
    evaluated += 1;
    if (!scored.rugScreen.passed) continue;

    try {
      matched += await alertForToken(snapshot.token, scored, activeFilters, bot);
    } catch (err) {
      logger.warn("fast match failed for token", { mint: candidate.mintAddress, error: String(err) });
    }
  }

  if (matched > 0) {
    logger.info("fast match pass alerted", {
      durationMs: Date.now() - startedAt,
      tracked: byMint.size,
      evaluated,
      matches: matched,
    });
  }
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
  token: { id: string; mintAddress: string },
  scored: Parameters<typeof createMatchesForTargets>[0]["scored"],
  activeFilters: FilterWithUser[],
  bot: AlertBot,
): Promise<number> {
  // The cooldown is part of "is an alert about to exist", so it is resolved before the write and
  // not after it. Matching alone is not enough: a hot token keeps matching the same filters for
  // hours after their 12-hour cooldown started, and writing on a match meant four snapshots a
  // minute per such token, every one of them unreferenced by any Match.
  const toAlert = await resolveAlertTargets({ tokenId: token.id, scored, activeFilters });
  if (toAlert.length === 0) return 0;

  const fullToken = await prisma.token.findUnique({ where: { id: token.id } });
  if (!fullToken) return 0;

  const snapshot = await prisma.tokenSnapshot.create({
    data: snapshotDataFor(token.id, scored, "fast"),
  });
  return createMatchesForTargets({ token: fullToken, snapshot, scored, toAlert, bot });
}
