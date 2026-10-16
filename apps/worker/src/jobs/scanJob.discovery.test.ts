// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  runRugScreen,
  type CandidateToken,
  type RugCheckProfile,
  type MintAuthorityResult,
} from "@trenchscanner/core";
import {
  addNewMintsToWatchlist,
  saveMovingLaunches,
  buildOnChainProfile,
  freshGraduatesOverCut,
  noteSnapshotWritten,
  persistSnapshot,
  reviveMovingMints,
  stampLiveMarketCaps,
  viewedOutOfBand,
  type CandidatePrior,
} from "./scanJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** Valid-looking base58 mints (looksLikeSolanaAddress), unique per run. The pad collides 1 and 11, 2 and 12. */
const RUN = Date.now()
  .toString(36)
  .replace(/[0lIO]/g, "x");
const mint = (n: number) => `Disc${RUN}${String(n).padStart(3, "1")}`.padEnd(44, "A").replace(/[0lIO]/g, "x");

describe("a fresh graduate's own pool in its RugCheck holders", () => {
  const POOL = "FreshPool1111111111111111111111111111111111";
  const now = Date.parse("2026-10-12T04:00:00Z");
  const profile = (top10: number, shares?: { owner: string; pct: number }[]): RugCheckProfile => ({
    mintAddress: "Fresh",
    top10HolderPct: top10,
    top10HolderAddresses: shares?.map((s) => s.owner) ?? [],
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    riskFlags: [],
    ...(shares ? { topHolderShares: shares } : {}),
  });
  const poolCounted = profile(52, [
    { owner: POOL, pct: 21.7 },
    { owner: "w1", pct: 20.3 },
    { owner: "w2", pct: 10 },
  ]);

  it("is left out of the profile the screen reads", () => {
    const built = buildOnChainProfile(
      { mintAddress: "Fresh", dexId: "pumpswap", pairAddress: POOL },
      new Map([["Fresh", poolCounted]]),
      new Map(),
    );
    expect(built?.top10HolderPct).toBeCloseTo(30.3);
    expect(built?.top10HolderAddresses).toEqual(["w1", "w2"]);
  });

  it("judges a Stonks coin's LP on its LaunchLab markets, not on a side pool someone opened", () => {
    const rug = new Map([["Fresh", { ...profile(20), lpBurned: false, launchLabLpBurned: true }]]);
    const stonks = buildOnChainProfile(
      { mintAddress: "Fresh", dexId: "raydium", launchpad: "stonks" },
      rug,
      new Map(),
    );
    expect(stonks?.lpBurned).toBe(true);
    // Another launchpad's coin, or one cached before the reading existed, keeps every pool's answer.
    expect(buildOnChainProfile({ mintAddress: "Fresh", dexId: "raydium" }, rug, new Map())?.lpBurned).toBe(
      false,
    );
    const cached = new Map([["Fresh", { ...profile(20), lpBurned: false }]]);
    expect(
      buildOnChainProfile({ mintAddress: "Fresh", dexId: "raydium", launchpad: "stonks" }, cached, new Map())
        ?.lpBurned,
    ).toBe(false);
  });

  it("passes a proven Pump.fun launch on LP and authorities, without its PumpSwap pool as a holder", () => {
    // STARMAN's shape: a curve quoted in another Pump.fun coin, whose RugCheck report listed only
    // the Meteora side pools (0% locked) and counted the PumpSwap pool as a holder.
    const sidePoolsOnly = new Map([
      [
        "Fresh",
        profile(45, [
          { owner: "QuotedPool", pct: 11.8 },
          { owner: "w1", pct: 20 },
          { owner: "w2", pct: 13.2 },
        ]),
      ],
    ]);
    sidePoolsOnly.get("Fresh")!.lpBurned = false;
    const candidate = { mintAddress: "Fresh", dexId: "pumpswap", pairAddress: "SomeOtherPair" };
    expect(buildOnChainProfile(candidate, sidePoolsOnly, new Map())?.lpBurned).toBe(false);

    const proven = new Map([
      ["Fresh", { status: "found" as const, launch: { quoteMint: "Q", pool: "QuotedPool" } }],
    ]);
    const built = buildOnChainProfile(candidate, sidePoolsOnly, new Map(), new Map(), proven);
    expect(built).toMatchObject({ lpBurned: true, mintAuthorityActive: false, freezeAuthorityActive: false });
    expect(built?.top10HolderPct).toBeCloseTo(33.2);
    expect(runRugScreen({ ...built!, isMayhemMode: false }).reasons).not.toContainEqual(
      expect.stringContaining("liquidity"),
    );

    // No proof (not a Pump.fun launch, or the read failed): the report's answer stands.
    for (const result of [{ status: "found" as const, launch: null }, { status: "failed" as const }]) {
      const unproven = new Map([["Fresh", result]]);
      expect(buildOnChainProfile(candidate, sidePoolsOnly, new Map(), new Map(), unproven)?.lpBurned).toBe(
        false,
      );
    }
  });

  it("screens a coin on the chain's holders when RugCheck still lists a wallet that sold out", () => {
    // 6vs4o...pump on 2026-10-16: RugCheck's report kept a 15% holder an hour after it had sold
    // everything, so the coin failed the largest-holder cut on a wallet that held nothing.
    const stale = new Map([
      [
        "Fresh",
        {
          ...profile(29.6, [
            { owner: "soldOut", pct: 15 },
            { owner: "w1", pct: 4.18 },
            { owner: "w2", pct: 3.32 },
          ]),
          largestHolderPct: 15,
          creator: "w2",
          devWalletPct: 3.32,
        },
      ],
    ]);
    const candidate = { mintAddress: "Fresh", dexId: "pumpswap", pairAddress: POOL };
    const before = buildOnChainProfile(candidate, stale, new Map());
    expect(runRugScreen({ ...before!, isMayhemMode: false }).reasons).toContainEqual(
      expect.stringContaining("largest holder owns 15.0%"),
    );

    const chain = new Map([
      [
        "Fresh",
        {
          top10HolderPct: 9.5,
          largestHolderPct: 4.2,
          top10HolderAddresses: ["w1", "w2", "w3"],
          topHolderShares: [
            { owner: "w1", pct: 4.2 },
            { owner: "w2", pct: 3.3 },
            { owner: "w3", pct: 2 },
          ],
        },
      ],
    ]);
    const now = buildOnChainProfile(candidate, stale, new Map(), chain);
    expect(now).toMatchObject({
      top10HolderPct: 9.5,
      largestHolderPct: 4.2,
      top10HolderAddresses: ["w1", "w2", "w3"],
      devWalletPct: 3.3,
    });
    expect(runRugScreen({ ...now!, isMayhemMode: false }).passed).toBe(true);
  });

  it("builds a proven launch's profile from the proof when RugCheck and the authority read have nothing", () => {
    const proven = new Map([["Fresh", { status: "found" as const, launch: { quoteMint: "Q", pool: "P" } }]]);
    const failed = new Map<string, MintAuthorityResult>([["Fresh", { status: "failed" }]]);
    const candidate = { mintAddress: "Fresh", dexId: "meteora" };
    expect(buildOnChainProfile(candidate, new Map(), failed)).toBeNull();
    expect(buildOnChainProfile(candidate, new Map(), failed, new Map(), proven)).toMatchObject({
      lpBurned: true,
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
    });
  });

  it("re-reads only coins graduated in the last five minutes still over the cut without their pool", () => {
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    const profiles = new Map<string, RugCheckProfile>([
      ["Over", { ...profile(78), mintAddress: "Over" }],
      // Over the top-10 cut only with its pool, and no holder over the largest-holder cut without it.
      [
        "PoolOnly",
        {
          ...profile(52, [
            { owner: POOL, pct: 21.7 },
            { owner: "w1", pct: 10 },
            { owner: "w2", pct: 10 },
            { owner: "w3", pct: 10 },
          ]),
          mintAddress: "PoolOnly",
        },
      ],
      // Under the top-10 cut, but one wallet over the largest-holder cut.
      ["Whale", { ...profile(20, [{ owner: "w1", pct: 15 }]), mintAddress: "Whale" }],
      ["Old", { ...profile(78), mintAddress: "Old" }],
      ["Under", { ...profile(20), mintAddress: "Under" }],
    ]);
    const candidates = [
      { mintAddress: "Over", pairAddress: "p1", graduatedAt: at(2) },
      { mintAddress: "PoolOnly", pairAddress: POOL, graduatedAt: at(1) },
      { mintAddress: "Old", pairAddress: "p3", graduatedAt: at(6) },
      { mintAddress: "Under", pairAddress: "p4", graduatedAt: at(1) },
      { mintAddress: "Whale", pairAddress: "p6", graduatedAt: at(1) },
      { mintAddress: "Curve", pairAddress: "p5" },
    ];
    expect(freshGraduatesOverCut(candidates, profiles, now)).toEqual(["Over", "Whale"]);
  });
});

