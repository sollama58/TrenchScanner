import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type * as z from "zod/v4";
import {
  prisma,
  Prisma,
  createLogger,
  buildAiReviewBrief,
  launcherTextInstructs,
  LAUNCHER_TEXT_GUARD_MODEL,
  decisionAnchor,
  readFdsaBudget,
  readFdsaDeskConfig,
  readFdsaScreenAnswer,
  readFdsaDecideAnswer,
  readFdsaReviseAnswer,
  buildFdsaReviseBrief,
  fdsaReviewDedupeKey,
  FdsaScreenAnswerSchema,
  FdsaDecideAnswerSchema,
  FdsaReviseAnswerSchema,
  FDSA_SCREEN_SYSTEM_PROMPT,
  FDSA_DECIDE_SYSTEM_PROMPT,
  FDSA_REVISE_SYSTEM_PROMPT,
  FDSA_DESK_ID,
  FDSA_PROMPT_VERSION,
  type CurationDecision,
  type Env,
  type FdsaAnswerMeta,
  type FdsaDecideVerdict,
  type FdsaRead,
  type FdsaReviseBriefInput,
  type FdsaReviseVerdict,
  type FdsaScreenVerdict,
  type FdsaSpendSource,
  type FdsaStage,
  type ScoredToken,
} from "@trenchscanner/core";
import { anthropicClient, anthropicConfigured, describeAnthropicError } from "../ai/client.js";
import {
  estimateCallUsd,
  failedCallCostUsd,
  fdsaReviewsHeld,
  reserveFdsaSpend,
  responseCostUsd,
  settleAiSpend,
} from "../ai/budget.js";
import { comparablesFor } from "../ai/reviewer.js";

const logger = createLogger("fdsa-review");

/**
 * FDSA's review pipeline (owner decision 2026-10-31): every curated alert, one per token, is
 * screened on a cheap model, and the shortlist goes to a full decide call that says trade or
 * pass and sets the entry exit plan. It runs alongside the AI reviewer (ai/reviewer.ts) and
 * changes nothing about it: its own prompts (core's fdsa/prompts.ts), its own table (FdsaReview),
 * its own spend cap (reserveFdsaSpend, ledger "fdsa"). It shares the reviewer's brief builder,
 * comparables, Anthropic client and launcher-text guard rather than forking them.
 *
 * Detached, like shadow reviews: emission enqueues an alert and moves on, so FDSA never delays or
 * changes the public feed. A trade verdict is a stored FdsaReview row (stage "decide", decision
 * "trade", exitPlan set); the paper desk picks those up in its pass and checks the signal's age,
 * the mint, the caps and the bankroll before it buys. Nothing here trades, holds a key or signs.
 *
 * Exit revisions on open positions (reviseFdsaPlan) go through the same client and the same cap,
 * out of the share kept for them, and ahead of any queued review.
 */

/** What emission hands FDSA about one curated alert. */
export interface FdsaAlert {
  tokenId: string;
  mint: string;
  scored: ScoredToken;
  decision: CurationDecision;
  candidateOutcomeId: string | null;
  curatedAlertId: string | null;
  /** When the alert went out: the signal's age, and the comparables' cutoff, count from here. */
  alertAt: Date;
}

/** Whether FDSA may call at all: switched on and a key to call with. The desk's Resume is checked per alert. */
export function fdsaEnabled(env: Pick<Env, "FDSA_ENABLED" | "ANTHROPIC_API_KEY">): boolean {
  return env.FDSA_ENABLED && anthropicConfigured(env as Env);
}

// ── Desk state ────────────────────────────────────────────────────────────

interface DeskState {
  running: boolean;
  maxSignalAgeSeconds: number;
}
const DESK_CACHE_MS = 10_000;
let deskCache: { at: number; state: DeskState } | null = null;

/** The desk's running flag and freshness window, read at most every 10 s. No desk row = not running. */
async function deskState(): Promise<DeskState> {
  if (deskCache && Date.now() - deskCache.at < DESK_CACHE_MS) return deskCache.state;
  const desk = await prisma.fdsaDesk.findUnique({
    where: { id: FDSA_DESK_ID },
    select: { running: true, config: true },
  });
  const state = {
    running: desk?.running ?? false,
    maxSignalAgeSeconds: readFdsaDeskConfig(desk?.config).maxSignalAgeSeconds,
  };
  deskCache = { at: Date.now(), state };
  return state;
}

