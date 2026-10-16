import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JupiterClient,
  JupiterFirstLookup,
  jupiterPriorityReserve,
  jupiterRequestsPerMinute,
  parseJupiterLaunches,
  parseJupiterMovingLaunches,
  parseJupiterQuotes,
  parseJupiterTokens,
} from "./jupiter.js";
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
      marketSource: "jupiter",
    });
    expect(b).toMatchObject({ mintAddress: "b", priceUsd: 0, marketCapUsd: 5_000, liquidityUsd: undefined });
    expect(b!.volume24hUsd).toBeUndefined();
    expect(parseJupiterTokens({ error: "nope" }, new Set(["a"]))).toEqual([]);
  });
});

describe("parseJupiterLaunches", () => {
  it("reads a launch the way the band refresh reads a DexScreener pair", () => {
    const body = [
      {
        id: "curve",
        symbol: "CRV",
        name: "Curve coin",
        usdPrice: 0.0000105,
        mcap: 10_500,
        liquidity: 8_000,
        launchpad: "pump.fun",
        firstPool: { id: "curve", createdAt: "2026-10-12T20:47:03Z" },
        stats5m: { priceChange: 240, buyVolume: 2_000, sellVolume: 500, numBuys: 30, numSells: 9 },
        stats1h: { priceChange: 240, buyVolume: 2_000, sellVolume: 500, numBuys: 30, numSells: 9 },
        stats24h: { priceChange: 240, buyVolume: 2_000, sellVolume: 500, numBuys: 30, numSells: 9 },
      },
      {
        id: "graduate",
        usdPrice: 0.00005,
        // Counted on the supply left after burns: the cap is read on Pump.fun's 1B instead.
        mcap: 45_500,
        liquidity: 10_000,
        launchpad: "pump.fun",
        graduatedPool: "pool",
        graduatedAt: "2026-10-12T20:50:00Z",
      },
      { id: "untraded", usdPrice: null, mcap: null, launchpad: "pump.fun" },
      { id: "stranger", usdPrice: 1, mcap: 1 },
    ];
    const [curve, graduate, ...rest] = parseJupiterLaunches(body, new Set(["curve", "graduate", "untraded"]));
    expect(rest).toEqual([]);
    expect(curve).toMatchObject({
      mintAddress: "curve",
      symbol: "CRV",
      priceUsd: 0.0000105,
      marketCapUsd: 10_500,
      // A curve reads with no liquidity, as it does on DexScreener.
      liquidityUsd: undefined,
      dexId: "pumpfun",
      pairCreatedAt: new Date("2026-10-12T20:47:03Z"),
      priceChange5mPct: 240,
      volume5mUsd: 2_500,
      buys5m: 30,
      sells5m: 9,
      buys1h: 30,
      volume24hUsd: 2_500,
      marketSource: "jupiter",
    });
    expect(graduate).toMatchObject({
      marketCapUsd: 50_000,
      dexId: "pumpswap",
      marketSource: "jupiter",
      graduatedAt: new Date("2026-10-12T20:50:00Z"),
      liquidityUsd: 20_000,
      volume5mUsd: undefined,
    });
    expect(curve!.graduatedAt).toBeUndefined();
    expect(parseJupiterLaunches({ error: "nope" }, new Set(["curve"]))).toEqual([]);
  });

  it("reads a Stonks coin on its LaunchLab curve, and after it moves to its Raydium pool", () => {
    const [curve, graduate] = parseJupiterLaunches(
      [
        {
          id: "stonkCurve",
          usdPrice: 0.00002,
          mcap: 20_000,
          fdv: 20_000,
          liquidity: 9_000,
          launchpad: "stonkfun",
        },
        {
          id: "stonkPool",
          usdPrice: 0.0001,
          mcap: 99_000,
          fdv: 100_000,
          liquidity: 30_000,
          launchpad: "stonkfun",
          graduatedPool: "cpmm",
          graduatedAt: "2026-10-16T00:10:00Z",
        },
      ],
      new Set(["stonkCurve", "stonkPool"]),
    );
    expect(curve).toMatchObject({ dexId: "stonkfun", launchpad: "stonks", liquidityUsd: undefined });
    expect(curve!.graduatedAt).toBeUndefined();
    expect(graduate).toMatchObject({ dexId: "raydium", launchpad: "stonks", liquidityUsd: 60_000 });
    expect(graduate!.graduatedAt).toEqual(new Date("2026-10-16T00:10:00Z"));
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
        holderCount: 412,
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
      holderCount: 412,
    });
    expect(quotes[1]!.quote).toMatchObject({
      marketCapUsd: 10_000,
      updatedAt: undefined,
      stats5m: undefined,
      holderCount: undefined,
    });
  });
});