describe("buildOnChainProfile without a RugCheck report", () => {
  const authorities = new Map<string, MintAuthorityResult>([
    ["Pre", { status: "found", mintAuthorityActive: false, freezeAuthorityActive: false }],
    ["Grad", { status: "found", mintAuthorityActive: false, freezeAuthorityActive: false }],
  ]);
  const none = new Map<string, RugCheckProfile>();

  it("lets a bonding-curve mint with renounced authorities clear the LP condition", () => {
    const profile = buildOnChainProfile({ mintAddress: "Pre", dexId: "pumpfun" }, none, authorities);
    expect(profile?.lpBurned).toBe(true);
    // Still unverified on Mayhem until that lookup lands - the screen keeps failing closed on it.
    expect(runRugScreen(profile).reasons).toEqual(["Mayhem Mode status unverified - failing closed"]);
    expect(runRugScreen({ ...profile!, isMayhemMode: false }).passed).toBe(true);
  });

  it("counts a PumpSwap pool as locked, but keeps any other pool unverified until RugCheck reports it", () => {
    const pumpswap = buildOnChainProfile({ mintAddress: "Grad", dexId: "pumpswap" }, none, authorities);
    expect(pumpswap?.lpBurned).toBe(true);
    const raydium = buildOnChainProfile({ mintAddress: "Grad", dexId: "raydium" }, none, authorities);
    expect(raydium?.lpBurned).toBe(false);
    expect(runRugScreen({ ...raydium!, isMayhemMode: false }).passed).toBe(false);
  });

  it("carries the holders read from the chain, so the concentration cut and wallet checks run", () => {
    const holders = new Map([["Pre", { top10HolderPct: 45, top10HolderAddresses: ["w1", "w2"] }]]);
    const profile = buildOnChainProfile({ mintAddress: "Pre", dexId: "pumpfun" }, none, authorities, holders);
    expect(profile).toMatchObject({ top10HolderPct: 45, top10HolderAddresses: ["w1", "w2"] });
    expect(runRugScreen({ ...profile!, isMayhemMode: false }).passed).toBe(false);
  });

  it("takes the Pump.fun venue's LP answer when the RugCheck report lists no market yet", () => {
    const early = new Map<string, RugCheckProfile>([
      [
        "Pre",
        {
          mintAddress: "Pre",
          mintAuthorityActive: false,
          freezeAuthorityActive: false,
          lpBurned: false,
          marketsListed: false,
          riskFlags: [],
        },
      ],
    ]);
    const pump = buildOnChainProfile({ mintAddress: "Pre", dexId: "pumpfun" }, early, authorities);
    expect(pump?.lpBurned).toBe(true);
    expect(runRugScreen({ ...pump!, isMayhemMode: false }).passed).toBe(true);
    // Off a Pump.fun venue the report's answer stands until RugCheck lists the pool.
    expect(buildOnChainProfile({ mintAddress: "Pre", dexId: "raydium" }, early, authorities)?.lpBurned).toBe(
      false,
    );
  });

  it("still fails closed when the authority lookup itself failed", () => {
    expect(buildOnChainProfile({ mintAddress: "Unknown", dexId: "pumpfun" }, none, authorities)).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("discovery metadata and revival", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: `Disc${RUN}` } } });
  });

  it("records the description, the first source to report a mint, and a sticky boost flag", async () => {
    await addNewMintsToWatchlist([
      { mintAddress: mint(1), description: "a dog", discoverySource: "pumpfun" },
      { mintAddress: mint(1), discoverySource: "dexscreener", boosted: true },
    ]);
    const row = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(1) } });
    expect(row.description).toBe("a dog");
    expect(row.discoverySource).toBe("pumpfun");
    expect(row.dexBoosted).toBe(true);

    // A boost bought after discovery still marks an existing row.
    await addNewMintsToWatchlist([{ mintAddress: mint(2), discoverySource: "pumpfun" }]);
    await addNewMintsToWatchlist([{ mintAddress: mint(2), discoverySource: "dexscreener", boosted: true }]);
    expect((await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(2) } })).dexBoosted).toBe(true);
  });

  it("records the launch time a launch source says, on a new row and later on one found without it", async () => {
    const launchedAt = new Date("2026-10-16T12:00:00Z");
    await addNewMintsToWatchlist([
      { mintAddress: mint(31), createdAt: launchedAt, discoverySource: "pumpfun" },
    ]);
    const fromLaunch = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(31) } });
    expect(fromLaunch.launchedAt).toEqual(launchedAt);
    expect(fromLaunch.firstSeenAt).toEqual(launchedAt);

    // First met on DexScreener (no launch time), then on a Pump.fun list: the row takes it, once.
    await addNewMintsToWatchlist([{ mintAddress: mint(32), discoverySource: "dexscreener" }]);
    expect(
      (await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(32) } })).launchedAt,
    ).toBeNull();
    await addNewMintsToWatchlist([
      { mintAddress: mint(32), createdAt: launchedAt, discoverySource: "pumpfun" },
    ]);
    const later = new Date("2026-10-16T13:00:00Z");
    await addNewMintsToWatchlist([{ mintAddress: mint(32), createdAt: later, discoverySource: "jupiter" }]);
    const filled = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(32) } });
    expect(filled.launchedAt).toEqual(launchedAt);
    expect(filled.firstSeenAt).not.toEqual(launchedAt);
  });

  it("fills in the description and socials of a row the stream created bare, once", async () => {
    await addNewMintsToWatchlist([{ mintAddress: mint(90), symbol: "BARE", discoverySource: "pumpportal" }]);
    // Bare means unread: the socials are null, not a false the models would read as "none".
    expect(await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(90) } })).toMatchObject({
      description: null,
      hasTwitter: null,
      hasWebsite: null,
    });

    await addNewMintsToWatchlist([
      {
        mintAddress: mint(90),
        description: "a cat",
        hasTwitter: true,
        hasWebsite: false,
        twitterUrl: "https://x.com/cat",
        discoverySource: "pumpportal",
      },
    ]);
    const filled = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(90) } });
    expect(filled).toMatchObject({
      description: "a cat",
      hasTwitter: true,
      // The detail read said no website: a read none, recorded over the unread null.
      hasWebsite: false,
      twitterUrl: "https://x.com/cat",
    });

    // A recorded description is never rewritten.
    await addNewMintsToWatchlist([
      { mintAddress: mint(90), description: "other", discoverySource: "pumpfun" },
    ]);
    expect((await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(90) } })).description).toBe(
      "a cat",
    );
  });

  it("saves Jupiter's moving coins without claiming a description, reviving known ones", async () => {
    const stale = new Date(Date.now() - 6 * 3_600_000);
    await prisma.token.create({
      data: { mintAddress: mint(91), lastLiveAt: stale, lastMcapUsd: 4_000, description: "kept" },
    });
    const coinDetails = async () => null;
    await saveMovingLaunches(
      [
        { mintAddress: mint(91), graduated: false, marketCapUsd: 80_000 },
        { mintAddress: mint(92), symbol: "NEW", graduated: false, marketCapUsd: 3_000 },
      ],
      { coinDetails },
      env,
    );
    const known = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(91) } });
    expect(known.description).toBe("kept");
    expect(known.lastMcapUsd).toBe(80_000);
    const fresh = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(92) } });
    expect(fresh).toMatchObject({
      symbol: "NEW",
      description: null,
      discoverySource: "jupiter",
      // Jupiter's lists carry no socials: unknown, not "none".
      hasTwitter: null,
      hasWebsite: null,
    });
  });

  it("revives a known mint that is moving again, and ignores ones still at launch level", async () => {
    const stale = new Date(Date.now() - 6 * 3_600_000);
    await prisma.token.createMany({
      data: [
        { mintAddress: mint(3), lastLiveAt: stale, lastMcapUsd: 4_000 },
        { mintAddress: mint(4), lastLiveAt: stale, lastMcapUsd: 4_000 },
      ],
    });
    const changed = await reviveMovingMints(
      [
        { mintAddress: mint(3), marketCapUsd: 40_000 },
        { mintAddress: mint(4), marketCapUsd: env.WATCHLIST_NEAR_BAND_MIN_MCAP_USD - 1 },
      ],
      env,
    );
    expect(changed).toBe(1);
    const revived = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(3) } });
    expect(revived.lastMcapUsd).toBe(40_000);
    expect(revived.lastLiveAt!.getTime()).toBeGreaterThan(stale.getTime());
    const untouched = await prisma.token.findUniqueOrThrow({ where: { mintAddress: mint(4) } });
    expect(untouched.lastMcapUsd).toBe(4_000);
  });

  it("revives a mint stamped moments ago only when its cap moves it into the near-band tier", async () => {
    // The ~110 recently-traded coins were rewritten every cycle, stamped or not.
    const recent = new Date(Date.now() - 30_000);
    await prisma.token.createMany({
      data: [
        { mintAddress: mint(21), lastLiveAt: recent, lastMcapUsd: 20_000 },
        { mintAddress: mint(22), lastLiveAt: recent, lastMcapUsd: 3_000 },
        { mintAddress: mint(23) },
      ],
    });
    const changed = await reviveMovingMints(
      [
        { mintAddress: mint(21), marketCapUsd: 21_000 }, // same tier, stamped recently: left alone
        { mintAddress: mint(22), marketCapUsd: 30_000 }, // climbed into the tier: revived
        { mintAddress: mint(23), marketCapUsd: 40_000 }, // never stamped: revived
      ],
      env,
    );
    expect(changed).toBe(2);
    const rows = await prisma.token.findMany({
      where: { mintAddress: { in: [mint(21), mint(22), mint(23)] } },
    });
    const mcap = (n: number) => rows.find((r) => r.mintAddress === mint(n))?.lastMcapUsd;
    expect([mcap(21), mcap(22), mcap(23)]).toEqual([20_000, 30_000, 40_000]);
  });

  it("stamps a live mint at most every couple of minutes, unless its cap crossed the near-band tier", async () => {
    // Stamping all ~900 live mints every cycle rewrote that many Token rows a cycle.
    const recent = new Date(Date.now() - 30_000);
    const old = new Date(Date.now() - 5 * 60_000);
    await prisma.token.createMany({
      data: [
        { mintAddress: mint(5), lastLiveAt: recent, lastMcapUsd: 20_000 },
        { mintAddress: mint(6), lastLiveAt: recent, lastMcapUsd: 3_000 },
        { mintAddress: mint(7), lastLiveAt: old, lastMcapUsd: 20_000 },
        { mintAddress: mint(8) },
      ],
    });
    await stampLiveMarketCaps(
      [
        { mintAddress: mint(5), marketCapUsd: 21_000 }, // same tier, stamped recently: left alone
        { mintAddress: mint(6), marketCapUsd: 30_000 }, // climbed into the tier: stamped
        { mintAddress: mint(7), marketCapUsd: 22_000 }, // stamp is old: stamped
        { mintAddress: mint(8), marketCapUsd: 5_000 }, // never stamped: stamped
      ],
      env,
    );
    const rows = await prisma.token.findMany({
      where: { mintAddress: { in: [mint(5), mint(6), mint(7), mint(8)] } },
    });
    const mcap = (n: number) => rows.find((r) => r.mintAddress === mint(n))?.lastMcapUsd;
    expect([mcap(5), mcap(6), mcap(7), mcap(8)]).toEqual([20_000, 30_000, 22_000, 5_000]);
  });
});

