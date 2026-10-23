import type { FastifyInstance } from "fastify";
import {
  baseSegments,
  createLogger,
  launchSupplyFactors,
  oldestCandleCover,
  prisma,
  PUMPFUN_LAUNCHPAD,
  readCandleChunks,
  type Env,
  type SeriesInput,
} from "@trenchscanner/core";
import { allowLookupRead } from "../lookupGate.js";
import {
  askBackfill,
  configureCandleStore,
  keepStreamBars,
  latestPage,
  storingFetcher,
} from "../candleStore.js";
import { liveCurves } from "../liveCurve.js";
import { liveTrades } from "../liveTrades.js";
import { sharedSolPrice } from "../solPrice.js";
import { streamCandles, type StreamFeeds } from "../streamCandles.js";
import { CandleCache, KeyedCache, pumpFunCandleFetcher, pumpFunPages } from "../tokenChart.js";
import {
  CANDLE_TIMEFRAMES,
  SOURCE_PRIORITY,
  candlesQuery,
  chunkInputs,
  pageInput,
  readTokenCandles,
  type CandleReadDeps,
  type TokenCandlesAnswer,
} from "../tokenCandles.js";

const logger = createLogger("candle-routes");

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A chart cache's newest page younger than this stands in for a read of our own. */
const PAGE_FRESH_MS = 90_000;

/**
 * The newest pages when no chart cache read the coin lately (the store holds only closed chunks).
 * Small budgets of their own: with the chart's 200 a minute they stay under the process's swap-api
 * gate (240, pumpfunGate.ts). Their reads are saved like the chart's (storingFetcher). The answers
 * are the token chart's own (pumpFunPages, price-market audit 2026-10-23, 4a-2): a coin open in both
 * read the same page twice within the TTL, which is the same here and there.
 */
const minuteCache = new CandleCache(storingFetcher(pumpFunCandleFetcher(), 60), {
  callsPerMinute: 20,
  ttlMs: 30_000,
  entries: pumpFunPages.minute,
});
const quarterCache = new CandleCache(storingFetcher(pumpFunCandleFetcher(undefined, "15s"), 15), {
  callsPerMinute: 10,
  ttlMs: 60_000,
  entries: pumpFunPages.quarter,
});

/** The live tail's ticks and Live trades', as the chart's own stream candles read them. */
const feeds: StreamFeeds = {
  history: (mint) => liveCurves().history(mint),
  recent: (mint) => liveTrades().recent(mint),
  solUsd: () => sharedSolPrice.get(),
};

/** A minute page ending longer ago than this leaves the newest stretch to the backfill's top-up. */
const STALE_MINUTES_MS = 3 * 60_000;

/** A page held this long still stands in for an older page's stretch the store hasn't saved yet. */
const PAGE_HELD_MS = 15 * 60_000;

/**
 * The stretch not stored yet: the newest Pump.fun pages, then the stream's 1-second bars. The
 * newest page (`newest`) may read Pump.fun; an older one takes only the pages held.
 */
