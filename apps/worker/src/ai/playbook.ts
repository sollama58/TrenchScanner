import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod/v4";
import {
  prisma,
  Prisma,
  createLogger,
  buildReflectionBrief,
  decidePlaybookPromotion,
  sanitizePlaybookText,
  DISQUALIFYING_DRAWDOWN_FRACTION,
  REFLECTION_SYSTEM_PROMPT,
  type Env,
  type JudgeRecordSummary,
  type ReflectionCall,
} from "@trenchscanner/core";
import { anthropicClient, describeAnthropicError } from "./client.js";
import { ensureActivePlaybook, resetActivePlaybookCache, type ActivePlaybook } from "./playbookStore.js";
import { loadReplayItems, replayRequestUsd, submitReplay, type ScoredReplayRun } from "./replay.js";
import {
  aiBudgetRoomUsd,
  estimateCallUsd,
  failedCallCostUsd,
  reserveAiSpend,
  responseCostUsd,
  settleAiSpend,
} from "./budget.js";

const logger = createLogger("ai-playbook");

/**
 * Playbook evolution - the AI reviewer's learning loop (see curation/aiJudge.ts for the why).
 * Each round:
 *
 *  1. Collect the active playbook's graded calls from BEFORE the holdout window - live reviews
 *     and replayed ones. Too few (a fresh install) and a baseline replay of the active playbook is
 *     sent first instead, to give it a record to learn from.
 *  2. Ask Claude to review that record into two candidate playbooks.
 *  3. Replay the incumbent and both candidates on the holdout window's alerts - which the review
 *     never saw - in one batch.
 *  4. When the batch is scored (settleEvolutionRun), promote a candidate only if it beat the
 *     incumbent clearly; reject the rest. Every version is kept.
 */

/** Graded calls the review needs before it is worth asking. */
const MIN_REFLECTION_CALLS = 40;
/** Graded holdout alerts a fair replay needs. */
const MIN_HOLDOUT_ROWS = 30;
/** How far back a baseline replay reaches, before the holdout window. */
const BASELINE_DAYS = 14;
/** Most graded calls loaded for one review (the brief lists the costliest first). */
const MAX_REFLECTION_LOAD = 600;

const ReflectionSchema = z.object({
  candidates: z.array(z.object({ playbook: z.string(), rationale: z.string() })),
});

export type EvolutionStep =
  | "disabled"
  | "replay-pending"
  | "not-due"
  | "too-few-holdout-alerts"
  | "baseline-submitted"
  | "waiting-for-graded-calls"
  | "review-failed"
  | "no-new-candidates"
  | "evolution-submitted"
  | "submit-failed"
  | "over-budget";

