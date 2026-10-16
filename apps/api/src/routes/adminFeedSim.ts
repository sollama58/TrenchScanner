import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, feedCatch, type FeedCatch } from "@trenchscanner/core";
import type { ReportCaches } from "./curated.js";
import { summarizeFeed, type FeedStats } from "../feedStats.js";
import { CURATED_MATCH_LINK_WINDOW_MS } from "../curatedFeed.js";
import { contestState } from "../contest.js";
import type { Env } from "@trenchscanner/core";
import {
  calledNear,
  feedStatsCards,
  openOutcomeRows,
  STATS_CALL_SELECT,
  STATS_MATCH_SELECT,
} from "./matches.js";

/**
 * The Admin feed simulator: how a feed made of any models and any switched-on filters would have
 * done over a window, four ways - the models alone, the filters alone, either (a reader with Model
 * alerts on) and both (Settings' "Only alerts both caught"). Hit rates are the Live feed's Stats
 * tiles (feedStatsCards + summarizeFeed, the same folding and grading); coverage is the Feed catch
 * meter (core feedCatch over the leaderboard's catch ledger, the Coverage Meter's runners).
 */

/** The leaderboard windows the simulator offers (its catch ledger is built per window). */
export const FEED_SIM_DAYS = [1, 7, 30] as const;

/** Per side: far above any real window, so it only bounds a runaway read. */
const FEED_SIM_MAX_ROWS = 20_000;

const idList = (re: RegExp, what: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? [...new Set(v.split(",").filter(Boolean))] : []))
    .pipe(z.array(z.string().regex(re, `not a ${what} id`)).max(64));

export const feedSimQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (FEED_SIM_DAYS as readonly number[]).includes(d), {
      message: `days must be one of ${FEED_SIM_DAYS.join(", ")}`,
    })
    .default(7),
  models: idList(/^[a-z0-9-]{1,40}$/, "model"),
  filters: idList(/^[a-z0-9]{8,40}$/i, "filter"),
});

export type FeedSimMode = "models" | "filters" | "either" | "both";

export interface FeedSimRow {
  mode: FeedSimMode;
  stats: FeedStats;
  catch: FeedCatch;
}

/**
 * Filter alerts from several readers' filters on one token are one event: kept once, the first,
 * with any later alert on the token inside the fold window dropped. Takes and returns newest first.
 */
export function dedupeByToken<T extends { tokenId: string; matchedAt: Date }>(
  newestFirst: readonly T[],
  windowMs: number = CURATED_MATCH_LINK_WINDOW_MS,
): T[] {
  const lastKept = new Map<string, number>();
  const kept: T[] = [];
  for (const m of [...newestFirst].reverse()) {
    const at = m.matchedAt.getTime();
    const prev = lastKept.get(m.tokenId);
    if (prev !== undefined && at - prev <= windowMs) continue;
    lastKept.set(m.tokenId, at);
    kept.push(m);
  }
  return kept.reverse();
}

/**
 * The "both" row's filter alerts: those a call stands beside (calledNear), then deduped. Paired
 * first, as the both-only feed does: deduping first kept a token's oldest alert, and when that one
 * was more than the fold window from the call while a later one (another picked filter's) was
 * within it, the token went uncounted though the reader's both-only feed shows that later card.
 */
export function bothCaughtMatches<T extends { tokenId: string; matchedAt: Date }>(
  newestFirst: readonly T[],
  calls: readonly { tokenId: string; createdAt: Date }[],
): T[] {
  const near = calledNear(calls);
  return dedupeByToken(newestFirst.filter((m) => near(m.tokenId, m.matchedAt)));
}

export async function registerAdminFeedSimRoutes(
  app: FastifyInstance,
  opts: { env: Env; reports: ReportCaches },
) {
  app.get("/feed-sim", async (request, reply) => {
    const parsed = feedSimQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { days } = parsed.data;
    const [board, state] = await Promise.all([opts.reports.leaderboard(days), contestState(opts.env)]);
    const models = parsed.data.models.filter((m) => state.roster.some((c) => c.id === m));
    const since = new Date(board.window.since);
    const hours = days * 24;

    // Only switched-on filters: the simulator answers "this feed, as it stands".
    const filters = await prisma.userFilter.findMany({
      where: { id: { in: parsed.data.filters }, isActive: true, deletedAt: null },
      select: { id: true },
    });
    const filterIds = filters.map((f) => f.id);
    const [rawMatches, calls, wins] = await Promise.all([
      filterIds.length === 0
        ? Promise.resolve([])
        : prisma.match.findMany({
            where: { filterId: { in: filterIds }, matchedAt: { gte: since } },
            orderBy: { matchedAt: "desc" },
            take: FEED_SIM_MAX_ROWS,
            select: STATS_MATCH_SELECT,
          }),
      models.length === 0
        ? Promise.resolve([])
        : prisma.curatedAlert.findMany({
            // From a fold window earlier, so a filter alert early in the window finds its call.
            where: {
              model: { in: models },
              createdAt: { gte: new Date(since.getTime() - CURATED_MATCH_LINK_WINDOW_MS) },
            },
            orderBy: { createdAt: "desc" },
            take: FEED_SIM_MAX_ROWS,
            select: STATS_CALL_SELECT,
          }),
      // The filters' clean 2x alerts by token at the latest one: filterWins, over these filters.
      filterIds.length === 0
        ? Promise.resolve([] as { token: string; at: Date }[])
        : prisma.$queryRaw<{ token: string; at: Date }[]>`
            SELECT "tokenId" AS token, max("matchedAt") AS at
              FROM "Match"
             WHERE "matchedAt" >= ${since}
               AND "filterId" = ANY(${filterIds})
               AND "hit2xIn1h" AND NOT COALESCE("disqualified", false)
             GROUP BY 1`,
    ]);
    const matches = dedupeByToken(rawMatches);
    const bothMatches = bothCaughtMatches(rawMatches, calls);
    const rowById = await openOutcomeRows([...new Set([...matches, ...bothMatches])]);
    // Calls before the window only pair with a filter alert; on their own they're outside it.
    const callsInWindow = calls.filter((c) => c.createdAt >= since);
    const filterSide = { count: filterIds.length, wins, since };
    const noFilters = { count: 0, wins: [], since };

    const row = (mode: FeedSimMode): FeedSimRow => {
      const cards =
        mode === "models"
          ? feedStatsCards([], callsInWindow, rowById, false)
          : mode === "filters"
            ? feedStatsCards(matches, [], rowById, false)
            : mode === "either"
              ? feedStatsCards(matches, callsInWindow, rowById, false)
              : feedStatsCards(bothMatches, calls, rowById, true);
      return {
        mode,
        stats: summarizeFeed(cards, hours),
        catch: feedCatch(
          board.catchLedger,
          mode === "filters" ? [] : models,
          mode === "models" ? noFilters : filterSide,
          mode === "both",
        ),
      };
    };

    return {
      days,
      since: since.toISOString(),
      models,
      filters: filterIds,
      rows: (["either", "both", "models", "filters"] as const).map(row),
      truncated: rawMatches.length === FEED_SIM_MAX_ROWS || calls.length === FEED_SIM_MAX_ROWS,
    };
  });
}
