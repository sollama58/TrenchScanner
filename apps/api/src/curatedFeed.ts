import type { Prisma } from "@prisma/client";

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

/** Everything a curated card needs, in one Prisma include. */
export const curatedAlertInclude = {
  token: { include: { snapshots: { orderBy: { takenAt: "desc" }, take: 1 } } },
  snapshot: true,
  candidateOutcome: {
    select: {
      anchorPriceUsd: true,
      peak1hPriceUsd: true,
      low1hPriceUsd: true,
      peak24hPriceUsd: true,
      hit2xAt: true,
      finalizedAt: true,
      peak1hReturnPct: true,
      maxDrawdown1hPct: true,
      hit2xIn1h: true,
      disqualified: true,
      peak24hReturnPct: true,
    },
  },
} satisfies Prisma.CuratedAlertInclude;

export type CuratedAlertWithRelations = Prisma.CuratedAlertGetPayload<{
  include: typeof curatedAlertInclude;
}>;

/** How one curated call is going / went, resolved from the freshest source available. */
export interface OutcomeView {
  /**
   * watching: the 1h label window is still open. won/missed/disqualified: the verdict.
   * unknown: the training row was pruned before its copies landed - surfaced honestly rather
   * than guessed at.
   */
  status: "watching" | "won" | "missed" | "disqualified" | "unknown";
  /** True the moment a 2x is observed - the badge flips before the window formally closes. */
  hit2x: boolean;
  /** Final once the verdict lands; the running peak-so-far while still watching. */
  peak1hReturnPct: number | null;
  maxDrawdown1hPct: number | null;
  /** Keeps climbing for winners until their 24h watch ends. */
  peak24hReturnPct: number | null;
  /** The 24h book is closed - every number above is final. */
  finalized: boolean;
  /** Minutes left in the 1h window, for the countdown badge. Null once it has closed. */
  minutesLeft: number | null;
}

type OutcomeSources = Pick<
  CuratedAlertWithRelations,
  | "createdAt"
  | "peak1hReturnPct"
  | "maxDrawdown1hPct"
  | "hit2xIn1h"
  | "disqualified"
  | "peak24hReturnPct"
  | "outcomeFinalizedAt"
> & { candidateOutcome: CuratedAlertWithRelations["candidateOutcome"] };

/**
 * Resolves an alert's outcome from the freshest source available: the live CandidateOutcome link
 * while it exists (updated every watcher tick), the columns copied onto the alert after the
 * training row has been pruned.
 */
export function resolveOutcome(alert: OutcomeSources): OutcomeView {
  const live = alert.candidateOutcome;
  const pctFrom = (price: number, anchor: number) => ((price - anchor) / anchor) * 100;

  // The 1h verdict, from whichever source has it. The live row wins ties - its copy is written
  // in the same sweep, but the live row is what mid-window reads see.
  const verdict =
    live?.finalizedAt != null
      ? { hit2xIn1h: live.hit2xIn1h, disqualified: live.disqualified }
      : alert.hit2xIn1h != null
        ? { hit2xIn1h: alert.hit2xIn1h, disqualified: alert.disqualified }
        : null;

  if (verdict) {
    return {
      status: verdict.disqualified ? "disqualified" : verdict.hit2xIn1h ? "won" : "missed",
      hit2x: verdict.hit2xIn1h === true,
      peak1hReturnPct: live?.peak1hReturnPct ?? alert.peak1hReturnPct,
      maxDrawdown1hPct: live?.maxDrawdown1hPct ?? alert.maxDrawdown1hPct,
      peak24hReturnPct:
        alert.peak24hReturnPct ??
        live?.peak24hReturnPct ??
        (live ? pctFrom(live.peak24hPriceUsd, live.anchorPriceUsd) : null),
      finalized: alert.outcomeFinalizedAt != null,
      minutesLeft: null,
    };
  }

  if (live) {
    // Derived from the anchor rather than sent as a countdown the client has to keep in step -
    // the card renders it once and ticks it locally.
    const elapsedMin = (Date.now() - alert.createdAt.getTime()) / 60_000;
    return {
      status: "watching",
      hit2x: live.hit2xAt != null,
      peak1hReturnPct: pctFrom(live.peak1hPriceUsd, live.anchorPriceUsd),
      maxDrawdown1hPct: pctFrom(live.low1hPriceUsd, live.anchorPriceUsd),
      peak24hReturnPct: pctFrom(live.peak24hPriceUsd, live.anchorPriceUsd),
      finalized: false,
      minutesLeft: Math.max(0, Math.round(60 - elapsedMin)),
    };
  }

  return {
    status: "unknown",
    hit2x: false,
    peak1hReturnPct: null,
    maxDrawdown1hPct: null,
    peak24hReturnPct: null,
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
    confidence: alert.confidence,
    reasons: alert.reasons,
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
    isMayhemMode: null,
    graduated: null,
    mintAuthorityActive: null,
    freezeAuthorityActive: null,
    lpBurned: null,
    ageMinutes: null,
    score: alert.confidence,
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
    deliveredTelegram: false,
    digestSentAt: null,
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
    kind: "match" | "curated";
    tokenId: string;
    matchedAt: Date;
    curated: { alertId: string } | null;
  },
>(cards: T[], windowMs: number): T[] {
  const absorbed = new Set<string>();
  const folded = new Map<string, T["curated"]>();

  for (const card of cards) {
    if (card.kind !== "curated" || !card.curated) continue;
    const twin = cards.find(
      (m) =>
        m.kind === "match" &&
        m.tokenId === card.tokenId &&
        !folded.has(m.tokenId + m.matchedAt.toISOString()) &&
        m.curated === null &&
        Math.abs(m.matchedAt.getTime() - card.matchedAt.getTime()) <= windowMs,
    );
    if (!twin) continue;
    folded.set(twin.tokenId + twin.matchedAt.toISOString(), card.curated);
    absorbed.add(card.curated.alertId);
  }

  return cards
    .filter((c) => !(c.kind === "curated" && c.curated && absorbed.has(c.curated.alertId)))
    .map((c) => {
      const meta = folded.get(c.tokenId + c.matchedAt.toISOString());
      return meta && c.kind === "match" ? { ...c, curated: meta } : c;
    });
}
