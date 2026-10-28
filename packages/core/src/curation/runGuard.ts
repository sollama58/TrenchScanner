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
  /**
   * When the training set's loading rules last changed on purpose (TRAINING_ROW_RULES_SINCE).
   * Running models that went live before it counted rows under the older rules, so their count
   * says nothing about rows going missing: the row check compares only against models since.
   */
  rowRulesSince?: Date;
}

/**
 * When the loader's rules last narrowed the training set on purpose: the data-correctness audit
 * of 2026-10-16 (#674 and its follow-ups: a 3-hour age cap on every row, rows off the current
 * label rule and frozen-curve rows left out, the scan's own cap for the band) took the set from
 * about 38,000 rows to about 16,000. The running models then saw the old count, so every run
 * after held for the full CURATOR_GUARD_MAX_HOLD_HOURS as "rows went missing". The deploy of #674,
 * with slack on the early side so no model trained under the new rules is left out. Move it
 * forward whenever a change shrinks the set on purpose.
 */
export const TRAINING_ROW_RULES_SINCE = new Date("2026-10-16T18:00:00Z");

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
  // Only running models trained under the current loading rules say how many rows to expect (a
  // model with no activation time predates the column, so it predates the rules too).
  const since = input.rowRulesSince?.getTime() ?? -Infinity;
  const comparable = input.incumbents.filter((m) => (m.activatedAt?.getTime() ?? -Infinity) >= since);
  const priorRows = comparable.length > 0 ? Math.max(...comparable.map((m) => m.trainingRows)) : 0;
  const expected = Math.min(priorRows, input.maxRows);
  if (comparable.length > 0 && input.trainingRows < expected * MIN_ROW_SHARE) {
    problems.push(`trained on ${input.trainingRows} rows, under half the ${expected} the running models saw`);
  }
  const calling = (kind: string, threshold: number | null) =>
    kind !== RULES_MODEL_KIND && threshold !== null && threshold < NEVER_EMIT_THRESHOLD;
  const wasCalling = input.incumbents.filter((m) => calling(m.kind, m.threshold)).length;
  const nowCalling = input.results.filter((r) => calling(r.kind, thresholdOf(r.params))).length;
  if (wasCalling > 0 && nowCalling === 0) {
    problems.push(`every seat would go silent (${wasCalling} alerting now, none after this run)`);
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
        `${s.contestant}: alerted on ${pct(s.calls / decisions)} of ${decisions} decision moments against a ${pct(targetShare)} share`,
      );
    }
  }
  const active = seats.filter((s) => s.calledBefore);
  const quiet = active.filter((s) => s.calls === 0);
  if (active.length >= 4 && quiet.length * 2 > active.length) {
    out.push(
      `${quiet.length} of ${active.length} alerting seats raised no alert in ${decisions} decision moments`,
    );
  }
  return out;
}

/** An input read by the learners whose fill on the newest rows fell under this share of its reference fill. */
export const FILL_DROP_RATIO = 0.4;

/**
 * Inputs the learners read that went dead lately (a source down), and retired inputs that came
 * back to life (worth judging again). The onset guard already keeps a dead input out of the run;
 * this makes it visible. An input is also judged within each age bucket (2026-10-16,
 * data-correctness audit: the holder count went from 99% to 6% filled on coins under five
 * minutes old while its pooled fill stayed over 80%, and no alarm fired); the message names the
 * bucket.
 */
export function fillRateAlarms(
  /** inputFills (featureOnset.ts): each input's fill on the reference span and the newest rows, and per age bucket. */
  fills: readonly HeldFeature[],
  read: ReadonlySet<string>,
  retired: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  const wentDead = (referencePct: number, recentPct: number) =>
    referencePct >= 20 && recentPct < referencePct * FILL_DROP_RATIO;
  for (const f of fills) {
    if (read.has(f.feature) && wentDead(f.referencePct, f.recentPct)) {
      out.push(`${f.feature} went dead: ${f.recentPct}% of the newest rows against ${f.referencePct}%`);
    } else if (read.has(f.feature)) {
      for (const b of f.buckets ?? []) {
        if (wentDead(b.referencePct, b.recentPct)) {
          out.push(
            `${f.feature} went dead at ${b.bucket}: ${b.recentPct}% of the newest ${b.recentRows} rows against ${b.referencePct}%`,
          );
        }
      }
    } else if (retired.has(f.feature) && f.referencePct < 2 && f.recentPct >= 20) {
      out.push(`${f.feature} (retired as dead) is filled again on ${f.recentPct}% of the newest rows`);
    }
  }
  return out;
}

/** The span the zero-era scan compares: six hours of decision moments. */
export const ZERO_ERA_BLOCK_MS = 6 * 3_600_000;
/** A block judges an input only on at least this many rows that carry it. */
export const ZERO_ERA_MIN_FILLED = 20;
/** A block whose zero share sits this far from the input's usual share (in share points) is an era. */
export const ZERO_ERA_STEP = 0.4;
/**
 * For a mostly-zero input, where a 40-point step can't happen: blocks whose non-zero share fell
 * under this fraction of the usual one, each on enough rows that the usual share expects at least
 * ZERO_ERA_MIN_EXPECTED non-zero readings in it, and together at least ZERO_ERA_MIN_RUN_EXPECTED.
 * One thin block of a rare input reads all zeros by chance often enough (on the 10-13..26 export,
 * a 6-hour block at 6% non-zero did so for one input in ten) that a lone one is not an era.
 */
