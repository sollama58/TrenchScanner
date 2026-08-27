import { describe, expect, it } from "vitest";
import { computeFreshPct } from "./walletFreshness.js";

const HOUR = 3_600_000;

describe("computeFreshPct", () => {
  it("returns null for an empty address list", () => {
    expect(computeFreshPct([], new Map())).toBeNull();
  });

  it("counts a wallet the lookup attempted but couldn't date (present as null) as not fresh", () => {
    const pct = computeFreshPct(
      ["a", "b"],
      new Map([
        ["a", null],
        ["b", null],
      ]),
    );
    expect(pct).toBe(0);
  });

  it("returns null when any wallet was never attempted at all (absent from the map)", () => {
    // The per-cycle lookup budget can defer wallets entirely - a percentage over a part-checked
    // top-10 list would just be a fabricated low number, so the whole answer is "unknown".
    const pct = computeFreshPct(["a", "b"], new Map([["a", new Date()]]));
    expect(pct).toBeNull();
  });

  it("counts an address funded within the last 24h as fresh", () => {
    const oneHourAgo = new Date(Date.now() - HOUR);
    const pct = computeFreshPct(["a"], new Map([["a", oneHourAgo]]));
    expect(pct).toBe(100);
  });

  it("counts an address funded more than 24h ago as not fresh", () => {
    const twoDaysAgo = new Date(Date.now() - 48 * HOUR);
    const pct = computeFreshPct(["a"], new Map([["a", twoDaysAgo]]));
    expect(pct).toBe(0);
  });

  it("computes the correct percentage across a mix of fresh and stale wallets", () => {
    const fresh = new Date(Date.now() - HOUR);
    const stale = new Date(Date.now() - 100 * HOUR);
    const earliestByAddress = new Map([
      ["a", fresh],
      ["b", fresh],
      ["c", stale],
      ["d", null], // indeterminate - counted as not fresh
    ]);
    expect(computeFreshPct(["a", "b", "c", "d"], earliestByAddress)).toBe(50);
  });

  it("ignores addresses in the map that aren't part of this particular candidate's list", () => {
    const fresh = new Date(Date.now() - HOUR);
    const earliestByAddress = new Map([
      ["a", fresh],
      ["unrelated-wallet-from-another-token", fresh],
    ]);
    expect(computeFreshPct(["a"], earliestByAddress)).toBe(100);
  });
});
