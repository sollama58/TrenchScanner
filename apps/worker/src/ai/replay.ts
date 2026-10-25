import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";
import {
  prisma,
  createLogger,
  aiReviewSystemPrompt,
  buildAiReviewBrief,
  launcherTextInstructs,
  nearestOutcomes,
  passesWalletSafetyCuts,
  isPreFeeWalletStonksRow,
  scoredFromFeatures,
  summarizeJudgeRecord,
  aiSpendDay,
  usageCostUsd,
  BRIEF_WALLET_FIELDS,
  isRawWalletRiskRow,
  HOLDER_TRANSFER_LINKS_READ_SINCE,
  FRESH_ANCHOR_LABEL_RULE,
  type CurationDecision,
  type Env,
  type ScoredToken,
  type JudgeRecordSummary,
  type JudgedCall,
  HIGH_CONVICTION_TIER,
} from "@trenchscanner/core";
import { anthropicClient, describeAnthropicError } from "./client.js";
import { aiBudgetRoomUsd, estimateCallUsd, reserveAiSpend, settleAiSpend } from "./budget.js";
import { blendTargets } from "./blend.js";
import {
  COMPARABLES_K,
  COMPARABLE_POOL_DAYS,
  comparablesKnowableAt,
  VerdictSchema,
  loadGradedPool,
  verdictFromParsed,
  type DatedGradedRow,
} from "./reviewer.js";

const logger = createLogger("ai-replay");

/**
 * Offline replay of the AI reviewer: past graded alerts re-asked under a given playbook through
 * the Message Batches API (half the price of live calls; results within a day, usually within the
 * hour). This is what lets a playbook be judged on hundreds of alerts overnight instead of waiting
 * weeks for live calls to be graded - and judged fairly: every playbook in a run sees the same
 * alerts, briefed exactly as the live reviewer would have been briefed AT THE TIME, with
 * comparables drawn only from outcomes that had already finished by then (no peeking).
 *
 * The numbers are the alert's own stored feature vector, wallet stage included; the RugCheck
 * flags are the alert's own scan's (its TokenSnapshot); a call graded from a fresh quote is
 * briefed with both market caps, as live. Known gaps from live: narrative tags and description
 * are the token's current ones, and the curator's reasons are what the alert row kept.
 */

/** How long a submitted run's batch may stay unreadable before the run is failed. */
const UNREADABLE_BATCH_GIVE_UP_MS = 3 * 86_400_000;
/** The most pool rows one replay loads for comparables. */
const REPLAY_POOL_MAX_ROWS = 8_000;
/** Most requests one replay sends - well under the API's limits, keeps the request body small. */
const MAX_BATCH_REQUESTS = 1_000;

export interface ReplayItem {
  candidateOutcomeId: string;
  anchorAt: Date;
  brief: string;
}

/**
 * The past alerts a replay re-asks about: high-conviction calls sent in [from, to) on any ledger -
 * the population the live reviewer judges (reviewPriority) - whose label window has closed, one
 * per anchor and one per token, newest first, at most `take`. Each comes back briefed as the live
 * reviewer would have seen it.
 */