// ── Slots ─────────────────────────────────────────────────────────────────

/**
 * FDSA calls in flight at once (FDSA_MAX_IN_FLIGHT), screens, decides and revisions together, so
 * a busy cycle doesn't fire every alert into the key's rate limit. A revision waits at the front
 * of the line: an open position's check-in must never sit behind a backlog of new alerts.
 */
let inFlight = 0;
const waiting: (() => void)[] = [];

async function withSlot<T>(env: Env, urgent: boolean, fn: () => Promise<T>): Promise<T> {
  if (inFlight >= env.FDSA_MAX_IN_FLIGHT) {
    await new Promise<void>((resolve) => (urgent ? waiting.unshift(resolve) : waiting.push(resolve)));
  } else {
    inFlight += 1;
  }
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight -= 1;
  }
}

// ── Stats for the heartbeat ───────────────────────────────────────────────

const LATENCY_SAMPLES = 50;
interface Stats {
  enqueued: number;
  screened: number;
  shortlisted: number;
  decided: number;
  trades: number;
  passes: number;
  errors: number;
  vetoedByGuard: number;
  skippedBudget: number;
  skippedPaused: number;
  /** Trade verdicts that landed after the desk's maxSignalAgeSeconds: the desk won't buy them. */
  staleTrades: number;
  screenMs: number[];
  decideMs: number[];
  alertToVerdictMs: number[];
  lastError: string | null;
  lastErrorAt: string | null;
}
const emptyStats = (): Stats => ({
  enqueued: 0,
  screened: 0,
  shortlisted: 0,
  decided: 0,
  trades: 0,
  passes: 0,
  errors: 0,
  vetoedByGuard: 0,
  skippedBudget: 0,
  skippedPaused: 0,
  staleTrades: 0,
  screenMs: [],
  decideMs: [],
  alertToVerdictMs: [],
  lastError: null,
  lastErrorAt: null,
});
let stats = emptyStats();

function sample(list: number[], v: number): void {
  list.push(v);
  if (list.length > LATENCY_SAMPLES) list.shift();
}
function noteError(error: string): void {
  stats.errors += 1;
  stats.lastError = error.slice(0, 300);
  stats.lastErrorAt = new Date().toISOString();
}
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
};

/** Alerts enqueued and not yet finished, and the tokens among them (one review per token). */
const pending = new Set<Promise<unknown>>();
const pendingTokens = new Set<string>();

/** Test hook. */
export function resetFdsaReviews(): void {
  stats = emptyStats();
  deskCache = null;
  pendingTokens.clear();
  pending.clear();
  inFlight = 0;
  waiting.length = 0;
}

/**
 * FDSA's line on the scan heartbeat (owner ask 2026-10-31: say when the cap stops reviews): on or
 * off, the desk's Resume, whether today's cap has stopped reviews, the queue, counts since this
 * process started and the latency a buy has to beat the signal's freshness with. Never throws.
 */
export async function fdsaHeartbeat(env: Env): Promise<Record<string, string | number | boolean | null>> {
  if (!fdsaEnabled(env)) return { enabled: false };
  const [desk, budget] = await Promise.all([
    deskState().catch(() => null),
    readFdsaBudget(env).catch(() => null),
  ]);
  return {
    enabled: true,
    running: desk?.running ?? null,
    reviewsStopped: (budget?.reviewsStopped ?? false) || fdsaReviewsHeld(),
    exitsStopped: budget?.exitsStopped ?? null,
    spentUsd: budget?.spentUsd ?? null,
    capUsd: budget?.capUsd ?? env.FDSA_DAILY_BUDGET_USD,
    queued: pending.size,
    inFlight,
    // Since this process started.
    enqueued: stats.enqueued,
    screened: stats.screened,
    shortlisted: stats.shortlisted,
    decided: stats.decided,
    trades: stats.trades,
    passes: stats.passes,
    errors: stats.errors,
    vetoedByGuard: stats.vetoedByGuard,
    skippedBudget: stats.skippedBudget,
    skippedPaused: stats.skippedPaused,
    staleTrades: stats.staleTrades,
    // Over the last 50 calls of each.
    screenP50Ms: median(stats.screenMs),
    decideP50Ms: median(stats.decideMs),
    alertToVerdictP50Ms: median(stats.alertToVerdictMs),
    alertToVerdictMaxMs: stats.alertToVerdictMs.length > 0 ? Math.max(...stats.alertToVerdictMs) : null,
    maxSignalAgeSeconds: desk?.maxSignalAgeSeconds ?? null,
    lastError: stats.lastError,
    lastErrorAt: stats.lastErrorAt,
  };
}

