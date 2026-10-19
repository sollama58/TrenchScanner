import { describe, expect, it } from "vitest";
import { creditBuckets, roundBuySol } from "./GetAsdf";

describe("creditBuckets", () => {
  it("shows each pick's tokens and its quoted SOL, rounded up", () => {
    const picks = creditBuckets({
      mint: "m",
      decimals: 6,
      tokensPerCredit: 1_000,
      picks: [
        { credits: 10, units: "10000000000", lamports: "1234000" },
        { credits: 250, units: "250000000000", lamports: "123456789" },
        { credits: 1000, units: "1000000000000", lamports: null },
      ],
    });
    // Under the smallest trade: the minimum, marked, since it lands more credits than the pick.
    expect(picks[0]).toEqual({ credits: 10, tokens: 10_000, sol: 0.01, atMinimum: true });
    expect(picks[1]).toEqual({ credits: 250, tokens: 250_000, sol: 0.124, atMinimum: false });
    // No route: no price, rather than a guess.
    expect(picks[2]).toEqual({ credits: 1000, tokens: 1_000_000, sol: null, atMinimum: false });
  });

  it("has no picks without a reading or a credit price", () => {
    expect(creditBuckets(null)).toEqual([]);
    expect(creditBuckets({ mint: "m", decimals: 6, tokensPerCredit: 0, picks: [] })).toEqual([]);
  });
});

describe("roundBuySol", () => {
  it("rounds up to the thousandth, never under the smallest trade", () => {
    expect(roundBuySol(0.12341)).toBe(0.124);
    expect(roundBuySol(0.0001)).toBe(0.01);
    expect(roundBuySol(2)).toBe(2);
  });
});
