import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, corsOriginList, type Env } from "@trenchscanner/core";
import type { OnDemandLiveRefresher } from "../liveRefresh.js";
import {
  attachAiReviewsForAdmin,
  curatedAlertInclude,
  withLatestSnapshots,
  latestSnapshotsByToken,
  TOKEN_CARD_SELECT,
  foldCuratedIntoPage,
  groupSameTokenCalls,
  serializeCuratedAlert,
  resolveOutcome,
  type CallGroup,
  type ModelCall,
} from "../curatedFeed.js";
import { summarizeFeed, type FeedStatsCard } from "../feedStats.js";
import type { MatchStream } from "../matchStream.js";
import type { ViewStampBuffer } from "../viewStamps.js";
import { contestState, resolveFeedModels, savedFeed } from "../contest.js";

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

/** The columns grouping calls needs - the page's own calls are loaded in full afterwards. */
const CALL_SELECT = {
  id: true,
  tokenId: true,
  createdAt: true,
  model: true,
  modelName: true,
  confidence: true,
  tier: true,
  calibratedPct: true,
} satisfies Prisma.CuratedAlertSelect;
type CallRow = Prisma.CuratedAlertGetPayload<{ select: typeof CALL_SELECT }>;

type CuratedCardMeta = ReturnType<typeof serializeCuratedAlert>["curated"] & { calledBy: ModelCall[] };

/**
 * Only the latest snapshot per token, not the whole history - lets the dashboard show "now"
 * (marketCapUsd/% change) alongside the frozen alert-time snapshot without a separate request
 * per card. Will be the same row as `snapshot` itself whenever the worker hasn't re-scanned this
 * token since the match - that's an honest "no new data," not a bug, and the dashboard shows the
 * snapshot's own age either way.
 */
const matchInclude = {
  // The latest snapshot is attached by withLatestSnapshots, not a nested include - see there.
  token: { select: TOKEN_CARD_SELECT },
  snapshot: true,
  filter: { select: { id: true, name: true } },
} satisfies Prisma.MatchInclude;

/** What ordering and slicing the feed needs from a match - the page's own rows load in full. */
const MATCH_ORDER_SELECT = { id: true, matchedAt: true, tokenId: true } satisfies Prisma.MatchSelect;

export const listQuerySchema = z.object({
  // Capped: the merge below reads page * PAGE_SIZE rows of each source, so an unbounded page was
  // an unbounded query (and past 2^53 a Prisma error).
  page: z.coerce.number().int().min(1).max(500).default(1),
  /**
   * Whether to interleave the curated feed into this user's own matches. Opt-in, and defaulted
   * OFF here rather than in the client: the Live Feed's promise is "what YOUR filters caught",
   * and a reader who never asked for the curator's picks shouldn't have to recognise which cards
   * are theirs. Curated alerts always have their own tab regardless.
   *
   * "saved" follows the reader's own model-alerts switch (User.showModelAlerts).
   *
   * Parsed by hand rather than z.coerce.boolean(), which treats the string "false" as true -
   * every value here arrives as a query string, so that coercion would make the flag impossible
   * to turn off.
   */
  includeCurated: z
    .string()
    .optional()
    .transform((v): "on" | "off" | "saved" =>
      v === "true" || v === "1" ? "on" : v === "saved" ? "saved" : "off",
    ),
});

export const feedStatsQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(24),
});

/** Per source: far above any real feed's day, so it only bounds a runaway window. */
const FEED_STATS_MAX_ROWS = 5_000;

/** The match columns resolveOutcome reads, plus the link to the row grading it. */
const MATCH_OUTCOME_SELECT = {
  matchedAt: true,
  candidateOutcomeId: true,
  peak1hReturnPct: true,
  maxDrawdown1hPct: true,
  hit2xIn1h: true,
  hit4xIn1h: true,
  hit10xIn1h: true,
  disqualified: true,
  peak24hReturnPct: true,
} satisfies Prisma.MatchSelect;
type MatchOutcomeRow = Prisma.MatchGetPayload<{ select: typeof MATCH_OUTCOME_SELECT }>;

