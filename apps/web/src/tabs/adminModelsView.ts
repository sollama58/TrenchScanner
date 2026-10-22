/**
 * State for Admin > Models + Training. Mirrors apps/api/src/modelsDesk.ts readExam: a stored exam
 * only yields a rate when the column is actually there.
 */

import type { LeaderboardEntry, LearningCurve, LearningRun } from "../api";

export interface ExamView {
  calls: number;
  graded: number;
  wins: number;
  goals: number;
  tenX: number | null;
  avgDoublings: number | null;
  avgRunDoublings: number | null;
  simCalls: number | null;
  avgReturnPct: number | null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Same rules as modelsDesk.readExam. Null when the row has no usable exam. */
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

export interface RosterSeat {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  retired: boolean;
  control: boolean;
}

export interface ExplainSeatRef {
  id: string;
  name: string;
  status: string;
  callsPerHour: number;
}

/** One row of the comparison. Missing board fields stay null — they are not zero. */
export interface CompareRow {
  id: string;
  name: string;
  role: string;
  enabled: boolean;
  retired: boolean;
  status: string | null;
  score: number | null;
  graded: number | null;
  hit2x: number | null;
  hit4x: number | null;
  avgReturnPct: number | null;
  avgDoublings: number | null;
  last24hGraded: number | null;
  last24hHit: number | null;
  last24hReturn: number | null;
  callsPerHour: number | null;
}

export function compareRows(
  roster: readonly RosterSeat[],
  explain: readonly ExplainSeatRef[],
  board: readonly LeaderboardEntry[] | null,
): CompareRow[] {
  const byExplain = new Map(explain.map((s) => [s.id, s]));
  const byBoard = new Map((board ?? []).map((e) => [e.id, e]));
  const rows: CompareRow[] = roster.map((seat) => {
    const ex = byExplain.get(seat.id);
    const b = byBoard.get(seat.id);
    const live = b?.composite.live;
    return {
      id: seat.id,
      name: b?.name ?? ex?.name ?? seat.name,
      role: seat.role,
      enabled: seat.enabled,
      retired: seat.retired,
      status: b?.status ?? ex?.status ?? null,
      score: b?.composite.score ?? null,
      graded: live?.graded ?? null,
      hit2x: live?.winRatePct ?? null,
      hit4x: live?.goalRatePct ?? null,
      avgReturnPct: live?.avgSimReturnPct ?? null,
      avgDoublings: live?.avgReturnDoublings ?? null,
      last24hGraded: b?.last24h?.graded ?? null,
      last24hHit: b?.last24h?.hitRate2xPct ?? null,
      last24hReturn: b?.last24h?.avgReturnPct ?? null,
      callsPerHour: ex?.callsPerHour ?? null,
    };
  });
  // A board entry the roster does not list (an old id) still belongs in the comparison.
  for (const b of board ?? []) {
    if (rows.some((r) => r.id === b.id)) continue;
    const live = b.composite.live;
    rows.push({
      id: b.id,
      name: b.name,
      role: b.role,
      enabled: false,
      retired: false,
      status: b.status,
      score: b.composite.score,
      graded: live.graded,
      hit2x: live.winRatePct,
      hit4x: live.goalRatePct,
      avgReturnPct: live.avgSimReturnPct ?? null,
      avgDoublings: live.avgReturnDoublings,
      last24hGraded: b.last24h?.graded ?? null,
      last24hHit: b.last24h?.hitRate2xPct ?? null,
      last24hReturn: b.last24h?.avgReturnPct ?? null,
      callsPerHour: null,
    });
  }
  return rows;
}

/**
 * The seat on screen. A picked id stays while it is still a seat or a roster entry, so a slow
 * reload cannot swap in another model. A picked id that disappeared falls back to the default.
 */
export function resolveSelection(
  picked: string | null,
  seats: readonly { id: string }[],
  roster: readonly { id: string }[],
  fallbackId: string | null,
): string | null {
  if (picked && (seats.some((s) => s.id === picked) || roster.some((r) => r.id === picked))) return picked;
  if (fallbackId && (seats.some((s) => s.id === fallbackId) || roster.some((r) => r.id === fallbackId)))
    return fallbackId;
  return seats[0]?.id ?? roster[0]?.id ?? null;
}

export interface StageProgress {
  done: string[];
  current: string | null;
  doneCount: number;
  total: number;
}

/** How far a run in flight has got. The current step is not counted as finished. */
export function trainingProgress(
  order: readonly string[],
  done: Record<string, number> | null | undefined,
  step: string | null | undefined,
): StageProgress {
  const finished = new Set(Object.keys(done ?? {}));
  const current = step ? step.split(":")[0]!.trim() : null;
  const known = order.filter((name) => finished.has(name));
  const extra = [...finished].filter((name) => !order.includes(name));
  return {
    done: [...known, ...extra],
    current: current && !finished.has(current) ? current : current,
    doneCount: known.length,
    total: order.length,
  };
}

export interface BarRow {
  label: string;
  value: number | null;
}

/** Stage durations in minutes, known stages first. Non-numeric entries are dropped. */
export function stageBars(
  stages: Record<string, number> | null | undefined,
  order: readonly string[],
): BarRow[] {
  if (!stages) return [];
  const names = [
    ...order.filter((n) => typeof stages[n] === "number"),
    ...Object.keys(stages).filter((n) => !order.includes(n)),
  ];
  return names
    .filter((name) => typeof stages[name] === "number" && Number.isFinite(stages[name]))
    .map((name) => ({ label: name, value: stages[name]! / 60_000 }));
}

export interface LinePoint {
  label: string;
  values: (number | null)[];
}

/** Feed and market 2x rate by day. Days come from the curve; null rates stay null. */
export function feedRateSeries(days: LearningCurve["days"] | null | undefined): LinePoint[] {
  return (days ?? []).map((d) => ({
    label: d.day.slice(5),
    values: [d.feed?.rate2xPct ?? null, d.market?.rate2xPct ?? null],
  }));
}

/** One model's own 2x rate on the days it called. */
export function modelRateSeries(
  curve: LearningCurve | null | undefined,
  modelId: string | null,
): LinePoint[] {
  if (!curve || !modelId) return [];
  const model = curve.models?.find((m) => m.model === modelId);
  return (model?.days ?? []).map((d) => ({
    label: d.day.slice(5),
    values: [d.rates?.rate2xPct ?? null, d.rates?.avgReturnPct ?? null],
  }));
}

/** Exam score and 2x rate for one contestant across stored runs, oldest first. */
export function examSeries(
  runs: readonly LearningRun[] | null | undefined,
  contestant: string | null,
): LinePoint[] {
  if (!runs || !contestant) return [];
  const points: LinePoint[] = [];
  for (const run of [...runs].reverse()) {
    const model = run.models?.find((m) => m.contestant === contestant);
    if (!model) continue;
    const at = run.at ? run.at.slice(5, 10) : "";
    points.push({ label: at, values: [model.score, model.rate2xPct] });
  }
  return points;
}

/** Contiguous non-null runs. A gap is a break, not a zero. */
export function lineSegments(values: readonly (number | null)[]): { i: number; v: number }[][] {
  const out: { i: number; v: number }[][] = [];
  let cur: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (cur.length) out.push(cur);
      cur = [];
      return;
    }
    cur.push({ i, v });
  });
  if (cur.length) out.push(cur);
  return out;
}

export function hasNumber(values: readonly (number | null)[]): boolean {
  return values.some((v) => v !== null && Number.isFinite(v));
}
