// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma, walletRiskScore } from "@trenchscanner/core";
import { withWalletSignals } from "./scanJob.js";
import {
  ownTapesOf,
  refreshWalletRiskBook,
  resetWalletRiskBook,
  setWalletRiskBook,
  takeWalletRiskBookReloads,
  walletRiskBookLoaded,
  walletRiskLookup,
  walletRiskScale,
} from "./walletRiskBook.js";

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

// Performance audit 2026-10-19 (F7): the table changes only with the hourly rebuild, so a due reload
// keeps the copy while the rebuild's heartbeat row is unchanged.
describe.skipIf(!dbAvailable)("refreshWalletRiskBook", () => {
  const wallet = `${TAG}-book`;
  const MIN = 60_000;
  let saved: Awaited<ReturnType<typeof prisma.systemHeartbeat.findUnique>> = null;

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.walletRisk.deleteMany({ where: { wallet } });
    await prisma.systemHeartbeat.deleteMany({ where: { job: "wallet-risk" } });
    if (saved) await prisma.systemHeartbeat.create({ data: { ...saved, meta: saved.meta ?? undefined } });
    resetWalletRiskBook();
  });

  it("reads the table again only when the rebuild's heartbeat row changed, or an hour on", async () => {
    saved = await prisma.systemHeartbeat.findUnique({ where: { job: "wallet-risk" } });
    resetWalletRiskBook();
    takeWalletRiskBookReloads();
    await prisma.walletRisk.create({
      data: {
        wallet,
        score: 70,
        appearances: 3,
        dumps: 2,
        fastExits: 0,
        snipes: 0,
        solIn: 1,
        solOut: 0,
        lastSeenAt: new Date(),
        computedAt: new Date(),
      },
    });
    const at = new Date("2026-10-19T10:00:00Z");
    await prisma.systemHeartbeat.upsert({
      where: { job: "wallet-risk" },
      create: { job: "wallet-risk", lastRunAt: at, lastSuccessAt: at, meta: { marketDumpRate: 0.2 } },
      update: { lastRunAt: at, lastSuccessAt: at, meta: { marketDumpRate: 0.2 } },
    });
    const t0 = Date.now();

    refreshWalletRiskBook(t0);
    await walletRiskBookLoaded();
    expect(walletRiskLookup()?.(wallet)?.score).toBe(70);
    expect(takeWalletRiskBookReloads()).toEqual({ full: 1, skipped: 0 });

    // Due again, nothing rebuilt: the copy stands, even with a row changed behind the heartbeat's back.
    await prisma.walletRisk.update({ where: { wallet }, data: { score: 80 } });
    refreshWalletRiskBook(Date.now() + 11 * MIN);
    await walletRiskBookLoaded();
    expect(takeWalletRiskBookReloads()).toEqual({ full: 0, skipped: 1 });
    expect(walletRiskLookup()?.(wallet)?.score).toBe(70);

    // A rebuild wrote its heartbeat: read in full.
    const later = new Date("2026-10-19T11:00:00Z");
    await prisma.systemHeartbeat.update({
      where: { job: "wallet-risk" },
      data: { lastRunAt: later, lastSuccessAt: later },
    });
    refreshWalletRiskBook(Date.now() + 22 * MIN);
    await walletRiskBookLoaded();
    expect(takeWalletRiskBookReloads()).toEqual({ full: 1, skipped: 0 });
    expect(walletRiskLookup()?.(wallet)?.score).toBe(80);
    expect(walletRiskScale()?.builtAt.toISOString()).toBe(later.toISOString());

    // An hour without a full read: read in full however quiet the heartbeat.
    await prisma.walletRisk.update({ where: { wallet }, data: { score: 90 } });
    refreshWalletRiskBook(Date.now() + 61 * MIN);
    await walletRiskBookLoaded();
    expect(takeWalletRiskBookReloads()).toEqual({ full: 1, skipped: 0 });
    expect(walletRiskLookup()?.(wallet)?.score).toBe(90);
  });
});
