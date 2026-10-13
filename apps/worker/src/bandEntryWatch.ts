import { createLogger, type CandidateToken, type LaunchQuoteSource } from "@trenchscanner/core";

const logger = createLogger("band-entry-watch");

/**
 * Of the curated band's floor, how close a young launch must be to be watched between cycles:
 * at 60% of $10k, a launch from $6k up.
 */
export const BAND_ENTRY_APPROACH_RATIO = 0.6;
/** One Jupiter call's worth (it takes 100 mints a call), the closest to the floor first. */
export const BAND_ENTRY_MAX_WATCHED = 100;
/**
 * Of that call, the most places the launches created since the last cycle take first (about 25
 * arrive in a 30 s cycle); the rest go to the launches approaching the floor.
 */
export const BAND_ENTRY_MAX_NEW = 50;
/** How often the scan's scheduler asks whether a watched launch has crossed. */
export const BAND_ENTRY_CHECK_MS = 5_000;
/**
 * No check this soon after the cycle that noted the launches: that cycle has just read them, and
 * the next check would only spend Jupiter's budget to learn the same thing.
 */
export const BAND_ENTRY_MIN_GAP_MS = 8_000;
/**
 * How long one check may wait on Jupiter. Past it the check gives up rather than queue behind the
 * cycle's own Jupiter reads, and the scan runs on its ordinary cadence.
 */
export const BAND_ENTRY_READ_BUDGET_MS = 1_500;

export interface BandEntryWatchStats {
  checks: number;
  wakes: number;
  /** Of the wakes, those for a launch created since the last cycle (the rest approached the floor). */
  newLaunchWakes: number;
}

const emptyStats = (): BandEntryWatchStats => ({ checks: 0, wakes: 0, newLaunchWakes: 0 });

/**
 * Starts the scan early when a young launch crosses into the band between cycles.
 *
 * The scan runs every 30 s, and the fastest launches climb from $10k to $13k+ inside one cycle
 * (2026-10-12, first hour after #403: launches first scanned in band a median 20 s after the
 * crossing, at a median $12.3k). Each cycle notes the young launches it priced just under the
 * floor; between cycles the scheduler asks this every few seconds, one Jupiter call for all of
 * them, and the first one past the floor starts the next cycle at once - so it is screened, and
 * reaches the Stream and the models, within seconds of crossing rather than up to a cycle later.
 *
 * The same call also asks about the launches created since the last cycle (newLaunches, from the
 * PumpPortal stream). Over half the launches that reach the Stream cross $10k in their first
 * minute, before any cycle has priced them (2026-10-12 23:05-00:00: 23 of 40, entering the Stream
 * at a median $13.3k, a median 33 s after creation); they are otherwise first read by the next
 * cycle.
 */
export class BandEntryWatch {
  private watched: string[] = [];
  private notedAt = 0;
  private stats = emptyStats();

  constructor(
    private readonly source: LaunchQuoteSource,
    private readonly bandMin: number,
    /** The launches created since the last cycle, newest first. */
    private readonly newLaunches: () => string[] = () => [],
  ) {}

  /**
   * The young launches the cycle just priced, with the market caps it read: those approaching the
   * floor replace the watch list.
   */
  note(readings: Pick<CandidateToken, "mintAddress" | "marketCapUsd">[], now = Date.now()): void {
    const floor = this.bandMin * BAND_ENTRY_APPROACH_RATIO;
    this.watched = readings
      .filter((r) => r.marketCapUsd >= floor && r.marketCapUsd < this.bandMin)
      .sort((a, b) => b.marketCapUsd - a.marketCapUsd)
      .slice(0, BAND_ENTRY_MAX_WATCHED)
      .map((r) => r.mintAddress);
    this.notedAt = now;
  }

  /** Whether a watched launch has crossed the floor since the last cycle: start the scan now. */
  async due(now = Date.now()): Promise<boolean> {
    if (now - this.notedAt < BAND_ENTRY_MIN_GAP_MS) return false;
    const fresh = new Set(this.newLaunches().slice(0, BAND_ENTRY_MAX_NEW));
    const ask = [...new Set([...fresh, ...this.watched])].slice(0, BAND_ENTRY_MAX_WATCHED);
    if (ask.length === 0) return false;
    this.stats.checks += 1;
    const read = await this.source
      .getLaunches(ask, {
        timeoutMs: BAND_ENTRY_READ_BUDGET_MS,
        deadlineMs: BAND_ENTRY_READ_BUDGET_MS,
        retries: 0,
      })
      .catch((err: unknown) => {
        logger.warn("band entry check failed - the scan keeps its cadence", { error: String(err) });
        return [] as CandidateToken[];
      });
    const crossed = read.filter((t) => t.marketCapUsd >= this.bandMin);
    if (crossed.length === 0) return false;
    // Read again by the cycle this starts, which notes a fresh list (and drains the new launches).
    this.watched = [];
    this.stats.wakes += 1;
    if (crossed.some((t) => fresh.has(t.mintAddress))) this.stats.newLaunchWakes += 1;
    return true;
  }

  /** Checks made and early cycles started since the last call, then reset. */
  takeStats(): BandEntryWatchStats {
    const stats = this.stats;
    this.stats = emptyStats();
    return stats;
  }
}
