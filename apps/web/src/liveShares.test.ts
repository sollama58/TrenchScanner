import { describe, expect, it } from "vitest";
import {
  coversFrom,
  listedShareDeltas,
  wideWithLiveShares,
  withLiveShares,
  type ShareTrade,
} from "./liveShares";
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

const feed = (trades: ShareTrade[], wholeFrom = T, supply: number | null = SUPPLY) => ({
  trades,
  supply,
  wholeFrom,
});

describe("listedShareDeltas", () => {
  it("nets each listed wallet's trades after the list's time as a share of supply", () => {
    const d = listedShareDeltas(
      feed([buy("a", 10_000_000), sell("a", 5_000_000), buy("b", 1_000_000, T), sell("c", 2_000_000)]),
      new Set(["a", "b", "c"]),
      T,
    );
    expect(d.get("a")).toBeCloseTo(0.5);
    expect(d.has("b")).toBe(false);
    expect(d.get("c")).toBeCloseTo(-0.2);
  });

  it("never moves a wallet off the list: its holding before the feed is unknown", () => {
    // A wallet ranked 30th that buys more, or a router that an aggregator trade names, would show
    // at only the size of its trades.
    const d = listedShareDeltas(
      feed([buy("listed", 1_000_000), buy("router", 50_000_000)]),
      new Set(["listed"]),
      T,
    );
    expect([...d.keys()]).toEqual(["listed"]);
  });

  it("moves nothing when the feed doesn't hold every trade since the list's time", () => {
    // The feed is whole only from T + 5: a trade between T and T + 5 may be missing.
    const d = listedShareDeltas(feed([buy("a", 1_000_000, T + 10)], T + 5), new Set(["a"]), T);
    expect(d.size).toBe(0);
  });

  it("moves nothing without a supply", () => {
    expect(listedShareDeltas(feed([buy("a", 1)], T, null), new Set(["a"]), T).size).toBe(0);
  });

  it("does not count again a trade the holder stream already folded into the shares", () => {
    const trades = [buy("a", 10_000_000, T + 5), buy("a", 1_000_000, T + 20)];
    const d = listedShareDeltas(feed(trades), new Set(["a"]), T + 10);
    expect(d.get("a")).toBeCloseTo(0.1);
  });
});

describe("coversFrom", () => {
  it("holds only with a supply and the feed whole at or before the time", () => {
    expect(coversFrom(feed([]), T)).toBe(true);
    expect(coversFrom(feed([], T + 1), T)).toBe(false);
    expect(coversFrom(feed([], T, null), T)).toBe(false);
    expect(coversFrom(null, T)).toBe(false);
    expect(coversFrom(feed([]), NaN)).toBe(false);
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
    ]);
    const live = withLiveShares(reading, d);
    expect(live.linkedHolders).toEqual([
      { wallet: "a", pct: 4, cexFunder: "ex" },
      { wallet: "b", pct: 3 },
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

  it("clamps a displayed share at 100", () => {
    const live = withLiveShares(
      { ...reading, linkedHolders: [{ wallet: "a", pct: 98 }] },
      new Map([["a", 5]]),
    );
    expect(live.linkedHolders?.[0]?.pct).toBe(100);
  });

  it("re-ranks a holder who sold down and adds no one", () => {
    const live = withLiveShares(
      reading,
      new Map([
        ["b", -2.5],
        ["new", 0.5],
      ]),
    );
    expect(live.linkedHolders?.map((h) => h.wallet)).toEqual(["a", "c", "b"]);
    expect(live.linkedHolders?.map((h) => h.pct)).toEqual([5, 1, 0.5]);
  });
});

describe("wideWithLiveShares", () => {
  it("moves the top 50's own wallets and adds no one", () => {
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
    const live = wideWithLiveShares(
      wide,
      new Map([
        ["n", 1.5],
        ["b", 1.5],
      ]),
    );
    expect(live.holders.map((h) => [h.wallet, h.pct])).toEqual([
      ["b", 2.5],
      ["a", 2],
    ]);
  });
});
