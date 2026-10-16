import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import {
  prisma,
  corsOriginList,
  feedCallsKey,
  feedCallsWhere,
  resolveFeedCalls,
  CALL_PEAK_READING_LAG_MS,
  type Env,
  type FeedCalls,
} from "@trenchscanner/core";
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
  CURATED_MATCH_LINK_WINDOW_MS,
  callPeakPct,
  callPeakAt,
  foldedCallPeakPct,
  type CallGroup,
  type CuratedAlertWithRelations,
  type ModelCall,
} from "../curatedFeed.js";
import {
  RETURN_WINDOW_MAX_HOURS,
  summarizeFeed,
  summarizeReturns,
  topReturns,
  callPassed,
  type FeedReturnWindow,
  type FeedStatsCard,
  type ReturnCard,
} from "../feedStats.js";
import type { MatchStream } from "../matchStream.js";
import type { ViewStampBuffer } from "../viewStamps.js";
import {
  contestState,
  feedBothOnlyApplies,
  resolveFeedModels,
  savedFeed,
  type SavedFeed,
} from "../contest.js";
import { SharedCacheMap } from "../sharedCache.js";

/** Fixed, not user-configurable - the dashboard's Live Feed always shows 12 cards per page. */
const PAGE_SIZE = 12;

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

/** What GET /matches/stats answers with - cached per reader, see FEED_STATS_CACHE_TTL_MS. */
type FeedStatsResponse = ReturnType<typeof summarizeFeed> & {
  showModelAlerts: boolean;
  /** Only alerts both caught (Settings): every card is a filter alert a followed model also called. */
  bothOnly: boolean;
  truncated: boolean;
};

/** A grading row's columns the run peak reads, and the exit-plan return. */
const RUN_PEAK_SELECT = {
  simReturnPct: true,
  peak24hReturnPct: true,
  peak24hPriceUsd: true,
  anchorPriceUsd: true,
} satisfies Prisma.CandidateOutcomeSelect;

/** A grading row's run peak, as a return on its anchor price: written at the close, live before it. */
function runPeakPct(
  row: { peak24hReturnPct: number | null; peak24hPriceUsd: number; anchorPriceUsd: number } | null,
): number | null {
  if (!row) return null;
  if (row.peak24hReturnPct !== null) return row.peak24hReturnPct;
  const pct = ((row.peak24hPriceUsd - row.anchorPriceUsd) / row.anchorPriceUsd) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/** The larger of two percentages either of which may be missing. */
function maxPct(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * Each call's live market cap, as a return on its alert market cap, for the calls made before
 * that reading. The snapshot highs are already folded into the call's peakMcapUsd by the worker
 * (jobs/curatedPeaks.ts, every match-peaks pass), which callPeakPct reads - only the live ping
 * is read here, so a token someone has open shows its newest high before the next pass banks it.
 */
async function liveMarketCapPeaks(
  calls: readonly { id: string; tokenId: string; createdAt: Date; anchorMcapUsd: number }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (calls.length === 0) return out;
  const live = await prisma.token.findMany({
    where: {
      id: { in: [...new Set(calls.map((c) => c.tokenId))] },
      liveMarketCapUsd: { not: null },
      liveDataAt: { not: null },
    },
    select: { id: true, liveMarketCapUsd: true, liveDataAt: true },
  });
  const byToken = new Map(live.map((t) => [t.id, { mcap: t.liveMarketCapUsd!, at: t.liveDataAt! }]));
  for (const c of calls) {
    const r = byToken.get(c.tokenId);
    // A reading from the first minute after the call still shows the market before it.
    if (!r || !(c.anchorMcapUsd > 0) || r.at.getTime() < c.createdAt.getTime() + CALL_PEAK_READING_LAG_MS)
      continue;
    const pct = (r.mcap / c.anchorMcapUsd - 1) * 100;
    if (Number.isFinite(pct) && pct > 0) out.set(c.id, pct);
  }
  return out;
}

/** What GET /matches/returns answers with - cached per reader, see FEED_RETURNS_CACHE_TTL_MS. */
interface FeedReturnsResponse {
  windows: FeedReturnWindow[];
  /** The week's three biggest runs (the cards' Peak), one per token, best first - for the share cards. */
  top: {
    tokenId: string;
    symbol: string | null;
    name: string | null;
    mintAddress: string;
    at: string;
    /** The card's Peak: the highest the token went above its alert price, in percent. */
    peakPct: number;
    /** What alerted it: one of the reader's filters, or a model they follow. Null if the filter is gone. */
    source: { kind: "filter" | "model"; name: string } | null;
  }[];
  /** The same, from the followed models' calls alone and from the reader's own filters' alerts alone. */
  topBySource: { model: FeedReturnsResponse["top"]; filter: FeedReturnsResponse["top"] };
  showModelAlerts: boolean;
  bothOnly: boolean;
  truncated: boolean;
}

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
  // color and icon: the owner's style for this filter's cards (null keeps Customize's).
  filter: { select: { id: true, name: true, color: true, icon: true } },
} satisfies Prisma.MatchInclude;

/** What ordering and slicing the feed needs from a match - the page's own rows load in full. */
const MATCH_ORDER_SELECT = { id: true, matchedAt: true, tokenId: true } satisfies Prisma.MatchSelect;

/**
 * `?highConviction=1`: the model calls a feed answer carries are the high-conviction tier alone
 * (every model's calls that cleared its high-conviction line, core feedModels.highConvictionCalls)
 * instead of the models the reader follows. It narrows the model-call half only: with model calls
 * off it changes nothing. Parsed by hand for the reason given on includeCurated below.
 */
const highConvictionParam = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1");

/**
 * `?q=`: the text the dashboard's search box holds when it isn't a whole address - a ticker
 * (a leading "$" is dropped), a name, or part of an address. Two characters at least: one
 * matches nearly everything.
 */
export const tokenSearchParam = z
  .string()
  .transform((v) => v.trim().replace(/^\$/, "").trim())
  .pipe(z.string().min(2, "search for at least 2 characters").max(64))
  .optional();

/** The tokens whose ticker, name or address holds `text`, in any case. */
export function tokenTextWhere(text: string): Prisma.TokenWhereInput {
  return {
    OR: [
      { symbol: { contains: text, mode: "insensitive" } },
      { name: { contains: text, mode: "insensitive" } },
      { mintAddress: { contains: text, mode: "insensitive" } },
    ],
  };
}

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
  highConviction: highConvictionParam,
  /**
   * A token's contract address: the feed narrowed to that one token's alerts (the dashboard's CA
   * search), paged and merged exactly as the whole feed is. An address no token has answers an
   * empty page.
   */
  mint: z
    .string()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "mint must be a Solana address")
    .optional(),
  /** A name, ticker or part of an address: the feed narrowed to the tokens that hold it. */
  q: tokenSearchParam,
});