export const ZERO_ERA_NONZERO_RATIO = 0.2;
export const ZERO_ERA_MIN_EXPECTED = 8;
export const ZERO_ERA_MIN_RUN_EXPECTED = 30;
/** Calendar inputs: their value follows the clock by design (ctxWeekend is 0 all week). */
const ZERO_ERA_EXEMPT: ReadonlySet<string> = new Set(["ctxHourSin", "ctxHourCos", "ctxWeekend"]);

/** One run of consecutive blocks where an input's zero share left its usual level. */
export interface ZeroEra {
  feature: string;
  from: Date;
  until: Date;
  /** Zero share among the era's filled rows, and the input's usual (median block) share, 0-1. */
  zeroShare: number;
  usualZeroShare: number;
  filledRows: number;
}

/**
 * Stretches where a learner input read 0 far more (or far less) often than it usually does, on
 * the decision moments of the training window (full audit 2026-10-27, MT-5/MT-6). A source that
 * breaks often reports 0 rather than nothing: TokenSage's logo reuse read 0 on every row from
 * 10-20 to 10-23 and its X read flag from 10-22 20:00 to 10-23 20:00, and both trained as an era
 * until someone scanned for them. The rows have their known masks applied already
 * (maskKnownBadInputs turns a masked 0 into a missing value), so an era found here is one no mask
 * covers yet. Fill gaps are not judged: a missing value is honest, and fillRateAlarms covers an
 * input going dead. Pure; the caller passes the rows it trains on.
 */
export function findZeroEras(
  rows: readonly {
    anchorAt: Date;
    features: Record<string, number | null | undefined>;
    sampleKind?: string;
  }[],
  features: readonly string[],
): ZeroEra[] {
  const blocks = new Map<number, Map<string, [filled: number, zeros: number]>>();
  for (const r of rows) {
    if (r.sampleKind !== undefined && r.sampleKind !== "event") continue;
    const b = Math.floor(r.anchorAt.getTime() / ZERO_ERA_BLOCK_MS);
    let m = blocks.get(b);
    if (!m) blocks.set(b, (m = new Map()));
    for (const name of features) {
      const v = r.features[name];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      let c = m.get(name);
      if (!c) m.set(name, (c = [0, 0]));
      c[0]++;
      if (v === 0) c[1]++;
    }
  }
  const keys = [...blocks.keys()].sort((a, b) => a - b);
  const out: ZeroEra[] = [];
  for (const name of features) {
    if (ZERO_ERA_EXEMPT.has(name)) continue;
    const judged = keys.flatMap((k) => {
      const c = blocks.get(k)!.get(name);
      return c && c[0] >= ZERO_ERA_MIN_FILLED ? [{ block: k, filled: c[0], zeros: c[1] }] : [];
    });
    if (judged.length < 4) continue;
    const shares = judged.map((j) => j.zeros / j.filled).sort((a, b) => a - b);
    const usual = shares[Math.floor(shares.length / 2)]!;
    const usualNonzero = 1 - usual;
    const stepped = (j: { filled: number; zeros: number }) =>
      Math.abs(j.zeros / j.filled - usual) >= ZERO_ERA_STEP;
    const collapsed = (j: { filled: number; zeros: number }) =>
      usualNonzero * j.filled >= ZERO_ERA_MIN_EXPECTED &&
      1 - j.zeros / j.filled < usualNonzero * ZERO_ERA_NONZERO_RATIO;
    let run: (typeof judged)[number][] = [];
    const close = () => {
      if (run.length === 0) return;
      const filled = run.reduce((s, j) => s + j.filled, 0);
      if (!run.some(stepped) && usualNonzero * filled < ZERO_ERA_MIN_RUN_EXPECTED) {
        run = [];
        return;
      }
      out.push({
        feature: name,
        from: new Date(run[0]!.block * ZERO_ERA_BLOCK_MS),
        until: new Date((run[run.length - 1]!.block + 1) * ZERO_ERA_BLOCK_MS),
        zeroShare: run.reduce((s, j) => s + j.zeros, 0) / filled,
        usualZeroShare: usual,
        filledRows: filled,
      });
      run = [];
    };
    for (const j of judged) {
      // A judged block in between that looks usual ends the run; a block too thin to judge doesn't.
      if (stepped(j) || collapsed(j)) run.push(j);
      else close();
    }
    close();
  }
  return out;
}

/** Most inputs the zero-era alarm names; the rest are counted. */
export const ZERO_ERA_MAX_ALARMS = 10;

/** The alarm lines for findZeroEras' eras, one per input (its longest era): alarm only. */
export function zeroEraAlarms(eras: readonly ZeroEra[]): string[] {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const at = (d: Date) => d.toISOString().slice(0, 16).replace("T", " ");
  const byInput = new Map<string, ZeroEra[]>();
  for (const e of eras) byInput.set(e.feature, [...(byInput.get(e.feature) ?? []), e]);
  const lines = [...byInput.values()]
    .map((list) => {
      const e = list.reduce((a, b) => (b.filledRows > a.filledRows ? b : a));
      const more = list.length > 1 ? ` (and ${list.length - 1} more)` : "";
      return {
        rows: e.filledRows,
        line: `${e.feature} read 0 on ${pct(e.zeroShare)} of ${e.filledRows} decision moments ${at(e.from)}-${at(e.until)} UTC against a usual ${pct(e.usualZeroShare)}${more}: a false-zero era for maskKnownBadInputs?`,
      };
    })
    .sort((a, b) => b.rows - a.rows);
  const out = lines.slice(0, ZERO_ERA_MAX_ALARMS).map((l) => l.line);
  if (lines.length > ZERO_ERA_MAX_ALARMS)
    out.push(`${lines.length - ZERO_ERA_MAX_ALARMS} more inputs with a zero era`);
  return out;
}
