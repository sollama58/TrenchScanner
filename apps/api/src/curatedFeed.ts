import type { Prisma, TokenSnapshot } from "@prisma/client";
import {
  prisma,
  WIN_WINDOW_MINUTES,
  GOAL_WINDOW_MINUTES,
  TEN_X_WINDOW_MINUTES,
  GOAL_MULTIPLE,
  tenXVerdict,
  hit2xInWinWindow,
  disqualifiedByDrawdown,
  cleanPeakPriceUsd,
  contestantSpec,
} from "@trenchscanner/core";

/**
 * Turning a CuratedAlert into a feed card.
 *
 * The Curated tab and the Live Feed show the same card, because a curated alert IS an alert -
 * the only difference is who picked it. That means a curated alert has to serialize into the
 * exact shape a Match does (alert-time snapshot, latest snapshot, reconciled "now" market cap,
 * peak-since-alert), plus a `curated` block carrying who called it and how the call is going.
 *
 * Keeping this in one place rather than in each route is what stops the two feeds drifting into
 * showing different numbers for the same alert.
 */

/**
 * Attaches each row's token's newest snapshot as `token.snapshots` (zero or one element).
 *
 * Not a nested `snapshots: { orderBy, take: 1 }` include: for a list of parents Prisma sends that
 * as one `WHERE "tokenId" IN (...) ORDER BY "takenAt" DESC` with NO limit and applies the
 * take-1 per parent in memory - so every feed page pulled every snapshot of every token on it
 * (up to ~1,400 a day per token, 30 days kept) out of the largest table in the database, on
 * every poll. This asks for one row per token through the (tokenId, takenAt) index instead.
 */
export async function withLatestSnapshots<T extends { token: { id: string } }>(
  rows: T[],
  // A caller that already knows the page's tokens can start this lookup alongside its own row
  // load and pass the result in, instead of waiting for the rows first.
  latest?: Promise<Map<string, TokenSnapshot>>,
): Promise<(T & { token: T["token"] & { snapshots: TokenSnapshot[] } })[]> {
  const byToken = await (latest ?? latestSnapshotsByToken(rows.map((r) => r.token.id)));
  return rows.map((r) => {
    const snapshot = byToken.get(r.token.id);
    return { ...r, token: { ...r.token, snapshots: snapshot ? [snapshot] : [] } };
  });
}

/**
 * Each token's newest snapshot, in one statement: one index probe per token through
 * (tokenId, takenAt), returning the whole row. This was two round trips - the ids first, then
 * the rows by id - and a feed page runs it once per half (matches and curated calls).
 */
export async function latestSnapshotsByToken(
  tokenIds: readonly string[],
): Promise<Map<string, TokenSnapshot>> {
  const ids = [...new Set(tokenIds)];
  if (ids.length === 0) return new Map();
  const snapshots = await prisma.$queryRaw<TokenSnapshot[]>`
    SELECT s.*
    FROM unnest(${ids}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT * FROM "TokenSnapshot" WHERE "tokenId" = t.id ORDER BY "takenAt" DESC LIMIT 1
    ) s`;
  return new Map(snapshots.map((s) => [s.tokenId, s]));
}

/**
 * The token columns a card carries: everything but the AI text read (aiTextScores), which is a
 * model input the worker keeps on the row, not something any card shows - every card on every
 * poll was shipping it.
 */
export const TOKEN_CARD_SELECT = {
  id: true,
  mintAddress: true,
  symbol: true,
  name: true,
  pairAddress: true,
  imageUrl: true,
  firstSeenAt: true,
  hasTwitter: true,
  hasTelegram: true,
  hasWebsite: true,
  narrativeTags: true,
  description: true,
  discoverySource: true,
  dexBoosted: true,
  firstInBandAt: true,
  lastViewedAt: true,
  liveMarketCapUsd: true,
  livePriceUsd: true,
  liveDataAt: true,
  lastLiveAt: true,
  lastMcapUsd: true,
} satisfies Prisma.TokenSelect;

