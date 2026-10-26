import {
  createLogger,
  withApiFeature,
  type CandidateToken,
  type LaunchQuoteSource,
} from "@trenchscanner/core";

const logger = createLogger("entry-watch");

/**
 * Of the curated band's floor, how close a young launch must be to be watched between cycles:
 * at 60% of $7k, a launch from $4.2k up.
 */
export const ENTRY_APPROACH_RATIO = 0.6;
/** One Jupiter call's worth (it takes 100 mints a call), the closest to the floor first. */
export const ENTRY_MAX_WATCHED = 100;
/**
 * Of that call, the most places the launches created since the last cycle take first (about 50
 * arrive in a one-minute cycle); the rest go to the launches approaching the floor.
 */
export const ENTRY_MAX_NEW = 50;
/**
 * How often the watch reads the curves: the curve tape's prices are free to read, so twice a
 * second, which lets ENTRY_DWELL_MS end within half a second of when it runs out (a check a
 * second, as the band wake had, made every dwell three seconds).
 */
export const ENTRY_CHECK_MS = 500;
/**
 * How long a launch must hold the floor before its first scan starts (user decision 2026-10-22):
 * every reading at or above it for this long, the first one under it starting the count over. A
 * launch that pokes over the floor on one trade and falls straight back is not worth a scan; one
 * that holds it for a few seconds is the climb the fast path exists for.
 */
export const ENTRY_DWELL_MS = 2_500;
/** How often Jupiter is asked, for the launches the curve tape can't price. */
export const ENTRY_QUOTE_MS = 5_000;
/** Coins the cycle read with a curve price, at least, before their median sets the dollar scale. */
export const ENTRY_MIN_CURVE_READINGS = 3;
/**
 * No Jupiter check this soon after the cycle that noted the launches: that cycle has just read
 * them, and the next check would only spend Jupiter's budget to learn the same thing.
 */
export const ENTRY_MIN_GAP_MS = 8_000;
/**
 * How long one check may wait on Jupiter. Past it the check gives up rather than queue behind the
 * cycle's own Jupiter reads, and those launches are read by the next check or the next cycle.
 */
export const ENTRY_READ_BUDGET_MS = 1_500;
/**
 * How long a launch handed to the fast path is remembered, so it is never handed again: the
 * cycle owns it after. Past the ten minutes a launch is watched for (LIVE_LAUNCH_MINUTES), with room.
 */
const HANDED_FORGET_MS = 60 * 60_000;

export interface EntryWatchStats {
  /** Jupiter checks, for the launches the curve tape can't price. */
  checks: number;
  /** Launches read at or above the floor after a reading under it (or none). */
  crossings: number;
  /** Of the crossings, launches created since the last cycle (the rest approached the floor). */
  newLaunchCrossings: number;
  /** Of the crossings, those the curve tape saw (the rest Jupiter did). */
  curveCrossings: number;
  /** Crossings that fell back under the floor before the dwell ran out. */
  dips: number;
  /** Launches that held the floor for the dwell, handed to the fast path. */
  entries: number;
}

const emptyStats = (): EntryWatchStats => ({
  checks: 0,
  crossings: 0,
  newLaunchCrossings: 0,
  curveCrossings: 0,
  dips: 0,
  entries: 0,
});