/**
 * Windows /matches/stats answers. A fixed set, not any hour from 1 to 168: each value is its own
 * per-reader and shared cache key, so cycling it re-ran the full 5k-row reads on every request
 * and pushed other readers' entries out of the bounded caches. The dashboard asks for 24.
 */
export const FEED_STATS_HOURS = [1, 6, 24, 168] as const;

export const feedStatsQuerySchema = z.object({
  hours: z.coerce
    .number()
    .int()
    .refine((h) => (FEED_STATS_HOURS as readonly number[]).includes(h), {
      message: `hours must be one of ${FEED_STATS_HOURS.join(", ")}`,
    })
    .default(24),
  highConviction: highConvictionParam,
});

export const feedReturnsQuerySchema = z.object({ highConviction: highConvictionParam });

/** Per source: far above any real feed's day, so it only bounds a runaway window. */
const FEED_STATS_MAX_ROWS = 5_000;

/**
 * How long one reader's /stats answer stands. Every open Live tab asks every 30 seconds and
 * again on each SSE nudge, and each answer read up to 5,000 matches and 5,000 calls; the tiles
 * it feeds move when an outcome lands, not per second. Cleared outright when a match or curated
 * alert is announced, so the nudge still shows the new card's effect at once.
 */
const FEED_STATS_CACHE_TTL_MS = 10_000;
/**
 * How long a reader's merged-run count (where the matches-only tail starts, past
 * MAX_MERGE_DEPTH) stands. Walking it read 300 matches plus 300 calls per model for every deep
 * page; the count only changes when a match or call lands, and both clear it.
 */
const MERGED_RUN_CACHE_TTL_MS = 60_000;
/**
 * How long one reader's /returns answer stands. A week of the feed is read for it, but only while
 * the Stats panel is open, and an exit-plan return lands minutes to hours after its alert, so a
 * minute old is current enough. Cleared with the stats when a new card lands.
 */
const FEED_RETURNS_CACHE_TTL_MS = 60_000;
/**
 * Readers' caches held per process, each key a few kilobytes at most. One reader can hold several
 * keys (a stats window each, plus returns and the merged-run count), so 500 evicted active readers
 * once a few hundred were online; 2000 keeps them all for a few megabytes.
 */
const MAX_CACHED_READER_KEYS = 2000;
/**
 * How long one read of the followed models' calls is shared across readers.
 *
 * The feed, the stats tiles and the returns each read the calls of the reader's models, and those
 * rows are identical for everyone following the same models - yet each reader read them alone,
 * up to 5,000 rows at a time for the stats. A new call clears every one of them at once and every
 * open tab asks again in the same moment, so that per-reader read was most of what a busy
 * instance spent its database on: at 1,000 simulated readers the refresh after a call took ~10s.
 * Shared per model set, a few reads serve them all. Cleared the moment a call lands; between
 * calls, what moves is a call's outcome, which the stats and returns caches already let stand
 * this long.
 */
const SHARED_CALL_READ_TTL_MS = 10_000;
/** Keys are a window and a model set: a handful in practice, far below this. */
const MAX_SHARED_CALL_READ_KEYS = 200;