/** Everything a curated card needs, in one Prisma include - plus withLatestSnapshots. */
export const curatedAlertInclude = {
  token: { select: TOKEN_CARD_SELECT },
  snapshot: true,
  candidateOutcome: {
    select: {
      anchorAt: true,
      anchorPriceUsd: true,
      peak1hPriceUsd: true,
      low1hPriceUsd: true,
      lowBefore2xPriceUsd: true,
      peak24hPriceUsd: true,
      peak24hAt: true,
      peakBeforeStopPriceUsd: true,
      peakBeforeStop60mPriceUsd: true,
      stopped60mAt: true,
      hit2xAt: true,
      finalizedAt: true,
      finalized24hAt: true,
      peak1hReturnPct: true,
      maxDrawdown1hPct: true,
      hit2xIn15m: true,
      hit2xIn1h: true,
      hit4xIn1h: true,
      hit10xIn1h: true,
      disqualified: true,
      peak24hReturnPct: true,
      runPeakMinutes: true,
    },
  },
} satisfies Prisma.CuratedAlertInclude;

export type CuratedAlertWithRelations = Awaited<
  ReturnType<
    typeof withLatestSnapshots<Prisma.CuratedAlertGetPayload<{ include: typeof curatedAlertInclude }>>
  >
>[number];

/** How one curated call is going / went, resolved from the freshest source available. */
export interface OutcomeView {
  /**
   * watching: the 15-minute win window is still open. won/missed/disqualified: the verdict.
   * unknown: the training row was pruned before its copies landed - surfaced honestly rather
   * than guessed at.
   */
  status: "watching" | "won" | "missed" | "disqualified" | "unknown";
  /** True the moment a 2x is observed inside the win window - the badge flips right then. */
  hit2x: boolean;
  /** Whether the run went on to clear the 4x goal within 30 minutes. Null until it's knowable. */
  hitGoal: boolean | null;
  /**
   * The third tier: whether the run reached 10x within an hour, before the stop. Null until it's
   * knowable, and on calls from before the tier existed (they never tracked it).
   */
  hitTenX: boolean | null;
  /** Final once the goal window closes; the running peak-so-far before that. */
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  /** The run peak: keeps climbing for winners until their 24h watch ends. */
  peak24hReturnPct: number | null;
  /** Minutes from the alert to the run peak so far; null until it has traded above the alert price. */
  runPeakMinutes: number | null;
  /** The 24h book is closed - every number above is final. */
  finalized: boolean;
  /** Minutes left in the WIN window, for the countdown badge. Null once it has closed. */
  minutesLeft: number | null;
}

type OutcomeSources = Pick<
  CuratedAlertWithRelations,
  | "createdAt"
  | "peak1hReturnPct"
  | "maxDrawdown1hPct"
  | "hit2xIn15m"
  | "hit2xIn1h"
  | "hit4xIn1h"
  | "hit10xIn1h"
  | "disqualified"
  | "peak24hReturnPct"
  | "runPeakMinutes"
  | "outcomeFinalizedAt"
> & { candidateOutcome: CuratedAlertWithRelations["candidateOutcome"] };

/**
 * Resolves an alert's outcome from the freshest source available: the live CandidateOutcome link
 * while it exists (updated every watcher tick), the columns copied onto the alert after the
 * training row has been pruned.
 *
 * The verdict lands when the 15-minute win window closes; hit2x flips the moment a 2x is observed
 * inside it, so the badge can show the win before the window is up. The 4x goal settles when the
 * 30-minute goal window closes.
 */