/**
 * Sees a young launch cross into the band between cycles, and hands it to the entry fast path
 * (entryFastPath.ts) once it has held the floor for ENTRY_DWELL_MS: that coin's first scan runs
 * then, alone, rather than a minute later with the next cycle.
 *
 * Until 2026-10-22 a crossing started a whole cycle early instead (#874, the band wake): every
 * cycle re-reads the whole band on per-cycle Helius budgets, and with a launch near the floor
 * almost always crossing the scan ran about 3.6 times a minute and Helius spend went to about 2.1M
 * credits a day (notes/audit-2026-10-22, C1). The user decided to scan the crossing coin alone and
 * put the cycle back to a minute (user decision 2026-10-22).
 *
 * The fastest launches climb from the floor to well past it inside one cycle (2026-10-12, first
 * hour after #403: launches first scanned in band a median 20 s after the crossing, at a median
 * $12.3k). Each cycle notes the young launches it priced just under the floor, and the watch reads
 * them between cycles, with the launches created since the last cycle (newLaunches, from the
 * PumpPortal stream and Jupiter's launch poller): over half the launches that reach the Stream
 * cross the floor in their first minute, before any cycle has priced them (2026-10-12 23:05-00:00:
 * 23 of 40, a median 33 s after creation).
 *
 * Every launch the curve tape follows, new ones included, is read off its curve at no cost (user
 * ask 2026-10-20, more speed): the cycle's market cap readings over the curves' prices give the
 * dollars per unit of curve price (SOL's price, as every Pump.fun coin has the same supply).
 * Jupiter is asked only about the launches the curve tape can't price, every ENTRY_QUOTE_MS.
 */
export class EntryWatch {
  private watched: string[] = [];
  /** Dollars of market cap per unit of curve price, from the last cycle's readings (null: unknown). */
  private mcapPerCurvePrice: number | null = null;
  private notedAt = 0;
  private askedAt = 0;
  /** When each launch was first read at or above the floor in its current run over it. */
  private readonly aboveSince = new Map<string, number>();
  /** Launches handed to the fast path, and when: never handed again. */
  private readonly handed = new Map<string, number>();
  private checking = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stats = emptyStats();

  constructor(
    private readonly source: LaunchQuoteSource,
    private readonly bandMin: number,
    /** The launches created since the last cycle, newest first (only ones known not to be Mayhem). */
    private readonly newLaunches: () => string[] = () => [],
    /** A launch's bonding-curve price now, from the curve tape (null: not followed or not current). */
    private readonly curvePrice: (mint: string, now: number) => number | null = () => null,
    /** A launch has held the floor for the dwell: `crossedAt` is its first reading at or over it. */
    private readonly onEntry: (mint: string, crossedAt: number) => void = () => {},
    /**
     * A launch has just read at or over the floor for the first time in its current run over it:
     * the dwell starts now. The worker asks TokenSage for the coin's quick read here
     * (prefetch.ts requestNarrativeRead), so the read is on its way before the fast path decides.
     * Called again only after a dip under the floor (a new crossing).
     */
    private readonly onCrossing: (mint: string) => void = () => {},
  ) {}

