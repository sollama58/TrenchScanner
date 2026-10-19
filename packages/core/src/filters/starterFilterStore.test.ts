import { describe, expect, it } from "vitest";
import { parseStarterCriteria } from "./starterFilterStore.js";
import { STARTER_FILTER_NAME } from "./starterFilter.js";

describe("parseStarterCriteria", () => {
  it("carries the copied criteria under the Default name", () => {
    const data = parseStarterCriteria({
      mcapMin: 12_000,
      mcapMax: 90_000,
      maxFreshTop10WalletPct: 25,
      launchpads: ["pump.fun"],
      excludeCopycats: true,
    });
    expect(data).toEqual({
      name: STARTER_FILTER_NAME,
      mcapMin: 12_000,
      mcapMax: 90_000,
      maxFreshTop10WalletPct: 25,
      launchpads: ["pump.fun"],
      excludeCopycats: true,
    });
  });

  it("drops keys that aren't criteria columns, so a stale copy can't fail the create", () => {
    const data = parseStarterCriteria({
      mcapMin: 1,
      mcapMax: 2,
      name: "Gemerald",
      color: "#0f0",
      isActive: false,
      someRemovedColumn: 5,
    });
    expect(data).toEqual({ name: STARTER_FILTER_NAME, mcapMin: 1, mcapMax: 2 });
  });

  it("drops the retired criteria, so a new account's Default shows no old rules", () => {
    const data = parseStarterCriteria({
      mcapMin: 1,
      mcapMax: 2,
      maxBundledSupplyPct: 30,
      maxSniperTop10WalletPct: 30,
      maxLinkedWalletCount: 5,
      maxSameTimeFundedCount: 5,
      maxLinkedWalletPct: 20,
      maxSameTimeFundedPct: 20,
      maxKolBundledPct: 10,
      minCexFundedPct: 0,
      maxCexFundedPct: 50,
    });
    expect(data).toEqual({ name: STARTER_FILTER_NAME, mcapMin: 1, mcapMax: 2, maxBundledSupplyPct: 30 });
  });

  it("rejects criteria without a market cap band", () => {
    expect(parseStarterCriteria(null)).toBeNull();
    expect(parseStarterCriteria([])).toBeNull();
    expect(parseStarterCriteria({ mcapMin: 1 })).toBeNull();
  });
});
