import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, corsOriginList, type Env, type DexScreenerClient } from "@trenchscanner/core";
import { OnDemandLiveRefresher } from "../liveRefresh.js";
import { curatedAlertInclude, foldCuratedIntoPage, serializeCuratedAlert } from "../curatedFeed.js";
import type { MatchStream } from "../matchStream.js";
import type { ViewStampBuffer } from "../viewStamps.js";

/** Fixed, not user-configurable - the dashboard's Live Feed always shows 12 cards per page. */
const PAGE_SIZE = 12;

/**
 * A curated alert and one of this user's matches for the same token, this close together, are
 * the same event seen twice - the scanner alerted them and the curator picked it. The feed shows
 * one card carrying both facts rather than two cards for one token.
 */
const CURATED_MATCH_LINK_WINDOW_MS = 6 * 3_600_000;

/**
 * How deep the interleaved feed stays interleaved. Merging two time-ordered sources exactly
 * means fetching `page * PAGE_SIZE` of each and slicing the union, so the cost grows with page
 * depth - this bounds it. Past this depth the feed falls back to the user's own matches alone,
 * which is the right thing anyway: that far back is history browsing, and the whole curated
 * history has its own tab.
 */
const MAX_MERGE_DEPTH = 300;

/**
 * Only the latest snapshot per token, not the whole history - lets the dashboard show "now"
 * (marketCapUsd/% change) alongside the frozen alert-time snapshot without a separate request
 * per card. Will be the same row as `snapshot` itself whenever the worker hasn't re-scanned this
 * token since the match - that's an honest "no new data," not a bug, and the dashboard shows the
 * snapshot's own age either way.
 */
const matchInclude = {
  token: { include: { snapshots: { orderBy: { takenAt: "desc" }, take: 1 } } },
  snapshot: true,
  filter: { select: { id: true, name: true } },
} satisfies Prisma.MatchInclude;

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  /**
   * Whether to interleave the curated feed into this user's own matches. Opt-in, and defaulted
   * OFF here rather than in the client: the Live Feed's promise is "what YOUR filters caught",
   * and a reader who never asked for the curator's picks shouldn't have to recognise which cards
   * are theirs. Curated alerts always have their own tab regardless.
   *
   * Parsed by hand rather than z.coerce.boolean(), which treats the string "false" as true -
   * every value here arrives as a query string, so that coercion would make the flag impossible
   * to turn off.
   */
  includeCurated: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export async function registerMatchRoutes(
  app: FastifyInstance,
  opts: { env: Env; dexScreener: DexScreenerClient; matchStream: MatchStream; viewStamps: ViewStampBuffer },
) {
  // The feed itself, and the live stream that pushes to it. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

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

    // Capacity is checked before anything is hijacked or any header is set, so a rejection is an
    // ordinary JSON 503 the client can actually read. Doing it after hijack meant replying 503
    // with Content-Type: text/event-stream already on the response.
    const dispose = opts.matchStream.subscribe(userId, reply.raw);
    if (!dispose) {
      return reply.code(503).send({ error: "stream capacity reached - fall back to polling" });
    }

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
    const { page, includeCurated } = parsed.data;
    const where = { userId: request.user!.userId };

    /*
     * The curated feed can be interleaved into this one, for readers who ask for it
     * (includeCurated): a curated alert is an alert, and the point of curation is that a
     * subscriber can see it without having to build a filter for it. Off unless requested,
     * because the Live Feed's default promise is the reader's own matches.
     *
     * Merging two independently-paginated time-ordered sources exactly: take the newest
     * `page * PAGE_SIZE` of each, merge, sort, and slice out this page. The union's first N
     * items are always inside those 2N, so the slice is exact - no duplicates across pages, and
     * no curated alert stranded for being older than the newest twelve matches, which is what a
     * time-window merge does to anyone whose filters are busy.
     *
     * Past MAX_MERGE_DEPTH the feed is the user's own matches alone, paginated the way it always
     * was: that far back is history browsing, and the curated history has its own tab.
     */
    const mergeDepth = page * PAGE_SIZE;
    // Skipped entirely when the reader hasn't opted in - no curated rows are fetched, so nothing
    // is filtered out after the fact and the page count stays exact.
    const interleave = includeCurated && mergeDepth <= MAX_MERGE_DEPTH;

    const [matches, matchTotal] = await Promise.all([
      prisma.match.findMany({
        where,
        orderBy: { matchedAt: "desc" },
        // Interleaving needs the whole run up to this page (it slices the union itself);
        // otherwise this IS the page.
        ...(interleave ? { take: mergeDepth } : { skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
        include: matchInclude,
      }),
      prisma.match.count({ where }),
    ]);

    const [curatedAlerts, curatedTotal] = interleave
      ? await Promise.all([
          prisma.curatedAlert.findMany({
            orderBy: { createdAt: "desc" },
            take: mergeDepth,
            include: curatedAlertInclude,
          }),
          prisma.curatedAlert.count(),
        ])
      : [[], 0];

    const matchCards = matches.map((match) => {
      const { snapshots, ...token } = match.token;
      const latestSnapshot = snapshots[0] ?? null;
      const current = currentMarketCap(token, latestSnapshot);
      return {
        ...match,
        kind: "match" as const,
        token,
        latestSnapshot,
        // The freshest market cap we have and when it was read, resolved server-side so every
        // client doesn't have to re-implement the "which of these two is newer" comparison.
        currentMarketCapUsd: current.marketCapUsd,
        currentMarketCapAt: current.at,
        curated: null as ReturnType<typeof serializeCuratedAlert>["curated"] | null,
      };
    });
    const curatedCards = curatedAlerts.map((alert) => serializeCuratedAlert(alert, currentMarketCap));

    const merged = [...matchCards, ...curatedCards].sort(
      (a, b) => b.matchedAt.getTime() - a.matchedAt.getTime(),
    );
    // Folded after slicing, so a card's curated badge depends only on the page it is on - see
    // foldCuratedIntoPage.
    const cards = foldCuratedIntoPage(
      interleave ? merged.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : merged,
      CURATED_MATCH_LINK_WINDOW_MS,
    );

    // An upper bound: a page that folds two cards into one leaves this a little high, which at
    // worst costs a short final page and never a missing card.
    const totalCount = matchTotal + curatedTotal;

    // Marks every token on this page as "currently being looked at," regardless of which user
    // fetched it - see the comment on Token.lastViewedAt. This is a side effect of a GET, which
    // is unusual, but it's idempotent and lossy-tolerant (worst case a token's tracking lapses a
    // few minutes early), and piggybacking on the poll the dashboard already makes avoids a
    // second round trip just to say "I'm looking at these."
    //
    // Buffered rather than written here: the write used to cost this request a transaction, and
    // concurrent readers of the same page all queued on the same rows. See ViewStampBuffer.
    opts.viewStamps.record(cards.map((c) => c.tokenId));

    // Stamping lastViewedAt above is only half of it: the worker acts on that stamp once a minute,
    // so a page being opened - a first visit, or paging back to one seen earlier - would show
    // whatever the last tick left behind until the next one came round. This asks for those
    // specific tokens to be refreshed right now. Deliberately not awaited: the numbers in *this*
    // response are the ones we already have, and the dashboard's next poll picks up the new ones a
    // few seconds later. A slow or broken DexScreener can't delay or fail the page load.
    liveRefresher.request(cards.map((c) => c.token));

    return {
      // Still `matches`, and every entry still Match-shaped, so a bundle deployed before this
      // change renders curated cards as ordinary ones instead of breaking on an unknown key.
      matches: cards,
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
