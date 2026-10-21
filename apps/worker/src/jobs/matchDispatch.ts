import {
  adminWalletSet,
  loadEntitledActiveFilters,
  prisma,
  createLogger,
  matchesFilter,
  alertGuardBlocks,
  notifyMatchesCreated,
  type Env,
  type FilterCriteria,
  type MatchAlertGuardMode,
  type ScoredToken,
  type UserFilter,
  decisionAnchor,
  freshWalletShare,
  FRESH_ANCHOR_LABEL_RULE,
} from "@trenchscanner/core";
import type { Token, TokenSnapshot } from "@prisma/client";
import { carryHolderReadingOntoAlertRow } from "./holderListWrites.js";
import { recordCandidateSample } from "./candidateOutcomeJob.js";
import { curvePathOf } from "./curveTape.js";
import { clearFilterWalletWait, filterWalletWaitOver, linkedPendingFor } from "./walletPriority.js";

const logger = createLogger("match-dispatch");

/** Once a user has been alerted for a token+filter, don't re-alert for it again within this window. */
export const ALERT_COOLDOWN_HOURS = 12;

/**
 * How long after arming (created, switched on, or edited - see UserFilter.armedAt) a filter can
 * at most be settling in: recording what already matches it instead of alerting. Settling ends
 * sooner, when the scan has evaluated the whole in-band watchlist against it once (see
 * markFilterPassComplete): everything that matched the moment the filter was armed has then
 * been seen, and baselined, and a token that starts matching after that pass is news.
 *
 * Without the baseline, applying a filter alerted on every token it matched at once - dozens of
 * "just now" cards and pings for tokens that had been sitting in the watchlist for minutes or
 * hours. Settling used to be the wall clock alone, two minutes: a token that began matching a
 * minute after arming was baselined as backlog and silenced for the cooldown, and a slow cycle
 * that straddled the window alerted on the tail of the backlog after all. The bound here only
 * limits how long a pass that never completes (a worker restart, a cycle that fails) can keep a
 * filter quiet.
 */
export const FILTER_ARM_QUIET_MINUTES = 10;

export type FilterWithUser = UserFilter;

/** Default for resolveAlertTargets' walletWaitMs - the env default of FILTER_WALLET_MAX_WAIT_SECONDS. */
const DEFAULT_WALLET_WAIT_MS = 180_000;

/**
 * Whether this filter puts a ceiling on a wallet figure the token doesn't have yet. matchesFilter
 * lets an unknown figure past a ceiling, which on its own let a token with 80% empty holders
 * through a 60% "Max empty" filter on its first sighting, before its holders had been priced
 * (reported 2026-10-08): resolveAlertTargets holds such a match until the figure lands.
 */
