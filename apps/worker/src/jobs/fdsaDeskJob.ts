import {
  FDSA_NOTE_USER_ID,
  paperFdsaExecutor,
  prisma,
  runFdsaDesk,
  sendTradeNotes,
  type Env,
  type FdsaReviser,
  type JupiterSwapClient,
  type TelegramApi,
  type TradingRpc,
} from "@trenchscanner/core";
import { reviseFdsaPlan } from "../fdsa/review.js";
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
      reviser: env.FDSA_ENABLED ? (shared.reviser ?? fdsaReviser(env)) : undefined,
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

/**
 * The desk's reviser on the review pipeline's revise stage. The stored review is graded like the
 * alert, so it carries the alert's time and anchor from the decide review that bought the
 * position. Any "no call" (FDSA off, over the cap, an outage) is a failed revision: the running
 * plan stays.
 */
export function fdsaReviser(env: Env): FdsaReviser {
  return {
    async revise(r) {
      const position = await prisma.fdsaPosition.findUnique({
        where: { id: r.positionId },
        select: { reviewId: true, tokenId: true, candidateOutcomeId: true, curatedAlertId: true },
      });
      const decide = position?.reviewId
        ? await prisma.fdsaReview.findUnique({
            where: { id: position.reviewId },
            select: { tokenId: true, alertAt: true, anchorPriceUsd: true, anchorMcapUsd: true },
          })
        : null;
      if (!position || !decide) return { ok: false, error: "no decide review behind the position" };
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
      });
      if (!result)
        return { ok: false, error: "no revision call: FDSA off, over its cap, or the call failed" };
      return { ok: true, reviewId: result.reviewId, read: result.read };
    },
  };
}
