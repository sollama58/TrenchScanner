// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@trenchscanner/core";
import { loadEnv } from "@trenchscanner/core";
import {
  createModelsVsKolsCache,
  readKolCalls,
  typicalKol,
  windowTiers,
  type KolCall,
  type VsTiers,
} from "./modelsVsKols.js";
import { cacheReport } from "./sharedCache.js";
import { READ_KEEPS_WARM_MS } from "./marketLighthouse.js";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const HOUR = 3_600_000;

const call = (over: Partial<KolCall>): KolCall => ({
  who: "k",
  mint: "m",
  boughtAt: new Date(NOW - HOUR),
  hit2x: false,
  hit4x: false,
  hit10x: false,
  tenXGraded: true,
  ...over,
});

const tiers = (graded: number, won2x: number): VsTiers => ({
  days: 7,
  calls: graded,
  graded,
  won2x,
  won4x: 0,
  won10x: 0,
  tenXGraded: graded,
});

describe("windowTiers", () => {
  it("counts each window back from now and leaves ungraded calls out of the rates", () => {
    const calls = [
      call({ mint: "a", hit2x: true, hit4x: true, hit10x: true }),
      // A clean 2x still inside its hour: graded, its 10x not settled yet.
      call({ mint: "b", hit2x: true, tenXGraded: false, boughtAt: new Date(NOW - 30 * HOUR) }),
      // Still inside its 15 minutes: a call, not graded.
      call({ mint: "c", hit2x: null, hit4x: null, hit10x: null, tenXGraded: false }),
      call({ mint: "d", boughtAt: new Date(NOW - 5 * 24 * HOUR) }),
    ];
    const [day, three, week] = windowTiers(calls, NOW, [1, 3, 7]);
    expect(day).toEqual({ days: 1, calls: 2, graded: 1, won2x: 1, won4x: 1, won10x: 1, tenXGraded: 1 });
    expect(three).toMatchObject({ calls: 3, graded: 2, won2x: 2, won4x: 1, tenXGraded: 1 });
    expect(week).toMatchObject({ calls: 4, graded: 3, won2x: 2, tenXGraded: 2 });
  });
});

