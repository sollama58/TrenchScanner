import { describe, expect, it } from "vitest";
import { dexScreenerQuote, QUOTE_PRICE_MAX_AGE_MS, QuotePrice } from "./quotePrice.js";

describe("QuotePrice", () => {
  it("falls through to the next reader when the first fails, and tells of a coin none could price", async () => {
    const failed: string[] = [];
    const q = new QuotePrice(
      [
        async () => {
          throw new Error("jupiter down");
        },
        async (mint) => (mint === "USD1" ? { usd: 1, decimals: 6 } : null),
      ],
      30_000,
      10_000,
      Date.now,
      200,
      QUOTE_PRICE_MAX_AGE_MS,
      (mint) => failed.push(mint),
    );
    expect(await q.get("USD1")).toEqual({ usd: 1, decimals: 6 });
    expect(await q.get("WOJAK")).toBeNull();
    expect(failed).toEqual(["WOJAK"]);
    const misses = q.takeMisses();
    expect(misses.map((m) => m.mint)).toEqual(["WOJAK"]);
    expect(misses[0]!.error).toContain("jupiter down");
    expect(q.takeMisses()).toEqual([]);
  });

  it("stops serving a kept price past the age cap", async () => {
    let now = 0;
    let up = true;
    const q = new QuotePrice(
      async () => {
        if (!up) throw new Error("down");
        return { usd: 0.005, decimals: 6 };
      },
      30_000,
      10_000,
      () => now,
    );
    await q.get("PUMP");
    up = false;
    now = 31_000;
    // Within the cap, the kept price is served while the read fails.
    expect(await q.get("PUMP")).toEqual({ usd: 0.005, decimals: 6 });
    await new Promise((r) => setTimeout(r, 0));
    now = QUOTE_PRICE_MAX_AGE_MS + 60_000;
    expect(await q.get("PUMP")).toBeNull();
  });
});

describe("dexScreenerQuote", () => {
  it("prices a quote coin off DexScreener, its decimals read once off the mint", async () => {
    let decimalReads = 0;
    const read = dexScreenerQuote(
      {
        getTokensByAddresses: async (mints) =>
          mints.map((m) => ({ mintAddress: m, priceUsd: 0.004, marketCapUsd: 1 })),
      },
      async (mints) => {
        decimalReads += 1;
        return new Map(mints.map((m) => [m, 6]));
      },
    );
    expect(await read("PUMP")).toEqual({ usd: 0.004, decimals: 6 });
    expect(await read("PUMP")).toEqual({ usd: 0.004, decimals: 6 });
    expect(decimalReads).toBe(1);
  });

  it("answers none without the coin's decimals rather than guess them", async () => {
    const read = dexScreenerQuote(
      {
        getTokensByAddresses: async (mints) =>
          mints.map((m) => ({ mintAddress: m, priceUsd: 140, marketCapUsd: 1 })),
      },
      async () => new Map(),
    );
    expect(await read("STOCKx")).toBeNull();
  });
});
