import { afterEach, describe, expect, it, vi } from "vitest";
import {
  largestHolderShare,
  RugCheckClient,
  RUGCHECK_BREAKER_FAILURES,
  toProfile,
  withChainHolders,
  withoutVenueHolder,
  type RugCheckReport,
} from "./rugcheck.js";
import { STONKS_FEE_WALLET } from "../stonksFees.js";

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
  it("reads a holder count of 0 as unknown, not as a token nobody holds", () => {
    expect(toProfile(MINT, baseReport({ totalHolders: 0 })).holderCount).toBeUndefined();
    expect(toProfile(MINT, baseReport()).holderCount).toBe(286_289);
  });

  it("drops the top-10 and dev shares when they sum past 100% of supply", () => {
    const report = baseReport({
      topHolders: [
        { address: POOL_AUTHORITY, owner: POOL_AUTHORITY, pct: 30 },
        { address: CREATOR, owner: CREATOR, pct: 70 },
        { address: "wallet-3", owner: "wallet-3", pct: 50 },
      ],
    });
    const profile = toProfile(MINT, report);
    expect(profile.top10HolderPct).toBeUndefined();
    expect(profile.devWalletPct).toBeUndefined();
  });

  it("excludes the AMM pool's own holdings from top-10 concentration", () => {
    const profile = toProfile(MINT, baseReport());
    // 9.2 + 0.95, NOT +49.1 - the pool authority's 49.1% is locked liquidity, not a holder.
    expect(profile.top10HolderPct).toBeCloseTo(10.15);
  });

  it("leaves out a LaunchLab curve's shared vault, which RugCheck lists as a holder", () => {
    // A Stonks coin on its Raydium LaunchLab curve: the vault's owner is LaunchLab's one authority
    // for every curve, so only the vault's own address ties it to this coin's market.
    const vault = "vaultTokenAccount";
    const profile = toProfile(
      MINT,
      baseReport({
        topHolders: [
          { address: vault, owner: "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", pct: 96 },
          { address: "wallet-2", owner: "wallet-2", pct: 1.5 },
        ],
        markets: [{ pubkey: "launchlabPool", liquidityA: vault, lp: { lpLockedPct: 100 } }],
      }),
    );
    expect(profile.top10HolderPct).toBeCloseTo(1.5);
  });

  it("leaves out a graduated coin's old bonding curve, which its markets list no longer names", () => {
    // Live report for 2bQcQFdqp62Wo99noGRYdWdLrCZ3SAVXtjTP2jUspump, 2026-10-16: the markets list has
    // only the PumpSwap pool, while the Pump.fun curve (its PDA, 7oq2c...) still holds 22%.
    const pumpSwapPool = "3fZsfqSQuMGvD4aR1YQhQrewSnkYfmxm4R6wFnv69mkE";
    const profile = toProfile(
      "2bQcQFdqp62Wo99noGRYdWdLrCZ3SAVXtjTP2jUspump",
      baseReport({
        topHolders: [
          { address: "kAZugyrySXzHzrBz3BWQUk5bwevfwqfaWmyUqmWzg4G", owner: pumpSwapPool, pct: 47.996 },
          {
            address: "B5bSNbkRVGXStFQxRPHxLv8JjBp6FPcY4xyZptkyHeZ7",
            owner: "7oq2c9s7GD1RAxFRccybGc4kZDMzwHSLBaKrEbXA9mJG",
            pct: 22.231,
          },
          {
            address: "HHQwnfduTwLB1MDtBsuAhAKMrrT6HxSMkXbv4Jbky9iT",
            owner: "Cm9BjYWLEUzwHQNV3Fn5dzghYpiqN8zuGW8soy7DoDQX",
            pct: 10.189,
          },
          {
            address: "G9GqQXchSYfAim9s8imiBBqVcKhTBmFnJVpy79z3YcWS",
            owner: "JEAYzwR2kYLRCVWkXTyB35rejx1xqxauu2TpFcQMguxZ",
            pct: 3.702,
          },
        ],
        markets: [{ pubkey: pumpSwapPool, marketType: "pump_fun_amm", lp: { lpLockedPct: 100 } }],
      }),
    );
    expect(profile.largestHolderPct).toBeCloseTo(10.189);
    expect(profile.top10HolderPct).toBeCloseTo(13.891);
    expect(profile.top10HolderAddresses).toEqual([
      "Cm9BjYWLEUzwHQNV3Fn5dzghYpiqN8zuGW8soy7DoDQX",
      "JEAYzwR2kYLRCVWkXTyB35rejx1xqxauu2TpFcQMguxZ",
    ]);
    expect(profile.topHolderShares?.map((h) => h.owner)).not.toContain(
      "7oq2c9s7GD1RAxFRccybGc4kZDMzwHSLBaKrEbXA9mJG",
    );
  });

  it("leaves out a coin's bonding curve on a report that lists no market yet", () => {
    const profile = toProfile(
      "2bQcQFdqp62Wo99noGRYdWdLrCZ3SAVXtjTP2jUspump",
      baseReport({
        topHolders: [
          {
            address: "B5bSNbkRVGXStFQxRPHxLv8JjBp6FPcY4xyZptkyHeZ7",
            owner: "7oq2c9s7GD1RAxFRccybGc4kZDMzwHSLBaKrEbXA9mJG",
            pct: 80,
          },
          {
            address: "HHQwnfduTwLB1MDtBsuAhAKMrrT6HxSMkXbv4Jbky9iT",
            owner: "Cm9BjYWLEUzwHQNV3Fn5dzghYpiqN8zuGW8soy7DoDQX",
            pct: 4,
          },
        ],
        markets: [],
      }),
    );
    expect(profile.largestHolderPct).toBeCloseTo(4);
    expect(profile.top10HolderPct).toBeCloseTo(4);
  });

  it("leaves Stonks' fee wallet out of every coin's holders", () => {
    const holders = [
      { address: "FeeAcct1111111111111111111111111111111111111", owner: STONKS_FEE_WALLET, pct: 6 },
      {
        address: "HHQwnfduTwLB1MDtBsuAhAKMrrT6HxSMkXbv4Jbky9iT",
        owner: "Cm9BjYWLEUzwHQNV3Fn5dzghYpiqN8zuGW8soy7DoDQX",
        pct: 4,
      },
    ];
    for (const launchpad of ["stonkfun", "pump_fun", null]) {
      const profile = toProfile(MINT, baseReport({ topHolders: holders, launchpad }));
      expect(profile.largestHolderPct).toBeCloseTo(4);
      expect(profile.top10HolderPct).toBeCloseTo(4);
      expect(profile.top10HolderAddresses).not.toContain(STONKS_FEE_WALLET);
    }
  });

  it("keeps a multisig vault as a holder: program-derived, but someone can sell from it", () => {
    // A system-owned PDA holding SOL (a Squads-style vault), seen among top holders 2026-10-16.
    const profile = toProfile(
      MINT,
      baseReport({
        topHolders: [
          { address: "vaultTokenAccount", owner: "BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s", pct: 12 },
        ],
        markets: [],
      }),
    );
    expect(profile.largestHolderPct).toBeCloseTo(12);
  });

  it("reads the LP lock on Raydium LaunchLab's own markets apart, for a Stonks coin", () => {
    const markets = [
      { pubkey: "cpmm", marketType: "raydium_cpmm", lp: { lpLockedPct: 100, quoteUSD: 50_000 } },
      { pubkey: "dlmm", marketType: "meteoraDlmm", lp: { lpLockedPct: 0, quoteUSD: 50_000 } },
    ];
    const profile = toProfile(MINT, baseReport({ markets }));
    expect(profile.lpBurned).toBe(false);
    expect(profile.launchLabLpBurned).toBe(true);
    expect(toProfile(MINT, baseReport()).launchLabLpBurned).toBeUndefined();
  });

  it("treats LP as burned when every market clears the lock threshold", () => {
    const profile = toProfile(MINT, baseReport());
    expect(profile.lpBurned).toBe(true);
  });

  it("marks a report that lists no market as not having read the LP", () => {
    const early = toProfile(MINT, baseReport({ markets: [] }));
    expect(early.lpBurned).toBe(false);
    expect(early.marketsListed).toBe(false);
    expect(toProfile(MINT, baseReport()).marketsListed).toBeUndefined();
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

  it("leaves a risk of 0 unknown when the holder list is not indexed yet", () => {
    const profile = toProfile(MINT, baseReport({ totalHolders: 0, score_normalised: 0 }));
    expect(profile.holderCount).toBeUndefined();
    expect(profile.riskScore).toBeUndefined();
    // A counted list with a real 0 stays a clean score.
    expect(toProfile(MINT, baseReport({ score_normalised: 0 })).riskScore).toBe(0);
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

  it("leaves out closed token accounts RugCheck still lists under the System Program", () => {
    const closed = "11111111111111111111111111111111";
    const profile = toProfile(
      MINT,
      baseReport({
        topHolders: [
          { address: POOL_AUTHORITY, owner: POOL_AUTHORITY, pct: 49.1 },
          { address: "wallet-2", owner: "wallet-2", pct: 9.2 },
          { address: "closed-1", owner: closed, pct: 6.4 },
          { address: "wallet-3", owner: "wallet-3", pct: 0.95 },
          { address: "closed-2", owner: closed, pct: 3.6 },
        ],
      }),
    );
    expect(profile.top10HolderAddresses).toEqual(["wallet-2", "wallet-3"]);
    expect(profile.top10HolderPct).toBeCloseTo(10.15);
    expect(profile.topHolderShares?.map((h) => h.owner)).toEqual(["wallet-2", "wallet-3"]);
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

  it("stands down after a run of failures, probes once per stand-down, and a real answer closes it", async () => {
    // A 403 (blocked), not a 5xx: it fails at once instead of retrying after a backoff.
    let status = 403;
    let sent = 0;
    vi.stubGlobal("fetch", async () => {
      sent += 1;
      return new Response(JSON.stringify(status === 200 ? baseReport() : { error: "boom" }), { status });
    });
    let now = 1_000_000;
    const client = new RugCheckClient({ now: () => now });
    for (let i = 0; i < RUGCHECK_BREAKER_FAILURES; i++) {
      await expect(client.getProfileResult(MINT)).resolves.toEqual({ status: "failed" });
    }
    expect(client.standingDown).toBe(true);
    const before = sent;
    await expect(client.getProfileResult(MINT)).resolves.toEqual({ status: "failed" });
    expect(sent).toBe(before);

    // The stand-down lapses: one probe goes out, fails, and the next stand-down is longer.
    now += 30_000;
    await client.getProfileResult(MINT);
    expect(sent).toBeGreaterThan(before);
    expect(client.standingDown).toBe(true);
    now += 30_000;
    expect(client.standingDown).toBe(true);

    // The probe that answers closes it.
    now += 30_000;
    status = 200;
    await expect(client.getProfileResult(MINT)).resolves.toMatchObject({ status: "found" });
    expect(client.standingDown).toBe(false);
  });

  it("never stands down on 'not found' answers, however many", async () => {
    answer(400, { error: "not found" });
    const client = new RugCheckClient();
    for (let i = 0; i < RUGCHECK_BREAKER_FAILURES + 2; i++) await client.getProfileResult(MINT);
    expect(client.standingDown).toBe(false);
  });

  it("records nothing for a mint still queued at the deadline: never asked is not a failure", async () => {
    // One slow answer holds the only worker past the deadline; the mint behind it is skipped,
    // and must not come back as "failed" (the scan job would back it off for a strike it never
    // earned).
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    });
    const client = new RugCheckClient();
    const results = await client.getProfileResults(["first", "second"], 1, { deadlineMs: 10 });
    expect(results.get("first")).toEqual({ status: "absent" });
    expect(results.has("second")).toBe(false);
    expect(asked).toHaveLength(1);
  });
});

describe("withoutVenueHolder", () => {
  const NEW_POOL = "NewPumpSwapPool111111111111111111111111111";
  // RugCheck's report predates the new PumpSwap pool: its markets list the curve only, so the
  // pool's vault (owned by the pool address) reads as a 21.7% holder.
  const report = baseReport({
    topHolders: [
      { address: "vault", owner: NEW_POOL, pct: 21.7 },
      { address: "acct-2", owner: "wallet-2", pct: 9.2 },
      { address: "acct-3", owner: "wallet-3", pct: 12 },
    ],
    markets: [],
  });

  it("takes the coin's own pool out of the top ten", () => {
    const profile = toProfile(MINT, report);
    expect(profile.top10HolderPct).toBeCloseTo(42.9);
    const fixed = withoutVenueHolder(profile, NEW_POOL);
    expect(fixed.top10HolderPct).toBeCloseTo(21.2);
    expect(fixed.top10HolderAddresses).toEqual(["wallet-2", "wallet-3"]);
    expect(profile.largestHolderPct).toBeCloseTo(21.7);
    expect(fixed.largestHolderPct).toBeCloseTo(12);
  });

  it("fills in the largest holder on a profile cached before it was kept", () => {
    const { largestHolderPct: _, ...cached } = toProfile(MINT, report);
    expect(withoutVenueHolder(cached, undefined).largestHolderPct).toBeCloseTo(21.7);
  });

  it("leaves the profile alone when the pool is not a holder, unknown, or the shares are missing", () => {
    const profile = toProfile(MINT, report);
    expect(withoutVenueHolder(profile, "SomeOtherPool")).toBe(profile);
    expect(withoutVenueHolder(profile, undefined)).toBe(profile);
    const cachedBefore = { ...profile, topHolderShares: undefined };
    expect(withoutVenueHolder(cachedBefore, NEW_POOL)).toBe(cachedBefore);
  });

  it("refills the top ten from the eleventh holder", () => {
    const holders = [
      { address: "vault", owner: NEW_POOL, pct: 20 },
      ...Array.from({ length: 11 }, (_, i) => ({ address: `a${i}`, owner: `w${i}`, pct: 3 })),
    ];
    const fixed = withoutVenueHolder(
      toProfile(MINT, baseReport({ topHolders: holders, markets: [] })),
      NEW_POOL,
    );
    expect(fixed.top10HolderPct).toBeCloseTo(30);
    expect(fixed.top10HolderAddresses).toHaveLength(10);
  });
});

describe("largestHolderShare", () => {
  it("sums one owner's accounts and takes the biggest", () => {
    expect(
      largestHolderShare([
        { owner: "a", pct: 6 },
        { owner: "b", pct: 8 },
        { owner: "a", pct: 5 },
      ]),
    ).toBe(11);
    expect(largestHolderShare([])).toBeUndefined();
  });
});

describe("withChainHolders", () => {
  const profile = toProfile(
    MINT,
    baseReport({
      creator: CREATOR,
      topHolders: [
        { address: "acct-1", owner: "sold-out", pct: 15 },
        { address: "acct-2", owner: CREATOR, pct: 4 },
      ],
    }),
  );

  it("takes the holder figures from the chain's reading and keeps the rest of the report", () => {
    const current = withChainHolders(profile, {
      top10HolderPct: 7,
      largestHolderPct: 5,
      topHolderShares: [
        { owner: "w1", pct: 5 },
        { owner: CREATOR, pct: 2 },
      ],
    });
    expect(current).toMatchObject({
      top10HolderPct: 7,
      largestHolderPct: 5,
      top10HolderAddresses: ["w1", CREATOR],
      devWalletPct: 2,
      lpBurned: profile.lpBurned,
      creator: CREATOR,
    });
    // The creator sold out too: no dev share, as when RugCheck doesn't list them.
    expect(
      withChainHolders(profile, {
        top10HolderPct: 5,
        largestHolderPct: 5,
        topHolderShares: [{ owner: "w1", pct: 5 }],
      }).devWalletPct,
    ).toBeUndefined();
  });

  it("leaves the profile alone without a trustworthy reading", () => {
    expect(withChainHolders(profile, undefined)).toBe(profile);
    expect(withChainHolders(profile, { top10HolderPct: undefined, largestHolderPct: undefined })).toBe(
      profile,
    );
    expect(withChainHolders(profile, { top10HolderPct: 3, largestHolderPct: 3, topHolderShares: [] })).toBe(
      profile,
    );
  });
});