export function awaitsWalletFigure(
  scored: Pick<
    ScoredToken,
    | "freshTop10WalletPct"
    | "emptyTop10WalletPct"
    | "sniperTop10WalletPct"
    | "sniperTopHolderCount"
    | "linkedWalletPct"
    | "linkedWalletCount"
    | "flaggedBuySol"
    | "cexFundedCount"
    | "sameTimeFundedPct"
    | "sameTimeFundedCount"
    | "linkedCreatorPct"
    | "kolBundledPct"
    | "bundledSupplyPct"
    | "transferredSupplyPct"
  >,
  filter: Pick<
    FilterCriteria,
    | "maxFreshTop10WalletPct"
    | "maxEmptyTop10WalletPct"
    | "maxSniperTop10WalletPct"
    | "maxSniperTopHolderCount"
    | "maxLinkedWalletPct"
    | "maxLinkedWalletCount"
    | "maxFlaggedBuySol"
    | "minCexFundedCount"
    | "maxCexFundedCount"
    | "maxSameTimeFundedPct"
    | "maxSameTimeFundedCount"
    | "maxLinkedCreatorPct"
    | "maxKolBundledPct"
    | "maxBundledSupplyPct"
    | "maxTransferredSupplyPct"
  >,
): boolean {
  return (
    (filter.maxFreshTop10WalletPct != null && scored.freshTop10WalletPct === undefined) ||
    (filter.maxEmptyTop10WalletPct != null && scored.emptyTop10WalletPct === undefined) ||
    (filter.maxSniperTop10WalletPct != null && scored.sniperTop10WalletPct === undefined) ||
    (filter.maxSniperTopHolderCount != null && scored.sniperTopHolderCount === undefined) ||
    (filter.maxLinkedWalletPct != null && scored.linkedWalletPct === undefined) ||
    (filter.maxLinkedWalletCount != null && scored.linkedWalletCount === undefined) ||
    (filter.maxFlaggedBuySol != null && scored.flaggedBuySol === undefined) ||
    ((filter.minCexFundedCount != null || filter.maxCexFundedCount != null) &&
      scored.cexFundedCount === undefined) ||
    (filter.maxSameTimeFundedPct != null && scored.sameTimeFundedPct === undefined) ||
    (filter.maxSameTimeFundedCount != null && scored.sameTimeFundedCount === undefined) ||
    (filter.maxLinkedCreatorPct != null && scored.linkedCreatorPct === undefined) ||
    (filter.maxKolBundledPct != null && scored.kolBundledPct === undefined) ||
    (filter.maxBundledSupplyPct != null && scored.bundledSupplyPct === undefined) ||
    (filter.maxTransferredSupplyPct != null && scored.transferredSupplyPct === undefined)
  );
}

/**
 * Whether the safety screen's holder cuts can't have run on this token yet: its fresh-wallet share
 * is unknown, which also means no top-10 holder list was in to read (rugScreen.ts). The screen's
 * wallet cuts pass a figure that isn't measured, so until this lands the token has passed a screen
 * that never looked at its holders. Model calls already wait for it (CURATED_REQUIRE_WALLET_CHECKS);
 * resolveAlertTargets holds every user-filter match for it too, and without a time limit: HEEHAW
 * (2026-10-16) alerted three filters at 3-4 minutes old, before RugCheck had a holder list, and
 * failed the screen two minutes later on 100% fresh and 25 of 25 linked. Over the two days before,
 * 33 of the 77 coins alerted with no holder reading failed the screen within 15 minutes of it.
 */
export function awaitsScreenReading(scored: Parameters<typeof freshWalletShare>[0]): boolean {
  return freshWalletShare(scored) === undefined;
}

/**
 * Per filter, the armedAt the scan has completed a full pass for. Process-local: after a restart
 * a filter armed inside the window above settles for one more pass, which only baselines tokens
 * that match it right then (on cooldown anyway, if they alerted before the restart).
 */
const passCompleteFor = new Map<string, number>();

/**
 * The scan's candidate loop finished with these filters loaded: whatever they matched has been
 * baselined, so from now on they alert. Only the scan calls this - the fast lane evaluates a
 * subset of the watchlist, so its passes don't count.
 */
export function markFilterPassComplete(filters: readonly Pick<UserFilter, "id" | "armedAt">[]): void {
  for (const f of filters) passCompleteFor.set(f.id, f.armedAt.getTime());
  // Bounded: filters that no longer exist drop out as the live set is re-marked every cycle.
  if (passCompleteFor.size > 2 * filters.length + 1_000) {
    const live = new Set(filters.map((f) => f.id));
    for (const id of passCompleteFor.keys()) if (!live.has(id)) passCompleteFor.delete(id);
  }
}

/**
 * The filters the scan and the fast lane match this cycle: active ones whose owner has access
 * (loadEntitledActiveFilters). A filter that has just gained access - its owner subscribed, renewed
 * after a lapse, or was whitelisted - is re-armed (armedAt = now), as the API re-arms a filter
 * switched on: it was skipped while its owner had no access, so everything it matches is backlog,
 * and without this the first pass alerted on all of it at once. Process-local like the passes
 * above: the first load after a restart only records the set.
 */