async function liveInputs(
  mint: string,
  tfSec: number,
  factor: number,
  newest: boolean,
): Promise<SeriesInput[]> {
  const out: SeriesInput[] = [];
  const page = async (res: 15 | 60, cache: CandleCache) => {
    const kept = latestPage(mint, res, newest ? PAGE_FRESH_MS : PAGE_HELD_MS);
    if (kept) return pageInput(kept.candles, res, kept.at, factor);
    if (!newest) return null;
    const read = await cache.read(mint).catch(() => null);
    const fresh = latestPage(mint, res, PAGE_FRESH_MS);
    if (fresh) return pageInput(fresh.candles, res, fresh.at, factor);
    // A stale answer (Pump.fun failing): its cover ends at its newest bar.
    const candles = read?.candles;
    return candles?.length
      ? pageInput(candles, res, candles[candles.length - 1]!.t + res * 1_000, factor)
      : null;
  };
  const [minutes, quarters, stream] = await Promise.all([
    page(60, minuteCache),
    tfSec < 60 ? page(15, quarterCache) : Promise.resolve(null),
    // Already on the supply now (LiveCurves.history).
    newest ? streamCandles(feeds, mint, 1_000).catch(() => null) : Promise.resolve(null),
  ]);
  if (minutes) out.push(minutes);
  // No minute page, or only an old one (Pump.fun has no such coin, or won't answer: its Cloudflare
  // answered Render 403 on 2026-10-23): the store's newest minutes come from the backfill, topped
  // up to now from GeckoTerminal while a chart is open, at most every BACKFILL_TOP_UP_AFTER_MS.
  if (newest && (!minutes || minutes.coverTo < Date.now() - STALE_MINUTES_MS))
    askBackfill(mint, Date.now(), true);
  if (quarters) out.push(quarters);
  if (stream?.candles.length) {
    // On the finest timeframes only what the stream itself delivered: RPC reads every few seconds
    // make 1-second bars that sit flat four seconds in five (charts audit CH-6).
    const from = tfSec < 5 ? stream.streamFrom : (stream.coveredFrom ?? stream.candles[0]!.t);
    // What the stream itself delivered is saved, on the launch billion, for the next chart.
    if (stream.streamFrom !== null && stream.readAt !== null && factor > 0) {
      const saveFrom = stream.streamFrom;
      keepStreamBars(
        mint,
        stream.candles
          .filter((k) => k.t >= saveFrom)
          .map((k) => ({ ...k, o: k.o / factor, h: k.h / factor, l: k.l / factor, c: k.c / factor })),
        { from: saveFrom, to: stream.readAt },
      );
    }
    if (from !== null) {
      out.push({
        res: 1,
        coverFrom: from,
        coverTo: stream.readAt ?? stream.candles[stream.candles.length - 1]!.t + 1_000,
        bars: stream.candles.filter((k) => k.t + 1_000 > from),
        priority: SOURCE_PRIORITY.stream,
      });
    }
  }
  return out;
}

const deps: CandleReadDeps = {
  readChunks: readCandleChunks,
  oldestCover: oldestCandleCover,
  factor: async (mint) =>
    (await launchSupplyFactors([mint]).catch(() => new Map<string, number>())).get(mint),
  live: liveInputs,
};

/** Answers are shared by every reader for a few seconds (the newest page) or a minute (older ones). */
const newestAnswers = new KeyedCache<TokenCandlesAnswer>(5_000, 500);
const olderAnswers = new KeyedCache<TokenCandlesAnswer>(60_000, 500);
/** Whether a mint is on Token and is a Pump.fun coin, reused a while (the chart polls). */
const onToken = new KeyedCache<{ pump: boolean } | null>(5 * 60_000, 2_000);

/**
 * GET /tokens/:mint/candles?tf=&before=&limit= (charts audit 2026-10-22 target design): bars of
 * one timeframe from the closed-candle store and the live edge (tokenCandles.ts). Behind the same
 * paywall and lookup gate as the token chart, and only for a coin on Token.
 */
export async function registerCandleRoutes(app: FastifyInstance, opts: { env?: Env } = {}) {
  configureCandleStore({ enabled: opts.env?.CANDLE_STORE ?? true });
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/:mintAddress/candles", async (request, reply): Promise<TokenCandlesAnswer | undefined> => {
    const { mintAddress } = request.params as { mintAddress: string };
    if (!MINT_RE.test(mintAddress)) {
      reply.code(400).send({ error: "not a valid mint" });
      return;
    }
    const q = candlesQuery(request.query);
    if ("error" in q) {
      reply.code(400).send({ error: q.error });
      return;
    }
    if (!(await allowLookupRead(request, reply, "token", mintAddress))) return;
    const empty: TokenCandlesAnswer = { mint: mintAddress, tf: q.tf, bars: [], next: null };
    const known = await onToken
      .get(mintAddress, async () => {
        const row = await prisma.token.findUnique({
          where: { mintAddress },
          select: { launchpad: true },
        });
        return row ? { pump: row.launchpad === PUMPFUN_LAUNCHPAD || mintAddress.endsWith("pump") } : null;
      })
      .catch(() => null);
    if (!known) {
      onToken.forget(mintAddress);
      reply.header("Cache-Control", "private, max-age=15");
      return empty;
    }
    // Opening a chart queues the coin's history back to launch, once (the worker's candleBackfill.ts);
    // a coin Pump.fun has no candles for is topped up to now on each open (askBackfill).
    askBackfill(mintAddress, Date.now(), !known.pump);
    const key = `${mintAddress}:${q.tf}:${q.before ?? "now"}:${q.limit}`;
    const cache = q.before === null ? newestAnswers : olderAnswers;
    const answer = await cache
      .get(key, () => readTokenCandles(mintAddress, q.tf, q.before, q.limit, deps))
      .catch((err: unknown) => {
        logger.warn("candles failed", { mint: mintAddress, tf: q.tf, error: String(err) });
        return empty;
      });
    // As the chart's: the newest page a few seconds (3 on the finest timeframes, as /chart/fine's
    // 1-second answer), older pages, which hold only closed candles, a minute.
    const maxAge = q.before !== null ? 60 : CANDLE_TIMEFRAMES[q.tf] < 15 ? 3 : 15;
    reply.header("Cache-Control", `private, max-age=${maxAge}`);
    return answer;
  });
}

