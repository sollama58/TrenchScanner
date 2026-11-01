import {
  FDSA_NOTE_USER_ID,
  paperFdsaExecutor,
  prisma,
  runFdsaDesk,
  sendTradeNotes,
  type Env,
  type FdsaReviser,
  type FdsaSinceEntryChange,
  type JupiterSwapClient,
  type TelegramApi,
  type TradingRpc,
} from "@trenchscanner/core";
import { reviseFdsaPlan, type FdsaMarketSource } from "../fdsa/review.js";
import type { JobRunMeta } from "../scheduler.js";

/**
 * The FDSA paper desk (packages/core/src/fdsa/paperDesk.ts; owner decision 2026-10-31), run in
 * the paper-trading job right after the strategies, on the same quotes, prices and mint reads.
 * Paper only: it reads and never signs or sends.
 *
 * With FDSA_ENABLED off it buys nothing, but positions already open keep following their exit
 * plans: switching FDSA off must never strand a position without its stop (decision 8). With no
 * desk row yet and FDSA off, it does nothing at all.
 *
 * Revisions go through the review pipeline's revise stage (fdsa/review.ts reviseFdsaPlan), under
 * FDSA's exit slice of the cap. With FDSA off there are none: plans run as set at entry, still
 * with the -50% floor, the ratchet and the hold cap.
 */
export function createFdsaDeskRunner(
  env: Env,
  shared: {
    swap: JupiterSwapClient;
    rpc: TradingRpc;
    telegram: TelegramApi | null;
    admins: ReadonlySet<string>;
    /** Seconds-old quotes for the revise brief's market block (the scan's Jupiter client); none, "unknown". */
    market?: FdsaMarketSource | null;
    /** Replaces the revise stage (tests). */
    reviser?: FdsaReviser;
    /** Takes each detached revision call (tests await them); unset, they run fire and forget. */
    dispatch?: (revision: Promise<void>) => void;
  },
): () => Promise<JobRunMeta> {
  const executor = paperFdsaExecutor({ swap: shared.swap, rpc: shared.rpc });
  const telegram = shared.telegram;
  // Buys, sales and automatic pauses, labelled FDSA, to every admin's private chats (decision 10).
  const notify = telegram
    ? async (notes: Parameters<typeof sendTradeNotes>[0]) =>
        void (await sendTradeNotes(notes, {
          telegram,
          admins: shared.admins,
          serverUserId: FDSA_NOTE_USER_ID,
        }))
    : undefined;
  return async () => {
    const s = await runFdsaDesk({
      market: shared.swap,
      rpc: shared.rpc,
      executor,
      entries: env.FDSA_ENABLED,
      reviser: env.FDSA_ENABLED ? (shared.reviser ?? fdsaReviser(env, shared.market)) : undefined,
      revision: {
        timerMinutes: env.FDSA_REVISION_TIMER_MINUTES,
        drawdownPct: env.FDSA_REVISION_DRAWDOWN_PCT,
        minGapSeconds: env.FDSA_REVISION_MIN_GAP_SECONDS,
      },
      notify,
      dispatch: shared.dispatch,
    });
    return {
      fdsaRunning: s.running,
      fdsaOpen: s.open,
      fdsaExitsChecked: s.exitsChecked,
      fdsaSells: s.sells,
      fdsaRevisions: s.revisionsDispatched,
      fdsaIntents: s.intents,
      fdsaEntries: s.entries,
      fdsaSkipped: s.skips.length,
      fdsaErrors: s.errors,
    };
  };
}

/** The holder figures the revise brief shows at the alert against now (TokenSnapshot columns). */
const SINCE_ENTRY_FIELDS = [
  { key: "holderCount", label: "holders", fmt: (v: number) => String(Math.round(v)) },
  { key: "largestHolderPct", label: "largest holder", fmt: (v: number) => `${v.toFixed(1)}%` },
  { key: "devWalletPct", label: "dev wallet", fmt: (v: number) => `${v.toFixed(1)}%` },
  { key: "bundledSupplyPct", label: "bundled supply", fmt: (v: number) => `${v.toFixed(1)}%` },
  { key: "flaggedSellers", label: "flagged wallets selling", fmt: (v: number) => String(Math.round(v)) },
  { key: "winnerRecentBuyers", label: "winner wallets buying", fmt: (v: number) => String(Math.round(v)) },
  { key: "winnerRecentSellers", label: "winner wallets selling", fmt: (v: number) => String(Math.round(v)) },
] as const;
type SinceEntryKey = (typeof SINCE_ENTRY_FIELDS)[number]["key"];
export type FdsaSnapshotRow = Record<SinceEntryKey, number | null> & { devHolding: boolean | null };
type SnapshotRow = FdsaSnapshotRow;

/**
 * What changed in the holders between the alert and now: the scan's last snapshot before the
 * alert against its newest one since the fill, field by field, only where both read. Empty when
 * the scan hasn't read the coin again since entry (the brief then says so).
 */
export function sinceEntryLines(
  before: SnapshotRow | null,
  after: SnapshotRow | null,
): FdsaSinceEntryChange[] {
  if (!before || !after) return [];
  const out: FdsaSinceEntryChange[] = [];
  for (const f of SINCE_ENTRY_FIELDS) {
    const a = before[f.key];
    const b = after[f.key];
    if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push({ label: f.label, from: f.fmt(a), to: f.fmt(b) });
  }
  if (before.devHolding !== null && after.devHolding !== null) {
    const text = (v: boolean) => (v ? "yes" : "no, sold out");
    out.push({ label: "dev still holding", from: text(before.devHolding), to: text(after.devHolding) });
  }
  return out;
}

