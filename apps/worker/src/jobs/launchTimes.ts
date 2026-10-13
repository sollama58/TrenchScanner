import {
  createLogger,
  forEachWithConcurrency,
  type DexScreenerClient,
  type Env,
  type PumpFunClient,
} from "@trenchscanner/core";
import { FailureBackoff } from "./failureBackoff.js";

const logger = createLogger("launch-times");

/**
 * How long each graduated candidate spent on its bonding curve, for the safety screen's pre-bond
 * cut (SAFETY_MIN_PREBOND_SECONDS): launch to graduation. Both ends never change, so answers are
 * kept for good; failed lookups back off and are never cached.
 *
 * Graduation, first source that has it:
 *  - the PumpSwap pool's creation time in the DexScreener pairs the scan already fetches
 *    (CandidateToken.graduatedAt);
 *  - the PumpPortal stream's migration event (rememberGraduations);
 *  - DexScreener's per-token pairs, asked once for a curve that looks bought out (see
 *    looksBoughtOut). A coin whose curve filled in its launch second is the case all three exist
 *    for: DexScreener's batch lookup goes on listing only its frozen curve, so the scan read it as
 *    a pre-bond token at the graduation price and the cut never saw it graduate (2026-10-11: six
 *    such coins, 57 calls).
 *
 * Launch: the curve pair's own creation time, Pump.fun's created_timestamp from the discovery
 * lists (rememberLaunchTimes), and otherwise Pump.fun asked once per mint. Most graduated tokens
 * never need that lookup: the first time the scanner knew of a mint is never before its launch,
 * so a mint known a full floor before its graduation clears the cut as is.
 */
const launches = new Map<string, number | null>();
const graduations = new Map<string, number>();
const CACHE_MAX = 50_000;
const launchBackoff = new FailureBackoff();
const graduationBackoff = new FailureBackoff();
const LOOKUP_CONCURRENCY = 4;
const POOL_RECHECK_MINUTES = 3;

/** Test hook. */
export function resetLaunchTimes(): void {
  launches.clear();
  graduations.clear();
  launchBackoff.clear();
  graduationBackoff.clear();
}

function remember<V>(map: Map<string, V>, mint: string, ms: V): void {
  if (!map.has(mint) && map.size >= CACHE_MAX) {
    // Oldest first (insertion order): the mints seen longest ago are the least likely to matter now.
    const drop = map.size - CACHE_MAX + 1 + Math.floor(CACHE_MAX / 10);
    let n = 0;
    for (const key of map.keys()) {
      if (n++ >= drop) break;
      map.delete(key);
    }
  }
  map.set(mint, ms);
}

const validMs = (d: Date | undefined): number | undefined => {
  const ms = d?.getTime();
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : undefined;
};

/** Seeds launch times the discovery lists already carry (Pump.fun's created_timestamp). */
export function rememberLaunchTimes(coins: ReadonlyArray<{ mintAddress: string; createdAt?: Date }>): void {
  for (const coin of coins) {
    const ms = validMs(coin.createdAt);
    if (ms !== undefined && launches.get(coin.mintAddress) == null) remember(launches, coin.mintAddress, ms);
  }
}

/** Seeds graduation times from the stream's migration events; the earliest seen for a mint stands. */
export function rememberGraduations(events: ReadonlyArray<{ mintAddress: string; at: Date }>): void {
  for (const e of events) {
    const ms = validMs(e.at);
    const known = graduations.get(e.mintAddress);
    if (ms !== undefined && (known === undefined || ms < known)) remember(graduations, e.mintAddress, ms);
  }
}

export interface PreBondCandidate {
  mintAddress: string;
  graduatedAt?: Date;
  dexId?: string;
  pairCreatedAt?: Date;
  buys24h?: number;
  sells24h?: number;
}

/**
 * A curve pair that has been bought and never sold: what DexScreener shows for a coin whose curve
 * a bundle filled in one go and that has traded only in its pool since. Any curve still trading
 * has sellers.
 */
function looksBoughtOut(c: PreBondCandidate): boolean {
  return c.dexId === "pumpfun" && (c.buys24h ?? 0) > 0 && c.sells24h === 0;
}