describe("JupiterClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives no fresh quotes, at once, while Jupiter rate-limits us - the decision goes ahead on DexScreener's price", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", () => {
      calls += 1;
      return Promise.resolve(new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
    });
    const client = new JupiterClient({ apiKey: "k", requestsPerMinute: 6000 });
    const mints = Array.from({ length: 250 }, (_, i) => `m${i}`);
    expect((await client.getFreshQuotes(mints, { deadlineMs: 2_500 })).size).toBe(0);
    // The next cycle doesn't wait out the pause or call again: it gives up on the spot.
    const startedAt = Date.now();
    expect((await client.getFreshQuotes(mints, { deadlineMs: 2_500 })).size).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(calls).toBeLessThanOrEqual(3);
  });

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

  it("keeps its reserve for the scan's fresh quotes while other callers have spent the rest", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const list = decodeURIComponent(url.split("query=")[1]!).split(",");
      return Promise.resolve(new Response(JSON.stringify(list.map((id) => ({ id, usdPrice: 1, mcap: 1 })))));
    });
    // One call a second once the burst of 5 is spent; 2 of the 5 are reserved.
    const client = new JupiterClient({ apiKey: "k", requestsPerMinute: 60, burst: 5 });
    const batch = (from: number) => Array.from({ length: 100 }, (_, i) => `m${from + i}`);
    // The outcome watcher's lookups take the three ordinary slots.
    await client.getTokensByAddresses([...batch(0), ...batch(100), ...batch(200)], 3, { retries: 0 });
    // Another ordinary lookup now waits on the reserve: past a short deadline, it gets nothing.
    const failed = new Set<string>();
    expect(await client.getTokensByAddresses(batch(300), 1, { deadlineMs: 300, retries: 0, failed })).toEqual(
      [],
    );
    expect(failed.size).toBe(100);
    // The decision's fresh quotes go out at once on the reserved slots.
    const startedAt = Date.now();
    expect((await client.getFreshQuotes(batch(400), { deadlineMs: 300 })).size).toBe(100);
    expect(Date.now() - startedAt).toBeLessThan(250);
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