const snapshotSelect = {
  holderCount: true,
  largestHolderPct: true,
  devWalletPct: true,
  bundledSupplyPct: true,
  flaggedSellers: true,
  winnerRecentBuyers: true,
  winnerRecentSellers: true,
  devHolding: true,
} as const;

/** The scan's snapshots around a position: the last before the alert, the newest since the fill. */
async function snapshotsAround(
  tokenId: string,
  alertAt: Date,
  openedAt: Date,
): Promise<{ before: SnapshotRow | null; after: SnapshotRow | null }> {
  const [before, after] = await Promise.all([
    prisma.tokenSnapshot.findFirst({
      where: { tokenId, takenAt: { lte: alertAt } },
      orderBy: { takenAt: "desc" },
      select: snapshotSelect,
    }),
    prisma.tokenSnapshot.findFirst({
      where: { tokenId, takenAt: { gt: openedAt } },
      orderBy: { takenAt: "desc" },
      select: snapshotSelect,
    }),
  ]);
  return { before, after };
}

/**
 * The desk's reviser on the review pipeline's revise stage. The stored review is graded like the
 * alert, so it carries the alert's time and anchor from the decide review that bought the
 * position. Any "no call" (FDSA off, over the cap, an outage) is a failed revision: the running
 * plan stays.
 *
 * What the brief is given beyond the position (AI evaluation 2026-11-01, which found the market
 * block always read "unknown"): a seconds-old quote from `market` for the market block, the
 * desk's own tape of the position (the request carries it), the decide stage's reasoning, risks
 * and odds as the thesis at entry, the holder figures at the alert against now, and the fill's
 * price against the alert's anchor. Each is "unknown" in the brief when it can't be had; none of
 * them can stop the call.
 */
export function fdsaReviser(env: Env, market?: FdsaMarketSource | null): FdsaReviser {
  return {
    async revise(r) {
      const position = await prisma.fdsaPosition.findUnique({
        where: { id: r.positionId },
        select: { reviewId: true, tokenId: true, candidateOutcomeId: true, curatedAlertId: true },
      });
      const decide = position?.reviewId
        ? await prisma.fdsaReview.findUnique({
            where: { id: position.reviewId },
            select: {
              tokenId: true,
              alertAt: true,
              anchorPriceUsd: true,
              anchorMcapUsd: true,
              reasoning: true,
              risks: true,
              probability2x: true,
              probability4x: true,
            },
          })
        : null;
      if (!position || !decide) return { ok: false, error: "no decide review behind the position" };
      const [quote, snapshots] = await Promise.all([
        market ? market.freshQuote(r.mint).catch(() => null) : Promise.resolve(null),
        snapshotsAround(decide.tokenId, decide.alertAt, r.openedAt).catch(() => ({
          before: null,
          after: null,
        })),
      ]);
      const s5 = quote?.stats5m;
      const result = await reviseFdsaPlan(env, {
        positionId: r.positionId,
        tokenId: decide.tokenId,
        candidateOutcomeId: position.candidateOutcomeId,
        curatedAlertId: position.curatedAlertId,
        alertAt: decide.alertAt,
        anchorPriceUsd: decide.anchorPriceUsd,
        anchorMcapUsd: decide.anchorMcapUsd,
        trigger: r.trigger,
        symbol: r.symbol,
        minutesHeld: (r.at.getTime() - r.openedAt.getTime()) / 60_000,
        multiple: r.multiple,
        peakMultiple: r.peakMultiple,
        floorMultiple: r.floorMultiple,
        soldFraction: r.soldFraction,
        planVersion: r.planVersion,
        plan: r.plan,
        tape: r.tape,
        market: quote
          ? {
              priceChange5mPct: s5?.priceChangePct ?? null,
              priceChange1hPct: quote.stats1h?.priceChangePct ?? null,
              buyVolume5mUsd: s5?.buyVolumeUsd ?? null,
              sellVolume5mUsd: s5?.sellVolumeUsd ?? null,
              // A window Jupiter reports with no trades has counts of zero; one it left out is unknown.
              buys5m: s5 ? (s5.buys ?? 0) : null,
              sells5m: s5 ? (s5.sells ?? 0) : null,
              netBuyers5m: s5?.netBuyers ?? null,
              holderCount: quote.holderCount ?? null,
              holderChange5m: s5?.holderChange ?? null,
            }
          : undefined,
        thesis:
          decide.reasoning !== null && decide.probability2x !== null
            ? {
                reasoning: decide.reasoning,
                risks: decide.risks,
                probability2x: decide.probability2x,
                probability4x: decide.probability4x ?? 0,
              }
            : null,
        entryVsAlertPct:
          r.entryPriceUsd !== null && decide.anchorPriceUsd > 0
            ? (r.entryPriceUsd / decide.anchorPriceUsd - 1) * 100
            : null,
        sinceEntry: sinceEntryLines(snapshots.before, snapshots.after),
      });
      if (!result)
        return { ok: false, error: "no revision call: FDSA off, over its cap, or the call failed" };
      return { ok: true, reviewId: result.reviewId, read: result.read };
    },
  };
}