/** The match columns resolveOutcome reads, plus the link to the row grading it. */
export const MATCH_OUTCOME_SELECT = {
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
 * A filter alert's snapshot as its card shows it: with the price the alert was priced at when the
 * scan had a fresh quote (Match.alertMcapUsd, the anchor its verdict and Peak count from) in place
 * of the snapshot's DexScreener figures, 45-60 s behind. As serializeCuratedAlert does for a call:
 * a coin caught on its way up showed an Alert far below what a buyer paid, and a Peak of 2.5x
 * beside a verdict that it missed 2x.
 */
export function matchAlertSnapshot<S extends { priceUsd: number; marketCapUsd: number }>(
  snapshot: S,
  alertMcapUsd: number | null,
): S {
  if (alertMcapUsd === null || !(alertMcapUsd > 0) || !(snapshot.marketCapUsd > 0)) return snapshot;
  return {
    ...snapshot,
    marketCapUsd: alertMcapUsd,
    priceUsd: (snapshot.priceUsd / snapshot.marketCapUsd) * alertMcapUsd,
  };
}

/**
 * A filter alert is graded by its own outcome row (the watcher copies the verdict onto the match
 * when the window closes). Reads the rows still open for these matches, so a 2x shows the moment
 * it lands and the card doesn't say "Live" for the whole window after the token doubled.
 */
export async function openOutcomeRows(matches: readonly MatchOutcomeRow[]) {
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
export function matchOutcome(
  m: MatchOutcomeRow,
  rowById: ReadonlyMap<string, NonNullable<CuratedAlertWithRelations["candidateOutcome"]>>,
) {
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

/** A filter alert's columns the Stats tiles grade it on. */
export const STATS_MATCH_SELECT = {
  id: true,
  tokenId: true,
  peakReturnPct: true,
  // The card's alert market cap (matchAlertSnapshot), which a folded call's Peak re-bases onto.
  alertMcapUsd: true,
  snapshot: { select: { priceUsd: true, marketCapUsd: true } },
  ...MATCH_OUTCOME_SELECT,
  token: { select: { symbol: true } },
} satisfies Prisma.MatchSelect;
type StatsMatchRow = Prisma.MatchGetPayload<{ select: typeof STATS_MATCH_SELECT }>;

/** A model call's columns the Stats tiles grade it on. */
export const STATS_CALL_SELECT = {
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
  anchorMcapUsd: true,
  peakMcapUsd: true,
  peakMcapAt: true,
  candidateOutcome: curatedAlertInclude.candidateOutcome,
  token: { select: { symbol: true } },
} satisfies Prisma.CuratedAlertSelect;
type StatsCallRow = Prisma.CuratedAlertGetPayload<{ select: typeof STATS_CALL_SELECT }>;

/**
 * The cards a feed's Stats tiles grade, from its filter alerts and model calls (newest first),
 * folded and graded exactly as the feed's cards are. With `bothOnly`, only the filter alerts a
 * call stands beside (calledNear), folded or not, and no call on its own. Shared with the Admin
 * feed simulator, so a simulated feed is graded the way a reader's is.
 */
export function feedStatsCards(
  matches: readonly StatsMatchRow[],
  calls: StatsCallRow[],
  rowById: Awaited<ReturnType<typeof openOutcomeRows>>,
  bothOnly: boolean,
): FeedStatsCard[] {
  type StatsCard = FeedStatsCard & {
    id: string;
    matchedAt: Date;
    /** A filter alert's market cap as its card shows it; 0 on a call's. */
    alertMcapUsd: number;
    curated: {
      alertId: string;
      card: FeedStatsCard;
      /** The call's Peak as a market cap, and when it came (curatedMeta's peakMcapUsd, peakAt). */
      peakMcapUsd: number | null;
      peakAt: Date | null;
    } | null;
  };
  const near = bothOnly ? calledNear(calls) : null;
  const kept = near ? matches.filter((m) => near(m.tokenId, m.matchedAt)) : matches;
  const matchCards: StatsCard[] = kept.map((m) => {
    const outcome = matchOutcome(m, rowById);
    return {
      id: m.id,
      kind: "match",
      tokenId: m.tokenId,
      matchedAt: m.matchedAt,
      alertMcapUsd: matchAlertSnapshot(m.snapshot, m.alertMcapUsd).marketCapUsd,
      symbol: m.token.symbol,
      outcome,
      // The card's ATH figure for a filter alert.
      peakPct: m.peakReturnPct ?? outcome.peak24hReturnPct,
      curated: null,
    };
  });
  // Several followed models calling one token are one card, graded on its first call.
  const callCards: StatsCard[] = groupSameTokenCalls(calls, CURATED_MATCH_LINK_WINDOW_MS).map(({ lead }) => {
    const outcome = resolveOutcome(lead);
    const peakPct = callPeakPct(outcome.peak24hReturnPct, lead);
    const card: FeedStatsCard = {
      kind: "curated",
      tokenId: lead.tokenId,
      symbol: lead.token.symbol,
      outcome,
      peakPct,
    };
    return {
      ...card,
      id: lead.id,
      matchedAt: lead.createdAt,
      alertMcapUsd: 0,
      curated: {
        alertId: lead.id,
        card,
        peakMcapUsd: peakPct !== null && peakPct > 0 ? lead.anchorMcapUsd * (1 + peakPct / 100) : null,
        peakAt: callPeakAt(outcome.peak24hReturnPct, outcome.runPeakMinutes, lead),
      },
    };
  });
  // A model call on a token the reader's filter also caught is one card. It keeps the filter
  // alert's price, so it keeps that alert's verdict too, as the feed card grades it: a call at
  // $11K that doubled must not count a filter alert at $22.4K that peaked at 1.2x as a win.
  const folded = foldCuratedIntoPage([...matchCards, ...callCards], CURATED_MATCH_LINK_WINDOW_MS);
  return (bothOnly ? folded.filter((c) => c.kind === "match") : folded).map((c): FeedStatsCard =>
    c.kind === "match" && c.curated
      ? {
          ...c.curated.card,
          kind: "match",
          tokenId: c.tokenId,
          outcome: c.outcome,
          // The better of the two alerts' runs, as the card shows it (recordedPeakOf): the call's
          // re-based onto the filter alert's price, and only when it came at or after that alert.
          peakPct: maxPct(c.peakPct, foldedCallPeakPct(c.curated, c.matchedAt, c.alertMcapUsd)),
        }
      : c,
  );
}

/**
 * One clearer per registered match-routes instance (one per process in production; tests build
 * several servers). See clearReaderCaches.
 */
const readerCacheClearers = new Set<(userId: string) => void>();

/**
 * Forgets one reader's cached feed answers (stats, returns, merged-run count) on this process.
 *
 * For changes to a user's matches that announce nothing: a new match NOTIFYs and clears these
 * through onMatch, but a filter hard-delete cascades its Match rows away silently, and without this
 * the reader's stats and deep pages would count the vanished alerts until the TTL ran out.
 */
export function clearReaderCaches(userId: string): void {
  for (const clear of readerCacheClearers) clear(userId);
}

/**
 * Whether a cache key's model set - the comma-joined last segment every key below ends with -
 * includes `model`. A key with no models (model alerts off) never does: no call is in that answer.
 */
export function keyFollowsModel(key: string, model: string): boolean {
  return key
    .slice(key.lastIndexOf(":") + 1)
    .split(",")
    .includes(model);
}

/** Which feed a reader's saved settings make: their filters alone, with model calls, or both-only. */
function feedMode(saved: Pick<SavedFeed, "showModelAlerts" | "bothOnly">): "off" | "on" | "both" {
  return feedBothOnlyApplies(saved) ? "both" : saved.showModelAlerts ? "on" : "off";
}

/**
 * For the "only alerts both caught" feed: whether a filter alert on `tokenId` at `at` has one of
 * `calls` on the same token within the fold window either side - the alerts the feed folds into
 * one card wearing both (foldCuratedIntoPage), and the same test the feed's SQL makes.
 */
export function calledNear(
  calls: readonly { tokenId: string; createdAt: Date }[],
  windowMs: number = CURATED_MATCH_LINK_WINDOW_MS,
): (tokenId: string, at: Date) => boolean {
  const byToken = new Map<string, number[]>();
  for (const c of calls) {
    const list = byToken.get(c.tokenId);
    if (list) list.push(c.createdAt.getTime());
    else byToken.set(c.tokenId, [c.createdAt.getTime()]);
  }
  return (tokenId, at) => (byToken.get(tokenId) ?? []).some((t) => Math.abs(t - at.getTime()) <= windowMs);
}

/** A filter that is the owner's and switched on: the "active filters" the both-only feed counts. */
const ACTIVE_FILTER = { isActive: true, deletedAt: null } satisfies Prisma.UserFilterWhereInput;

/** Text searches one account may run per minute (GET /matches?q=). */
const TEXT_SEARCHES_PER_MINUTE = 30;
const textSearches = new Map<string, number[]>();

/** Whether this account may run another text search now; records it when so. */
export function allowTextSearch(userKey: string, now = Date.now()): boolean {
  const recent = (textSearches.get(userKey) ?? []).filter((t) => now - t < 60_000);
  textSearches.delete(userKey);
  if (recent.length >= TEXT_SEARCHES_PER_MINUTE) {
    textSearches.set(userKey, recent);
    return false;
  }
  recent.push(now);
  textSearches.set(userKey, recent);
  while (textSearches.size > 10_000) {
    const oldest = textSearches.keys().next().value;
    if (oldest === undefined) break;
    textSearches.delete(oldest);
  }
  return true;
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

  // Keyed by user first, so one user's new match clears only their own entries; and by model set
  // last, so a curated alert clears every reader following that model and nobody else.
  const statsCache = new SharedCacheMap<FeedStatsResponse>(FEED_STATS_CACHE_TTL_MS, MAX_CACHED_READER_KEYS);
  const mergedRunCache = new SharedCacheMap<number>(MERGED_RUN_CACHE_TTL_MS, MAX_CACHED_READER_KEYS);
  const returnsCache = new SharedCacheMap<FeedReturnsResponse>(
    FEED_RETURNS_CACHE_TTL_MS,
    MAX_CACHED_READER_KEYS,
  );
  // The model-call half of those answers is the same for everyone following the same models, so
  // it is read once per model set and shared, not once per reader. See SHARED_CALL_READ_TTL_MS.
  const sharedCallReads = new SharedCacheMap<unknown>(SHARED_CALL_READ_TTL_MS, MAX_SHARED_CALL_READ_KEYS);
  const sharedCallRead = <T>(key: string, read: () => Promise<T>): Promise<T> =>
    sharedCallReads.for(key).get(read) as Promise<T>;
  const stopCuratedListener = opts.matchStream.onCuratedAlert((model) => {
    // No model (a LISTEN reconnect, or an older worker's payload): any ledger may have changed.
    // Model ids are roster slugs; one that could collide with the key separators clears it all.
    const affected =
      model === undefined || /[:,]/.test(model) ? () => true : (key: string) => keyFollowsModel(key, model);
    sharedCallReads.clearWhere(affected);
    statsCache.clearWhere(affected);
    returnsCache.clearWhere(affected);
    mergedRunCache.clearWhere(affected);
  });
  const clearReader = (userId: string) => {
    statsCache.clear(`${userId}:`);
    returnsCache.clear(`${userId}:`);
    mergedRunCache.clear(`${userId}:`);
  };
  const stopMatchListener = opts.matchStream.onMatch(clearReader);
  readerCacheClearers.add(clearReader);
  app.addHook("onClose", async () => {
    stopCuratedListener();
    stopMatchListener();
    readerCacheClearers.delete(clearReader);
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
    // A client that gave up while the auth check was running has already fired "close", so the
    // listener above never runs; without this its slot (of the 8 per user) waited for a heartbeat.
    if (request.raw.destroyed || reply.raw.destroyed) dispose();
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
    const { hours, highConviction } = parsed.data;
    const saved = await savedFeed(request);
    const calls = await readerCalls(saved, highConviction);
    const userId = request.user!.userId;
    // Everything the answer depends on, so a settings change never reads a stale answer.
    const mode = feedMode(saved);
    const key = `${userId}:${hours}:${mode}:${feedCallsKey(calls)}`;
    return statsCache.for(key).get(() => buildFeedStats(userId, hours, calls, mode));
  });

  /**
   * The model calls a reader's feed answers carry: none with their model-alerts switch off, else
   * their followed models' calls, or the high-conviction tier when they asked for it alone.
   */
  async function readerCalls(
    saved: Awaited<ReturnType<typeof savedFeed>>,
    highConviction: boolean,
  ): Promise<FeedCalls> {
    if (!saved.showModelAlerts) return { models: [], tier: null };
    const state = await contestState(opts.env);
    return resolveFeedCalls(state, resolveFeedModels(state, saved).models, highConviction);
  }

  async function buildFeedStats(
    userId: string,
    hours: number,
    feedCalls: FeedCalls,
    mode: "off" | "on" | "both",
  ): Promise<FeedStatsResponse> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const bothOnly = mode === "both";
    // Both-only: a filter alert early in the window counts with a call from up to the fold window
    // before it, as its feed card does.
    const callsSince = bothOnly ? new Date(since.getTime() - CURATED_MATCH_LINK_WINDOW_MS) : since;

    const [matches, calls] = await Promise.all([
      prisma.match.findMany({
        where: { userId, matchedAt: { gte: since }, ...(bothOnly ? { filter: ACTIVE_FILTER } : {}) },
        orderBy: { matchedAt: "desc" },
        take: FEED_STATS_MAX_ROWS,
        select: STATS_MATCH_SELECT,
      }),
      feedCalls.models.length === 0
        ? Promise.resolve([])
        : sharedCallRead(`stats:${hours}:${bothOnly ? "both:" : ""}${feedCallsKey(feedCalls)}`, () =>
            prisma.curatedAlert.findMany({
              where: { ...feedCallsWhere(feedCalls), createdAt: { gte: callsSince } },
              orderBy: { createdAt: "desc" },
              take: FEED_STATS_MAX_ROWS,
              select: STATS_CALL_SELECT,
            }),
          ),
    ]);

    const cards = feedStatsCards(matches, calls, await openOutcomeRows(matches), bothOnly);

    return {
      ...summarizeFeed(cards, hours),
      showModelAlerts: mode !== "off",
      bothOnly,
      // The caps bound a pathological window; a real feed is far below them.
      truncated: matches.length === FEED_STATS_MAX_ROWS || calls.length === FEED_STATS_MAX_ROWS,
    };
  }

  /**
   * The Stats panel's returns: the average exit-plan return of this reader's feed over the last
   * hour, 6 hours, day and week, each with its bars. The same cards /stats grades (their filter's
   * alerts plus, when their switch is on, their followed models' calls, folded the same way), read
   * once for the week and cut into the four windows here. Only the columns the return needs are
   * read, both reads ride an index ((userId, matchedAt) and (model, createdAt)), and the panel
   * asks only while it is open.
   */
  app.get("/returns", async (request, reply) => {
    const parsed = feedReturnsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const saved = await savedFeed(request);
    const calls = await readerCalls(saved, parsed.data.highConviction);
    const userId = request.user!.userId;
    const mode = feedMode(saved);
    const key = `${userId}:${mode}:${feedCallsKey(calls)}`;
    return returnsCache.for(key).get(() => buildFeedReturns(userId, calls, mode));
  });

  async function buildFeedReturns(
    userId: string,
    feedCalls: FeedCalls,
    mode: "off" | "on" | "both",
  ): Promise<FeedReturnsResponse> {
    const now = Date.now();
    const since = new Date(now - RETURN_WINDOW_MAX_HOURS * 3_600_000);
    const bothOnly = mode === "both";
    const callsSince = bothOnly ? new Date(since.getTime() - CURATED_MATCH_LINK_WINDOW_MS) : since;
    const [allMatches, allCalls] = await Promise.all([
      prisma.match.findMany({
        where: { userId, matchedAt: { gte: since }, ...(bothOnly ? { filter: ACTIVE_FILTER } : {}) },
        orderBy: { matchedAt: "desc" },
        take: FEED_STATS_MAX_ROWS,
        select: {
          id: true,
          tokenId: true,
          filterId: true,
          peakReturnPct: true,
          // The verdict too: the Top 3 shows only calls that passed.
          ...MATCH_OUTCOME_SELECT,
        },
      }),
      feedCalls.models.length === 0
        ? Promise.resolve([])
        : sharedCallRead(`returns:${bothOnly ? "both:" : ""}${feedCallsKey(feedCalls)}`, () =>
            prisma.curatedAlert.findMany({
              where: { ...feedCallsWhere(feedCalls), createdAt: { gte: callsSince } },
              orderBy: { createdAt: "desc" },
              take: FEED_STATS_MAX_ROWS,
              select: {
                ...CALL_SELECT,
                simReturnPct: true,
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
                anchorMcapUsd: true,
                peakMcapUsd: true,
                candidateOutcome: {
                  select: { ...curatedAlertInclude.candidateOutcome.select, ...RUN_PEAK_SELECT },
                },
              },
            }),
          ),
    ]);
    // Both-only: the filter alerts a call stands beside, and the calls standing beside one (the
    // models' Top 3 then lists only calls the feed shows).
    const nearCall = bothOnly ? calledNear(allCalls) : null;
    const nearMatch = bothOnly
      ? calledNear(allMatches.map((m) => ({ tokenId: m.tokenId, createdAt: m.matchedAt })))
      : null;
    const matches = nearCall ? allMatches.filter((m) => nearCall(m.tokenId, m.matchedAt)) : allMatches;
    const calls = nearMatch ? allCalls.filter((c) => nearMatch(c.tokenId, c.createdAt)) : allCalls;
    // A filter alert's return is on the row grading it; the match keeps no copy.
    const outcomeIds = [
      ...new Set(matches.flatMap((m) => (m.candidateOutcomeId ? [m.candidateOutcomeId] : []))),
    ];
    const outcomes =
      outcomeIds.length === 0
        ? []
        : await prisma.candidateOutcome.findMany({
            where: { id: { in: outcomeIds } },
            select: { id: true, ...RUN_PEAK_SELECT },
          });
    const outcomeById = new Map(outcomes.map((o) => [o.id, o]));
    const rowById = await openOutcomeRows(matches);

    type ReturnFeedCard = ReturnCard & {
      id: string;
      kind: "match" | "curated";
      tokenId: string;
      matchedAt: Date;
      /** The filter that caught it, or the model's name for a call. */
      source: { filterId: string } | { modelName: string };
      /** The Peak the feed card shows: the highest the token went above its alert price. */
      peakPct: number | null;
      /** Whether the alert passed (callPassed): the Top 3 shows only those. */
      passed: boolean;
      curated: {
        alertId: string;
        /** When the call was made. */
        at: Date;
        returnPct: number | null;
        peakPct: number | null;
        passed: boolean;
        modelName: string;
      } | null;
    };
    const matchCards: ReturnFeedCard[] = matches.map((m) => {
      const row = m.candidateOutcomeId ? (outcomeById.get(m.candidateOutcomeId) ?? null) : null;
      return {
        id: m.id,
        kind: "match",
        tokenId: m.tokenId,
        matchedAt: m.matchedAt,
        at: m.matchedAt,
        returnPct: row?.simReturnPct ?? null,
        // The card's Peak for a filter alert: its tracked ATH, else its grading row's run peak.
        peakPct: m.peakReturnPct ?? m.peak24hReturnPct ?? runPeakPct(row),
        source: { filterId: m.filterId },
        passed: callPassed(matchOutcome(m, rowById)),
        curated: null,
      };
    });
    // Folded exactly as /stats folds them, so the two panels count the same cards.
    const groups = groupSameTokenCalls(calls, CURATED_MATCH_LINK_WINDOW_MS);
    const callLive = await liveMarketCapPeaks(groups.map(({ lead }) => lead));
    const callCards: ReturnFeedCard[] = groups.map(({ lead }) => {
      const returnPct = lead.simReturnPct ?? lead.candidateOutcome?.simReturnPct ?? null;
      const modelName = lead.modelName ?? lead.model ?? "Model";
      // The call's own run peak stops when its watch does (30 minutes for a call that didn't
      // double), so a token that ran later would read small. Its market-cap high since the call
      // (peakMcapUsd, from the snapshots, via callPeakPct) and its live reading are the same ATH a
      // filter alert tracks.
      const peakPct = maxPct(
        callPeakPct(lead.peak24hReturnPct ?? runPeakPct(lead.candidateOutcome), lead),
        callLive.get(lead.id) ?? null,
      );
      const passed = callPassed(resolveOutcome(lead));
      return {
        id: lead.id,
        kind: "curated",
        tokenId: lead.tokenId,
        matchedAt: lead.createdAt,
        at: lead.createdAt,
        returnPct,
        peakPct,
        source: { modelName },
        passed,
        curated: { alertId: lead.id, at: lead.createdAt, returnPct, peakPct, passed, modelName },
      };
    });
    type FoldedReturnCard = ReturnCard & {
      tokenId: string;
      peakPct: number | null;
      source: ReturnFeedCard["source"];
      /** When the alert that made the Peak came: the Top 3 shows that, not the card's time. */
      peakAt: Date;
      /** Whether the alert that made the Peak passed. */
      passed: boolean;
    };
    const foldedCards = foldCuratedIntoPage([...matchCards, ...callCards], CURATED_MATCH_LINK_WINDOW_MS);
    const cards = (bothOnly ? foldedCards.filter((c) => c.kind === "match") : foldedCards).map(
      (c): FoldedReturnCard => {
        if (c.kind !== "match" || !c.curated) return { ...c, peakAt: c.at };
        // A folded card's return is the call's; its run is the better of the two alerts' (each
        // from its own alert price), shown with the time and source of the alert that made it - a
        // multiple put on the other alert's time or name would claim a run that alert didn't make.
        // The card stays at its own time in the return windows, as it shows in the feed.
        const callWins = c.curated.peakPct !== null && (c.peakPct === null || c.curated.peakPct > c.peakPct);
        return {
          at: c.at,
          tokenId: c.tokenId,
          returnPct: c.curated.returnPct,
          peakPct: maxPct(c.peakPct, c.curated.peakPct),
          source: callWins ? { modelName: c.curated.modelName } : c.source,
          peakAt: callWins ? c.curated.at : c.at,
          passed: callWins ? c.curated.passed : c.passed,
        };
      },
    );
    // The Top 3 three ways: the whole feed (folded as it shows), the models' calls alone, and the
    // reader's own filters' alerts alone - each from its own alerts, so a token both caught counts
    // in each list with that side's run.
    const best = topReturns(
      cards.map((c) => ({ ...c, at: c.peakAt })),
      now,
    );
    const bestModel = topReturns(callCards, now);
    const bestFilter = topReturns(matchCards, now);
    const shown = [...best, ...bestModel, ...bestFilter];
    // Names only for the cards shown, not for the week's every card.
    const tokenIds = [...new Set(shown.map((b) => b.tokenId))];
    const tokens =
      tokenIds.length === 0
        ? []
        : await prisma.token.findMany({
            where: { id: { in: tokenIds } },
            select: { id: true, symbol: true, name: true, mintAddress: true },
          });
    const tokenById = new Map(tokens.map((t) => [t.id, t]));
    const filterIds = [...new Set(shown.flatMap((b) => ("filterId" in b.source ? [b.source.filterId] : [])))];
    const filters =
      filterIds.length === 0
        ? []
        : await prisma.userFilter.findMany({
            where: { id: { in: filterIds }, userId },
            select: { id: true, name: true },
          });
    const filterName = new Map(filters.map((f) => [f.id, f.name]));
    const sourceOf = (src: ReturnFeedCard["source"]) => {
      if ("modelName" in src) return { kind: "model" as const, name: src.modelName };
      const name = filterName.get(src.filterId);
      return name ? { kind: "filter" as const, name } : null;
    };
    const named = (
      list: readonly { tokenId: string; at: Date; peakPct: number; source: ReturnFeedCard["source"] }[],
    ) =>
      list.flatMap((b) => {
        const t = tokenById.get(b.tokenId);
        return t
          ? [
              {
                tokenId: b.tokenId,
                symbol: t.symbol,
                name: t.name,
                mintAddress: t.mintAddress,
                at: b.at.toISOString(),
                peakPct: b.peakPct,
                source: sourceOf(b.source),
              },
            ]
          : [];
      });
    return {
      windows: summarizeReturns(cards, now),
      top: named(best),
      topBySource: { model: named(bestModel), filter: named(bestFilter) },
      showModelAlerts: mode !== "off",
      bothOnly,
      truncated: allMatches.length === FEED_STATS_MAX_ROWS || allCalls.length === FEED_STATS_MAX_ROWS,
    };
  }

  /** The live feed: this user's matches, newest first, 12 per page. */
  app.get("/", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { page, includeCurated, highConviction, mint, q } = parsed.data;
    // A text search is uncached and can't use an index (%text%): its own, tighter budget, so one
    // script can't keep the shared database busy (security audit 2026-10-16, inputs F3).
    if (q && !allowTextSearch(request.user!.userId)) {
      return reply.code(429).send({ error: "Too many searches; wait a few seconds and try again." });
    }
    // The CA search: one token's alerts. Nobody has an alert on a token we never saw.
    const searched = mint
      ? await prisma.token.findUnique({ where: { mintAddress: mint }, select: { id: true } })
      : undefined;
    if (searched === null) return { matches: [], page, pageSize: PAGE_SIZE, totalCount: 0, hasMore: false };
    const tokenId = searched?.id;
    // The name/ticker search: the tokens whose ticker, name or address holds the text.
    const narrow = tokenId ? { tokenId } : q ? { token: tokenTextWhere(q) } : {};
    const where = { userId: request.user!.userId, ...narrow };
    // Every model-call read below narrows the same way, and its cache key says so (ahead of the
    // model set, which keyFollowsModel reads off the end).
    const callsWhere = (calls: FeedCalls) => ({ ...feedCallsWhere(calls), ...narrow });
    const tokenKey = tokenId ? `token=${tokenId}:` : "";
    // A typed search is one reader's passing question: it isn't cached, so a run of keystrokes
    // can't push every reader's shared answers out of the bounded caches.
    const callRead = <T>(key: string, read: () => Promise<T>): Promise<T> =>
      q ? read() : sharedCallRead(key, read);

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
    // Settings' "only alerts both caught": the page is the reader's active filters' alerts on
    // tokens a followed model also called within the fold window, each one card wearing both, and
    // no card from either side alone. Paged on those matches alone (bothOnlyRows), not merged.
    const bothOnly = saved !== null && feedBothOnlyApplies(saved);
    const wantsCurated = !bothOnly && (includeCurated === "on" || (saved?.showModelAlerts ?? false));
    // Skipped entirely when the reader hasn't opted in - no curated rows are fetched, so nothing
    // is filtered out after the fact and the page count stays exact.
    const interleave = wantsCurated && mergeDepth <= MAX_MERGE_DEPTH;
    // Past the merge depth with curated cards on, this page is matches only - but the pages before
    // it showed fewer than MAX_MERGE_DEPTH matches (curated cards took slots), so a plain
    // (page - 1) * PAGE_SIZE offset skipped every match ranked between the last one shown and
    // position MAX_MERGE_DEPTH. The offset is counted from the merged run instead.
    const pastMergeDepth = wantsCurated && !interleave;

    // The curated calls interleaved are every model the reader checked (else their single pick,
    // else the default) - the same list the Models tab marks as in their feed - or, with
    // ?highConviction=1, the high-conviction tier alone.
    // Fetched alongside the matches rather than after them: the two halves are independent.
    const feedCalls = async (): Promise<FeedCalls> => {
      const [state, feed] = await Promise.all([contestState(opts.env), saved ?? savedFeed(request)]);
      return resolveFeedCalls(state, resolveFeedModels(state, feed).models, highConviction);
    };
    const loadCurated = async (depth = mergeDepth) => {
      const calls = await feedCalls();
      // Several models calling one token collapse into one card (at most one call per model), so
      // the newest page * models calls always hold this page's cards whole - see
      // groupSameTokenCalls. Only the columns grouping needs; the page's own rows are loaded in
      // full below.
      const take = depth * calls.models.length;
      const key = tokenKey + feedCallsKey(calls);
      const [rows, total] = await Promise.all([
        callRead(`feed:${take}:${key}`, () =>
          prisma.curatedAlert.findMany({
            where: callsWhere(calls),
            orderBy: { createdAt: "desc" },
            take,
            select: CALL_SELECT,
          }),
        ),
        // Only the legacy flag reports a count; the dashboard pages on hasMore instead.
        includeCurated === "on"
          ? callRead(`count:${key}`, () => prisma.curatedAlert.count({ where: callsWhere(calls) }))
          : 0,
      ]);
      return { calls, rows, total, hitLimit: rows.length === take };
    };

    // How many of the first MAX_MERGE_DEPTH merged items were matches: where the matches-only
    // tail starts. The same two bare reads page MAX_MERGE_DEPTH / PAGE_SIZE itself makes.
    const matchesInMergedRun = async (): Promise<number> => {
      const calls = await feedCalls();
      if (q) return countMatchesInMergedRun();
      return mergedRunCache
        .for(`${where.userId}:${tokenKey}${feedCallsKey(calls)}`)
        .get(() => countMatchesInMergedRun());
    };
    const countMatchesInMergedRun = async (): Promise<number> => {
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

    /**
     * The both-only page: the reader's matches from active filters with a followed call on the
     * same token within the fold window either side (calledNear's test, in SQL), newest first, one
     * row past the page so hasMore needs no count. Rides Match (userId, matchedAt) for the scan and
     * CuratedAlert (tokenId, createdAt) for each EXISTS.
     */
    const bothOnlyRows = async (calls: FeedCalls) => {
      if (calls.models.length === 0) return [];
      const text = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
      return prisma.$queryRaw<{ id: string; matchedAt: Date; tokenId: string }[]>`
        SELECT m."id", m."matchedAt", m."tokenId"
          FROM "Match" m
          JOIN "UserFilter" f ON f."id" = m."filterId"
         WHERE m."userId" = ${where.userId}
           AND f."isActive" AND f."deletedAt" IS NULL
           ${tokenId ? Prisma.sql`AND m."tokenId" = ${tokenId}` : Prisma.empty}
           ${
             text
               ? Prisma.sql`AND EXISTS (SELECT 1 FROM "Token" t WHERE t."id" = m."tokenId"
                   AND (t."symbol" ILIKE ${text} OR t."name" ILIKE ${text} OR t."mintAddress" ILIKE ${text}))`
               : Prisma.empty
           }
           AND EXISTS (
             SELECT 1 FROM "CuratedAlert" c
              WHERE c."tokenId" = m."tokenId"
                AND c."model" = ANY(${calls.models})
                ${calls.tier === null ? Prisma.empty : Prisma.sql`AND c."tier" = ${calls.tier}`}
                AND c."createdAt" BETWEEN m."matchedAt" - ${CURATED_MATCH_LINK_WINDOW_MS / 1000} * interval '1 second'
                                      AND m."matchedAt" + ${CURATED_MATCH_LINK_WINDOW_MS / 1000} * interval '1 second')
         ORDER BY m."matchedAt" DESC, m."id" DESC
         OFFSET ${skip} LIMIT ${PAGE_SIZE + 1}`;
    };
    const both = bothOnly
      ? await feedCalls().then(async (calls) => ({ calls, rows: await bothOnlyRows(calls) }))
      : null;

    const [[matches, matchTotal], curated] = await Promise.all([
      both
        ? ([both.rows.slice(0, PAGE_SIZE), skip + both.rows.length] as const)
        : Promise.all([
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
            ...callsWhere(curated.calls),
            tokenId: { in: tokenIds },
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
    // Both-only: each card's calls - the followed calls on its token within the fold window, read
    // for the page's matches alone - grouped as the feed groups them; a card wears the group with
    // a call nearest its own alert.
    const bothGroupOf = new Map<string, CallGroup<CallRow>>();
    if (both && matches.length > 0) {
      const times = matches.map((m) => m.matchedAt.getTime());
      const near = await prisma.curatedAlert.findMany({
        where: {
          ...callsWhere(both.calls),
          tokenId: { in: [...new Set(matches.map((m) => m.tokenId))] },
          createdAt: {
            gte: new Date(Math.min(...times) - CURATED_MATCH_LINK_WINDOW_MS),
            lte: new Date(Math.max(...times) + CURATED_MATCH_LINK_WINDOW_MS),
          },
        },
        orderBy: { createdAt: "desc" },
        select: CALL_SELECT,
      });
      const groups = groupSameTokenCalls(near, CURATED_MATCH_LINK_WINDOW_MS);
      for (const m of matches) {
        const at = m.matchedAt.getTime();
        const gap = (g: CallGroup<CallRow>) =>
          Math.min(...g.calls.map((c) => Math.abs(c.alertedAt.getTime() - at)));
        const best = groups
          .filter((g) => g.lead.tokenId === m.tokenId && gap(g) <= CURATED_MATCH_LINK_WINDOW_MS)
          .sort((a, b) => gap(a) - gap(b))[0];
        if (best) bothGroupOf.set(m.id, best);
      }
      pageGroups = [...new Map([...bothGroupOf.values()].map((g) => [g.newest.id, g])).values()];
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
        snapshot: matchAlertSnapshot(match.snapshot, match.alertMcapUsd),
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
        if (!match) continue;
        const card = toMatchCard(match);
        // Both-only: the card wears its calls, as a folded card does.
        const group = bothGroupOf.get(match.id);
        const alert = group && curatedById.get(group.lead.id);
        if (group && alert) card.curated = toCuratedCard(alert, group).curated;
        ordered.push(card);
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
    opts.liveRefresher.request(
      cards.map((c) => c.token),
      request.user?.userId,
    );

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
