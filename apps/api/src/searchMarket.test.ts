import { afterEach, describe, expect, it } from "vitest";
import type { CandidateToken } from "@trenchscanner/core";
import {
  clearSearchMarketMemory,
  coalesceMarketReadings,
  fillSearchMarketHits,
  SEARCH_MARKET_FRESH_MS,
  type SearchMarketHit,
  type SearchQuoteSource,
} from "./searchMarket.js";

const NOW = 1_700_000_000_000;

const hit = (over: Partial<SearchMarketHit> = {}): SearchMarketHit => ({
  mint: "mint",
  symbol: "PEPE",
  name: "Pepe",
  imageUrl: "https://img.example/pepe.png",
  marketCapUsd: null,
  marketCapAt: null,
  volume24hUsd: null,
  liquidityUsd: null,
  holderCount: null,
  ...over,
});

afterEach(() => {
  clearSearchMarketMemory();
});

describe("coalesceMarketReadings", () => {
  it("prefers the freshest reading and skips a fetch inside the window", () => {
    const merged = coalesceMarketReadings(
      [
        { at: NOW - 50_000, source: "hit", marketCapUsd: 4_000, volume24hUsd: 10 },
        { at: NOW - 5_000, source: "memory", marketCapUsd: 9_000 },
      ],
      NOW,
    );
    expect(merged.marketCapUsd).toBe(9_000);
    expect(merged.volume24hUsd).toBe(10);
    expect(merged.marketCapAt).toBe(NOW - 5_000);
    expect(merged.skipFetch).toBe(true);
  });

  it("fills a field the fresh reading lacks from an older cached one", () => {
    const merged = coalesceMarketReadings(
      [
        { at: NOW - 10_000, source: "hit", marketCapUsd: 5_000, holderCount: 40 },
        { at: NOW - 50_000, source: "memory", marketCapUsd: 1, volume24hUsd: 80, liquidityUsd: 20 },
      ],
      NOW,
    );
    expect(merged).toMatchObject({
      marketCapUsd: 5_000,
      volume24hUsd: 80,
      liquidityUsd: 20,
      holderCount: 40,
      skipFetch: true,
    });
  });

  it("asks for a fetch only once the newest reading is older than the window", () => {
    expect(
      coalesceMarketReadings([{ at: NOW - SEARCH_MARKET_FRESH_MS, source: "hit", marketCapUsd: 1 }], NOW)
        .skipFetch,
    ).toBe(true);
    expect(
      coalesceMarketReadings([{ at: NOW - SEARCH_MARKET_FRESH_MS - 1, source: "hit", marketCapUsd: 1 }], NOW)
        .skipFetch,
    ).toBe(false);
    expect(coalesceMarketReadings([{ at: 0, source: "hit" }], NOW).skipFetch).toBe(false);
  });

  it("breaks a tie toward the in-memory quote and keeps the hit's name and image", () => {
    const merged = coalesceMarketReadings(
      [
        {
          at: NOW - 1_000,
          source: "hit",
          marketCapUsd: 1,
          symbol: "PEPE",
          name: "Pepe",
          imageUrl: "https://ours.example/a.png",
        },
        {
          at: NOW - 1_000,
          source: "memory",
          marketCapUsd: 2,
          symbol: "OTHER",
          name: "Other",
          imageUrl: "https://dex.example/b.png",
        },
      ],
      NOW,
    );
    expect(merged.marketCapUsd).toBe(2);
    expect(merged.symbol).toBe("PEPE");
    expect(merged.name).toBe("Pepe");
    expect(merged.imageUrl).toBe("https://ours.example/a.png");
  });

  it("fills a missing image from the quote", () => {
    const merged = coalesceMarketReadings(
      [
        { at: NOW, source: "hit", marketCapUsd: 3, imageUrl: null },
        { at: NOW - 1_000, source: "memory", imageUrl: "https://dex.example/b.png" },
      ],
      NOW,
    );
    expect(merged.imageUrl).toBe("https://dex.example/b.png");
    expect(merged.skipFetch).toBe(true);
  });
});

describe("fillSearchMarketHits", () => {
  const token = (mint: string, marketCapUsd: number, volume24hUsd = 7): CandidateToken => ({
    mintAddress: mint,
    priceUsd: 1,
    marketCapUsd,
    volume24hUsd,
  });

  function source(opts: {
    cached?: Map<string, { token: CandidateToken; at: Date }>;
    fetched?: CandidateToken[];
    fetch?: (mints: string[]) => Promise<CandidateToken[]>;
  }): SearchQuoteSource & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      cachedQuotes: (mints) => {
        const out = new Map<string, { token: CandidateToken; at: Date }>();
        for (const mint of mints) {
          const hit = opts.cached?.get(mint);
          if (hit) out.set(mint, hit);
        }
        return out;
      },
      getTokensByAddresses: async (mints) => {
        calls.push(mints);
        return opts.fetch ? opts.fetch(mints) : (opts.fetched ?? mints.map((m) => token(m, 12)));
      },
    };
  }

  it("reuses a cached quote and does not fetch a mint read inside the window", async () => {
    const dex = source({
      cached: new Map([["mint", { token: token("mint", 9_000, 15), at: new Date(NOW - 20_000) }]]),
    });
    const [filled] = await fillSearchMarketHits(
      [hit({ marketCapUsd: 4_000, marketCapAt: new Date(NOW - 90_000), volume24hUsd: null })],
      dex,
      NOW,
    );
    expect(filled).toMatchObject({ marketCapUsd: 9_000, volume24hUsd: 15, symbol: "PEPE" });
    expect(dex.calls).toEqual([]);
  });

  it("fetches a stale mint once, then answers the next ask from that reading", async () => {
    const dex = source({ fetched: [token("mint", 12_000, 4)] });
    const stale = hit({ marketCapUsd: 4_000, marketCapAt: new Date(NOW - 90_000), volume24hUsd: 2 });
    const [first] = await fillSearchMarketHits([stale], dex, NOW);
    expect(first).toMatchObject({ marketCapUsd: 12_000, volume24hUsd: 4, holderCount: null });
    expect(dex.calls).toEqual([["mint"]]);

    const [again] = await fillSearchMarketHits([hit()], dex, NOW + 1_000);
    expect(again?.marketCapUsd).toBe(12_000);
    expect(dex.calls).toEqual([["mint"]]);
  });

  it("shares one lookup when two fills ask for the same stale mint", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dex = source({
      fetch: async (mints) => {
        await gate;
        return mints.map((m) => token(m, 8));
      },
    });
    const stale = hit({ marketCapAt: new Date(NOW - 90_000) });
    const pending = Promise.all([
      fillSearchMarketHits([stale], dex, NOW),
      fillSearchMarketHits([stale], dex, NOW),
    ]);
    release();
    const [[a], [b]] = await pending;
    expect(a?.marketCapUsd).toBe(8);
    expect(b?.marketCapUsd).toBe(8);
    expect(dex.calls).toHaveLength(1);
  });

  it("keeps the cached row when the lookup fails", async () => {
    const dex = source({ fetch: async () => Promise.reject(new Error("down")) });
    const [filled] = await fillSearchMarketHits(
      [hit({ marketCapUsd: 4_000, marketCapAt: new Date(NOW - 90_000), holderCount: 9 })],
      dex,
      NOW,
    );
    expect(filled).toMatchObject({ marketCapUsd: 4_000, holderCount: 9 });
  });
});
