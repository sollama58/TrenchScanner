import { describe, expect, it } from "vitest";
import { runRugScreen } from "./rugScreen.js";
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

  // Top-10 concentration, dev wallet %, RugCheck's risk score, and its named risk flags used to
  // be hard-gated here too - they're now opt-in UserFilter criteria instead (see
  // matchFilters.test.ts), so a profile that would have failed on any of those alone now passes
  // the automatic screen. This is the intended behavior change, not a gap: different users
  // legitimately want different thresholds for these, unlike mint/freeze/LP.
  it("passes despite extreme top-10 concentration - that's now opt-in, not automatic", () => {
    const result = runRugScreen({ ...safeProfile, top10HolderPct: 95 });
    expect(result.passed).toBe(true);
  });

  it("passes despite an unknown top-10 concentration - that's now opt-in, not automatic", () => {
    const result = runRugScreen({ ...safeProfile, top10HolderPct: undefined });
    expect(result.passed).toBe(true);
  });

  it("passes despite a large dev wallet - that's now opt-in, not automatic", () => {
    const result = runRugScreen({ ...safeProfile, devWalletPct: 90 });
    expect(result.passed).toBe(true);
  });

  it("passes despite a high RugCheck risk score - that's now opt-in, not automatic", () => {
    const result = runRugScreen({ ...safeProfile, riskScore: 100 });
    expect(result.passed).toBe(true);
  });

  it("passes despite a critical risk flag - that's now opt-in, not automatic", () => {
    const result = runRugScreen({ ...safeProfile, riskFlags: ["Creator history of rugged tokens"] });
    expect(result.passed).toBe(true);
  });
});
