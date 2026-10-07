import { afterEach, describe, expect, it, vi } from "vitest";
import { RugCheckClient, toProfile, type RugCheckReport } from "./rugcheck.js";

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

  it("judges a Pump.fun token's LP on its own pool, not on side pools others opened", () => {
    const report = baseReport({
      markets: [
        { pubkey: POOL_AUTHORITY, marketType: "pump_fun_amm", lp: { lpLockedPct: 100 } },
        { pubkey: "dlmm-pool", marketType: "meteoraDlmm", lp: { lpLockedPct: 0 } },
        { pubkey: "damm-pool", marketType: "meteora_damm_v2", lp: { lpLockedPct: 0 } },
      ],
    });
    expect(toProfile(MINT, report).lpBurned).toBe(true);
  });

  it("still fails a Pump.fun token whose own pool is not locked", () => {
    const report = baseReport({
      markets: [
        { pubkey: "curve", marketType: "pump_fun", lp: { lpLockedPct: 100 } },
        { pubkey: POOL_AUTHORITY, marketType: "pump_fun_amm", lp: { lpLockedPct: 0 } },
      ],
    });
    expect(toProfile(MINT, report).lpBurned).toBe(false);
  });

  it("ignores dust side pools on a non-Pump.fun token, but not a real unlocked pool", () => {
    const pool = (pubkey: string, lpLockedPct: number, usd: number) => ({
      pubkey,
      marketType: "meteora_damm_v2",
      lp: { lpLockedPct, baseUSD: usd / 2, quoteUSD: usd / 2 },
    });
    const dust = baseReport({ markets: [pool(POOL_AUTHORITY, 100, 50_000), pool("dust", 0, 1)] });
    expect(toProfile(MINT, dust).lpBurned).toBe(true);
    const real = baseReport({ markets: [pool(POOL_AUTHORITY, 100, 50_000), pool("real", 0, 20_000)] });
    expect(toProfile(MINT, real).lpBurned).toBe(false);
  });

  it("treats LP as not burned when there are no markets at all", () => {
    expect(toProfile(MINT, baseReport({ markets: [] })).lpBurned).toBe(false);
  });

  it("reads whether the creator still holds from creatorBalance", () => {
    expect(toProfile(MINT, baseReport({ creatorBalance: 1_000 })).creatorHolding).toBe(true);
    expect(toProfile(MINT, baseReport({ creatorBalance: 0 })).creatorHolding).toBe(false);
    expect(toProfile(MINT, baseReport({})).creatorHolding).toBeUndefined();
    expect(
      toProfile(MINT, baseReport({ creator: undefined, creatorBalance: 0 })).creatorHolding,
    ).toBeUndefined();
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

  it("does not attribute an owner-less holder's bag to a missing creator", () => {
    const report = baseReport({ creator: undefined, topHolders: [{ address: "acct-a", pct: 35 }] });
    expect(toProfile(MINT, report).devWalletPct).toBeUndefined();
  });

  it("leaves riskScore unknown, not a perfect 0, when the report has no score", () => {
    expect(toProfile(MINT, baseReport({ score_normalised: undefined })).riskScore).toBeUndefined();
  });

  it("passes through RugCheck's own risk score and flags", () => {
    const profile = toProfile(MINT, baseReport());
    expect(profile.riskScore).toBe(43);
    expect(profile.riskFlags).toContain("High holder concentration");
  });

  it("exposes top10HolderAddresses excluding the pool authority, for the freshness check", () => {
    const profile = toProfile(MINT, baseReport());
    expect(profile.top10HolderAddresses).toEqual(["wallet-2", "wallet-3"]);
    expect(profile.top10HolderAddresses).not.toContain(POOL_AUTHORITY);
  });
});

describe("RugCheckClient.getProfileResult", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answer = (status: number, body: unknown) =>
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status }));

  it("reads RugCheck's 400 'not found' for an unindexed mint as absent, so it gets cached", async () => {
    answer(400, { error: "not found" });
    await expect(new RugCheckClient().getProfileResult(MINT)).resolves.toEqual({ status: "absent" });
  });

  it("still reads a 404 as absent", async () => {
    answer(404, { error: "not found" });
    await expect(new RugCheckClient().getProfileResult(MINT)).resolves.toEqual({ status: "absent" });
  });

  it("keeps a 429 a failure, never cached", async () => {
    answer(429, { error: "rate limited" });
    const client = new RugCheckClient();
    await expect(client.getProfileResult(MINT)).resolves.toEqual({ status: "failed" });
  });
});
