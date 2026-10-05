import { NEVER_EMIT_THRESHOLD, RULES_MODEL_KIND } from "./trainingRun.js";

/**
 * The training run's guard: whether a finished run may replace the models that are running.
 *
 * Every run retires every active model and ships its own (applyContestResults), and the cleanup
 * job strips a retired model's weights a week later. So one bad run - a data source that broke
 * and left the window half empty, a numeric blow-up in a fit - used to silently replace every good
 * model at once. The guard holds such a run back and keeps the running models instead. It does not
 * judge whether a run is better (the exam already does that, seat by seat); it only catches runs
 * that are plainly broken:
 *
 *  - a weight, bias or cutoff that is not a finite number (NaN and Infinity store as JSON null,
 *    and a null weight scores every candidate as NaN). Always held.
 *  - a training set under half the rows the running models were trained on (or under half the
 *    row cap, when that was lowered): rows went missing, not the market.
 *  - every seat that was calling would go silent (no cutoff it can call at).
 *
 * The last two can also be real changes in the data, so they hold for at most `maxHoldMs` from
 * when the running models went live; after that the run is accepted and the log says why.
 */

export interface IncumbentModel {
  contestant: string | null;
  kind: string;
  /** params.threshold, or null for a kind without one. */
  threshold: number | null;
  trainingRows: number;
  activatedAt: Date | null;
}

export interface CandidateModel {
  contestant: string;
  kind: string;
  params: unknown;
}

export interface RunGuardInput {
  incumbents: readonly IncumbentModel[];
  results: readonly CandidateModel[];
  trainingRows: number;
  maxRows: number;
  now: Date;
  maxHoldMs: number;
}

export type RunGuardVerdict =
  { accept: true; reason: string | null } | { accept: false; reason: string; heldSinceMs: number };

/** Below this share of the rows the running models saw, a run is held. */
export const MIN_ROW_SHARE = 0.5;

export function assessTrainingRun(input: RunGuardInput): RunGuardVerdict {
  for (const r of input.results) {
    const bad = firstNonFinite(r.params);
    if (bad !== null) {
      return {
        accept: false,
        reason: `${r.contestant}'s model has a non-finite number at ${bad} - never shipped`,
        heldSinceMs: 0,
      };
    }
  }
  if (input.incumbents.length === 0) return { accept: true, reason: null };

  const problems: string[] = [];
  const priorRows = Math.max(...input.incumbents.map((m) => m.trainingRows));
  const expected = Math.min(priorRows, input.maxRows);
  if (input.trainingRows < expected * MIN_ROW_SHARE) {
    problems.push(`trained on ${input.trainingRows} rows, under half the ${expected} the running models saw`);
  }
  const calling = (kind: string, threshold: number | null) =>
    kind !== RULES_MODEL_KIND && threshold !== null && threshold < NEVER_EMIT_THRESHOLD;
  const wasCalling = input.incumbents.filter((m) => calling(m.kind, m.threshold)).length;
  const nowCalling = input.results.filter((r) => calling(r.kind, thresholdOf(r.params))).length;
  if (wasCalling > 0 && nowCalling === 0) {
    problems.push(`every seat would go silent (${wasCalling} calling now, none after this run)`);
  }
  if (problems.length === 0) return { accept: true, reason: null };

  // An incumbent with no activation time (a row older than the column) counts as activated now:
  // reading it as the epoch made the hold window look long spent, and the run went through at once.
  const live = input.incumbents
    .map((m) => m.activatedAt?.getTime() ?? input.now.getTime())
    .reduce((a, b) => Math.max(a, b), 0);
  const heldSinceMs = input.now.getTime() - live;
  if (heldSinceMs >= input.maxHoldMs) {
    return {
      accept: true,
      reason: `accepted after holding ${Math.round(heldSinceMs / 3_600_000)}h: ${problems.join("; ")}`,
    };
  }
  return { accept: false, reason: problems.join("; "), heldSinceMs };
}

function thresholdOf(params: unknown): number | null {
  if (typeof params !== "object" || params === null) return null;
  const t = (params as { threshold?: unknown }).threshold;
  return typeof t === "number" ? t : null;
}

/**
 * The path of the first number in `value` that isn't finite, or null when there is none. Nulls
 * themselves are allowed (a rules cutoff, an absent calibration), only NaN and the infinities are not.
 */
export function firstNonFinite(value: unknown, path = "params"): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? null : path;
  if (value instanceof Float64Array || value instanceof Float32Array) {
    for (let i = 0; i < value.length; i++) if (!Number.isFinite(value[i]!)) return `${path}[${i}]`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const bad = firstNonFinite(value[i], `${path}[${i}]`);
      if (bad !== null) return bad;
    }
    return null;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const bad = firstNonFinite(v, `${path}.${k}`);
      if (bad !== null) return bad;
    }
  }
  return null;
}
