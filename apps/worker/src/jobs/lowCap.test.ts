import { describe, expect, it } from "vitest";
import { splitLowCap } from "./lowCap.js";

const coin = (mintAddress: string, marketCapUsd: number) => ({ mintAddress, marketCapUsd });

describe("splitLowCap", () => {
  it("holds the coins under the floor and keeps the rest", () => {
    const { kept, held } = splitLowCap([coin("a", 3_999), coin("b", 4_000), coin("c", 80_000)], 4_000);
    expect(held.map((c) => c.mintAddress)).toEqual(["a"]);
    expect(kept.map((c) => c.mintAddress)).toEqual(["b", "c"]);
  });

  it("never holds a looked-up coin", () => {
    const { kept, held } = splitLowCap([coin("a", 1_000)], 4_000, new Set(["a"]));
    expect(held).toEqual([]);
    expect(kept.map((c) => c.mintAddress)).toEqual(["a"]);
  });

  it("does not judge a coin with no market cap reading", () => {
    expect(splitLowCap([coin("a", 0), coin("b", NaN)], 4_000).held).toEqual([]);
  });

  it("holds nothing when the floor is 0", () => {
    expect(splitLowCap([coin("a", 100)], 0).held).toEqual([]);
  });
});
