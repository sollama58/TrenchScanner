import { beforeEach, describe, expect, it } from "vitest";
import {
  HOLDER_LIST_REWRITE_MS,
  holderClockFields,
  holderListKey,
  holderReadingData,
  holderReadingKey,
  noteHolderReadingWritten,
  resetHolderListWritesForTests,
  shouldWriteHolderReading,
  type HolderReading,
} from "./holderListWrites.js";
import { snapshotDataFor } from "./snapshotData.js";
import type { ScoredToken } from "@trenchscanner/core";

const T0 = 1_760_000_000_000;
type HolderList = NonNullable<ScoredToken["linkedHolders"]>;
const list = (pct = 4.2): HolderList => [
  { wallet: "A".repeat(44), pct, cexFunder: "Binance" },
  { wallet: "B".repeat(44), pct: 1.1, sniper: true },
];
const clusters = (pct = 5.3): NonNullable<ScoredToken["linkedClusters"]> => [
  {
    funder: "F".repeat(44),
    wallets: [
      { wallet: "A".repeat(44), pct: 4.2 },
      { wallet: "B".repeat(44), pct: 1.1 },
    ],
    pct,
    creatorLinked: false,
  },
];
const groups = (): NonNullable<ScoredToken["sameTimeClusters"]> => [
  {
    atMs: T0 - 60_000,
    spanMs: 20_000,
    wallets: [
      { wallet: "A".repeat(44), pct: 4.2, fundedAtMs: T0 - 60_000, funder: "F".repeat(44) },
      { wallet: "B".repeat(44), pct: 1.1, fundedAtMs: T0 - 40_000, funder: null },
    ],
    pct: 5.3,
  },
];
const reading = (pct = 4.2): HolderReading => ({
  linkedHolders: list(pct),
  linkedClusters: clusters(),
  sameTimeClusters: groups(),
});

describe("shouldWriteHolderReading", () => {
  beforeEach(() => resetHolderListWritesForTests());

  it("writes a coin's first reading, then not the same one again within the rewrite window", () => {
    expect(shouldWriteHolderReading("t1", reading(), T0)).toBe(true);
    noteHolderReadingWritten("t1", reading(), T0);
    expect(shouldWriteHolderReading("t1", reading(), T0 + 30_000)).toBe(false);
    expect(shouldWriteHolderReading("t1", reading(), T0 + HOLDER_LIST_REWRITE_MS - 1)).toBe(false);
  });

  it("writes again once the last written reading is HOLDER_LIST_REWRITE_MS old", () => {
    noteHolderReadingWritten("t1", reading(), T0);
    expect(shouldWriteHolderReading("t1", reading(), T0 + HOLDER_LIST_REWRITE_MS)).toBe(true);
  });

  it("writes an unchanged reading at a watched coin's own pace when one is given", () => {
    noteHolderReadingWritten("t1", reading(), T0);
    expect(shouldWriteHolderReading("t1", reading(), T0 + 59_999, 60_000)).toBe(false);
    expect(shouldWriteHolderReading("t1", reading(), T0 + 60_000, 60_000)).toBe(true);
  });

  it("writes a changed reading at once: a share, a tag or a wallet of the list", () => {
    noteHolderReadingWritten("t1", reading(), T0);
    expect(shouldWriteHolderReading("t1", reading(4.3), T0 + 1_000)).toBe(true);
    const tagged = reading();
    tagged.linkedHolders![1] = { ...tagged.linkedHolders![1]!, fresh: true };
    expect(shouldWriteHolderReading("t1", tagged, T0 + 1_000)).toBe(true);
    expect(
      shouldWriteHolderReading("t1", { ...reading(), linkedHolders: list().slice(0, 1) }, T0 + 1_000),
    ).toBe(true);
  });

  it("writes a changed cluster or same-minute group at once, with the same list", () => {
    noteHolderReadingWritten("t1", reading(), T0);
    expect(shouldWriteHolderReading("t1", { ...reading(), linkedClusters: clusters(6) }, T0 + 1_000)).toBe(
      true,
    );
    expect(shouldWriteHolderReading("t1", { ...reading(), linkedClusters: [] }, T0 + 1_000)).toBe(true);
    expect(shouldWriteHolderReading("t1", { ...reading(), sameTimeClusters: [] }, T0 + 1_000)).toBe(true);
    // A reading with the list alone, then the same list with clusters: two readings.
    noteHolderReadingWritten("t2", { linkedHolders: list() }, T0);
    expect(shouldWriteHolderReading("t2", { linkedHolders: list() }, T0 + 1_000)).toBe(false);
    expect(
      shouldWriteHolderReading("t2", { linkedHolders: list(), linkedClusters: clusters() }, T0 + 1_000),
    ).toBe(true);
  });

  it("has nothing to write for a reading with no list, and keeps the record for the next one", () => {
    noteHolderReadingWritten("t1", reading(), T0);
    expect(shouldWriteHolderReading("t1", {}, T0 + 1_000)).toBe(false);
    expect(shouldWriteHolderReading("t1", { linkedHolders: [], linkedClusters: [] }, T0 + 1_000)).toBe(false);
    expect(shouldWriteHolderReading("t1", reading(), T0 + 2_000)).toBe(false);
    // Clusters alone are still a list to carry.
    expect(shouldWriteHolderReading("t3", { linkedClusters: clusters() }, T0)).toBe(true);
  });

  it("tracks coins apart", () => {
    noteHolderReadingWritten("t1", reading(), T0);
    expect(shouldWriteHolderReading("t2", reading(), T0 + 1_000)).toBe(true);
  });

  it("keys a list by its holders, shares and tags in order, and a reading by its three lists", () => {
    expect(holderListKey(list())).toBe(holderListKey(list()));
    expect(holderListKey(list())).not.toBe(holderListKey([...list()].reverse()));
    expect(holderListKey([{ wallet: "A", pct: 1 }])).toBe(
      holderListKey([{ wallet: "A", pct: 1, sniper: undefined }]),
    );
    expect(holderReadingKey(reading())).toBe(holderReadingKey(reading()));
    expect(holderReadingKey({ linkedHolders: list() })).toBe(
      holderReadingKey({ linkedHolders: list(), linkedClusters: [] }),
    );
    expect(holderReadingKey({ linkedHolders: list() })).not.toBe(holderReadingKey(reading()));
  });
});