export async function loadReplayItems(
  env: Env,
  range: { from: Date; to: Date; take: number },
): Promise<ReplayItem[]> {
  const alerts = await prisma.curatedAlert.findMany({
    where: {
      createdAt: { gte: range.from, lt: range.to },
      tier: HIGH_CONVICTION_TIER,
      candidateOutcome: { is: { finalizedAt: { not: null } } },
    },
    orderBy: { createdAt: "desc" },
    take: range.take * 4,
    select: {
      source: true,
      confidence: true,
      calibratedPct: true,
      reasons: true,
      tier: true,
      snapshot: { select: { riskFlags: true } },
      candidateOutcome: {
        select: {
          id: true,
          anchorAt: true,
          anchorPriceUsd: true,
          anchorMcapUsd: true,
          labelRule: true,
          features: true,
        },
      },
      token: {
        select: {
          id: true,
          mintAddress: true,
          symbol: true,
          name: true,
          description: true,
          narrativeTags: true,
          hasTwitter: true,
          hasTelegram: true,
          hasWebsite: true,
        },
      },
    },
  });

  const seen = new Set<string>();
  const seenTokens = new Set<string>();
  const picked = alerts.filter((a) => {
    const id = a.candidateOutcome?.id;
    // Live, a token is reviewed once however many seats call it (curatedAlerts.ts reviewOnce).
    if (!id || seen.has(id) || seenTokens.has(a.token.id)) return false;
    // Launcher text written to steer the reviewer is passed on live without asking the model
    // (reviewer.ts reviewPick), and that pass stays out of the judge's record: replaying it would
    // send the steering text to the model and grade a verdict the live reviewer never gives.
    if (
      launcherTextInstructs({
        symbol: a.token.symbol ?? undefined,
        name: a.token.name ?? undefined,
        description: a.token.description ?? undefined,
      })
    ) {
      return false;
    }
    // A token the safety screen now rejects is never put to the reviewer live, so it is not replayed.
    if (!passesWalletSafetyCuts(a.candidateOutcome!.features as Record<string, number | null>)) return false;
    if (
      isPreFeeWalletStonksRow(
        a.candidateOutcome!.anchorAt,
        a.candidateOutcome!.features as Record<string, number | null>,
      )
    )
      return false;
    seen.add(id);
    seenTokens.add(a.token.id);
    return true;
  });
  const chosen = picked.slice(0, range.take);
  if (chosen.length === 0) return [];

  const oldest = Math.min(...chosen.map((a) => a.candidateOutcome!.anchorAt.getTime()));
  const pool = await loadGradedPool(env, {
    from: new Date(oldest - COMPARABLE_POOL_DAYS * 86_400_000),
    to: range.to,
    take: REPLAY_POOL_MAX_ROWS,
  });

  return chosen.map((a) => {
    const co = a.candidateOutcome!;
    const features = co.features as Record<string, number | null>;
    const scored: ScoredToken = {
      ...replayedMarket(features, co),
      mintAddress: a.token.mintAddress,
      symbol: a.token.symbol ?? undefined,
      name: a.token.name ?? undefined,
      description: a.token.description ?? undefined,
      narrativeTags: a.token.narrativeTags,
      riskFlags: a.snapshot?.riskFlags,
      // The pool's open time, back from the recorded pair age, so the brief reads it as it stood.
      pairCreatedAt:
        typeof features.pairAgeMinutes === "number"
          ? new Date(co.anchorAt.getTime() - features.pairAgeMinutes * 60_000)
          : undefined,
    };
    for (const k of BRIEF_WALLET_FIELDS) {
      const v = features[k];
      if (typeof v === "number") scored[k] = v;
    }
    // A row from before the vector banked them with transfers counted holds another definition.
    if (co.anchorAt < HOLDER_TRANSFER_LINKS_READ_SINCE) {
      delete scored.kolBundledPct;
      delete scored.linkedCreatorPct;
    }
    // A row from before the percentile banks the raw risk score: not put to the brief as a percentile.
    if (isRawWalletRiskRow(co.anchorAt, features)) delete scored.walletRiskTop10Max;
    const decision: CurationDecision = {
      curate: true,
      tier: a.tier === "high" ? "high" : undefined,
      confidence: a.confidence,
      calibratedPct: a.calibratedPct ?? undefined,
      reasons: a.reasons,
      source: a.source,
    };
    return {
      candidateOutcomeId: co.id,
      anchorAt: co.anchorAt,
      brief: buildAiReviewBrief(scored, decision, comparablesAsOf(features, pool, co.anchorAt), co.anchorAt),
    };
  });
}

/**
 * The token's market as the decision saw it. A call graded from a fresh quote (labelRule
 * FRESH_ANCHOR_LABEL_RULE) is anchored on the quote's price, and DexScreener's lagging price is
 * that over 1 + freshGapPct (the decision row's own gap): both are put back, so the brief shows the
 * two market caps the live one did instead of the quote alone as "market cap".
 */
export function replayedMarket(
  features: Record<string, number | null>,
  co: { anchorAt: Date; anchorPriceUsd: number; anchorMcapUsd: number; labelRule: number },
): ScoredToken {
  const gap = features.freshGapPct;
  if (co.labelRule !== FRESH_ANCHOR_LABEL_RULE || typeof gap !== "number" || !(1 + gap / 100 > 0)) {
    return scoredFromFeatures(features, co.anchorPriceUsd, co.anchorMcapUsd);
  }
  const lag = 1 + gap / 100;
  return {
    ...scoredFromFeatures(features, co.anchorPriceUsd / lag, co.anchorMcapUsd / lag),
    freshQuote: { priceUsd: co.anchorPriceUsd, marketCapUsd: co.anchorMcapUsd, fetchedAt: co.anchorAt },
  };
}

