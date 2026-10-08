import { afterEach, describe, expect, it, vi } from "vitest";
import { JupiterClient, JupiterFirstLookup, parseJupiterTokens } from "./jupiter.js";
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

describe("JupiterClient", () => {
  afterEach(() => vi.unstubAllGlobals());

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
