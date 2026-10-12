import { afterEach, describe, expect, it, vi } from "vitest";
import { JupiterClient, JupiterFirstLookup, parseJupiterQuotes, parseJupiterTokens } from "./jupiter.js";
import type { CandidateToken } from "../types.js";

describe("parseJupiterTokens", () => {
  it("reads price, market cap, doubled liquidity and 24h volume for the requested mints only", () => {
    const body = [
      {
        id: "a",
        symbol: "AAA",
        usdPrice: 0.0001,
        mcap: 100_000,
        fdv: 120_000,
        liquidity: 15_000,
        stats24h: { buyVolume: 700, sellVolume: 300, numBuys: 10, numSells: 4, priceChange: -5 },
      },
      { id: "a", usdPrice: 9 },
      { id: "stranger", usdPrice: 1 },
      { id: "b", usdPrice: null, mcap: null, fdv: 5_000 },
    ];
    const [a, b] = parseJupiterTokens(body, new Set(["a", "b"]));
    expect(a).toMatchObject({
      mintAddress: "a",
      priceUsd: 0.0001,
      marketCapUsd: 100_000,
      liquidityUsd: 30_000,
      volume24hUsd: 1_000,
      buys24h: 10,
      sells24h: 4,
      priceChange24hPct: -5,
    });
    expect(b).toMatchObject({ mintAddress: "b", priceUsd: 0, marketCapUsd: 5_000, liquidityUsd: undefined });
    expect(b!.volume24hUsd).toBeUndefined();
    expect(parseJupiterTokens({ error: "nope" }, new Set(["a"]))).toEqual([]);
  });
});

describe("parseJupiterQuotes", () => {
  it("reads the price, cap, update time and 5m/1h activity, and drops quotes without a price or cap", () => {
    const body = [
      {
        id: "a",
        usdPrice: 0.00005,
        mcap: 50_000,
        updatedAt: "2026-10-12T10:00:00Z",
        stats5m: {
          priceChange: 12.5,
          buyVolume: 4_000,
          sellVolume: 1_000,
          numBuys: 40,
          numSells: 9,
          numTraders: 30,
          numNetBuyers: 11,
          holderChange: 7,
        },
        stats1h: { priceChange: 80, holderChange: 60 },
      },
      { id: "b", usdPrice: 0, mcap: 1_000 },
      { id: "c", usdPrice: 1, mcap: null, fdv: null },
      { id: "d", usdPrice: 0.00001, fdv: 10_000, updatedAt: "not a date" },
    ];
    const quotes = parseJupiterQuotes(body, new Set(["a", "b", "c", "d"]));
    expect(quotes.map((q) => q.mintAddress)).toEqual(["a", "d"]);
    expect(quotes[0]!.quote).toMatchObject({
      priceUsd: 0.00005,
      marketCapUsd: 50_000,
      updatedAt: new Date("2026-10-12T10:00:00Z"),
      stats5m: {
        priceChangePct: 12.5,
        buyVolumeUsd: 4_000,
        buys: 40,
        traders: 30,
        netBuyers: 11,
        holderChange: 7,
      },
      stats1h: { priceChangePct: 80, holderChange: 60 },
    });
    expect(quotes[1]!.quote).toMatchObject({
      marketCapUsd: 10_000,
      updatedAt: undefined,
      stats5m: undefined,
    });
  });
});

