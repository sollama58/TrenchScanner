// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, describe, expect, it } from "vitest";
import { prisma, loadEnv, type CandidateToken, type DexScreenerClient } from "@trenchscanner/core";
import { runFastMatchCycle } from "./fastMatchJob.js";
import { resetMatchableFilters } from "./matchDispatch.js";
import { snapshotDataFor } from "./snapshotData.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `fast-match-test-${Date.now()}`;

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
      ...snapshotDataFor(
        token.id,
        {
          mintAddress: token.mintAddress,
          priceUsd: 0.0001,
          marketCapUsd: 120_000,
          narrativeTags: [],
          rugScreen: { passed: true, reasons: [] },
          score: { momentum: 80, holderHealth: 70, age: 100, narrative: 20, total: 75 },
        },
        "scan",
      ),
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      lpBurned: true,
      isMayhemMode: false,
      rugScreenPassed: true,
      // The screen's holder reading is in - a match waits for it (matchDispatch's awaitsScreenReading).
      freshTop10WalletPct: 10,
      ...overrides,
    },
  });
  return token;
}

async function seedSubscriber(suffix: string, subscribed = true) {
  const user = await prisma.user.create({ data: { walletAddress: `${TAG}-${suffix}` } });
  // Only filters whose owner has access are matched (loadEntitledActiveFilters).
  if (subscribed)
    await prisma.subscription.create({
      data: { userId: user.id, expiresAt: new Date(Date.now() + 86_400_000), source: "BURN" },
    });
  await prisma.userFilter.create({
    // Armed long ago: these tests are about alerting, not a just-applied filter settling in.
    data: {
      userId: user.id,
      name: suffix,
      mcapMin: 1_000,
      mcapMax: 10_000_000,
      isActive: true,
      armedAt: new Date(Date.now() - 3_600_000),
    },
  });
  return user;
}

