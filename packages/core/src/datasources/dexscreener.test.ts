import { afterEach, describe, expect, it, vi } from "vitest";
import { DexScreenerClient, pickCanonicalPair } from "./dexscreener.js";
import { GeckoTerminalClient, parseGeckoTokens } from "./geckoterminal.js";

describe("pickCanonicalPair", () => {
  const curve = { dexId: "pumpfun", volume: { h1: 20_000 } };

  it("keeps a trading pre-bond curve over side pools someone opened for the mint", () => {
    const dust = { dexId: "meteora", liquidity: { usd: 40 }, volume: { h1: 5 } };
    const seeded = { dexId: "raydium", liquidity: { usd: 5_000 }, volume: { h1: 50 } };
    expect(pickCanonicalPair([curve, dust, seeded])).toBe(curve);
  });

  it("moves to the pumpswap pool the moment the mint graduates", () => {
    // The curve's last hour still shows volume right after graduation; graduation is one-way.
    const pumpswap = { dexId: "pumpswap", liquidity: { usd: 30_000 }, volume: { h1: 1_000 } };
    expect(pickCanonicalPair([curve, pumpswap])).toBe(pumpswap);
  });

  it("ignores an unfunded pumpswap pool as a graduation signal", () => {
    const fake = { dexId: "pumpswap", liquidity: { usd: 10 }, volume: { h1: 0 } };
    expect(pickCanonicalPair([curve, fake])).toBe(curve);
  });

  it("prices a graduated coin off its drained pumpswap pool, not the frozen curve", () => {
    // After graduation DexScreener still lists the curve at the graduation price; once the pool
    // falls under the funded threshold the quiet curve used to win and read as not graduated.
    const frozenCurve = { dexId: "pumpfun", volume: { h1: 0 } };
    const drained = { dexId: "pumpswap", liquidity: { usd: 600 }, volume: { h1: 0 } };
    expect(pickCanonicalPair([frozenCurve, drained])).toBe(drained);
  });

  it("keeps a quiet curve over a dust pumpswap pool opened on a coin still on its curve", () => {
    const quietCurve = { dexId: "pumpfun", volume: { h1: 0 } };
    const fake = { dexId: "pumpswap", liquidity: { usd: 10 }, volume: { h1: 0 } };
    expect(pickCanonicalPair([quietCurve, fake])).toBe(quietCurve);
  });

  it("uses the deepest real pool once the curve has stopped trading", () => {
    const staleCurve = { dexId: "pumpfun", volume: { h1: 0 } };
    const raydium = { dexId: "raydium", liquidity: { usd: 50_000 } };
    const thin = { dexId: "meteora", liquidity: { usd: 2_000 } };
    expect(pickCanonicalPair([staleCurve, thin, raydium])).toBe(raydium);
  });

  it("keeps a quiet curve over dust side pools when no real pool exists", () => {
    // A few dollars in a side pool used to outrank the curve here, pricing the token off that
    // pool and reading it as graduated.
    const staleCurve = { dexId: "pumpfun", liquidity: { usd: 0 }, volume: { h1: 0 } };
    const dust = { dexId: "meteora", liquidity: { usd: 5 } };
    expect(pickCanonicalPair([staleCurve, dust])).toBe(staleCurve);
  });

  it("falls back to the deepest pair when nothing is funded", () => {
    const a = { dexId: "meteora", liquidity: { usd: 10 } };
    const b = { dexId: "raydium", liquidity: { usd: 500 } };
    expect(pickCanonicalPair([a, b])).toBe(b);
  });
});

describe("getTokensByAddresses deadline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the batches that answered once the deadline passes, without waiting on the rest", async () => {
    // A throttled DexScreener held scan cycles for 20-50s; the scan now stops waiting after its
    // deadline and goes on with what it has.
    const mints = Array.from({ length: 31 }, (_, i) => `mint${i}`);
    vi.stubGlobal("fetch", (url: string, init: { signal: AbortSignal }) => {
      if (url.includes("mint0,")) {
        const pair = {
          chainId: "solana",
          dexId: "raydium",
          baseToken: { address: "mint0" },
          marketCap: 50_000,
        };
        return Promise.resolve(new Response(JSON.stringify([pair])));
      }
      // The second batch never answers until aborted.
      return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });

    const startedAt = Date.now();
    const failed = new Set<string>();
    const result = await new DexScreenerClient().getTokensByAddresses(mints, 1, {
      timeoutMs: 5_000,
      retries: 0,
      deadlineMs: 200,
      failed,
    });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.map((t) => t.mintAddress)).toEqual(["mint0"]);
    // The unanswered batch is reported as failed, not as "no pair"; the answered one is not.
    expect(failed).toEqual(new Set(["mint30"]));
  });
});

