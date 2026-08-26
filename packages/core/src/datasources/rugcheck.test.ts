import { describe, expect, it } from "vitest";
import { toProfile, type RugCheckReport } from "./rugcheck.js";

const MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const POOL_AUTHORITY = "FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC";
const CREATOR = "9ENSWnedBEAvVB7jJKZrLRZ9vuVuJdBE7uJt2oAsG1jr";

/** Shape mirrors a real RugCheck /report response for a graduated pump.fun token (see git history for the live sample this was captured from). */
function baseReport(overrides: Partial<RugCheckReport> = {}): RugCheckReport {
  return {
    token: { mintAuthority: null, freezeAuthority: null },
    creator: CREATOR,
    totalHolders: 286_289,
    topHolders: [
      { address: POOL_AUTHORITY, owner: POOL_AUTHORITY, pct: 49.1 },
      { address: "wallet-2", owner: "wallet-2", pct: 9.2 },
      { address: "wallet-3", owner: "wallet-3", pct: 0.95 },
    ],
    markets: [{ pubkey: POOL_AUTHORITY, lp: { lpLockedPct: 100 } }],
    score_normalised: 43,
    risks: [{ name: "High holder concentration", level: "warn" }],
    ...overrides,
  };
}

describe("toProfile", () => {
  it("excludes the AMM pool's own holdings from top-10 concentration", () => {
    const profile = toProfile(MINT, baseReport());
    // 9.2 + 0.95, NOT +49.1 - the pool authority's 49.1% is locked liquidity, not a holder.
    expect(profile.top10HolderPct).toBeCloseTo(10.15);
  });

  it("treats LP as burned when every market clears the lock threshold", () => {
    const profile = toProfile(MINT, baseReport());
    expect(profile.lpBurned).toBe(true);
  });

  it("treats LP as not burned when any market is below the lock threshold", () => {
    const report = baseReport({
      markets: [
        { pubkey: POOL_AUTHORITY, lp: { lpLockedPct: 100 } },
        { pubkey: "other-pool", lp: { lpLockedPct: 40 } },
      ],
    });
    expect(toProfile(MINT, report).lpBurned).toBe(false);
  });

  it("treats LP as not burned when there are no markets at all", () => {
    expect(toProfile(MINT, baseReport({ markets: [] })).lpBurned).toBe(false);
  });

  it("derives devWalletPct when the creator appears in the (pool-excluded) holder list", () => {
    const report = baseReport({
      topHolders: [
        { address: POOL_AUTHORITY, owner: POOL_AUTHORITY, pct: 49.1 },
        { address: CREATOR, owner: CREATOR, pct: 12.5 },
      ],
    });
    expect(toProfile(MINT, report).devWalletPct).toBeCloseTo(12.5);
  });

  it("leaves devWalletPct undefined (not a critical flag) when the creator simply holds too little to rank", () => {
    // Known, identified creator - just not in the top holders. This is the common, benign case.
    const profile = toProfile(MINT, baseReport());
    expect(profile.devWalletPct).toBeUndefined();
    expect(profile.riskFlags).not.toContain("Creator identity unknown");
  });

  it("flags 'Creator identity unknown' as a critical risk when the creator field itself is missing", () => {
    const profile = toProfile(MINT, baseReport({ creator: undefined }));
    expect(profile.devWalletPct).toBeUndefined();
    expect(profile.riskFlags).toContain("Creator identity unknown");
  });

  it("passes through RugCheck's own risk score and flags", () => {
    const profile = toProfile(MINT, baseReport());
    expect(profile.riskScore).toBe(43);
    expect(profile.riskFlags).toContain("High holder concentration");
  });
});
