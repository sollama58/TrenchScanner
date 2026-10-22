/**
 * Pure facts for Admin > Models + Training. The route (routes/adminModelsDesk.ts) fills these
 * from the trainer heartbeat, env caps and stored models. Nothing here invents a measurement.
 */

/** Stages curatorTrainingJob.ts records, in run order. A step name the worker adds still shows. */
export const TRAINING_STAGE_ORDER = [
  "score weights",
  "load rows",
  "plan",
  "exams",
  "store models",
  "re-choose default",
] as const;

export interface ExamView {
  calls: number;
  graded: number;
  wins: number;
  goals: number;
  /** Null when the stored exam did not count 10x. */
  tenX: number | null;
  /** sumLabel / graded: average doublings inside the label window. Null when the sum was not stored. */
  avgDoublings: number | null;
  /** sumRun / graded: average doublings to the run peak. Null when the exam did not store sumRun. */
  avgRunDoublings: number | null;
  simCalls: number | null;
  /** sumSimReturnPct / simCalls. Null when the exam has no simulated returns. */
  avgReturnPct: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The exam object stored on CuratorModel.evalMetrics. Null when the row has no usable record. */
export function readExam(raw: unknown): ExamView | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const graded = num(o.graded);
  const calls = num(o.calls);
  const wins = num(o.wins);
  const goals = num(o.goals);
  if (graded === null || calls === null || wins === null || goals === null) return null;
  const sumLabel = num(o.sumLabel);
  const sumRun = num(o.sumRun);
  const simCalls = num(o.simCalls);
  const sumSim = num(o.sumSimReturnPct);
  return {
    calls,
    graded,
    wins,
    goals,
    tenX: num(o.tenX),
    avgDoublings: graded > 0 && sumLabel !== null ? sumLabel / graded : null,
    avgRunDoublings: graded > 0 && sumRun !== null ? sumRun / graded : null,
    simCalls,
    avgReturnPct: simCalls !== null && simCalls > 0 && sumSim !== null ? sumSim / simCalls : null,
  };
}

export interface ScheduleInput {
  nowMs: number;
  /** Heartbeat interval, else the configured one. Null when neither is known. */
  intervalMs: number | null;
  lastRunAt: string | null;
  running: boolean;
  pending: boolean;
}

/**
 * When the next training run is due, from the heartbeat the scheduler actually writes.
 * A run in flight or a queued retrain has no finish time, so the next slot stays unknown.
 */
export function trainingScheduleView(input: ScheduleInput): { nextRunAt: string | null; basis: string } {
  if (input.running) {
    return {
      nextRunAt: null,
      basis:
        "A run is in progress. The next run is one interval after this one finishes. The finish time is not known.",
    };
  }
  if (input.pending) {
    return {
      nextRunAt: null,
      basis:
        "A retrain is queued. The trainer picks it up within about a minute, and the schedule restarts from that run.",
    };
  }
  if (!input.lastRunAt) {
    return { nextRunAt: null, basis: "No curator-training heartbeat yet, so the next run is not known." };
  }
  if (input.intervalMs === null || !(input.intervalMs > 0)) {
    return {
      nextRunAt: null,
      basis: "The trainer's interval is not on the heartbeat, so the next run time is not known.",
    };
  }
  const last = new Date(input.lastRunAt).getTime();
  if (Number.isNaN(last)) return { nextRunAt: null, basis: "The last run time could not be read." };
  const at = last + input.intervalMs;
  return {
    nextRunAt: new Date(at).toISOString(),
    basis:
      at <= input.nowMs
        ? "That slot has passed. The trainer starts the run when its process is up; this API cannot see that delay."
        : "One interval after the last heartbeat, which is the slot the trainer schedules when a run finishes.",
  };
}

/** What the trainer loads. The rule used is not stored on each model row. */
export function labelRuleSummary(input: {
  fitRule: number;
  fineTickRule: number;
  reportedRule: number;
  excludeFineTick: boolean;
}): string {
  const fine = input.excludeFineTick
    ? `Rule ${input.fineTickRule} (fine-tick) rows are excluded.`
    : `Rule ${input.fineTickRule} (fine-tick) rows are included.`;
  return `The trainer loads finalized rows on label rule ${input.fitRule} or newer. ${fine} Rules below ${input.fitRule} are not loaded. Live charts count rule ${input.reportedRule} and newer. Which rule a given model was fit on is not stored on the model row.`;
}

export function metaNumber(meta: unknown, key: string): number | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  return num((meta as Record<string, unknown>)[key]);
}

export function metaString(meta: unknown, key: string): string | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function metaBool(meta: unknown, key: string): boolean | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "boolean" ? v : null;
}

export function metaStages(meta: unknown, key: string): Record<string, number> | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [name, ms] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ms === "number" && Number.isFinite(ms)) out[name] = ms;
  }
  return Object.keys(out).length > 0 ? out : null;
}
