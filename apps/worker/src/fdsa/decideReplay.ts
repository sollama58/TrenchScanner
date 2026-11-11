import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { MessageBatchIndividualResponse } from "@anthropic-ai/sdk/resources/messages/batches";
import {
  createLogger,
  estimateCostUsd,
  fdsaDecideSystemPrompt,
  FDSA_PROMPT_VERSIONS,
  FdsaDecideAnswerSchema,
  isWin,
  prisma,
  readFdsaDecideAnswer,
  usageCostUsd,
  type Env,
} from "@trenchscanner/core";
import { anthropicClient, anthropicConfigured, describeAnthropicError } from "../ai/client.js";
import type { JobRunMeta } from "../scheduler.js";
import { lastTextJson } from "./review.js";

const logger = createLogger("fdsa-decide-replay");

/**
 * The FDSA decide replay (owner decision 2026-11-11, "approve up to $30 via Batches"; model system
 * audit 2026-11-07): the live decide prompt re-asked, through the Message Batches API, about past
 * shortlisted alerts whose label is in, so the decide stage can be judged on hundreds of graded
 * alerts at once instead of the dozens a live week yields - and judged against the scanner
 * model's own odds on the same alerts, the figure the screen shortlists on. Each alert is
 * re-asked with the exact brief its live decide was sent (FdsaReview.brief, kept for this), so
 * the replay sees what the desk saw at the time, nothing later. Two passes over the same alerts:
 * the live effort, and a cheaper one, to tell whether the effort buys ranking.
 *
 * Runs on the trainer when FDSA_DECIDE_REPLAY names a run tag: one replay per tag, the run and its
 * verdicts on AiReplayRun / AiReplayVerdict under purpose "fdsa-decide" (the reviewer's replay
 * tables; its own poll skips this purpose and this one skips the reviewer's). The spend sits
 * outside both daily caps - a one-off, approved on its own - under FDSA_DECIDE_REPLAY_MAX_USD
 * across every tag. Nothing here changes what the desk runs: the scorecard is the heartbeat meta
 * (Admin > Worker, /stats/ops/worker) and the run row.
 */

export const FDSA_DECIDE_REPLAY_PURPOSE = "fdsa-decide";
/** Batch prices are half of live prices. */
const BATCH_PRICE_SHARE = 0.5;
/** Most requests one replay sends - well under the API's limits, keeps the request body small. */
const MAX_BATCH_REQUESTS = 1_000;
/** Fewer affordable alerts than this and the replay is not worth its spend: nothing is sent. */
export const MIN_REPLAY_ITEMS = 50;
/** How long a submitted run's batch may stay unreadable before the run is failed. */
const UNREADABLE_BATCH_GIVE_UP_MS = 3 * 86_400_000;
/** A submit that failed (the key's limit, an outage) is tried again after this long. */
const RETRY_FAILED_SUBMIT_MS = 24 * 3_600_000;
/** Live decide rows whose real cost sets the estimate. */
const COST_SAMPLE_ROWS = 500;
/** The live decide's call shape, for the estimate before any live decide has a recorded cost. */
const DECIDE_PROFILE = { input: 8_000, output: 3_000 };

export type DecideEffort = Env["FDSA_DECIDE_EFFORT"];

export interface DecideReplayVariant {
  /** `<tag>:<effort>`, the AiReplayVerdict.playbookId the variant's verdicts are stored under. */
  id: string;
  effort: DecideEffort;
}

/** The passes a replay makes: the live effort first, then one step cheaper (medium; low under it). */
export function decideReplayVariants(
  env: Pick<Env, "FDSA_DECIDE_EFFORT">,
  tag: string,
): DecideReplayVariant[] {
  const live = env.FDSA_DECIDE_EFFORT;
  const compared: DecideEffort = live === "medium" || live === "low" ? "low" : "medium";
  const out: DecideReplayVariant[] = [{ id: `${tag}:${live}`, effort: live }];
  if (compared !== live) out.push({ id: `${tag}:${compared}`, effort: compared });
  return out;
}

export interface DecideReplayItem {
  candidateOutcomeId: string;
  tokenId: string;
  /** The brief the live decide was sent. */
  brief: string;
  /** When the live decide ran. */
  createdAt: Date;
}

