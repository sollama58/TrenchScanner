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
  buildOnChainProfile,
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

  it("keeps a graduated mint's pool unverified until RugCheck reports it", () => {
    const profile = buildOnChainProfile({ mintAddress: "Grad", dexId: "pumpswap" }, none, authorities);
    expect(profile?.lpBurned).toBe(false);
    expect(runRugScreen({ ...profile!, isMayhemMode: false }).passed).toBe(false);
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
