// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { readTokenProfile, safeLink } from "./tokenProfile.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `token-profile-test-${Date.now()}`;
const DEV = "DevWa11et".replace(/1/g, "2").padEnd(40, "z");
const FUNDER = "Funder".padEnd(40, "y");

describe.skipIf(!dbAvailable)("readTokenProfile: the Dev card", () => {
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.devLaunchRisk.deleteMany({ where: { wallet: DEV } });
    await prisma.devFunderRisk.deleteMany({ where: { funder: FUNDER } });
  });

  it("lists every coin the dev created, with its first grade, and both launch records", async () => {
    const at = (h: number) => new Date(Date.now() - h * 3_600_000);
    const coin = await prisma.token.create({ data: { mintAddress: `${TAG}-coin`, creator: DEV } });
    await prisma.token.create({
      data: { mintAddress: `${TAG}-dead`, symbol: "DEAD", creator: DEV, firstSeenAt: at(5) },
    });
    const graded = await prisma.token.create({
      data: {
        mintAddress: `${TAG}-graded`,
        symbol: "WON",
        creator: DEV,
        firstSeenAt: at(3),
        firstInBandAt: at(3),
      },
    });
    for (const [h, win] of [
      [2.9, true],
      [2.5, false],
    ] as const) {
      await prisma.candidateOutcome.create({
        data: {
          tokenId: graded.id,
          anchorAt: at(h),
          anchorPriceUsd: 1,
          anchorMcapUsd: 10_000,
          features: {},
          sampleKind: "event",
          nextCheckAt: new Date(),
          peak1hPriceUsd: 2,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 2,
          finalizedAt: at(h - 0.5),
          hit2xIn1h: win,
          disqualified: false,
          peak1hReturnPct: win ? 120 : 10,
        },
      });
    }
    const record = { launches: 3, inBand: 1, graded: 1, wins: 1, stops: 0 };
    await prisma.devLaunchRisk.create({
      data: {
        wallet: DEV,
        score: 22,
        ...record,
        funder: FUNDER,
        lastLaunchAt: at(3),
        computedAt: new Date(),
      },
    });
    await prisma.devFunderRisk.create({
      data: {
        funder: FUNDER,
        creators: 4,
        score: 61,
        launches: 9,
        inBand: 1,
        graded: 1,
        wins: 1,
        stops: 0,
        computedAt: new Date(),
      },
    });

    const dev = (await readTokenProfile(coin.mintAddress))!.dev!;
    expect(dev.wallet).toBe(DEV);
    expect(dev.launch).toEqual({ score: 22, ...record });
    expect(dev.family).toMatchObject({ creators: 4, score: 61, launches: 9 });
    expect(dev.coins.map((c) => [c.symbol, c.outcome, c.reachedBand, c.peakPct])).toEqual([
      ["WON", "win", true, 120],
      ["DEAD", null, false, null],
    ]);
  });
});

describe("safeLink", () => {
  it("keeps https links and builds handles into links", () => {
    expect(safeLink("https://x.com/coin", "x")).toBe("https://x.com/coin");
    expect(safeLink("@coindev", "x")).toBe("https://x.com/coindev");
    expect(safeLink("coin_chat", "telegram")).toBe("https://t.me/coin_chat");
    expect(safeLink("https://coin.fun/", "website")).toBe("https://coin.fun/");
  });
  it("drops anything that isn't https", () => {
    expect(safeLink("http://coin.fun", "website")).toBeNull();
    expect(safeLink("javascript:alert(1)", "website")).toBeNull();
    expect(safeLink("not a link", "website")).toBeNull();
    expect(safeLink(null, "x")).toBeNull();
    expect(safeLink("", "telegram")).toBeNull();
  });
  it("drops userinfo links and off-host X and Telegram links", () => {
    expect(safeLink("https://x.com@evil.example/", "x")).toBeNull();
    expect(safeLink("https://user:pw@coin.fun/", "website")).toBeNull();
    expect(safeLink("https://evil.example/coin", "x")).toBeNull();
    expect(safeLink("https://evil.example/chat", "telegram")).toBeNull();
    expect(safeLink("https://twitter.com/coin", "x")).toBe("https://twitter.com/coin");
    expect(safeLink("https://t.me/coin_chat", "telegram")).toBe("https://t.me/coin_chat");
  });
});
