import { describe, expect, it } from "vitest";
import type { TokenSearchHit } from "./api";
import { arrangeHits, filterCounts } from "./tokenSearch";

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
