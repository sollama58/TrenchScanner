// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, describe, expect, it } from "vitest";
import { prisma, loadEnv, type CandidateToken, type DexScreenerClient } from "@trenchscanner/core";
import { runFastMatchCycle } from "./fastMatchJob.js";
import { snapshotDataFor } from "./snapshotData.js";
import type { AlertBot } from "../telegram/bot.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `fast-match-test-${Date.now()}`;
const silentBot: AlertBot = {
  enabled: false,
  async sendMessage() {
    return false;
  },
  start() {},
  async stop() {},
};

function stubDexScreener(byMint: Record<string, Partial<CandidateToken>>): DexScreenerClient {
  return {
    getTokensByAddresses: async (mints: string[]) =>
      mints
        .filter((m) => byMint[m])
        .map((m) => ({
          mintAddress: m,
          priceUsd: 0.0002,
          marketCapUsd: 150_000,
          volume24hUsd: 200_000,
          buys24h: 700,
          sells24h: 300,
          dexId: "pumpswap",
          ...byMint[m],
        })) as CandidateToken[],
  } as unknown as DexScreenerClient;
}

/** A token the full scan cycle has recently vetted, with the on-chain half the fast pass reuses. */
async function seedVetted(suffix: string, overrides: Record<string, unknown> = {}) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${suffix}` } });
  await prisma.tokenSnapshot.create({
    data: {
      ...snapshotDataFor(token.id, {
        mintAddress: token.mintAddress,
        priceUsd: 0.0001,
        marketCapUsd: 120_000,
        narrativeTags: [],
        rugScreen: { passed: true, reasons: [] },
        score: { momentum: 80, holderHealth: 70, age: 100, narrative: 20, total: 75 },
      }),
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      lpBurned: true,
      isMayhemMode: false,
      rugScreenPassed: true,
      ...overrides,
    },
  });
  return token;
}

async function seedSubscriber(suffix: string) {
  const user = await prisma.user.create({ data: { walletAddress: `${TAG}-${suffix}` } });
  await prisma.userFilter.create({
    data: { userId: user.id, name: suffix, mcapMin: 1_000, mcapMax: 10_000_000, isActive: true },
  });
  return user;
}

describe.skipIf(!dbAvailable)("runFastMatchCycle", () => {
  const env = loadEnv();

  afterEach(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("alerts on a re-priced token without touching RugCheck or Helius", async () => {
    const token = await seedVetted("hot");
    const user = await seedSubscriber("sub");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env, silentBot);

    // Scoped to this test's own subscriber: the pass legitimately alerts every filter that
    // matches, and this database carries other tests' filters too.
    expect(await prisma.match.count({ where: { tokenId: token.id, userId: user.id } })).toBe(1);
    // A snapshot was written for the match to point at - carrying THIS moment's market data.
    const snapshot = await prisma.tokenSnapshot.findFirstOrThrow({
      where: { tokenId: token.id },
      orderBy: { takenAt: "desc" },
    });
    expect(snapshot.priceUsd).toBe(0.0002);
  });

  it("writes nothing at all when the re-priced token matches nobody", async () => {
    const token = await seedVetted("cold");
    await seedSubscriber("sub2");
    const before = await prisma.tokenSnapshot.count({ where: { tokenId: token.id } });

    // Far outside the filter's band, so there is nothing to alert on.
    await runFastMatchCycle(
      stubDexScreener({ [token.mintAddress]: { marketCapUsd: 90_000_000 } }),
      env,
      silentBot,
    );

    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
    // Crucially, no speculative snapshot either - this pass runs four times a minute over
    // hundreds of tokens, and a row per look would bury the table for readings nobody reads.
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: token.id } })).toBe(before);
  });

  it("never admits a token whose vetted snapshot failed the rug screen", async () => {
    const token = await seedVetted("rugged", { rugScreenPassed: false, lpBurned: false });
    await seedSubscriber("sub3");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env, silentBot);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("re-runs the screen on the carried-forward profile - an unverified Mayhem check still fails", async () => {
    // The snapshot says it passed, but its Mayhem status is null (the check never resolved).
    // The full screen rejects an unverified mint, and this pass must reach the same verdict
    // rather than trusting the stale rugScreenPassed flag.
    const token = await seedVetted("unverified", { isMayhemMode: null });
    await seedSubscriber("sub4");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env, silentBot);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("skips a token whose snapshot never resolved the hard on-chain facts", async () => {
    const token = await seedVetted("unknown-authority", { lpBurned: null });
    await seedSubscriber("sub5");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env, silentBot);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });
});
