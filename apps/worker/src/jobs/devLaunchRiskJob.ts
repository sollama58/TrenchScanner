import {
  prisma,
  Prisma,
  createLogger,
  devLaunchMarket,
  devLaunchScore,
  DEV_LAUNCH_GRADE_KINDS,
  DEV_LAUNCH_SETTLE_MS,
  DEV_LAUNCH_WINDOW_DAYS,
  DEV_FAMILY_MAX_CREATORS,
  HOT_FUNDER_DENYLIST,
  RISKY_DEV_LAUNCH_SCORE,
  type DevLaunchStats,
} from "@trenchscanner/core";
import type { JobRunMeta } from "../scheduler.js";
import { replaceRows, type ReplaceRowsSpec } from "./replaceRows.js";

const logger = createLogger("dev-launch-risk");

/**
 * Rebuilds the dev launch scores (DevLaunchRisk, DevFunderRisk; core's wallets/devLaunchScore.ts),
 * hourly: every creator's launches in the last DEV_LAUNCH_WINDOW_DAYS, how each went, and the
 * family of creators each funder paid for.
 *
 * A launch is a Token row with its creator known, first seen at least DEV_LAUNCH_SETTLE_MS before
 * `now`. It reached the band when firstInBandAt is set; its grade is its earliest outcome row of
 * DEV_LAUNCH_GRADE_KINDS finalized before `now` (only coins that reached the band are sampled, so
 * the others aren't looked up). The scan takes a coin's own launch back out of its creator's
 * record with the same rule against the same `now` (devLaunchBook.ts ownLaunchesOf), which the
 * heartbeat carries as builtAt.
 */

/** The same address check the Token.creator backfill used (20261017003000_token_creator). */
const WALLET_SQL_RE = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";

/** A creator's row is kept with two launches or more, one in the band, or a family. */
const MIN_LAUNCHES = 2;

const DEV_LAUNCH_TABLE: ReplaceRowsSpec = {
  table: "DevLaunchRisk",
  key: "wallet",
  columns: [
    { name: "wallet", type: "text" },
    { name: "score", type: "double precision" },
    { name: "launches", type: "integer" },
    { name: "inBand", type: "integer" },
    { name: "graded", type: "integer" },
    { name: "wins", type: "integer" },
    { name: "stops", type: "integer" },
    { name: "funder", type: "text" },
    { name: "lastLaunchAt", type: "timestamp(3)" },
    { name: "computedAt", type: "timestamp(3)" },
  ],
  stampColumns: ["computedAt"],
};

const DEV_FUNDER_TABLE: ReplaceRowsSpec = {
  table: "DevFunderRisk",
  key: "funder",
  columns: [
    { name: "funder", type: "text" },
    { name: "creators", type: "integer" },
    { name: "score", type: "double precision" },
    { name: "launches", type: "integer" },
    { name: "inBand", type: "integer" },
    { name: "graded", type: "integer" },
    { name: "wins", type: "integer" },
    { name: "stops", type: "integer" },
    { name: "computedAt", type: "timestamp(3)" },
  ],
  stampColumns: ["computedAt"],
};

type CountRow = Record<keyof DevLaunchStats, bigint>;

const stats = (r: CountRow): DevLaunchStats => ({
  launches: Number(r.launches),
  inBand: Number(r.inBand),
  graded: Number(r.graded),
  wins: Number(r.wins),
  stops: Number(r.stops),
});

/**
 * Each launch in the window, as `l`: its creator, when it was first seen, whether it reached the
 * band, and its grade (win/stop null when ungraded). Shared by the rebuild's three reads.
 */
function launchesSql(now: Date): Prisma.Sql {
  const since = new Date(now.getTime() - DEV_LAUNCH_WINDOW_DAYS * 86_400_000);
  const settled = new Date(now.getTime() - DEV_LAUNCH_SETTLE_MS);
  return Prisma.sql`(
    SELECT t."creator", t."firstSeenAt",
           (t."firstInBandAt" IS NOT NULL AND t."firstInBandAt" < ${now}) AS "inBand",
           g."win", g."stop"
    FROM "Token" t
    LEFT JOIN LATERAL (
      SELECT (c."hit2xIn1h" IS TRUE AND c."disqualified" IS NOT TRUE) AS "win",
             (c."stoppedAt" IS NOT NULL) AS "stop"
      FROM "CandidateOutcome" c
      WHERE t."firstInBandAt" IS NOT NULL
        AND c."tokenId" = t."id"
        AND c."sampleKind" = ANY(${[...DEV_LAUNCH_GRADE_KINDS]})
        AND c."finalizedAt" IS NOT NULL AND c."finalizedAt" < ${now}
      ORDER BY c."anchorAt" ASC
      LIMIT 1
    ) g ON true
    WHERE t."firstSeenAt" >= ${since} AND t."firstSeenAt" < ${settled}
      AND t."creator" ~ ${WALLET_SQL_RE}
  ) l`;
}

const countsSql = Prisma.sql`COUNT(*) AS "launches",
  COUNT(*) FILTER (WHERE l."inBand") AS "inBand",
  COUNT(*) FILTER (WHERE l."win" IS NOT NULL) AS "graded",
  COUNT(*) FILTER (WHERE l."win") AS "wins",
  COUNT(*) FILTER (WHERE l."stop") AS "stops"`;

