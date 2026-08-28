import { describe, expect, it } from "vitest";
import { DEFAULT_BAND_PADDING_RATIO, refreshAndFilterToBand, scanBand } from "./refreshCandidates.js";
import type { DexScreenerClient } from "../datasources/dexscreener.js";
import type { CandidateToken } from "../types.js";

describe("scanBand", () => {
  it("widens the configured band by the default padding ratio", () => {
    expect(scanBand(50_000, 500_000)).toEqual({ min: 25_000, max: 750_000 });
  });

  it("accepts a custom padding ratio", () => {
    expect(scanBand(100_000, 200_000, 0.25)).toEqual({ min: 75_000, max: 250_000 });
  });

  it("matches refreshAndFilterToBand's own default when no ratio is passed", () => {
    expect(scanBand(50_000, 500_000)).toEqual(scanBand(50_000, 500_000, DEFAULT_BAND_PADDING_RATIO));
  });

  it("a zero padding ratio leaves the band untouched", () => {
    expect(scanBand(50_000, 500_000, 0)).toEqual({ min: 50_000, max: 500_000 });
  });
});

describe("refreshAndFilterToBand", () => {
  const candidate = (mintAddress: string, marketCapUsd: number): CandidateToken => ({
    mintAddress,
    priceUsd: 0.001,
    marketCapUsd,
  });

  it("reports every mint with market data as live, band-filtered or not", async () => {
    // liveMints is what Token.lastLiveAt gets stamped from - an out-of-band token with a real
    // pair is exactly the "still climbing" case the liveness-prioritized watchlist must keep.
    const dexScreener = {
      getTokensByAddresses: async () => [candidate("in-band", 100_000), candidate("below", 2_000)],
    } as unknown as DexScreenerClient;

    const result = await refreshAndFilterToBand(dexScreener, ["in-band", "below", "dead"], {
      mcapMin: 50_000,
      mcapMax: 500_000,
    });
    expect(result.inBand.map((t) => t.mintAddress)).toEqual(["in-band"]);
    expect(result.liveMints.sort()).toEqual(["below", "in-band"]);
  });

  it("returns empty for an empty watchlist without touching the client", async () => {
    const dexScreener = {
      getTokensByAddresses: async () => {
        throw new Error("should not be called");
      },
    } as unknown as DexScreenerClient;
    expect(await refreshAndFilterToBand(dexScreener, [], { mcapMin: 1, mcapMax: 2 })).toEqual({
      inBand: [],
      liveMints: [],
    });
  });
});
