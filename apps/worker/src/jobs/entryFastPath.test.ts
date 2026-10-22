import { afterEach, describe, expect, it } from "vitest";
import { EntryFastPath, type EntryFastPathOptions } from "./entryFastPath.js";
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
});
