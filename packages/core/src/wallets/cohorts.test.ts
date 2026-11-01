import { describe, expect, it } from "vitest";
import { buildCohorts, cohortReading, pairJaccard } from "./cohorts.js";
import type { TapeTrade } from "./tradeTape.js";

const at = new Date("2026-11-01T00:00:00Z");

describe("buildCohorts", () => {
  it("keeps pairs with two coins and a quarter overlap, joins them into cohorts, counts the creator's coins", () => {
    const coinsOf = new Map([
      ["a", 4],
      ["b", 3],
      ["c", 5],
      ["z", 40], // a busy wallet: two coins with `a` are a coincidence among its forty
      ["d", 3],
      ["e", 3],
    ]);
    const pairs = [
      { a: "a", b: "b", tokens: ["t1", "t2", "t2"], lastAt: at }, // 2 of (4 + 3 - 2) = 0.4: kept
      { a: "b", b: "c", tokens: ["t1", "t3"], lastAt: new Date(at.getTime() + 1000) }, // 2 of 6: kept
      { a: "a", b: "z", tokens: ["t1", "t4"], lastAt: at }, // 2 of 42: a coincidence
      { a: "d", b: "e", tokens: ["t5"], lastAt: at }, // one coin: never
    ];
    const creatorOf = new Map([
      ["t1", "c"], // the cohort's own member launched t1
      ["t3", "someone-else"],
    ]);
    const { rows, pairs: kept } = buildCohorts(pairs, coinsOf, creatorOf);
    expect(kept).toEqual([
      { a: "a", b: "b", coins: 2, lastAt: at },
      { a: "b", b: "c", coins: 2, lastAt: new Date(at.getTime() + 1000) },
    ]);
    expect(rows).toEqual([
      { wallet: "a", cohortId: "a", size: 3, coins: 2, creatorCoins: 1, lastSeenAt: at },
      {
        wallet: "b",
        cohortId: "a",
        size: 3,
        coins: 3,
        creatorCoins: 1,
        lastSeenAt: new Date(at.getTime() + 1000),
      },
      {
        wallet: "c",
        cohortId: "a",
        size: 3,
        coins: 2,
        creatorCoins: 1,
        lastSeenAt: new Date(at.getTime() + 1000),
      },
    ]);
  });

  it("names a cohort by its smallest wallet whichever way the pairs arrive", () => {
    const coinsOf = new Map([
      ["x", 3],
      ["m", 3],
      ["q", 3],
    ]);
    const one = buildCohorts([{ a: "x", b: "m", tokens: ["t1", "t2"], lastAt: at }], coinsOf, new Map());
    const two = buildCohorts([{ a: "m", b: "x", tokens: ["t1", "t2"], lastAt: at }], coinsOf, new Map());
    expect(one.rows.map((r) => r.cohortId)).toEqual(["m", "m"]);
    expect(two.rows).toEqual(one.rows);
    expect(two.pairs).toEqual([{ a: "m", b: "x", coins: 2, lastAt: at }]);
  });

  it("reads the Jaccard overlap", () => {
    expect(pairJaccard(2, 4, 3)).toBeCloseTo(0.4, 6);
    expect(pairJaccard(0, 0, 0)).toBe(0);
  });
});

describe("cohortReading", () => {
  const trade = (wallet: string, side: TapeTrade["side"] = "buy"): TapeTrade => ({
    wallet,
    side,
    sol: 1,
    tokens: 1,
    atMs: 0,
    tx: `${wallet}-${side}`,
  });
  const book = new Map([
    ["a", { cohortId: "a", size: 3, creatorCoins: 0 }],
    ["b", { cohortId: "a", size: 3, creatorCoins: 0 }],
    ["k", { cohortId: "k", size: 5, creatorCoins: 2 }],
    ["dev", { cohortId: "a", size: 3, creatorCoins: 0 }],
  ]);
  const lookup = (w: string) => book.get(w);

  it("counts each buyer once, the largest cohort, and whether a cohort has a creator in it", () => {
    const trades = [trade("a"), trade("a"), trade("b", "sell"), trade("n"), trade("k")];
    expect(cohortReading(trades, lookup)).toEqual({
      cohortRecentBuyersPct: 66.7,
      cohortRecentMaxSize: 5,
      cohortCreatorLinked: 1,
    });
    expect(cohortReading([trade("a"), trade("n")], lookup)).toEqual({
      cohortRecentBuyersPct: 50,
      cohortRecentMaxSize: 3,
      cohortCreatorLinked: 0,
    });
    // This coin's creator shares cohort `a` with the buyer.
    expect(cohortReading([trade("a"), trade("n")], lookup, "dev").cohortCreatorLinked).toBe(1);
    expect(cohortReading([trade("n")], lookup, "dev")).toEqual({
      cohortRecentBuyersPct: 0,
      cohortRecentMaxSize: 0,
      cohortCreatorLinked: 0,
    });
  });

  it("is unknown without buyers", () => {
    expect(cohortReading([trade("a", "sell")], lookup)).toEqual({
      cohortRecentBuyersPct: null,
      cohortRecentMaxSize: 0,
      cohortCreatorLinked: null,
    });
  });
});