describe("JupiterClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives fresh quotes stamped with when they arrived, and nothing for an answer past the deadline", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const list = decodeURIComponent(url.split("query=")[1]!).split(",");
      const body = JSON.stringify(list.map((id) => ({ id, usdPrice: 0.0001, mcap: 100_000 })));
      // The second batch answers after the deadline.
      const late = list.includes("m100");
      return new Promise((resolve) => setTimeout(() => resolve(new Response(body)), late ? 300 : 0));
    });
    const client = new JupiterClient({ apiKey: "k", requestsPerMinute: 6000 });
    const mints = Array.from({ length: 150 }, (_, i) => `m${i}`);
    const before = Date.now();
    const quotes = await client.getFreshQuotes(mints, { deadlineMs: 100 });
    expect(quotes.size).toBe(100);
    expect(quotes.get("m0")).toMatchObject({ priceUsd: 0.0001, marketCapUsd: 100_000 });
    expect(quotes.get("m0")!.fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(quotes.has("m120")).toBe(false);
  });

  it("asks 100 mints a call with the key, and fails the mints of a batch that errors", async () => {
    const urls: string[] = [];
    const headers: (Record<string, string> | undefined)[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      urls.push(url);
      headers.push(init?.headers as Record<string, string> | undefined);
      const list = decodeURIComponent(url.split("query=")[1]!).split(",");
      if (list.includes("m150")) return Promise.resolve(new Response("boom", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(list.map((id) => ({ id, usdPrice: 1 })))));
    });
    const client = new JupiterClient({ apiKey: "k", requestsPerMinute: 6000 });
    const mints = Array.from({ length: 200 }, (_, i) => `m${i}`);
    const failed = new Set<string>();
    const found = await client.getTokensByAddresses(mints, 2, { retries: 0, failed });
    expect(urls).toHaveLength(2);
    expect(headers[0]?.["x-api-key"]).toBe("k");
    expect(found).toHaveLength(100);
    expect(failed.size).toBe(100);
    expect(failed.has("m150")).toBe(true);
  });
});

describe("JupiterFirstLookup", () => {
  const token = (mint: string, priceUsd = 1): CandidateToken => ({
    mintAddress: mint,
    priceUsd,
    marketCapUsd: 1,
  });

  it("asks DexScreener only for what Jupiter missed or never answered", async () => {
    const jupiter = {
      getTokensByAddresses: vi.fn(async (_mints: string[], _c?: number, o?: { failed?: Set<string> }) => {
        o?.failed?.add("unanswered");
        return [token("priced"), token("zero", 0)];
      }),
    };
    const dex = { getTokensByAddresses: vi.fn(async (mints: string[]) => mints.map((m) => token(m, 2))) };
    const lookup = new JupiterFirstLookup(jupiter, dex);
    const out = await lookup.getTokensByAddresses(["priced", "zero", "absent", "unanswered"], 5, {});
    expect(dex.getTokensByAddresses.mock.calls[0]![0]).toEqual(["zero", "absent", "unanswered"]);
    expect(Object.fromEntries(out.map((t) => [t.mintAddress, t.priceUsd]))).toEqual({
      priced: 1,
      zero: 2,
      absent: 2,
      unanswered: 2,
    });
  });

  it("takes Jupiter's word on unindexed mints and asks DexScreener only for unanswered ones", async () => {
    const jupiter = {
      getTokensByAddresses: vi.fn(async (_mints: string[], _c?: number, o?: { failed?: Set<string> }) => {
        o?.failed?.add("unanswered");
        return [token("priced")];
      }),
    };
    const dex = { getTokensByAddresses: vi.fn(async (_mints: string[]) => [] as CandidateToken[]) };
    const lookup = new JupiterFirstLookup(jupiter, dex);
    await lookup.getTokensByAddresses(["priced", "junk", "unanswered"], 3, { mayBeUnindexed: true });
    expect(dex.getTokensByAddresses.mock.calls[0]![0]).toEqual(["unanswered"]);
  });

  it("never touches DexScreener when Jupiter priced everything", async () => {
    const jupiter = { getTokensByAddresses: vi.fn(async (mints: string[]) => mints.map((m) => token(m))) };
    const dex = { getTokensByAddresses: vi.fn(async (_mints: string[]) => [] as CandidateToken[]) };
    const out = await new JupiterFirstLookup(jupiter, dex).getTokensByAddresses(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(dex.getTokensByAddresses).not.toHaveBeenCalled();
  });
});