export async function runDevLaunchRiskJob(opts: { now?: () => number } = {}): Promise<JobRunMeta> {
  const now = new Date((opts.now ?? Date.now)());
  // One pass: the launches, each creator's record, its funder (exchanges, launchpads and the busy
  // funders FunderActivity marks hot aside), and each funder's family of two creators or more.
  const rows = await prisma.$queryRaw<
    (CountRow & {
      creator: string;
      lastLaunchAt: Date;
      funder: string | null;
      familyCreators: bigint | null;
    } & { [K in keyof DevLaunchStats as `f_${K}` | `t_${K}`]: bigint | null })[]
  >`
    WITH launches AS (SELECT * FROM ${launchesSql(now)}),
    creators AS (
      SELECT l."creator", ${countsSql}, MAX(l."firstSeenAt") AS "lastLaunchAt"
      FROM launches l
      GROUP BY l."creator"
    ),
    funded AS (
      SELECT c.*, f."funder"
      FROM creators c
      JOIN "WalletFunder" f ON f."wallet" = c."creator"
      LEFT JOIN "FunderActivity" fa ON fa."address" = f."funder"
      WHERE f."status" = 'found' AND f."funder" IS NOT NULL AND f."funder" <> c."creator"
        AND fa."hot" IS NOT TRUE
        AND f."funder" <> ALL(${[...HOT_FUNDER_DENYLIST]})
    ),
    families AS (
      SELECT f."funder", COUNT(*) AS "creators",
             SUM(f."launches")::bigint AS "launches", SUM(f."inBand")::bigint AS "inBand", SUM(f."graded")::bigint AS "graded",
             SUM(f."wins")::bigint AS "wins", SUM(f."stops")::bigint AS "stops"
      FROM funded f
      GROUP BY f."funder"
      HAVING COUNT(*) >= 2 AND COUNT(*) <= ${DEV_FAMILY_MAX_CREATORS}
    ),
    -- The market's rates over every launch in the window, the once-seen creators included.
    totals AS (
      SELECT SUM(c."launches")::bigint AS "t_launches", SUM(c."inBand")::bigint AS "t_inBand", SUM(c."graded")::bigint AS "t_graded",
             SUM(c."wins")::bigint AS "t_wins", SUM(c."stops")::bigint AS "t_stops"
      FROM creators c
    )
    SELECT c."creator", c."launches", c."inBand", c."graded", c."wins", c."stops", c."lastLaunchAt",
           fam."funder", fam."creators" AS "familyCreators",
           fam."launches" AS "f_launches", fam."inBand" AS "f_inBand", fam."graded" AS "f_graded",
           fam."wins" AS "f_wins", fam."stops" AS "f_stops", totals.*
    FROM creators c
    CROSS JOIN totals
    LEFT JOIN funded fd ON fd."creator" = c."creator"
    LEFT JOIN families fam ON fam."funder" = fd."funder"
    WHERE c."launches" >= ${MIN_LAUNCHES} OR c."inBand" > 0 OR fam."funder" IS NOT NULL`;

  const t = rows[0];
  const totals = stats({
    launches: t?.t_launches ?? 0n,
    inBand: t?.t_inBand ?? 0n,
    graded: t?.t_graded ?? 0n,
    wins: t?.t_wins ?? 0n,
    stops: t?.t_stops ?? 0n,
  });
  const market = devLaunchMarket(totals);

  const creators = rows.map((r) => {
    const s = stats(r);
    return {
      wallet: r.creator,
      score: devLaunchScore(s, market) ?? 0,
      ...s,
      funder: r.funder,
      lastLaunchAt: r.lastLaunchAt,
      computedAt: now,
    };
  });
  const families = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    if (r.funder === null || families.has(r.funder)) continue;
    const s = stats({
      launches: r.f_launches ?? 0n,
      inBand: r.f_inBand ?? 0n,
      graded: r.f_graded ?? 0n,
      wins: r.f_wins ?? 0n,
      stops: r.f_stops ?? 0n,
    });
    families.set(r.funder, {
      funder: r.funder,
      creators: Number(r.familyCreators ?? 0),
      score: devLaunchScore(s, market) ?? 0,
      ...s,
      computedAt: now,
    });
  }

  // maxWait as in walletRiskJob: the trainer's pool is shared with the other hourly jobs.
  const [devs, funders] = await prisma.$transaction(
    async (tx) => [
      await replaceRows(tx, DEV_LAUNCH_TABLE, creators),
      await replaceRows(tx, DEV_FUNDER_TABLE, [...families.values()]),
    ],
    { maxWait: 30_000, timeout: 120_000 },
  );

  const round = (x: number) => Math.round(x * 10_000) / 10_000;
  const meta: JobRunMeta = {
    // The cut the scan's own-launch read must use (devLaunchBook.ts).
    builtAt: now.toISOString(),
    launches: totals.launches,
    creators: creators.length,
    families: families.size,
    written: devs.written + funders.written,
    removed: devs.deleted + funders.deleted,
    risky: creators.filter((c) => c.score >= RISKY_DEV_LAUNCH_SCORE).length,
    bandRate: round(market.bandRate),
    winRate: round(market.winRate),
    stopRate: round(market.stopRate),
  };
  logger.info("dev launch risk rebuilt", meta);
  return meta;
}