describe("typicalKol", () => {
  const kol = (graded: number, won2x: number, tenXGraded = graded, won10x = 0): VsTiers => ({
    ...tiers(graded, won2x),
    won4x: Math.floor(won2x / 2),
    won10x,
    tenXGraded,
  });

  it("takes the median of the KOLs past the floor, one KOL one vote", () => {
    const t = typicalKol(
      [
        kol(10, 1),
        kol(20, 6),
        // A hot hand: moves the mean, not the median.
        kol(10, 9, 10, 4),
        // Under the floor: left out, though its rate is perfect.
        kol(3, 3),
        // No graded pick: not even active.
        kol(0, 0),
      ],
      7,
      10,
    );
    expect(t).toMatchObject({ days: 7, minPicks: 10, kols: 3, active: 4, picks: 40 });
    expect(t.median.r2x).toBeCloseTo(30);
    expect(t.mean.r2x).toBeCloseTo((10 + 30 + 90) / 3);
    expect(t.median.r4x).toBeCloseTo(15);
    expect(t.median.r10x).toBe(0);
    expect(t.mean.r10x).toBeCloseTo(40 / 3);
  });

  it("averages the middle two on an even count, and has nothing with no KOL past the floor", () => {
    expect(typicalKol([kol(10, 2), kol(10, 4)], 3, 6).median.r2x).toBeCloseTo(30);
    // 10x only from KOLs with a settled pick.
    expect(typicalKol([kol(10, 2, 0), kol(10, 4, 5, 1)], 3, 6).median.r10x).toBeCloseTo(20);
    const none = typicalKol([kol(2, 1)], 1, 3);
    expect(none).toMatchObject({ kols: 0, active: 1, picks: 0 });
    expect(none.median).toEqual({ r2x: null, r4x: null, r10x: null });
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = "vskols";
const KOL = `${TAG}Kol1111111111111111111111111111111`;
const SIDE = `${TAG}Side111111111111111111111111111111`;

async function cleanup() {
  await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  await prisma.kolWallet.deleteMany({ where: { wallet: { in: [KOL, SIDE] } } });
}

describe.skipIf(!dbAvailable)("readKolCalls", () => {
  const now = Date.now();
  beforeAll(async () => {
    await cleanup();
    await prisma.kolWallet.createMany({
      data: [
        { wallet: KOL, name: "Tester", twitter: "tester", seenAt: new Date() },
        { wallet: SIDE, name: "Tester", seenAt: new Date(), mainWallet: KOL },
      ],
    });
    // anchor: when our clock started; buy: minutes from the anchor the KOL bought (negative = before).
    const coins = [
      { won: true, anchor: now - HOUR, buy: -2, dq: false },
      { won: false, anchor: now - 2 * HOUR, buy: 0, dq: false },
      // Bought after the clock started: the coin may already have run, so it isn't a call.
      { won: true, anchor: now - 3 * HOUR, buy: 5, dq: false },
      // A 2x after the stop: graded a loss.
      { won: true, anchor: now - 4 * HOUR, buy: -1, dq: true },
      // Graded under an older rule: not a call either way (the models' side reads the same bound).
      { won: true, anchor: now - 5 * HOUR, buy: -1, dq: false, labelRule: 2 },
    ];
    for (const [i, c] of coins.entries()) {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${i}`, symbol: `VK${i}` } });
      const outcome = await prisma.candidateOutcome.create({
        data: {
          tokenId: token.id,
          anchorAt: new Date(c.anchor),
          anchorPriceUsd: 1,
          anchorMcapUsd: 1,
          features: {},
          nextCheckAt: new Date(c.anchor),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          hit2xIn1h: c.won,
          hit4xIn1h: c.won,
          hit10xIn1h: c.won ? false : null,
          disqualified: c.dq,
          ...("labelRule" in c ? { labelRule: c.labelRule } : {}),
        },
      });
      await prisma.tokenTradeTape.create({
        data: {
          tokenId: token.id,
          outcomeId: outcome.id,
          anchorAt: new Date(c.anchor),
          reason: "called",
          status: "done",
          windowEnd: new Date(c.anchor + HOUR),
        },
      });
      const buy = new Date(c.anchor + c.buy * 60_000);
      await prisma.tokenWalletActivity.createMany({
        data: [
          { tokenId: token.id, wallet: KOL, buys: 1, solIn: 1, tokensBought: 100, firstBuyAt: buy },
          // The Known Side bought coin 0 too: still one call, on the KOL.
          ...(i === 0
            ? [{ tokenId: token.id, wallet: SIDE, buys: 1, solIn: 1, tokensBought: 50, firstBuyAt: buy }]
            : []),
        ],
      });
    }
  });
  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it("counts coins bought before the clock started, Known Sides folded into their KOL", async () => {
    const calls = (await readKolCalls(new Date(now - 7 * 24 * HOUR))).filter((c) => c.mint.startsWith(TAG));
    expect(calls.map((c) => c.mint).sort()).toEqual([`${TAG}-0`, `${TAG}-1`, `${TAG}-3`]);
    expect(calls.every((c) => c.who === KOL)).toBe(true);
    const [week] = windowTiers(calls, now, [7]);
    expect(week).toMatchObject({ calls: 3, graded: 3, won2x: 1, won4x: 1, won10x: 0, tenXGraded: 3 });
  });
});

describe.skipIf(!dbAvailable)("createModelsVsKolsCache keepWarm", () => {
  afterEach(() => vi.useRealTimers());

  it("fills once at startup, then only while read lately", async () => {
    const report = createModelsVsKolsCache(loadEnv());
    const fills = () =>
      cacheReport()
        .filter((r) => r.name === "models vs kols")
        .reduce((n, r) => n + r.fills, 0);
    // Far ahead: the cache counts as due on each pass, so only the read rule decides.
    const AHEAD = 365 * 86_400_000;
    const before = fills();
    await report.keepWarm(AHEAD);
    const first = fills();
    expect(first).toBe(before + 1);
    // Nobody read it: left alone.
    await report.keepWarm(AHEAD);
    expect(fills()).toBe(first);
    // Read: kept warm.
    await report();
    const read = fills();
    await report.keepWarm(AHEAD);
    expect(fills()).toBe(read + 1);
    // An hour on with no further read, let go again.
    vi.useFakeTimers({ now: Date.now() + READ_KEEPS_WARM_MS + 1, toFake: ["Date"] });
    const later = fills();
    await report.keepWarm(AHEAD);
    expect(fills()).toBe(later);
  }, 60_000);
});
