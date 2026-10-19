import { describe, expect, it } from "vitest";
import { CREDIT_BUCKETS, creditBuckets, roundBuySol } from "./GetAsdf";

describe("creditBuckets", () => {
  it("sizes each pick in burn credits and prices it at the quoted rate", () => {
    // 0.1 SOL buys 1,000,000 tokens (6 decimals): 10,000,000 per SOL.
    const quote = { refLamports: "100000000", outAmount: "1000000000000", decimals: 6 };
    const picks = creditBuckets(1_000, quote);
    expect(picks.map((p) => p.credits)).toEqual([...CREDIT_BUCKETS]);
    expect(picks[0]).toEqual({ credits: 10, tokens: 10_000, sol: 0.01 });
    expect(picks[2]).toEqual({ credits: 100, tokens: 100_000, sol: 0.01 });
    expect(picks.at(-1)).toEqual({ credits: 1000, tokens: 1_000_000, sol: 0.1 });
  });

  it("shows the picks without SOL until the rate is read, and none without a credit price", () => {
    expect(creditBuckets(500, null).every((p) => p.sol === null)).toBe(true);
    expect(creditBuckets(null, null)).toEqual([]);
    expect(creditBuckets(0, null)).toEqual([]);
  });
});

describe("roundBuySol", () => {
  it("rounds up to the thousandth, never under the smallest trade", () => {
    expect(roundBuySol(0.12341)).toBe(0.124);
    expect(roundBuySol(0.0001)).toBe(0.01);
    expect(roundBuySol(2)).toBe(2);
  });
});