/**
 * A filter alert is graded by its own outcome row (the watcher copies the verdict onto the match
 * when the window closes). Reads the rows still open for these matches, so a 2x shows the moment
 * it lands and the card doesn't say "Live" for the whole window after the token doubled.
 */
async function openOutcomeRows(matches: readonly MatchOutcomeRow[]) {
  // A clean winner's 10x tier stays open for the rest of its hour after the 2x/4x verdict lands.
  const open = (m: MatchOutcomeRow) =>
    m.hit2xIn1h === null || (m.hit2xIn1h && !m.disqualified && m.hit10xIn1h === null);
  const openIds = matches.flatMap((m) => (open(m) && m.candidateOutcomeId ? [m.candidateOutcomeId] : []));
  const rows =
    openIds.length === 0
      ? []
      : await prisma.candidateOutcome.findMany({
          where: { id: { in: openIds } },
          select: { id: true, ...curatedAlertInclude.candidateOutcome.select },
        });
  return new Map(rows.map(({ id, ...row }) => [id, row]));
}

/** How a filter alert is going / went, from its open grading row while there is one. */
function matchOutcome(m: MatchOutcomeRow, rowById: Awaited<ReturnType<typeof openOutcomeRows>>) {
  return resolveOutcome({
    createdAt: m.matchedAt,
    peak1hReturnPct: m.peak1hReturnPct,
    maxDrawdown1hPct: m.maxDrawdown1hPct,
    hit2xIn15m: null,
    hit2xIn1h: m.hit2xIn1h,
    hit4xIn1h: m.hit4xIn1h,
    hit10xIn1h: m.hit10xIn1h,
    disqualified: m.disqualified,
    peak24hReturnPct: m.peak24hReturnPct,
    runPeakMinutes: null,
    // A match keeps no closing stamp of its own; the row's verdict is what makes it final.
    outcomeFinalizedAt: m.hit2xIn1h === null ? null : m.matchedAt,
    candidateOutcome: (m.candidateOutcomeId && rowById.get(m.candidateOutcomeId)) || null,
  });
}

