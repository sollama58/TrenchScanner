import { describe, expect, it } from "vitest";
import { liveShareDeltas, wideWithLiveShares, withLiveShares } from "./liveShares";
import type { WideMap } from "./bubbleMap";

const SUPPLY = 1_000_000_000;
const T = 1_000_000;
const buy = (wallet: string, tokens: number, atMs = T + 1) => ({
  wallet,
  side: "buy" as const,
  tokens,
  atMs,
});
const sell = (wallet: string, tokens: number, atMs = T + 1) => ({
  wallet,
  side: "sell" as const,
  tokens,
  atMs,
});

describe("liveShareDeltas", () => {
  it("nets each wallet's trades after the read as a share of supply", () => {
    const d = liveShareDeltas(
      [buy("a", 10_000_000), sell("a", 5_000_000), buy("b", 1_000_000, T), sell("c", 2_000_000)],
      SUPPLY,
      T,
    );
    expect(d.get("a")).toBeCloseTo(0.5);
    expect(d.has("b")).toBe(false);
    expect(d.get("c")).toBeCloseTo(-0.2);
  });

  it("moves nothing without a supply", () => {
    expect(liveShareDeltas([buy("a", 1)], null, T).size).toBe(0);
  });
});

describe("withLiveShares", () => {
  const reading = {
    linkedHolders: [
      { wallet: "a", pct: 5, cexFunder: "ex" },
      { wallet: "b", pct: 3 },
      { wallet: "c", pct: 1 },
    ],
    linkedClusters: [
      {
        funder: "f",
        wallets: [
          { wallet: "b", pct: 3 },
          { wallet: "c", pct: 1 },
        ],
        pct: 4,
        creatorLinked: false,
      },
    ],
    sameTimeClusters: null,
    linkedWalletPct: 4,
    sameTimeFundedPct: null,
    cexFundedPct: 5,
    linkedCreatorPct: null,
  };

  it("moves the holders, the clusters and the figures over the same wallets", () => {
    const d = new Map([
      ["a", -1],
      ["c", -1],
      ["new", 2],
      ["tiny", 0.1],
    ]);
    const live = withLiveShares(reading, d);
    expect(live.linkedHolders).toEqual([
      { wallet: "a", pct: 4, cexFunder: "ex" },
      { wallet: "b", pct: 3 },
      { wallet: "new", pct: 2 },
    ]);
    expect(live.linkedClusters).toEqual([
      { funder: "f", wallets: [{ wallet: "b", pct: 3 }], pct: 3, creatorLinked: false },
    ]);
    expect(live.linkedWalletPct).toBe(3);
    expect(live.cexFundedPct).toBe(4);
  });

  it("returns the reading itself with no moves", () => {
    expect(withLiveShares(reading, new Map())).toBe(reading);
  });
});

describe("wideWithLiveShares", () => {
  it("moves the top 50 and adds a buyer that ranks in it", () => {
    const wide: WideMap = {
      readAt: new Date(T).toISOString(),
      holdersRead: 2,
      knownExtra: 0,
      holders: [
        { wallet: "a", pct: 2 },
        { wallet: "b", pct: 1, rank: 30 },
      ],
      clusters: [],
      sameTimeClusters: [],
    };
    const live = wideWithLiveShares(wide, new Map([["n", 1.5]]));
    expect(live.holders.map((h) => h.wallet)).toEqual(["a", "n"]);
  });
});
