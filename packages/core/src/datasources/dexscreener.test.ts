import { afterEach, describe, expect, it, vi } from "vitest";
import { DexScreenerClient, pickCanonicalPair, pumpSwapPoolCreatedAt } from "./dexscreener.js";
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

describe("graduation time", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the earliest PumpSwap pool's creation, ignoring other venues", () => {
    expect(
      pumpSwapPoolCreatedAt([
        { dexId: "pumpfun", pairCreatedAt: 1_000 },
        { dexId: "meteora", pairCreatedAt: 2_000 },
        { dexId: "pumpswap", pairCreatedAt: 5_000 },
        { dexId: "pumpswap", pairCreatedAt: 3_000 },
      ]),
    ).toEqual(new Date(3_000));
    expect(pumpSwapPoolCreatedAt([{ dexId: "raydium", pairCreatedAt: 1_000 }])).toBeUndefined();
  });

  it("is set on a graduated mint's candidate and not on one still on its curve", async () => {
    const pairs = [
      {
        chainId: "solana",
        dexId: "pumpswap",
        baseToken: { address: "grad" },
        liquidity: { usd: 30_000 },
        marketCap: 80_000,
        pairCreatedAt: 1_791_674_763_000,
      },
      {
        chainId: "solana",
        dexId: "pumpfun",
        baseToken: { address: "curve" },
        volume: { h1: 500 },
        pairCreatedAt: 1,
      },
    ];
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(pairs))));
    const tokens = await new DexScreenerClient().getTokensByAddresses(["grad", "curve"], 1, { retries: 0 });
    const by = new Map(tokens.map((t) => [t.mintAddress, t]));
    expect(by.get("grad")?.graduatedAt).toEqual(new Date(1_791_674_763_000));
    expect(by.get("curve")?.graduatedAt).toBeUndefined();
  });
});

describe("pumpSwapGraduation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the mint's own PumpSwap pool from the per-token pairs, and null without one", async () => {
    const pairs = [
      { chainId: "solana", dexId: "pumpfun", baseToken: { address: "m" }, pairCreatedAt: 1_000 },
      { chainId: "solana", dexId: "pumpswap", baseToken: { address: "m" }, pairCreatedAt: 1_000 },
      { chainId: "solana", dexId: "pumpswap", baseToken: { address: "other" }, pairCreatedAt: 500 },
    ];
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(JSON.stringify(url.endsWith("/m") ? pairs : [pairs[0]])));
    });
    const client = new DexScreenerClient();
    expect(await client.pumpSwapGraduation("m")).toEqual(new Date(1_000));
    expect(await client.pumpSwapGraduation("n")).toBeNull();
    expect(urls[0]).toMatch(/\/token-pairs\/v1\/solana\/m$/);
  });
});