/**
 * The alerts a replay re-asks about: the live decide rows on the current decide prompt whose brief
 * was kept and whose alert's label window has closed, one per token (its latest), newest first,
 * at most `max`. A decide whose call failed still kept its brief, so the alerts the decide
 * stage missed while it was failing (2026-11-05 on) are in the pool too.
 */
export async function loadDecideReplayItems(max: number): Promise<DecideReplayItem[]> {
  const version = FDSA_PROMPT_VERSIONS.decide;
  return prisma.$queryRaw<DecideReplayItem[]>`
    SELECT "candidateOutcomeId", "tokenId", brief, "createdAt" FROM (
      SELECT DISTINCT ON (r."tokenId") r."tokenId", r."candidateOutcomeId", r.brief, r."createdAt"
      FROM "FdsaReview" r JOIN "CandidateOutcome" c ON c.id = r."candidateOutcomeId"
      WHERE r.stage = 'decide' AND r."promptVersion" = ${version} AND r.brief IS NOT NULL
        AND c."finalizedAt" IS NOT NULL
      ORDER BY r."tokenId", r."createdAt" DESC
    ) latest
    ORDER BY "createdAt" DESC
    LIMIT ${Math.max(1, Math.floor(max))}`;
}

/** What every replay so far cost, or was expected to: the cap counts both. */
export async function decideReplaySpentUsd(): Promise<number> {
  const runs = await prisma.aiReplayRun.findMany({
    where: { purpose: FDSA_DECIDE_REPLAY_PURPOSE, status: { in: ["submitted", "scored"] } },
    select: { costUsd: true, estimatedCostUsd: true },
  });
  return runs.reduce((s, r) => s + (r.costUsd ?? r.estimatedCostUsd ?? 0), 0);
}

/**
 * What one replayed decide is expected to cost: the live decide's mean recorded cost on the same
 * model, at the batch price - or, before any, the call shape's estimate (ai/budget.ts profile).
 */
export async function decideReplayRequestUsd(env: Pick<Env, "FDSA_DECIDE_MODEL">): Promise<number> {
  const rows = await prisma.fdsaReview.findMany({
    where: { stage: "decide", model: env.FDSA_DECIDE_MODEL, error: null, costUsd: { gt: 0 } },
    orderBy: { createdAt: "desc" },
    take: COST_SAMPLE_ROWS,
    select: { costUsd: true },
  });
  const live =
    rows.length > 0
      ? rows.reduce((s, r) => s + (r.costUsd ?? 0), 0) / rows.length
      : estimateCostUsd(env.FDSA_DECIDE_MODEL, DECIDE_PROFILE);
  return live * BATCH_PRICE_SHARE;
}

function customId(variant: number, candidateOutcomeId: string): string {
  return `v${variant}-${candidateOutcomeId}`;
}

function parseCustomId(id: string): { variant: number; candidateOutcomeId: string } | null {
  const m = /^v(\d+)-(.+)$/.exec(id);
  return m ? { variant: Number(m[1]), candidateOutcomeId: m[2]! } : null;
}

export type SubmitDecideReplayResult =
  | { runId: string; items: number; requests: number; estimatedCostUsd: number }
  | { runId: null; reason: "nothing-to-replay" | "over-cap" | "submit-failed"; affordable?: number };

/**
 * Submits one replay as one Message Batch: every item under every variant. The items are trimmed
 * to what the cap leaves (FDSA_DECIDE_REPLAY_MAX_USD less every earlier run) and to
 * FDSA_DECIDE_REPLAY_ITEMS; fewer than MIN_REPLAY_ITEMS affordable and nothing is sent. The run is
 * recorded before the batch is created, so a failed submit is visible.
 */
