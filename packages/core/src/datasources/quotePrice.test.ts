import { describe, expect, it } from "vitest";
import { HttpError } from "./httpClient.js";
import {
  dexScreenerQuote,
  QUOTE_PRICE_MAX_AGE_MS,
  QuotePrice,
  RATE_LIMITED_REST_MAX_MS,
  RATE_LIMITED_REST_MS,
} from "./quotePrice.js";

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

  it("passes over a reader that answered 429, for every coin, until its rest is up", async () => {
    let now = 0;
    const asked: string[] = [];
    const q = new QuotePrice(
      [
        async (mint) => {
          asked.push(mint);
          throw new HttpError(429, "https://lite-api.jup.ag/price/v3", "HTTP 429");
        },
        async () => ({ usd: 2, decimals: 6 }),
      ],
      30_000,
      10_000,
      () => now,
    );
    expect(await q.get("A")).toEqual({ usd: 2, decimals: 6 });
    expect(await q.get("B")).toEqual({ usd: 2, decimals: 6 });
    // B went straight to the second reader: the first is resting after A's 429.
    expect(asked).toEqual(["A"]);
    now = RATE_LIMITED_REST_MS;
    expect(await q.get("C")).toEqual({ usd: 2, decimals: 6 });
    expect(asked).toEqual(["A", "C"]);
  });

  it("rests a reader longer with each 429 in a row, up to 15 minutes, and starts over once it answers (DA-1)", async () => {
    let now = 0;
    let answer: "429" | "ok" = "429";
    const asked: number[] = [];
    const q = new QuotePrice(
      [
        async () => {
          asked.push(now);
          if (answer === "429") throw new HttpError(429, "https://lite-api.jup.ag/price/v3", "HTTP 429");
          return { usd: 1, decimals: 6 };
        },
        async () => ({ usd: 2, decimals: 6 }),
      ],
      0,
      0,
      () => now,
    );
    // A kept price is served while the refresh runs behind it: let that refresh settle each time.
    const probe = async () => {
      await q.get("A");
      await new Promise((r) => setTimeout(r, 0));
    };
    // Each probe after a rest is refused again: rests of 1, 2, 4, 8, 15 (the cap), 15 minutes.
    for (const rest of [1, 2, 4, 8, 15, 15].map((m) => m * 60_000)) {
      await probe();
      now += rest - 1;
      await probe(); // still resting: the second reader answers alone
      now += 1;
    }
    expect(asked).toEqual([0, 1, 3, 7, 15, 30].map((m) => m * 60_000));
    expect(QuotePrice.restMs(1)).toBe(RATE_LIMITED_REST_MS);
    expect(QuotePrice.restMs(10)).toBe(RATE_LIMITED_REST_MAX_MS);
    // An answer ends the run: the next 429 rests a minute again, not fifteen.
    answer = "ok";
    await probe();
    answer = "429";
    await probe();
    const before = asked.length;
    now += RATE_LIMITED_REST_MS;
    await probe();
    expect(asked.length).toBe(before + 1);
  });

  it("does not rest a reader for an error other than a 429", async () => {
    const asked: string[] = [];
    const q = new QuotePrice([
      async (mint) => {
        asked.push(mint);
        throw new HttpError(500, "https://lite-api.jup.ag/price/v3", "HTTP 500");
      },
      async () => ({ usd: 2, decimals: 6 }),
    ]);
    await q.get("A");
    await q.get("B");
    expect(asked).toEqual(["A", "B"]);
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
