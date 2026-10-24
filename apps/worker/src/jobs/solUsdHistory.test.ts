import { describe, expect, it } from "vitest";
import { parseCoinbaseMinutes, SolUsdHistory } from "./solUsdHistory.js";

const MIN = 60_000;
const T0 = 1_792_800_000_000; // a minute boundary
const NOW = T0 + 60 * MIN;

describe("SolUsdHistory", () => {
  it("reads Coinbase's minute closes, newest first, leaving bad rows out", () => {
    const got = parseCoinbaseMinutes([
      [T0 / 1000 + 60, 102.6, 102.7, 102.6, 102.63, 1],
      [T0 / 1000, 102.5, 102.7, 102.7, 102.6, 1],
      [T0 / 1000 + 1, 1, 1, 1, 1, 1],
      ["x"],
    ]);
    expect([...got]).toEqual([
      [T0 + MIN, 102.63],
      [T0, 102.6],
    ]);
  });

  it("prices each minute it read, holding the close over a minute with no trade, and reads a stretch once", async () => {
    const asked: [number, number][] = [];
    const h = new SolUsdHistory(
      async (from, to) => {
        asked.push([from, to]);
        return new Map([
          [T0, 100],
          [T0 + 2 * MIN, 104],
        ]);
      },
      () => NOW,
    );
    await h.prepare(T0 + 10_000, T0 + 3 * MIN);
    expect(h.at(T0 + 30_000)).toBe(100);
    expect(h.at(T0 + MIN + 59_000)).toBe(100);
    expect(h.at(T0 + 2 * MIN)).toBe(104);
    // Not read: the spot price stands in.
    expect(h.at(T0 + 10 * MIN)).toBeNull();
    await h.prepare(T0, T0 + 3 * MIN);
    expect(asked).toEqual([[T0, T0 + 3 * MIN]]);
  });

  it("leaves the newest minutes to the spot price and waits a while after a failed read", async () => {
    let calls = 0;
    const h = new SolUsdHistory(
      async () => {
        calls += 1;
        throw new Error("down");
      },
      () => NOW,
    );
    await h.prepare(NOW - 30 * MIN, NOW);
    await h.prepare(NOW - 30 * MIN, NOW);
    expect(calls).toBe(1);
    const recent: [number, number][] = [];
    const fresh = new SolUsdHistory(
      async (from, to) => (recent.push([from, to]), new Map()),
      () => NOW,
    );
    await fresh.prepare(NOW - MIN, NOW);
    expect(recent).toEqual([]);
  });
});
