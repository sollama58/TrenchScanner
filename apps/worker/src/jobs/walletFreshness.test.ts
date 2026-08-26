import { describe, expect, it } from "vitest";
import { computeFreshPct } from "./walletFreshness.js";

const HOUR = 3_600_000;

describe("computeFreshPct", () => {
  it("returns null for an empty address list", () => {
    expect(computeFreshPct([], new Map())).toBeNull();
  });

  it("counts a wallet with no resolved activity (missing from the map) as not fresh", () => {
    const pct = computeFreshPct(["a", "b"], new Map([["a", null]]));
    expect(pct).toBe(0);
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
