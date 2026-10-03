import {
  prisma,
  createLogger,
  matchesFilter,
  alertGuardBlocks,
  notifyMatchCreated,
  type Env,
  type MatchAlertGuardMode,
  type ScoredToken,
  type UserFilter,
} from "@trenchscanner/core";
import type { Token, TokenSnapshot } from "@prisma/client";
import { recordCandidateSample } from "./candidateOutcomeJob.js";

const logger = createLogger("match-dispatch");

/** Once a user has been alerted for a token+filter, don't re-alert for it again within this window. */
export const ALERT_COOLDOWN_HOURS = 12;

export type FilterWithUser = UserFilter;

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
    scored,
    activeFilters,
    guard: env?.MATCH_ALERT_GUARD,
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
  scored: ScoredToken;
  activeFilters: FilterWithUser[];
  /** MATCH_ALERT_GUARD - see scoring/alertGuard.ts. Omitted means "off". */
  guard?: MatchAlertGuardMode;
}): Promise<FilterWithUser[]> {
  const { tokenId, scored, activeFilters } = opts;

  const matching = activeFilters.filter((filter) => matchesFilter(scored, filter));
  if (matching.length === 0) return [];

  // Before the cooldown read, and returning nothing rather than a reason: a held-back match must
  // not start the cooldown, so the token can still be alerted the moment it stops flushing.
  if (alertGuardBlocks(scored, opts.guard ?? "off") !== null) return [];

  // One round trip for every cooldown on this token, instead of one per matching filter. The
  // cooldown is per (user, filter, token), so the pair is what has to be compared - two of a
  // user's filters both catching this token are two separate alerts by design.
  const cooldownCutoff = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3_600_000);
  const recent = await prisma.match.findMany({
    where: {
      tokenId,
      matchedAt: { gt: cooldownCutoff },
      filterId: { in: matching.map((f) => f.id) },
    },
    select: { userId: true, filterId: true },
  });
  const onCooldown = new Set(recent.map((r) => `${r.userId}:${r.filterId}`));
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
  const cooldownCutoff = new Date(Date.now() - ALERT_COOLDOWN_HOURS * 3_600_000);
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${token.id}))`;

    const recent = await tx.match.findMany({
      where: {
        tokenId: token.id,
        matchedAt: { gt: cooldownCutoff },
        filterId: { in: toAlert.map((f) => f.id) },
      },
      select: { userId: true, filterId: true },
    });
    const onCooldown = new Set(recent.map((r) => `${r.userId}:${r.filterId}`));
    const confirmed = toAlert.filter((f) => !onCooldown.has(`${f.userId}:${f.id}`));

    const rows = [];
    for (const filter of confirmed) {
      rows.push(
        await tx.match.create({
          data: {
            userId: filter.userId,
            filterId: filter.id,
            tokenId: token.id,
            snapshotId: snapshot.id,
            score: scored.score.total,
            deliveredDashboard: true,
          },
        }),
      );
    }
    return rows;
  });
  if (created.length === 0) return 0;

  // Whoever actually got a row is who gets pushed to - the lock above may have dropped filters
  // the other lane alerted first, and notifying for those would be a nudge with nothing behind it.
  const alerted = created.map((match) => {
    const filter = toAlert.find((f) => f.id === match.filterId && f.userId === match.userId)!;
    return { match, filter };
  });

  // After the creates, never before: the row has to exist by the time a client acts on the
  // notification. Each swallows its own errors - the match is already committed, and the
  // client's fallback poll covers a missed nudge.
  await Promise.all(
    alerted.map(({ match, filter }) => notifyMatchCreated({ userId: filter.userId, matchId: match.id })),
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
 * now, at the price the alert was raised on, which the candidate watcher fills (first price at
 * least CANDIDATE_ENTRY_DELAY_SECONDS later, plus slippage), watches for an hour, and closes with
 * the 2x / 4x / 50%-stop verdict - copied onto these Match rows (candidateOutcomeJob.ts). That
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