describe("frozen graduation curves", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const SOL = { address: "So11111111111111111111111111111111111111112" };
  const curve = (mint: string, priceNative: string, marketCap: number) => ({
    chainId: "solana",
    dexId: "pumpfun",
    baseToken: { address: mint },
    quoteToken: SOL,
    priceNative,
    marketCap,
    volume: { h1: 9_500 },
    pairCreatedAt: 1_000,
  });

  it("re-reads a curve stuck at its graduation price and prices the mint off its PumpSwap pool", async () => {
    // DOWO, 2026-10-12: /tokens/v1 listed only the curve, frozen at $45.9k; the pool traded at $176k.
    const frozen = curve("dowo", "0.0000004097", 45_904);
    const live = curve("live", "0.0000001200", 13_000);
    const pool = {
      chainId: "solana",
      dexId: "pumpswap",
      baseToken: { address: "dowo" },
      quoteToken: SOL,
      liquidity: { usd: 37_957 },
      marketCap: 176_049,
      pairCreatedAt: 1_000,
    };
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      const body = url.includes("/token-pairs/") ? [frozen, pool] : [frozen, live];
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    const tokens = await new DexScreenerClient().getTokensByAddresses(["dowo", "live"], 1, { retries: 0 });
    const by = new Map(tokens.map((t) => [t.mintAddress, t]));
    expect(by.get("dowo")).toMatchObject({
      dexId: "pumpswap",
      marketCapUsd: 176_049,
      graduatedAt: new Date(1_000),
    });
    expect(by.get("live")).toMatchObject({ dexId: "pumpfun", marketCapUsd: 13_000 });
    expect(urls.filter((u) => u.includes("/token-pairs/"))).toEqual([
      "https://api.dexscreener.com/token-pairs/v1/solana/dowo",
    ]);
  });

  it("keeps the batch answer when no pool is listed or the re-read fails", async () => {
    const nearTop = curve("near", "0.0000003900", 43_000);
    const broken = curve("broken", "0.0000004100", 45_000);
    vi.stubGlobal("fetch", (url: string) => {
      if (url.endsWith("/broken")) return Promise.resolve(new Response("{}", { status: 500 }));
      const body = url.includes("/token-pairs/") ? [nearTop] : [nearTop, broken];
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    const tokens = await new DexScreenerClient().getTokensByAddresses(["near", "broken"], 1, { retries: 0 });
    expect(tokens.map((t) => [t.mintAddress, t.dexId, t.marketCapUsd])).toEqual(
      expect.arrayContaining([
        ["near", "pumpfun", 43_000],
        ["broken", "pumpfun", 45_000],
      ]),
    );
  });

  it("backs off re-reading a curve whose pool isn't listed, and finds a pool listed later", async () => {
    // 2026-10-12: ~13 of 182 near-band mints were ordinary graduates whose curve sat at the
    // graduation price with no pool listed anywhere; each cost a re-read in every lookup.
    const quiet = curve("quiet", "0.0000004100", 45_000);
    const pool = {
      chainId: "solana",
      dexId: "pumpswap",
      baseToken: { address: "quiet" },
      quoteToken: SOL,
      liquidity: { usd: 20_000 },
      marketCap: 90_000,
      pairCreatedAt: 1_000,
    };
    let listed = false;
    const reReads: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      if (url.includes("/token-pairs/")) reReads.push(url);
      const body = url.includes("/token-pairs/") && listed ? [quiet, pool] : [quiet];
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const client = new DexScreenerClient();
    const lookup = async () =>
      (await client.getTokensByAddresses(["quiet"], 1, { retries: 0, fresh: true }))[0];

    expect(await lookup()).toMatchObject({ dexId: "pumpfun", marketCapUsd: 45_000 });
    expect(reReads).toHaveLength(1);
    now += 30_000;
    await lookup();
    expect(reReads).toHaveLength(1); // still inside the first minute's backoff
    now += 31_000;
    await lookup();
    expect(reReads).toHaveLength(2); // a second miss doubles the wait to two minutes
    now += 90_000;
    await lookup();
    expect(reReads).toHaveLength(2);
    listed = true;
    now += 31_000;
    expect(await lookup()).toMatchObject({ dexId: "pumpswap", marketCapUsd: 90_000 });
    expect(reReads).toHaveLength(3);
    // Found: re-read on every lookup again, so the pool's price stays live.
    await lookup();
    expect(reReads).toHaveLength(4);
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
    // A priority lookup (the band refresh), so the budget's reserve doesn't hold them as well.
    const result = await client.getTokensByAddresses(mints, 1, { retries: 1, priority: true });
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

  it("sends no unindexed lookup to the fallback while DexScreener is blank, and fails its mints", async () => {
    let geckoCalls = 0;
    vi.stubGlobal("fetch", (url: string) => {
      const list = url.split("/").pop()!.split("?")[0]!.split(",");
      if (url.includes("geckoterminal")) {
        geckoCalls += 1;
        return Promise.resolve(new Response(JSON.stringify(geckoBody(list))));
      }
      return Promise.resolve(new Response("[]"));
    });
    const client = new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });
    const mints = Array.from({ length: 60 }, (_, i) => `mint${i}`);
    await client.getTokensByAddresses(mints, 5, { retries: 0 });
    expect(client.usingFallback).toBe(true);
    geckoCalls = 0;

    const failed = new Set<string>();
    const junk = Array.from({ length: 60 }, (_, i) => `junk${i}`);
    expect(await client.getTokensByAddresses(junk, 5, { retries: 0, mayBeUnindexed: true, failed })).toEqual(
      [],
    );
    expect(geckoCalls).toBe(0);
    expect(failed.size).toBe(60);
    expect(client.usingFallback).toBe(true);
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

describe("getTokensByAddresses quote cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function stubPairs(): string[] {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      const chunk = url.split("/").pop()!.split(",");
      const pairs = chunk.map((mint) => ({
        chainId: "solana",
        dexId: "raydium",
        baseToken: { address: mint },
        marketCap: 50_000,
      }));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });
    return urls;
  }

  it("answers a repeat lookup within the window from memory, with the first reading's time", async () => {
    const urls = stubPairs();
    const client = new DexScreenerClient();
    const firstSeen = new Map<string, Date>();
    await client.getTokensByAddresses(["a", "b"], 1, { retries: 0, seenAt: firstSeen });

    const seenAt = new Map<string, Date>();
    const again = await client.getTokensByAddresses(["a", "b", "c"], 1, { retries: 0, seenAt });
    expect(again.map((t) => t.mintAddress).sort()).toEqual(["a", "b", "c"]);
    // Only the mint it hadn't seen goes upstream.
    expect(urls).toHaveLength(2);
    expect(urls[1]!.endsWith("/c")).toBe(true);
    expect(seenAt.get("a")).toEqual(firstSeen.get("a"));
    expect(client.takeQuoteCacheHits()).toBe(2);
    expect(client.takeQuoteCacheHits()).toBe(0);
  });

  it("goes upstream when asked for a fresh reading, and once the window has passed", async () => {
    const urls = stubPairs();
    const client = new DexScreenerClient();
    await client.getTokensByAddresses(["a"], 1, { retries: 0 });
    await client.getTokensByAddresses(["a"], 1, { retries: 0, fresh: true });
    expect(urls).toHaveLength(2);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11_000);
    await client.getTokensByAddresses(["a"], 1, { retries: 0 });
    expect(urls).toHaveLength(3);
  });

  it("hands each caller its own copy, so one caller's edits don't leak into another's", async () => {
    stubPairs();
    const client = new DexScreenerClient();
    const [first] = await client.getTokensByAddresses(["a"], 1, { retries: 0 });
    first!.marketCapUsd = 1;
    const [second] = await client.getTokensByAddresses(["a"], 1, { retries: 0 });
    expect(second!.marketCapUsd).toBe(50_000);
  });
});