let entitledFilterIds: Set<string> | null = null;

export async function loadMatchableFilters(env: Env): Promise<FilterWithUser[]> {
  const filters = await loadEntitledActiveFilters(adminWalletSet(env));
  const previous = entitledFilterIds;
  entitledFilterIds = new Set(filters.map((f) => f.id));
  if (!previous) return filters;
  const gained = filters.filter((f) => !previous.has(f.id));
  if (gained.length === 0) return filters;
  const armedAt = new Date();
  await prisma.userFilter.updateMany({ where: { id: { in: gained.map((f) => f.id) } }, data: { armedAt } });
  for (const f of gained) f.armedAt = armedAt;
  return filters;
}

/** Test hook: forget which filters were last loaded, so the next load re-arms none. */
export function resetMatchableFilters(): void {
  entitledFilterIds = null;
}

/** Test hook: forget every completed pass. */
export function resetFilterPasses(): void {
  passCompleteFor.clear();
}

/**
 * Whether this filter is still settling in for this token: armed since the scan's last full pass
 * (and within the quiet bound), and the token is one the watchlist already knew when it was armed.
 * A token first seen after that is news by definition, so it alerts even while settling.
 */
export function isSettling(
  filter: Pick<UserFilter, "id" | "armedAt">,
  tokenFirstSeenAt: Date | undefined,
  now = Date.now(),
): boolean {
  const armedAt = filter.armedAt.getTime();
  if (now - armedAt >= FILTER_ARM_QUIET_MINUTES * 60_000) return false;
  if ((passCompleteFor.get(filter.id) ?? -Infinity) >= armedAt) return false;
  return !(tokenFirstSeenAt && tokenFirstSeenAt.getTime() > armedAt);
}

type Db = Pick<typeof prisma, "$executeRaw" | "filterBaseline">;

/** Records that these filters already matched this token when they were armed - see FilterBaseline. */
async function recordBaselines(db: Db, tokenId: string, filterIds: string[]): Promise<void> {
  if (filterIds.length === 0) return;
  // Joined to UserFilter so a filter deleted since the cycle loaded its list (inside its arming
  // window, the only time it is here) is dropped rather than failing the insert's FK - which, from
  // resolveAlertTargets, failed the whole candidate: every other user's alert on the token, its
  // training sample and its curated contender, for that cycle.
  await db.$executeRaw`
    INSERT INTO "FilterBaseline" ("filterId", "tokenId", "createdAt")
    SELECT u."id", ${tokenId}, now()
    FROM unnest(${filterIds}::text[]) AS f(id)
    JOIN "UserFilter" u ON u."id" = f.id
    ON CONFLICT ("filterId", "tokenId") DO UPDATE SET "createdAt" = EXCLUDED."createdAt"`;
}

/**
 * The (user, filter) pairs on cooldown for this token: alerted inside ALERT_COOLDOWN_HOURS, or
 * baselined inside it (already matching when the filter was armed, so never news).
 */
async function cooldownKeys(
  db: Pick<typeof prisma, "match" | "filterBaseline">,
  tokenId: string,
  filters: FilterWithUser[],
): Promise<Set<string>> {
  const cutoff = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3_600_000);
  const filterIds = filters.map((f) => f.id);
  const [recent, baselined] = await Promise.all([
    db.match.findMany({
      where: { tokenId, matchedAt: { gt: cutoff }, filterId: { in: filterIds } },
      select: { userId: true, filterId: true },
    }),
    db.filterBaseline.findMany({
      where: { tokenId, createdAt: { gt: cutoff }, filterId: { in: filterIds } },
      select: { filterId: true },
    }),
  ]);
  const keys = new Set(recent.map((r) => `${r.userId}:${r.filterId}`));
  const owner = new Map(filters.map((f) => [f.id, f.userId]));
  for (const b of baselined) keys.add(`${owner.get(b.filterId)}:${b.filterId}`);
  return keys;
}

