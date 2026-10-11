import { Prisma } from "@prisma/client";
import { RETIRED_CONTESTANT_IDS } from "./contestants.js";

/** The call ledgers firstCallOnRowSql can read: live calls and the bench's shadow calls. */
export type CallTable = "CuratedAlert" | "CuratedShadowEmission";

export interface FirstCallOptions {
  /** The alias the outer query gives the call table. */
  alias?: string;
  table?: CallTable;
  /**
   * Limit "first" to calls sharing this column's value: a breakdown whose groups are not summed
   * into a total (the conviction tiers), where each group should count its own first call.
   */
  sameColumn?: string;
  /**
   * Limit "first" to calls on the same side of the heuristic/model split: `source` equal to this
   * value or not (the curator records report the two sides separately).
   */
  heuristicSource?: string;
}

/**
 * Whether a call is the first call on its grading row, as a SQL condition.
 *
 * When several models call the same token at the same moment, their calls share one
 * CandidateOutcome: one 2x, 4x and 10x verdict and one exit-plan return. A figure that pools every
 * model's calls would count that token once per model, and the tokens many models agree on are
 * the ones that do better, so pooled figures read high (2026-10-11, 7 days: a 23.7% 2x rate and a
 * -5.4% return pooled, against 20.3% and -10.7% with each grading row once; 6,302 calls on 2,230
 * rows). Pooled figures count only the first call on each row. A per-model figure needs no such
 * filter: a model never calls one row twice.
 *
 * A call with no grading row counts as its own first. Reads the candidateOutcomeId index.
 */
export function firstCallOnRowSql(opts: FirstCallOptions = {}): Prisma.Sql {
  const a = Prisma.raw(`"${opts.alias ?? "a"}"`);
  const table = Prisma.raw(`"${opts.table ?? "CuratedAlert"}"`);
  const same: Prisma.Sql[] = [];
  if (opts.sameColumn) {
    const col = Prisma.raw(`"${opts.sameColumn}"`);
    same.push(Prisma.sql` AND e.${col} IS NOT DISTINCT FROM ${a}.${col}`);
  }
  if (opts.heuristicSource !== undefined) {
    same.push(
      Prisma.sql` AND (e."source" = ${opts.heuristicSource}) = (${a}."source" = ${opts.heuristicSource})`,
    );
  }
  // A retired seat's call is out of live stats, so it can't be a row's first either: the next
  // seat's call counts instead. Shadow rows carry no seat.
  if ((opts.table ?? "CuratedAlert") === "CuratedAlert") same.push(Prisma.sql` AND ${retiredExcluded("e")}`);
  return Prisma.sql`(${a}."candidateOutcomeId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM ${table} e
    WHERE e."candidateOutcomeId" = ${a}."candidateOutcomeId"${same.length ? Prisma.join(same, "") : Prisma.empty}
      AND (e."createdAt" < ${a}."createdAt" OR (e."createdAt" = ${a}."createdAt" AND e."id" < ${a}."id"))))`;
}

/**
 * A CuratedAlert row from a seat that still runs, as a SQL condition: a retired seat's calls
 * (ContestantSpec.retired - Ranker since 2026-10-11) stay in the table but out of live stats and
 * pooled averages. A pooled figure filters on this; a call on a row a retired seat called first
 * then counts as that row's first (firstCallOnRowSql skips the retired call too).
 */
export function notRetiredModelSql(alias = "a"): Prisma.Sql {
  return retiredExcluded(alias);
}

function retiredExcluded(alias: string): Prisma.Sql {
  if (RETIRED_CONTESTANT_IDS.length === 0) return Prisma.sql`TRUE`;
  const model = Prisma.raw(`"${alias}"."model"`);
  // A call from before the ledgers (model NULL) is no retired seat's.
  return Prisma.sql`(${model} IS NULL OR ${model} NOT IN (${Prisma.join(RETIRED_CONTESTANT_IDS)}))`;
}