export function resolveOutcome(alert: OutcomeSources): OutcomeView {
  const live = alert.candidateOutcome;
  const pctFrom = (price: number, anchor: number) => ((price - anchor) / anchor) * 100;

  const peaks = {
    peak1hReturnPct: live ? pctFrom(live.peak1hPriceUsd, live.anchorPriceUsd) : alert.peak1hReturnPct,
    maxDrawdown1hPct: live ? pctFrom(live.low1hPriceUsd, live.anchorPriceUsd) : alert.maxDrawdown1hPct,
    peak24hReturnPct:
      alert.peak24hReturnPct ??
      live?.peak24hReturnPct ??
      (live ? pctFrom(live.peak24hPriceUsd, live.anchorPriceUsd) : null),
    runPeakMinutes:
      alert.runPeakMinutes ??
      live?.runPeakMinutes ??
      (live?.peak24hAt ? (live.peak24hAt.getTime() - live.anchorAt.getTime()) / 60_000 : null),
  };

  // The stored verdict, from whichever source has it. hit2xIn1h is THE bar (2x within 15 minutes
  // since 2026-10-05; the name predates it), and every graded row carries it - the migration
  // re-graded older rows under the current windows.
  const stored =
    live?.finalizedAt != null
      ? {
          won: live.hit2xIn1h,
          disqualified: live.disqualified,
          hitGoal: live.hit4xIn1h,
          hitTenX: live.hit10xIn1h ?? alert.hit10xIn1h,
        }
      : alert.hit2xIn1h != null
        ? {
            won: alert.hit2xIn1h,
            disqualified: alert.disqualified,
            hitGoal: alert.hit4xIn1h,
            hitTenX: alert.hit10xIn1h,
          }
        : null;

  // The 10x tier settles up to an hour after the alert - past the 4x - so a clean winner's row can
  // carry its 2x/4x verdict while the 10x is still open; that part is read off the live aggregates.
  // The same rule the watcher applies (tenXVerdict), for a clean win.
  const tenXOf = (storedTenX: boolean | null): boolean | null => {
    if (storedTenX !== null || !live) return storedTenX;
    const hourClosed = Date.now() - live.anchorAt.getTime() >= TEN_X_WINDOW_MINUTES * 60_000;
    return tenXVerdict(live, true, hourClosed);
  };

  if (stored) {
    return {
      status: stored.disqualified ? "disqualified" : stored.won ? "won" : "missed",
      hit2x: stored.won === true,
      hitGoal: stored.hitGoal,
      hitTenX: stored.won === true && !stored.disqualified ? tenXOf(stored.hitTenX) : false,
      ...peaks,
      finalized: alert.outcomeFinalizedAt != null,
      minutesLeft: null,
    };
  }

  // The row closed with no verdict: no price was ever seen inside the win window (the worker was
  // down, or the mint had no price), so nothing was measured - the watcher retires such a row
  // ungraded and stamps only the closing time on the alert. Not a miss: the unmoved aggregates
  // below would read as one, and the hit-rate report leaves these out of pending and graded alike.
  const ungraded = live
    ? live.finalized24hAt != null && live.finalizedAt == null
    : alert.outcomeFinalizedAt != null;
  if (ungraded) {
    return {
      status: "unknown",
      hit2x: false,
      hitGoal: null,
      hitTenX: null,
      peak1hReturnPct: null,
      maxDrawdown1hPct: null,
      peak24hReturnPct: null,
      runPeakMinutes: null,
      finalized: true,
      minutesLeft: null,
    };
  }

  if (live) {
    // Everything below is derived from the live aggregates rather than waiting on the row to
    // finalize - same rules the watcher will apply, just applied now.
    const hit2x = hit2xInWinWindow(live);
    // Held to the same stop as the 2x - a run that breached -50% first stopped its buyer out.
    // Judged on the peak before the stop, as the watcher does (see cleanPeakPriceUsd).
    const hitGoal =
      hit2x &&
      !disqualifiedByDrawdown(live) &&
      cleanPeakPriceUsd(live) >= live.anchorPriceUsd * GOAL_MULTIPLE;
    const elapsedMin = (Date.now() - live.anchorAt.getTime()) / 60_000;
    // Only a clean win can reach the tier - the peak alone would credit a stopped-out run.
    const tenX = hit2x && !disqualifiedByDrawdown(live) ? tenXOf(null) : null;

    if (elapsedMin >= WIN_WINDOW_MINUTES) {
      const disqualified = hit2x && disqualifiedByDrawdown(live);
      return {
        status: disqualified ? "disqualified" : hit2x ? "won" : "missed",
        hit2x,
        hitGoal: hitGoal ? true : elapsedMin >= GOAL_WINDOW_MINUTES ? false : null,
        hitTenX:
          live.peakBeforeStop60mPriceUsd == null
            ? null
            : !hit2x || disqualified
              ? false
              : (tenX ?? (elapsedMin >= TEN_X_WINDOW_MINUTES ? false : null)),
        ...peaks,
        finalized: false,
        minutesLeft: null,
      };
    }

    // Derived from the anchor rather than sent as a countdown the client has to keep in step -
    // the card renders it once and ticks it locally.
    return {
      status: "watching",
      hit2x,
      hitGoal: hitGoal ? true : null,
      hitTenX: tenX,
      ...peaks,
      finalized: false,
      minutesLeft: Math.max(0, Math.round(WIN_WINDOW_MINUTES - elapsedMin)),
    };
  }

  return {
    status: "unknown",
    hit2x: false,
    hitGoal: null,
    hitTenX: null,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    peak24hReturnPct: null,
    runPeakMinutes: null,
    finalized: false,
    minutesLeft: null,
  };
}

