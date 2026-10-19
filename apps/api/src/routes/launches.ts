import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma, type Env } from "@trenchscanner/core";
import { TOKEN_CARD_SELECT, withCarriedHolderLists, withLatestSnapshots } from "../curatedFeed.js";
import { SharedCacheMap } from "../sharedCache.js";
import { currentMarketCap, tokenSearchParam } from "./matches.js";
import { LIVE_TICK_MAX_TOKENS } from "./live.js";

/**
 * Cards the Stream shows: one live tick's worth (routes/live.ts), so every card's "Now" can be
 * kept seconds old by the same tick the Live feed uses.
 */
export const LAUNCH_STREAM_SIZE = LIVE_TICK_MAX_TOKENS;

/**
 * How many pages back the Stream goes. Each page deeper looks at LAUNCH_STREAM_CANDIDATES more
 * band entries, so this bounds what paging back costs; a day's passes fit well inside it.
 */
export const LAUNCH_STREAM_MAX_PAGES = 10;

/** One cached answer per page and per searched address; far more than are ever open at once. */
const LAUNCH_STREAM_CACHE_KEYS = 64;

export const launchQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(LAUNCH_STREAM_MAX_PAGES).default(1),
  /** A token's contract address: the Stream narrowed to that token (the dashboard's CA search). */
  mint: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "mint must be a Solana address")
    .optional(),
  /** A name, ticker or part of an address: the Stream narrowed to the tokens that hold it. */
  q: tokenSearchParam,
  /**
   * "1": only graduated tokens, each at its first passing in-band scan after it graduated - Scope's
   * "All screened graduated" column (user ask 2026-10-18).
   */
  graduated: z.enum(["0", "1"]).optional(),
  /**
   * "1": the Stream's tokens still on their curve at LAUNCH_SOON_MCAP_USD or more now, biggest
   * first - Scope's "About to graduate" column (bug report 2026-10-19: the newest Stream pages
   * alone rarely held one).
   */
  soon: z.enum(["0", "1"]).optional(),
});

/** About to graduate from this market cap now (apps/web scope.ts SOON_MCAP_USD). */
export const LAUNCH_SOON_MCAP_USD = 45_000;

/** `text` as an ILIKE pattern that matches it anywhere, its own % and _ taken literally. */
const containsPattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

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
 * Past its TTL, a page is still answered at once for this long while it refills behind the
 * reader (Scope's load, user ask 2026-10-18: nobody waits out a fill they didn't need to).
 */
const LAUNCH_STREAM_STALE_MS = 30_000;

/**
 * The graduated list (Scope's Graduated column) moves only when a token graduates and passes,
 * a few an hour, and its read looks three times as far back: kept longer, refilled behind readers.
 */
