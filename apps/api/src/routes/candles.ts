import type { FastifyInstance } from "fastify";
import {
  createLogger,
  launchSupplyFactors,
  oldestCandleCover,
  prisma,
  readCandleChunks,
  type Env,
  type SeriesInput,
} from "@trenchscanner/core";
import { allowLookupRead } from "../lookupGate.js";
import { askBackfill, configureCandleStore, latestPage, storingFetcher } from "../candleStore.js";
import { liveCurves } from "../liveCurve.js";
import { liveTrades } from "../liveTrades.js";
import { sharedSolPrice } from "../solPrice.js";
import { streamCandles, type StreamFeeds } from "../streamCandles.js";
import { CandleCache, KeyedCache, pumpFunCandleFetcher } from "../tokenChart.js";
import {
  CANDLE_TIMEFRAMES,
  SOURCE_PRIORITY,
  candlesQuery,
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
 * gate (240, pumpfunGate.ts). Their reads are saved like the chart's (storingFetcher).
 */
const minuteCache = new CandleCache(storingFetcher(pumpFunCandleFetcher(), 60), {
  callsPerMinute: 20,
  ttlMs: 30_000,
});
const quarterCache = new CandleCache(storingFetcher(pumpFunCandleFetcher(undefined, "15s"), 15), {
  callsPerMinute: 10,
  ttlMs: 60_000,
});

/** The live tail's ticks and Live trades', as the chart's own stream candles read them. */
const feeds: StreamFeeds = {
  history: (mint) => liveCurves().history(mint),
  recent: (mint) => liveTrades().recent(mint),
  solUsd: () => sharedSolPrice.get(),
};

/** The newest stretch, not stored yet: the newest Pump.fun pages, then the stream's 1-second bars. */
async function liveInputs(mint: string, tfSec: number, factor: number): Promise<SeriesInput[]> {
  const out: SeriesInput[] = [];
  const page = async (res: 15 | 60, cache: CandleCache) => {
    const kept = latestPage(mint, res, PAGE_FRESH_MS);
    if (kept) return pageInput(kept.candles, res, kept.at, factor);
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
    streamCandles(feeds, mint, 1_000).catch(() => null),
  ]);
  if (minutes) out.push(minutes);
  if (quarters) out.push(quarters);
  if (stream?.candles.length) {
    out.push({
      res: 1,
      coverFrom: stream.coveredFrom ?? stream.candles[0]!.t,
      coverTo: stream.readAt ?? stream.candles[stream.candles.length - 1]!.t + 1_000,
      bars: stream.candles,
      priority: SOURCE_PRIORITY.stream,
    });
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
/** Whether a mint is on Token, reused a while (the chart polls). */
const onToken = new KeyedCache<boolean>(5 * 60_000, 2_000);

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
        const row = await prisma.token.findUnique({ where: { mintAddress }, select: { id: true } });
        return row !== null;
      })
      .catch(() => false);
    if (!known) {
      onToken.forget(mintAddress);
      reply.header("Cache-Control", "private, max-age=15");
      return empty;
    }
    // Opening a chart queues the coin's history back to launch, once (the worker's candleBackfill.ts).
    askBackfill(mintAddress);
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
