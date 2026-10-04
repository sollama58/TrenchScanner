import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";
import {
  prisma,
  createLogger,
  aiReviewSystemPrompt,
  buildAiReviewBrief,
  nearestOutcomes,
  scoredFromFeatures,
  summarizeJudgeRecord,
  type CurationDecision,
  type Env,
  type JudgeRecordSummary,
  type JudgedCall,
} from "@trenchscanner/core";
import { anthropicClient, describeAnthropicError } from "./client.js";
import { blendTargets } from "./blend.js";
import {
  COMPARABLES_K,
  COMPARABLE_POOL_DAYS,
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
 * Known gaps from live: RugCheck flag strings and the curator's reasons are what the alert row
 * kept, and narrative tags/description are the token's current ones. The numbers are the alert's
 * own stored feature vector.
 */

/** A pool row counts as known at time t once its 1h label window (plus slack) has closed. */
const LABEL_SETTLE_MS = 65 * 60_000;
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
 * The past alerts a replay re-asks about: curated alerts sent in [from, to) on any ledger - the
 * population the reviewer exists to filter - whose label window has closed, one per anchor,
 * newest first, at most `take`. Each comes back briefed as the live reviewer would have seen it.
 */
export async function loadReplayItems(
  env: Env,
  range: { from: Date; to: Date; take: number },
): Promise<ReplayItem[]> {
  const alerts = await prisma.curatedAlert.findMany({
    where: {
      createdAt: { gte: range.from, lt: range.to },
      candidateOutcome: { is: { finalizedAt: { not: null } } },
    },
    orderBy: { createdAt: "desc" },
    take: range.take * 4,
    select: {
      source: true,
      confidence: true,
      reasons: true,
      candidateOutcome: {
        select: { id: true, anchorAt: true, anchorPriceUsd: true, anchorMcapUsd: true, features: true },
      },
      token: {
        select: {
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
  const picked = alerts.filter((a) => {
    const id = a.candidateOutcome?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
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
    const scored = {
      ...scoredFromFeatures(features, co.anchorPriceUsd, co.anchorMcapUsd),
      mintAddress: a.token.mintAddress,
      symbol: a.token.symbol ?? undefined,
      name: a.token.name ?? undefined,
      description: a.token.description ?? undefined,
      narrativeTags: a.token.narrativeTags,
    };
    const decision: CurationDecision = {
      curate: true,
      confidence: a.confidence,
      reasons: a.reasons,
      source: a.source,
    };
    return {
      candidateOutcomeId: co.id,
      anchorAt: co.anchorAt,
      brief: buildAiReviewBrief(scored, decision, comparablesAsOf(features, pool, co.anchorAt)),
    };
  });
}

/** The pick's nearest graded rows among those whose outcome was already known at `at`. */
function comparablesAsOf(
  features: Record<string, number | null>,
  pool: DatedGradedRow[],
  at: Date,
): ReturnType<typeof nearestOutcomes> {
  const settled = at.getTime() - LABEL_SETTLE_MS;
  const earliest = at.getTime() - COMPARABLE_POOL_DAYS * 86_400_000;
  const known = pool.filter((r) => {
    const t = r.anchorAt.getTime();
    return t <= settled && t >= earliest;
  });
  return nearestOutcomes(features, known, COMPARABLES_K);
}

/** custom_id: the playbook's position in the run, then the alert's anchor row. */
const customId = (playbookIndex: number, candidateOutcomeId: string) =>
  `p${playbookIndex}-${candidateOutcomeId}`;

function parseCustomId(id: string): { playbookIndex: number; candidateOutcomeId: string } | null {
  const m = /^p(\d+)-(.+)$/.exec(id);
  return m ? { playbookIndex: Number(m[1]), candidateOutcomeId: m[2]! } : null;
}

/**
 * Submits one replay: every item under every playbook, as one Message Batch. Records the run
 * first so a failed submit is visible; returns its id, or null when there was nothing to replay.
 */
export async function submitReplay(
  env: Env,
  opts: {
    purpose: "baseline" | "evolution";
    playbooks: { id: string; text: string }[];
    items: ReplayItem[];
    window: { from: Date; to: Date };
  },
): Promise<string | null> {
  if (opts.items.length === 0 || opts.playbooks.length === 0) return null;
  // Every playbook sees the same items, so the cap trims items, never one playbook's share.
  const items = opts.items.slice(0, Math.floor(MAX_BATCH_REQUESTS / opts.playbooks.length));
  const { type, schema } = zodOutputFormat(VerdictSchema);
  const requests = opts.playbooks.flatMap((playbook, p) => {
    const system = aiReviewSystemPrompt(playbook.text);
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

  const run = await prisma.aiReplayRun.create({
    data: {
      purpose: opts.purpose,
      status: "submitted",
      model: env.AI_REVIEW_MODEL,
      playbookIds: opts.playbooks.map((p) => p.id),
      windowStart: opts.window.from,
      windowEnd: opts.window.to,
      requestCount: requests.length,
    },
  });
  try {
    const batch = await anthropicClient(env).messages.batches.create({ requests });
    await prisma.aiReplayRun.update({ where: { id: run.id }, data: { batchId: batch.id } });
    logger.info("ai replay submitted", {
      run: run.id,
      purpose: opts.purpose,
      requests: requests.length,
      batch: batch.id,
    });
    return run.id;
  } catch (err) {
    const error = describeAnthropicError(err);
    await prisma.aiReplayRun.update({ where: { id: run.id }, data: { status: "failed", error } });
    logger.warn("ai replay submit failed", { run: run.id, error });
    return null;
  }
}

/** One batch result as a stored verdict row; null when its custom_id names no playbook of the run. */
export function replayVerdictRow(
  runId: string,
  playbookIds: string[],
  result: MessageBatchIndividualResponse,
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
  const verdict = verdictFromParsed(parsed.data);
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
 */
export async function pollReplayRuns(env: Env): Promise<ScoredReplayRun[]> {
  const runs = await prisma.aiReplayRun.findMany({ where: { status: "submitted" } });
  const scored: ScoredReplayRun[] = [];
  for (const run of runs) {
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
      for await (const result of await client.messages.batches.results(run.batchId)) {
        const row = replayVerdictRow(run.id, run.playbookIds, result);
        if (row) buffer.push(row);
        if (buffer.length >= 500) {
          await prisma.aiReplayVerdict.createMany({ data: buffer });
          buffer = [];
        }
      }
      if (buffer.length > 0) await prisma.aiReplayVerdict.createMany({ data: buffer });

      const summaries = await summarizeRun(run.id, run.playbookIds, env);
      await prisma.aiReplayRun.update({
        where: { id: run.id },
        data: { status: "scored", scoredAt: new Date(), metrics: summaries as object },
      });
      logger.info("ai replay scored", { run: run.id, purpose: run.purpose, summaries });
      scored.push({ id: run.id, purpose: run.purpose, playbookIds: run.playbookIds, summaries });
    } catch (err) {
      logger.warn("could not read ai replay batch - retrying next pass", {
        run: run.id,
        error: describeAnthropicError(err),
      });
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
