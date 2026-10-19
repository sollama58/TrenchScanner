import { describe, expect, it } from "vitest";
import { dexScreenerQuote, MAX_PRICE_AGE_MS, QuotePrice, SolPrice } from "./solPrice.js";

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("SolPrice's age cap", () => {
  it("stops serving the last good price once it is older than the cap", async () => {
    let now = 0;
    let up = true;
    const price = new SolPrice(
      [
        {
          name: "one",
          read: async () => {
            if (!up) throw new Error("down");
            return 150;
          },
        },
      ],
      60_000,
      10_000,
      () => now,
    );
    expect(await price.get()).toBe(150);
    up = false;
    now = MAX_PRICE_AGE_MS - 1;
    expect(await price.get()).toBe(150);
    await settle();
    now = MAX_PRICE_AGE_MS + 20_000;
    // Too old to serve, and the refresh fails: no price rather than a stale one.
    expect(await price.get()).toBeNull();
    up = true;
    now += 20_000;
    expect(await price.get()).toBe(150);
  });

  it("warms: the first read runs before anyone asks", async () => {
    let reads = 0;
    const price = new SolPrice([{ name: "one", read: async () => (reads += 1) && 120 }]);
    await price.warm();
    expect(reads).toBe(1);
    expect(await price.get()).toBe(120);
    expect(reads).toBe(1);
  });
});

describe("QuotePrice with a second source", () => {
  it("falls through to the next reader when the first fails", async () => {
    const q = new QuotePrice([
      async () => {
        throw new Error("jupiter down");
      },
      async () => ({ usd: 1, decimals: 6 }),
    ]);
    expect(await q.get("USD1")).toEqual({ usd: 1, decimals: 6 });
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
    now = MAX_PRICE_AGE_MS + 1;
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