/** One pass of the loop - see the module comment. Cheap when nothing is due. */
export async function maybeEvolvePlaybook(env: Env, now = Date.now()): Promise<EvolutionStep> {
  if (!env.AI_PLAYBOOK_EVOLUTION) return "disabled";
  if ((await prisma.aiReplayRun.count({ where: { status: "submitted" } })) > 0) return "replay-pending";
  const lastEvolution = await prisma.aiReplayRun.findFirst({
    where: { purpose: "evolution" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (
    lastEvolution &&
    now - lastEvolution.createdAt.getTime() < env.AI_PLAYBOOK_EVOLUTION_HOURS * 3_600_000
  ) {
    return "not-due";
  }

  const active = await ensureActivePlaybook();
  const holdoutStart = new Date(now - env.AI_REPLAY_HOLDOUT_DAYS * 86_400_000);
  const holdoutEnd = new Date(now);
  const holdout = await loadReplayItems(env, {
    from: holdoutStart,
    to: holdoutEnd,
    take: env.AI_REPLAY_MAX_ROWS,
  });
  if (holdout.length < MIN_HOLDOUT_ROWS) return "too-few-holdout-alerts";

  const record = await reflectionRecord(active, holdoutStart);
  if (record.length < MIN_REFLECTION_CALLS) {
    // A fresh playbook has no record to learn from yet. One baseline replay per playbook buys it
    // one; after that, wait for live calls rather than paying for the same replay again.
    const baselined = await prisma.aiReplayRun.count({
      where: {
        purpose: "baseline",
        playbookIds: { has: active.id },
        status: { in: ["submitted", "scored"] },
      },
    });
    if (baselined > 0) return "waiting-for-graded-calls";
    // A baseline that failed to submit waits out the evolution interval like any other attempt,
    // rather than being resubmitted on every pass.
    const recentFailure = await prisma.aiReplayRun.count({
      where: {
        purpose: "baseline",
        playbookIds: { has: active.id },
        status: "failed",
        createdAt: { gte: new Date(now - env.AI_PLAYBOOK_EVOLUTION_HOURS * 3_600_000) },
      },
    });
    if (recentFailure > 0) return "not-due";
    const from = new Date(holdoutStart.getTime() - BASELINE_DAYS * 86_400_000);
    const items = await loadReplayItems(env, { from, to: holdoutStart, take: env.AI_REPLAY_MAX_ROWS });
    if (items.length < MIN_REFLECTION_CALLS) return "waiting-for-graded-calls";
    const submitted = await submitReplay(env, {
      purpose: "baseline",
      playbooks: [active],
      items,
      window: { from, to: holdoutStart },
      minItems: MIN_REFLECTION_CALLS,
    });
    if (submitted.runId !== null) return "baseline-submitted";
    return submitted.reason === "over-budget" ? "over-budget" : "submit-failed";
  }

  // A round is background work on the daily AI budget: the review plus a replay of the incumbent
  // and two candidates on at least MIN_HOLDOUT_ROWS alerts. When what is left above the
  // high-conviction reserve can't pay for that, the round waits - with no run recorded, so it is
  // tried again once the budget resets.
  const roundUsd =
    estimateCallUsd("playbook", env.AI_REVIEW_MODEL) + MIN_HOLDOUT_ROWS * 3 * (await replayRequestUsd(env));
  if ((await aiBudgetRoomUsd(env, "background")) < roundUsd) return "over-budget";

  const proposals = await reviewRecord(env, active, record);
  if (proposals === "over-budget") return "over-budget";
  // Both dead ends are logged as an evolution run so the interval gate above counts them: without
  // a row, every 10-minute pass would pay for another full reflection call.
  const window = { from: holdoutStart, to: holdoutEnd };
  if (proposals === null) {
    await recordDeadEnd(env, active.id, window, "review failed");
    return "review-failed";
  }
  const fresh = proposals.filter((p) => p.text !== "" && p.text !== sanitizePlaybookText(active.text));
  if (fresh.length === 0) {
    await recordDeadEnd(env, active.id, window, "no new candidates");
    return "no-new-candidates";
  }

  const maxVersion = await prisma.aiPlaybook.aggregate({ _max: { version: true } });
  let version = maxVersion._max.version ?? active.version;
  const candidates = [];
  for (const p of fresh.slice(0, 2)) {
    version += 1;
    candidates.push(
      await prisma.aiPlaybook.create({
        data: { version, status: "candidate", text: p.text, rationale: p.rationale, parentId: active.id },
        select: { id: true, text: true },
      }),
    );
  }

  const { runId } = await submitReplay(env, {
    purpose: "evolution",
    playbooks: [active, ...candidates],
    items: holdout,
    window: { from: holdoutStart, to: holdoutEnd },
    minItems: MIN_HOLDOUT_ROWS,
  });
  if (!runId) {
    await prisma.aiPlaybook.updateMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      data: { status: "rejected", decidedAt: new Date(), rationale: "replay could not be submitted" },
    });
    return "submit-failed";
  }
  return "evolution-submitted";
}

/** An evolution attempt that ended before any replay: stored as a failed run with no requests. */
async function recordDeadEnd(
  env: Env,
  playbookId: string,
  window: { from: Date; to: Date },
  error: string,
): Promise<void> {
  await prisma.aiReplayRun.create({
    data: {
      purpose: "evolution",
      status: "failed",
      model: env.AI_REVIEW_MODEL,
      playbookIds: [playbookId],
      windowStart: window.from,
      windowEnd: window.to,
      requestCount: 0,
      error,
    },
  });
}

/**
 * The active playbook's graded calls anchored before `before`: its live reviews (plus, for the
 * first version, reviews from before playbooks existed) and its replayed verdicts, one per alert -
 * live wins over replayed.
 */
async function reflectionRecord(active: ActivePlaybook, before: Date): Promise<ReflectionCall[]> {
  const live = await prisma.aiReview.findMany({
    where: {
      decision: { in: ["buy", "no_buy"] },
      ...(active.version === 1
        ? { OR: [{ playbookId: active.id }, { playbookId: null }] }
        : { playbookId: active.id }),
      candidateOutcome: { is: { finalizedAt: { not: null }, anchorAt: { lt: before } } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_REFLECTION_LOAD,
    select: { candidateOutcomeId: true, decision: true, probability2x: true, curatorProbability: true },
  });
  const replayed = await prisma.aiReplayVerdict.findMany({
    where: { playbookId: active.id, decision: { in: ["buy", "no_buy"] } },
    orderBy: { id: "desc" },
    take: MAX_REFLECTION_LOAD,
    select: { candidateOutcomeId: true, decision: true, probability2x: true },
  });

  const calls = new Map<
    string,
    { decision: string; probability2x: number | null; curatorProbability: number | null }
  >();
  for (const r of replayed) {
    calls.set(r.candidateOutcomeId, {
      decision: r.decision!,
      probability2x: r.probability2x,
      curatorProbability: null,
    });
  }
  for (const r of live) {
    if (r.candidateOutcomeId) {
      calls.set(r.candidateOutcomeId, {
        decision: r.decision!,
        probability2x: r.probability2x,
        curatorProbability: r.curatorProbability,
      });
    }
  }
  if (calls.size === 0) return [];

  const ids = [...calls.keys()];
  const outcomes = [];
  for (let i = 0; i < ids.length; i += 1_000) {
    outcomes.push(
      ...(await prisma.candidateOutcome.findMany({
        where: { id: { in: ids.slice(i, i + 1_000) }, finalizedAt: { not: null }, anchorAt: { lt: before } },
        select: {
          id: true,
          features: true,
          labelValue: true,
          disqualified: true,
          peak1hReturnPct: true,
          maxDrawdown1hPct: true,
        },
      })),
    );
  }
  const stopLevel = -(1 - DISQUALIFYING_DRAWDOWN_FRACTION) * 100;
  return outcomes.map((o) => {
    const call = calls.get(o.id)!;
    const labelValue = o.labelValue ?? 0;
    return {
      decision: call.decision === "buy" ? "buy" : "no_buy",
      probability2x: call.probability2x,
      curatorProbability: call.curatorProbability,
      labelValue,
      stoppedOut:
        (o.disqualified ?? false) ||
        (labelValue === 0 && o.maxDrawdown1hPct !== null && o.maxDrawdown1hPct <= stopLevel),
      peak1hReturnPct: o.peak1hReturnPct,
      features: o.features as Record<string, number | null>,
    };
  });
}

/**
 * Asks Claude to review the record into candidate playbooks; null when the call fails,
 * "over-budget" when the daily AI budget can't take it.
 */
async function reviewRecord(
  env: Env,
  active: ActivePlaybook,
  record: ReflectionCall[],
): Promise<{ text: string; rationale: string }[] | null | "over-budget"> {
  const reservation = await reserveAiSpend(
    env,
    "playbook",
    estimateCallUsd("playbook", env.AI_REVIEW_MODEL),
    "background",
  );
  if (!reservation) return "over-budget";
  try {
    let response;
    try {
      response = await anthropicClient(env).beta.messages.parse(
        {
          model: env.AI_REVIEW_MODEL,
          max_tokens: 32000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: REFLECTION_SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildReflectionBrief(active.text, record) }],
          output_config: { effort: "high", format: betaZodOutputFormat(ReflectionSchema) },
        },
        // A review is one call a day reading a few hundred rows; give it room beyond the live
        // reviewer's timeout.
        { timeout: 10 * 60_000 },
      );
    } catch (err) {
      await settleAiSpend(reservation, failedCallCostUsd(err, reservation));
      throw err;
    }
    await settleAiSpend(reservation, responseCostUsd(env.AI_REVIEW_MODEL, response), "playbook");
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      logger.warn("playbook review returned nothing usable", { stop: response.stop_reason });
      return null;
    }
    return response.parsed_output.candidates.map((c) => ({
      text: sanitizePlaybookText(c.playbook),
      rationale: c.rationale.replace(/[<>]/g, "").slice(0, 500),
    }));
  } catch (err) {
    logger.warn("playbook review failed", { error: describeAnthropicError(err) });
    return null;
  }
}

