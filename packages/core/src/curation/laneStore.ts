import { prisma } from "../db.js";
import type { CuratorRecipe } from "./contestants.js";
import type { Lane } from "./evolution.js";
import { LABEL_LOG2_CAP } from "./labels.js";
import type { CallRecord } from "./leaderboard.js";

/**
 * The contest's shared reads: the worker (emission, training) and the API (leaderboard, feeds)
 * must see the same lanes and grade the same live records, so both read through here.
 */

/** Each seat's current lane (CuratorLane with retiredAt null), newest first per slot. */
export async function loadCurrentLanes(): Promise<Lane[]> {
  const rows = await prisma.curatorLane.findMany({
    where: { retiredAt: null },
    orderBy: { bornAt: "desc" },
  });
  const seen = new Set<string>();
  const lanes: Lane[] = [];
  for (const r of rows) {
    if (seen.has(r.slot)) continue;
    seen.add(r.slot);
    lanes.push({
      slot: r.slot,
      name: r.name,
      description: r.description,
      recipe: r.recipe as unknown as CuratorRecipe,
      generation: r.generation,
      parentName: r.parentName,
      bornAt: r.bornAt,
    });
  }
  return lanes;
}

interface LiveRow {
  calls: bigint;
  graded: bigint;
  wins: bigint;
  goals: bigint;
  sum_label: number | null;
}

/**
 * One model's live record: its calls since `since`, graded exactly like the hit-rate report -
 * the alert's outcome copies when they've landed, else the linked training row. Returns in
 * doublings use the row's labelValue, or - once the row is pruned - the copied 1h peak, capped
 * the same way.
 */
export async function liveCallRecord(model: string, since: Date): Promise<CallRecord> {
  const [r] = await prisma.$queryRaw<LiveRow[]>`
    WITH calls AS (
      SELECT COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."disqualified", co."disqualified", false) AS dq,
             co."labelValue" AS label,
             a."peak1hReturnPct" AS peak
      FROM "CuratedAlert" a
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."model" = ${model} AND a."createdAt" >= ${since}
    )
    SELECT count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT dq) AS wins,
           count(*) FILTER (WHERE hit4x AND NOT dq) AS goals,
           sum(CASE WHEN hit2x AND NOT dq THEN
                 COALESCE(label, LEAST(log(2::numeric, GREATEST(1 + peak / 100, 1)::numeric)::float8, ${LABEL_LOG2_CAP}::float8))
               ELSE 0 END)::float8 AS sum_label
    FROM calls`;
  return {
    calls: Number(r?.calls ?? 0),
    graded: Number(r?.graded ?? 0),
    wins: Number(r?.wins ?? 0),
    goals: Number(r?.goals ?? 0),
    sumLabel: r?.sum_label ?? 0,
  };
}

/**
 * Each model's live record over the window - but never from before its current lane took the
 * seat: a new recipe starts with a clean record rather than inheriting the one it replaced.
 */
export async function liveCallRecords(
  models: readonly string[],
  since: Date,
  lanes: readonly Lane[],
): Promise<Map<string, CallRecord>> {
  const bornAt = new Map(lanes.map((l) => [l.slot, l.bornAt]));
  const out = new Map<string, CallRecord>();
  if (models.length === 0) return out;
  const froms = models.map((model) => {
    const born = bornAt.get(model);
    return born && born > since ? born : since;
  });
  // Every model in one grouped pass over the window, not one scan of CuratedAlert per model.
  // Each model's own start is applied per row; the range scan uses the earliest of them.
  const earliest = new Date(Math.min(...froms.map((d) => d.getTime())));
  const rows = await prisma.$queryRaw<(LiveRow & { model: string })[]>`
    WITH seats AS (
      SELECT * FROM unnest(${[...models]}::text[], ${froms.map((d) => d.toISOString())}::timestamp(3)[]) AS s(model, since)
    ),
    calls AS (
      SELECT a."model" AS model,
             COALESCE(a."hit2xIn1h", co."hit2xIn1h") AS hit2x,
             COALESCE(a."hit4xIn1h", co."hit4xIn1h") AS hit4x,
             COALESCE(a."disqualified", co."disqualified", false) AS dq,
             co."labelValue" AS label,
             a."peak1hReturnPct" AS peak
      FROM "CuratedAlert" a
      JOIN seats ON seats.model = a."model" AND a."createdAt" >= seats.since
      LEFT JOIN "CandidateOutcome" co ON co."id" = a."candidateOutcomeId"
      WHERE a."createdAt" >= ${earliest}
    )
    SELECT model,
           count(*) AS calls,
           count(*) FILTER (WHERE hit2x IS NOT NULL) AS graded,
           count(*) FILTER (WHERE hit2x AND NOT dq) AS wins,
           count(*) FILTER (WHERE hit4x AND NOT dq) AS goals,
           sum(CASE WHEN hit2x AND NOT dq THEN
                 COALESCE(label, LEAST(log(2::numeric, GREATEST(1 + peak / 100, 1)::numeric)::float8, ${LABEL_LOG2_CAP}::float8))
               ELSE 0 END)::float8 AS sum_label
    FROM calls
    GROUP BY model`;
  const byModel = new Map(rows.map((r) => [r.model, r]));
  for (const model of models) {
    const r = byModel.get(model);
    out.set(model, {
      calls: Number(r?.calls ?? 0),
      graded: Number(r?.graded ?? 0),
      wins: Number(r?.wins ?? 0),
      goals: Number(r?.goals ?? 0),
      sumLabel: r?.sum_label ?? 0,
    });
  }
  return out;
}