/** The `curated` block both feeds attach to a card the curator picked. */
export function curatedMeta(alert: CuratedAlertWithRelations) {
  return {
    alertId: alert.id,
    /** "heuristic-v1", or the id of the trained model that emitted it. */
    source: alert.source,
    /**
     * The contestant whose call this is (curation/contestants.ts), with the name it held when it
     * made the call (seats evolve - see CuratorLane); rows from before names were stored fall
     * back to the seat's founding name.
     */
    model: alert.model,
    modelName: alert.modelName ?? (alert.model ? (contestantSpec(alert.model)?.name ?? alert.model) : null),
    confidence: alert.confidence,
    /** "high" for a high-conviction call, "standard" otherwise, null on rules calls and older rows. */
    tier: alert.tier,
    /** The 2x rate of recent out-of-sample calls ranked like this one at emission, in percent. */
    calibratedPct: alert.calibratedPct,
    // An "AI: ..." line was how a gate-mode reviewer's reasoning reached public cards; that is now
    // admin-only (see attachAiReviewsForAdmin), so any such line already stored is held back too.
    reasons: alert.reasons.filter((r) => !r.startsWith("AI: ")),
    alertedAt: alert.createdAt,
    outcome: resolveOutcome(alert),
  };
}

/**
 * A curated alert as a feed card, structurally identical to a serialized Match.
 *
 * Deliberately Match-shaped rather than a new response type: both feeds render the same
 * component, and during a deploy where the API is ahead of the bundle an older client renders
 * these as ordinary cards instead of breaking on an unknown shape.
 *
 * `snapshot` prefers the real scan snapshot this alert was emitted from. Once that snapshot ages
 * past the retention horizon (the alert outlives it - see CuratedAlert.snapshotId) the card
 * falls back to a minimal one synthesized from the anchor figures: the market cap and price are
 * exactly right, and every field the scan would have filled reads null rather than zero, because
 * "we no longer hold that detail" is not the same as "it was nothing".
 */
export function serializeCuratedAlert(
  alert: CuratedAlertWithRelations,
  currentMarketCap: (
    token: { liveMarketCapUsd: number | null; liveDataAt: Date | null },
    latestSnapshot: { marketCapUsd: number; takenAt: Date } | null,
  ) => { marketCapUsd: number | null; at: Date | null },
) {
  const { snapshots, ...token } = alert.token;
  const latestSnapshot = snapshots[0] ?? null;
  const current = currentMarketCap(token, latestSnapshot);
  const outcome = resolveOutcome(alert);

  const snapshot = alert.snapshot ?? {
    id: `${alert.id}-anchor`,
    tokenId: alert.tokenId,
    takenAt: alert.createdAt,
    priceUsd: alert.anchorPriceUsd,
    marketCapUsd: alert.anchorMcapUsd,
    liquidityUsd: null,
    volume24hUsd: null,
    volume5mUsd: null,
    volume1hUsd: null,
    volumeToMcapRatio: null,
    buys24h: null,
    sells24h: null,
    holderCount: null,
    holderGrowthPct: null,
    top10HolderPct: null,
    devWalletPct: null,
    riskScore: null,
    riskFlags: [],
    freshTop10WalletPct: null,
    emptyTop10WalletPct: null,
    firstBuyersHolding: null,
    firstBuyersSeen: null,
    devHolding: null,
    isMayhemMode: null,
    graduated: null,
    mintAuthorityActive: null,
    freezeAuthorityActive: null,
    lpBurned: null,
    ageMinutes: null,
    // The token's composite score is a scan figure this synthesized snapshot doesn't hold (the
    // card shows it under "Score"); the model's own confidence is on `curated`.
    score: null,
    scoreMomentum: null,
    scoreHolderHealth: null,
    scoreAge: null,
    scoreNarrative: null,
    rugScreenPassed: true,
    rugScreenReasons: [],
  };

  // The peak the card's ATH section shows. Derived from the outcome watcher's peak rather than
  // the Match peak job (which only tracks matches): supply is fixed for these tokens, so a price
  // multiple IS a market cap multiple. Null until it has actually traded above the alert.
  const peakPct = outcome.peak24hReturnPct;
  const peakMcapUsd = peakPct !== null && peakPct > 0 ? alert.anchorMcapUsd * (1 + peakPct / 100) : null;

  return {
    id: alert.id,
    kind: "curated" as const,
    userId: "",
    filterId: "",
    tokenId: alert.tokenId,
    snapshotId: snapshot.id,
    matchedAt: alert.createdAt,
    score: alert.confidence,
    deliveredDashboard: true,
    peakMcapUsd,
    peakMcapAt: null,
    peakReturnPct: peakMcapUsd !== null ? peakPct : null,
    hitHundredPctAt: null,
    token,
    snapshot,
    latestSnapshot,
    currentMarketCapUsd: current.marketCapUsd,
    currentMarketCapAt: current.at,
    filter: { id: "curated", name: "Curated" },
    curated: curatedMeta(alert),
  };
}

