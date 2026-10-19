import { describe, expect, it } from "vitest";
import type { TokenSearchHit } from "./api";
import { arrangeHits, facetOptions, filterCounts, sortCoverage } from "./tokenSearch";

const hit = (mint: string, over: Partial<TokenSearchHit> = {}): TokenSearchHit => ({
  mint,
  symbol: mint,
  name: null,
  imageUrl: null,
  marketCapUsd: null,
  marketCapAt: null,
  volume24hUsd: null,
  liquidityUsd: null,
  holderCount: null,
  graduated: null,
  launchedAt: "2026-10-18T00:00:00Z",
  yourAlertAt: null,
  modelCalls: 0,
  lastCallAt: null,
  bestCallPeakPct: null,
  quoteMint: null,
  quoteSymbol: null,
  feeDestination: null,
  ...over,
});

const HITS = [
  hit("a", { marketCapUsd: 20_000, modelCalls: 2, bestCallPeakPct: 150 }),
  hit("b", { marketCapUsd: null, yourAlertAt: "2026-10-18T01:00:00Z", launchedAt: "2026-10-18T05:00:00Z" }),
  hit("c", { marketCapUsd: 90_000, graduated: true, bestCallPeakPct: 40, modelCalls: 1 }),
];

describe("arrangeHits", () => {
  it("keeps the API's order for best match", () => {
    expect(arrangeHits(HITS, "all", "match").map((h) => h.mint)).toEqual(["a", "b", "c"]);
  });

  it("sorts biggest first with unknowns last", () => {
    expect(arrangeHits(HITS, "all", "mcap").map((h) => h.mint)).toEqual(["c", "a", "b"]);
    expect(arrangeHits(HITS, "all", "run").map((h) => h.mint)).toEqual(["a", "c", "b"]);
    expect(arrangeHits(HITS, "all", "newest")[0]!.mint).toBe("b");
  });

  it("narrows by filter without touching the input", () => {
    expect(arrangeHits(HITS, "called", "mcap").map((h) => h.mint)).toEqual(["c", "a"]);
    expect(arrangeHits(HITS, "yours", "match").map((h) => h.mint)).toEqual(["b"]);
    expect(arrangeHits(HITS, "graduated", "match").map((h) => h.mint)).toEqual(["c"]);
    expect(HITS.map((h) => h.mint)).toEqual(["a", "b", "c"]);
  });
});

describe("filterCounts", () => {
  it("counts what each filter leaves", () => {
    expect(filterCounts(HITS)).toEqual({ all: 3, yours: 1, called: 2, graduated: 1 });
  });
});

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("rewards type and pairing", () => {
  const hits = [
    hit("d", { feeDestination: "creator" }),
    hit("h", { feeDestination: "holder_rewards", quoteMint: USDC }),
    hit("c", { feeDestination: "charity", graduated: true }),
    hit("u", { quoteMint: "So11111111111111111111111111111111111111112" }),
  ];

  it("narrows by where creator fees go, unread coins as Unknown", () => {
    expect(
      arrangeHits(hits, "all", "match", { rewards: "rewards", pairing: "any" }).map((h) => h.mint),
    ).toEqual(["h"]);
    expect(
      arrangeHits(hits, "all", "match", { rewards: "unread", pairing: "any" }).map((h) => h.mint),
    ).toEqual(["u"]);
  });

  it("narrows by pairing, counting an unnamed quote as SOL", () => {
    expect(arrangeHits(hits, "all", "match", { rewards: "any", pairing: "USDC" }).map((h) => h.mint)).toEqual(
      ["h"],
    );
    expect(arrangeHits(hits, "all", "match", { rewards: "any", pairing: "SOL" })).toHaveLength(3);
  });

  it("offers only the choices the results hold, SOL first", () => {
    const options = facetOptions(hits, "all");
    expect(options.rewards.map((r) => r.id)).toEqual(["dev", "rewards", "charity", "unread"]);
    expect(options.pairing).toEqual([
      { label: "SOL", count: 3 },
      { label: "USDC", count: 1 },
    ]);
    expect(facetOptions(hits, "graduated").rewards).toEqual([{ id: "charity", count: 1 }]);
  });
});

describe("sortCoverage", () => {
  it("counts the hits each sort has a figure for", () => {
    expect(sortCoverage(HITS)).toMatchObject({ match: 3, mcap: 2, run: 2, holders: 0, newest: 3 });
  });
});
