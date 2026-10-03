import { afterEach, describe, expect, it } from "vitest";
import type { TokenSnapshot } from "@prisma/client";
import {
  markScanVerdictsPopulated,
  recentScanVerdicts,
  recordScanVerdict,
  resetScanVerdicts,
} from "./vettedTokens.js";

function verdict(id: string, takenAt: Date, rugScreenPassed = true) {
  return {
    token: { id, mintAddress: `mint-${id}`, firstSeenAt: new Date(0) },
    snapshot: { id: `snap-${id}-${takenAt.getTime()}`, takenAt, rugScreenPassed } as TokenSnapshot,
  };
}

afterEach(() => resetScanVerdicts());

describe("vettedTokens", () => {
  it("says nothing until a scan cycle has completed, so the caller falls back to the database", () => {
    recordScanVerdict(verdict("a", new Date()));
    expect(recentScanVerdicts(new Date(0), 10)).toBeNull();
    markScanVerdictsPopulated();
    expect(recentScanVerdicts(new Date(0), 10)).toHaveLength(1);
  });

  it("keeps only the newest verdict per token, even when it fails the screen", () => {
    markScanVerdictsPopulated();
    recordScanVerdict(verdict("a", new Date(1_000), true));
    recordScanVerdict(verdict("a", new Date(2_000), false));
    const out = recentScanVerdicts(new Date(0), 10)!;
    expect(out).toHaveLength(1);
    expect(out[0]!.snapshot.rugScreenPassed).toBe(false);
  });

  it("returns newest first, capped, and ages out anything older than the window", () => {
    markScanVerdictsPopulated();
    recordScanVerdict(verdict("old", new Date(500)));
    recordScanVerdict(verdict("b", new Date(2_000)));
    recordScanVerdict(verdict("c", new Date(3_000)));
    recordScanVerdict(verdict("d", new Date(1_500)));
    expect(recentScanVerdicts(new Date(1_000), 2)!.map((v) => v.token.id)).toEqual(["c", "b"]);
    expect(recentScanVerdicts(new Date(0), 10)!.map((v) => v.token.id)).toEqual(["c", "b", "d"]);
  });
});
