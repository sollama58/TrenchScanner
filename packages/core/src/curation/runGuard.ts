import type { HeldFeature } from "./featureOnset.js";
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

/**
 * Alarms, never holds (lane 4 M-5, notes/full-audit-2026-10-14): the guard above only catches runs
 * that are plainly broken, so a run whose exam fell sharply, a seat calling far more of the market
 * than its cutoff share, most seats going quiet, or an input the learners read going dead all went
 * through unremarked. These say so in the log and on the job's run meta; nothing waits on them.
 */

/** A seat's exam 2x rate, new run against the model it replaces. */
export interface SeatExam {
  contestant: string;
  wins: number;
  graded: number;
}

/** A drop this many points or more, with the new rate's 95% upper bound under the old rate, alarms. */
export const EXAM_DROP_POINTS = 5;
/** Fewest graded exam calls, on both sides, before a drop is judged. */
const MIN_EXAM_GRADED = 50;

function wilsonBounds(k: number, n: number, z = 1.96): [number, number] {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Seats whose exam 2x rate fell sharply against the model they replace. */
export function examRegressionAlarms(
  incumbents: readonly SeatExam[],
  results: readonly SeatExam[],
): string[] {
  const before = new Map(incumbents.map((s) => [s.contestant, s]));
  const out: string[] = [];
  for (const now of results) {
    const was = before.get(now.contestant);
    if (!was || was.graded < MIN_EXAM_GRADED || now.graded < MIN_EXAM_GRADED) continue;
    const oldRate = was.wins / was.graded;
    const newRate = now.wins / now.graded;
    if (oldRate - newRate >= EXAM_DROP_POINTS / 100 && wilsonBounds(now.wins, now.graded)[1] < oldRate) {
      out.push(
        `${now.contestant}: exam 2x ${pct(newRate)} (${now.wins}/${now.graded}) against ${pct(oldRate)} for the model it replaces`,
      );
    }
  }
  return out;
}

/** A seat's live calls against the decision moments of the same window. */
export interface SeatLiveShare {
  contestant: string;
  /** Distinct decision moments the seat called in the window. */
  calls: number;
  /** Whether the seat called anything in the day before the window (a quiet seat that never calls isn't judged). */
  calledBefore: boolean;
}

/** A seat calling this many times its cutoff share of decision moments (95% lower bound) alarms. */
export const LIVE_SHARE_ALARM_RATIO = 1.75;
/** Fewest decision moments in the window before shares are judged. */
const MIN_WINDOW_DECISIONS = 200;

/**
 * Seats calling far more of the market than their cutoff share (in 2026-10-13's run the loose
 * seats called 35-48% of decision moments against 20%), and most seats going quiet at once.
 */
export function liveShareAlarms(
  seats: readonly SeatLiveShare[],
  decisions: number,
  targetShare: number,
): string[] {
  if (decisions < MIN_WINDOW_DECISIONS || !(targetShare > 0)) return [];
  const out: string[] = [];
  for (const s of seats) {
    const [lo] = wilsonBounds(Math.min(s.calls, decisions), decisions);
    if (lo > targetShare * LIVE_SHARE_ALARM_RATIO) {
      out.push(
        `${s.contestant}: called ${pct(s.calls / decisions)} of ${decisions} decision moments against a ${pct(targetShare)} share`,
      );
    }
  }
  const active = seats.filter((s) => s.calledBefore);
  const quiet = active.filter((s) => s.calls === 0);
  if (active.length >= 4 && quiet.length * 2 > active.length) {
    out.push(
      `${quiet.length} of ${active.length} calling seats made no call in ${decisions} decision moments`,
    );
  }
  return out;
}

/** An input read by the learners whose fill on the newest rows fell under this share of its reference fill. */
export const FILL_DROP_RATIO = 0.4;

/**
 * Inputs the learners read that went dead lately (a source down), and retired inputs that came
 * back to life (worth judging again). The onset guard already keeps a dead input out of the run;
 * this makes it visible.
 */
export function fillRateAlarms(
  /** inputFills (featureOnset.ts): each input's fill on the reference span and the newest rows. */
  fills: readonly HeldFeature[],
  read: ReadonlySet<string>,
  retired: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const f of fills) {
    if (read.has(f.feature) && f.referencePct >= 20 && f.recentPct < f.referencePct * FILL_DROP_RATIO) {
      out.push(`${f.feature} went dead: ${f.recentPct}% of the newest rows against ${f.referencePct}%`);
    } else if (retired.has(f.feature) && f.referencePct < 2 && f.recentPct >= 20) {
      out.push(`${f.feature} (retired as dead) is filled again on ${f.recentPct}% of the newest rows`);
    }
  }
  return out;
}