describe("viewedOutOfBand", () => {
  const token = (mintAddress: string, marketCapUsd: number): CandidateToken => ({
    mintAddress,
    priceUsd: 0.001,
    marketCapUsd,
  });

  it("reads a watchlisted viewed token from the refresh, the rest from the lookup", () => {
    // What a lookup of every viewed token, minus the in-band ones, used to return.
    const refreshed = [token("in-band", 100_000), token("viewed-above", 5_000_000), token("unviewed", 1)];
    const lookedUp = [token("viewed-off-list", 2_000)];
    const viewed = [
      { mintAddress: "viewed-off-list" },
      { mintAddress: "in-band" },
      { mintAddress: "viewed-above" },
    ];
    const out = viewedOutOfBand(viewed, refreshed, lookedUp, new Set(["in-band"]));
    expect(out.map((t) => [t.mintAddress, t.marketCapUsd])).toEqual([
      ["viewed-off-list", 2_000],
      ["viewed-above", 5_000_000],
    ]);
  });

  it("drops a viewed token nothing returned market data for", () => {
    expect(viewedOutOfBand([{ mintAddress: "dead" }], [], [], new Set())).toEqual([]);
  });
});

describe("persistSnapshot", () => {
  const prior = (alerted: boolean): CandidatePrior => ({
    token: null,
    holderCount: null,
    holderCount10m: null,
    recentHourlySample: false,
    alerted,
  });

  it("spaces a failing token's snapshots out, but never an alerted token's", () => {
    const now = Date.now();
    const id = `spacing-${RUN}`;
    expect(persistSnapshot(id, prior(false), now)).toBe(true);
    noteSnapshotWritten(id, now);
    expect(persistSnapshot(id, prior(false), now + 60_000)).toBe(false);
    expect(persistSnapshot(id, prior(true), now + 60_000)).toBe(true);
    expect(persistSnapshot(id, prior(false), now + 3 * 60_000)).toBe(true);
  });
});
