import { afterEach, describe, expect, it } from "vitest";
import {
  flushPricePaths,
  foldSeconds,
  MIN_ACTIVE_SECONDS,
  packPath,
  recordPricePath,
  resetPricePathRecorder,
  startPricePathRecorder,
  takePricePathStats,
  unpackPath,
} from "./pricePathRecorder.js";

/** A tape with a change every second for `secs` seconds, the curve taking 0.1 SOL each. */
const tape = (secs: number, start = 1_700_000_000_000) => ({
  quoteIsSol: true,
  ticks: Array.from({ length: secs + 1 }, (_, i) => ({
    at: start + i * 1_000 + 250,
    price: 1e-7 * (1 + i / 100),
    realQuote: i * 1e8,
  })),
});

afterEach(() => resetPricePathRecorder());

describe("foldSeconds", () => {
  it("keeps the last price of each second, sums its net SOL and counts its changes", () => {
    const { startAt, rows } = foldSeconds(
      [
        { at: 10_100, price: 1, realQuote: 0 },
        { at: 10_400, price: 2, realQuote: 1e9 },
        { at: 10_900, price: 3, realQuote: 5e8 },
        { at: 13_000, price: 4, realQuote: 2e9 },
      ],
      true,
    );
    expect(startAt).toBe(10_000);
    expect(rows).toEqual([
      { sec: 0, price: 3, netSol: 0.5, changes: 2 },
      { sec: 3, price: 4, netSol: 1.5, changes: 1 },
    ]);
  });

  it("leaves the SOL flow at 0 on a curve quoted in something else", () => {
    const { rows } = foldSeconds(
      [
        { at: 0, price: 1, realQuote: 0 },
        { at: 1_000, price: 2, realQuote: 9e9 },
      ],
      false,
    );
    expect(rows[1]!.netSol).toBe(0);
  });
});

describe("packPath", () => {
  it("round-trips through gzip to float32 precision, a few bytes a second", () => {
    const { rows } = foldSeconds(tape(600).ticks, true);
    const data = packPath(rows);
    expect(data.length).toBeLessThan(rows.length * 14);
    const back = unpackPath(data);
    expect(back).toHaveLength(rows.length);
    back.forEach((r, i) => {
      expect(r.sec).toBe(rows[i]!.sec);
      expect(r.changes).toBe(rows[i]!.changes);
      expect(r.price / rows[i]!.price).toBeCloseTo(1, 6);
      expect(r.netSol).toBeCloseTo(rows[i]!.netSol, 5);
    });
  });
});

describe("recordPricePath", () => {
  it("does nothing while the recorder is off", () => {
    recordPricePath("m", tape(100), "aged");
    expect(takePricePathStats()).toBeNull();
  });

  it("skips quiet paths, caps the day, and writes the rest in one insert", async () => {
    const written: unknown[][] = [];
    startPricePathRecorder({ maxPerDay: 2 }, async (rows) => written.push(rows));
    const now = Date.UTC(2026, 9, 18, 5);
    recordPricePath("quiet", tape(MIN_ACTIVE_SECONDS - 1), "aged", now);
    recordPricePath("a", tape(120), "aged", now);
    recordPricePath("b", tape(120), "graduated", now);
    recordPricePath("c", tape(120), "aged", now);
    recordPricePath("none", null, "aged", now);
    await flushPricePaths();
    expect(written).toHaveLength(1);
    const rows = written[0] as { mint: string; reason: string; seconds: number; data: Buffer }[];
    expect(rows.map((r) => r.mint)).toEqual(["a", "b"]);
    expect(rows[1]!.reason).toBe("graduated");
    expect(unpackPath(rows[0]!.data)).toHaveLength(rows[0]!.seconds);
    expect(takePricePathStats()).toMatchObject({ recorded: 2, skipped: 1, capped: 1, written: 2, today: 2 });
    // A new UTC day has room again.
    recordPricePath("d", tape(120), "aged", now + 86_400_000);
    expect(takePricePathStats()).toMatchObject({ recorded: 1, pending: 1 });
  });

  it("drops a batch the database refuses instead of holding it", async () => {
    startPricePathRecorder({ maxPerDay: 10 }, async () => {
      throw new Error("down");
    });
    recordPricePath("a", tape(120), "aged");
    await flushPricePaths();
    expect(takePricePathStats()).toMatchObject({ failed: 1, pending: 0 });
  });
});
