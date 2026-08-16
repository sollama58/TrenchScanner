import { describe, expect, it } from "vitest";
import { runRugScreen, DEFAULT_RUG_THRESHOLDS } from "./rugScreen.js";
import type { OnChainProfile } from "../types.js";

const safeProfile: OnChainProfile = {
  mintAddress: "mint111",
  holderCount: 500,
  top10HolderPct: 25,
  devWalletPct: 3,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  lpBurned: true,
};

describe("runRugScreen", () => {
  it("passes a clean profile", () => {
    const result = runRugScreen(safeProfile);
    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("fails closed when no profile is available", () => {
    const result = runRugScreen(null);
    expect(result.passed).toBe(false);
    expect(result.reasons[0]).toMatch(/unavailable/);
  });

  it("fails on active mint authority", () => {
    const result = runRugScreen({ ...safeProfile, mintAuthorityActive: true });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("mint authority"))).toBe(true);
  });

  it("fails on active freeze authority", () => {
    const result = runRugScreen({ ...safeProfile, freezeAuthorityActive: true });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("freeze authority"))).toBe(true);
  });

  it("fails when liquidity is not burned/locked", () => {
    const result = runRugScreen({ ...safeProfile, lpBurned: false });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("liquidity"))).toBe(true);
  });

  it("fails when top-10 holder concentration exceeds the threshold", () => {
    const result = runRugScreen({ ...safeProfile, top10HolderPct: 75 });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("top 10 holders"))).toBe(true);
  });

  it("fails closed when top-10 holder concentration is unknown", () => {
    const result = runRugScreen({ ...safeProfile, top10HolderPct: undefined });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("unknown"))).toBe(true);
  });

  it("fails when the dev wallet owns too much supply", () => {
    const result = runRugScreen({ ...safeProfile, devWalletPct: 40 });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("dev wallet"))).toBe(true);
  });

  it("respects custom thresholds", () => {
    const tight = { ...DEFAULT_RUG_THRESHOLDS, maxTop10HolderPct: 10 };
    const result = runRugScreen(safeProfile, tight);
    expect(result.passed).toBe(false);
  });
});