export async function submitDecideReplay(
  env: Env,
  opts: { tag: string; items: DecideReplayItem[] },
): Promise<SubmitDecideReplayResult> {
  const variants = decideReplayVariants(env, opts.tag);
  if (opts.items.length === 0) return { runId: null, reason: "nothing-to-replay" };
  const perRequestUsd = await decideReplayRequestUsd(env);
  const room = env.FDSA_DECIDE_REPLAY_MAX_USD - (await decideReplaySpentUsd());
  const affordable = Math.max(0, Math.floor(room / (perRequestUsd * variants.length)));
  const items = opts.items.slice(
    0,
    Math.min(env.FDSA_DECIDE_REPLAY_ITEMS, Math.floor(MAX_BATCH_REQUESTS / variants.length), affordable),
  );
  if (items.length < MIN_REPLAY_ITEMS) {
    logger.warn("FDSA decide replay not sent: the cap leaves too few alerts", {
      tag: opts.tag,
      affordable,
      wanted: opts.items.length,
      perRequestUsd,
    });
    return { runId: null, reason: "over-cap", affordable };
  }

  const { type, schema } = zodOutputFormat(FdsaDecideAnswerSchema);
  // The live decide's own prompt: the bar and the share are the env values the desk runs under.
  const system = fdsaDecideSystemPrompt(env.FDSA_TRADE_MIN_P2X, env.FDSA_TRADE_TOP_PCT);
  const requests = variants.flatMap((variant, v) =>
    items.map((item) => ({
      custom_id: customId(v, item.candidateOutcomeId),
      params: {
        model: env.FDSA_DECIDE_MODEL,
        max_tokens: 16_000,
        thinking: { type: "adaptive" as const },
        system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
        messages: [{ role: "user" as const, content: item.brief }],
        output_config: { effort: variant.effort, format: { type, schema } },
      },
    })),
  );
  const estimatedCostUsd = perRequestUsd * requests.length;
  const createdAts = items.map((i) => i.createdAt.getTime());
  const run = await prisma.aiReplayRun.create({
    data: {
      purpose: FDSA_DECIDE_REPLAY_PURPOSE,
      status: "submitted",
      model: env.FDSA_DECIDE_MODEL,
      playbookIds: variants.map((v) => v.id),
      windowStart: new Date(Math.min(...createdAts)),
      windowEnd: new Date(Math.max(...createdAts)),
      requestCount: requests.length,
      estimatedCostUsd,
    },
  });
  try {
    // No retry: a timeout after the batch was created would submit a second one and bill both.
    const batch = await anthropicClient(env).messages.batches.create({ requests }, { maxRetries: 0 });
    await prisma.aiReplayRun.update({ where: { id: run.id }, data: { batchId: batch.id } });
    logger.info("FDSA decide replay submitted", {
      run: run.id,
      tag: opts.tag,
      items: items.length,
      requests: requests.length,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100) / 100,
      batch: batch.id,
    });
    return { runId: run.id, items: items.length, requests: requests.length, estimatedCostUsd };
  } catch (err) {
    // A batch that was never created runs nothing and bills nothing.
    const error = describeAnthropicError(err);
    await prisma.aiReplayRun.update({
      where: { id: run.id },
      data: { status: "failed", error, costUsd: 0 },
    });
    logger.warn("FDSA decide replay submit failed", { run: run.id, tag: opts.tag, error });
    return { runId: null, reason: "submit-failed" };
  }
}

