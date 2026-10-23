// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chunkBars, prisma, saveCandleChunks } from "@trenchscanner/core";
import type { McapCandle } from "../tokenChart.js";
import { readTokenChart, setCandleFetcherForTests, setStreamFeedsForTests } from "./tokens.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `older-test-${Date.now()}`;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const address = (seed: string) =>
  Array.from({ length: 44 }, (_, i) => B58[(seed.charCodeAt(i % seed.length) * (i + 7)) % B58.length]).join(
    "",
  );
const STORED = address(`${TAG}-stored`);
const UNSTORED = address(`${TAG}-unstored`);

const FIVE = 5 * 60_000;
const launch = Math.floor((Date.now() - 3 * 86_400_000) / FIVE) * FIVE;
// The minute page starts two minutes into the bucket 300 five-minute bars after the launch.
const first = launch + 300 * FIVE + 2 * 60_000;
const bar = (t: number): McapCandle => ({ t, o: 1_000, h: 2_000, l: 500, c: 1_500, vol: 3 });
const minutes = [first, first + 60_000, first + 2 * 60_000].map(bar);
const fives = Array.from({ length: 302 }, (_, i) => bar(launch + i * FIVE));

describe.skipIf(!dbAvailable)("TokenChart.older from the candle store (price-market audit 4a-3)", () => {
  const olderAsked: string[] = [];

  beforeAll(async () => {
    setCandleFetcherForTests(
      async () => minutes,
      async () => null,
      async (mint) => {
        olderAsked.push(mint);
        return fives;
      },
    );
    setStreamFeedsForTests({ history: async () => null, recent: async () => null, solUsd: async () => null });
    for (const mint of [STORED, UNSTORED])
      await prisma.token.create({
        data: { mintAddress: mint, symbol: "OLDR", launchedAt: new Date(launch) },
      });
    // What the backfill saves of Pump.fun's 5-minute page: its closed chunks, source pumpfun.
    await saveCandleChunks(
      chunkBars(
        STORED,
        300,
        "pumpfun",
        fives.filter((k) => k.t + FIVE <= Date.now()),
        { from: launch, to: Math.floor(Date.now() / FIVE) * FIVE },
      ),
    );
  });

  afterAll(async () => {
    await prisma.candleChunk.deleteMany({ where: { mint: { in: [STORED, UNSTORED] } } });
    await prisma.token.deleteMany({ where: { mintAddress: { in: [STORED, UNSTORED] } } });
  });

  it("answers the older candles from the store without reading Pump.fun's 5-minute page", async () => {
    const chart = await readTokenChart(STORED);
    expect(olderAsked).not.toContain(STORED);
    // The bars before the minute page's first, its own bucket whole: the same as the page's.
    expect(chart.older?.map((k) => k.t)).toEqual(fives.slice(0, 301).map((k) => k.t));
    expect(chart.older?.[0]).toEqual(fives[0]);
  });

  it("reads the page for a coin the store doesn't hold, with the same answer", async () => {
    const stored = await readTokenChart(STORED);
    const chart = await readTokenChart(UNSTORED);
    expect(olderAsked).toEqual([UNSTORED]);
    expect(chart.older).toEqual(stored.older);
  });
});
