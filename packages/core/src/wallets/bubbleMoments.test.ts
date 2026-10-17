import { describe, expect, it } from "vitest";
import { bubbleReadingOf, packBubbleReading, unpackBubbleReading } from "./bubbleMoments.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const w = (seed: number) => Array.from({ length: 44 }, (_, i) => B58[(seed * 31 + i * 7) % 58]).join("");

const holders = Array.from({ length: 25 }, (_, i) => ({
  wallet: w(i),
  pct: Math.round((9 / (i + 1)) * 100) / 100,
  ...(i % 4 === 0 ? { cexFunder: w(100 + (i % 2)) } : {}),
  ...(i === 1 ? { sniper: true } : {}),
  ...(i === 2 ? { fresh: true, empty: true } : {}),
  ...(i === 4 ? { creatorTied: true } : {}),
}));
const reading = {
  linkedHolders: holders,
  linkedClusters: [
    {
      funder: w(200),
      wallets: [
        { wallet: w(3), pct: 3 },
        { wallet: w(5), pct: 1.5 },
      ],
      pct: 4.5,
      creatorLinked: false,
      transfers: 1,
    },
    { funder: w(4), wallets: [{ wallet: w(4), pct: 2.25 }], pct: 2.25, creatorLinked: true },
  ],
  sameTimeClusters: [
    {
      atMs: 1_792_100_000_000,
      spanMs: 41_000,
      wallets: [
        { wallet: w(7), pct: 1.29, fundedAtMs: 1_792_100_000_000, funder: w(201) },
        { wallet: w(8), pct: 1.13, fundedAtMs: 1_792_100_041_000, funder: null },
      ],
      pct: 2.42,
    },
  ],
  holderTransfers: [
    { from: w(1), to: w(9), pct: 0.84, count: 2, lastAtMs: 1_792_100_500_000 },
    { from: w(2), to: w(10), pct: 0.1, count: 1 },
  ],
  linkedClustersExTransfers: [
    { funder: w(4), wallets: [{ wallet: w(4), pct: 2.25 }], pct: 2.25, creatorLinked: true },
  ],
  bundledSupplyPct: 4.1,
  linkedWalletPctExTransfers: 6.75,
  linkedWalletPct: 9.17,
  linkedWalletCount: 5,
  linkedWalletsChecked: 25,
  top10HolderPct: 26.4,
  cexFundedCount: 7,
  kolBundledPct: 0,
  linkedCreatorPct: 2.25,
};

describe("bubbleReadingOf", () => {
  it("keeps the map's lists and numbers, and leaves out unknowns and empties", () => {
    const r = bubbleReadingOf({
      ...reading,
      sameTimeClusters: [],
      cexFundedPct: undefined,
      transferWalletCount: NaN,
    });
    expect(r).not.toBeNull();
    expect(r).not.toHaveProperty("sameTimeClusters");
    expect(r).not.toHaveProperty("cexFundedPct");
    expect(r).not.toHaveProperty("transferWalletCount");
    expect(r!.kolBundledPct).toBe(0);
  });

  it("has nothing to keep without a holder list", () => {
    expect(bubbleReadingOf({ linkedHolders: null, linkedWalletPct: 3 })).toBeNull();
    expect(bubbleReadingOf({ linkedHolders: [] })).toBeNull();
  });
});

describe("packBubbleReading", () => {
  it("unpacks to the reading it packed", () => {
    const r = bubbleReadingOf(reading)!;
    expect(unpackBubbleReading(packBubbleReading(r))).toEqual(r);
  });

  it("keeps an empty list of clusters without transfers, and none when the reading had none", () => {
    const r = bubbleReadingOf({ ...reading, linkedClustersExTransfers: [] })!;
    expect(r.linkedClustersExTransfers).toEqual([]);
    expect(unpackBubbleReading(packBubbleReading(r))!.linkedClustersExTransfers).toEqual([]);
    const none = bubbleReadingOf({ ...reading, linkedClustersExTransfers: undefined })!;
    expect(unpackBubbleReading(packBubbleReading(none))).not.toHaveProperty("linkedClustersExTransfers");
  });

  it("writes each address once and is well under the reading as JSON", () => {
    const r = bubbleReadingOf(reading)!;
    const packed = packBubbleReading(r);
    expect(packed.split(w(3)).length - 1).toBe(1);
    expect(packed.length).toBeLessThan(JSON.stringify(r).length * 0.6);
  });

  it("packs the same reading to the same text", () => {
    const r = bubbleReadingOf(reading)!;
    const shuffled = bubbleReadingOf(Object.fromEntries(Object.entries(reading).reverse()))!;
    expect(packBubbleReading(shuffled)).toBe(packBubbleReading(r));
  });

  it("reads nothing from text in no shape it knows", () => {
    expect(unpackBubbleReading(null)).toBeNull();
    expect(unpackBubbleReading("not json")).toBeNull();
    expect(unpackBubbleReading(JSON.stringify({ v: 99, a: [], h: [] }))).toBeNull();
    expect(unpackBubbleReading(JSON.stringify({ v: 1, a: [], h: [] }))).toBeNull();
  });
});
