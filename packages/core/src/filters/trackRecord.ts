import { prisma } from "../db.js";

/** A filter's graded alerts over the last TRACK_RECORD_DAYS - see loadFilterTrackRecords. */
export interface FilterTrackRecord {
  /** Alerts whose 1h verdict is in. */
  graded: number;
  /** Doubled within the hour without first falling through the 50% stop. */
  won2x: number;
  /** Reached 4x within the hour, stop respected. */
  won4x: number;
}

/** The window a filter's record covers - recent enough to describe the filter as it stands. */
export const TRACK_RECORD_DAYS = 30;

/**
 * Each filter's graded alerts over the last TRACK_RECORD_DAYS: how many have a verdict, how many
 * doubled within the hour without the stop, and how many reached 4x. Scoped by user as well as
 * filter so the read rides Match's (userId, matchedAt) index.
 */
export async function loadFilterTrackRecords(
  filters: { id: string; userId: string }[],
): Promise<Map<string, FilterTrackRecord>> {
  const out = new Map<string, FilterTrackRecord>();
  if (filters.length === 0) return out;
  const since = new Date(Date.now() - TRACK_RECORD_DAYS * 86_400_000);
  const userIds = [...new Set(filters.map((f) => f.userId))];
  const filterIds = filters.map((f) => f.id);
  const rows = await prisma.$queryRaw<{ filterId: string; graded: bigint; won2x: bigint; won4x: bigint }[]>`
    SELECT "filterId",
           count(*) AS graded,
           count(*) FILTER (WHERE "hit2xIn1h" AND NOT "disqualified") AS won2x,
           count(*) FILTER (WHERE "hit4xIn1h") AS won4x
    FROM "Match"
    WHERE "userId" = ANY(${userIds}) AND "matchedAt" > ${since}
      AND "filterId" = ANY(${filterIds}) AND "hit2xIn1h" IS NOT NULL
    GROUP BY "filterId"`;
  for (const id of filterIds) out.set(id, { graded: 0, won2x: 0, won4x: 0 });
  for (const r of rows) {
    out.set(r.filterId, { graded: Number(r.graded), won2x: Number(r.won2x), won4x: Number(r.won4x) });
  }
  return out;
}