/** One batch result as a stored verdict row; null when its custom_id names no variant of the run. */
export function decideReplayVerdictRow(
  runId: string,
  variantIds: string[],
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
  const parsed = parseCustomId(result.custom_id);
  const playbookId = parsed === null ? undefined : variantIds[parsed.variant];
  if (!parsed || playbookId === undefined) return null;
  const base = { runId, playbookId, candidateOutcomeId: parsed.candidateOutcomeId };
  if (result.result.type !== "succeeded") {
    return {
      ...base,
      decision: null,
      probability2x: null,
      probability4x: null,
      error: result.result.type === "errored" ? `errored: ${result.result.error.type}` : result.result.type,
      inputTokens: null,
      outputTokens: null,
    };
  }
  const message = result.result.message;
  const raw = message.stop_reason === "refusal" ? null : lastTextJson(message.content);
  // The model's own word and odds (no bar, no ranked line): the summary ranks the odds itself.
  const read = readFdsaDecideAnswer(raw, { stopReason: message.stop_reason ?? null });
  const answered = read.error === null || read.error === "trade without a usable exit plan";
  return {
    ...base,
    decision: answered ? read.verdict.decision : null,
    probability2x: answered ? read.verdict.probability2x : null,
    probability4x: answered ? read.verdict.probability4x : null,
    error: read.error,
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

/** One replayed verdict beside its alert's label and the scanner model's own odds for it. */
export interface GradedDecideReplayRow {
  variantId: string;
  candidateOutcomeId: string;
  decision: string | null;
  probability2x: number | null;
  /** The alert's graded label: 0 = loss, log2(peak multiple) for a clean win. */
  labelValue: number;
  /** The alerting model's calibrated 2x rate, in percent, when the alert row kept one. */
  modelPct: number | null;
}

export interface DecideReplayVariantSummary {
  /** Graded alerts the variant answered. */
  answered: number;
  /** Requests that came back unusable (no answer, a refusal, an error). */
  errors: number;
  /** The pool's own 2x rate, %. */
  baseWinRatePct: number | null;
  /** The model said "trade": how many, and how they did, %. */
  trades: number;
  tradeWinRatePct: number | null;
  /** The desk's rule: the top FDSA_TRADE_TOP_PCT of the pool by probability2x. */
  ranked: number;
  rankedWinRatePct: number | null;
  /** How well probability2x orders winners above losers: 0.5 is chance. */
  auc: number | null;
  /** Mean squared error of probability2x against the 2x outcome; 0.25 is a coin. */
  brier: number | null;
  meanProbability2xPct: number | null;
  /** The scanner model's odds on the same alerts, read the same two ways. */
  modelAuc: number | null;
  modelRankedWinRatePct: number | null;
  /** Against the first variant (the live effort): same "trade"/"pass" word, and shared ranked picks, %. */
  agreesWithLivePct: number | null;
  rankedOverlapPct: number | null;
}

const pct = (hits: number, n: number) => (n > 0 ? Math.round((hits / n) * 1000) / 10 : null);
const won = (r: { labelValue: number }) => isWin(r);

/** The area under the ROC curve by rank sums; ties count half. Null without both outcomes. */
export function rocAuc(rows: readonly { score: number; won: boolean }[]): number | null {
  const sorted = [...rows].sort((a, b) => a.score - b.score);
  let positives = 0;
  let rankSum = 0;
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j]!.score === sorted[i]!.score) j++;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k++) {
      if (sorted[k]!.won) {
        positives += 1;
        rankSum += rank;
      }
    }
    i = j;
  }
  const negatives = sorted.length - positives;
  if (positives === 0 || negatives === 0) return null;
  return Math.round(((rankSum - (positives * (positives + 1)) / 2) / (positives * negatives)) * 1000) / 1000;
}

/** The ids of the top `topPct` percent of `rows` by `score`, at least one when the share is set. */
function topShare<T extends { candidateOutcomeId: string }>(
  rows: readonly T[],
  score: (r: T) => number,
  topPct: number,
): Set<string> {
  if (topPct <= 0 || rows.length === 0) return new Set();
  const take = Math.max(1, Math.round((rows.length * topPct) / 100));
  return new Set(
    [...rows]
      .sort((a, b) => score(b) - score(a))
      .slice(0, take)
      .map((r) => r.candidateOutcomeId),
  );
}

/** Each variant's record on a run, graded by the alerts' own labels - see DecideReplayVariantSummary. */
export function summarizeDecideReplay(
  rows: readonly GradedDecideReplayRow[],
  variantIds: readonly string[],
  topPct: number,
): Record<string, DecideReplayVariantSummary> {
  const out: Record<string, DecideReplayVariantSummary> = {};
  const live = variantIds[0];
  const liveRows = new Map(rows.filter((r) => r.variantId === live).map((r) => [r.candidateOutcomeId, r]));
  const liveAnswered = [...liveRows.values()].filter((r) => r.probability2x !== null);
  const liveRanked = topShare(liveAnswered, (r) => r.probability2x!, topPct);
  for (const variantId of variantIds) {
    const mine = rows.filter((r) => r.variantId === variantId);
    const answered = mine.filter((r) => r.probability2x !== null);
    const trades = answered.filter((r) => r.decision === "trade");
    const ranked = topShare(answered, (r) => r.probability2x!, topPct);
    const rankedRows = answered.filter((r) => ranked.has(r.candidateOutcomeId));
    const withModel = answered.filter((r) => r.modelPct !== null);
    const modelRanked = topShare(withModel, (r) => r.modelPct!, topPct);
    const modelRankedRows = withModel.filter((r) => modelRanked.has(r.candidateOutcomeId));
    const compared =
      variantId === live
        ? []
        : answered.flatMap((r) => {
            const other = liveRows.get(r.candidateOutcomeId);
            return other && other.probability2x !== null ? [{ mine: r, live: other }] : [];
          });
    out[variantId] = {
      answered: answered.length,
      errors: mine.length - answered.length,
      baseWinRatePct: pct(answered.filter(won).length, answered.length),
      trades: trades.length,
      tradeWinRatePct: pct(trades.filter(won).length, trades.length),
      ranked: rankedRows.length,
      rankedWinRatePct: pct(rankedRows.filter(won).length, rankedRows.length),
      auc: rocAuc(answered.map((r) => ({ score: r.probability2x!, won: won(r) }))),
      brier:
        answered.length === 0
          ? null
          : Math.round(
              (answered.reduce((s, r) => s + (r.probability2x! - (won(r) ? 1 : 0)) ** 2, 0) /
                answered.length) *
                1000,
            ) / 1000,
      meanProbability2xPct:
        answered.length === 0
          ? null
          : Math.round((answered.reduce((s, r) => s + r.probability2x!, 0) / answered.length) * 1000) / 10,
      modelAuc: rocAuc(withModel.map((r) => ({ score: r.modelPct!, won: won(r) }))),
      modelRankedWinRatePct: pct(modelRankedRows.filter(won).length, modelRankedRows.length),
      agreesWithLivePct:
        variantId === live
          ? null
          : pct(compared.filter((c) => c.mine.decision === c.live.decision).length, compared.length),
      rankedOverlapPct:
        variantId === live
          ? null
          : pct(
              [...ranked].filter((id) => liveRanked.has(id)).length,
              Math.max(ranked.size, liveRanked.size),
            ),
    };
  }
  return out;
}