/**
 * Settles a scored evolution run: the incumbent (the run's first playbook) keeps the job unless a
 * candidate beat it clearly on the same alerts (decidePlaybookPromotion). If the incumbent is no
 * longer the active playbook by now, the round is void and its candidates are rejected.
 */
export async function settleEvolutionRun(run: ScoredReplayRun, env: Env): Promise<string> {
  const [incumbentId, ...candidateIds] = run.playbookIds;
  if (!incumbentId) return "empty run";
  const now = new Date();
  const incumbent = await prisma.aiPlaybook.findUnique({
    where: { id: incumbentId },
    select: { status: true },
  });
  const summary = (id: string): JudgeRecordSummary | undefined => run.summaries[id];

  if (incumbent?.status !== "active" || summary(incumbentId) === undefined) {
    await prisma.aiPlaybook.updateMany({
      where: { id: { in: candidateIds }, status: "candidate" },
      data: { status: "rejected", decidedAt: now },
    });
    return "incumbent changed; round void";
  }
  const decision = decidePlaybookPromotion(
    summary(incumbentId)!,
    candidateIds.flatMap((id) => (summary(id) ? [{ id, summary: summary(id)! }] : [])),
    { minGain: env.AI_PLAYBOOK_MIN_GAIN, minBuys: env.AI_PLAYBOOK_MIN_BUYS },
  );

  await prisma.$transaction(async (tx) => {
    await tx.aiPlaybook.update({
      where: { id: incumbentId },
      data: { metrics: summary(incumbentId) as object },
    });
    for (const id of candidateIds) {
      const won = id === decision.winner;
      await tx.aiPlaybook.update({
        where: { id },
        data: {
          status: won ? "active" : "rejected",
          decidedAt: now,
          metrics: summary(id) ? (summary(id) as object) : Prisma.JsonNull,
        },
      });
    }
    if (decision.winner) {
      await tx.aiPlaybook.update({ where: { id: incumbentId }, data: { status: "retired", decidedAt: now } });
    }
  });
  if (decision.winner) resetActivePlaybookCache();
  logger.info("playbook evolution settled", {
    run: run.id,
    winner: decision.winner,
    reason: decision.reason,
  });
  return decision.reason;
}
