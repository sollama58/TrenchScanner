import { Prisma } from "@prisma/client";
import { RETIRED_CONTESTANT_IDS } from "./contestants.js";

/**
 * Whether a CuratedAlert row is the first call on its grading row, as a SQL condition.
 *
 * When several models call the same token at the same moment, their alerts share one
 * CandidateOutcome and so one exit-plan return. A figure that pools every model's calls would
 * count that return once per model, and the tokens many models agree on are the ones that do
 * better, so the pooled average read about 5 points high (2026-10-11: -5.4% pooled against -10.7%
 * with each grading row once, 6,302 calls on 2,230 rows). Pooled returns count only the first
 * call on each row; a per-model figure needs no such filter (a model never calls one row twice).
 *
 * `sameColumn` limits "first" to calls sharing that column's value (a breakdown whose groups are
 * not summed into a total, like the conviction tiers). A call with no grading row counts as its
 * own first. Uses the candidateOutcomeId index.
 */
export function firstCallOnRowSql(alias = "a", sameColumn?: string): Prisma.Sql {
  const a = Prisma.raw(`"${alias}"`);
  const same = sameColumn
    ? Prisma.sql` AND e.${Prisma.raw(`"${sameColumn}"`)} IS NOT DISTINCT FROM ${a}.${Prisma.raw(`"${sameColumn}"`)}`
    : Prisma.empty;
  return Prisma.sql`(${a}."candidateOutcomeId" IS NULL OR NOT EXISTS (
    SELECT 1 FROM "CuratedAlert" e
    WHERE e."candidateOutcomeId" = ${a}."candidateOutcomeId"${same}
      AND ${retiredExcluded("e")}
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