/**
 * Folds a curated card into a match card for the same token when both landed on the same page.
 *
 * A curated alert and one of this user's own matches this close together are the same event seen
 * twice - their filter caught it and the curator picked it - so the page shows one card wearing
 * both facts rather than two cards for one token.
 *
 * Deliberately page-local: it runs on the cards already sliced for this page, so a card's badge
 * never depends on how deep the feed was fetched to build it. Linking against the whole fetched
 * window instead made the same card show its curated flag on one page and not on another, purely
 * because the two pages fetch different amounts of history.
 *
 * Each match absorbs at most one alert, so a token alerted twice still yields two cards.
 */
export function foldCuratedIntoPage<
  T extends {
    id: string;
    kind: "match" | "curated";
    tokenId: string;
    matchedAt: Date;
    curated: { alertId: string } | null;
  },
>(cards: T[], windowMs: number): T[] {
  const absorbed = new Set<string>();
  // Keyed by the match card's own id, not tokenId + timestamp. Two of a user's filters catching
  // the same token in one scan cycle produce two Match rows whose matchedAt can be identical to
  // the millisecond - so that composite key was not unique, and the map lookup below then
  // stamped the curated badge onto BOTH cards while the standalone curated card was removed:
  // one alert rendered as two curated-badged cards, against the documented one-absorption rule.
  const folded = new Map<string, T["curated"]>();
  // Candidate twins by token, in page order: a page is twelve cards, but the Live tiles fold a
  // whole day's feed (thousands of cards) through here too, where a scan per alert was quadratic.
  const matchesByToken = new Map<string, T[]>();
  for (const card of cards) {
    if (card.kind !== "match" || card.curated !== null) continue;
    const list = matchesByToken.get(card.tokenId);
    if (list) list.push(card);
    else matchesByToken.set(card.tokenId, [card]);
  }

  for (const card of cards) {
    if (card.kind !== "curated" || !card.curated) continue;
    const twin = matchesByToken
      .get(card.tokenId)
      ?.find(
        (m) => !folded.has(m.id) && Math.abs(m.matchedAt.getTime() - card.matchedAt.getTime()) <= windowMs,
      );
    if (!twin) continue;
    folded.set(twin.id, card.curated);
    absorbed.add(card.curated.alertId);
  }

  return cards
    .filter((c) => !(c.kind === "curated" && c.curated && absorbed.has(c.curated.alertId)))
    .map((c) => {
      const meta = folded.get(c.id);
      return meta && c.kind === "match" ? { ...c, curated: meta } : c;
    });
}

/** One model's call on a token, as listed on a card several models called. */
export interface ModelCall {
  model: string | null;
  modelName: string | null;
  confidence: number;
  tier: string | null;
  calibratedPct: number | null;
  alertedAt: Date;
}

