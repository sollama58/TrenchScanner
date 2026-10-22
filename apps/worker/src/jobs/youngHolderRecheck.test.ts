import { beforeEach, describe, expect, it } from "vitest";
import type { OnChainProfile } from "@trenchscanner/core";
import {
  OLD_HOLDER_RECHECK_MINUTES,
  OLD_HOLDER_RECHECK_TTL_MINUTES,
  YOUNG_HOLDER_RECHECK_MINUTES,
  holderCutRecheckTtlFor,
  noteHolderCutVerdict,
  resetYoungHolderRecheck,
  rugCheckTtlFor,
} from "./youngHolderRecheck.js";

const NOW = Date.parse("2026-10-13T01:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000);

function profile(over: Partial<OnChainProfile> = {}): OnChainProfile {
  return {
    mintAddress: "m",
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    riskFlags: [],
    top10HolderPct: 20,
    ...over,
  } as OnChainProfile;
}

describe("young holder recheck", () => {
  beforeEach(() => resetYoungHolderRecheck());

  it("re-reads a young coin failing a holder cut every minute, and others on the default TTL", () => {
    noteHolderCutVerdict("sniped", profile({ emptyTop10WalletPct: 90 }), minutesAgo(2), NOW);
    // Block 0 is read from the chain, not RugCheck: a fresh report would not change it.
    noteHolderCutVerdict("blockZero", profile({ blockZeroHeldPct: 30 }), minutesAgo(2), NOW);
    noteHolderCutVerdict("heavy", profile({ top10HolderPct: 55 }), minutesAgo(1), NOW);
    noteHolderCutVerdict("clean", profile(), minutesAgo(2), NOW);
    const ttl = rugCheckTtlFor(5, NOW);
    expect(ttl("sniped")).toBe(1);
    expect(ttl("heavy")).toBe(1);
    expect(ttl("clean")).toBe(5);
    expect(ttl("blockZero")).toBe(5);
    expect(ttl("never-seen")).toBe(5);
  });

  it("leaves older coins on the default TTL, and drops a coin that ages past the window", () => {
    noteHolderCutVerdict("old", profile({ emptyTop10WalletPct: 100 }), minutesAgo(30), NOW);
    noteHolderCutVerdict("young", profile({ emptyTop10WalletPct: 100 }), minutesAgo(2), NOW);
    expect(rugCheckTtlFor(5, NOW)("old")).toBe(5);
    expect(rugCheckTtlFor(5, NOW)("young")).toBe(1);
    const later = NOW + YOUNG_HOLDER_RECHECK_MINUTES * 60_000;
    expect(rugCheckTtlFor(5, later)("young")).toBe(5);
  });

  it("forgets a coin once it passes the holder cuts", () => {
    noteHolderCutVerdict("m", profile({ freshTop10WalletPct: 90 }), minutesAgo(1), NOW);
    noteHolderCutVerdict("m", profile(), minutesAgo(1), NOW);
    expect(rugCheckTtlFor(5, NOW)("m")).toBe(5);
  });

  it("does not shorten a TTL that is already shorter", () => {
    noteHolderCutVerdict("m", profile({ top10HolderPct: 60 }), minutesAgo(1), NOW);
    expect(rugCheckTtlFor(0.5, NOW)("m")).toBe(0.5);
  });

  it("ignores a coin with no launch time or no profile", () => {
    noteHolderCutVerdict("a", profile({ top10HolderPct: 60 }), undefined, NOW);
    noteHolderCutVerdict("b", null, minutesAgo(1), NOW);
    expect(rugCheckTtlFor(5, NOW)("a")).toBe(5);
    expect(rugCheckTtlFor(5, NOW)("b")).toBe(5);
  });
});

describe("holder-cut recheck TTL (user decision 2026-10-20)", () => {
  it("stretches the chain read of a coin past its first hour, and only of the rechecks", () => {
    const ages = new Map([
      ["old", OLD_HOLDER_RECHECK_MINUTES],
      ["young", OLD_HOLDER_RECHECK_MINUTES - 1],
    ]);
    const ttl = holderCutRecheckTtlFor(
      (mint) => (mint === "long" ? 30 : 5),
      (mint) => (mint === "long" ? 600 : ages.get(mint)),
    );
    expect(ttl("old")).toBe(OLD_HOLDER_RECHECK_TTL_MINUTES);
    expect(ttl("young")).toBe(5);
    expect(ttl("not-a-recheck")).toBe(5);
    // Never shortens a longer TTL.
    expect(ttl("long")).toBe(30);
  });
});
