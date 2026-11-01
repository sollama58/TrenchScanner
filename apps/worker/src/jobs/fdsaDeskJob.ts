import {
  FDSA_NOTE_USER_ID,
  paperFdsaExecutor,
  runFdsaDesk,
  sendTradeNotes,
  type Env,
  type FdsaReviser,
  type JupiterSwapClient,
  type TelegramApi,
  type TradingRpc,
} from "@trenchscanner/core";
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
 * Revisions: `reviser` is the review pipeline's revise stage. Until that is wired, plans run as
 * set at entry - still with the -50% floor, the ratchet and the hold cap.
 */
export function createFdsaDeskRunner(
  env: Env,
  shared: {
    swap: JupiterSwapClient;
    rpc: TradingRpc;
    telegram: TelegramApi | null;
    admins: ReadonlySet<string>;
    reviser?: FdsaReviser;
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
      reviser: env.FDSA_ENABLED ? shared.reviser : undefined,
      revision: {
        timerMinutes: env.FDSA_REVISION_TIMER_MINUTES,
        drawdownPct: env.FDSA_REVISION_DRAWDOWN_PCT,
        minGapSeconds: env.FDSA_REVISION_MIN_GAP_SECONDS,
      },
      notify,
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
