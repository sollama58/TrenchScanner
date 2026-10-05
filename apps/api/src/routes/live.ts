import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trenchscanner/core";
import type { OnDemandLiveRefresher } from "../liveRefresh.js";
import type { ViewStampBuffer } from "../viewStamps.js";

/** Most tokens one tick may ask about - more than a feed page holds, within one DexScreener call. */
export const LIVE_TICK_MAX_TOKENS = 30;

/**
 * How old a reading the tick will hand back without first looking again. Just under the
 * dashboard's 10s tick, so every tick of an open page finds the previous reading due.
 */
const LIVE_TICK_MAX_AGE_MS = 8_000;

/**
 * How long a tick waits for a lookup before answering with what it has. DexScreener usually
 * answers in 150-450ms; a slow one must not hold the response, and its numbers land on the next
 * tick anyway.
 */
const LIVE_TICK_WAIT_MS = 2_500;

const LIVE_TICK_RATE_LIMIT = { max: 40, timeWindow: "1 minute" };

const tickQuerySchema = z.object({
  tokens: z
    .string()
    .transform((v) => [...new Set(v.split(",").filter(Boolean))])
    .pipe(z.array(z.string().min(1).max(64)).min(1).max(LIVE_TICK_MAX_TOKENS)),
});

/**
 * The live tick: current market data for the tokens on an open page, seconds old.
 *
 * Before this, "Now" on a card was as fresh as the last full feed poll (every 30s) carrying the
 * last worker refresh (every 60s) - up to 90s behind, ~45s on average, on a product whose alerts
 * are graded on a one-hour window. The full feed is the wrong thing to poll faster: it is a dozen
 * queries for rows that rarely change. This is one indexed read of a few columns, plus a lookup
 * shared with every other reader of the same tokens, so the dashboard can afford it every 10s.
 *
 * Also counts as viewing the tokens (Token.lastViewedAt), so the worker keeps refreshing them
 * while the page stays open.
 */
export async function registerLiveRoutes(
  app: FastifyInstance,
  opts: { liveRefresher: OnDemandLiveRefresher; viewStamps: ViewStampBuffer },
) {
  // Same gate as the feeds these numbers belong to.
  app.addHook("preHandler", app.authenticateSubscriber);

  // The dashboard ticks every 10 seconds; a few tabs fit under this. Each tick's lookup spends the
  // refresher's shared upstream budget, so one client can't burn it for everyone by ticking fast.
  app.get("/market", { config: { rateLimit: LIVE_TICK_RATE_LIMIT } }, async (request, reply) => {
    const parsed = tickQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const ids = parsed.data.tokens;
    const read = () =>
      prisma.token.findMany({
        where: { id: { in: ids } },
        select: { id: true, mintAddress: true, liveMarketCapUsd: true, livePriceUsd: true, liveDataAt: true },
      });

    let rows = await read();
    opts.viewStamps.record(rows.map((r) => r.id));
    const refreshed = await opts.liveRefresher.refreshAndWait(rows, {
      maxAgeMs: LIVE_TICK_MAX_AGE_MS,
      timeoutMs: LIVE_TICK_WAIT_MS,
    });
    if (refreshed) rows = await read();

    reply.header("Cache-Control", "no-store");
    const now = Date.now();
    const withReading = rows.filter((r) => r.liveDataAt !== null && r.liveMarketCapUsd !== null);
    if (withReading.length > 0) {
      opts.liveRefresher.noteServed(Math.max(...withReading.map((r) => now - r.liveDataAt!.getTime())));
    }
    return {
      at: new Date(now).toISOString(),
      tokens: withReading.map((r) => ({
        id: r.id,
        marketCapUsd: r.liveMarketCapUsd,
        priceUsd: r.livePriceUsd,
        at: r.liveDataAt,
      })),
    };
  });
}
