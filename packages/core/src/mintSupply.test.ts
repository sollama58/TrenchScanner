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

  it("gathers stale re-reads into one read per refresh interval, and still reads a new mint at once", async () => {
    // Twelve coins first asked five seconds apart, so their readings run out one after another.
    const mints = Array.from({ length: 12 }, (_, i) => `m${i}`);
    const supplies: Record<string, number> = Object.fromEntries(mints.map((m) => [m, 1e9]));
    supplies.late = 5e8;
    const r = reader(supplies);
    let now = 0;
    const book = new MintSupplies(r, { ttlMs: 60_000, refreshEveryMs: 30_000, now: () => now });
    for (let i = 0; i < mints.length; i++) {
      now = i * 5_000;
      await book.get(mints.slice(0, i + 1));
    }
    expect(r.getMintSupplies).toHaveBeenCalledTimes(12);
    // A tick every 5 s for two minutes. Re-read each at its own expiry, every tick sends a read
    // (25 of them); gathered, it is one read per 30 s carrying every coin that went stale since.
    supplies.m0 = 9e8;
    for (now = 60_000; now <= 180_000; now += 5_000) {
      await book.get(mints);
      // Let the read land before the next tick.
      await new Promise((resolve) => setImmediate(resolve));
    }
    const calls = r.getMintSupplies.mock.calls.slice(12).map(([asked]) => asked.length);
    expect(calls.length).toBe(5);
    expect(Math.max(...calls)).toBeGreaterThan(1);
    // The burn was read, late by no more than the refresh interval.
    expect((await book.get(["m0"])).get("m0")).toBe(9e8);
    // A coin never read before does not wait for the next refresh.
    expect((await book.get(["late"])).get("late")).toBe(5e8);
    expect(r.getMintSupplies.mock.calls.at(-1)![0]).toEqual(["late"]);
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
