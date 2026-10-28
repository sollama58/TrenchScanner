import {
  createLogger,
  deriveGraduated,
  forEachWithConcurrency,
  isCurveVenue,
  STONKS_LAUNCHPAD,
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
/** Mints whose launch time is being asked for, or written to the Token row, right now. */
const launchLookupsInFlight = new Set<string>();
/** Mints whose launch time this process has written to the Token row (never twice). */
const launchesStored = new Set<string>();

/** Test hook. */
export function resetLaunchTimes(): void {
  launches.clear();
  preBondInFlight.clear();
  graduations.clear();
  launchBackoff.clear();
  graduationBackoff.clear();
  launchLookupsInFlight.clear();
  launchesStored.clear();
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
 * first-seen time), an upper bound on its launch. Waits for the lookups; the scan cycle starts
 * them with startPreBondLookups instead and goes on without them.
 */
export async function resolvePreBondSeconds(
  candidates: ReadonlyArray<PreBondCandidate>,
  knownSince: ReadonlyMap<string, Date | undefined>,
  clients: PreBondClients,
  env: Pick<Env, "SAFETY_MIN_PREBOND_SECONDS" | "PREBOND_LOOKUPS_MAX_PER_CYCLE">,
  now = Date.now(),
): Promise<Map<string, number>> {
  const { pending } = startPreBondLookups(candidates, knownSince, clients, env, now);
  await pending;
  return env.SAFETY_MIN_PREBOND_SECONDS * 1000 > 0 ? knownPreBondSeconds(candidates) : new Map();
}

export interface PreBondClients {
  pumpFun: Pick<PumpFunClient, "launchTime">;
  dexScreener: Pick<DexScreenerClient, "pumpSwapGraduation">;
}

/** Mints whose pre-bond lookups (graduation, then launch) are running now, possibly past a cycle. */
const preBondInFlight = new Set<string>();

/**
 * Whether a mint's pre-bond lookups are still running: the cut can't read it yet, so the scan
 * holds the coin's decision (and its training rows) until they land rather than decide without
 * the cut (scanJob.ts processCandidate, the `preBondWait` hold).
 */
export function preBondLookupPending(mintAddress: string): boolean {
  return preBondInFlight.has(mintAddress);
}

/**
 * The pre-bond cut's lookups for this cycle, started BEHIND the cycle: `known` is what this
 * process can already answer (knownPreBondSeconds), and the lookups' answers land in memory for the
 * next cycle to read. Until then preBondLookupPending holds just those coins.
 *
 * Awaited inside the cycle until 2026-10-28, ahead of every decision: DexScreener's per-token pairs
 * lookup queues behind its shared rate budget (about 6-8 s a request at the time), so a cycle with
 * one bought-out curve to ask about spent a median 14 s, up to 22 s, in this stage, and every
 * contender waited for one or two coins' answer (preBond on the scan heartbeat, 40% of cycles).
 *
 * Per mint: a curve that looks bought out with no graduation known asks DexScreener for its pool
 * (looksBoughtOut), then Pump.fun for its launch if the cut still needs it; a graduated mint whose
 * launch is unknown and not known to clear the floor asks Pump.fun. Up to
 * PREBOND_LOOKUPS_MAX_PER_CYCLE lookups start a cycle, and a mint already being asked isn't asked
 * again.
 */
export function startPreBondLookups(
  candidates: ReadonlyArray<PreBondCandidate>,
  knownSince: ReadonlyMap<string, Date | undefined>,
  clients: PreBondClients,
  env: Pick<Env, "SAFETY_MIN_PREBOND_SECONDS" | "PREBOND_LOOKUPS_MAX_PER_CYCLE">,
  now = Date.now(),
): { known: Map<string, number>; pending: Promise<void> } {
  const floorMs = env.SAFETY_MIN_PREBOND_SECONDS * 1000;
  if (floorMs <= 0) return { known: new Map(), pending: Promise.resolve() };
  let budget = env.PREBOND_LOOKUPS_MAX_PER_CYCLE;

  // A curve pair is created with the coin: its creation time is the launch.
  for (const c of candidates) {
    const ms = validMs(c.pairCreatedAt);
    if (isCurveVenue(c.dexId) && ms !== undefined && launches.get(c.mintAddress) == null) {
      remember(launches, c.mintAddress, ms);
    }
  }

  // Whether the cut still needs a launch time asked of Pump.fun for this mint (graduation known).
  const needsLaunch = (c: PreBondCandidate, grad: number | undefined): boolean => {
    if (grad === undefined || launches.has(c.mintAddress)) return false;
    const known = validMs(knownSince.get(c.mintAddress));
    if (known !== undefined && grad - known >= floorMs) return false;
    // One already being asked by resolveLaunchTimes is answered there: asking twice spent Pump.fun calls.
    return !launchLookupsInFlight.has(c.mintAddress) && !launchBackoff.blocked(c.mintAddress, now);
  };

  const poolLookups = candidates
    .filter(
      (c) =>
        !preBondInFlight.has(c.mintAddress) &&
        graduatedAt(c) === undefined &&
        looksBoughtOut(c) &&
        !graduationBackoff.blocked(c.mintAddress, now),
    )
    .slice(0, budget);
  budget -= poolLookups.length;
  const launchLookups: PreBondCandidate[] = [];
  for (const c of candidates) {
    if (launchLookups.length >= budget) break;
    if (!preBondInFlight.has(c.mintAddress) && needsLaunch(c, graduatedAt(c))) launchLookups.push(c);
  }

  let failed = 0;
  const askLaunch = async (mint: string): Promise<void> => {
    launchLookupsInFlight.add(mint);
    try {
      const launched = await clients.pumpFun.launchTime(mint);
      remember(launches, mint, launched ? launched.getTime() : null);
      launchBackoff.succeed(mint);
    } catch {
      failed += 1;
      launchBackoff.fail(mint, now);
    } finally {
      launchLookupsInFlight.delete(mint);
    }
  };
  const askPool = async (c: PreBondCandidate): Promise<void> => {
    try {
      const at = await clients.dexScreener.pumpSwapGraduation(c.mintAddress);
      if (at) {
        remember(graduations, c.mintAddress, at.getTime());
        graduationBackoff.succeed(c.mintAddress);
      } else {
        // No pool listed: still on its curve, or a pool DexScreener hasn't indexed yet. Asked
        // again in a few minutes rather than settled for good.
        graduationBackoff.fail(c.mintAddress, now, POOL_RECHECK_MINUTES);
      }
    } catch {
      failed += 1;
      graduationBackoff.fail(c.mintAddress, now);
    }
    // The pool's answer can leave the cut needing the launch end too: asked now, so the coin is
    // held for one round of lookups, not two cycles.
    if (needsLaunch(c, graduatedAt(c))) await askLaunch(c.mintAddress);
  };

  const work: Array<() => Promise<void>> = [
    ...poolLookups.map((c) => () => askPool(c)),
    ...launchLookups.map((c) => () => askLaunch(c.mintAddress)),
  ];
  const asked = [...poolLookups, ...launchLookups].map((c) => c.mintAddress);
  for (const mint of asked) preBondInFlight.add(mint);
  const known = knownPreBondSeconds(candidates);
  if (work.length === 0) return { known, pending: Promise.resolve() };
  const pending = forEachWithConcurrency(work, LOOKUP_CONCURRENCY, (run) => run())
    .catch((err: unknown) => logger.warn("pre-bond lookups failed", { error: String(err) }))
    .finally(() => {
      for (const mint of asked) preBondInFlight.delete(mint);
      launchBackoff.prune(now);
      graduationBackoff.prune(now);
      if (failed > 0) logger.info("pre-bond lookups without an answer", { failed, asked: asked.length });
    });
  return { known, pending };
}

const graduatedAt = (c: PreBondCandidate): number | undefined =>
  validMs(c.graduatedAt) ?? graduations.get(c.mintAddress);

export interface LaunchTimeCandidate {
  mintAddress: string;
  dexId?: string;
  pairCreatedAt?: Date;
  launchpad?: string;
}

/**
 * When each candidate launched, for the token's age (processCandidate's ageMinutes, and the
 * ageSource input): the launch time a source has said, from the Token row (`stored`,
 * Token.launchedAt) or this process (discovery lists, the curve pair, earlier lookups). A mint
 * missing from the result has none known, and its age counts from the earliest anchor the scan
 * has - on a coin first met after graduation, its PumpSwap pool.
 *
 * A graduated Pump.fun coin nobody has a launch time for is asked of Pump.fun once, BEHIND the
 * cycle: the lookups start here and the cycle goes on without them, the answer lands on the Token
 * row (`store`) and in memory, and the next scan reads it. The scan loop's stages are on a
 * budget each, and a 5-second Pump.fun call per graduate would come out of the decisions'; a
 * one-cycle wait on the first sighting is the cost of keeping it off that path. Up to
 * LAUNCH_TIME_LOOKUPS_MAX_PER_CYCLE start per cycle; a failed lookup backs off like the pre-bond
 * cut's (never cached), and Pump.fun's "no such coin" is kept for the process so a coin it never
 * launched costs one call per restart. A launch time known here but not yet on the row (one the
 * discovery lists said, on a row from before the column) is written once as well, so a restart
 * reads it back.
 */
export function resolveLaunchTimes(
  candidates: ReadonlyArray<LaunchTimeCandidate>,
  stored: ReadonlyMap<string, Date | null | undefined>,
  clients: { pumpFun: Pick<PumpFunClient, "launchTime"> },
  env: Pick<Env, "LAUNCH_TIME_LOOKUPS_MAX_PER_CYCLE">,
  store: (mintAddress: string, launchedAt: Date) => Promise<unknown>,
  now = Date.now(),
): { known: Map<string, Date>; pending: Promise<void> } {
  const known = new Map<string, Date>();
  const writes: Promise<unknown>[] = [];
  const keep = (mint: string, launchedAt: Date): void => {
    if (launchLookupsInFlight.has(mint) || launchesStored.has(mint)) return;
    launchLookupsInFlight.add(mint);
    writes.push(
      store(mint, launchedAt)
        .then(() => launchesStored.add(mint))
        .catch((err: unknown) => logger.warn("failed to record a launch time", { mint, error: String(err) }))
        .finally(() => launchLookupsInFlight.delete(mint)),
    );
  };

  const lookups: string[] = [];
  for (const c of candidates) {
    const mint = c.mintAddress;
    // The row's answer and the curve pair's seed memory, as the discovery lists do.
    const onRow = validMs(stored.get(mint) ?? undefined);
    if (onRow !== undefined && launches.get(mint) == null) remember(launches, mint, onRow);
    const curveMs = validMs(c.pairCreatedAt);
    if (isCurveVenue(c.dexId) && curveMs !== undefined && launches.get(mint) == null) {
      remember(launches, mint, curveMs);
    }
    const launched = launches.get(mint);
    if (typeof launched === "number") {
      known.set(mint, new Date(launched));
      if (onRow === undefined) keep(mint, new Date(launched));
      continue;
    }
    // Only a graduated Pump.fun coin: on its curve the pair says, and Pump.fun has no answer for
    // another launchpad's coin. A null in memory is Pump.fun's own "no such coin".
    if (launched === null || deriveGraduated(c.dexId) !== true || c.launchpad === STONKS_LAUNCHPAD) continue;
    if (launchLookupsInFlight.has(mint) || launchBackoff.blocked(mint, now)) continue;
    if (lookups.length >= env.LAUNCH_TIME_LOOKUPS_MAX_PER_CYCLE) continue;
    lookups.push(mint);
  }

  for (const mint of lookups) launchLookupsInFlight.add(mint);
  const pending = forEachWithConcurrency(lookups, LOOKUP_CONCURRENCY, async (mint) => {
    try {
      const launched = await clients.pumpFun.launchTime(mint);
      remember(launches, mint, launched ? launched.getTime() : null);
      launchBackoff.succeed(mint);
      if (launched) {
        await store(mint, launched)
          .then(() => launchesStored.add(mint))
          .catch((err: unknown) =>
            logger.warn("failed to record a launch time", { mint, error: String(err) }),
          );
      }
    } catch {
      launchBackoff.fail(mint, now);
    } finally {
      launchLookupsInFlight.delete(mint);
    }
  })
    .then(() => Promise.all(writes))
    .then(() => {
      launchBackoff.prune(now);
      if (lookups.length > 0) logger.debug("launch time lookups done", { asked: lookups.length });
    });
  return { known, pending };
}

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
