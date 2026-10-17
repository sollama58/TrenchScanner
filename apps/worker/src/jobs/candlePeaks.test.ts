// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError, prisma, type MinuteCandle } from "@trenchscanner/core";
import { enrolPeakWatches, resetPeakWatchEnrolment, runCandlePeaksJob } from "./candlePeaks.js";
import { recordCuratedPeaks } from "./curatedPeaks.js";
import { recordMatchPeaks } from "./matchPeaks.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `candlepeaks-test-${Date.now()}`;

/** Minute candles from `startMs`, one a minute, closing at `closes` (USD per token). */
const minutes = (startMs: number, closes: number[]): MinuteCandle[] =>
  closes.map((close, i) => ({ startMs: startMs + i * MIN, close }));

describe.skipIf(!dbAvailable)("runCandlePeaksJob", () => {
  let userId: string;
  let filterId: string;
  const candlesByMint = new Map<string, MinuteCandle[] | null | Error>();
  const pumpFun = {
    minuteCandles: async (mint: string) => {
      const c = candlesByMint.get(mint);
      if (c instanceof Error) throw c;
      return c === undefined ? null : c;
    },
  };
  /** Runs the job over just this test's coins: due now, read now. */
  const run = (nowMs = Date.now()) =>
    runCandlePeaksJob(pumpFun, { trackingDays: 14, coinsPerRun: 500, spacingMs: 0, now: () => nowMs });

  beforeAll(async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-wallet` } });
    userId = user.id;
    filterId = (
      await prisma.userFilter.create({ data: { userId, name: TAG, mcapMin: 10_000, mcapMax: 1_000_000 } })
    ).id;
  });

  beforeEach(() => resetPeakWatchEnrolment());

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.match.deleteMany({ where: { userId } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.userFilter.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  /** A coin alerted `hoursAgo` at $10k (price 1e-5 on a 1B supply) by a model call and a filter. */
  async function seedCoin(
    name: string,
    hoursAgo: number,
    opts: { callPeak?: number; matchPeak?: number } = {},
  ) {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${name}`, symbol: name } });
    const at = new Date(Date.now() - hoursAgo * HOUR);
    const call = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        confidence: 70,
        anchorPriceUsd: 1e-5,
        anchorMcapUsd: 10_000,
        createdAt: at,
        peakMcapUsd: opts.callPeak ?? null,
        peakMcapAt: opts.callPeak ? at : null,
      },
    });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, takenAt: at, priceUsd: 1e-5, marketCapUsd: 10_000, score: 70 },
    });
    const match = await prisma.match.create({
      data: {
        userId,
        filterId,
        tokenId: token.id,
        snapshotId: snapshot.id,
        matchedAt: at,
        score: 70,
        peakMcapUsd: opts.matchPeak ?? null,
        peakMcapAt: opts.matchPeak ? at : null,
        peakReturnPct: opts.matchPeak ? (opts.matchPeak / 10_000 - 1) * 100 : null,
        hitHundredPctAt: opts.matchPeak && opts.matchPeak >= 20_000 ? at : null,
      },
    });
    return { token, call, match, at };
  }

  const callOf = (id: string) => prisma.curatedAlert.findUniqueOrThrow({ where: { id } });
  const matchOf = (id: string) => prisma.match.findUniqueOrThrow({ where: { id } });

  it("sets a late runner's Peak from its trades, days after the readings stopped", async () => {
    // Glow, 2026-10-14: 1.3x on its first day, then 77x on day two - the card stayed at 1.3x.
    const { token, call, match, at } = await seedCoin("late", 40, { callPeak: 13_000, matchPeak: 13_000 });
    candlesByMint.set(token.mintAddress, [
      ...minutes(at.getTime() - 5 * MIN, [1e-5, 1e-5, 1e-5, 1e-5, 1e-5, 1.1e-5, 1.3e-5, 1.2e-5]),
      ...minutes(at.getTime() + 30 * HOUR, [2e-5, 4e-4, 7.7e-4, 3e-4]),
    ]);
    const meta = await run();
    expect(meta).toMatchObject({ throttled: false });

    const c = await callOf(call.id);
    expect(c.peakMcapUsd).toBeCloseTo(770_000);
    expect(c.peakMcapAt).toEqual(new Date(at.getTime() + 30 * HOUR + 3 * MIN));
    expect(c.peakCheckedAt).not.toBeNull();
    const m = await matchOf(match.id);
    expect(m.peakMcapUsd).toBeCloseTo(770_000);
    expect(m.peakReturnPct).toBeCloseTo(7600);
    // Leaderboard-eligible, dated to when the coin got there.
    expect(m.hitHundredPctAt).toEqual(m.peakMcapAt);

    const watch = await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(watch.athMcapUsd).toBeCloseTo(770_000);
    expect(watch.candlesTrusted).toBe(true);
    // Last traded ten hours ago: read again in an hour.
    expect(watch.nextCheckAt.getTime() - watch.lastCheckedAt!.getTime()).toBe(HOUR);
  });

  it("corrects a stale reading's peak, takes back its Leaderboard 2x, and keeps it from coming back", async () => {
    // A frozen graduation curve read the coin at $43k while it traded at $2k.
    const { token, call, match, at } = await seedCoin("stale", 3, { callPeak: 43_000, matchPeak: 43_000 });
    candlesByMint.set(
      token.mintAddress,
      minutes(at.getTime() - 2 * MIN, [1e-5, 1e-5, 1.2e-5, 0.4e-5, 0.2e-5]),
    );
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: token.id,
        takenAt: new Date(at.getTime() + HOUR),
        priceUsd: 4.3e-5,
        marketCapUsd: 43_000,
      },
    });
    await run();

    expect((await callOf(call.id)).peakMcapUsd).toBeCloseTo(12_000);
    const m = await matchOf(match.id);
    expect(m.peakMcapUsd).toBeCloseTo(12_000);
    expect(m.peakReturnPct).toBeCloseTo(20);
    expect(m.hitHundredPctAt).toBeNull();

    // The readings' passes leave a candle-kept row alone, so the stale $43k doesn't come back.
    await recordCuratedPeaks(30);
    await recordMatchPeaks(30);
    expect((await callOf(call.id)).peakMcapUsd).toBeCloseTo(12_000);
    expect((await matchOf(match.id)).peakMcapUsd).toBeCloseTo(12_000);
  });

  it("clears the peak of a coin that never traded above its alert", async () => {
    const { token, call, at } = await seedCoin("rug", 2, { callPeak: 13_200 });
    candlesByMint.set(token.mintAddress, minutes(at.getTime() - MIN, [1e-5, 0.3e-5, 0.1e-5]));
    await run();
    const c = await callOf(call.id);
    expect(c.peakMcapUsd).toBeNull();
    expect(c.peakMcapAt).toBeNull();
  });

  it("leaves alerts alone when the candles are not the alert's market, and coins Pump.fun doesn't know", async () => {
    const odd = await seedCoin("odd", 2, { callPeak: 15_000 });
    // 4x the alert price at the alert: another quote coin's prices.
    candlesByMint.set(odd.token.mintAddress, minutes(odd.at.getTime() - MIN, [4e-5, 9e-5]));
    const none = await seedCoin("none", 2, { callPeak: 15_000 });
    await run();
    expect((await callOf(odd.call.id)).peakMcapUsd).toBe(15_000);
    expect((await callOf(odd.call.id)).peakCheckedAt).toBeNull();
    expect(
      (await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: odd.token.id } })).candlesTrusted,
    ).toBe(false);
    expect((await callOf(none.call.id)).peakMcapUsd).toBe(15_000);
    expect((await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: none.token.id } })).noCandles).toBe(
      true,
    );
  });

  it("only raises from a page that starts after the alert, once the coin's candles have proved themselves", async () => {
    const { token, call, at } = await seedCoin("busy", 30, { callPeak: 50_000 });
    // First read: the whole history, a 5x.
    candlesByMint.set(token.mintAddress, minutes(at.getTime() - MIN, [1e-5, 5e-5, 2e-5]));
    await run();
    expect((await callOf(call.id)).peakMcapUsd).toBeCloseTo(50_000);

    // Later: a full page of 1000 minutes that starts after the alert, topping at 3x - not lowered.
    const page = minutes(
      at.getTime() + 10 * HOUR,
      Array.from({ length: 1000 }, (_, i) => (i === 500 ? 3e-5 : 2e-5)),
    );
    candlesByMint.set(token.mintAddress, page);
    await prisma.peakWatch.update({ where: { tokenId: token.id }, data: { nextCheckAt: new Date(0) } });
    await run();
    expect((await callOf(call.id)).peakMcapUsd).toBeCloseTo(50_000);

    // A page with a new high raises it.
    page[700] = { ...page[700]!, close: 9e-5 };
    await prisma.peakWatch.update({ where: { tokenId: token.id }, data: { nextCheckAt: new Date(0) } });
    await run();
    expect((await callOf(call.id)).peakMcapUsd).toBeCloseTo(90_000);
  });

  it("keeps the coin's ATH when only a later alert's read covers the candles", async () => {
    const { token, at } = await seedCoin("realert", 72);
    // First read: the whole history, a 10x on the first alert.
    candlesByMint.set(token.mintAddress, minutes(at.getTime() - MIN, [1e-5, 1e-4, 2e-5]));
    await run();
    expect(
      (await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: token.id } })).athMcapUsd,
    ).toBeCloseTo(100_000);

    // Called again at $30k two hours ago; the page now starts after the first alert.
    const reAt = new Date(at.getTime() + 70 * HOUR);
    const reCall = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        confidence: 70,
        anchorPriceUsd: 3e-5,
        anchorMcapUsd: 30_000,
        createdAt: reAt,
      },
    });
    candlesByMint.set(
      token.mintAddress,
      minutes(reAt.getTime() - 5 * MIN, [3e-5, 3e-5, 3e-5, 3e-5, 3e-5, 3e-5, 3.3e-5]),
    );
    await prisma.peakWatch.update({ where: { tokenId: token.id }, data: { nextCheckAt: new Date(0) } });
    await run();
    expect((await callOf(reCall.id)).peakMcapUsd).toBeCloseTo(33_000);
    const watch = await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(watch.athMcapUsd).toBeCloseTo(100_000);
    expect(watch.athAt).toEqual(new Date(at.getTime() + MIN));
  });

  it("stops at Pump.fun's first 429 and tries a failed coin again soon", async () => {
    const { token, call } = await seedCoin("throttled", 1, { callPeak: 12_000 });
    candlesByMint.set(token.mintAddress, new HttpError(429, "too many"));
    const meta = await run();
    expect(meta).toMatchObject({ throttled: true });
    expect((await callOf(call.id)).peakCheckedAt).toBeNull();
    candlesByMint.set(token.mintAddress, new Error("socket hang up"));
    const now = Date.now();
    await run(now);
    const watch = await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(watch.nextCheckAt.getTime()).toBeGreaterThan(now);
    candlesByMint.set(token.mintAddress, null);
  });

  it("moves a quiet coin's next read up when it is alerted again", async () => {
    const { token, at } = await seedCoin("again", 48);
    candlesByMint.set(token.mintAddress, minutes(at.getTime() - MIN, [1e-5, 1.1e-5]));
    await run();
    const before = await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(before.nextCheckAt.getTime() - before.lastCheckedAt!.getTime()).toBe(12 * HOUR);

    await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        source: "test",
        confidence: 70,
        anchorPriceUsd: 1e-5,
        anchorMcapUsd: 10_000,
      },
    });
    await enrolPeakWatches(new Date(Date.now() - HOUR), new Date(Date.now() + 10 * MIN));
    const after = await prisma.peakWatch.findUniqueOrThrow({ where: { tokenId: token.id } });
    expect(after.nextCheckAt.getTime()).toBeLessThan(before.nextCheckAt.getTime());
    expect(after.lastAlertAt.getTime()).toBeGreaterThan(before.lastAlertAt.getTime());
  });
});