/** The run's verdicts beside their labels and the alerting model's odds. */
async function gradedRows(runId: string): Promise<GradedDecideReplayRow[]> {
  const verdicts = await prisma.aiReplayVerdict.findMany({
    where: { runId },
    select: { playbookId: true, candidateOutcomeId: true, decision: true, probability2x: true },
  });
  const ids = [...new Set(verdicts.map((v) => v.candidateOutcomeId))];
  const labels = new Map<string, number>();
  const modelPct = new Map<string, number | null>();
  for (let i = 0; i < ids.length; i += 1_000) {
    const slice = ids.slice(i, i + 1_000);
    const outcomes = await prisma.candidateOutcome.findMany({
      where: { id: { in: slice }, finalizedAt: { not: null } },
      select: { id: true, labelValue: true },
    });
    for (const o of outcomes) labels.set(o.id, o.labelValue ?? 0);
    const reviews = await prisma.fdsaReview.findMany({
      where: { candidateOutcomeId: { in: slice }, stage: "decide", brief: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { candidateOutcomeId: true, curatedAlert: { select: { calibratedPct: true } } },
    });
    for (const r of reviews) {
      if (r.candidateOutcomeId && !modelPct.has(r.candidateOutcomeId)) {
        modelPct.set(r.candidateOutcomeId, r.curatedAlert?.calibratedPct ?? null);
      }
    }
  }
  return verdicts.flatMap((v) => {
    const labelValue = labels.get(v.candidateOutcomeId);
    if (labelValue === undefined) return [];
    return [
      {
        variantId: v.playbookId,
        candidateOutcomeId: v.candidateOutcomeId,
        decision: v.decision,
        probability2x: v.probability2x,
        labelValue,
        modelPct: modelPct.get(v.candidateOutcomeId) ?? null,
      },
    ];
  });
}

export interface ScoredDecideReplay {
  id: string;
  variantIds: string[];
  costUsd: number;
  summaries: Record<string, DecideReplayVariantSummary>;
}

/**
 * Checks every submitted replay's batch; for each that has ended, stores its verdicts, grades them
 * and records a summary per variant on the run. A batch not yet ended is left for the next pass;
 * one unreadable for days is failed (as the reviewer's replay does).
 */
export async function pollDecideReplayRuns(env: Env): Promise<ScoredDecideReplay[]> {
  const runs = await prisma.aiReplayRun.findMany({
    where: { purpose: FDSA_DECIDE_REPLAY_PURPOSE, status: "submitted" },
  });
  const scored: ScoredDecideReplay[] = [];
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
      let buffer: NonNullable<ReturnType<typeof decideReplayVerdictRow>>[] = [];
      let costUsd = 0;
      for await (const result of await client.messages.batches.results(run.batchId)) {
        if (result.result.type === "succeeded") {
          const message = result.result.message;
          costUsd += usageCostUsd([run.model, message.model], message.usage, { batch: true });
        }
        const row = decideReplayVerdictRow(run.id, run.playbookIds, result);
        if (row) buffer.push(row);
        if (buffer.length >= 500) {
          await prisma.aiReplayVerdict.createMany({ data: buffer, skipDuplicates: true });
          buffer = [];
        }
      }
      if (buffer.length > 0) await prisma.aiReplayVerdict.createMany({ data: buffer, skipDuplicates: true });
      const summaries = summarizeDecideReplay(
        await gradedRows(run.id),
        run.playbookIds,
        env.FDSA_TRADE_TOP_PCT,
      );
      const claimed = await prisma.aiReplayRun.updateMany({
        where: { id: run.id, status: "submitted" },
        data: { status: "scored", scoredAt: new Date(), metrics: summaries as object, costUsd },
      });
      if (claimed.count !== 1) continue;
      logger.info("FDSA decide replay scored", {
        run: run.id,
        costUsd: Math.round(costUsd * 100) / 100,
        summaries,
      });
      scored.push({ id: run.id, variantIds: run.playbookIds, costUsd, summaries });
    } catch (err) {
      const error = describeAnthropicError(err);
      if (Date.now() - run.createdAt.getTime() >= UNREADABLE_BATCH_GIVE_UP_MS) {
        await prisma.aiReplayRun.update({
          where: { id: run.id },
          data: { status: "failed", error: `batch unreadable: ${error}`.slice(0, 500) },
        });
        logger.warn("FDSA decide replay batch unreadable for days - marking it failed", {
          run: run.id,
          error,
        });
        continue;
      }
      logger.warn("could not read the FDSA decide replay batch - retrying next pass", { run: run.id, error });
    }
  }
  return scored;
}