describe("getTokensByAddresses: the fallback prices what DexScreener can't", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SOL = { address: "So11111111111111111111111111111111111111112" };
  const gecko = (mints: string[]) => ({
    data: mints.map((mint) => ({
      attributes: { address: mint, symbol: "G", fdv_usd: "12000", market_cap_usd: null },
      relationships: { top_pools: { data: [{ id: `solana_pool_${mint}` }] } },
    })),
    included: mints.map((mint) => ({
      id: `solana_pool_${mint}`,
      attributes: { base_token_price_usd: "0.000012", volume_usd: { m5: "900" } },
      relationships: { base_token: { data: { id: `solana_${mint}` } }, dex: { data: { id: "pump-fun" } } },
    })),
  });

  function stub(geckoAsked: string[][]) {
    vi.stubGlobal("fetch", (url: string) => {
      const list = url.split("/").pop()!.split("?")[0]!.split(",");
      if (url.includes("geckoterminal")) {
        geckoAsked.push(list);
        return Promise.resolve(new Response(JSON.stringify(gecko(list))));
      }
      const pairs = [
        // A launch paired with another coin: DexScreener gives no USD figures at all.
        {
          chainId: "solana",
          dexId: "pumpfun",
          baseToken: { address: "pepeQuoted" },
          quoteToken: { address: "PEPEmint" },
          priceNative: "0.0004",
        },
        {
          chainId: "solana",
          dexId: "pumpfun",
          baseToken: { address: "listed" },
          quoteToken: SOL,
          marketCap: 9_000,
        },
      ].filter((p) => list.includes(p.baseToken.address));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });
  }
  const client = () =>
    new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });

  it("asks GeckoTerminal for a pair with no USD price and for a new launch DexScreener hasn't listed", async () => {
    const asked: string[][] = [];
    stub(asked);
    const tokens = await client().getTokensByAddresses(["listed", "pepeQuoted", "newLaunch", "oldDead"], 5, {
      retries: 0,
      priority: true,
      fallbackIfUnlisted: ["newLaunch"],
    });
    expect(asked).toEqual([["pepeQuoted", "newLaunch"]]);
    const by = new Map(tokens.map((t) => [t.mintAddress, t]));
    expect(by.get("pepeQuoted")).toMatchObject({
      marketCapUsd: 12_000,
      priceUsd: 0.000012,
      volume5mUsd: 900,
    });
    expect(by.get("newLaunch")).toMatchObject({ marketCapUsd: 12_000 });
    expect(by.get("listed")).toMatchObject({ marketCapUsd: 9_000 });
    expect(by.has("oldDead")).toBe(false);
  });

  it("leaves other jobs' lookups to DexScreener alone", async () => {
    const asked: string[][] = [];
    stub(asked);
    const tokens = await client().getTokensByAddresses(["listed", "pepeQuoted"], 5, {
      retries: 0,
      fallbackIfUnlisted: ["newLaunch"],
    });
    expect(asked).toEqual([]);
    expect(tokens.find((t) => t.mintAddress === "pepeQuoted")?.marketCapUsd).toBe(0);
  });
});