/**
 * Turns one scored token into every alert it owes, for every user whose filter it matches: one
 * query for every cooldown, the match rows created together, then every dashboard NOTIFY.
 */
export async function createMatchesForCandidate(opts: {
  token: Token;
  snapshot: TokenSnapshot;
  scored: ScoredToken;
  activeFilters: FilterWithUser[];
  /** The worker's env: turns on the alert guard (MATCH_ALERT_GUARD) and outcome grading. */
  env?: Env;
}): Promise<number> {
  const { token, snapshot, scored, activeFilters, env } = opts;

  const toAlert = await resolveAlertTargets({
    tokenId: token.id,
    tokenFirstSeenAt: token.firstSeenAt,
    scored,
    activeFilters,
    guard: env?.MATCH_ALERT_GUARD,
    walletWaitMs: env ? env.FILTER_WALLET_MAX_WAIT_SECONDS * 1000 : undefined,
    unknownRiskFails: env?.SAFETY_UNKNOWN_RISK_FAILS,
  });
  if (toAlert.length === 0) return 0;

  return createMatchesForTargets({ token, snapshot, scored, toAlert, env });
}

/**
 * Which filters this token owes an alert to right now: the ones it matches, minus the ones
 * already alerted inside the cooldown.
 *
 * Split out from the creation below so a caller can ask the question BEFORE paying to write a
 * snapshot. The fast match pass needs exactly that: it writes a row only when a match is about
 * to exist, and asking "does it match any filter" without also asking "is that filter on
 * cooldown" had it minting a snapshot every 15 seconds for tokens whose every match was
 * suppressed - four rows a minute per hot token, all of them unreferenced.
 */
export async function resolveAlertTargets(opts: {
  tokenId: string;
  /** When the watchlist first saw the token - a token newer than a filter is never backlog. */
  tokenFirstSeenAt?: Date;
  scored: ScoredToken;
  activeFilters: FilterWithUser[];
  /** MATCH_ALERT_GUARD - see scoring/alertGuard.ts. Omitted means "off". */
  guard?: MatchAlertGuardMode;
  /**
   * FILTER_WALLET_MAX_WAIT_SECONDS in ms: the longest a match is held for a wallet figure its
   * filter puts a ceiling on (see awaitsWalletFigure). Omitted means the env default.
   */
  walletWaitMs?: number;
  /**
   * Whether a token that no longer has a match waiting may drop its wallet-figure hold (default
   * true). The fast lane passes false: it scores on thinner data (no holder-growth baseline, no
   * description), so a filter the scan matched can fail there, and clearing the hold every 15
   * seconds restarted it on each scan - the FILTER_WALLET_MAX_WAIT_SECONDS bound never ran out.
   */
  clearWalletWait?: boolean;
  /** SAFETY_UNKNOWN_RISK_FAILS. Omitted means off: an unknown risk ceiling still passes. */
  unknownRiskFails?: boolean;
}): Promise<FilterWithUser[]> {
  const { tokenId, scored, activeFilters } = opts;
  const clearWait = () => {
    if (opts.clearWalletWait !== false) clearFilterWalletWait(scored.mintAddress);
  };

  const allMatching = activeFilters.filter((filter) =>
    matchesFilter(scored, filter, { unknownFails: opts.unknownRiskFails }),
  );
  if (allMatching.length === 0) {
    clearWait();
    return [];
  }

  // A filter that was only just armed records what already matches it instead of alerting on it.
  // Before the guard on purpose: a token held back for flushing was still already matching.
  const now = Date.now();
  const settling = allMatching.filter((f) => isSettling(f, opts.tokenFirstSeenAt, now));
  await recordBaselines(
    prisma,
    tokenId,
    settling.map((f) => f.id),
  );
  const settled = allMatching.filter((f) => !settling.includes(f));
  if (settled.length === 0) return [];

  // A match whose filter caps a wallet figure that isn't in yet waits for it, up to walletWaitMs:
  // the next scan with the figure decides it for real. Held, like the guard below, without
  // starting the cooldown. The other filters on the token alert now. Every filter waits for a
  // linked-wallets reading the scan left for later (see holdForLinked): the safety screen cuts on it.
  // And every filter waits for the screen's own holder reading (awaitsScreenReading), past
  // walletWaitMs too: a match that went out before it was a token the screen had not checked.
  const screenPending = awaitsScreenReading(scored);
  const linkedPending = linkedPendingFor(scored.mintAddress);
  const waiting = settled.filter((f) => screenPending || linkedPending || awaitsWalletFigure(scored, f));
  let matching = settled;
  if (waiting.length === 0) {
    clearWait();
  } else {
    // Called either way: the first call starts the hold, which puts the token's wallet lookups
    // next in line after the contenders' (alertAwaitingWallets).
    const waitOver = filterWalletWaitOver(
      scored.mintAddress,
      opts.walletWaitMs ?? DEFAULT_WALLET_WAIT_MS,
      now,
    );
    if (screenPending) return [];
    if (!waitOver) matching = settled.filter((f) => !waiting.includes(f));
  }
  if (matching.length === 0) return [];

  // Before the cooldown read, and returning nothing rather than a reason: a held-back match must
  // not start the cooldown, so the token can still be alerted the moment it stops collapsing. The
  // curve's reading is taken now, not at scoring: it is seconds old, and a collapse is fast.
  const guarded = { ...scored, curvePath: curvePathOf(scored.mintAddress) };
  if (alertGuardBlocks(guarded, opts.guard ?? "off") !== null) return [];

  // One round trip for every cooldown on this token, instead of one per matching filter. The
  // cooldown is per (user, filter, token), so the pair is what has to be compared - two of a
  // user's filters both catching this token are two separate alerts by design.
  const onCooldown = await cooldownKeys(prisma, tokenId, matching);
  return matching.filter((f) => !onCooldown.has(`${f.userId}:${f.id}`));
}

