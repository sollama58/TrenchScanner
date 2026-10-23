import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DexScreenerClient,
  canonicalPairCreatedAt,
  pickCanonicalPair,
  pumpSwapPoolCreatedAt,
} from "./dexscreener.js";
import { MARKET_SOURCE } from "../marketSource.js";
import { buildCandidateFeatures } from "../curation/features.js";
import { enrichToken } from "../discovery/enrich.js";
import { GeckoTerminalClient, parseGeckoTokens } from "./geckoterminal.js";
import type { CandidateToken, ScoredToken } from "../types.js";

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

  it("reads a curve quoted in another coin as trading from its trade count, not its USD volume", () => {
    // DexScreener reports such a curve's USD volume as 0 however much it trades.
    const tokenCurve = { dexId: "pumpfun", volume: { h1: 0 }, txns: { h1: { buys: 40, sells: 30 } } };
    const side = { dexId: "meteora", liquidity: { usd: 5_000 }, volume: { h1: 50 } };
    expect(pickCanonicalPair([tokenCurve, side])).toBe(tokenCurve);
  });

  it("moves a curve quoted in another coin to its pumpswap pool in that coin once it trades", () => {
    const DOPE = { address: "DOPEmint" };
    const frozen = {
      dexId: "pumpfun",
      quoteToken: DOPE,
      volume: { h1: 0 },
      txns: { h1: { buys: 9, sells: 3 } },
    };
    const pool = {
      dexId: "pumpswap",
      quoteToken: DOPE,
      volume: { h1: 0 },
      txns: { h1: { buys: 50, sells: 20 } },
    };
    expect(pickCanonicalPair([frozen, pool])).toBe(pool);
    // A dust pool quoted in some other coin is no graduation.
    const stray = { ...pool, quoteToken: { address: "OTHERmint" } };
    expect(pickCanonicalPair([frozen, stray])).toBe(frozen);
  });

  it("falls back to the deepest pair when nothing is funded", () => {
    const a = { dexId: "meteora", liquidity: { usd: 10 } };
    const b = { dexId: "raydium", liquidity: { usd: 500 } };
    expect(pickCanonicalPair([a, b])).toBe(b);
  });

  it("keeps the PumpSwap pool when a spam Meteora or Raydium pool is deeper", () => {
    const curve = { dexId: "pumpfun", volume: { h1: 0 }, pairCreatedAt: 1_000 };
    const pumpswap = {
      dexId: "pumpswap",
      liquidity: { usd: 20_000 },
      volume: { h1: 100 },
      pairCreatedAt: 3_000,
    };
    const meteora = {
      dexId: "meteora",
      liquidity: { usd: 90_000 },
      volume: { h1: 8_000 },
      pairCreatedAt: 9_000,
    };
    const raydium = { dexId: "raydium", liquidity: { usd: 80_000 }, pairCreatedAt: 8_000 };
    expect(pickCanonicalPair([curve, meteora, pumpswap])).toBe(pumpswap);
    expect(pickCanonicalPair([pumpswap, raydium])).toBe(pumpswap);
    // A drained graduation pool still beats a deeper junk pool and the frozen curve.
    const drained = { dexId: "pumpswap", liquidity: { usd: 600 }, pairCreatedAt: 3_000 };
    expect(pickCanonicalPair([curve, meteora, drained])).toBe(drained);
  });

  it("keeps a quiet curve over a funded Meteora pool, and a Raydium graduation over that pool", () => {
    const quiet = { dexId: "pumpfun", volume: { h1: 0 }, pairCreatedAt: 1_000 };
    const spam = { dexId: "meteora", liquidity: { usd: 40_000 }, pairCreatedAt: 500 };
    expect(pickCanonicalPair([quiet, spam])).toBe(quiet);
    const raydium = { dexId: "raydium", liquidity: { usd: 12_000 }, pairCreatedAt: 4_000 };
    expect(pickCanonicalPair([quiet, spam, raydium])).toBe(raydium);
  });

  it("takes the documented branch for each shape of pair list", () => {
    const pair = (label: string, dexId: string, extra: Record<string, unknown> = {}) => ({
      label,
      dexId,
      ...extra,
    });
    const cases: {
      name: string;
      pairs: ReturnType<typeof pair>[];
      winner: string;
      launchHomeClock?: boolean;
    }[] = [
      {
        name: "the deepest funded pumpswap pool, ahead of a trading curve and a deeper side pool",
        pairs: [
          pair("curve", "pumpfun", { volume: { h1: 20_000 } }),
          pair("spam", "meteora", { liquidity: { usd: 90_000 }, volume: { h1: 8_000 } }),
          pair("thin", "pumpswap", { liquidity: { usd: 2_000 }, volume: { h1: 10 } }),
          pair("home", "pumpswap", { liquidity: { usd: 20_000 }, volume: { h1: 10 } }),
        ],
        winner: "home",
      },
      {
        name: "a pumpswap pool quoted in the curve's own coin once it trades",
        pairs: [
          pair("curve", "pumpfun", {
            quoteToken: { address: "DOPE" },
            volume: { h1: 0 },
            txns: { h1: { buys: 9, sells: 3 } },
          }),
          pair("home", "pumpswap", {
            quoteToken: { address: "DOPE" },
            volume: { h1: 0 },
            txns: { h1: { buys: 4, sells: 1 } },
          }),
          pair("stray", "pumpswap", {
            quoteToken: { address: "OTHER" },
            volume: { h1: 0 },
            txns: { h1: { buys: 80, sells: 40 } },
          }),
        ],
        winner: "home",
      },
      {
        name: "a pumpswap pool quoted in some other coin is not that graduation",
        pairs: [
          pair("home", "pumpfun", {
            quoteToken: { address: "DOPE" },
            volume: { h1: 0 },
            txns: { h1: { buys: 9, sells: 3 } },
          }),
          pair("stray", "pumpswap", {
            quoteToken: { address: "OTHER" },
            volume: { h1: 0 },
            txns: { h1: { buys: 80, sells: 40 } },
          }),
        ],
        winner: "home",
      },
      {
        name: "a trading curve, by volume, over a funded side pool",
        pairs: [
          pair("home", "pumpfun", { volume: { h1: 20_000 } }),
          pair("spam", "meteora", { liquidity: { usd: 50_000 }, volume: { h1: 9_000 } }),
        ],
        winner: "home",
      },
      {
        name: "a drained pumpswap pool over the frozen curve and a deeper Meteora pool",
        pairs: [
          pair("curve", "pumpfun", { volume: { h1: 0 } }),
          pair("spam", "meteora", { liquidity: { usd: 90_000 } }),
          pair("home", "pumpswap", { liquidity: { usd: 600 } }),
        ],
        winner: "home",
      },
      {
        name: "a quiet curve over a dust pumpswap pool",
        pairs: [
          pair("home", "pumpfun", { volume: { h1: 0 } }),
          pair("dust", "pumpswap", { liquidity: { usd: 10 } }),
        ],
        winner: "home",
      },
      {
        name: "a quiet Pump.fun curve yields to its funded Raydium graduation, not to Meteora",
        pairs: [
          pair("curve", "pumpfun", { volume: { h1: 0 } }),
          pair("spam", "meteora", { liquidity: { usd: 40_000 } }),
          pair("home", "raydium", { liquidity: { usd: 12_000 } }),
        ],
        winner: "home",
      },
      {
        name: "a quiet Stonks curve yields to Raydium the same way",
        pairs: [
          pair("curve", "stonkfun", { volume: { h1: 0 } }),
          pair("home", "raydium", { liquidity: { usd: 12_000 } }),
        ],
        winner: "home",
      },
      {
        launchHomeClock: true,
        name: "a quiet LaunchLab curve yields to its Raydium pool",
        pairs: [
          pair("curve", "launchlab", { volume: { h1: 0 } }),
          pair("spam", "meteora", { liquidity: { usd: 80_000 } }),
          pair("home", "raydium", { liquidity: { usd: 12_000 } }),
        ],
        winner: "home",
      },
      {
        launchHomeClock: true,
        name: "a quiet Meteora DBC stays the pair beside a funded Raydium pool",
        pairs: [
          pair("home", "meteoradbc", { volume: { h1: 0 }, liquidity: { usd: 3_000 } }),
          pair("ray", "raydium", { liquidity: { usd: 40_000 } }),
          pair("amm", "meteora", { liquidity: { usd: 90_000 } }),
        ],
        winner: "home",
      },
      {
        launchHomeClock: true,
        name: "a trading Meteora DBC over a deeper Meteora AMM",
        pairs: [
          pair("amm", "meteora", { liquidity: { usd: 90_000 }, volume: { h1: 8_000 } }),
          pair("home", "meteoradbc", { volume: { h1: 1_000 }, liquidity: { usd: 4_000 } }),
        ],
        winner: "home",
      },
      {
        launchHomeClock: true,
        name: "a trading LaunchLab curve over a deeper Meteora pool",
        pairs: [
          pair("spam", "meteora", { liquidity: { usd: 90_000 }, volume: { h1: 8_000 } }),
          pair("home", "launchlab", { volume: { h1: 500 } }),
        ],
        winner: "home",
      },
      {
        name: "the deepest funded pool when no curve and no PumpSwap pool exist",
        pairs: [
          pair("thin", "raydium", { liquidity: { usd: 2_000 } }),
          pair("home", "meteora", { liquidity: { usd: 8_000 } }),
        ],
        winner: "home",
      },
      {
        name: "the deepest pair of any size when nothing is funded",
        pairs: [
          pair("dust", "meteora", { liquidity: { usd: 10 } }),
          pair("home", "raydium", { liquidity: { usd: 500 } }),
        ],
        winner: "home",
      },
    ];
    for (const c of cases) {
      expect(pickCanonicalPair(c.pairs, c.launchHomeClock === true).label, c.name).toBe(c.winner);
    }
  });
});

