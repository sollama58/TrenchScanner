/**
 * Which coins the scan is reading right now, and for whom: the full cycle, or the entry fast path's
 * first scan of one coin (entryFastPath.ts). The two must never read and decide the same coin at
 * the same time - each writes the coin's snapshot, files its decision moment and can send its
 * call, and two passes side by side could each send one.
 *
 * Whoever claims a coin first has it. The cycle claims its whole band once its market refresh
 * has answered, less any coin a fast scan holds then (that coin's first scan is under way, and is
 * the reading this moment gets); the fast path claims one coin before it starts, and waits out a
 * cycle holding it (whenCycleReleases): the cycle's band takes a little under the floor too, so a
 * coin the cycle read just under it can cross while the cycle is still deciding on that reading.
 * Both claims are synchronous, so in this one process a coin can never end up claimed by both.
 */

/**
 * One set per cycle holding claims: normally one, but a cycle abandoned past its deadline keeps
 * running beside the next, and each gives back only its own.
 */
const cycleClaims = new Set<Set<string>>();
const fastClaims = new Set<string>();
/** Fast scans waiting for a cycle to let go of their coin, each checked when a cycle releases. */
const releaseWaiters = new Set<() => void>();

function cycleHolds(mint: string): boolean {
  for (const held of cycleClaims) if (held.has(mint)) return true;
  return false;
}

export interface CycleClaim {
  /** The cycle's band, less the coins a fast scan holds now; the rest are held for this cycle. */
  claim<T extends { mintAddress: string }>(candidates: T[]): T[];
  /** The cycle is done with its band (or stopped early): its coins are free again. */
  release(): void;
}

/** A cycle's claim on the coins it reads, empty until it claims its band. */
export function cycleClaim(): CycleClaim {
  const held = new Set<string>();
  return {
    claim(candidates) {
      const kept = candidates.filter((c) => !fastClaims.has(c.mintAddress));
      held.clear();
      for (const c of kept) held.add(c.mintAddress);
      cycleClaims.add(held);
      return kept;
    },
    release() {
      cycleClaims.delete(held);
      for (const waiter of [...releaseWaiters]) waiter();
    },
  };
}

/**
 * Takes one coin for a fast scan. "cycle": a full cycle is reading it now; "busy": another fast
 * scan already holds it. Only "ok" claims it, to be given back with releaseFastClaim.
 */
export function claimForFastScan(mint: string): "ok" | "cycle" | "busy" {
  if (cycleHolds(mint)) return "cycle";
  if (fastClaims.has(mint)) return "busy";
  fastClaims.add(mint);
  return "ok";
}

export function releaseFastClaim(mint: string): void {
  fastClaims.delete(mint);
}

/**
 * Resolves true once no cycle holds `mint` (at once if none does), or false after `maxMs`: a cycle
 * abandoned past its deadline may never let go.
 */
export function whenCycleReleases(mint: string, maxMs: number): Promise<boolean> {
  if (!cycleHolds(mint)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (released: boolean) => {
      releaseWaiters.delete(waiter);
      clearTimeout(timer);
      resolve(released);
    };
    const waiter = () => {
      if (!cycleHolds(mint)) done(true);
    };
    const timer = setTimeout(() => done(false), maxMs);
    timer.unref?.();
    releaseWaiters.add(waiter);
  });
}

/** Tests only. */
export function resetScanClaims(): void {
  cycleClaims.clear();
  fastClaims.clear();
  releaseWaiters.clear();
}
