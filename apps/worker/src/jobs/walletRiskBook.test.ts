// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, walletRiskScore } from "@trenchscanner/core";
import { withWalletSignals } from "./scanJob.js";
import { ownTapesOf, setWalletRiskBook, walletRiskLookup, walletRiskScale } from "./walletRiskBook.js";

describe("wallet risk readings on the scan", () => {
  const profile = {
    mintAddress: "M",
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
    top10HolderAddresses: ["risky", "calm"],
    topHolderShares: [
      { owner: "risky", pct: 8 },
      { owner: "calm", pct: 3 },
    ],
  };
  const env = { WALLET_HOLDINGS_MIN_USD: 25 };

  it("records nothing before the scores load", () => {
    expect(walletRiskLookup()).toBeUndefined();
    expect(walletRiskScale()).toBeUndefined();
    expect(
      withWalletSignals(profile, new Map(), new Map(), env, undefined)?.walletRiskTop10Max,
    ).toBeUndefined();
  });

  it("reads the top holders and first buyers against the scores, the max as a percentile", () => {
    setWalletRiskBook([
      ["risky", { score: 85, dumps: 4, dumper: true }],
      ["calm", { score: 20, dumps: 0 }],
    ]);
    const out = withWalletSignals(profile, new Map(), new Map(), env, new Set(["risky", "unknown"]));
    expect(out).toMatchObject({
      // 85 is above one of the two wallets scored.
      walletRiskTop10Max: 50,
      walletRiskScoredTop10: 2,
      walletRiskFirstBuyersMean: 85,
      walletRiskHighSupplyPct: 8,
      knownDumperFirstBuyers: 1,
    });
  });

  // 2026-10-16 (data-correctness audit): a repeat decision reads the wallets without the coin's own tape.
  it("takes the coin's own tape rows back out of the scores, and records nothing when they couldn't be read", () => {
    const market = 0.2;
    const counted = { appearances: 10, dumps: 4, fastExits: 0, snipes: 0 };
    setWalletRiskBook(
      [
        ["risky", { score: walletRiskScore(counted, market), ...counted, dumper: true }],
        ["calm", { score: 20, dumps: 0, appearances: 2, fastExits: 0, snipes: 0 }],
      ],
      { marketDumpRate: market },
    );
    const own = new Map([["risky", { dumpedIntoStop: true, fastExit: false, launchSniper: false }]]);
    const out = withWalletSignals(profile, new Map(), new Map(), env, new Set(["risky"]), own);
    // 40 * (4/14) / 0.2 = 57.1 without this coin, still above "calm": the 50th percentile.
    expect(out).toMatchObject({ walletRiskTop10Max: 50, walletRiskScoredTop10: 2 });
    expect(out?.walletRiskFirstBuyersMean).toBeCloseTo(57.1, 1);
    expect(
      withWalletSignals(profile, new Map(), new Map(), env, undefined, null)?.walletRiskTop10Max,
    ).toBeUndefined();
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `wallet-risk-book-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("ownTapesOf", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("reads each coin's rows on its own finished tape, counted by the build, for the wallets in view", async () => {
    const builtAt = new Date("2026-10-16T12:00:00Z");
    const taped = await prisma.token.create({ data: { mintAddress: `${TAG}-taped` } });
    const failed = await prisma.token.create({ data: { mintAddress: `${TAG}-failed` } });
    for (const [token, status] of [
      [taped, "done"],
      [failed, "failed"],
    ] as const) {
      await prisma.tokenTradeTape.create({
        data: { tokenId: token.id, anchorAt: builtAt, reason: "called", status, windowEnd: builtAt },
      });
    }
    const before = new Date(builtAt.getTime() - 1);
    await prisma.tokenWalletActivity.createMany({
      data: [
        { tokenId: taped.id, wallet: `${TAG}-dumper`, buys: 1, dumpedIntoStop: true, createdAt: before },
        {
          tokenId: taped.id,
          wallet: `${TAG}-sniper`,
          buys: 1,
          launchSniper: true,
          fastExit: true,
          createdAt: before,
        },
        // Read after the table was built: not in the scores yet.
        {
          tokenId: taped.id,
          wallet: `${TAG}-new`,
          buys: 1,
          dumpedIntoStop: true,
          createdAt: new Date(builtAt.getTime() + 1),
        },
        // Never bought: the rebuild doesn't count it either.
        { tokenId: taped.id, wallet: `${TAG}-seller`, buys: 0, sells: 1, createdAt: before },
        { tokenId: failed.id, wallet: `${TAG}-dumper`, buys: 1, dumpedIntoStop: true, createdAt: before },
      ],
    });
    const wallets = [`${TAG}-dumper`, `${TAG}-sniper`, `${TAG}-new`, `${TAG}-seller`, `${TAG}-other`];
    const out = await ownTapesOf(
      [
        { mintAddress: "taped", tokenId: taped.id, wallets },
        { mintAddress: "failed", tokenId: failed.id, wallets },
        { mintAddress: "fresh", wallets },
      ],
      builtAt,
    );
    expect(out).not.toBeNull();
    expect([...out!.keys()]).toEqual(["taped"]);
    expect([...out!.get("taped")!.entries()].sort()).toEqual([
      [`${TAG}-dumper`, { dumpedIntoStop: true, fastExit: false, launchSniper: false }],
      [`${TAG}-sniper`, { dumpedIntoStop: false, fastExit: true, launchSniper: true }],
    ]);
    expect(await ownTapesOf([{ mintAddress: "fresh", wallets }], builtAt)).toEqual(new Map());
  });
});
