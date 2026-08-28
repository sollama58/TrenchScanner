// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { beforeEach, describe, expect, it } from "vitest";
import { computeEmptyPct } from "./walletHoldings.js";

const MIN_USD = 25;

describe("computeEmptyPct", () => {
  const holdings = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it("counts wallets under the bar, and only those", () => {
    // Two shells (under $25), two real wallets - exactly the shape the filter exists to catch.
    const pct = computeEmptyPct(["a", "b", "c", "d"], holdings({ a: 0, b: 12.5, c: 25, d: 4_200 }), MIN_USD);
    expect(pct).toBe(50);
  });

  it("treats the threshold itself as holding enough", () => {
    // Exactly $25 is not empty - the bar is "less than", so a wallet sitting on it counts as real.
    expect(computeEmptyPct(["a"], holdings({ a: MIN_USD }), MIN_USD)).toBe(0);
    expect(computeEmptyPct(["a"], holdings({ a: MIN_USD - 0.01 }), MIN_USD)).toBe(100);
  });

  it("returns null when ANY wallet went unpriced, rather than a part-checked percentage", () => {
    // The budget deferred "d". Nine of ten priced is not 'mostly right' here - quoting a
    // percentage over a list we only partly checked invents a number, so the answer is unknown
    // and those wallets retry next cycle.
    expect(computeEmptyPct(["a", "b", "c", "d"], holdings({ a: 0, b: 0, c: 0 }), MIN_USD)).toBeNull();
  });

  it("distinguishes 'nothing to check' from 'checked, none empty'", () => {
    expect(computeEmptyPct([], holdings({}), MIN_USD)).toBeNull();
    expect(computeEmptyPct(["a"], holdings({ a: 1_000 }), MIN_USD)).toBe(0);
  });

  it("reports a whole sniper farm as 100%", () => {
    const addresses = ["a", "b", "c", "d", "e"];
    const empty = Object.fromEntries(addresses.map((a) => [a, 0]));
    expect(computeEmptyPct(addresses, holdings(empty), MIN_USD)).toBe(100);
  });

  it("honours a caller-supplied threshold rather than a baked-in one", () => {
    // The bar is env-tunable (WALLET_HOLDINGS_MIN_USD); the same wallet flips sides with it.
    const wallets = holdings({ a: 50 });
    expect(computeEmptyPct(["a"], wallets, 25)).toBe(0);
    expect(computeEmptyPct(["a"], wallets, 100)).toBe(100);
  });
});