/** A summary of one series input, for the diagnosis. */
function inputSummary(i: SeriesInput & { source?: string; startAt?: number }) {
  return {
    res: i.res,
    ...(i.source ? { source: i.source } : {}),
    priority: i.priority,
    coverFrom: i.coverFrom,
    coverTo: i.coverTo,
    bars: i.bars.length,
    firstBar: i.bars[0]?.t ?? null,
    lastBar: i.bars[i.bars.length - 1]?.t ?? null,
  };
}

/**
 * GET /stats/candles/:mint's report (routes/stats.ts, behind STATS_API_TOKEN; chart gaps audit
 * 2026-10-23): the page a chart gets, with what it was built from (the stored chunks, the live
 * pages and the stream), which source each stretch was read from, and every stretch of the page
 * with no bar where some source does hold a bar: a gap the chart draws flat over real trades.
 * Read-only, apart from the newest page's usual Pump.fun read; asks for no backfill.
 */
export async function candleDiagnosis(mint: string, query: unknown) {
  if (!MINT_RE.test(mint)) return { error: "not a valid mint" };
  const q = candlesQuery(query);
  if ("error" in q) return q;
  const now = Date.now();
  const tfSec = CANDLE_TIMEFRAMES[q.tf];
  const tfMs = tfSec * 1_000;
  const factor = (await deps.factor(mint)) ?? 1;
  const live = await liveInputs(mint, tfSec, factor > 0 ? factor : 1, q.before === null);
  const answer = await readTokenCandles(mint, q.tf, q.before, q.limit, {
    ...deps,
    live: async () => live,
  });
  const end = q.before ?? Math.floor(now / tfMs) * tfMs + tfMs;
  const from = answer.bars[0]?.t ?? end - q.limit * tfMs;
  const chunks = await readCandleChunks(mint, from, end);
  const inputs = [
    ...chunks.map((c) => ({
      ...inputSummary({ ...c, priority: SOURCE_PRIORITY[c.source] }),
      source: c.source,
      startAt: c.startAt,
    })),
    ...live.map((i) => ({
      ...inputSummary(i),
      source: i.priority === SOURCE_PRIORITY.stream ? "stream" : "live",
    })),
  ];
  const all = [...chunkInputs(chunks, factor > 0 ? factor : 1), ...live];
  const segments = baseSegments(all, from, end, tfSec);
  // Stretches between the page's bars (each bar's own width) where some source holds a bar.
  const sourceBars = all.flatMap((i) => i.bars.map((b) => ({ t: b.t, res: i.res })));
  const gaps: { from: number; to: number; minutes: number; barsInSources: number }[] = [];
  for (let k = 1; k < answer.bars.length; k++) {
    const prev = answer.bars[k - 1]!;
    const gapFrom = prev.t + (prev.w ?? tfSec) * 1_000;
    const gapTo = answer.bars[k]!.t;
    if (gapTo <= gapFrom) continue;
    const held = sourceBars.filter((b) => b.t >= gapFrom && b.t + b.res * 1_000 <= gapTo).length;
    if (held > 0)
      gaps.push({ from: gapFrom, to: gapTo, minutes: (gapTo - gapFrom) / 60_000, barsInSources: held });
  }
  const backfill = await prisma.candleBackfill.findUnique({ where: { mint } }).catch(() => null);
  return {
    mint,
    tf: q.tf,
    now,
    factor,
    bars: answer.bars.length,
    firstBar: answer.bars[0]?.t ?? null,
    lastBar: answer.bars[answer.bars.length - 1]?.t ?? null,
    next: answer.next,
    coarseBars: answer.bars.filter((b) => b.coarse).length,
    gaps,
    segments,
    inputs,
    backfill,
    answer: answer.bars,
  };
}

/** GET /stats/candles: the coins charts asked the store about lately, newest first. */
export async function recentCandleCoins(limit = 30) {
  return prisma.candleBackfill.findMany({ orderBy: { requestedAt: "desc" }, take: limit });
}