describe("pair clock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const launch = Date.parse("2026-10-21T12:00:00Z");
  const grad = Date.parse("2026-10-21T13:00:00Z");
  const spamAt = Date.parse("2026-10-21T11:00:00Z");
  const now = new Date(grad + 30 * 60_000);

  function scored(token: CandidateToken, launchedAt?: Date): ScoredToken {
    const enriched = enrichToken(token, null, { now, launchedAt });
    return {
      ...enriched,
      narrativeTags: enriched.narrativeTags ?? [],
      rugScreen: { passed: true, reasons: [] },
      score: { momentum: 0, holderHealth: 0, age: 0, narrative: 0, total: 0 },
    };
  }

  it("follows the canonical PumpSwap pair, not a deeper newer Meteora pool", async () => {
    const pairs = [
      {
        chainId: "solana",
        dexId: "pumpfun",
        baseToken: { address: "m" },
        volume: { h1: 0 },
        marketCap: 80_000,
        pairCreatedAt: launch,
      },
      {
        chainId: "solana",
        dexId: "pumpswap",
        baseToken: { address: "m" },
        liquidity: { usd: 20_000 },
        volume: { h1: 100 },
        marketCap: 80_000,
        pairCreatedAt: grad,
      },
      {
        chainId: "solana",
        dexId: "meteora",
        baseToken: { address: "m" },
        liquidity: { usd: 90_000 },
        volume: { h1: 5_000 },
        marketCap: 10_000,
        pairCreatedAt: Date.parse("2026-10-21T13:40:00Z"),
      },
    ];
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(pairs))));
    const [token] = await new DexScreenerClient().getTokensByAddresses(["m"], 1, { retries: 0 });
    expect(token?.dexId).toBe("pumpswap");
    expect(token?.pairCreatedAt).toEqual(new Date(grad));
    const features = buildCandidateFeatures(scored(token!, new Date(launch)), now);
    // Launch was an hour before graduation; the pool clock is the thirty minutes since graduation.
    expect(features.ageMinutes).toBe(90);
    expect(features.pairAgeMinutes).toBeCloseTo(30);
  });

  it("follows the bonding curve when that is the canonical pair beside a Meteora pool", async () => {
    const pairs = [
      {
        chainId: "solana",
        dexId: "pumpfun",
        baseToken: { address: "m" },
        volume: { h1: 2_000 },
        marketCap: 20_000,
        pairCreatedAt: launch,
      },
      {
        chainId: "solana",
        dexId: "meteora",
        baseToken: { address: "m" },
        liquidity: { usd: 50_000 },
        volume: { h1: 9_000 },
        marketCap: 20_000,
        pairCreatedAt: spamAt,
      },
    ];
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(pairs))));
    const [token] = await new DexScreenerClient().getTokensByAddresses(["m"], 1, { retries: 0 });
    expect(token?.dexId).toBe("pumpfun");
    expect(token?.pairCreatedAt).toEqual(new Date(launch));
    const features = buildCandidateFeatures(scored(token!, new Date(launch)), now);
    expect(features.pairAgeMinutes).toBeCloseTo(90);
    expect(features.ageMinutes).toBe(90);
  });

  it("does not invent a pool age from a Meteora pool alone", async () => {
    const pairs = [
      {
        chainId: "solana",
        dexId: "meteora",
        baseToken: { address: "m" },
        liquidity: { usd: 90_000 },
        marketCap: 10_000,
        pairCreatedAt: spamAt,
      },
    ];
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(pairs))));
    const [token] = await new DexScreenerClient().getTokensByAddresses(["m"], 1, { retries: 0 });
    expect(token?.dexId).toBe("meteora");
    expect(token?.pairCreatedAt).toBeUndefined();
    const enriched = enrichToken(token!, null, { now });
    expect(enriched.ageMinutes).toBeUndefined();
    expect(buildCandidateFeatures(scored(token!), now).pairAgeMinutes).toBeNull();
  });

  it("keeps a Meteora DBC or LaunchLab curve's age when that curve is the pair", () => {
    const at = Date.parse("2026-10-21T12:00:00Z");
    expect(canonicalPairCreatedAt("meteoradbc", at)).toBeUndefined();
    expect(canonicalPairCreatedAt("launchlab", at)).toBeUndefined();
    expect(canonicalPairCreatedAt("meteoradbc", at, true)).toEqual(new Date(at));
    expect(canonicalPairCreatedAt("launchlab", at, true)).toEqual(new Date(at));
    expect(canonicalPairCreatedAt("meteora", at, true)).toBeUndefined();
    expect(canonicalPairCreatedAt("meteoradbc", 0, true)).toBeUndefined();
    expect(canonicalPairCreatedAt(undefined, at, true)).toBeUndefined();
  });

  it("reads a DBC-only and a LaunchLab-only listing as that home's clock", async () => {
    const at = Date.parse("2026-10-21T12:00:00Z");
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              chainId: "solana",
              dexId: "meteoradbc",
              baseToken: { address: "dbc" },
              liquidity: { usd: 4_000 },
              volume: { h1: 1_000 },
              marketCap: 20_000,
              pairCreatedAt: at,
            },
            {
              chainId: "solana",
              dexId: "launchlab",
              baseToken: { address: "lab" },
              volume: { h1: 800 },
              marketCap: 15_000,
              pairCreatedAt: at,
            },
          ]),
        ),
      ),
    );
    const tokens = await new DexScreenerClient({ launchHomeClock: true }).getTokensByAddresses(
      ["dbc", "lab"],
      1,
      { retries: 0 },
    );
    const by = new Map(tokens.map((t) => [t.mintAddress, t]));
    expect(by.get("dbc")?.dexId).toBe("meteoradbc");
    expect(by.get("dbc")?.pairCreatedAt).toEqual(new Date(at));
    expect(by.get("lab")?.dexId).toBe("launchlab");
    expect(by.get("lab")?.pairCreatedAt).toEqual(new Date(at));
    expect(buildCandidateFeatures(scored(by.get("dbc")!), now).pairAgeMinutes).toBeCloseTo(90);
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