describe.skipIf(!dbAvailable)("runFastMatchCycle", () => {
  // Lazy: vitest runs a describe callback during collection even when skipIf will skip every
  // test inside it, so calling loadEnv() here directly threw on a machine with no DATABASE_URL -
  // turning the intended graceful skip into a hard suite failure, which is the opposite of what
  // the guard above and this file's own header promise.
  const env = dbAvailable ? loadEnv() : (undefined as never);

  afterEach(async () => {
    resetMatchableFilters();
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("alerts on a re-priced token without touching RugCheck or Helius", async () => {
    const token = await seedVetted("hot");
    const user = await seedSubscriber("sub");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);

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

  it("carries the funding-only figures and the newest holder lists onto the alert's snapshot", async () => {
    const token = await seedVetted("lists", { kolBundledPctExTransfers: 4, bundledSupplyPctExTransfers: 6 });
    // The scan wrote the lists on an earlier row only (holderListWrites.ts dedupes them).
    const holders = [{ wallet: "w1", pct: 3.5 }];
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        source: "scan",
        takenAt: new Date(Date.now() - 60_000),
        priceUsd: 0.0001,
        marketCapUsd: 120_000,
        score: 75,
        linkedHolders: holders,
      },
    });
    const user = await seedSubscriber("sub-lists");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);

    expect(await prisma.match.count({ where: { tokenId: token.id, userId: user.id } })).toBe(1);
    const fast = await prisma.tokenSnapshot.findFirstOrThrow({
      where: { tokenId: token.id, source: "fast" },
    });
    expect(fast).toMatchObject({ kolBundledPctExTransfers: 4, bundledSupplyPctExTransfers: 6 });
    expect(fast.linkedHolders).toEqual(holders);
  });

  it("doesn't alert on a vetted token whose holders the screen hasn't read yet", async () => {
    // HEEHAW (2026-10-16): the fast lane alerted at three minutes old, before the holder list was
    // in, and the screen rejected it on that list two minutes later.
    const token = await seedVetted("unread", { freshTop10WalletPct: null });
    const user = await seedSubscriber("sub-unread");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);

    expect(await prisma.match.count({ where: { tokenId: token.id, userId: user.id } })).toBe(0);
  });

  it("writes nothing at all when the re-priced token matches nobody", async () => {
    const token = await seedVetted("cold");
    await seedSubscriber("sub2");
    const before = await prisma.tokenSnapshot.count({ where: { tokenId: token.id } });

    // Far outside the filter's band, so there is nothing to alert on.
    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: { marketCapUsd: 90_000_000 } }), env);

    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
    // Crucially, no speculative snapshot either - this pass runs four times a minute over
    // hundreds of tokens, and a row per look would bury the table for readings nobody reads.
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: token.id } })).toBe(before);
  });

  it("never admits a token whose vetted snapshot failed the rug screen", async () => {
    const token = await seedVetted("rugged", { rugScreenPassed: false, lpBurned: false });
    await seedSubscriber("sub3");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("stops alerting once a NEWER scan snapshot fails the screen", async () => {
    // The exact shape the gate exists to stop: a token vetted clean, then re-checked by the full
    // cycle and found to have had its LP unlocked. The older passing row is still inside the
    // vetting window, and selecting the newest PASSING row rather than the newest row would keep
    // alerting from underneath the rejection for the rest of that window.
    const token = await seedVetted("flipped");
    await seedSubscriber("sub-flipped");
    await prisma.tokenSnapshot.create({
      data: {
        ...snapshotDataFor(
          token.id,
          {
            mintAddress: token.mintAddress,
            priceUsd: 0.0001,
            marketCapUsd: 120_000,
            narrativeTags: [],
            rugScreen: { passed: false, reasons: ["LP not burned or locked"] },
            score: { momentum: 80, holderHealth: 70, age: 100, narrative: 20, total: 75 },
          },
          "scan",
        ),
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpBurned: false,
        isMayhemMode: false,
        rugScreenPassed: false,
      },
    });

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("does not treat its own fast-pass snapshots as having vetted a token", async () => {
    // The pass carries the on-chain half forward instead of re-resolving it, so its own rows
    // restate a verdict rather than establishing one. If they counted as vetting, a token could
    // hold its vetting window open indefinitely off its own restatements - long after the last
    // real on-chain check aged out.
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-fastonly` } });
    await prisma.tokenSnapshot.create({
      data: {
        ...snapshotDataFor(
          token.id,
          {
            mintAddress: token.mintAddress,
            priceUsd: 0.0001,
            marketCapUsd: 120_000,
            narrativeTags: [],
            rugScreen: { passed: true, reasons: [] },
            score: { momentum: 80, holderHealth: 70, age: 100, narrative: 20, total: 75 },
          },
          "fast",
        ),
        mintAuthorityActive: false,
        freezeAuthorityActive: false,
        lpBurned: true,
        isMayhemMode: false,
        rugScreenPassed: true,
      },
    });
    await seedSubscriber("sub-fastonly");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("matches no filter whose owner has no access", async () => {
    const token = await seedVetted("free");
    const paid = await seedSubscriber("paid");
    const free = await seedSubscriber("free", false);

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);

    expect(await prisma.match.count({ where: { tokenId: token.id, userId: paid.id } })).toBe(1);
    expect(await prisma.match.count({ where: { tokenId: token.id, userId: free.id } })).toBe(0);
  });

  it("re-arms a filter whose owner just gained access, so its backlog doesn't alert at once", async () => {
    const token = await seedVetted("gained");
    const dex = stubDexScreener({ [token.mintAddress]: {} });
    // A first pass records which filters were matchable; the newcomer is not among them yet.
    await runFastMatchCycle(dex, env);
    const newcomer = await seedSubscriber("newcomer");

    await runFastMatchCycle(dex, env);

    expect(await prisma.match.count({ where: { tokenId: token.id, userId: newcomer.id } })).toBe(0);
    const filter = await prisma.userFilter.findFirstOrThrow({ where: { userId: newcomer.id } });
    expect(Date.now() - filter.armedAt.getTime()).toBeLessThan(60_000);
  });

  it("writes no snapshot for a token whose every match is already on cooldown", async () => {
    // Matching is not enough to justify a write: a hot token keeps matching the same filter for
    // hours after its 12-hour cooldown started. Writing on a match rather than on an alert meant
    // four unreferenced rows a minute for exactly the tokens that stay interesting longest.
    const token = await seedVetted("cooling");
    const user = await seedSubscriber("sub-cooling");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);
    expect(await prisma.match.count({ where: { tokenId: token.id, userId: user.id } })).toBe(1);

    const afterFirst = await prisma.tokenSnapshot.count({ where: { tokenId: token.id } });
    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);

    expect(await prisma.match.count({ where: { tokenId: token.id, userId: user.id } })).toBe(1);
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: token.id } })).toBe(afterFirst);
  });

  it("re-runs the screen on the carried-forward profile - an unverified Mayhem check still fails", async () => {
    // The snapshot says it passed, but its Mayhem status is null (the check never resolved).
    // The full screen rejects an unverified mint, and this pass must reach the same verdict
    // rather than trusting the stale rugScreenPassed flag.
    const token = await seedVetted("unverified", { isMayhemMode: null });
    await seedSubscriber("sub4");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });

  it("skips a token whose snapshot never resolved the hard on-chain facts", async () => {
    const token = await seedVetted("unknown-authority", { lpBurned: null });
    await seedSubscriber("sub5");

    await runFastMatchCycle(stubDexScreener({ [token.mintAddress]: {} }), env);
    expect(await prisma.match.count({ where: { tokenId: token.id } })).toBe(0);
  });
});