/** Calls on one token collapsed into one card. */
export interface CallGroup<T> {
  /** The first call: the card shows it (that is when the token was alerted, and its alert price). */
  lead: T;
  /** The latest call: where the card sits in the feed. */
  newest: T;
  /** Every model that called it, first call first. */
  calls: ModelCall[];
}

/**
 * Collapses calls on the same token by different models into one entry, so a reader following
 * several models sees a token once however many of them called it.
 *
 * Groups are built from the newest call backwards: an older call joins when it lands within
 * `windowMs` of the group's newest call and is from a model not already in it (a model calling
 * the same token again after its own cooldown is a new alert, not a duplicate). Built this way, a
 * group only depends on calls newer than its own, so the newest `n * models` calls always hold the
 * top `n` groups whole up to their newest call - which is what makes paging over them exact. A
 * group sits at its newest call; its older calls past what was read are filled in afterwards
 * (see the /matches route). Takes rows newest first; returns groups newest first.
 */
export function groupSameTokenCalls<
  T extends {
    tokenId: string;
    createdAt: Date;
    model: string | null;
    modelName: string | null;
    confidence: number;
    tier?: string | null;
    calibratedPct?: number | null;
  },
>(rowsNewestFirst: T[], windowMs: number): CallGroup<T>[] {
  const open = new Map<string, { newest: T; rows: T[] }>();
  const groups: { newest: T; rows: T[] }[] = [];
  for (const row of rowsNewestFirst) {
    const group = open.get(row.tokenId);
    if (
      group &&
      group.newest.createdAt.getTime() - row.createdAt.getTime() <= windowMs &&
      !group.rows.some((r) => r.model === row.model)
    ) {
      group.rows.push(row);
      continue;
    }
    const fresh = { newest: row, rows: [row] };
    open.set(row.tokenId, fresh);
    groups.push(fresh);
  }
  return groups.map(({ newest, rows }) => {
    const oldestFirst = [...rows].reverse();
    return {
      lead: oldestFirst[0]!,
      newest,
      calls: oldestFirst.map((r) => ({
        model: r.model,
        modelName: r.modelName ?? (r.model ? (contestantSpec(r.model)?.name ?? r.model) : null),
        confidence: r.confidence,
        tier: r.tier ?? null,
        calibratedPct: r.calibratedPct ?? null,
        alertedAt: r.createdAt,
      })),
    };
  });
}

/** The AI reviewer's verdict on a curated alert, as only admins see it. */
export interface AdminAiReview {
  mode: string;
  decision: string | null;
  probability2x: number | null;
  probability4x: number | null;
  reasoning: string | null;
  risks: string[];
  error: string | null;
}

/**
 * Adds the AI reviewer's verdict and reasoning to each curated card - for admin wallets only.
 *
 * The reasoning is model output over launcher-written token text, so it never goes on the public
 * card; it stays in the AiReview table and is shown here to the people who tune the reviewer.
 * One query per page, run after the shared page cache so cached rows never carry it.
 */
export async function attachAiReviewsForAdmin<T extends { curated: { alertId: string } | null }>(
  cards: T[],
  isAdmin: boolean,
): Promise<(T & { curated: (NonNullable<T["curated"]> & { aiReview?: AdminAiReview }) | null })[]> {
  const alertIds = cards.flatMap((c) => (c.curated ? [c.curated.alertId] : []));
  if (!isAdmin || alertIds.length === 0) return cards as never;
  const reviews = await prisma.aiReview.findMany({
    where: { curatedAlertId: { in: alertIds } },
    orderBy: { createdAt: "desc" },
    select: {
      curatedAlertId: true,
      mode: true,
      decision: true,
      probability2x: true,
      probability4x: true,
      reasoning: true,
      risks: true,
      error: true,
    },
  });
  const byAlert = new Map<string, AdminAiReview>();
  for (const { curatedAlertId, ...review } of reviews) {
    if (curatedAlertId && !byAlert.has(curatedAlertId)) byAlert.set(curatedAlertId, review);
  }
  return cards.map((card) => {
    const review = card.curated ? byAlert.get(card.curated.alertId) : undefined;
    return review ? { ...card, curated: { ...card.curated!, aiReview: review } } : card;
  }) as never;
}