/**
 * Seconds on the curve for each graduated candidate whose two ends are known (after this cycle's
 * lookups). A mint missing from the result is unknown - or already known to clear the floor - and
 * passes the cut. `knownSince` is the earliest time the scanner knew of each mint (its watchlist
 * first-seen time), an upper bound on its launch.
 */
export async function resolvePreBondSeconds(
  candidates: ReadonlyArray<PreBondCandidate>,
  knownSince: ReadonlyMap<string, Date | undefined>,
  clients: {
    pumpFun: Pick<PumpFunClient, "launchTime">;
    dexScreener: Pick<DexScreenerClient, "pumpSwapGraduation">;
  },
  env: Pick<Env, "SAFETY_MIN_PREBOND_SECONDS" | "PREBOND_LOOKUPS_MAX_PER_CYCLE">,
  now = Date.now(),
): Promise<Map<string, number>> {
  const floorMs = env.SAFETY_MIN_PREBOND_SECONDS * 1000;
  if (floorMs <= 0) return new Map();
  let budget = env.PREBOND_LOOKUPS_MAX_PER_CYCLE;

  // A curve pair is created with the coin: its creation time is the launch.
  for (const c of candidates) {
    const ms = validMs(c.pairCreatedAt);
    if (c.dexId === "pumpfun" && ms !== undefined && launches.get(c.mintAddress) == null) {
      remember(launches, c.mintAddress, ms);
    }
  }

  const poolLookups = candidates
    .filter(
      (c) =>
        graduatedAt(c) === undefined && looksBoughtOut(c) && !graduationBackoff.blocked(c.mintAddress, now),
    )
    .slice(0, budget)
    .map((c) => c.mintAddress);
  budget -= poolLookups.length;
  let failed = 0;
  await forEachWithConcurrency(poolLookups, LOOKUP_CONCURRENCY, async (mint) => {
    try {
      const at = await clients.dexScreener.pumpSwapGraduation(mint);
      if (at) {
        remember(graduations, mint, at.getTime());
        graduationBackoff.succeed(mint);
      } else {
        // No pool listed: still on its curve, or a pool DexScreener hasn't indexed yet. Asked
        // again in a few minutes rather than settled for good.
        graduationBackoff.fail(mint, now, POOL_RECHECK_MINUTES);
      }
    } catch {
      failed += 1;
      graduationBackoff.fail(mint, now);
    }
  });

  const launchLookups: string[] = [];
  for (const c of candidates) {
    const grad = graduatedAt(c);
    if (grad === undefined || launches.has(c.mintAddress)) continue;
    const known = validMs(knownSince.get(c.mintAddress));
    if (known !== undefined && grad - known >= floorMs) continue;
    if (launchBackoff.blocked(c.mintAddress, now) || launchLookups.length >= budget) continue;
    launchLookups.push(c.mintAddress);
  }
  await forEachWithConcurrency(launchLookups, LOOKUP_CONCURRENCY, async (mint) => {
    try {
      const launched = await clients.pumpFun.launchTime(mint);
      remember(launches, mint, launched ? launched.getTime() : null);
      launchBackoff.succeed(mint);
    } catch {
      failed += 1;
      launchBackoff.fail(mint, now);
    }
  });
  launchBackoff.prune(now);
  graduationBackoff.prune(now);
  if (failed > 0) {
    logger.info("pre-bond lookups without an answer", {
      failed,
      asked: poolLookups.length + launchLookups.length,
    });
  }

  return knownPreBondSeconds(candidates);
}

const graduatedAt = (c: PreBondCandidate): number | undefined =>
  validMs(c.graduatedAt) ?? graduations.get(c.mintAddress);

/**
 * Seconds on the curve for each candidate whose launch and graduation are both already known in
 * this process - no lookup. What resolvePreBondSeconds answers from once its lookups are done.
 */
export function knownPreBondSeconds(candidates: ReadonlyArray<PreBondCandidate>): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of candidates) {
    const grad = graduatedAt(c);
    const launched = launches.get(c.mintAddress);
    if (grad !== undefined && typeof launched === "number") out.set(c.mintAddress, (grad - launched) / 1000);
  }
  return out;
}