describe("socials on a candidate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("are unknown without an info block, and a read none or link with one", async () => {
    // Nearly every young coin's pair has no info block: nothing was read, so nothing is claimed
    // (a false here was stored as "none" and the models read 0 as "unread" - 2026-10-16 audit).
    const pairs = [
      { chainId: "solana", dexId: "pumpfun", baseToken: { address: "bare" }, volume: { h1: 1 } },
      {
        chainId: "solana",
        dexId: "pumpfun",
        baseToken: { address: "profiled" },
        volume: { h1: 1 },
        info: { socials: [{ type: "twitter", url: "https://x.com/a" }] },
      },
    ];
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify(pairs))));
    const tokens = await new DexScreenerClient().getTokensByAddresses(["bare", "profiled"], 1, {
      retries: 0,
    });
    const by = new Map(tokens.map((t) => [t.mintAddress, t]));
    expect(by.get("bare")?.hasTwitter).toBeUndefined();
    expect(by.get("bare")?.hasWebsite).toBeUndefined();
    expect(by.get("bare")?.dexInfo).toBeUndefined();
    expect(by.get("profiled")?.hasTwitter).toBe(true);
    expect(by.get("profiled")?.hasWebsite).toBe(false);
    // The info block is DexScreener token info. It carries no payment time.
    expect(by.get("profiled")?.dexInfo).toBe(true);
  });
});