/** The pick's nearest graded rows among those whose outcome was already known at `at`. */
function comparablesAsOf(
  features: Record<string, number | null>,
  pool: DatedGradedRow[],
  at: Date,
): ReturnType<typeof nearestOutcomes> {
  return nearestOutcomes(features, comparablesKnowableAt(pool, at), COMPARABLES_K);
}

/** custom_id: the playbook's position in the run, then the alert's anchor row. */
const customId = (playbookIndex: number, candidateOutcomeId: string) =>
  `p${playbookIndex}-${candidateOutcomeId}`;

function parseCustomId(id: string): { playbookIndex: number; candidateOutcomeId: string } | null {
  const m = /^p(\d+)-(.+)$/.exec(id);
  return m ? { playbookIndex: Number(m[1]), candidateOutcomeId: m[2]! } : null;
}

/**
 * What one replay request is expected to cost: the last scored run's real cost per request, or,
 * before any, a live review's estimate at the Batches API's half price.
 */
export async function replayRequestUsd(env: Env): Promise<number> {
  const last = await prisma.aiReplayRun.findFirst({
    where: { status: "scored", costUsd: { not: null }, requestCount: { gt: 0 }, model: env.AI_REVIEW_MODEL },
    orderBy: { createdAt: "desc" },
    select: { costUsd: true, requestCount: true },
  });
  if (last?.costUsd) return last.costUsd / last.requestCount;
  return estimateCallUsd("review", env.AI_REVIEW_MODEL) * 0.5;
}

export type SubmitReplayResult =
  { runId: string } | { runId: null; reason: "nothing-to-replay" | "over-budget" | "submit-failed" };

/**
 * Submits one replay: every item under every playbook, as one Message Batch. Records the run
 * first so a failed submit is visible. A replay is background work on the daily AI budget: the
 * items are trimmed to what the budget left above the high-conviction reserve can pay for, and
 * when that is fewer than `minItems` nothing is sent ("over-budget").
 */
export async function submitReplay(
  env: Env,
  opts: {
    purpose: "baseline" | "evolution";
    playbooks: { id: string; text: string }[];
    items: ReplayItem[];
    window: { from: Date; to: Date };
    /** The fewest items worth replaying; fewer affordable and the replay waits. Default 1. */
    minItems?: number;
  },
): Promise<SubmitReplayResult> {
  if (opts.items.length === 0 || opts.playbooks.length === 0) {
    return { runId: null, reason: "nothing-to-replay" };
  }
  const perRequestUsd = await replayRequestUsd(env);
  const affordable = Math.floor(
    (await aiBudgetRoomUsd(env, "background")) / (perRequestUsd * opts.playbooks.length),
  );
  // Every playbook sees the same items, so the caps trim items, never one playbook's share.
  const items = opts.items.slice(
    0,
    Math.min(Math.floor(MAX_BATCH_REQUESTS / opts.playbooks.length), affordable),
  );
  if (items.length < Math.max(1, opts.minItems ?? 1)) {
    logger.info("ai replay waits for budget", {
      purpose: opts.purpose,
      affordable,
      wanted: opts.items.length,
    });
    return { runId: null, reason: "over-budget" };
  }
  const { type, schema } = zodOutputFormat(VerdictSchema);
  const requests = opts.playbooks.flatMap((playbook, p) => {
    const system = aiReviewSystemPrompt(playbook.text, env.AI_REVIEW_BUY_MIN_PROBABILITY);
    return items.map((item) => ({
      custom_id: customId(p, item.candidateOutcomeId),
      params: {
        model: env.AI_REVIEW_MODEL,
        max_tokens: 16000,
        system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
        messages: [{ role: "user" as const, content: item.brief }],
        output_config: { effort: env.AI_REVIEW_EFFORT, format: { type, schema } },
      },
    }));
  });

  const estimatedCostUsd = perRequestUsd * requests.length;
  const reservation = await reserveAiSpend(env, "replay", estimatedCostUsd, "background");
  if (!reservation) return { runId: null, reason: "over-budget" };
  const run = await prisma.aiReplayRun.create({
    data: {
      purpose: opts.purpose,
      status: "submitted",
      model: env.AI_REVIEW_MODEL,
      playbookIds: opts.playbooks.map((p) => p.id),
      windowStart: opts.window.from,
      windowEnd: opts.window.to,
      requestCount: requests.length,
      estimatedCostUsd,
    },
  });
  try {
    // No retry: a timeout after the batch was created would submit a second one and bill both,
    // against the one reservation made above. A batch that was never created bills nothing.
    const batch = await anthropicClient(env).messages.batches.create({ requests }, { maxRetries: 0 });
    await prisma.aiReplayRun.update({ where: { id: run.id }, data: { batchId: batch.id } });
    logger.info("ai replay submitted", {
      run: run.id,
      purpose: opts.purpose,
      requests: requests.length,
      batch: batch.id,
    });
    return { runId: run.id };
  } catch (err) {
    // A batch that was never created runs nothing and bills nothing.
    await settleAiSpend(reservation, 0);
    const error = describeAnthropicError(err);
    await prisma.aiReplayRun.update({
      where: { id: run.id },
      data: { status: "failed", error, costUsd: 0 },
    });
    logger.warn("ai replay submit failed", { run: run.id, error });
    return { runId: null, reason: "submit-failed" };
  }
}

