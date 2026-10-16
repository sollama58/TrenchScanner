import { floatArrayParam, prisma } from "./db.js";
import { createLogger } from "./logger.js";
import type { DexScreenerClient } from "./datasources/dexscreener.js";

const logger = createLogger("live-market-data");

/**
 * How long after a model call a DexScreener reading (a scan snapshot or a live ping) starts to
 * count toward the call's market-cap high. DexScreener runs 45-60 s behind the market, and a call
 * is priced from a seconds-old Jupiter quote (label rule 4), so a reading taken in the first minute
 * still shows the market from before the call: CASINO, called at $11k on its way down from an $83k
 * wick, banked a $70k "high since the call" from a reading taken 14 s after it. A real high in that
 * minute is still caught by the call's run peak, which the watcher follows on Jupiter's prices.
 */
export const CALL_PEAK_READING_LAG_MS = 60_000;

/** What one refresh pass managed to do. `requested - updated` is what DexScreener had no data for. */
export interface LiveMarketDataRefresh {
  requested: number;
  updated: number;
}

/**
 * Writes current market data onto Token.liveMarketCapUsd/livePriceUsd/liveDataAt for the given
 * tokens, in one batched DexScreener lookup.
 *
 * Deliberately not a TokenSnapshot: a snapshot is a full point-in-time evaluation that feeds
 * scoring, matching and history, and minting one every time a number moves on screen would both
 * bloat that table and attach stale on-chain data to fresh market data. See the comment on those
 * three fields in schema.prisma.
 *
 * Shared by the worker's periodic live-price job and the API's on-demand refresh, so "what a live
 * refresh writes" has exactly one definition. Throws if the DexScreener call itself fails - both
 * callers treat that as "no refresh this time" rather than an error worth surfacing, but that's
 * their decision to make, not this function's.
 */
export async function refreshLiveMarketData(
  dexScreener: DexScreenerClient,
  tokens: readonly { id: string; mintAddress: string }[],
  options: {
    /**
     * Also raise the recorded peak of these tokens' matches and model calls from the last
     * this-many days, from the readings just taken. Omit to leave peaks to the worker's
     * match-peaks pass alone.
     */
    peakWindowDays?: number;
    /** Filled with the mints whose DexScreener batch failed (the client answers them as absent). */
    failed?: Set<string>;
  } = {},
): Promise<LiveMarketDataRefresh> {
  if (tokens.length === 0) return { requested: 0, updated: 0 };

  // When each reading was taken, per mint: a lookup of several batches spans seconds, and the
  // reading's own time is what liveDataAt (and a peak recorded from it) should carry, not the
  // moment the write happened to land.
  const seenAt = new Map<string, Date>();
  const live = await dexScreener.getTokensByAddresses(
    tokens.map((t) => t.mintAddress),
    5,
    { seenAt, failed: options.failed },
  );
  return writeLiveMarketData(tokens, live, {
    peakWindowDays: options.peakWindowDays,
    seenAt,
    fetchedAt: new Date(),
  });
}

/**
 * The write half of refreshLiveMarketData, for market data already in hand: the scan prices every
 * viewed token each cycle anyway, and writing what it got saves the live-price job asking
 * DexScreener for the same tokens again moments later.
 */
export async function writeLiveMarketData(
  tokens: readonly { id: string; mintAddress: string }[],
  live: readonly { mintAddress: string; marketCapUsd: number; priceUsd: number }[],
  options: {
    /** Per mint, when its reading was taken; mints missing from it get `fetchedAt`. */
    seenAt?: Map<string, Date>;
    fetchedAt: Date;
    peakWindowDays?: number;
  },
): Promise<LiveMarketDataRefresh> {
  if (tokens.length === 0) return { requested: 0, updated: 0 };
  const { seenAt, fetchedAt } = options;
  const byMint = new Map(live.map((c) => [c.mintAddress, c]));
  // Not in the response (delisted, liquidity pulled, DexScreener hasn't indexed it) - leave
  // whatever was last recorded rather than blanking it, exactly as outcomeTrackingJob does.
  const rows = tokens
    .flatMap((t) => {
      const data = byMint.get(t.mintAddress);
      // A pair with no market cap or FDV yet reads as 0: not a reading, so the row is left as it
      // was, last figure and its time, rather than stamped. Writing it as NULL with a fresh
      // liveDataAt erased the last good figure while the row looked just refreshed (and the
      // live-price job then skipped the token as fresh). refreshAndFilterToBand skips these for
      // the same reason. A non-finite or $0 price alongside a real market cap is written as NULL.
      return data && data.marketCapUsd > 0 && Number.isFinite(data.marketCapUsd)
        ? [
            {
              id: t.id,
              mcap: data.marketCapUsd,
              price: data.priceUsd > 0 ? data.priceUsd : NaN,
              at: seenAt?.get(t.mintAddress) ?? fetchedAt,
            },
          ]
        : [];
    })
    // A stable order, so two overlapping refreshes take their row locks in the same sequence.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (rows.length === 0) return { requested: tokens.length, updated: 0 };

  let updated = 0;
  try {
    // One statement for the whole batch. This used to be one UPDATE per token, all in flight at
    // once - up to 150 from the worker every minute and 12 per API page load, each its own pool
    // checkout, which on the API's 12-connection pool queued every other request behind them. A
    // token deleted mid-refresh simply matches no row.
    updated = await prisma.$executeRaw`
      UPDATE "Token" AS t
      SET "liveMarketCapUsd" = v.mcap, "livePriceUsd" = v.price, "liveDataAt" = v.at
      FROM unnest(
        ${rows.map((r) => r.id)}::text[],
        ${floatArrayParam(rows.map((r) => r.mcap))}::text::float8[],
        ${floatArrayParam(rows.map((r) => r.price))}::text::float8[],
        ${rows.map((r) => r.at.toISOString())}::text[]::timestamptz[]
      ) AS v(id, mcap, price, at)
      WHERE t.id = v.id
        -- The scan, the live-price job and the API refresher each read on their own client and
        -- cache: a reading older than the one already stored (a cached quote, a slow batch) must
        -- not take its place and move the card's figure backwards.
        AND (t."liveDataAt" IS NULL OR t."liveDataAt" <= v.at)`;
  } catch (err) {
    logger.warn("failed to persist live market data", { count: rows.length, error: String(err) });
  }

  if (updated > 0 && options.peakWindowDays !== undefined) {
    await raiseMatchPeaks(rows, options.peakWindowDays);
    await raiseCuratedPeaks(rows, options.peakWindowDays);
  }

  return { requested: tokens.length, updated };
}

