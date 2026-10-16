import { beforeEach, describe, expect, it } from "vitest";
import {
  HOLDER_LIST_REWRITE_MS,
  holderListKey,
  noteHolderListWritten,
  resetHolderListWritesForTests,
  shouldWriteHolderList,
} from "./holderListWrites.js";
import { snapshotDataFor } from "./snapshotData.js";
import type { ScoredToken } from "@trenchscanner/core";

const T0 = 1_760_000_000_000;
type HolderList = NonNullable<ScoredToken["linkedHolders"]>;
const list = (pct = 4.2): HolderList => [
  { wallet: "A".repeat(44), pct, cexFunder: "Binance" },
  { wallet: "B".repeat(44), pct: 1.1, sniper: true },
];

describe("shouldWriteHolderList", () => {
  beforeEach(() => resetHolderListWritesForTests());

  it("writes a coin's first list, then not the same one again within the rewrite window", () => {
    expect(shouldWriteHolderList("t1", list(), T0)).toBe(true);
    noteHolderListWritten("t1", list(), T0);
    expect(shouldWriteHolderList("t1", list(), T0 + 30_000)).toBe(false);
    expect(shouldWriteHolderList("t1", list(), T0 + HOLDER_LIST_REWRITE_MS - 1)).toBe(false);
  });

  it("writes again once the last written list is HOLDER_LIST_REWRITE_MS old", () => {
    noteHolderListWritten("t1", list(), T0);
    expect(shouldWriteHolderList("t1", list(), T0 + HOLDER_LIST_REWRITE_MS)).toBe(true);
  });

  it("writes a changed reading at once: a share, a tag or a wallet", () => {
    noteHolderListWritten("t1", list(), T0);
    expect(shouldWriteHolderList("t1", list(4.3), T0 + 1_000)).toBe(true);
    const tagged = list();
    tagged[1] = { ...tagged[1]!, fresh: true };
    expect(shouldWriteHolderList("t1", tagged, T0 + 1_000)).toBe(true);
    expect(shouldWriteHolderList("t1", list().slice(0, 1), T0 + 1_000)).toBe(true);
  });

  it("has nothing to write for a missing or empty list, and keeps the record for the next one", () => {
    noteHolderListWritten("t1", list(), T0);
    expect(shouldWriteHolderList("t1", undefined, T0 + 1_000)).toBe(false);
    expect(shouldWriteHolderList("t1", [], T0 + 1_000)).toBe(false);
    expect(shouldWriteHolderList("t1", list(), T0 + 2_000)).toBe(false);
  });

  it("tracks coins apart", () => {
    noteHolderListWritten("t1", list(), T0);
    expect(shouldWriteHolderList("t2", list(), T0 + 1_000)).toBe(true);
  });

  it("keys a list by its holders, shares and tags in order", () => {
    expect(holderListKey(list())).toBe(holderListKey(list()));
    expect(holderListKey(list())).not.toBe(holderListKey([...list()].reverse()));
    expect(holderListKey([{ wallet: "A", pct: 1 }])).toBe(
      holderListKey([{ wallet: "A", pct: 1, sniper: undefined }]),
    );
  });
});

describe("snapshotDataFor: the holder list", () => {
  const scored = {
    priceUsd: 1,
    marketCapUsd: 1,
    score: { total: 0, momentum: 0, holderHealth: 0, age: 0, narrative: 0 },
    rugScreen: { passed: true, reasons: [] },
    linkedHolders: list(),
  } as unknown as ScoredToken;

  it("carries the list by default and when asked to", () => {
    expect(snapshotDataFor("t1", scored, "scan").linkedHolders).toEqual(list());
    expect(snapshotDataFor("t1", scored, "scan", { linkedHolders: true }).linkedHolders).toEqual(list());
  });

  it("leaves the list off when the writer says it is unchanged", () => {
    expect(snapshotDataFor("t1", scored, "scan", { linkedHolders: false }).linkedHolders).toBeUndefined();
  });
});