/**
 * Creates the match rows for targets already resolved above, then pushes every dashboard.
 *
 * `resolveAlertTargets` reads and this writes, so the cooldown is re-checked here under a
 * per-token advisory lock rather than trusted from the caller - see the note inside.
 */
export async function createMatchesForTargets(opts: {
  token: Token;
  snapshot: TokenSnapshot;
  scored: ScoredToken;
  toAlert: FilterWithUser[];
  /** When given, the alert is graded on the curated verdict - see anchorMatchOutcome. */
  env?: Env;
}): Promise<number> {
  const { token, snapshot, scored, toAlert, env } = opts;
  if (toAlert.length === 0) return 0;

  // The cooldown is re-checked here, inside a lock, rather than trusted from the caller.
  //
  // Two lanes create matches - the minutely scan cycle and the 15-second fast pass - and a token
  // becoming matchable between full cycles is precisely what the fast lane exists for, so the
  // two evaluating the same token at the same moment is the expected case, not a rare one. Both
  // would read an empty cooldown set in the few milliseconds before either inserted, and both
  // would insert: two cards and two SSE nudges for one event.
  //
  // A per-token advisory lock serializes just those two attempts. It is transaction-scoped, so
  // it releases on commit or rollback with no cleanup path to get wrong, and it is taken on the
  // token rather than per (user, filter) pair because both lanes contend over exactly one token
  // at a time - one lock instead of a dozen.
  const created = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${token.id}))`;

      const onCooldown = await cooldownKeys(tx, token.id, toAlert);
      // The callers' filter list was read at the start of their cycle. A filter deleted since
      // would fail its insert on the foreign key and roll back every other user's alert for this
      // token with it; one switched off since would still alert, and one edited or switched on
      // again since is settling in again (see isSettling). Only filters still active now, as
      // they are now.
      const current = await tx.userFilter.findMany({
        where: { id: { in: toAlert.map((f) => f.id) }, isActive: true },
        select: { id: true, armedAt: true },
      });
      const now = Date.now();
      const resettling = current.filter((f) => isSettling(f, token.firstSeenAt, now)).map((f) => f.id);
      await recordBaselines(tx, token.id, resettling);
      const stillActive = new Set(current.filter((f) => !resettling.includes(f.id)).map((f) => f.id));
      const confirmed = toAlert.filter(
        (f) => stillActive.has(f.id) && !onCooldown.has(`${f.userId}:${f.id}`),
      );

      // One multi-row insert: a hot token can catch hundreds of users' filters at once, and
      // inserting them one by one held this token's lock (and a pooled connection) for as many
      // round trips, against the 15s body timeout below.
      if (confirmed.length === 0) return [];
      // The row these matches point at is read on its own by the feed, so it carries the holder
      // reading the scan may have left off as unchanged (holderListWrites.ts).
      if (snapshot.linkedHolders === null) await carryHolderReadingOntoAlertRow(tx, snapshot.id, scored);
      // Priced from a fresh quote when the scan read one, as the alert's grading row is (see
      // anchorMatchOutcome): its Alert figure and peaks then count from that price, not from the
      // snapshot's DexScreener one, which runs 45-60 s behind.
      const anchor = decisionAnchor(scored);
      const alertMcapUsd = anchor.labelRule === FRESH_ANCHOR_LABEL_RULE ? anchor.marketCapUsd : null;
      return tx.match.createManyAndReturn({
        data: confirmed.map((filter) => ({
          userId: filter.userId,
          filterId: filter.id,
          tokenId: token.id,
          snapshotId: snapshot.id,
          score: scored.score.total,
          alertMcapUsd,
          deliveredDashboard: true,
        })),
      });
    },
    // Prisma's default is to give up after 2s waiting for a connection. This runs while the scan's
    // candidate fan-out holds most of the worker's pool, and a timeout here drops the alert until
    // the next cycle - the one write in the worker that is worth waiting for.
    // ...and, once it has a connection, long enough to finish: the default 5s body timeout
    // aborted the whole alert when the inserts queued behind the candidate fan-out.
    { maxWait: 10_000, timeout: 15_000 },
  );
  if (created.length === 0) return 0;

  // Whoever actually got a row is who gets pushed to - the lock above may have dropped filters
  // the other lane alerted first, and notifying for those would be a nudge with nothing behind it.
  const alerted = created.map((match) => {
    const filter = toAlert.find((f) => f.id === match.filterId && f.userId === match.userId)!;
    return { match, filter };
  });

  // After the creates, never before: the row has to exist by the time a client acts on the
  // notification. It swallows its own errors - the match is already committed, and the
  // client's fallback poll covers a missed nudge.
  await notifyMatchesCreated(
    alerted.map(({ match, filter }) => ({ userId: filter.userId, matchId: match.id })),
  );

  if (env) {
    await anchorMatchOutcome(
      token.id,
      scored,
      env,
      created.map((m) => m.id),
    );
  }
  return created.length;
}

/**
 * Grades these alerts the way curated alerts are graded: a "match" CandidateOutcome row anchored
 * now, at the price the alert was raised on, which the candidate watcher grades from, watches through the 30-minute goal
 * window, and closes with the 2x-in-15-minutes / 4x-in-30 / 50%-stop verdict - copied onto these Match rows (candidateOutcomeJob.ts). That
 * is what lets a filter's track record be stated in the same terms as the curated feed's.
 *
 * Never worth failing the alert over: the match is committed and delivered by now.
 */
async function anchorMatchOutcome(tokenId: string, scored: ScoredToken, env: Env, matchIds: string[]) {
  try {
    const sample = await recordCandidateSample(tokenId, scored, env, { kind: "match" });
    if (!sample) return;
    await prisma.match.updateMany({
      where: { id: { in: matchIds } },
      data: { candidateOutcomeId: sample.id },
    });
  } catch (err) {
    logger.warn("failed to anchor match outcome", { tokenId, error: String(err) });
  }
}