  /**
   * Checks every `everyMs` until stop(). A check still waiting on Jupiter skips the next. Its
   * Jupiter calls count as "entry-fast-path/watch" in the API usage panel.
   */
  start(everyMs = ENTRY_CHECK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void withApiFeature("entry-fast-path/watch", () => this.check()), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The young launches the cycle just priced, with the market caps it read: those approaching the
   * floor replace the watch list.
   */
  note(readings: Pick<CandidateToken, "mintAddress" | "marketCapUsd">[], now = Date.now()): void {
    const floor = this.bandMin * ENTRY_APPROACH_RATIO;
    const near = readings
      .filter((r) => r.marketCapUsd >= floor && r.marketCapUsd < this.bandMin)
      .sort((a, b) => b.marketCapUsd - a.marketCapUsd)
      .slice(0, ENTRY_MAX_WATCHED);
    this.watched = near.map((r) => r.mintAddress);
    // The median over every coin read: one stale quote can't move it.
    const scales = readings
      .flatMap((r) => {
        const price = this.curvePrice(r.mintAddress, now);
        return price && price > 0 && r.marketCapUsd > 0 ? [r.marketCapUsd / price] : [];
      })
      .sort((a, b) => a - b);
    if (scales.length >= ENTRY_MIN_CURVE_READINGS) this.mcapPerCurvePrice = scales[scales.length >> 1]!;
    this.notedAt = now;
    for (const [mint, at] of this.handed) if (now - at > HANDED_FORGET_MS) this.handed.delete(mint);
  }

  /** The curve tape's market cap for `mint` now, or null when it can't price it. */
  private curveMcap(mint: string, now: number): number | null {
    if (this.mcapPerCurvePrice === null) return null;
    const price = this.curvePrice(mint, now);
    return price === null ? null : price * this.mcapPerCurvePrice;
  }

  /**
   * One check: every watched and new launch read off its curve, Jupiter asked about the rest on
   * its own cadence, and each launch that has now held the floor for ENTRY_DWELL_MS handed to the
   * fast path. Returns the launches handed. Never rejects.
   */
  async check(now = Date.now()): Promise<string[]> {
    if (this.checking) return [];
    this.checking = true;
    try {
      return await this.read(now);
    } finally {
      this.checking = false;
    }
  }

  private async read(now: number): Promise<string[]> {
    const newLaunches = this.newLaunches();
    const fresh = new Set(newLaunches);
    const watching = [...new Set([...newLaunches, ...this.watched])].filter((m) => !this.handed.has(m));
    // A launch the watch no longer follows (the cycle read it, or it aged out) starts over.
    const following = new Set(watching);
    for (const mint of this.aboveSince.keys()) if (!following.has(mint)) this.aboveSince.delete(mint);

    const readings = new Map<string, { mcap: number; curve: boolean }>();
    for (const mint of watching) {
      const mcap = this.curveMcap(mint, now);
      if (mcap !== null) readings.set(mint, { mcap, curve: true });
    }
    if (now - this.notedAt >= ENTRY_MIN_GAP_MS && now - this.askedAt >= ENTRY_QUOTE_MS) {
      // Jupiter only for what the curve tape can't price.
      const unpriced = watching.filter((m) => !readings.has(m));
      const ask = [
        ...new Set([
          ...unpriced.filter((m) => fresh.has(m)).slice(0, ENTRY_MAX_NEW),
          ...unpriced.filter((m) => !fresh.has(m)),
        ]),
      ].slice(0, ENTRY_MAX_WATCHED);
      if (ask.length > 0) {
        this.askedAt = now;
        this.stats.checks += 1;
        const read = await this.source
          .getLaunches(ask, {
            timeoutMs: ENTRY_READ_BUDGET_MS,
            deadlineMs: ENTRY_READ_BUDGET_MS,
            retries: 0,
          })
          .catch((err: unknown) => {
            logger.warn("entry check failed - those launches wait for the next check", {
              error: String(err),
            });
            return [] as CandidateToken[];
          });
        for (const t of read) {
          if (!readings.has(t.mintAddress))
            readings.set(t.mintAddress, { mcap: t.marketCapUsd, curve: false });
        }
      }
    }

    const entered: string[] = [];
    for (const [mint, { mcap, curve }] of readings) {
      if (mcap < this.bandMin) {
        if (this.aboveSince.delete(mint)) this.stats.dips += 1;
        continue;
      }
      const since = this.aboveSince.get(mint);
      if (since === undefined) {
        this.aboveSince.set(mint, now);
        this.stats.crossings += 1;
        if (fresh.has(mint)) this.stats.newLaunchCrossings += 1;
        if (curve) this.stats.curveCrossings += 1;
        this.onCrossing(mint);
        continue;
      }
      // A launch Jupiter alone prices is read every ENTRY_QUOTE_MS, so its dwell is that long.
      if (now - since < ENTRY_DWELL_MS) continue;
      this.aboveSince.delete(mint);
      this.handed.set(mint, now);
      this.stats.entries += 1;
      entered.push(mint);
      this.onEntry(mint, since);
    }
    return entered;
  }

  /** Checks made and launches crossing and handed off since the last call, then reset. */
  takeStats(): EntryWatchStats {
    const stats = this.stats;
    this.stats = emptyStats();
    return stats;
  }
}
