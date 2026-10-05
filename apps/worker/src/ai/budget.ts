import Anthropic from "@anthropic-ai/sdk";
import {
  addAiSpend,
  aiSpendDay,
  aiSpendLimitUsd,
  aiSpentUsd,
  createLogger,
  estimateCostUsd,
  usageCostUsd,
  type AiSpendPriority,
  type AiSpendSource,
  type AiUsage,
  type Env,
} from "@trenchscanner/core";

const logger = createLogger("ai-budget");

/**
 * The hard daily cap on AI spend (AI_DAILY_BUDGET_USD), enforced before every Anthropic call.
 * A call first reserves its estimated cost in the shared ledger (core's curation/aiSpend.ts) -
 * refused when that would take the day's spend past what its priority may use - and once it
 * returns, the reservation is trued up to the real cost from the response's usage. The ledger is
 * in the database, so the scanner and the trainer draw on one budget and a restart forgets
 * nothing.
 *
 * Priorities: "live" is a review of a high-conviction pick and may spend up to the cap;
 * "background" (text reads, playbook reviews and replays, reviews of standard picks) stops at the
 * cap less AI_BUDGET_REVIEW_RESERVE_PCT, so the reserve is always there for the calls that matter.
 *
 * Reservations are made one at a time within a process. Across the two processes a call can slip
 * in between another's read and write, so the cap can be overshot by at most one call's estimate.
 */

export interface AiSpendReservation {
  day: string;
  source: AiSpendSource;
  estimateUsd: number;
  capUsd: number;
}

/** The call shapes the worker makes, for estimates before any have been measured. */
export type AiCallKind = "review" | "text" | "playbook";
/**
 * Rough token counts per call (input including the cached system prompt, output including
 * thinking). Only the first estimates use these; after that the running average of real costs
 * takes over (see settleAiSpend).
 */
const CALL_PROFILES: Record<AiCallKind, { input: number; output: number }> = {
  review: { input: 6_000, output: 2_500 },
  text: { input: 1_000, output: 800 },
  playbook: { input: 60_000, output: 12_000 },
};
const EWMA_ALPHA = 0.2;
const observedUsd = new Map<AiCallKind, number>();

/** What one call of `kind` on `model` is expected to cost: the running average once there is one. */
export function estimateCallUsd(kind: AiCallKind, model: string): number {
  return observedUsd.get(kind) ?? estimateCostUsd(model, CALL_PROFILES[kind]);
}

/** After a refusal, the same priority isn't re-checked against the database for this long. */
const REFUSAL_HOLD_MS = 5 * 60_000;
const heldUntil = new Map<AiSpendPriority, { day: string; until: number }>();
const announced = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

/** Test hook. */
export function resetAiBudget(): void {
  observedUsd.clear();
  heldUntil.clear();
  announced.clear();
  queue = Promise.resolve();
}

function serially<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function held(priority: AiSpendPriority, day: string, now: number): boolean {
  // A refused live call means background work can't fit either.
  const keys: AiSpendPriority[] = priority === "background" ? ["background", "live"] : ["live"];
  return keys.some((k) => {
    const h = heldUntil.get(k);
    return h !== undefined && h.day === day && now < h.until;
  });
}

/**
 * Reserves `estimateUsd` for one call (or one batch) against today's budget. Returns the
 * reservation to settle afterwards, or null when the budget can't take it - the caller then
 * skips the call. A ledger that can't be read or written also returns null: no call runs
 * unaccounted for.
 */
export async function reserveAiSpend(
  env: Env,
  source: AiSpendSource,
  estimateUsd: number,
  priority: AiSpendPriority,
): Promise<AiSpendReservation | null> {
  return serially(async () => {
    const now = Date.now();
    const day = aiSpendDay(new Date(now));
    const capUsd = env.AI_DAILY_BUDGET_USD;
    try {
      // While a refusal is held, calls are turned away without touching the database (the text
      // reader would otherwise write a refusal per mint per scan); `refused` in the ledger
      // counts the checks that said no.
      if (capUsd <= 0 || held(priority, day, now)) return null;
      const spent = await aiSpentUsd(day);
      if (spent + estimateUsd > aiSpendLimitUsd(env, priority)) {
        heldUntil.set(priority, { day, until: now + REFUSAL_HOLD_MS });
        const key = `${day}:${priority}`;
        if (!announced.has(key)) {
          announced.add(key);
          logger.warn(
            priority === "live"
              ? "daily AI budget reached - AI calls stop until midnight UTC"
              : "daily AI budget down to the high-conviction reserve - background AI work paused until midnight UTC",
            { day, spentUsd: Math.round(spent * 100) / 100, capUsd, source },
          );
        }
        await addAiSpend(day, source, { refused: 1 }, capUsd);
        return null;
      }
      await addAiSpend(day, source, { costUsd: estimateUsd, calls: 1 }, capUsd);
      return { day, source, estimateUsd, capUsd };
    } catch (err) {
      logger.warn("could not check the AI budget - skipping the call", { source, error: String(err) });
      return null;
    }
  });
}

/**
 * Trues a reservation up to what the call really cost (0 refunds it). `kind` feeds the running
 * average later estimates use. Never throws - a failed true-up leaves the estimate standing.
 */
export async function settleAiSpend(
  reservation: AiSpendReservation,
  actualUsd: number,
  kind?: AiCallKind,
): Promise<void> {
  if (kind && actualUsd > 0) {
    const prev = observedUsd.get(kind);
    observedUsd.set(kind, prev === undefined ? actualUsd : prev + EWMA_ALPHA * (actualUsd - prev));
  }
  const delta = actualUsd - reservation.estimateUsd;
  if (Math.abs(delta) < 1e-9) return;
  try {
    await addAiSpend(reservation.day, reservation.source, { costUsd: delta }, reservation.capUsd);
  } catch (err) {
    logger.warn("could not true up an AI spend reservation", { error: String(err) });
  }
}

/** What a response cost: priced at the dearer of the model asked and the model that answered. */
export function responseCostUsd(requestedModel: string, response: { model: string; usage: AiUsage }): number {
  return usageCostUsd([requestedModel, response.model], response.usage);
}

/**
 * What a failed call cost, as far as can be told: nothing when the API answered with an error
 * status (the request was rejected, not run), the full estimate when it timed out or the
 * connection dropped (it may have run and been billed).
 */
export function failedCallCostUsd(err: unknown, reservation: AiSpendReservation): number {
  return err instanceof Anthropic.APIError && err.status !== undefined ? 0 : reservation.estimateUsd;
}

/** The USD `priority` can still spend today - for sizing a batch to fit. 0 when unreadable. */
export async function aiBudgetRoomUsd(env: Env, priority: AiSpendPriority): Promise<number> {
  try {
    const spent = await aiSpentUsd(aiSpendDay());
    return Math.max(0, aiSpendLimitUsd(env, priority) - spent);
  } catch (err) {
    logger.warn("could not read the AI budget", { error: String(err) });
    return 0;
  }
}