describe("token info orders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads a token-profile payment and leaves a failed mint out", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      if (url.endsWith("/paid")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([{ type: "tokenProfile", status: "approved", paymentTimestamp: 1_700_000_000 }]),
          ),
        );
      }
      return Promise.resolve(new Response("", { status: 500 }));
    });
    const reads = await new DexScreenerClient().readTokenInfoOrders(["paid", "down"]);
    expect(reads).toEqual([
      { mint: "paid", payment: { type: "tokenProfile", updated: false, paidAtMs: 1_700_000_000_000 } },
    ]);
    expect(urls.every((url) => url.includes("/orders/v1/solana/"))).toBe(true);
  });

  it("gives up on the orders and takeover reads, instead of queueing, while the discovery budget is paused", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      return Promise.resolve(new Response("[]"));
    });
    const client = new DexScreenerClient();
    // A 429 paused the budget for longer than these reads wait (DEX_INFO_GATE_WAIT_MS).
    (client as unknown as { discoveryGate: { throttled(ms: number): void } }).discoveryGate.throttled(60_000);
    const startedAt = Date.now();
    expect(await client.readTokenInfoOrders(["a", "b"])).toEqual([]);
    expect(await client.communityTakeoverMints()).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(urls).toEqual([]);
  });

  it("marks a profile feed mint as token info and a boost-only mint as not", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const body = url.includes("token-profiles")
        ? [{ chainId: "solana", tokenAddress: "profiled", links: [] }]
        : [{ chainId: "solana", tokenAddress: "boosted", amount: 10 }];
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
    const found = await new DexScreenerClient().discoverTrendingMints();
    const by = new Map(found.map((c) => [c.mintAddress, c]));
    expect(by.get("profiled")?.dexInfo).toBe(true);
    expect(by.get("boosted")?.dexInfo).toBeUndefined();
    expect(by.get("boosted")?.boosted).toBe(true);
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

    expect(await lookup()).toMatchObject({
      dexId: "pumpfun",
      marketCapUsd: 45_000,
      marketSource: "dexscreener",
    });
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

describe("getTokensByAddresses fallback when DexScreener fails", () => {
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

  /** DexScreener answers 503 for any batch holding a mint in `down`, pairs otherwise. */
  function stub(down: (mint: string) => boolean) {
    const geckoAsked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      const list = url.split("/").pop()!.split("?")[0]!.split(",");
      if (url.includes("geckoterminal")) {
        geckoAsked.push(...list);
        return Promise.resolve(new Response(JSON.stringify(geckoBody(list))));
      }
      if (list.some(down)) return Promise.resolve(new Response("down", { status: 503 }));
      const pairs = list.map((mint) => ({
        chainId: "solana",
        dexId: "raydium",
        baseToken: { address: mint },
        marketCap: 1,
      }));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });
    return geckoAsked;
  }

  it("prices a failed batch's mints from GeckoTerminal and leaves only unanswered ones failed", async () => {
    const mints = Array.from({ length: 60 }, (_, i) => `mint${i}`);
    // The second batch of 30 fails.
    const geckoAsked = stub((m) => Number(m.slice(4)) >= 30);
    const client = new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });
    const failed = new Set<string>();
    const out = await client.getTokensByAddresses(mints, 5, { retries: 0, failed, priority: true });
    expect(out).toHaveLength(60);
    expect(out.find((t) => t.mintAddress === "mint0")?.dexId).toBe("raydium");
    expect(out.find((t) => t.mintAddress === "mint45")?.dexId).toBe("pumpfun");
    expect(geckoAsked.sort()).toEqual(mints.slice(30).sort());
    expect(failed.size).toBe(0);
    // Part of the lookup answered: not an outage.
    expect(client.usingFallback).toBe(false);
  });

  it("routes around DexScreener once every batch of a lookup fails", async () => {
    const mints = Array.from({ length: 60 }, (_, i) => `mint${i}`);
    stub(() => true);
    const client = new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });
    const out = await client.getTokensByAddresses(mints, 5, { retries: 0 });
    expect(out).toHaveLength(60);
    expect(client.usingFallback).toBe(true);
  });

  it("does not send mints that may be unindexed to the fallback", async () => {
    const geckoAsked = stub(() => true);
    const client = new DexScreenerClient({
      fallback: new GeckoTerminalClient({ priorityPerMinute: 6000, backgroundPerMinute: 6000 }),
    });
    const failed = new Set<string>();
    await client.getTokensByAddresses(["a", "b"], 5, { retries: 0, mayBeUnindexed: true, failed });
    expect(geckoAsked).toEqual([]);
    expect(failed.size).toBe(2);
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
      marketSource: "gecko",
    });
    expect(t?.pairCreatedAt?.toISOString()).toBe("2026-10-07T20:00:00.000Z");
  });

  it("prices the canonical PumpSwap pool, not a deeper Meteora pool listed first, and invents no age from Meteora alone", () => {
    const mint = "m1";
    const body = {
      data: [
        {
          attributes: { address: mint, price_usd: "2", market_cap_usd: "1000" },
          relationships: { top_pools: { data: [{ id: "p_spam" }, { id: "p_swap" }] } },
        },
        {
          attributes: { address: "onlySpam", price_usd: "1", market_cap_usd: "500" },
          relationships: { top_pools: { data: [{ id: "p_only" }] } },
        },
      ],
      included: [
        {
          id: "p_spam",
          attributes: {
            address: "spam-pool",
            base_token_price_usd: "9",
            reserve_in_usd: "90000",
            pool_created_at: "2026-10-21T11:00:00Z",
          },
          relationships: {
            base_token: { data: { id: `solana_${mint}` } },
            dex: { data: { id: "meteora" } },
          },
        },
        {
          id: "p_swap",
          attributes: {
            address: "grad-pool",
            base_token_price_usd: "1.5",
            reserve_in_usd: "20000",
            pool_created_at: "2026-10-21T13:00:00Z",
          },
          relationships: {
            base_token: { data: { id: `solana_${mint}` } },
            dex: { data: { id: "pumpswap" } },
          },
        },
        {
          id: "p_only",
          attributes: {
            address: "only-pool",
            base_token_price_usd: "1",
            reserve_in_usd: "40000",
            pool_created_at: "2026-10-21T10:00:00Z",
          },
          relationships: {
            base_token: { data: { id: "solana_onlySpam" } },
            dex: { data: { id: "meteora" } },
          },
        },
      ],
    };
    const by = new Map(parseGeckoTokens(body, new Set([mint, "onlySpam"])).map((t) => [t.mintAddress, t]));
    expect(by.get(mint)).toMatchObject({ dexId: "pumpswap", pairAddress: "grad-pool", priceUsd: 1.5 });
    expect(by.get(mint)?.pairCreatedAt?.toISOString()).toBe("2026-10-21T13:00:00.000Z");
    expect(by.get("onlySpam")?.dexId).toBe("meteora");
    expect(by.get("onlySpam")?.pairCreatedAt).toBeUndefined();
  });

  it("keeps a Meteora DBC or LaunchLab home's age, and still drops a Meteora AMM", () => {
    const mint = "homeMint";
    const body = {
      data: [
        {
          attributes: { address: mint, price_usd: "1", market_cap_usd: "20000" },
          relationships: { top_pools: { data: [{ id: "p_amm" }, { id: "p_dbc" }] } },
        },
        {
          attributes: { address: "labMint", price_usd: "1", market_cap_usd: "15000" },
          relationships: { top_pools: { data: [{ id: "p_lab" }, { id: "p_cpmm" }] } },
        },
      ],
      included: [
        {
          id: "p_amm",
          attributes: {
            address: "amm",
            base_token_price_usd: "9",
            reserve_in_usd: "90000",
            pool_created_at: "2026-10-21T10:00:00Z",
            volume_usd: { h1: "8000" },
          },
          relationships: {
            base_token: { data: { id: `solana_${mint}` } },
            dex: { data: { id: "meteora" } },
          },
        },
        {
          id: "p_dbc",
          attributes: {
            address: "dbc-pool",
            base_token_price_usd: "1",
            reserve_in_usd: "4000",
            pool_created_at: "2026-10-21T12:00:00Z",
            volume_usd: { h1: "1000" },
          },
          relationships: {
            base_token: { data: { id: `solana_${mint}` } },
            dex: { data: { id: "meteora-dbc" } },
          },
        },
        {
          id: "p_lab",
          attributes: {
            address: "lab-pool",
            base_token_price_usd: "1",
            reserve_in_usd: "3000",
            pool_created_at: "2026-10-21T12:30:00Z",
            volume_usd: { h1: "500" },
          },
          relationships: {
            base_token: { data: { id: "solana_labMint" } },
            dex: { data: { id: "raydium-launchlab" } },
          },
        },
        {
          id: "p_cpmm",
          attributes: {
            address: "cpmm-pool",
            base_token_price_usd: "2",
            reserve_in_usd: "20000",
            pool_created_at: "2026-10-21T13:00:00Z",
          },
          relationships: {
            base_token: { data: { id: "solana_labMint" } },
            dex: { data: { id: "raydium-cpmm" } },
          },
        },
      ],
    };
    const off = parseGeckoTokens(body, new Set([mint]));
    expect(off[0]?.dexId).not.toBe("meteoradbc");
    expect(off[0]?.pairCreatedAt).toBeUndefined();
    const by = new Map(
      parseGeckoTokens(body, new Set([mint, "labMint"]), true).map((t) => [t.mintAddress, t]),
    );
    expect(by.get(mint)).toMatchObject({ dexId: "meteoradbc", pairAddress: "dbc-pool" });
    expect(by.get(mint)?.pairCreatedAt?.toISOString()).toBe("2026-10-21T12:00:00.000Z");
    // LaunchLab is still trading, so the later CPMM is not the pair yet.
    expect(by.get("labMint")).toMatchObject({ dexId: "launchlab", pairAddress: "lab-pool" });
    expect(by.get("labMint")?.pairCreatedAt?.toISOString()).toBe("2026-10-21T12:30:00.000Z");
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

  it("peeks a quote older than the lookup cache without another request", async () => {
    const urls = stubPairs();
    const client = new DexScreenerClient();
    await client.getTokensByAddresses(["a"], 1, { retries: 0 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11_000);
    expect(client.cachedQuotes(["a"], 60_000).get("a")?.token.marketCapUsd).toBe(50_000);
    expect(client.cachedQuotes(["a"], 10_000).has("a")).toBe(false);
    expect(urls).toHaveLength(1);
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

  it("prices a pair quoted in another coin off that coin's USD price, for every lookup", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      urls.push(url);
      const list = url.split("/").pop()!.split("?")[0]!.split(",");
      const pairs = [
        {
          chainId: "solana",
          dexId: "pumpfun",
          pairAddress: "curve",
          baseToken: { address: "pedo" },
          quoteToken: { address: "DOPE" },
          priceNative: "0.004",
          volume: { m5: 0, h1: 0, h24: 0 },
          txns: { h1: { buys: 400, sells: 300 } },
        },
        // The quote coin trades against SOL in two pools; the deeper one prices it.
        {
          chainId: "solana",
          dexId: "pumpswap",
          baseToken: { address: "DOPE" },
          quoteToken: SOL,
          priceUsd: "0.0037",
          liquidity: { usd: 230_000 },
        },
        {
          chainId: "solana",
          dexId: "meteora",
          baseToken: { address: "DOPE" },
          quoteToken: SOL,
          priceUsd: "0.0029",
          liquidity: { usd: 4_000 },
        },
      ].filter((p) => list.includes(p.baseToken.address));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });
    const c = new DexScreenerClient();
    const [token] = await c.getTokensByAddresses(["pedo"], 5, { retries: 0 });
    expect(token!.priceUsd).toBeCloseTo(0.004 * 0.0037, 12);
    expect(token!.marketCapUsd).toBeCloseTo(0.004 * 0.0037 * 1e9, 3);
    // Unknown rather than a dead coin's zero.
    expect(token!.volume1hUsd).toBeUndefined();
    expect(token!.dexId).toBe("pumpfun");
    // The quote coin's price is reused for the next lookup.
    await c.getTokensByAddresses(["pedo"], 5, { retries: 0, fresh: true });
    expect(urls.filter((u) => u.endsWith("/DOPE"))).toHaveLength(1);
  });

  it("prices any coin in SOL for a trade paid in it, and leaves out what it can't price", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const list = url.split("/").pop()!.split("?")[0]!.split(",");
      const pairs = [
        {
          dexId: "raydium",
          pairAddress: "s1",
          baseToken: { address: SOL.address },
          quoteToken: { address: "USDC" },
          priceUsd: "200",
          liquidity: { usd: 5e7 },
        },
        {
          dexId: "pumpswap",
          pairAddress: "p1",
          baseToken: { address: "PUMP" },
          quoteToken: SOL,
          priceUsd: "0.008",
          liquidity: { usd: 3e6 },
        },
      ]
        .map((p) => ({ chainId: "solana", ...p }))
        .filter((p) => list.includes(p.baseToken.address));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });
    const prices = await new DexScreenerClient().solPricesOf(["PUMP", "unknown", SOL.address]);
    expect([...prices.keys()]).toEqual(["PUMP"]);
    expect(prices.get("PUMP")).toBeCloseTo(0.008 / 200, 12);
  });

  it("prices a pair whose quote coin is itself quoted in another coin, a tokenized stock included", async () => {
    vi.stubGlobal("fetch", (url: string) => {
      const list = url.split("/").pop()!.split("?")[0]!.split(",");
      const pairs = [
        // A launch on 2XLONGINU, which trades only on LONGINU, which trades on SOL.
        {
          dexId: "pumpfun",
          pairAddress: "c1",
          baseToken: { address: "kid" },
          quoteToken: { address: "TWOX" },
          priceNative: "0.5",
        },
        {
          dexId: "pumpfun",
          pairAddress: "c2",
          baseToken: { address: "TWOX" },
          quoteToken: { address: "LONG" },
          priceNative: "0.2",
        },
        {
          dexId: "pumpswap",
          pairAddress: "c3",
          baseToken: { address: "LONG" },
          quoteToken: SOL,
          priceUsd: "0.01",
          liquidity: { usd: 9_000 },
        },
        // A launch on a tokenized stock.
        {
          dexId: "pumpfun",
          pairAddress: "c4",
          baseToken: { address: "onNvda" },
          quoteToken: { address: "NVDAx" },
          priceNative: "0.00000002",
        },
        {
          dexId: "raydium",
          pairAddress: "c5",
          baseToken: { address: "NVDAx" },
          quoteToken: { address: "USDC" },
          priceUsd: "180",
          liquidity: { usd: 2e6 },
        },
      ]
        .map((p) => ({ chainId: "solana", ...p }))
        .filter((p) => list.includes(p.baseToken.address));
      return Promise.resolve(new Response(JSON.stringify(pairs)));
    });
    const tokens = await new DexScreenerClient().getTokensByAddresses(["kid", "onNvda"], 5, { retries: 0 });
    const by = new Map(tokens.map((t) => [t.mintAddress, t]));
    expect(by.get("kid")!.priceUsd).toBeCloseTo(0.5 * 0.2 * 0.01, 12);
    expect(by.get("onNvda")!.marketCapUsd).toBeCloseTo(0.00000002 * 180 * 1e9, 6);
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

describe("stale readings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A pumpswap pool for `mint` at `priceUsd` on a 1B supply. */
  const pool = (mint: string, priceUsd: number) => ({
    chainId: "solana",
    dexId: "pumpswap",
    baseToken: { address: mint },
    priceUsd: String(priceUsd),
    marketCap: priceUsd * 1e9,
    liquidity: { usd: 20_000 },
  });

  it("re-prices a reading that stopped moving when the cross-check puts it elsewhere, and leaves a quiet coin alone", async () => {
    // Salem, 2026-10-14: DexScreener held it at $43k for hours while it traded at $2-3k.
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-10-14T20:00:00Z");
    vi.setSystemTime(t0);
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify([pool("frozen", 4.3e-5), pool("quiet", 2e-5)]))),
    );
    const asked: string[][] = [];
    const jupiter = {
      getTokensByAddresses: async (mints: string[]) => {
        asked.push(mints);
        return [
          { mintAddress: "frozen", priceUsd: 2.5e-6, marketCapUsd: 2_500 },
          { mintAddress: "quiet", priceUsd: 2.1e-5, marketCapUsd: 21_000 },
        ].filter((t) => mints.includes(t.mintAddress)) as never;
      },
    };
    const client = new DexScreenerClient({ staleCheck: jupiter });
    const read = async () => {
      const tokens = await client.getTokensByAddresses(["frozen", "quiet"]);
      return new Map(tokens.map((t) => [t.mintAddress, t]));
    };

    // Moving or only briefly flat: as DexScreener gave it, and nothing asked.
    expect((await read()).get("frozen")?.marketCapUsd).toBeCloseTo(43_000);
    vi.setSystemTime(t0 + 5 * 60_000);
    await read();
    expect(asked).toEqual([]);

    // Flat for ten minutes: asked about in the background, never waited on.
    vi.setSystemTime(t0 + 11 * 60_000);
    expect((await read()).get("frozen")?.marketCapUsd).toBeCloseTo(43_000);
    expect(asked).toEqual([["frozen", "quiet"]]);
    await client.staleCrossCheck;

    // The next lookup takes the cross-check's price on the pair's own supply.
    vi.setSystemTime(t0 + 11 * 60_000 + 15_000);
    const after = await read();
    expect(after.get("frozen")).toMatchObject({
      priceUsd: 2.5e-6,
      marketSource: MARKET_SOURCE.dexscreenerLive,
    });
    expect(after.get("frozen")?.marketCapUsd).toBeCloseTo(2_500);
    // Within 1.5x of the cross-check: a genuinely quiet coin, left as it was.
    expect(after.get("quiet")).toMatchObject({ priceUsd: 2e-5 });
    expect(after.get("quiet")?.marketSource).not.toBe(MARKET_SOURCE.dexscreenerLive);
    // Not asked again inside two minutes.
    expect(asked).toHaveLength(1);
  });

  it("leaves the readings as they were when the cross-check fails or isn't set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.parse("2026-10-14T20:00:00Z");
    vi.setSystemTime(t0);
    vi.stubGlobal("fetch", () => Promise.resolve(new Response(JSON.stringify([pool("frozen", 4.3e-5)]))));
    const failing = new DexScreenerClient({
      staleCheck: { getTokensByAddresses: () => Promise.reject(new Error("down")) },
    });
    const plain = new DexScreenerClient();
    for (const client of [failing, plain]) {
      vi.setSystemTime(t0);
      await client.getTokensByAddresses(["frozen"]);
      vi.setSystemTime(t0 + 11 * 60_000);
      await client.getTokensByAddresses(["frozen"]);
      await client.staleCrossCheck;
      vi.setSystemTime(t0 + 12 * 60_000);
      const [token] = await client.getTokensByAddresses(["frozen"]);
      expect(token?.marketCapUsd).toBeCloseTo(43_000);
    }
  });
});
