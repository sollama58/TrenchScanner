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
  /**
   * The hold for TokenSage's quick read (user decision 2026-10-26): before its scan, a coin waits
   * until `settled` says TokenSage has answered for it, or `maxMs` has passed, checking every
   * `pollMs` and calling `poll` between checks (the prefetcher's flush, which stores a finished
   * read). Absent, or with maxMs 0, no coin waits. A coin whose read is already in never waits.
   */
  readHold?: EntryReadHold;
  now?: () => number;
  /** The wait between hold checks; real time by default, a fake in tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface EntryReadHold {
  maxMs: number;
  pollMs: number;
  settled: (mint: string) => boolean;
  poll?: () => void | Promise<void>;
  /**
   * Stand down once this many holds in a row ended with no read (default
   * ENTRY_READ_HOLD_STAND_DOWN_AFTER): TokenSage is not answering, so holding every coin would
   * only cost each one 20 s for nothing (2026-10-26: with nine of twelve analyzer slots dead, a
   * quick read took minutes). While stood down, coins scan at once, except one probe every
   * `probeMs` (default ENTRY_READ_HOLD_PROBE_MS) that is held as usual; a probe whose read
   * arrives ends the stand-down. 0 never stands down.
   */
  standDownAfter?: number;
  probeMs?: number;
}

/** How often a held coin checks for its read when the hold names no cadence. */
export const ENTRY_READ_HOLD_POLL_MS = 2_000;
/** Holds that ended with no read, in a row, before the hold stands down (EntryReadHold). */
export const ENTRY_READ_HOLD_STAND_DOWN_AFTER = 10;
/** While stood down, how often one coin is held anyway to see whether TokenSage answers again. */
export const ENTRY_READ_HOLD_PROBE_MS = 60_000;

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
  /** Coins that waited for TokenSage's read, and how each wait ended: the read came, or the cap ran out. */
  held: number;
  holdReadArrived: number;
  holdTimedOut: number;
  /**
   * Coins that went straight to their scan because the hold had stood down (EntryReadHold
   * standDownAfter), and whether it is stood down now (1) or holding (0).
   */
  holdStoodDown: number;
  holdStandingDown: 0 | 1;
  /** How long the held coins waited. */
  holdMsMedian?: number;
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
  held: 0,
  holdReadArrived: 0,
  holdTimedOut: 0,
  holdStoodDown: 0,
  holdStandingDown: 0,
});

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
 * The fast scan decides on the coin but banks no decision moment or training row (processCandidate
 * in scanJob.ts): the coin's moments stay the cycle's, on their old schedule, so the inputs that
 * land in its first minute (TokenSage's read, the curve tape) still reach a decision.
 *
 * Before its scan a coin waits for TokenSage's quick read, up to ENTRY_READ_HOLD_SECONDS (user
 * decision 2026-10-26; EntryReadHold): the read is asked for at the crossing (entryWatch.ts
 * onCrossing) and lands a median 8 s after a decision made without it, so with no hold 18% of
 * fast-path decisions carried it and with a 20 s cap about two thirds do, at a median 1.02x on
 * the entry price (notes/model-audit-2026-10-26, section 7). The scan runs on the coin as it is
 * after the wait, so a launch that collapsed meanwhile fails the pre-gate. The hold stands down
 * while TokenSage is not answering (ten holds in a row with no read) and probes once a minute, so
 * a TokenSage outage costs the fast path nothing but the read (EntryReadHold).
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
  private holdMs: number[] = [];
  /** Holds in a row that ended with no read; reset by one that got its read. */
  private holdMisses = 0;
  /** The last coin held while stood down (the probe), so one goes every probeMs. */
  private probedAt = -Infinity;
  /**
   * When the hold last polled, for every held coin at once: each coin checks on its own cadence,
   * but the poll (a prefetcher flush, which re-sends everything queued to TokenSage) runs at most
   * once per pollMs however many coins are waiting. Before this, five coins held at once ran a
   * flush every 400 ms, each up to four batches: past TokenSage's 60 requests a minute, whose 429
   * paused every read for a minute and so timed out every hold behind it.
   */
  private lastPollAt = -Infinity;
  private readonly running = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: EntryFastPathOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
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
    // The hold comes before the claim, so a cycle that reaches the coin meanwhile is not kept
    // waiting on a scan that has not started. The scan after the hold reads the coin as it is
    // then, so a launch that collapsed during the wait fails the pre-gate it would have passed.
    await this.holdForRead(mint);
    if (!this.options.eligible(mint)) {
      this.stats.skippedMayhem += 1;
      return;
    }
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

  /**
   * Waits for TokenSage's quick read on the coin, up to the hold's cap - see EntryReadHold. A coin
   * whose read is already in (or that TokenSage has given up on) goes straight on, and so does
   * every coin but a periodic probe while the hold is stood down.
   */
  private async holdForRead(mint: string): Promise<void> {
    const hold = this.options.readHold;
    if (hold === undefined || !(hold.maxMs > 0) || hold.settled(mint)) return;
    const startedAt = this.now();
    if (this.standingDown()) {
      const probeMs = hold.probeMs ?? ENTRY_READ_HOLD_PROBE_MS;
      if (startedAt - this.probedAt < probeMs) {
        this.stats.holdStoodDown += 1;
        return;
      }
      this.probedAt = startedAt;
    }
    this.stats.held += 1;
    const pollMs = hold.pollMs > 0 ? hold.pollMs : ENTRY_READ_HOLD_POLL_MS;
    for (;;) {
      const waited = this.now() - startedAt;
      if (waited >= hold.maxMs) {
        this.stats.holdTimedOut += 1;
        this.holdMisses += 1;
        this.holdMs.push(waited);
        if (this.holdMisses === this.standDownAfter()) {
          // From now coins go straight to their scan; the first probe is a probeMs away.
          this.probedAt = this.now();
          logger.warn("entry read hold: no read arrived for the last holds; standing down", {
            misses: this.holdMisses,
            probeEveryMs: hold.probeMs ?? ENTRY_READ_HOLD_PROBE_MS,
          });
        }
        return;
      }
      await this.sleep(Math.min(pollMs, hold.maxMs - waited));
      if (hold.poll && this.now() - this.lastPollAt >= pollMs) {
        this.lastPollAt = this.now();
        try {
          await hold.poll();
        } catch (err) {
          logger.warn("entry read hold: poll failed", { mint, error: String(err) });
        }
      }
      if (hold.settled(mint)) {
        this.stats.holdReadArrived += 1;
        if (this.holdMisses >= this.standDownAfter()) {
          logger.info("entry read hold: TokenSage answers again; holding every coin", {
            missesBefore: this.holdMisses,
          });
        }
        this.holdMisses = 0;
        this.holdMs.push(this.now() - startedAt);
        return;
      }
    }
  }

  private standDownAfter(): number {
    return this.options.readHold?.standDownAfter ?? ENTRY_READ_HOLD_STAND_DOWN_AFTER;
  }

  /** Whether the last standDownAfter holds all ended with no read. */
  private standingDown(): boolean {
    const after = this.standDownAfter();
    return after > 0 && this.holdMisses >= after;
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
    const hold = median(this.holdMs);
    if (hold !== undefined) stats.holdMsMedian = hold;
    stats.holdStandingDown = this.standingDown() ? 1 : 0;
    this.stats = emptyStats();
    this.decisionMs = [];
    this.callMs = [];
    this.holdMs = [];
    return stats;
  }
}
