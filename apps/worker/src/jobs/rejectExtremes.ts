import { prisma, createLogger, floatArrayParam } from "@trenchscanner/core";

const logger = createLogger("reject-extremes");

/**
 * How long after a coin's first safety-screen rejection its price is followed: the window the
 * rejected-coin grade reads (audit 2026-10-14, lane 3 M9). Measurement only - nothing the scan
 * decides or alerts on reads these columns.
 */
export const REJECT_WATCH_MINUTES = 60;

/** One reading of a coin: what the screen rejected it at, or what a later refresh saw. */
export interface RejectReading {
  priceUsd: number;
  marketCapUsd: number;
}

/** First rejections seen this cycle, by Token.id, written together by flushScreenRejects. */
const pending = new Map<string, RejectReading & { at: Date }>();

function usable(r: RejectReading): boolean {
  return Number.isFinite(r.priceUsd) && r.priceUsd > 0 && Number.isFinite(r.marketCapUsd);
}

/**
 * Notes a coin the safety screen just rejected. Only its first rejection counts: a token whose
 * row already carries one is left alone, so a coin rejected every cycle costs nothing here.
 */
export function noteScreenReject(
  token: { id: string; screenRejectedAt?: Date | null },
  reading: RejectReading,
  at: Date = new Date(),
): void {
  if (token.screenRejectedAt || pending.has(token.id) || !usable(reading)) return;
  pending.set(token.id, { ...reading, at });
}

/**
 * Stamps this cycle's first rejections, the rejection's own reading seeding the peak and the low.
 * One statement for the batch; a row another pass stamped first keeps its stamp. Never fails the
 * cycle: a lost stamp only loses one coin's measurement. Returns how many rows were stamped.
 */
export async function flushScreenRejects(): Promise<number> {
  if (pending.size === 0) return 0;
  const rows = [...pending.entries()];
  pending.clear();
  const ids = rows.map(([id]) => id);
  const prices = floatArrayParam(rows.map(([, r]) => r.priceUsd));
  const mcaps = floatArrayParam(rows.map(([, r]) => r.marketCapUsd));
  // Token's timestamps are timestamp(3) without a zone holding UTC; ISO strings cast straight in.
  const ats = rows.map(([, r]) => r.at.toISOString().replace("Z", ""));
  return prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "screenRejectedAt" = v.at, "screenRejectedPriceUsd" = v.price, "screenRejectedMcapUsd" = v.mcap,
        "rejectPeak60mPriceUsd" = v.price, "rejectPeak60mMcapUsd" = v.mcap, "rejectPeak60mAt" = v.at,
        "rejectLow60mPriceUsd" = v.price, "rejectLow60mMcapUsd" = v.mcap
    FROM unnest(${ids}::text[], ${prices}::text::float8[], ${mcaps}::text::float8[], ${ats}::timestamp(3)[])
      AS v(id, price, mcap, at)
    WHERE t."id" = v.id AND t."screenRejectedAt" IS NULL`.catch((err: unknown) => {
    logger.warn("failed to stamp first screen rejections", { error: String(err) });
    return 0;
  });
}

/**
 * Folds the watchlist refresh's readings into the peak and low of every coin still inside the
 * REJECT_WATCH_MINUTES after its first rejection. The refresh already prices every tracked coin,
 * in band or not, each cycle; rejected coins stay on the watchlist while they trade, but are
 * snapshotted only every few minutes and only in band, so this is the one place their path is
 * seen at full cadence with no extra upstream read. Only a reading that sets a new peak or low
 * writes; every other row is matched on the mint index and left alone. Each reading counts at the
 * time it was taken (`seenAt`), not when it is written. Never fails the cycle. Returns how many
 * rows moved.
 */
export async function foldRejectExtremes(
  readings: readonly ({ mintAddress: string } & RejectReading)[],
  seenAt: ReadonlyMap<string, Date>,
  now: Date = new Date(),
): Promise<number> {
  const kept = readings.filter(usable);
  if (kept.length === 0) return 0;
  const mints = kept.map((r) => r.mintAddress);
  const prices = floatArrayParam(kept.map((r) => r.priceUsd));
  const mcaps = floatArrayParam(kept.map((r) => r.marketCapUsd));
  const ats = kept.map((r) => (seenAt.get(r.mintAddress) ?? now).toISOString().replace("Z", ""));
  const windowStart = new Date(now.getTime() - REJECT_WATCH_MINUTES * 60_000).toISOString().replace("Z", "");
  return prisma.$executeRaw`
    UPDATE "Token" AS t
    SET "rejectPeak60mPriceUsd" = GREATEST(t."rejectPeak60mPriceUsd", v.price),
        "rejectPeak60mMcapUsd" = CASE WHEN v.price > t."rejectPeak60mPriceUsd" THEN v.mcap ELSE t."rejectPeak60mMcapUsd" END,
        "rejectPeak60mAt" = CASE WHEN v.price > t."rejectPeak60mPriceUsd" THEN v.at ELSE t."rejectPeak60mAt" END,
        "rejectLow60mPriceUsd" = LEAST(t."rejectLow60mPriceUsd", v.price),
        "rejectLow60mMcapUsd" = CASE WHEN v.price < t."rejectLow60mPriceUsd" THEN v.mcap ELSE t."rejectLow60mMcapUsd" END
    FROM unnest(${mints}::text[], ${prices}::text::float8[], ${mcaps}::text::float8[], ${ats}::timestamp(3)[])
      AS v(mint, price, mcap, at)
    WHERE t."mintAddress" = v.mint
      AND t."screenRejectedAt" > ${windowStart}::timestamp(3)
      AND v.at >= t."screenRejectedAt"
      AND v.at <= t."screenRejectedAt" + ${REJECT_WATCH_MINUTES}::int * interval '1 minute'
      AND (v.price > t."rejectPeak60mPriceUsd" OR v.price < t."rejectLow60mPriceUsd")`.catch(
    (err: unknown) => {
      logger.warn("failed to fold rejected coins' prices", { error: String(err) });
      return 0;
    },
  );
}

/** Test hook. */
export function resetScreenRejects(): void {
  pending.clear();
}