// ── The call ──────────────────────────────────────────────────────────────

interface CallSpec {
  stage: FdsaStage;
  source: FdsaSpendSource;
  model: string;
  effort: Env["FDSA_DECIDE_EFFORT"];
  timeoutMs: number;
  system: string;
  brief: string;
  schema: z.ZodType;
}

/** One call's result: the raw answer for the stage's reader, plus what the row records. */
export interface FdsaCallResult {
  raw: unknown;
  meta: FdsaAnswerMeta;
  /** A failed call (timeout, API error); raw is null then. */
  error: string | null;
  answeredBy: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number;
  latencyMs: number;
}

/** The JSON in a response's last text block (a fallback's cut-off first answer comes before it), or null. */
export function lastTextJson(content: readonly { type: string; text?: string }[]): unknown {
  const text = content.filter((b) => b.type === "text" && typeof b.text === "string").at(-1)?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * One FDSA call: reserve out of FDSA's cap, call with structured output, settle to the real cost.
 * Null when the budget turned it away (no call made). Never throws: a failed call comes back with
 * its error, and the stage's reader turns it into a pass.
 */
async function callFdsa(env: Env, spec: CallSpec): Promise<FdsaCallResult | null> {
  const reservation = await reserveFdsaSpend(env, spec.source, estimateCallUsd(spec.source, spec.model));
  if (!reservation) return null;
  // Haikus take no server-side fallback, and Haiku 4.5 no effort setting (as ai/textScorer.ts);
  // the other current models take both - a declined call is re-run on a fallback model inside the
  // same request, and `answeredBy` records who answered. Adaptive thinking on every current model,
  // its depth set by the stage's effort (decision 1: the screen low, the decide medium).
  const haiku = spec.model.startsWith("claude-haiku");
  const noEffort = spec.model.startsWith("claude-haiku-4");
  const startedAt = Date.now();
  try {
    const response = await anthropicClient(env).beta.messages.create(
      {
        model: spec.model,
        max_tokens: spec.stage === "screen" ? 4_000 : 16_000,
        ...(haiku ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        thinking: { type: "adaptive" },
        // Fixed per stage (no per-call value in it), so it is the stable prefix worth caching.
        system: [{ type: "text", text: spec.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: spec.brief }],
        output_config: {
          ...(noEffort ? {} : { effort: spec.effort }),
          format: betaZodOutputFormat(spec.schema),
        },
      },
      // No retry: a retried timeout bills twice against one reservation (ai/client.ts).
      { maxRetries: 0, timeout: spec.timeoutMs },
    );
    const latencyMs = Date.now() - startedAt;
    const costUsd = responseCostUsd(spec.model, response);
    await settleAiSpend(reservation, costUsd, spec.source);
    return {
      raw: response.stop_reason === "refusal" ? null : lastTextJson(response.content),
      meta: { stopReason: response.stop_reason ?? null },
      error: null,
      answeredBy: response.model !== spec.model ? response.model : null,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
      costUsd,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const costUsd = failedCallCostUsd(err, reservation);
    await settleAiSpend(reservation, costUsd);
    const error = describeAnthropicError(err);
    logger.warn("FDSA call failed", { stage: spec.stage, error });
    return {
      raw: null,
      meta: { stopReason: null },
      error,
      answeredBy: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd,
      latencyMs,
    };
  }
}

// ── Storage ───────────────────────────────────────────────────────────────

interface RowBase {
  tokenId: string;
  candidateOutcomeId: string | null;
  curatedAlertId: string | null;
  positionId?: string | null;
  alertAt: Date;
  anchorPriceUsd: number;
  anchorMcapUsd: number;
}

/** Writes one FdsaReview row; null when another process already wrote this token's stage (dedupeKey). */
async function storeReview(
  base: RowBase,
  stage: FdsaStage,
  model: string,
  effort: string,
  brief: string,
  call: FdsaCallResult | null,
  verdict: Partial<Prisma.FdsaReviewUncheckedCreateInput>,
  error: string | null,
  refused: boolean,
): Promise<string | null> {
  try {
    const row = await prisma.fdsaReview.create({
      data: {
        ...base,
        positionId: base.positionId ?? null,
        stage,
        dedupeKey: fdsaReviewDedupeKey(base.tokenId, stage),
        model,
        answeredBy: call?.answeredBy ?? null,
        effort,
        promptVersion: FDSA_PROMPT_VERSION,
        playbookId: null,
        brief,
        ...verdict,
        error,
        refused,
        inputTokens: call?.inputTokens ?? null,
        outputTokens: call?.outputTokens ?? null,
        cacheReadTokens: call?.cacheReadTokens ?? null,
        cacheWriteTokens: call?.cacheWriteTokens ?? null,
        costUsd: call?.costUsd ?? null,
        latencyMs: call?.latencyMs ?? 0,
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.info("FDSA review already stored by another process", { tokenId: base.tokenId, stage });
      return null;
    }
    throw err;
  }
}

/** The error column: the call's own failure, else what made its answer unusable. */
const errorOf = (call: FdsaCallResult, read: { error: string | null }) => call.error ?? read.error;

// ── The pipeline ──────────────────────────────────────────────────────────

/**
 * Hands one emitted alert to FDSA, detached: returns at once, and the review runs in the
 * background (drainFdsaReviews waits for it at shutdown). One per token - another seat's alert on
 * the same coin, here or stored, is skipped. Does nothing while FDSA is off.
 */
export function enqueueFdsaAlert(alert: FdsaAlert, env: Env): void {
  if (!fdsaEnabled(env) || pendingTokens.has(alert.tokenId)) return;
  pendingTokens.add(alert.tokenId);
  stats.enqueued += 1;
  const p = reviewFdsaAlert(alert, env)
    .catch((err: unknown) => {
      noteError(String(err));
      logger.warn("FDSA review failed", { mint: alert.mint, error: String(err) });
    })
    .finally(() => {
      pending.delete(p);
      pendingTokens.delete(alert.tokenId);
    });
  pending.add(p);
}

/**
 * Waits up to `timeoutMs` for the FDSA reviews in flight to finish and write their rows - one cut
 * off is paid for and never recorded. Returns how many were still running when the wait ended.
 */
export async function drainFdsaReviews(timeoutMs: number): Promise<number> {
  if (pending.size === 0) return 0;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return pending.size;
}

export interface FdsaReviewOutcome {
  screen: FdsaScreenVerdict | null;
  decide: FdsaDecideVerdict | null;
  /** The decide row, when one was written. */
  decideReviewId: string | null;
  /** Why it stopped short of a decide, when it did. */
  stoppedAt: "off" | "paused" | "already-reviewed" | "budget" | "guard" | "dropped" | null;
}

/**
 * Screens one alert and, when it is shortlisted, decides it. Awaitable for tests; emission goes
 * through enqueueFdsaAlert. Throws only on a database failure.
 */
export async function reviewFdsaAlert(alert: FdsaAlert, env: Env): Promise<FdsaReviewOutcome> {
  const out = (stoppedAt: FdsaReviewOutcome["stoppedAt"]): FdsaReviewOutcome => ({
    screen: null,
    decide: null,
    decideReviewId: null,
    stoppedAt,
  });
  if (!fdsaEnabled(env)) return out("off");
  // Paused (or never resumed): no reviews of new alerts - the desk's Resume is what turns them on.
  const desk = await deskState();
  if (!desk.running) {
    stats.skippedPaused += 1;
    return out("paused");
  }
  const screenKey = fdsaReviewDedupeKey(alert.tokenId, "screen");
  if (
    screenKey &&
    (await prisma.fdsaReview.findUnique({ where: { dedupeKey: screenKey }, select: { id: true } }))
  )
    return out("already-reviewed");

  const anchor = decisionAnchor(alert.scored);
  const base: RowBase = {
    tokenId: alert.tokenId,
    candidateOutcomeId: alert.candidateOutcomeId,
    curatedAlertId: alert.curatedAlertId,
    alertAt: alert.alertAt,
    anchorPriceUsd: anchor.priceUsd,
    anchorMcapUsd: anchor.marketCapUsd,
  };
  // The screen reads the reviewer's brief without its comparables: the cheap first look.
  const screenBrief = buildAiReviewBrief(alert.scored, alert.decision);

  // Launcher text written to steer a model is a drop on its own, decided here so the model is
  // never the only check against it - the reviewer's own guard (core's launcherTextInstructs).
  if (launcherTextInstructs(alert.scored)) {
    stats.vetoedByGuard += 1;
    const reason = "The token's name, symbol or description is written to instruct an AI, so it is dropped.";
    await storeReview(
      base,
      "screen",
      LAUNCHER_TEXT_GUARD_MODEL,
      "none",
      screenBrief,
      null,
      { decision: "drop", score: 0, reasoning: reason },
      null,
      false,
    );
    return { ...out("guard"), screen: { decision: "drop", score: 0, reason } };
  }

  const screenCall = await withSlot(env, false, () =>
    callFdsa(env, {
      stage: "screen",
      source: "fdsa-screen",
      model: env.FDSA_SCREEN_MODEL,
      effort: env.FDSA_SCREEN_EFFORT,
      timeoutMs: env.FDSA_SCREEN_TIMEOUT_MS,
      system: FDSA_SCREEN_SYSTEM_PROMPT,
      brief: screenBrief,
      schema: FdsaScreenAnswerSchema,
    }),
  );
  if (!screenCall) {
    stats.skippedBudget += 1;
    return out("budget");
  }
  const screen = readFdsaScreenAnswer(screenCall.raw, screenCall.meta, env.FDSA_SCREEN_MIN_SCORE);
  stats.screened += 1;
  sample(stats.screenMs, screenCall.latencyMs);
  const screenError = errorOf(screenCall, screen);
  if (screenCall.error) noteError(screenCall.error);
  await storeReview(
    base,
    "screen",
    env.FDSA_SCREEN_MODEL,
    env.FDSA_SCREEN_EFFORT,
    screenBrief,
    screenCall,
    // A failed call stores no decision (the column's "the call failed"); an unusable answer stores "drop".
    screenCall.error
      ? {}
      : { decision: screen.verdict.decision, score: screen.verdict.score, reasoning: screen.verdict.reason },
    screenError,
    screen.refused,
  );
  if (screen.verdict.decision !== "shortlist") return { ...out("dropped"), screen: screen.verdict };
  stats.shortlisted += 1;

  const decided = await decideFdsaAlert(alert, env, base, desk);
  return { screen: screen.verdict, ...decided };
}

/** The decide stage on a shortlisted alert. */
async function decideFdsaAlert(
  alert: FdsaAlert,
  env: Env,
  base: RowBase,
  desk: DeskState,
): Promise<Omit<FdsaReviewOutcome, "screen">> {
  // The 20 nearest graded past calls, as the reviewer's shadow reviews see them: only rows whose
  // outcome was knowable at the alert, since this runs detached after it.
  const comparables = await comparablesFor(alert.scored, env, alert.alertAt);
  const brief = buildAiReviewBrief(alert.scored, alert.decision, comparables, alert.alertAt);
  const call = await withSlot(env, false, () =>
    callFdsa(env, {
      stage: "decide",
      source: "fdsa-decide",
      model: env.FDSA_DECIDE_MODEL,
      effort: env.FDSA_DECIDE_EFFORT,
      timeoutMs: env.FDSA_DECIDE_TIMEOUT_MS,
      system: FDSA_DECIDE_SYSTEM_PROMPT,
      brief,
      schema: FdsaDecideAnswerSchema,
    }),
  );
  if (!call) {
    stats.skippedBudget += 1;
    return { decide: null, decideReviewId: null, stoppedAt: "budget" };
  }
  const read: FdsaRead<FdsaDecideVerdict> = readFdsaDecideAnswer(call.raw, call.meta);
  const v = read.verdict;
  stats.decided += 1;
  sample(stats.decideMs, call.latencyMs);
  if (call.error) noteError(call.error);
  // End to end, alert to verdict: a buy has to reach the paper pass inside the desk's
  // maxSignalAgeSeconds, so a verdict that lands later is recorded but never bought.
  const alertToVerdictMs = Date.now() - alert.alertAt.getTime();
  sample(stats.alertToVerdictMs, alertToVerdictMs);
  if (v.decision === "trade") {
    stats.trades += 1;
    if (alertToVerdictMs > desk.maxSignalAgeSeconds * 1000) {
      stats.staleTrades += 1;
      logger.warn("FDSA trade verdict landed after the signal went stale - the desk will not buy it", {
        mint: alert.mint,
        alertToVerdictMs,
        maxSignalAgeSeconds: desk.maxSignalAgeSeconds,
      });
    }
  } else {
    stats.passes += 1;
  }
  const id = await storeReview(
    base,
    "decide",
    env.FDSA_DECIDE_MODEL,
    env.FDSA_DECIDE_EFFORT,
    brief,
    call,
    call.error
      ? {}
      : {
          decision: v.decision,
          probability2x: v.probability2x,
          probability4x: v.probability4x,
          conviction: v.conviction,
          exitPlan: v.exitPlan ? (v.exitPlan as unknown as Prisma.InputJsonObject) : Prisma.DbNull,
          reasoning: v.reasoning,
          risks: v.risks,
        },
    errorOf(call, read),
    read.refused,
  );
  logger.info("FDSA decided", {
    mint: alert.mint,
    decision: v.decision,
    probability2x: v.probability2x,
    callMs: call.latencyMs,
    alertToVerdictMs,
    error: errorOf(call, read),
  });
  return { decide: v, decideReviewId: id, stoppedAt: null };
}

// ── Exit revisions ────────────────────────────────────────────────────────

/** What a revision call needs about the position it revises (FdsaPosition and its alert). */
export interface FdsaRevisionRequest extends FdsaReviseBriefInput {
  positionId: string;
  tokenId: string;
  candidateOutcomeId: string | null;
  curatedAlertId: string | null;
  alertAt: Date;
  anchorPriceUsd: number;
  anchorMcapUsd: number;
}

export interface FdsaRevisionResult {
  /** The FdsaReview row (stage "revise") the call was stored as. */
  reviewId: string | null;
  /**
   * "keep" or "revise" with the model's proposal, NOT yet applied: the desk applies it with
   * applyFdsaRevision (core's exitPlan.ts), which clamps it again and holds the stop at or above
   * the position's floor. Anything unusable reads as "keep", with the error.
   */
  read: FdsaRead<FdsaReviseVerdict>;
}

/**
 * Asks Claude whether to revise an open position's exit plan at a named trigger (decision 3). For
 * the desk's trigger handling, off the per-tick path: null when FDSA is off or the cap turned it
 * away (no call), else the stored, read answer. Never throws - an outage or a database failure is
 * logged and returns null, and the running plan stays in force. Waits at the front of the line.
 */
export async function reviseFdsaPlan(env: Env, req: FdsaRevisionRequest): Promise<FdsaRevisionResult | null> {
  if (!fdsaEnabled(env)) return null;
  try {
    const brief = buildFdsaReviseBrief(req);
    const call = await withSlot(env, true, () =>
      callFdsa(env, {
        stage: "revise",
        source: "fdsa-exit",
        model: env.FDSA_REVISION_MODEL,
        effort: env.FDSA_REVISION_EFFORT,
        timeoutMs: env.FDSA_REVISION_TIMEOUT_MS,
        system: FDSA_REVISE_SYSTEM_PROMPT,
        brief,
        schema: FdsaReviseAnswerSchema,
      }),
    );
    if (!call) return null;
    const read = readFdsaReviseAnswer(call.raw, call.meta);
    if (call.error) noteError(call.error);
    const reviewId = await storeReview(
      {
        tokenId: req.tokenId,
        candidateOutcomeId: req.candidateOutcomeId,
        curatedAlertId: req.curatedAlertId,
        positionId: req.positionId,
        alertAt: req.alertAt,
        anchorPriceUsd: req.anchorPriceUsd,
        anchorMcapUsd: req.anchorMcapUsd,
      },
      "revise",
      env.FDSA_REVISION_MODEL,
      env.FDSA_REVISION_EFFORT,
      brief,
      call,
      call.error
        ? {}
        : {
            decision: read.verdict.action,
            exitPlan:
              read.verdict.proposed !== null
                ? (read.verdict.proposed as Prisma.InputJsonObject)
                : Prisma.DbNull,
            reasoning: read.verdict.reason,
          },
      errorOf(call, read),
      read.refused,
    );
    return { reviewId, read };
  } catch (err) {
    noteError(String(err));
    logger.warn("FDSA revision failed - the running plan stays", {
      positionId: req.positionId,
      error: String(err),
    });
    return null;
  }
}