describe("getTokensByAddresses rate limiting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pauses every batch on a 429, not just the one that got it", async () => {
    // 2026-10-07: each batch retried on its own while the others kept firing into the same limit.
    const mints = Array.from({ length: 90 }, (_, i) => `mint${i}`);
    const calls: number[] = [];
    let throttledOnce = false;
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(Date.now());
      if (!throttledOnce) {
        throttledOnce = true;
        return Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "0.3" } }));
      }
      const chunk = url.split("/").pop()!.split(",");
      const pairs = chunk.map((mint) => ({
        chainId: "solana",
        dexId: "raydium",
        baseToken: { address: mint },
        marketCap: 50_000,
      }));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });

    const client = new DexScreenerClient();
    const startedAt = Date.now();
    // One batch at a time until the 429 lands, so the pause is the only thing holding the rest.
    const result = await client.getTokensByAddresses(mints, 1, { retries: 1 });
    expect(result).toHaveLength(90);
    // The 429, its retry and the two other batches - none of the later ones before the pause ran out.
    expect(calls).toHaveLength(4);
    for (const at of calls.slice(1)) expect(at - startedAt).toBeGreaterThanOrEqual(290);
    expect(client.takeCallStats()).toMatchObject({ requests: 4, throttled: 1 });
  });

  it("counts a batch still queued behind the budget at its deadline as failed", async () => {
    const mints = Array.from({ length: 60 }, (_, i) => `mint${i}`);
    let first = true;
    vi.stubGlobal("fetch", () => {
      if (first) {
        first = false;
        // A long pause: the second batch can't get a slot before the deadline.
        return Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "10" } }));
      }
      return Promise.resolve(new Response("[]"));
    });
    const failed = new Set<string>();
    const startedAt = Date.now();
    await new DexScreenerClient().getTokensByAddresses(mints, 1, { retries: 0, deadlineMs: 500, failed });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(failed.size).toBe(60);
  });
});

describe("getTokensByAddresses fallback while DexScreener is blank", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const geckoBody = (mints: string[]) => ({
    data: mints.map((mint) => ({
      attributes: { address: mint, symbol: "X", fdv_usd: "40000", market_cap_usd: null },
      relationships: { top_pools: { data: [{ id: `solana_pool_${mint}` }] } },
    })),
    included: mints.map((mint) => ({
      id: `solana_pool_${mint}`,
      attributes: { base_token_price_usd: "0.00004", reserve_in_usd: "9000" },
      relationships: { base_token: { data: { id: `solana_${mint}` } }, dex: { data: { id: "pump-fun" } } },
    })),
  });

  it("answers from GeckoTerminal when DexScreener returns no pairs, then probes until it recovers", async () => {
    // 2026-10-07: DexScreener answered every lookup with [] and the scan saw nothing in band.
    const mints = Array.from({ length: 60 }, (_, i) => `mint${i}`);
    let dexBlank = true;
    const dexCalls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      const list = url.split("/").pop()!.split("?")[0]!.split(",");
      if (url.includes("geckoterminal"))
        return Promise.resolve(new Response(JSON.stringify(geckoBody(list))));
      dexCalls.push(url);
      const pairs = dexBlank
        ? []
        : list.map((mint) => ({
            chainId: "solana",
            dexId: "raydium",
            baseToken: { address: mint },
            marketCap: 1,
          }));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });
    const client = new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });

    const first = await client.getTokensByAddresses(mints, 5, { retries: 0 });
    expect(first).toHaveLength(60);
    expect(first[0]).toMatchObject({ marketCapUsd: 40_000, dexId: "pumpfun", liquidityUsd: undefined });
    expect(client.usingFallback).toBe(true);

    // While blank, DexScreener gets one probe batch, not the whole lookup.
    dexCalls.length = 0;
    expect(await client.getTokensByAddresses(mints, 5, { retries: 0 })).toHaveLength(60);
    expect(dexCalls).toHaveLength(1);

    // The probe finds pairs again: its answers win and the fallback stands down.
    dexBlank = false;
    const recovered = await client.getTokensByAddresses(mints, 5, { retries: 0 });
    expect(recovered.find((t) => t.mintAddress === "mint0")?.dexId).toBe("raydium");
    expect(client.usingFallback).toBe(false);
  });

  it("leaves a large blank lookup alone when its mints may be unindexed", async () => {
    // The empty-wallet check prices holders' other holdings - airdrops and NFTs with no pair -
    // and such a lookup answering empty must not route the scan's refresh onto the fallback.
    const dexCalls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("geckoterminal")) throw new Error("should not be called");
      dexCalls.push(url);
      return Promise.resolve(new Response("[]"));
    });
    const client = new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });
    const junk = Array.from({ length: 60 }, (_, i) => `junk${i}`);
    expect(await client.getTokensByAddresses(junk, 5, { retries: 0, mayBeUnindexed: true })).toEqual([]);
    expect(dexCalls).toHaveLength(2);
    expect(client.usingFallback).toBe(false);
  });

  it("leaves a small blank lookup alone: a few unindexed mints are not an outage", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("geckoterminal")) throw new Error("should not be called");
      return Promise.resolve(new Response("[]"));
    });
    const client = new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });
    expect(await client.getTokensByAddresses(["a", "b", "c"], 5, { retries: 0 })).toEqual([]);
    expect(client.usingFallback).toBe(false);
  });
});

