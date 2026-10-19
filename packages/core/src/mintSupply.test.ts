import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMintSupplies,
  launchSupplyFactors,
  MintSupplies,
  mintSupplies,
  onCurrentSupplies,
  onCurrentSupply,
} from "./mintSupply.js";

const reader = (supplies: Record<string, number>) => ({
  getMintSupplies: vi.fn(async (mints: string[]) => {
    const out = new Map<string, number>();
    for (const m of mints) if (supplies[m] !== undefined) out.set(m, supplies[m]);
    return out;
  }),
});

afterEach(() => configureMintSupplies(null));

describe("MintSupplies", () => {
  it("reads each mint once inside the TTL, in one batch", async () => {
    const r = reader({ a: 952_734_340.4, b: 1e9 });
    let now = 0;
    const book = new MintSupplies(r, { ttlMs: 60_000, now: () => now });
    expect([...(await book.get(["a", "b", "a"]))]).toEqual([
      ["a", 952_734_340.4],
      ["b", 1e9],
    ]);
    await book.get(["a"]);
    expect(r.getMintSupplies).toHaveBeenCalledTimes(1);
    expect(r.getMintSupplies).toHaveBeenCalledWith(["a", "b"]);
    now = 61_000;
    await book.get(["a"]);
    expect(r.getMintSupplies).toHaveBeenCalledTimes(2);
  });

  it("keeps the last reading when a re-read fails, and leaves out a mint never read", async () => {
    let fail = false;
    const r = {
      getMintSupplies: vi.fn(async () => {
        if (fail) throw new Error("rpc down");
        return new Map([["a", 9e8]]);
      }),
    };
    let now = 0;
    const book = new MintSupplies(r, { ttlMs: 1_000, now: () => now });
    await book.get(["a"]);
    fail = true;
    now = 5_000;
    const out = await book.get(["a", "z"]);
    expect(out.get("a")).toBe(9e8);
    expect(out.has("z")).toBe(false);
  });

  it("stops waiting at waitMs", async () => {
    const book = new MintSupplies({ getMintSupplies: () => new Promise(() => undefined) }, { waitMs: 10 });
    expect((await book.get(["a"])).size).toBe(0);
  });
});

describe("market cap on the supply now", () => {
  it("puts a launch-billion cap on the supply after burns", () => {
    expect(onCurrentSupply(100_000, 950_000_000)).toBeCloseTo(95_000);
    expect(onCurrentSupply(100_000, undefined)).toBe(100_000);
  });

  it("re-makes readings as price x supply where the supply is known", async () => {
    configureMintSupplies(new MintSupplies(reader({ a: 950_000_000 })));
    const out = await onCurrentSupplies([
      { mintAddress: "a", priceUsd: 0.0001, marketCapUsd: 100_000 },
      { mintAddress: "b", priceUsd: 0.0001, marketCapUsd: 100_000 },
    ]);
    expect(out[0]!.marketCapUsd).toBeCloseTo(95_000);
    expect(out[1]!.marketCapUsd).toBe(100_000);
    expect((await launchSupplyFactors(["a", "b"])).get("a")).toBeCloseTo(0.95);
  });

  it("knows nothing without a configured source", async () => {
    expect((await mintSupplies().get(["a"])).size).toBe(0);
  });
});