/**
 * Raises Match.peakMcapUsd wherever a reading just taken is above it.
 *
 * The worker's match-peaks pass folds live readings in every two minutes, but a live reading is
 * only the latest value, so a high that came and went between two passes was never recorded -
 * and with the dashboard's live tick reading every few seconds, most readings were thrown away
 * that way. Doing it here records each one as it is taken. Same rule as the live-ping statement in
 * matchPeaks.ts: a peak only counts above the alert market cap. peakReturnPct and hitHundredPctAt
 * follow on the worker's next pass (repairOutcomeBookkeeping keys off peakMcapAt). The peak is
 * stamped with the reading's time - the same liveDataAt just written - as the worker's own
 * live-ping statement stamps it, so "when it peaked" is when the price was seen, not written.
 *
 * Failures are logged, not thrown: the market data itself is already saved.
 */
async function raiseMatchPeaks(
  rows: readonly { id: string; mcap: number; at: Date }[],
  windowDays: number,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "Match" m
      SET "peakMcapUsd" = v.mcap, "peakMcapAt" = v.at
      FROM unnest(
        ${rows.map((r) => r.id)}::text[],
        ${floatArrayParam(rows.map((r) => r.mcap))}::text::float8[],
        ${rows.map((r) => r.at.toISOString())}::text[]::timestamptz[]
      ) AS v(id, mcap, at),
      "TokenSnapshot" alert
      WHERE m."tokenId" = v.id
        AND alert.id = m."snapshotId"
        AND m."matchedAt" > now() - MAKE_INTERVAL(days => ${windowDays}::int)
        -- A reading taken before the alert (a lookup spans seconds) is not its peak; nor, on an
        -- alert priced from a fresh quote, one from the minute after it (see Match.alertMcapUsd).
        AND v.at >= m."matchedAt" + CASE
          WHEN m."alertMcapUsd" IS NULL THEN INTERVAL '0 seconds'
          ELSE MAKE_INTERVAL(secs => ${CALL_PEAK_READING_LAG_MS / 1000}::int)
        END
        AND v.mcap > GREATEST(COALESCE(m."peakMcapUsd", 0), COALESCE(m."alertMcapUsd", alert."marketCapUsd"))`;
  } catch (err) {
    logger.warn("failed to record live match peaks", { count: rows.length, error: String(err) });
  }
}

/**
 * The same for model calls: raises CuratedAlert.peakMcapUsd wherever a reading just taken is above
 * it and above the call's market cap, as the live-ping statement in curatedPeaks.ts does. Without
 * it a call's high was only read off the Token's latest live reading on the worker's pass, so a
 * high between two passes was lost for the call while the filter alert on the same token kept it.
 */
async function raiseCuratedPeaks(
  rows: readonly { id: string; mcap: number; at: Date }[],
  windowDays: number,
): Promise<void> {
  try {
    await prisma.$executeRaw`
      UPDATE "CuratedAlert" c
      SET "peakMcapUsd" = v.mcap, "peakMcapAt" = v.at
      FROM unnest(
        ${rows.map((r) => r.id)}::text[],
        ${floatArrayParam(rows.map((r) => r.mcap))}::text::float8[],
        ${rows.map((r) => r.at.toISOString())}::text[]::timestamptz[]
      ) AS v(id, mcap, at)
      WHERE c."tokenId" = v.id
        AND c."createdAt" > now() - MAKE_INTERVAL(days => ${windowDays}::int)
        -- A reading from the first minute after the call still shows the market before it.
        AND v.at >= c."createdAt" + MAKE_INTERVAL(secs => ${CALL_PEAK_READING_LAG_MS / 1000}::int)
        AND v.mcap > GREATEST(COALESCE(c."peakMcapUsd", 0), c."anchorMcapUsd")`;
  } catch (err) {
    logger.warn("failed to record live call peaks", { count: rows.length, error: String(err) });
  }
}