const LAUNCH_GRADUATED_CACHE_MS = 30_000;
const LAUNCH_GRADUATED_STALE_MS = 5 * 60_000;

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

  const cache = new SharedCacheMap<Awaited<ReturnType<typeof readLaunches>>>(
    LAUNCH_STREAM_CACHE_MS,
    LAUNCH_STREAM_CACHE_KEYS,
    LAUNCH_STREAM_STALE_MS,
  );
  const gradCache = new SharedCacheMap<Awaited<ReturnType<typeof readLaunches>>>(
    LAUNCH_GRADUATED_CACHE_MS,
    LAUNCH_STREAM_CACHE_KEYS,
    LAUNCH_GRADUATED_STALE_MS,
  );

  /** Page `page` of the Stream (or, with `mint`, that token's card alone), and whether an older page has any. */
  const readLaunches = async (
    page: number,
    mint: string | undefined,
    q?: string,
    graduated = false,
    soon = false,
  ) => {
    const since = new Date(Date.now() - LAUNCH_STREAM_HORIZON_MS);
    // A page deeper needs that many more passes, so it looks at that many more band entries. Fewer
    // entries graduate, and later than they enter the band, so graduated pages look further back.
    const candidates = mint ? 1 : LAUNCH_STREAM_CANDIDATES * page * (graduated || soon ? 3 : 1);
    const offset = mint ? 0 : (page - 1) * LAUNCH_STREAM_SIZE;
    // The newest band entries by Token(firstInBandAt), then each one's first passing in-band scan
    // snapshot down its own (tokenId, takenAt) index. One past the page says whether there is another.
    const entries = await prisma.$queryRaw<{ tokenId: string; snapshotId: string }[]>(Prisma.sql`
      SELECT t.id AS "tokenId", s.id AS "snapshotId"
      FROM (
        SELECT id, "liveMarketCapUsd", "liveDataAt" FROM "Token"
        WHERE "firstInBandAt" > ${since}
          ${mint ? Prisma.sql`AND "mintAddress" = ${mint}` : Prisma.empty}
          ${
            q
              ? Prisma.sql`AND ("symbol" ILIKE ${containsPattern(q)} OR "name" ILIKE ${containsPattern(q)}
                  OR "mintAddress" ILIKE ${containsPattern(q)})`
              : Prisma.empty
          }
        ORDER BY "firstInBandAt" DESC
        LIMIT ${candidates}
      ) t
      ${
        // Graduated only: first each candidate's newest graduation reading, one row down its index,
        // so the walk below runs only for the few that have graduated instead of reading every
        // snapshot of every token that never did (most of them) - what made the list slow.
        graduated
          ? Prisma.sql`JOIN LATERAL (
              SELECT "graduated" FROM "TokenSnapshot"
              WHERE "tokenId" = t.id AND "graduated" IS NOT NULL
              ORDER BY "takenAt" DESC
              LIMIT 1
            ) g ON g."graduated"`
          : soon
            ? // About to graduate: not graduated by its newest reading, and at the mark now - its
              // live market cap, or its newest scan's when that is newer (currentMarketCap).
              Prisma.sql`LEFT JOIN LATERAL (
                SELECT "graduated" FROM "TokenSnapshot"
                WHERE "tokenId" = t.id AND "graduated" IS NOT NULL
                ORDER BY "takenAt" DESC
                LIMIT 1
              ) g ON true
              JOIN LATERAL (
                SELECT "marketCapUsd", "takenAt" FROM "TokenSnapshot"
                WHERE "tokenId" = t.id
                ORDER BY "takenAt" DESC
                LIMIT 1
              ) l ON true
              CROSS JOIN LATERAL (
                SELECT CASE
                  WHEN t."liveMarketCapUsd" IS NOT NULL AND t."liveDataAt" >= l."takenAt"
                    THEN t."liveMarketCapUsd"
                  ELSE l."marketCapUsd"
                END AS mcap
              ) n`
            : Prisma.empty
      }
      CROSS JOIN LATERAL (
        SELECT id, "takenAt" FROM "TokenSnapshot"
        WHERE "tokenId" = t.id
          AND "source" = 'scan'
          AND "rugScreenPassed"
          ${graduated ? Prisma.sql`AND "graduated"` : Prisma.empty}
          AND "marketCapUsd" BETWEEN ${opts.env.MCAP_FILTER_MIN} AND ${opts.env.MCAP_FILTER_MAX}
        ORDER BY "takenAt" ASC
        LIMIT 1
      ) s
      ${soon ? Prisma.sql`WHERE g."graduated" IS NOT TRUE AND n.mcap >= ${LAUNCH_SOON_MCAP_USD}` : Prisma.empty}
      ORDER BY ${soon ? Prisma.sql`n.mcap DESC` : Prisma.sql`s."takenAt" DESC`}
      OFFSET ${offset}
      LIMIT ${LAUNCH_STREAM_SIZE + 1}
    `);
    const hasMore = !mint && entries.length > LAUNCH_STREAM_SIZE && page < LAUNCH_STREAM_MAX_PAGES;
    entries.splice(LAUNCH_STREAM_SIZE);
    if (entries.length === 0) return { launches: [], hasMore: false };

    const [snapshots, tokens] = await Promise.all([
      prisma.tokenSnapshot.findMany({ where: { id: { in: entries.map((e) => e.snapshotId) } } }),
      prisma.token.findMany({
        where: { id: { in: entries.map((e) => e.tokenId) } },
        select: TOKEN_CARD_SELECT,
      }),
    ]);
    // The entry row often has no holder list of its own (written only on a new reading): it carries
    // the coin's newest one before it, so the Linked tile keeps its clusters.
    const snapshotById = new Map((await withCarriedHolderLists(snapshots)).map((s) => [s.id, s]));
    const tokenById = new Map(tokens.map((t) => [t.id, t]));
    // Ordered by the raw read: an `in` lookup makes no promise about row order.
    const rows = entries.flatMap((e) => {
      const snapshot = snapshotById.get(e.snapshotId);
      const token = tokenById.get(e.tokenId);
      return snapshot && token ? [{ snapshot, token }] : [];
    });
    const decorated = await withLatestSnapshots(rows);
    const launches = decorated.flatMap(({ snapshot, token: { snapshots: latest, ...token } }) => {
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
    return { launches, hasMore };
  };

  app.get("/", async (request, reply) => {
    const parsed = launchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { mint, q } = parsed.data;
    const graduated = parsed.data.graduated === "1";
    const soon = !graduated && parsed.data.soon === "1";
    const page = mint ? 1 : parsed.data.page;
    const g = graduated ? "grad:" : soon ? "soon:" : "";
    // A typed search isn't cached: a run of keystrokes would push the Stream's own pages out.
    const answer =
      q && !mint
        ? await readLaunches(page, undefined, q, graduated, soon)
        : await (graduated ? gradCache : cache)
            .for(`${g}${mint ? `mint:${mint}` : `page:${page}`}`)
            .get(() => readLaunches(page, mint, undefined, graduated, soon));
    return { ...answer, page };
  });
}
