import { describe, expect, it } from "vitest";
import { passesLocalRugScreen, passesWalletSafetyCuts, runRugScreen } from "./rugScreen.js";
import type { OnChainProfile } from "../types.js";

const safeProfile: OnChainProfile = {
  mintAddress: "mint111",
  holderCount: 500,
  top10HolderPct: 25,
  devWalletPct: 3,
  mintAuthorityActive: false,
  freezeAuthorityActive: false,
  lpBurned: true,
  // Explicitly verified as NOT a Mayhem token. Deliberately not defaulted anywhere in the
  // production types either - an absent value means "unverified", which the screen rejects.
  isMayhemMode: false,
};

describe("runRugScreen", () => {
  it("passes a clean profile", () => {
    const result = runRugScreen(safeProfile);
    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it("rejects a token whose top-10 holders are over 70% fresh wallets, and only once measured", () => {
    expect(runRugScreen({ ...safeProfile, freshTop10WalletPct: 80 }).passed).toBe(false);
    expect(runRugScreen({ ...safeProfile, freshTop10WalletPct: 80 }).reasons[0]).toMatch(/fresh wallets/);
    expect(runRugScreen({ ...safeProfile, freshTop10WalletPct: 70 }).passed).toBe(true);
    expect(runRugScreen({ ...safeProfile, freshTop10WalletPct: undefined }).passed).toBe(true);
  });

  it("rejects a token whose top-10 holders are 80% or more empty wallets, and only once measured", () => {
    expect(runRugScreen({ ...safeProfile, emptyTop10WalletPct: 90 }).passed).toBe(false);
    expect(runRugScreen({ ...safeProfile, emptyTop10WalletPct: 80 }).passed).toBe(false);
    expect(runRugScreen({ ...safeProfile, emptyTop10WalletPct: 80 }).reasons[0]).toMatch(/empty wallets/);
    expect(runRugScreen({ ...safeProfile, emptyTop10WalletPct: 77.78 }).passed).toBe(true);
    expect(runRugScreen({ ...safeProfile, emptyTop10WalletPct: 70 }).passed).toBe(true);
    expect(runRugScreen({ ...safeProfile, emptyTop10WalletPct: undefined }).passed).toBe(true);
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

  it("rejects a token whose top-10 holders own 40% or more of supply, and only once measured", () => {
    const concentrated = runRugScreen({ ...safeProfile, top10HolderPct: 40 });
    expect(concentrated.passed).toBe(false);
    expect(concentrated.reasons).toEqual(["top-10 holders own 40% of supply (40% or more)"]);
    expect(runRugScreen({ ...safeProfile, top10HolderPct: 95 }).passed).toBe(false);
    expect(runRugScreen({ ...safeProfile, top10HolderPct: 39.9 }).passed).toBe(true);
  });

  // Dev wallet %, RugCheck's risk score, and its named risk flags used to be hard-gated here
  // too - they're now opt-in UserFilter criteria instead (see matchFilters.test.ts), so a profile
  // that would have failed on any of those alone now passes the automatic screen. Top-10
  // concentration is the same below SAFETY_REJECT_TOP10_HOLDER_PCT.

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

describe("runRugScreen - Pump.fun Mayhem Mode", () => {
  it("fails a Mayhem Mode token", () => {
    const result = runRugScreen({ ...safeProfile, isMayhemMode: true });
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/Mayhem Mode/i);
  });

  it("fails closed when Mayhem status is unverified, rather than assuming it's clean", () => {
    const { isMayhemMode: _omitted, ...unverified } = safeProfile;
    const result = runRugScreen(unverified);
    expect(result.passed).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/unverified/i);
  });

  it("rejects a Mayhem token that is otherwise completely clean", () => {
    // The whole point: these tokens look great on every other axis precisely because their
    // volume and holder activity are manufactured by Pump.fun's AI agents.
    const result = runRugScreen({
      ...safeProfile,
      isMayhemMode: true,
      top10HolderPct: 5,
      devWalletPct: 0,
      riskScore: 0,
      riskFlags: [],
    });
    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(1);
  });

  it("reports Mayhem alongside any other failures rather than short-circuiting", () => {
    const result = runRugScreen({ ...safeProfile, isMayhemMode: true, lpBurned: false });
    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });
});

describe("passesLocalRugScreen", () => {
  it("passes on the free conditions alone, without waiting on the Mayhem lookup", () => {
    // The whole point: this answers "is this mint worth spending an RPC call on?" before the one
    // screen condition that costs one has been resolved.
    const { isMayhemMode: _unverified, ...unchecked } = safeProfile;
    expect(passesLocalRugScreen(unchecked)).toBe(true);
    expect(runRugScreen(unchecked).passed).toBe(false); // ...but it is NOT admitted unverified
  });

  it.each([
    ["mint authority active", { mintAuthorityActive: true }],
    ["freeze authority active", { freezeAuthorityActive: true }],
    ["LP not burned", { lpBurned: false }],
  ] as const)("rejects on %s, so no Mayhem call is ever spent on it", (_label, overrides) => {
    expect(passesLocalRugScreen({ ...safeProfile, ...overrides })).toBe(false);
  });

  it("fails closed with no profile at all, same as the full screen", () => {
    expect(passesLocalRugScreen(null)).toBe(false);
    expect(passesLocalRugScreen(undefined)).toBe(false);
  });

  it("ignores Mayhem status entirely - that is the full screen's job", () => {
    expect(passesLocalRugScreen({ ...safeProfile, isMayhemMode: true })).toBe(true);
    expect(runRugScreen({ ...safeProfile, isMayhemMode: true }).passed).toBe(false);
  });
});

describe("passesWalletSafetyCuts", () => {
  it("applies today's wallet cuts to a banked row's stored features", () => {
    expect(passesWalletSafetyCuts({ emptyTop10WalletPct: 90, freshTop10WalletPct: 0 })).toBe(false);
    expect(passesWalletSafetyCuts({ emptyTop10WalletPct: 80 })).toBe(false);
    expect(passesWalletSafetyCuts({ freshTop10WalletPct: 80 })).toBe(false);
    expect(passesWalletSafetyCuts({ emptyTop10WalletPct: 70, freshTop10WalletPct: 70 })).toBe(true);
    expect(passesWalletSafetyCuts({ sniperTop10WalletPct: 80 })).toBe(false);
    expect(passesWalletSafetyCuts({ sniperTop10WalletPct: 70 })).toBe(true);
    expect(passesWalletSafetyCuts({ top10HolderPct: 40 })).toBe(false);
    expect(passesWalletSafetyCuts({ top10HolderPct: 35 })).toBe(true);
  });

  it("rejects a live token when 80% or more of its top 10 are the launch's first buyers", () => {
    const sniped = runRugScreen({ ...safeProfile, sniperTop10WalletPct: 80 });
    expect(sniped.passed).toBe(false);
    expect(sniped.reasons).toEqual(["80% of top-10 holders are launch snipers (80% or more)"]);
    expect(runRugScreen({ ...safeProfile, sniperTop10WalletPct: 70 }).passed).toBe(true);
    expect(runRugScreen({ ...safeProfile, sniperTop10WalletPct: undefined }).passed).toBe(true);
  });

  it("keeps a row whose wallet checks were never measured", () => {
    expect(passesWalletSafetyCuts({})).toBe(true);
    expect(passesWalletSafetyCuts({ emptyTop10WalletPct: null, freshTop10WalletPct: null })).toBe(true);
    expect(passesWalletSafetyCuts({ top10HolderPct: null })).toBe(true);
  });
});
