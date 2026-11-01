import { z } from "zod";
import { clampProbability, clip } from "../curation/aiReview.js";
import { clampFdsaExitPlan, FdsaExitPlanAnswerSchema, type FdsaExitPlan } from "./exitPlan.js";

/**
 * What FDSA's Claude calls return, and how an answer becomes a stored verdict (owner decision
 * 2026-10-31, decision 1). Two stages review every curated alert:
 *   - "screen": Haiku at low effort, compact brief, a 0-1 shortlist score and a one-line reason;
 *     at or above FDSA_SCREEN_MIN_SCORE the alert is shortlisted for the decide stage;
 *   - "decide": Opus at medium effort, the reviewer's full brief, trade or pass and the entry exit
 *     plan.
 * And "revise" re-plans an open position at a named trigger (exitPlan.ts fdsaRevisionDue).
 *
 * The *AnswerSchema objects are what the model is asked for (structured output). They carry no
 * numeric bounds - structured outputs can't enforce them - so every answer goes through a read*
 * function here, which clamps every number and caps every string. An answer that is missing,
 * fails its schema, was refused, or was cut off at max_tokens becomes a pass ("drop" for the
 * screen, "keep" for a revision) with the error recorded - never a trade.
 *
 * Model text (reasoning, risks) is only ever stored and displayed: it is never executed, used as a
 * URL, or fed back into a prompt as instructions.
 */

export const FDSA_STAGES = ["screen", "decide", "revise"] as const;
export type FdsaStage = (typeof FDSA_STAGES)[number];

/**
 * Bumped whenever a prompt or an answer schema changes, and stored on every FdsaReview, so the
 * tab's record is read per prompt version.
 */
export const FDSA_PROMPT_VERSION = "fdsa-v1";

/** FdsaReview.dedupeKey: one screen and one decide per token. Revisions repeat, so they have none. */
export function fdsaReviewDedupeKey(tokenId: string, stage: FdsaStage): string | null {
  return stage === "revise" ? null : `${tokenId}:${stage}`;
}

/** How the response ended, as far as reading the answer goes. */
export interface FdsaAnswerMeta {
  /** The response's stop_reason ("end_turn", "max_tokens", "refusal", ...); null when unknown. */
  stopReason: string | null;
}

/** Why an answer could not be used, or null when it can. */
function unusable(raw: unknown, meta: FdsaAnswerMeta): string | null {
  if (meta.stopReason === "refusal") return "refused";
  if (meta.stopReason === "max_tokens") return "cut off at max_tokens";
  if (raw === null || raw === undefined) return `no parsable answer (stop: ${meta.stopReason ?? "unknown"})`;
  return null;
}

const REASON_CHARS = 280;
const REASONING_CHARS = 1_200;
const RISK_CHARS = 140;
const MAX_RISKS = 8;

/** Flattened and capped, with `<` and `>` stripped as the reviewer strips them (aiReview.ts clip). */
const clipText = (s: string, max: number) => clip(s, max);
const clipRisks = (risks: string[]) =>
  risks
    .map((r) => clipText(r, RISK_CHARS))
    .filter((r) => r !== "")
    .slice(0, MAX_RISKS);

// ── Screen ────────────────────────────────────────────────────────────────

export const FdsaScreenAnswerSchema = z.object({
  /** 0-1: how strongly this alert deserves the full decide review. */
  score: z.number(),
  /** One line: the deciding reason. */
  reason: z.string(),
});
export type FdsaScreenAnswer = z.infer<typeof FdsaScreenAnswerSchema>;

export interface FdsaScreenVerdict {
  decision: "shortlist" | "drop";
  score: number;
  reason: string;
}

export type FdsaRead<V> =
  { verdict: V; error: null; refused: false } | { verdict: V; error: string; refused: boolean };

/** A screen answer as stored: the score clamped, shortlisted at or above `minScore`, "drop" when unusable. */
export function readFdsaScreenAnswer(
  raw: unknown,
  meta: FdsaAnswerMeta,
  minScore: number,
): FdsaRead<FdsaScreenVerdict> {
  const drop = (error: string): FdsaRead<FdsaScreenVerdict> => ({
    verdict: { decision: "drop", score: 0, reason: "" },
    error,
    refused: meta.stopReason === "refusal",
  });
  const bad = unusable(raw, meta);
  if (bad) return drop(bad);
  const parsed = FdsaScreenAnswerSchema.safeParse(raw);
  if (!parsed.success) return drop("answer did not match the screen schema");
  const score = clampProbability(parsed.data.score);
  return {
    verdict: {
      decision: score >= minScore ? "shortlist" : "drop",
      score,
      reason: clipText(parsed.data.reason, REASON_CHARS),
    },
    error: null,
    refused: false,
  };
}

// ── Decide ────────────────────────────────────────────────────────────────