/** One batch result as a stored verdict row; null when its custom_id names no playbook of the run. */
export function replayVerdictRow(
  runId: string,
  playbookIds: string[],
  result: MessageBatchIndividualResponse,
  /** The buy bar the live reviewer is held to (AI_REVIEW_BUY_MIN_PROBABILITY); none when omitted. */
  buyMinProbability?: number,
): {
  runId: string;
  playbookId: string;
  candidateOutcomeId: string;
  decision: string | null;
  probability2x: number | null;
  probability4x: number | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
} | null {
  const id = parseCustomId(result.custom_id);
  const playbookId = id ? playbookIds[id.playbookIndex] : undefined;
  if (!id || !playbookId) return null;
  const base = {
    runId,
    playbookId,
    candidateOutcomeId: id.candidateOutcomeId,
    decision: null,
    probability2x: null,
    probability4x: null,
    inputTokens: null,
    outputTokens: null,
  };
  if (result.result.type !== "succeeded") return { ...base, error: result.result.type };
  const message = result.result.message;
  const usage = { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  if (message.stop_reason === "refusal") {
    return { ...base, ...usage, error: `refused: ${message.stop_details?.category ?? "unknown"}` };
  }
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let parsed: ReturnType<typeof VerdictSchema.safeParse>;
  try {
    parsed = VerdictSchema.safeParse(JSON.parse(text));
  } catch {
    return { ...base, ...usage, error: "unparsable verdict" };
  }
  if (!parsed.success) return { ...base, ...usage, error: "unparsable verdict" };
  const verdict = verdictFromParsed(parsed.data, buyMinProbability);
  return {
    ...base,
    ...usage,
    decision: verdict.decision,
    probability2x: verdict.probability2x,
    probability4x: verdict.probability4x,
    error: null,
  };
}

export interface ScoredReplayRun {
  id: string;
  purpose: string;
  playbookIds: string[];
  summaries: Record<string, JudgeRecordSummary>;
}

/**
 * Checks every submitted run's batch; for each that has ended, stores its verdicts, grades them
 * by the alerts' labels and records a summary per playbook. Returns the runs scored this pass.
 * A run whose batch can't be read is retried next pass; one with no batch id is failed.
 *
 * `signal` aborts a pass whose job lock was lost (aiJudgeJob). A run not yet marked scored is
 * left submitted: the next pass deletes its partial verdicts and ingests again. Marking scored
 * is a conditional update, so two overlapping passes cannot both settle the same batch.
 */
export async function pollReplayRuns(env: Env, signal?: AbortSignal): Promise<ScoredReplayRun[]> {
  const runs = await prisma.aiReplayRun.findMany({ where: { status: "submitted" } });
  const scored: ScoredReplayRun[] = [];
  for (const run of runs) {
    if (signal?.aborted) return scored;
    if (!run.batchId) {
      await prisma.aiReplayRun.update({
        where: { id: run.id },
        data: { status: "failed", error: "no batch" },
      });
      continue;
    }
    try {
      const client = anthropicClient(env);
      const batch = await client.messages.batches.retrieve(run.batchId);
      if (batch.processing_status !== "ended") continue;

      // Replace rather than append, so a pass that died half-way through ingesting is redone whole.
      await prisma.aiReplayVerdict.deleteMany({ where: { runId: run.id } });
      let buffer: NonNullable<ReturnType<typeof replayVerdictRow>>[] = [];
      let costUsd = 0;
      for await (const result of await client.messages.batches.results(run.batchId)) {
        // Stop before writing more of a batch another process may now be ingesting. The next
        // pass deletes these rows and starts the ingest over.
        if (signal?.aborted) return scored;
        // Only requests that ran are billed, at batch rates.
        if (result.result.type === "succeeded") {
          const message = result.result.message;
          costUsd += usageCostUsd([run.model, message.model], message.usage, { batch: true });
        }
        const row = replayVerdictRow(run.id, run.playbookIds, result, env.AI_REVIEW_BUY_MIN_PROBABILITY);
        if (row) buffer.push(row);
        if (buffer.length >= 500) {
          if (signal?.aborted) return scored;
          await prisma.aiReplayVerdict.createMany({ data: buffer });
          buffer = [];
        }
      }
      // The lock can be lost while the last results stream in, and the process that took it may
      // already have cleared this run's verdicts: a write now would sit beside its own as
      // duplicates (no unique key on a verdict), so every write checks first.
      if (signal?.aborted) return scored;
      if (buffer.length > 0) await prisma.aiReplayVerdict.createMany({ data: buffer });

      if (signal?.aborted) return scored;
      const summaries = await summarizeRun(run.id, run.playbookIds, env);
      // Only the pass that moves the row off "submitted" settles it. A second pass that ingested
      // the same batch (the lock was lost) finds the row already scored and does not charge again.
      if (signal?.aborted) return scored;
      const claimed = await prisma.aiReplayRun.updateMany({
        where: { id: run.id, status: "submitted" },
        data: { status: "scored", scoredAt: new Date(), metrics: summaries as object, costUsd },
      });
      if (claimed.count !== 1) {
        logger.info("ai replay already scored by another run", { run: run.id });
        continue;
      }
      // True the day's budget up from the reservation made at submit to what the batch cost -
      // after the run is marked scored, so a pass that dies half-way can't count it twice. A run
      // from before the ledger existed reserved nothing, and is charged in full.
      await settleAiSpend(
        {
          day: aiSpendDay(run.createdAt),
          source: "replay",
          estimateUsd: run.estimatedCostUsd ?? 0,
          capUsd: env.AI_DAILY_BUDGET_USD,
        },
        costUsd,
      );
      logger.info("ai replay scored", { run: run.id, purpose: run.purpose, summaries });
      scored.push({ id: run.id, purpose: run.purpose, playbookIds: run.playbookIds, summaries });
    } catch (err) {
      const error = describeAnthropicError(err);
      // A batch ends within 24h and its results are kept for 29 days, so one still unreadable
      // days later (a changed key, a deleted batch) never will be. Failed, it stops holding up
      // every later round (maybeEvolvePlaybook waits while any run is "submitted"). Its
      // reservation stays charged to the day it was made.
      if (Date.now() - run.createdAt.getTime() >= UNREADABLE_BATCH_GIVE_UP_MS) {
        await prisma.aiReplayRun.update({
          where: { id: run.id },
          data: { status: "failed", error: `batch unreadable: ${error}`.slice(0, 500) },
        });
        logger.warn("ai replay batch unreadable for days - marking it failed", { run: run.id, error });
        continue;
      }
      logger.warn("could not read ai replay batch - retrying next pass", { run: run.id, error });
    }
  }
  return scored;
}

/** Each playbook's record on a run, graded by the alerts' own labels. */
async function summarizeRun(
  runId: string,
  playbookIds: string[],
  env: Env,
): Promise<Record<string, JudgeRecordSummary>> {
  const verdicts = await prisma.aiReplayVerdict.findMany({
    where: { runId },
    select: { playbookId: true, candidateOutcomeId: true, decision: true, probability2x: true },
  });
  const labels = await gradedLabels([...new Set(verdicts.map((v) => v.candidateOutcomeId))]);
  const targets = blendTargets(env);
  const out: Record<string, JudgeRecordSummary> = {};
  for (const playbookId of playbookIds) {
    const calls: JudgedCall[] = verdicts.flatMap((v) => {
      const label = labels.get(v.candidateOutcomeId);
      if (v.playbookId !== playbookId || label === undefined) return [];
      return [
        {
          decision: v.decision === "buy" || v.decision === "no_buy" ? v.decision : null,
          probability2x: v.probability2x,
          labelValue: label,
        },
      ];
    });
    out[playbookId] = summarizeJudgeRecord(calls, targets);
  }
  return out;
}

/** labelValue per finalized CandidateOutcome id. */
export async function gradedLabels(ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 1_000) {
    const rows = await prisma.candidateOutcome.findMany({
      where: { id: { in: ids.slice(i, i + 1_000) }, finalizedAt: { not: null } },
      select: { id: true, labelValue: true },
    });
    for (const r of rows) out.set(r.id, r.labelValue ?? 0);
  }
  return out;
}