/** The run tag's latest run, as the job reports it. */
function runMeta(run: {
  id: string;
  status: string;
  requestCount: number;
  estimatedCostUsd: number | null;
  costUsd: number | null;
  error: string | null;
  metrics: unknown;
  playbookIds: string[];
}): JobRunMeta {
  const meta: JobRunMeta = {
    run: run.id,
    status: run.status,
    requests: run.requestCount,
    estimatedCostUsd: run.estimatedCostUsd === null ? null : Math.round(run.estimatedCostUsd * 100) / 100,
    costUsd: run.costUsd === null ? null : Math.round(run.costUsd * 100) / 100,
    error: run.error,
  };
  const metrics = run.metrics as Record<string, DecideReplayVariantSummary> | null;
  if (metrics) {
    for (const id of run.playbookIds) {
      const m = metrics[id];
      if (m) meta[`variant ${id.slice(id.lastIndexOf(":") + 1)}`] = { ...m };
    }
  }
  return meta;
}

/**
 * The job (hourly on the trainer): scores any replay whose batch has ended, and submits the tag's
 * replay once - a tag with a run submitted or scored is done, and one whose submit failed waits
 * RETRY_FAILED_SUBMIT_MS before another try, rather than hitting a limit every hour.
 */
export async function runFdsaDecideReplayJob(env: Env, now = Date.now()): Promise<JobRunMeta> {
  const tag = env.FDSA_DECIDE_REPLAY.trim();
  if (!tag) return { skipped: "FDSA_DECIDE_REPLAY unset" };
  if (!anthropicConfigured(env)) return { skipped: "no ANTHROPIC_API_KEY" };
  const scored = await pollDecideReplayRuns(env);
  const variants = decideReplayVariants(env, tag);
  const existing = await prisma.aiReplayRun.findFirst({
    where: { purpose: FDSA_DECIDE_REPLAY_PURPOSE, playbookIds: { has: variants[0]!.id } },
    orderBy: { createdAt: "desc" },
  });
  if (
    existing &&
    (existing.status !== "failed" || now - existing.createdAt.getTime() < RETRY_FAILED_SUBMIT_MS)
  ) {
    return { tag, scoredThisPass: scored.length, ...runMeta(existing) };
  }
  const items = await loadDecideReplayItems(env.FDSA_DECIDE_REPLAY_ITEMS);
  const submitted = await submitDecideReplay(env, { tag, items });
  if (submitted.runId === null) {
    return {
      tag,
      scoredThisPass: scored.length,
      candidates: items.length,
      submitted: false,
      reason: submitted.reason,
    };
  }
  return {
    tag,
    scoredThisPass: scored.length,
    candidates: items.length,
    submitted: true,
    run: submitted.runId,
    items: submitted.items,
    requests: submitted.requests,
    estimatedCostUsd: Math.round(submitted.estimatedCostUsd * 100) / 100,
  };
}
