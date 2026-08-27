import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, corsOriginList, type Env, type DexScreenerClient } from "@trenchscanner/core";
import { OnDemandLiveRefresher } from "../liveRefresh.js";
import type { MatchStream } from "../matchStream.js";

/** Fixed, not user-configurable - the dashboard's Live Feed always shows 12 cards per page. */
const PAGE_SIZE = 12;

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
});

export async function registerMatchRoutes(
  app: FastifyInstance,
  opts: { env: Env; dexScreener: DexScreenerClient; matchStream: MatchStream },
) {
  app.addHook("preHandler", app.authenticate);

  // Bounded to one page's worth per request - a single batched DexScreener lookup - and skips
  // anything already as fresh as the worker's live-price cadence promises. See liveRefresh.ts.
  const liveRefresher = new OnDemandLiveRefresher(opts.dexScreener, {
    maxAgeMs: opts.env.LIVE_PRICE_INTERVAL_MINUTES * 60_000,
    limit: PAGE_SIZE,
  });

  /**
   * Server-sent events: a nudge the instant a match is created for this user, rather than waiting
   * out the client's poll. See MatchStream for how the worker's notification gets here.
   *
   * Each event carries only `{ matchId }` - the client refetches page 1 to render it. That keeps
   * one definition of the match payload (the route above) instead of a second one here that could
   * drift, and costs one round trip on an event that is rare by nature.
   *
   * The stream is a latency optimisation, never the only path. Clients must keep a slow fallback
   * poll: NOTIFY is not durable, so a client that is disconnected at the moment of publication
   * simply misses that event, and corporate proxies do sometimes break long-lived responses
   * outright. A missed nudge should cost seconds, not an alert.
   */
  app.get("/stream", (request, reply) => {
    const userId = request.user!.userId;

    // reply.hijack() hands the socket over and skips Fastify's onSend hooks - which is where
    // @fastify/cors would normally attach its headers - so anything the browser needs has to be
    // set here explicitly. EventSource sends the session cookie only under withCredentials, and
    // that requires an exact origin echo; a wildcard is rejected by the browser.
    const origin = request.headers.origin;
    if (origin && corsOriginList(opts.env).includes(origin)) {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Vary", "Origin");
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    // Tells nginx-family proxies (Render's included) not to buffer the response - without it a
    // stream can be held back until some byte threshold is reached, which for SSE means events
    // arrive late or in clumps, i.e. exactly the thing this endpoint exists to avoid.
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.hijack();

    const dispose = opts.matchStream.subscribe(userId, reply.raw);
    if (!dispose) {
      // At capacity. Say so in-band and close, rather than holding a socket that will never be
      // fed - the client's fallback poll takes over.
      reply.raw.writeHead(503);
      reply.raw.end();
      return;
    }

    // `retry` sets the browser's own reconnect delay for this stream; EventSource reconnects on
    // its own, so this is the whole recovery story for a dropped connection.
    reply.raw.write("retry: 5000\n\n");
    reply.raw.write("event: ready\ndata: {}\n\n");

    request.raw.on("close", dispose);
    request.raw.on("error", dispose);
  });

  /** The live feed: this user's matches, newest first, 12 per page. */
  app.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { page } = parsed.data;
    const where = { userId: request.user!.userId };

    const [matches, totalCount] = await Promise.all([
      prisma.match.findMany({
        where,
        orderBy: { matchedAt: "desc" },
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: {
          // Only the latest snapshot per token, not the whole history - lets the dashboard show
          // "now" (marketCapUsd/% change) alongside the frozen alert-time snapshot without a
          // separate request per card. Will be the same row as `snapshot` itself whenever the
          // worker hasn't re-scanned this token since the match - that's an honest "no new
          // data," not a bug, and the dashboard shows the snapshot's own age either way.
          token: { include: { snapshots: { orderBy: { takenAt: "desc" }, take: 1 } } },
          snapshot: true,
          filter: { select: { id: true, name: true } },
        },
      }),
      prisma.match.count({ where }),
    ]);

    // Marks every token on this page as "currently being looked at," regardless of which user
    // fetched it - see the comment on Token.lastViewedAt. This is a side effect of a GET, which
    // is unusual, but it's idempotent and lossy-tolerant (worst case a token's tracking lapses a
    // few minutes early), and piggybacking on the poll the dashboard already makes avoids a
    // second round trip just to say "I'm looking at these."
    const tokenIds = [...new Set(matches.map((m) => m.tokenId))];
    if (tokenIds.length > 0) {
      await prisma.token.updateMany({ where: { id: { in: tokenIds } }, data: { lastViewedAt: new Date() } });
    }

    // Stamping lastViewedAt above is only half of it: the worker acts on that stamp once a minute,
    // so a page being opened - a first visit, or paging back to one seen earlier - would show
    // whatever the last tick left behind until the next one came round. This asks for those
    // specific tokens to be refreshed right now. Deliberately not awaited: the numbers in *this*
    // response are the ones we already have, and the dashboard's next poll picks up the new ones a
    // few seconds later. A slow or broken DexScreener can't delay or fail the page load.
    liveRefresher.request(matches.map((m) => m.token));

    return {
      matches: matches.map((match) => {
        const { snapshots, ...token } = match.token;
        const latestSnapshot = snapshots[0] ?? null;
        const current = currentMarketCap(token, latestSnapshot);
        return {
          ...match,
          token,
          latestSnapshot,
          // The freshest market cap we have and when it was read, resolved server-side so every
          // client doesn't have to re-implement the "which of these two is newer" comparison.
          currentMarketCapUsd: current.marketCapUsd,
          currentMarketCapAt: current.at,
        };
      }),
      page,
      pageSize: PAGE_SIZE,
      totalCount,
    };
  });
}

/**
 * Picks whichever of the two market cap readings is actually newer.
 *
 * Token.liveMarketCapUsd is refreshed roughly every minute for tokens someone currently has open
 * (apps/worker/src/jobs/livePriceJob.ts); a TokenSnapshot is written on the much slower full scan
 * cycle. Usually the live value wins, but not always - a token nobody has viewed recently stops
 * getting live pings while still being re-scanned if it's in the mcap band, and a snapshot written
 * seconds ago is genuinely fresher than a live ping from ten minutes ago. Comparing timestamps
 * rather than assuming an ordering is what keeps "Now" honest in both directions.
 */
export function currentMarketCap(
  token: { liveMarketCapUsd: number | null; liveDataAt: Date | null },
  latestSnapshot: { marketCapUsd: number; takenAt: Date } | null,
): { marketCapUsd: number | null; at: Date | null } {
  const liveAt = token.liveDataAt?.getTime() ?? -Infinity;
  const snapshotAt = latestSnapshot?.takenAt.getTime() ?? -Infinity;

  if (token.liveMarketCapUsd != null && liveAt >= snapshotAt) {
    return { marketCapUsd: token.liveMarketCapUsd, at: token.liveDataAt };
  }
  if (latestSnapshot) {
    return { marketCapUsd: latestSnapshot.marketCapUsd, at: latestSnapshot.takenAt };
  }
  return { marketCapUsd: null, at: null };
}