export async function registerMatchRoutes(
  app: FastifyInstance,
  opts: {
    env: Env;
    liveRefresher: OnDemandLiveRefresher;
    matchStream: MatchStream;
    viewStamps: ViewStampBuffer;
  },
) {
  // The feed itself, and the live stream that pushes to it. Behind the paywall - see authenticateSubscriber in server.ts.
  app.addHook("preHandler", app.authenticateSubscriber);

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

  /**
   * The Live tab's top tiles: how the coins this reader's own feed alerted on over the last
   * `hours` did - the same cards the feed shows (their filter's alerts plus, when their switch is
   * on, the calls of the models they follow, folded the same way), each graded as its card is.
   */
  app.get("/stats", async (request, reply) => {
    const parsed = feedStatsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { hours } = parsed.data;
    const since = new Date(Date.now() - hours * 3_600_000);
    const saved = await savedFeed(request);
    const models = saved.showModelAlerts ? resolveFeedModels(await contestState(opts.env), saved).models : [];

    const [matches, calls] = await Promise.all([
      prisma.match.findMany({
        where: { userId: request.user!.userId, matchedAt: { gte: since } },
        orderBy: { matchedAt: "desc" },
        take: FEED_STATS_MAX_ROWS,
        select: {
          id: true,
          tokenId: true,
          peakReturnPct: true,
          ...MATCH_OUTCOME_SELECT,
          token: { select: { symbol: true } },
        },
      }),
      models.length === 0
        ? Promise.resolve([])
        : prisma.curatedAlert.findMany({
            where: { model: { in: models }, createdAt: { gte: since } },
            orderBy: { createdAt: "desc" },
            take: FEED_STATS_MAX_ROWS,
            select: {
              ...CALL_SELECT,
              peak1hReturnPct: true,
              maxDrawdown1hPct: true,
              hit2xIn15m: true,
              hit2xIn1h: true,
              hit4xIn1h: true,
              hit10xIn1h: true,
              disqualified: true,
              peak24hReturnPct: true,
              runPeakMinutes: true,
              outcomeFinalizedAt: true,
              candidateOutcome: curatedAlertInclude.candidateOutcome,
              token: { select: { symbol: true } },
            },
          }),
    ]);

    const rowById = await openOutcomeRows(matches);

    type StatsCard = FeedStatsCard & {
      id: string;
      matchedAt: Date;
      curated: { alertId: string; card: FeedStatsCard } | null;
    };
    const matchCards: StatsCard[] = matches.map((m) => {
      const outcome = matchOutcome(m, rowById);
      return {
        id: m.id,
        kind: "match",
        tokenId: m.tokenId,
        matchedAt: m.matchedAt,
        symbol: m.token.symbol,
        outcome,
        // The card's ATH figure for a filter alert.
        peakPct: m.peakReturnPct ?? outcome.peak24hReturnPct,
        curated: null,
      };
    });
    // Several followed models calling one token are one card, graded on its first call.
    const callCards: StatsCard[] = groupSameTokenCalls(calls, CURATED_MATCH_LINK_WINDOW_MS).map(
      ({ lead }) => {
        const outcome = resolveOutcome(lead);
        const card: FeedStatsCard = {
          kind: "curated",
          tokenId: lead.tokenId,
          symbol: lead.token.symbol,
          outcome,
          peakPct: outcome.peak24hReturnPct,
        };
        return { ...card, id: lead.id, matchedAt: lead.createdAt, curated: { alertId: lead.id, card } };
      },
    );
    // A model call on a token the reader's filter also caught is one card showing the call.
    const cards = foldCuratedIntoPage([...matchCards, ...callCards], CURATED_MATCH_LINK_WINDOW_MS).map(
      (c): FeedStatsCard =>
        c.kind === "match" && c.curated ? { ...c.curated.card, kind: "match", tokenId: c.tokenId } : c,
    );

    return {
      ...summarizeFeed(cards, hours),
      showModelAlerts: saved.showModelAlerts,
      // The caps bound a pathological window; a real feed is far below them.
      truncated: matches.length === FEED_STATS_MAX_ROWS || calls.length === FEED_STATS_MAX_ROWS,
    };
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
     * because the Live Feed's default promise is the reader's own matches. "saved" follows the
     * reader's own on/off switch (PUT /curated/feed) - what the dashboard sends.
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
    const saved = includeCurated === "saved" ? await savedFeed(request) : null;
    const wantsCurated = includeCurated === "on" || (saved?.showModelAlerts ?? false);
    // Skipped entirely when the reader hasn't opted in - no curated rows are fetched, so nothing
    // is filtered out after the fact and the page count stays exact.
    const interleave = wantsCurated && mergeDepth <= MAX_MERGE_DEPTH;
    // Past the merge depth with curated cards on, this page is matches only - but the pages before
    // it showed fewer than MAX_MERGE_DEPTH matches (curated cards took slots), so a plain
    // (page - 1) * PAGE_SIZE offset skipped every match ranked between the last one shown and
    // position MAX_MERGE_DEPTH. The offset is counted from the merged run instead.
    const pastMergeDepth = wantsCurated && !interleave;

    // The curated calls interleaved are every model the reader checked (else their single pick,
    // else the default) - the same list the Models tab marks as in their feed.
    // Fetched alongside the matches rather than after them: the two halves are independent.
    const feedModels = async () => {
      const [state, feed] = await Promise.all([contestState(opts.env), saved ?? savedFeed(request)]);
      return resolveFeedModels(state, feed).models;
    };
    const loadCurated = async (depth = mergeDepth) => {
      const models = await feedModels();
      // Several models calling one token collapse into one card (at most one call per model), so
      // the newest page * models calls always hold this page's cards whole - see
      // groupSameTokenCalls. Only the columns grouping needs; the page's own rows are loaded in
      // full below.
      const take = depth * models.length;
      const [rows, total] = await Promise.all([
        prisma.curatedAlert.findMany({
          where: { model: { in: models } },
          orderBy: { createdAt: "desc" },
          take,
          select: CALL_SELECT,
        }),
        // Only the legacy flag reports a count; the dashboard pages on hasMore instead.
        includeCurated === "on" ? prisma.curatedAlert.count({ where: { model: { in: models } } }) : 0,
      ]);
      return { models, rows, total, hitLimit: rows.length === take };
    };

    // How many of the first MAX_MERGE_DEPTH merged items were matches: where the matches-only
    // tail starts. The same two bare reads page MAX_MERGE_DEPTH / PAGE_SIZE itself makes.
    const matchesInMergedRun = async (): Promise<number> => {
      const [run, calls] = await Promise.all([
        prisma.match.findMany({
          where,
          orderBy: { matchedAt: "desc" },
          take: MAX_MERGE_DEPTH,
          select: { matchedAt: true },
        }),
        loadCurated(MAX_MERGE_DEPTH),
      ]);
      const times = [
        ...run.map((m) => ({ match: true, at: m.matchedAt.getTime() })),
        ...groupSameTokenCalls(calls.rows, CURATED_MATCH_LINK_WINDOW_MS).map((g) => ({
          match: false,
          at: g.newest.createdAt.getTime(),
        })),
      ].sort((a, b) => b.at - a.at);
      return times.slice(0, MAX_MERGE_DEPTH).filter((t) => t.match).length;
    };
    const skip = pastMergeDepth
      ? (await matchesInMergedRun()) + mergeDepth - MAX_MERGE_DEPTH - PAGE_SIZE
      : (page - 1) * PAGE_SIZE;

    const [[matches, matchTotal], curated] = await Promise.all([
      Promise.all([
        prisma.match.findMany({
          where,
          orderBy: { matchedAt: "desc" },
          // Interleaving needs the whole run up to this page (it slices the union itself);
          // otherwise this IS the page.
          ...(interleave ? { take: mergeDepth } : { skip, take: PAGE_SIZE }),
          // Bare rows, like the curated half: only the page's own matches are loaded in full,
          // below, and a deep page's merge used to pull up to 300 matches with their token and
          // snapshot rows to show twelve.
          select: MATCH_ORDER_SELECT,
        }),
        prisma.match.count({ where }),
      ]),
      interleave ? loadCurated() : Promise.resolve(null),
    ]);

    // Ordered and sliced on the bare rows; only the page's own rows then get loaded in full and
    // get their latest snapshot, rather than every row the merge had to read.
    type Item =
      | { kind: "match"; at: Date; row: (typeof matches)[number] }
      | { kind: "curated"; at: Date; group: CallGroup<CallRow> };
    const items: Item[] = [
      ...matches.map((row) => ({ kind: "match" as const, at: row.matchedAt, row })),
      ...groupSameTokenCalls(curated?.rows ?? [], CURATED_MATCH_LINK_WINDOW_MS).map((group) => ({
        kind: "curated" as const,
        at: group.newest.createdAt,
        group,
      })),
    ].sort((a, b) => b.at.getTime() - a.at.getTime());
    const end = page * PAGE_SIZE;
    const pageItems = interleave ? items.slice(end - PAGE_SIZE, end) : items;
    const hasMore = interleave
      ? items.length > end || matchTotal > matches.length || (curated?.hitLimit ?? false)
      : matchTotal > skip + matches.length;

    // A card on this page can have older calls than the read reached; fill them in, so the card
    // shows the token's first call and every model that called it.
    let pageGroups = pageItems.flatMap((i) => (i.kind === "curated" ? [i.group] : []));
    if (curated?.hitLimit && pageGroups.length > 0) {
      const horizon = curated.rows[curated.rows.length - 1]!.createdAt;
      const reach = (g: CallGroup<CallRow>) => g.newest.createdAt.getTime() - CURATED_MATCH_LINK_WINDOW_MS;
      const open = pageGroups.filter((g) => reach(g) < horizon.getTime());
      if (open.length > 0) {
        const tokenIds = [...new Set(open.map((g) => g.newest.tokenId))];
        const older = await prisma.curatedAlert.findMany({
          where: {
            tokenId: { in: tokenIds },
            model: { in: curated.models },
            createdAt: { gte: new Date(Math.min(...open.map(reach))), lt: horizon },
          },
          orderBy: { createdAt: "desc" },
          select: CALL_SELECT,
        });
        const regrouped = new Map(
          groupSameTokenCalls(
            [...curated.rows.filter((r) => tokenIds.includes(r.tokenId)), ...older],
            CURATED_MATCH_LINK_WINDOW_MS,
          ).map((g) => [g.newest.id, g]),
        );
        pageGroups = pageGroups.map((g) => regrouped.get(g.newest.id) ?? g);
      }
    }
    const groupByNewest = new Map(pageGroups.map((g) => [g.newest.id, g]));

    // The page's full rows and every card's latest snapshot, all at once: the bare rows already
    // name each card's token, so the snapshot lookup (one statement for both halves) doesn't have
    // to wait for the rows it decorates.
    const pageMatchIds = pageItems.flatMap((i) => (i.kind === "match" ? [i.row.id] : []));
    const latest = latestSnapshotsByToken([
      ...pageItems.flatMap((i) => (i.kind === "match" ? [i.row.tokenId] : [])),
      ...pageGroups.map((g) => g.lead.tokenId),
    ]);
    // Awaited below; this only stops a failure from going unhandled if both row loads fail first.
    latest.catch(() => {});
    const [pageMatches, pageCurated] = await Promise.all([
      pageMatchIds.length === 0
        ? Promise.resolve([])
        : prisma.match
            .findMany({ where: { id: { in: pageMatchIds } }, include: matchInclude })
            .then(async (rows) => {
              const [decorated, outcomeRows] = await Promise.all([
                withLatestSnapshots(rows, latest),
                openOutcomeRows(rows),
              ]);
              return decorated.map((m) => ({ ...m, outcome: matchOutcome(m, outcomeRows) }));
            }),
      pageGroups.length === 0
        ? Promise.resolve([])
        : prisma.curatedAlert
            .findMany({
              where: { id: { in: pageGroups.map((g) => g.lead.id) } },
              include: curatedAlertInclude,
            })
            .then((rows) => withLatestSnapshots(rows, latest)),
    ]);
    const matchById = new Map(pageMatches.map((m) => [m.id, m]));
    const curatedById = new Map(pageCurated.map((c) => [c.id, c]));

    const toMatchCard = (match: (typeof pageMatches)[number]) => {
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
        // How the alert is going, from its open grading row (see openOutcomeRows). The stored
        // columns stay on the card for older bundles, which derive the badge from them.
        outcome: match.outcome,
        curated: null as CuratedCardMeta | null,
      };
    };
    const toCuratedCard = (alert: (typeof pageCurated)[number], group: CallGroup<CallRow>) => {
      const card = serializeCuratedAlert(alert, currentMarketCap);
      return { ...card, curated: { ...card.curated, calledBy: group.calls } as CuratedCardMeta | null };
    };

    // In feed order: a card sits at its newest call, so this is not matchedAt order.
    const ordered: (ReturnType<typeof toMatchCard> | ReturnType<typeof toCuratedCard>)[] = [];
    for (const item of pageItems) {
      if (item.kind === "match") {
        const match = matchById.get(item.row.id);
        if (match) ordered.push(toMatchCard(match));
        continue;
      }
      const group = groupByNewest.get(item.group.newest.id) ?? item.group;
      const alert = curatedById.get(group.lead.id);
      // Gone between the two reads (its token was pruned): nothing to show.
      if (alert) ordered.push(toCuratedCard(alert, group));
    }
    // Folded after slicing, so a card's curated badge depends only on the page it is on - see
    // foldCuratedIntoPage.
    const cards = foldCuratedIntoPage(ordered, CURATED_MATCH_LINK_WINDOW_MS);

    // Only meaningful for the legacy flag (an upper bound there: folded cards leave it a little
    // high). The dashboard pages on hasMore, which can't promise a page that turns out empty.
    const totalCount = matchTotal + (curated?.total ?? 0);

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
    // response are the ones we already have, and the dashboard's live tick (routes/live.ts) picks up
    // the new ones within seconds. A slow or broken DexScreener can't delay or fail the page load.
    opts.liveRefresher.request(cards.map((c) => c.token));

    return {
      // Still `matches`, and every entry still Match-shaped, so a bundle deployed before this
      // change renders curated cards as ordinary ones instead of breaking on an unknown key.
      matches: await attachAiReviewsForAdmin(cards, request.access?.reason === "admin"),
      page,
      pageSize: PAGE_SIZE,
      totalCount,
      hasMore,
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
