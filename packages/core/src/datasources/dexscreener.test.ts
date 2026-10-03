import { describe, expect, it } from "vitest";
import { pickCanonicalPair } from "./dexscreener.js";

describe("pickCanonicalPair", () => {
  const curve = { dexId: "pumpfun", volume: { h1: 20_000 } };

  it("keeps a pre-bond curve over a thin side pool someone opened for the mint", () => {
    const dust = { dexId: "meteora", liquidity: { usd: 40 }, volume: { h1: 5 } };
    expect(pickCanonicalPair([curve, dust])).toBe(curve);
  });

  it("switches to the AMM pool once the trading has moved there after graduation", () => {
    const staleCurve = { dexId: "pumpfun", volume: { h1: 0 } };
    const pumpswap = { dexId: "pumpswap", liquidity: { usd: 30_000 }, volume: { h1: 50_000 } };
    expect(pickCanonicalPair([staleCurve, pumpswap])).toBe(pumpswap);
  });

  it("breaks volume ties on liquidity", () => {
    const a = { dexId: "raydium", liquidity: { usd: 5_000 }, volume: { h1: 100 } };
    const b = { dexId: "pumpswap", liquidity: { usd: 50_000 }, volume: { h1: 100 } };
    expect(pickCanonicalPair([a, b])).toBe(b);
  });

  it("falls back to the deepest pair when nothing is eligible", () => {
    const a = { dexId: "meteora", liquidity: { usd: 10 } };
    const b = { dexId: "raydium", liquidity: { usd: 500 } };
    expect(pickCanonicalPair([a, b])).toBe(b);
  });
});
