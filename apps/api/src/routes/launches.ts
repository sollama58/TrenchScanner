import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { prisma, type Env } from "@trenchscanner/core";
import { TOKEN_CARD_SELECT, withLatestSnapshots } from "../curatedFeed.js";
import { SharedCache } from "../sharedCache.js";
import { currentMarketCap } from "./matches.js";
import { LIVE_TICK_MAX_TOKENS } from "./live.js";

/**
 * Cards the Stream shows: one live tick's worth (routes/live.ts), so every card's "Now" can be
 * kept seconds old by the same tick the Live feed uses.
 */
export const LAUNCH_STREAM_SIZE = LIVE_TICK_MAX_TOKENS;

/** How far back a band entry can be and still be on the Stream. */
const LAUNCH_STREAM_HORIZON_MS = 24 * 3_600_000;

/**
 * The newest band entries looked at for a screen pass. A token reaches the Stream at its first
 * passing scan inside the band, which is usually the scan that stamped firstInBandAt and at worst
 * a few cycles later, so the newest few hundred entries hold the newest LAUNCH_STREAM_SIZE passes.
 */
const LAUNCH_STREAM_CANDIDATES = 300;

/**
 * One read answers every open Stream for this long. The scan writes a cycle's snapshots a minute
 * or so apart and the dashboard polls every 10s, so a few seconds costs a viewer nothing.
 */
const LAUNCH_STREAM_CACHE_MS = 5_000;

/**
 * GET /launches - the dashboard's Stream: every new token the moment it has passed the safety
 * screen inside the curated mcap band (MCAP_FILTER_MIN to MAX), newest first, whatever anyone's
 * filter or the models make of it. A card sits at its first scan snapshot that both passed the rug
 * screen and was in the band; a token whose newest verdict has since failed drops off.
 *
 * The cards are shaped like the Live feed's (kind "stream", no filter, no call), so the dashboard
 * draws them with the same card and the reader's own card settings.
 */
export async function registerLaunchRoutes(app: FastifyInstance, opts: { env: Env }) {
  // Same gate as the feeds.
  app.addHook("preHandler", app.authenticateSubscriber);

  const cache = new SharedCache<Awaited<ReturnType<typeof readLaunches>>>(LAUNCH_STREAM_CACHE_MS);

  const readLaunches = async () => {
    const since = new Date(Date.now() - LAUNCH_STREAM_HORIZON_MS);
    // The newest band entries by Token(firstInBandAt), then each one's first passing in-band scan
    // snapshot down its own (tokenId, takenAt) index.
    const entries = await prisma.$queryRaw<{ tokenId: string; snapshotId: string }[]>(Prisma.sql`
      SELECT t.id AS "tokenId", s.id AS "snapshotId"
      FROM (
        SELECT id FROM "Token"
        WHERE "firstInBandAt" > ${since}
        ORDER BY "firstInBandAt" DESC
        LIMIT ${LAUNCH_STREAM_CANDIDATES}
      ) t
      CROSS JOIN LATERAL (
        SELECT id, "takenAt" FROM "TokenSnapshot"
        WHERE "tokenId" = t.id
          AND "source" = 'scan'
          AND "rugScreenPassed"
          AND "marketCapUsd" BETWEEN ${opts.env.MCAP_FILTER_MIN} AND ${opts.env.MCAP_FILTER_MAX}
        ORDER BY "takenAt" ASC
        LIMIT 1
      ) s
      ORDER BY s."takenAt" DESC
      LIMIT ${LAUNCH_STREAM_SIZE}
    `);
    if (entries.length === 0) return [];

    const [snapshots, tokens] = await Promise.all([
      prisma.tokenSnapshot.findMany({ where: { id: { in: entries.map((e) => e.snapshotId) } } }),
      prisma.token.findMany({
        where: { id: { in: entries.map((e) => e.tokenId) } },
        select: TOKEN_CARD_SELECT,
      }),
    ]);
    const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
    const tokenById = new Map(tokens.map((t) => [t.id, t]));
    // Ordered by the raw read: an `in` lookup makes no promise about row order.
    const rows = entries.flatMap((e) => {
      const snapshot = snapshotById.get(e.snapshotId);
      const token = tokenById.get(e.tokenId);
      return snapshot && token ? [{ snapshot, token }] : [];
    });
    const decorated = await withLatestSnapshots(rows);
    return decorated.flatMap(({ snapshot, token: { snapshots: latest, ...token } }) => {
      const latestSnapshot = latest[0] ?? null;
      // Passed on the way in but failed since (a dev dump, a flag RugCheck added): not a pass now.
      if (latestSnapshot && !latestSnapshot.rugScreenPassed) return [];
      const current = currentMarketCap(token, latestSnapshot);
      return [
        {
          id: `stream-${token.id}`,
          kind: "stream" as const,
          tokenId: token.id,
          // When it entered the Stream: the card's time is how long ago it passed.
          matchedAt: snapshot.takenAt,
          score: snapshot.score ?? 0,
          peakReturnPct: null,
          token,
          snapshot,
          latestSnapshot,
          currentMarketCapUsd: current.marketCapUsd,
          currentMarketCapAt: current.at,
          filter: null,
          curated: null,
          outcome: null,
        },
      ];
    });
  };

  app.get("/", async () => ({ launches: await cache.get(readLaunches) }));
}
