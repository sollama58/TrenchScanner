import { afterEach, describe, expect, it, vi } from "vitest";
import { DexScreenerClient, pickCanonicalPair } from "./dexscreener.js";

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
