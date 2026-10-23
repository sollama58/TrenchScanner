import { describe, expect, it } from "vitest";
import { clampToSafetyBounds, FILTER_SAFETY_CEILINGS, FILTER_SAFETY_DEFAULTS } from "./filterBounds.js";
import { parseStarterCriteria } from "./starterFilterStore.js";

describe("filter safety bounds", () => {
  it("sit at the most the screen lets through", () => {
    expect(FILTER_SAFETY_CEILINGS).toEqual({
      maxTop10HolderPct: 40,
      maxLargestHolderPct: 10,
      maxFreshTop10WalletPct: 70,
      maxEmptyTop10WalletPct: 70,
      maxBlockZeroHeldPct: 10,
      maxLinkedWalletCount: 19,
      minCexFundedCount: 20,
      maxCexFundedCount: 20,
      maxSniperTopHolderCount: 19,
      maxBundledSupplyPct: 40,
    });
  });

  it("defaults every ceiling but the minimum and the retired fields", () => {
    expect(Object.keys(FILTER_SAFETY_DEFAULTS).sort()).toEqual(
      [
        "maxBlockZeroHeldPct",
        "maxBundledSupplyPct",
        "maxCexFundedCount",
        "maxEmptyTop10WalletPct",
        "maxFreshTop10WalletPct",
        "maxLargestHolderPct",
        "maxSniperTopHolderCount",
        "maxTop10HolderPct",
      ].sort(),
    );
  });

  it("clamps only values above a ceiling, keeping unset fields and other keys", () => {
    expect(
      clampToSafetyBounds({
        maxTop10HolderPct: 60,
        maxLargestHolderPct: 5,
        maxEmptyTop10WalletPct: null,
        maxCexFundedCount: 25,
        maxDevWalletPct: 90,
      }),
    ).toEqual({
      maxTop10HolderPct: 40,
      maxLargestHolderPct: 5,
      maxEmptyTop10WalletPct: null,
      maxCexFundedCount: 20,
      maxDevWalletPct: 90,
    });
  });

  it("clamps the frozen Default copy when a new account is seeded", () => {
    const data = parseStarterCriteria({ mcapMin: 10_000, mcapMax: 1_000_000, maxFreshTop10WalletPct: 90 });
    expect(data?.maxFreshTop10WalletPct).toBe(70);
    expect(data?.maxEmptyTop10WalletPct).toBeUndefined();
  });
});
