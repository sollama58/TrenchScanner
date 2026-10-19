import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "../db.js";
import {
  ASDF_PRICE_KEEP_MS,
  asdfPriceFrom,
  asdfRawPerSol,
  sampleAsdfPrice,
  type AsdfPriceReader,
  type AsdfPriceSampleRow,
} from "./asdfPrice.js";
import { SUBSCRIPTION_MINT } from "./constants.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const NOW = new Date("2026-10-18T21:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** A sample from each source every 15 s over the last `minutes`, at `asdfPerSol`. */
function steady(minutes: number, asdfPerSol: number, startMsAgo = 0): AsdfPriceSampleRow[] {
  const rows: AsdfPriceSampleRow[] = [];
  for (let ms = startMsAgo; ms < startMsAgo + minutes * 60_000; ms += 15_000) {
    rows.push({ at: ago(ms), source: "quote", asdfPerSol }, { at: ago(ms), source: "price", asdfPerSol });
  }
  return rows;
}

describe("asdfPriceFrom", () => {
  it("charges at the higher ASDF per SOL of the 5-minute and 24-hour medians", () => {
    // A pump in the last 5 minutes (fewer ASDF a SOL) doesn't cut the Sacrifice: the day's wins.
    const pumped = [...steady(5, 600_000), ...steady(60, 740_000, 5 * 60_000)];
    const state = asdfPriceFrom(pumped, NOW);
    expect(state.refusal).toBeNull();
    expect(state.shortMedian).toBe(600_000);
    expect(state.longMedian).toBe(740_000);
    expect(state.asdfPerSol).toBe(740_000);
    // A dump in the last 5 minutes (more ASDF a SOL) charges at the dump.
    const dumped = [...steady(5, 900_000), ...steady(60, 740_000, 5 * 60_000)];
    expect(asdfPriceFrom(dumped, NOW).asdfPerSol).toBe(900_000);
  });

  it("takes the middle of an even count as the mean of the two", () => {
    const rows = [...steady(5, 700_000)];
    rows[0] = { ...rows[0]!, asdfPerSol: 1 };
    rows[1] = { ...rows[1]!, asdfPerSol: 10_000_000 };
    expect(asdfPriceFrom(rows, NOW).shortMedian).toBe(700_000);
  });

  it("refuses with under 10 samples in the window", () => {
    const state = asdfPriceFrom(steady(1, 740_000).slice(0, 8), NOW);
    expect(state).toMatchObject({ asdfPerSol: null, refusal: "few_samples", samples: 8 });
  });

  it("keeps the newest sample's price for 10 minutes while the sampler is paused", () => {
    // A worker deploy: no sample for 8 minutes, and the price as of the last one still stands.
    expect(asdfPriceFrom(steady(5, 740_000, 8 * 60_000), NOW)).toMatchObject({
      asdfPerSol: 740_000,
      refusal: null,
      samples: 40,
    });
    // One source stopped a while before the pause: still refused.
    const rows = [
      ...steady(5, 740_000, 10 * 60_000),
      ...steady(2, 740_000, 8 * 60_000).filter((r) => r.source === "quote"),
    ];
    expect(asdfPriceFrom(rows, NOW)).toMatchObject({ asdfPerSol: null, refusal: "source_down" });
  });

  it("refuses when the newest sample is over 10 minutes old", () => {
    expect(asdfPriceFrom(steady(5, 740_000, 11 * 60_000), NOW)).toMatchObject({
      asdfPerSol: null,
      refusal: "stale",
    });
  });

  it("refuses when one source has stopped answering", () => {
    const rows = [
      ...steady(5, 740_000, 2 * 60_000),
      ...steady(2, 740_000).filter((r) => r.source === "quote"),
    ];
    expect(asdfPriceFrom(rows, NOW)).toMatchObject({ asdfPerSol: null, refusal: "source_down" });
  });

  it("refuses when the two sources are more than 5% apart", () => {
    const rows = [
      ...steady(5, 740_000, 15_000),
      { at: NOW, source: "quote", asdfPerSol: 740_000 },
      { at: NOW, source: "price", asdfPerSol: 790_000 },
    ];
    expect(asdfPriceFrom(rows, NOW)).toMatchObject({ asdfPerSol: null, refusal: "sources_apart" });
    rows[rows.length - 1] = { at: NOW, source: "price", asdfPerSol: 770_000 };
    expect(asdfPriceFrom(rows, NOW).refusal).toBeNull();
  });

  it("ignores samples from the future and past the 24-hour window", () => {
    const rows = [
      ...steady(5, 740_000),
      { at: ago(25 * 60 * 60_000), source: "quote", asdfPerSol: 5_000_000 },
      { at: new Date(NOW.getTime() + 60_000), source: "quote", asdfPerSol: 5_000_000 },
    ];
    expect(asdfPriceFrom(rows, NOW).asdfPerSol).toBe(740_000);
  });
});

describe("asdfRawPerSol", () => {
  it("is base units of ASDF per SOL", () => {
    expect(asdfRawPerSol(740_000)).toBe(740_000_000_000n);
    expect(asdfRawPerSol(740_000.1234567)).toBe(740_000_123_457n);
  });
});

describe.skipIf(!dbAvailable)("sampleAsdfPrice", () => {
  const at = new Date("2001-01-01T00:00:00Z");
  afterAll(async () => {
    await prisma.asdfPriceSample.deleteMany({ where: { at: { lte: at } } });
  });

  const reader = (opts: { quote?: boolean; price?: boolean }): AsdfPriceReader => ({
    quote: async () => {
      if (!opts.quote) throw new Error("Jupiter down");
      return { outAmount: "740000000000" };
    },
    pricesUsd: async () => {
      if (!opts.price) throw new Error("prices down");
      return new Map([
        ["So11111111111111111111111111111111111111112", 101],
        [SUBSCRIPTION_MINT, 0.000137],
      ]);
    },
  });

  it("writes a sample from each source that answers and prunes the old ones", async () => {
    await prisma.asdfPriceSample.create({
      data: { at: new Date(at.getTime() - ASDF_PRICE_KEEP_MS - 1), source: "quote", asdfPerSol: 1 },
    });
    const both = await sampleAsdfPrice(reader({ quote: true, price: true }), at);
    expect(both.quote).toBe(740_000);
    expect(both.price).toBeCloseTo(101 / 0.000137);
    const rows = await prisma.asdfPriceSample.findMany({
      where: { at: { lte: at } },
      orderBy: { source: "asc" },
    });
    expect(rows.map((r) => [r.source, r.at.getTime()])).toEqual([
      ["price", at.getTime()],
      ["quote", at.getTime()],
    ]);
  });

  it("keeps sampling with one source down, and throws with both down", async () => {
    const later = new Date(at.getTime() - 15_000);
    expect(await sampleAsdfPrice(reader({ quote: true }), later)).toEqual({ quote: 740_000, price: null });
    await expect(sampleAsdfPrice(reader({}), later)).rejects.toThrow(/neither/);
  });
});