describe("jupiterRequestsPerMinute", () => {
  it("holds a paid plan to its credits, not its rate", () => {
    // Developer: 25M credits at 10 a search, 90% over a 31-day month - not 10 a second.
    expect(jupiterRequestsPerMinute(25_000_000, 8)).toBe(50);
    expect(50 * 10 * 31 * 24 * 60).toBeLessThanOrEqual(25_000_000);
    // Launch: 100M credits, 50 a second.
    expect(jupiterRequestsPerMinute(100_000_000, 40)).toBe(201);
  });

  it("goes by the rate alone with no credit cap (the free plan), and never below 1", () => {
    expect(jupiterRequestsPerMinute(0, 1)).toBe(54);
    expect(jupiterRequestsPerMinute(1, 8)).toBe(1);
  });

  it("reserves half the burst for the scan's reads, at least 2", () => {
    expect(jupiterPriorityReserve(8)).toBe(4);
    expect(jupiterPriorityReserve(5)).toBe(2);
    expect(jupiterPriorityReserve(1)).toBe(2);
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
    const freshSources = new Set<string>();
    const out = await lookup.getTokensByAddresses(["priced", "zero", "absent", "unanswered"], 5, {
      freshSources,
    });
    // Only the price Jupiter itself gave is marked seconds-old.
    expect([...freshSources]).toEqual(["priced"]);
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
    const unasked = new Set<string>();
    await lookup.getTokensByAddresses(["priced", "junk", "unanswered"], 3, { mayBeUnindexed: true, unasked });
    expect(dex.getTokensByAddresses.mock.calls[0]![0]).toEqual(["unanswered"]);
    // The mint nobody was asked about is named, so a caller doesn't read its absence as "no pair".
    expect([...unasked]).toEqual(["junk"]);
  });

  it("names nothing unasked when every miss goes on to DexScreener", async () => {
    const jupiter = { getTokensByAddresses: vi.fn(async () => [token("priced"), token("zero", 0)]) };
    const dex = { getTokensByAddresses: vi.fn(async (_mints: string[]) => [] as CandidateToken[]) };
    const unasked = new Set<string>();
    await new JupiterFirstLookup(jupiter, dex).getTokensByAddresses(["priced", "zero", "absent"], 3, {
      unasked,
    });
    expect(dex.getTokensByAddresses.mock.calls[0]![0]).toEqual(["zero", "absent"]);
    expect(unasked.size).toBe(0);
    // A token Jupiter answered without a price was answered, not skipped.
    const skipped = new Set<string>();
    await new JupiterFirstLookup(jupiter, dex).getTokensByAddresses(["priced", "zero", "absent"], 3, {
      mayBeUnindexed: true,
      unasked: skipped,
    });
    expect([...skipped]).toEqual(["absent"]);
  });

  it("never touches DexScreener when Jupiter priced everything", async () => {
    const jupiter = { getTokensByAddresses: vi.fn(async (mints: string[]) => mints.map((m) => token(m))) };
    const dex = { getTokensByAddresses: vi.fn(async (_mints: string[]) => [] as CandidateToken[]) };
    const out = await new JupiterFirstLookup(jupiter, dex).getTokensByAddresses(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(dex.getTokensByAddresses).not.toHaveBeenCalled();
  });
});

describe("parseJupiterMovingLaunches", () => {
  it("keeps Pump.fun and Stonks launches, priced on the 1B supply, with no socials claimed", () => {
    const coins = parseJupiterMovingLaunches([
      {
        id: "pumpMint",
        symbol: "DOG",
        name: "Dog",
        usdPrice: 0.00005,
        mcap: 46_000,
        launchpad: "pump.fun",
        icon: "https://ipfs.io/ipfs/x",
        firstPool: { createdAt: "2026-10-15T12:00:00Z" },
        graduatedAt: "2026-10-15T12:30:00Z",
      },
      { id: "otherMint", usdPrice: 1, launchpad: "letsbonk.fun" },
      { id: "noPad", usdPrice: 1 },
      { id: "stonkMint", usdPrice: 0.0001, mcap: 99_000, fdv: 100_000, launchpad: "stonkfun" },
    ]);
    expect(coins).toHaveLength(2);
    expect(coins[1]).toMatchObject({ mintAddress: "stonkMint", launchpad: "stonks", marketCapUsd: 100_000 });
    expect(coins[0]!.launchpad).toBe("pumpfun");
    expect(coins[0]).toMatchObject({
      mintAddress: "pumpMint",
      symbol: "DOG",
      marketCapUsd: 50_000,
      graduated: true,
      imageUrl: "https://ipfs.io/ipfs/x",
      createdAt: new Date("2026-10-15T12:00:00Z"),
    });
    expect(coins[0]!.description).toBeUndefined();
    // The lists carry no socials: unknown, never a false the row would store as "none".
    expect(coins[0]!.hasTwitter).toBeUndefined();
    expect(coins[0]!.hasWebsite).toBeUndefined();
    expect(parseJupiterMovingLaunches({ error: "x" })).toEqual([]);
  });
});

describe("JupiterClient.discoverMovingLaunches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("merges the lists, skips a failed one, and asks again only after the interval", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      if (url.includes("toptrending")) return Promise.resolve(new Response("nope", { status: 500 }));
      const id = url.includes("recent") ? "new" : "old";
      return Promise.resolve(new Response(JSON.stringify([{ id, usdPrice: 0.0001, launchpad: "pump.fun" }])));
    });
    const client = new JupiterClient({ apiKey: "k", requestsPerMinute: 6000 });
    const first = await client.discoverMovingLaunches({ now: 1_000_000 });
    expect(first.map((c) => c.mintAddress).sort()).toEqual(["new", "old"]);
    expect(urls).toHaveLength(3);
    expect(await client.discoverMovingLaunches({ now: 1_030_000 })).toEqual([]);
    expect(urls).toHaveLength(3);
    await client.discoverMovingLaunches({ now: 1_061_000 });
    expect(urls).toHaveLength(6);
  });
});

describe("JupiterClient.recentLaunches", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the newest pools alone, keeping only Pump.fun's", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { id: "pumpMint", usdPrice: 0.00001, launchpad: "pump.fun" },
            { id: "dbcMint", usdPrice: 0.00001, launchpad: "met-dbc" },
          ]),
        ),
      );
    });
    const client = new JupiterClient({ apiKey: "k", requestsPerMinute: 6000 });
    const coins = await client.recentLaunches();
    expect(coins.map((c) => c.mintAddress)).toEqual(["pumpMint"]);
    expect(urls).toEqual(["https://api.jup.ag/tokens/v2/recent"]);
  });
});
