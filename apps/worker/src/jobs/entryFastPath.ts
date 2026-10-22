import { createLogger } from "@trenchscanner/core";
import { claimForFastScan, releaseFastClaim, whenCycleReleases } from "./scanClaims.js";
import type { EntryScanResult } from "./scanJob.js";

const logger = createLogger("entry-fast-path");

/** The window ENTRY_FAST_PATH_MAX_PER_MINUTE is counted over. */
const CAP_WINDOW_MS = 60_000;
/**
 * The longest a fast scan waits for a cycle that holds its coin (scanClaims.ts). A cycle lets go
 * of its band within seconds of reading it; one that has not after this is stuck, and its coin
 * is the next cycle's.
 */
export const ENTRY_CYCLE_WAIT_MAX_MS = 30_000;

export interface EntryFastPathOptions {
  /** ENTRY_FAST_PATH_MAX_PER_MINUTE: fast scans started in any minute; the rest wait for the cycle. */
  maxPerMinute: number;
  /** Whether the coin may still have one: not known to be Mayhem (mayhemMode.ts's knownNotMayhem). */
  eligible: (mint: string) => boolean;
  /** The scan itself (scanJob.ts's runEntryScan). */
  scan: (mint: string) => Promise<EntryScanResult>;
  now?: () => number;
}

export interface EntryFastPathStats {
  /** Coins handed over by the entry watch. */
  offered: number;
  /** First scans run, and of them the coins a model called, and the ones that read out of band. */
  fastScans: number;
  called: number;
  notInBand: number;
  /** Turned away: over the minute's cap, no longer eligible (Mayhem), another scan holding the coin. */
  skippedByCap: number;
  skippedMayhem: number;
  skippedBusy: number;
  /** Waited for a cycle reading the coin, and of them the ones that gave up waiting. */
  waitedOnCycle: number;
  cycleWaitTimedOut: number;
  /** No watchlist row to scan (not recorded yet), or set aside. */
  noRow: number;
  failed: number;
  /** From the first reading at or over the floor to the end of the coin's scan: its decision. */
  crossToDecisionMsMedian?: number;
  crossToDecisionMsMax?: number;
  /** The same, for the coins a model called. */
  crossToCallMsMedian?: number;
}

const emptyStats = (): EntryFastPathStats => ({
  offered: 0,
  fastScans: 0,
  called: 0,
  notInBand: 0,
  skippedByCap: 0,
  skippedMayhem: 0,
  skippedBusy: 0,
  waitedOnCycle: 0,
  cycleWaitTimedOut: 0,
  noRow: 0,
  failed: 0,
});

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/**
 * The entry fast path (user decision 2026-10-22): a young launch that has held the band's floor
 * for the entry watch's dwell (entryWatch.ts) gets its first scan now, alone, through the cycle's
 * own stages (scanJob.ts's runEntryScan), so it can be called within seconds of crossing instead of
 * up to a minute later with the next cycle. It replaced the band wake, which started a whole cycle
 * early for each crossing and so spent the cycle's per-cycle Helius budgets three or four times a
 * minute (notes/audit-2026-10-22, C1).
 *
 * Each coin gets one: the watch never hands a coin over twice, and the cycle owns it after. One
 * scan per coin at a time, and never one alongside a cycle deciding on the same coin
 * (scanClaims.ts). At most maxPerMinute start in any minute; a coin over the cap waits for the
 * cycle like any other. The scans' outside calls count under their own feature in the API usage
 * panel ("entry-fast-path"), and their counts ride on the scan's heartbeat (/health/worker's
 * entryFastPath).
 */
export class EntryFastPath {
  private started: number[] = [];
  private stats = emptyStats();
  private decisionMs: number[] = [];
  private callMs: number[] = [];
  private readonly running = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly options: EntryFastPathOptions) {
    this.now = options.now ?? Date.now;
  }

  /** A coin has held the floor since `crossedAt`: its first scan now, if it may have one. Never rejects. */
  offer(mint: string, crossedAt: number): Promise<void> {
    const work = this.run(mint, crossedAt).catch((err: unknown) => {
      this.stats.failed += 1;
      logger.warn("entry fast scan failed - the coin waits for the cycle", { mint, error: String(err) });
    });
    this.running.add(work);
    void work.finally(() => this.running.delete(work));
    return work;
  }

  private async run(mint: string, crossedAt: number): Promise<void> {
    this.stats.offered += 1;
    if (!this.options.eligible(mint)) {
      this.stats.skippedMayhem += 1;
      return;
    }
    const now = this.now();
    this.started = this.started.filter((at) => now - at < CAP_WINDOW_MS);
    if (this.started.length >= this.options.maxPerMinute) {
      this.stats.skippedByCap += 1;
      return;
    }
    // Counted when it starts, waiting on a cycle included: the cap bounds the scans asked for.
    this.started.push(now);
    let claim = claimForFastScan(mint);
    if (claim === "cycle") {
      this.stats.waitedOnCycle += 1;
      if (!(await whenCycleReleases(mint, ENTRY_CYCLE_WAIT_MAX_MS))) {
        this.stats.cycleWaitTimedOut += 1;
        return;
      }
      if (!this.options.eligible(mint)) {
        this.stats.skippedMayhem += 1;
        return;
      }
      claim = claimForFastScan(mint);
    }
    if (claim !== "ok") {
      this.stats.skippedBusy += 1;
      return;
    }
    try {
      const result = await this.options.scan(mint);
      if (result.skipped === "noRow" || result.skipped === "ignored") {
        this.stats.noRow += 1;
        return;
      }
      this.stats.fastScans += 1;
      if (result.skipped) {
        this.stats.notInBand += 1;
        return;
      }
      const ms = this.now() - crossedAt;
      this.decisionMs.push(ms);
      if (result.called > 0) {
        this.stats.called += 1;
        this.callMs.push(ms);
      }
    } finally {
      releaseFastClaim(mint);
    }
  }

  /** Waits for the scans in flight, up to `ms`. For shutdown and tests. */
  async settle(ms = Infinity): Promise<void> {
    if (this.running.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      if (Number.isFinite(ms)) timer = setTimeout(resolve, ms);
    });
    await Promise.race([Promise.all([...this.running]), timeout]);
    clearTimeout(timer);
  }

  /** What the fast path did since the last call, then reset. */
  takeStats(): EntryFastPathStats {
    const stats: EntryFastPathStats = { ...this.stats };
    const decision = median(this.decisionMs);
    if (decision !== undefined) {
      stats.crossToDecisionMsMedian = decision;
      stats.crossToDecisionMsMax = Math.max(...this.decisionMs);
    }
    const call = median(this.callMs);
    if (call !== undefined) stats.crossToCallMsMedian = call;
    this.stats = emptyStats();
    this.decisionMs = [];
    this.callMs = [];
    return stats;
  }
}
