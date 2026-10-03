// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import {
  prisma,
  loadEnv,
  runRugScreen,
  type RugCheckProfile,
  type MintAuthorityResult,
} from "@trenchscanner/core";
import { addNewMintsToWatchlist, buildOnChainProfile, reviveMovingMints } from "./scanJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** Valid-looking base58 mints (looksLikeSolanaAddress), unique per run. */
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
});