describe("parseGeckoTokens", () => {
  it("prices only off a top pool the mint is the base of", () => {
    const body = {
      data: [
        {
          attributes: { address: "m1", price_usd: "2", market_cap_usd: "1000" },
          relationships: { top_pools: { data: [{ id: "p_quote" }, { id: "p_base" }] } },
        },
        { attributes: { address: "unrequested", fdv_usd: "5" } },
      ],
      included: [
        {
          id: "p_quote",
          attributes: { base_token_price_usd: "99", reserve_in_usd: "1" },
          relationships: { base_token: { data: { id: "solana_other" } }, dex: { data: { id: "raydium" } } },
        },
        {
          id: "p_base",
          attributes: {
            address: "pool1",
            base_token_price_usd: "1.5",
            reserve_in_usd: "50000",
            pool_created_at: "2026-10-07T20:00:00Z",
            price_change_percentage: { m5: "3.5", h1: "-2" },
            transactions: { m5: { buys: 4, sells: 2 } },
            volume_usd: { m5: "120", h24: "9000" },
          },
          relationships: { base_token: { data: { id: "solana_m1" } }, dex: { data: { id: "pumpswap" } } },
        },
      ],
    };
    const [t, ...rest] = parseGeckoTokens(body, new Set(["m1"]));
    expect(rest).toHaveLength(0);
    expect(t).toMatchObject({
      mintAddress: "m1",
      pairAddress: "pool1",
      priceUsd: 1.5,
      marketCapUsd: 1000,
      liquidityUsd: 50_000,
      dexId: "pumpswap",
      priceChange5mPct: 3.5,
      priceChange1hPct: -2,
      buys5m: 4,
      sells5m: 2,
      volume5mUsd: 120,
      volume24hUsd: 9000,
    });
    expect(t?.pairCreatedAt?.toISOString()).toBe("2026-10-07T20:00:00.000Z");
  });
});

describe("GeckoTerminalClient with a CoinGecko key", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls CoinGecko's on-chain API with the key, and does not cut background lookups short", async () => {
    const calls: { url: string; key?: string }[] = [];
    vi.stubGlobal("fetch", (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, key: init.headers["x-cg-pro-api-key"] });
      return Promise.resolve(new Response(JSON.stringify({ data: [] })));
    });
    const client = new GeckoTerminalClient({
      apiKey: "k",
      priorityPerMinute: 6000,
      backgroundPerMinute: 6000,
    });
    const failed = new Set<string>();
    await client.getTokensByAddresses(
      Array.from({ length: 120 }, (_, i) => `m${i}`),
      { retries: 0, failed },
    );
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ key: "k" });
    expect(
      calls[0]!.url.startsWith("https://pro-api.coingecko.com/api/v3/onchain/networks/solana/tokens/multi/"),
    ).toBe(true);
    expect(failed.size).toBe(0);
  });
});