describe("snapshotDataFor: the holder reading", () => {
  const scored = {
    priceUsd: 1,
    marketCapUsd: 1,
    score: { total: 0, momentum: 0, holderHealth: 0, age: 0, narrative: 0 },
    rugScreen: { passed: true, reasons: [] },
    ...reading(),
  } as unknown as ScoredToken;

  it("carries the three lists by default and when asked to", () => {
    for (const data of [
      snapshotDataFor("t1", scored, "scan"),
      snapshotDataFor("t1", scored, "fast"),
      snapshotDataFor("t1", scored, "scan", { holderReading: true }),
    ]) {
      expect(data.linkedHolders).toEqual(list());
      expect(data.linkedClusters).toEqual(clusters());
      expect(data.sameTimeClusters).toEqual(groups());
    }
  });

  it("records which source the market figures came from, null on a reading without one", () => {
    expect(snapshotDataFor("t1", scored, "scan").marketSource).toBeNull();
    expect(
      snapshotDataFor("t1", { ...scored, marketSource: "dexscreener_live" } as ScoredToken, "fast")
        .marketSource,
    ).toBe("dexscreener_live");
  });

  it("leaves the three lists off when the writer says the reading is unchanged", () => {
    const data = snapshotDataFor("t1", scored, "scan", { holderReading: false });
    expect(data.linkedHolders).toBeUndefined();
    expect(data.linkedClusters).toBeUndefined();
    expect(data.sameTimeClusters).toBeUndefined();
    // The reading's numbers still ride every row.
    expect(data.priceUsd).toBe(1);
  });

  it("copies both holder clocks with the lists and does not turn a balance into the enumeration", () => {
    const balances = new Date("2026-10-21T18:04:00.000Z");
    const chain = new Date("2026-10-21T18:00:00.000Z");
    const next = new Date("2026-10-21T18:05:00.000Z");
    const clocks = holderClockFields({
      holderBalancesAt: balances,
      holderChainReadAt: chain,
      holderNextReadAt: next,
    });
    expect(clocks).toEqual({ holderBalancesAt: balances, holderChainReadAt: chain, holderNextReadAt: next });
    // A balance tick has a share time and no new enumeration. The chain clock stays absent.
    expect(holderClockFields({ holderBalancesAt: balances })).toEqual({ holderBalancesAt: balances });
    const data = holderReadingData({ ...reading(), holderBalancesAt: balances, holderChainReadAt: chain });
    expect(data.linkedHolders).toEqual(list());
    expect(data.holderBalancesAt).toEqual(balances);
    expect(data.holderChainReadAt).toEqual(chain);
    const row = snapshotDataFor(
      "t1",
      { ...scored, holderBalancesAt: balances, holderChainReadAt: chain } as ScoredToken,
      "fast",
    );
    expect(row.holderBalancesAt).toEqual(balances);
    expect(row.holderChainReadAt).toEqual(chain);
    const bare = snapshotDataFor(
      "t1",
      { ...scored, holderBalancesAt: balances, holderChainReadAt: chain } as ScoredToken,
      "scan",
      { holderReading: false },
    );
    expect(bare.holderBalancesAt).toBeUndefined();
    expect(bare.holderChainReadAt).toBeUndefined();
  });

  it("stores no empty list", () => {
    const bare = { ...scored, linkedClusters: [], sameTimeClusters: undefined } as unknown as ScoredToken;
    const data = snapshotDataFor("t1", bare, "scan");
    expect(data.linkedHolders).toEqual(list());
    expect(data.linkedClusters).toBeUndefined();
    expect(data.sameTimeClusters).toBeUndefined();
  });
});
