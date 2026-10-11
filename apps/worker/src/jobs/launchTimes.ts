import { createLogger, forEachWithConcurrency, type Env, type PumpFunClient } from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("launch-times");

/**
 * How long each graduated candidate spent on its bonding curve, for the safety screen's pre-bond
 * cut (SAFETY_MIN_PREBOND_SECONDS): launch to graduation. Graduation is the PumpSwap pool's
 * creation time from the DexScreener pairs the scan already fetches (CandidateToken.graduatedAt);
 * launch is Pump.fun's created_timestamp, taken from the discovery lists for free
 * (rememberLaunchTimes) and otherwise asked of Pump.fun once per mint. A launch time never
 * changes, so answers are kept for good; failures back off and are never cached.
 *
 * Most graduated tokens never need the lookup: the first time the scanner knew of a mint is never
 * before its launch, so a mint known a full floor before its graduation clears the cut as is.
 */
const launches = new Map<string, number | null>();
const CACHE_MAX = 50_000;
const failureBackoff = new FailureBackoff();
const LOOKUP_CONCURRENCY = 4;

/** Test hook. */
export function resetLaunchTimes(): void {
  launches.clear();
  failureBackoff.clear();
}

function remember(mint: string, launchMs: number | null): void {
  if (!launches.has(mint) && launches.size >= CACHE_MAX) {
    // Oldest first (insertion order): the mints launched longest ago are the least likely to
    // graduate now.
    const drop = launches.size - CACHE_MAX + 1 + Math.floor(CACHE_MAX / 10);
    let n = 0;
    for (const key of launches.keys()) {
      if (n++ >= drop) break;
      launches.delete(key);
    }
  }
  launches.set(mint, launchMs);
}

/** Seeds launch times the discovery lists already carry (Pump.fun's created_timestamp). */
export function rememberLaunchTimes(coins: ReadonlyArray<{ mintAddress: string; createdAt?: Date }>): void {
  for (const coin of coins) {
    const ms = coin.createdAt?.getTime();
    if (typeof ms === "number" && Number.isFinite(ms) && launches.get(coin.mintAddress) == null) {
      remember(coin.mintAddress, ms);
    }
  }
}

/**
 * Seconds on the curve for each graduated candidate whose launch time is known (after this cycle's
 * lookups). A mint missing from the result is unknown - or already known to clear the floor - and
 * passes the cut. `knownSince` is the earliest time the scanner knew of each mint (its watchlist
 * first-seen time), an upper bound on its launch.
 */
export async function resolvePreBondSeconds(
  candidates: ReadonlyArray<{ mintAddress: string; graduatedAt?: Date }>,
  knownSince: ReadonlyMap<string, Date | undefined>,
  pumpFun: Pick<PumpFunClient, "launchTime">,
  env: Pick<Env, "SAFETY_MIN_PREBOND_SECONDS" | "PREBOND_LOOKUPS_MAX_PER_CYCLE">,
  now = Date.now(),
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const floorMs = env.SAFETY_MIN_PREBOND_SECONDS * 1000;
  if (floorMs <= 0) return out;

  const graduated = candidates.filter(
    (c): c is { mintAddress: string; graduatedAt: Date } =>
      c.graduatedAt instanceof Date && !Number.isNaN(c.graduatedAt.getTime()),
  );
  const toLookUp: string[] = [];
  for (const c of graduated) {
    if (launches.has(c.mintAddress)) continue;
    const known = knownSince.get(c.mintAddress)?.getTime();
    if (typeof known === "number" && c.graduatedAt.getTime() - known >= floorMs) continue;
    if (failureBackoff.blocked(c.mintAddress, now)) continue;
    if (toLookUp.length >= env.PREBOND_LOOKUPS_MAX_PER_CYCLE) continue;
    toLookUp.push(c.mintAddress);
  }

  let failed = 0;
  await forEachWithConcurrency(toLookUp, LOOKUP_CONCURRENCY, async (mint) => {
    try {
      const launched = await pumpFun.launchTime(mint);
      remember(mint, launched ? launched.getTime() : null);
      failureBackoff.succeed(mint);
    } catch {
      failed += 1;
      failureBackoff.fail(mint, now);
    }
  });
  failureBackoff.prune(now);
  if (failed > 0) logger.info("launch-time lookups without an answer", { failed, asked: toLookUp.length });

  for (const c of graduated) {
    const launched = launches.get(c.mintAddress);
    if (typeof launched === "number") out.set(c.mintAddress, (c.graduatedAt.getTime() - launched) / 1000);
  }
  return out;
}
