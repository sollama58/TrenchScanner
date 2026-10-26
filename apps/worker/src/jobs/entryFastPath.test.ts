import { afterEach, describe, expect, it } from "vitest";
import { EntryFastPath, type EntryFastPathOptions, type EntryReadHold } from "./entryFastPath.js";
import { claimForFastScan, cycleClaim, releaseFastClaim, resetScanClaims } from "./scanClaims.js";
import type { EntryScanResult } from "./scanJob.js";

const decided: EntryScanResult = { called: 0, matches: 0, stagesMs: {} };

/** A scan that waits until released, so a test can look at what overlaps it. */
function heldScan() {
  const started: string[] = [];
  const releases = new Map<string, (r: EntryScanResult) => void>();
  return {
    started,
    scan: (mint: string) =>
      new Promise<EntryScanResult>((resolve) => {
        started.push(mint);
        releases.set(mint, resolve);
      }),
    release: (mint: string, result: EntryScanResult = decided) => releases.get(mint)?.(result),
  };
}

function fastPath(
  options: Partial<EntryFastPathOptions> & Pick<EntryFastPathOptions, "scan">,
  now = () => 0,
) {
  return new EntryFastPath({ maxPerMinute: 30, eligible: () => true, now, ...options });
}

/** Lets the promises queued so far run. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => resetScanClaims());

describe("EntryFastPath", () => {
  it("scans each offered coin and reports how long it took from the crossing to its decision", async () => {
    let clock = 10_000;
    const path = fastPath(
      {
        scan: async (mint) => {
          clock += 3_000;
          return { ...decided, called: mint === "called" ? 1 : 0 };
        },
      },
      () => clock,
    );
    await path.offer("called", 7_000);
    await path.offer("quiet", 12_000);
    expect(path.takeStats()).toMatchObject({
      offered: 2,
      fastScans: 2,
      called: 1,
      crossToDecisionMsMedian: 6_000,
      crossToDecisionMsMax: 6_000,
      crossToCallMsMedian: 6_000,
    });
    expect(path.takeStats()).toMatchObject({ offered: 0, fastScans: 0 });
  });

  it("starts at most maxPerMinute scans a minute; the rest wait for the cycle", async () => {
    let clock = 0;
    const scanned: string[] = [];
    const path = fastPath(
      {
        maxPerMinute: 2,
        scan: async (mint) => {
          scanned.push(mint);
          return decided;
        },
      },
      () => clock,
    );
    await path.offer("a", 0);
    await path.offer("b", 0);
    await path.offer("c", 0);
    clock = 59_999;
    await path.offer("d", 0);
    clock = 60_000;
    await path.offer("e", 0);
    expect(scanned).toEqual(["a", "b", "e"]);
    expect(path.takeStats()).toMatchObject({ fastScans: 3, skippedByCap: 2 });
  });

  it("never scans a coin known to be Mayhem", async () => {
    const scanned: string[] = [];
    const path = fastPath({
      eligible: (mint) => mint !== "mayhem",
      scan: async (mint) => {
        scanned.push(mint);
        return decided;
      },
    });
    await path.offer("mayhem", 0);
    await path.offer("clean", 0);
    expect(scanned).toEqual(["clean"]);
    expect(path.takeStats()).toMatchObject({ skippedMayhem: 1, fastScans: 1 });
  });

  it("runs one scan per coin at a time", async () => {
    const held = heldScan();
    const path = fastPath({ scan: held.scan });
    const first = path.offer("a", 0);
    await flush();
    await path.offer("a", 0);
    expect(held.started).toEqual(["a"]);
    held.release("a");
    await first;
    expect(path.takeStats()).toMatchObject({ fastScans: 1, skippedBusy: 1 });
  });

  it("keeps the cycle off a coin it is scanning, and gives the coin back when done", async () => {
    const held = heldScan();
    const path = fastPath({ scan: held.scan });
    const scanning = path.offer("a", 0);
    await flush();
    const claim = cycleClaim();
    // The cycle's band takes everything but the coin under its fast scan.
    expect(claim.claim([{ mintAddress: "a" }, { mintAddress: "b" }])).toEqual([{ mintAddress: "b" }]);
    claim.release();
    held.release("a");
    await scanning;
    const next = cycleClaim();
    expect(next.claim([{ mintAddress: "a" }])).toEqual([{ mintAddress: "a" }]);
    next.release();
  });

  it("waits for a cycle reading the coin to let go of it, then scans it", async () => {
    const held = heldScan();
    const path = fastPath({ scan: held.scan });
    const claim = cycleClaim();
    claim.claim([{ mintAddress: "a" }]);
    const offered = path.offer("a", 0);
    await flush();
    // Never alongside the cycle.
    expect(held.started).toEqual([]);
    claim.release();
    await flush();
    expect(held.started).toEqual(["a"]);
    held.release("a");
    await offered;
    expect(path.takeStats()).toMatchObject({ waitedOnCycle: 1, fastScans: 1 });
  });

  it("counts a scan that read the coin out of band, and one with no row to scan", async () => {
    const path = fastPath({
      scan: async (mint) => ({ ...decided, skipped: mint === "gone" ? "empty" : "noRow" }),
    });
    await path.offer("gone", 0);
    await path.offer("unknown", 0);
    const stats = path.takeStats();
    expect(stats).toMatchObject({ fastScans: 1, notInBand: 1, noRow: 1 });
    expect(stats.crossToDecisionMsMedian).toBeUndefined();
  });

  it("gives the coin back after a scan that throws", async () => {
    const path = fastPath({
      scan: async () => {
        throw new Error("database down");
      },
    });
    await path.offer("a", 0);
    expect(path.takeStats()).toMatchObject({ failed: 1 });
    expect(claimForFastScan("a")).toBe("ok");
    releaseFastClaim("a");
  });

  describe("the hold for TokenSage's read", () => {
    /** A fake clock the hold's sleeps advance, so no test waits in real time. */
    const fakeTime = () => {
      let clock = 0;
      return {
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
        advance: (ms: number) => {
          clock += ms;
        },
      };
    };

    it("waits for the read, polling between checks, then scans with it in hand", async () => {
      const time = fakeTime();
      const settled = new Set<string>();
      let polls = 0;
      const scannedAt: number[] = [];
      const path = fastPath(
        {
          scan: async () => {
            scannedAt.push(time.now());
            return decided;
          },
          readHold: {
            maxMs: 20_000,
            pollMs: 2_000,
            settled: (mint) => settled.has(mint),
            poll: () => {
              polls += 1;
              if (polls === 3) settled.add("a");
            },
          },
          sleep: time.sleep,
        },
        time.now,
      );
      await path.offer("a", 0);
      expect(scannedAt).toEqual([6_000]);
      expect(polls).toBe(3);
      expect(path.takeStats()).toMatchObject({
        held: 1,
        holdReadArrived: 1,
        holdTimedOut: 0,
        holdMsMedian: 6_000,
        fastScans: 1,
        crossToDecisionMsMedian: 6_000,
      });
    });

    it("gives up at the cap and scans anyway", async () => {
      const time = fakeTime();
      const scannedAt: number[] = [];
      const path = fastPath(
        {
          scan: async () => {
            scannedAt.push(time.now());
            return decided;
          },
          readHold: { maxMs: 5_000, pollMs: 2_000, settled: () => false },
          sleep: time.sleep,
        },
        time.now,
      );
      await path.offer("a", 0);
      // 2 s, 2 s, then the 1 s left of the cap.
      expect(scannedAt).toEqual([5_000]);
      expect(path.takeStats()).toMatchObject({
        held: 1,
        holdTimedOut: 1,
        holdReadArrived: 0,
        holdMsMedian: 5_000,
      });
    });

    it("does not wait for a read already in, nor with the hold off", async () => {
      const time = fakeTime();
      const scannedAt: number[] = [];
      const scan = async () => {
        scannedAt.push(time.now());
        return decided;
      };
      const inHand = fastPath(
        { scan, readHold: { maxMs: 20_000, pollMs: 2_000, settled: () => true }, sleep: time.sleep },
        time.now,
      );
      await inHand.offer("a", 0);
      const off = fastPath(
        { scan, readHold: { maxMs: 0, pollMs: 2_000, settled: () => false }, sleep: time.sleep },
        time.now,
      );
      await off.offer("b", 0);
      expect(scannedAt).toEqual([0, 0]);
      expect(inHand.takeStats()).toMatchObject({ held: 0, fastScans: 1 });
      expect(off.takeStats()).toMatchObject({ held: 0, fastScans: 1 });
    });

    it("stands down after holds in a row got no read, probes now and then, and resumes when one does", async () => {
      const time = fakeTime();
      const settled = new Set<string>();
      const scannedAt = new Map<string, number>();
      const hold: EntryReadHold = {
        maxMs: 4_000,
        pollMs: 2_000,
        settled: (mint) => settled.has(mint),
        standDownAfter: 2,
        probeMs: 60_000,
      };
      const path = fastPath(
        {
          scan: async (mint) => {
            scannedAt.set(mint, time.now());
            return decided;
          },
          readHold: hold,
          sleep: time.sleep,
        },
        time.now,
      );
      // Two holds that ran out: TokenSage is not answering.
      await path.offer("a", 0);
      await path.offer("b", 0);
      expect(path.takeStats()).toMatchObject({ held: 2, holdTimedOut: 2, holdStandingDown: 1 });
      // Stood down: the next coin scans at once, as does one a bit later...
      await path.offer("c", 0);
      time.advance(30_000);
      await path.offer("d", 0);
      expect(scannedAt.get("c")).toBe(8_000);
      expect(scannedAt.get("d")).toBe(38_000);
      // ...until a minute has passed: the next coin is the probe, held as usual, and still no read.
      time.advance(30_000);
      await path.offer("e", 0);
      expect(scannedAt.get("e")).toBe(72_000);
      expect(path.takeStats()).toMatchObject({
        held: 1,
        holdTimedOut: 1,
        holdStoodDown: 2,
        holdStandingDown: 1,
      });
      // Another probe a minute on gets its read at its first check: the hold is back for every coin.
      time.advance(60_000);
      const before = time.now();
      let polled = false;
      hold.poll = () => {
        if (!polled) settled.add("f");
        polled = true;
      };
      await path.offer("f", 0);
      expect(scannedAt.get("f")).toBe(before + 2_000);
      expect(path.takeStats()).toMatchObject({
        held: 1,
        holdReadArrived: 1,
        holdStoodDown: 0,
        holdStandingDown: 0,
      });
      // The next coin holds (and times out), but one miss is not a stand-down.
      await path.offer("h", 0);
      expect(path.takeStats()).toMatchObject({ held: 1, holdTimedOut: 1, holdStandingDown: 0 });
    });

    it("never stands down with standDownAfter 0", async () => {
      const time = fakeTime();
      const path = fastPath(
        {
          scan: async () => decided,
          readHold: { maxMs: 2_000, pollMs: 2_000, settled: () => false, standDownAfter: 0 },
          sleep: time.sleep,
        },
        time.now,
      );
      for (const mint of ["a", "b", "c"]) await path.offer(mint, 0);
      expect(path.takeStats()).toMatchObject({
        held: 3,
        holdTimedOut: 3,
        holdStoodDown: 0,
        holdStandingDown: 0,
      });
    });

    it("polls once per cadence for every coin held at once, not once per coin", async () => {
      // Three coins held together, each checking every 2 s on a clock the test moves: the poll
      // (a prefetcher flush) runs once per 2 s in all, and each coin still sees its own read.
      let clock = 0;
      const gates: (() => void)[] = [];
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          gates.push(resolve);
          void ms;
        });
      const settled = new Set<string>();
      let polls = 0;
      const held = heldScan();
      const path = fastPath(
        {
          scan: held.scan,
          readHold: {
            maxMs: 20_000,
            pollMs: 2_000,
            settled: (mint) => settled.has(mint),
            poll: () => {
              polls += 1;
              if (polls === 2) settled.add("b");
            },
          },
          sleep,
        },
        () => clock,
      );
      const offers = ["a", "b", "c"].map((mint) => path.offer(mint, 0));
      await flush();
      expect(gates.length).toBe(3);
      // 2 s on: the three wake together; only the first to look polls.
      clock = 2_000;
      gates.splice(0).forEach((go) => go());
      await flush();
      expect(polls).toBe(1);
      expect(held.started).toEqual([]);
      // 4 s: again one poll, which brings b's read; b scans, a and c keep waiting.
      clock = 4_000;
      gates.splice(0).forEach((go) => go());
      await flush();
      expect(polls).toBe(2);
      expect(held.started).toEqual(["b"]);
      held.release("b");
      settled.add("a").add("c");
      clock = 6_000;
      gates.splice(0).forEach((go) => go());
      await flush();
      expect(polls).toBe(3);
      expect(held.started.sort()).toEqual(["a", "b", "c"]);
      held.release("a");
      held.release("c");
      await Promise.all(offers);
      expect(path.takeStats()).toMatchObject({ held: 3, holdReadArrived: 3, holdTimedOut: 0 });
    });

    it("holds before claiming the coin, so a cycle may take it meanwhile, and keeps polling through a failing poll", async () => {
      let clock = 0;
      // Sleeps the test lets go of one at a time.
      const gates: (() => void)[] = [];
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          clock += ms;
          gates.push(resolve);
        });
      const held = heldScan();
      let polls = 0;
      const path = fastPath(
        {
          scan: held.scan,
          readHold: {
            maxMs: 4_000,
            pollMs: 2_000,
            settled: () => false,
            poll: () => {
              polls += 1;
              throw new Error("TokenSage down");
            },
          },
          sleep,
        },
        () => clock,
      );
      const offered = path.offer("a", 0);
      await flush();
      // Still holding: the coin is free for the cycle.
      expect(claimForFastScan("a")).toBe("ok");
      releaseFastClaim("a");
      expect(held.started).toEqual([]);
      gates.shift()!();
      await flush();
      expect(polls).toBe(1);
      gates.shift()!();
      await flush();
      // The cap ran out: the scan runs with what is in hand.
      expect(polls).toBe(2);
      expect(held.started).toEqual(["a"]);
      held.release("a");
      await offered;
      expect(path.takeStats()).toMatchObject({ held: 1, holdTimedOut: 1, fastScans: 1, holdMsMedian: 4_000 });
    });

    it("drops a coin that became Mayhem during the hold", async () => {
      const time = fakeTime();
      let mayhem = false;
      const scanned: string[] = [];
      const path = fastPath(
        {
          eligible: () => !mayhem,
          scan: async (mint) => {
            scanned.push(mint);
            return decided;
          },
          readHold: {
            maxMs: 4_000,
            pollMs: 2_000,
            settled: () => false,
            poll: () => {
              mayhem = true;
            },
          },
          sleep: time.sleep,
        },
        time.now,
      );
      await path.offer("a", 0);
      expect(scanned).toEqual([]);
      expect(path.takeStats()).toMatchObject({ held: 1, skippedMayhem: 1, fastScans: 0 });
    });
  });
});