export const FdsaDecideAnswerSchema = z.object({
  decision: z.enum(["trade", "pass"]),
  /** The model's own odds the alert doubles within the label window before the -50% stop, 0-1. */
  probability2x: z.number(),
  /** The same for 4x, 0-1. */
  probability4x: z.number(),
  /** 0-1: how sure it is of the call itself. */
  conviction: z.number(),
  /** The entry exit plan; required on a trade, ignored on a pass. */
  exitPlan: FdsaExitPlanAnswerSchema.nullable(),
  /** One to three sentences: the deciding reason. */
  reasoning: z.string(),
  /** The specific red flags it weighed, short phrases. */
  risks: z.array(z.string()),
});
export type FdsaDecideAnswer = z.infer<typeof FdsaDecideAnswerSchema>;

export interface FdsaDecideVerdict {
  decision: "trade" | "pass";
  probability2x: number;
  probability4x: number;
  conviction: number;
  /** Set (clamped, validated) on a trade; null on a pass. */
  exitPlan: FdsaExitPlan | null;
  reasoning: string;
  risks: string[];
}

const PASS: FdsaDecideVerdict = {
  decision: "pass",
  probability2x: 0,
  probability4x: 0,
  conviction: 0,
  exitPlan: null,
  reasoning: "",
  risks: [],
};

/**
 * A decide answer as stored. Probabilities and conviction clamped to 0-1 (a 2-100 value read as a
 * percent, as the reviewer does), 4x odds held at or under the 2x odds, text capped, and the exit
 * plan clamped (clampFdsaExitPlan). A trade whose plan can't be made valid is stored as a pass with
 * the error - FDSA never buys without a plan that is safe to run.
 */
export function readFdsaDecideAnswer(raw: unknown, meta: FdsaAnswerMeta): FdsaRead<FdsaDecideVerdict> {
  const pass = (error: string): FdsaRead<FdsaDecideVerdict> => ({
    verdict: PASS,
    error,
    refused: meta.stopReason === "refusal",
  });
  const bad = unusable(raw, meta);
  if (bad) return pass(bad);
  const parsed = FdsaDecideAnswerSchema.safeParse(raw);
  if (!parsed.success) return pass("answer did not match the decide schema");
  const a = parsed.data;
  const probability2x = clampProbability(a.probability2x);
  const verdict: FdsaDecideVerdict = {
    decision: a.decision,
    probability2x,
    probability4x: Math.min(probability2x, clampProbability(a.probability4x)),
    conviction: clampProbability(a.conviction),
    exitPlan: null,
    reasoning: clipText(a.reasoning, REASONING_CHARS),
    risks: clipRisks(a.risks),
  };
  if (a.decision === "pass") return { verdict, error: null, refused: false };
  const plan = clampFdsaExitPlan(a.exitPlan);
  if (!plan)
    return {
      verdict: { ...verdict, decision: "pass" },
      error: "trade without a usable exit plan",
      refused: false,
    };
  return { verdict: { ...verdict, exitPlan: plan }, error: null, refused: false };
}

// ── Revise ────────────────────────────────────────────────────────────────

export const FdsaReviseAnswerSchema = z.object({
  action: z.enum(["revise", "keep"]),
  /** The whole new plan on "revise"; ignored on "keep". */
  exitPlan: FdsaExitPlanAnswerSchema.nullable(),
  /** One or two sentences: why. */
  reason: z.string(),
});
export type FdsaReviseAnswer = z.infer<typeof FdsaReviseAnswerSchema>;

export interface FdsaReviseVerdict {
  action: "revise" | "keep";
  /**
   * The model's plan as it sent it (it clamps to a valid plan), NOT yet applied: the caller
   * applies it with applyFdsaRevision (exitPlan.ts), which clamps it again and holds the stop at
   * or above the position's floor, and stores this raw form as FdsaPlanRevision.proposed.
   */
  proposed: unknown;
  reason: string;
}

/** A revision answer as stored; anything unusable is "keep" with the error, and the running plan stays. */
export function readFdsaReviseAnswer(raw: unknown, meta: FdsaAnswerMeta): FdsaRead<FdsaReviseVerdict> {
  const keep = (error: string): FdsaRead<FdsaReviseVerdict> => ({
    verdict: { action: "keep", proposed: null, reason: "" },
    error,
    refused: meta.stopReason === "refusal",
  });
  const bad = unusable(raw, meta);
  if (bad) return keep(bad);
  const parsed = FdsaReviseAnswerSchema.safeParse(raw);
  if (!parsed.success) return keep("answer did not match the revise schema");
  const reason = clipText(parsed.data.reason, REASON_CHARS);
  if (parsed.data.action === "keep")
    return { verdict: { action: "keep", proposed: null, reason }, error: null, refused: false };
  if (!clampFdsaExitPlan(parsed.data.exitPlan)) return keep("revision without a usable exit plan");
  return {
    verdict: { action: "revise", proposed: parsed.data.exitPlan, reason },
    error: null,
    refused: false,
  };
}
