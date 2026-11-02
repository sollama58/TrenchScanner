import { describe, expect, it } from "vitest";
import type { KolTypical, VsRow, VsTiers } from "../api";
import { KOL_ID, edge, kolRate, leaderOf, rateOf, rateText, sideTotal, windowName } from "./vsKolsView";

const tiers = (over: Partial<VsTiers> = {}): VsTiers => ({
  days: 7,
  calls: 0,
  graded: 0,
  won2x: 0,
  won4x: 0,
  won10x: 0,
  tenXGraded: 0,
  ...over,
});
const row = (id: string, t: Partial<VsTiers>): VsRow => ({ id, name: id, windows: [tiers(t)] });
const kol = (kols: number, r2x: number | null): KolTypical => ({
  days: 7,
  minPicks: 10,
  kols,
  active: kols,
  picks: kols * 10,
  median: { r2x, r4x: null, r10x: null },
  mean: { r2x: r2x === null ? null : r2x + 5, r4x: null, r10x: null },
});

describe("vsKolsView", () => {
  it("shows the KOLs' average in every tier, where the median KOL often reads 0%", () => {
    const k: KolTypical = {
      ...kol(20, 25),
      median: { r2x: 25, r4x: 5, r10x: 0 },
      mean: { r2x: 28, r4x: 6, r10x: 1.7 },
    };
    expect(kolRate(k, "10x")).toEqual({ median: 0, mean: 1.7, shown: 1.7 });
    expect(kolRate(k, "4x").shown).toBe(6);
    expect(kolRate(k, "2x").shown).toBe(28);
  });

  it("reads 10x as a share of the settled calls, the rest of the graded ones", () => {
    const t = tiers({ graded: 40, won2x: 10, won4x: 4, won10x: 1, tenXGraded: 20 });
    expect(rateOf(t, "2x")).toEqual({ pct: 25, n: 40, wins: 10 });
    expect(rateOf(t, "4x").pct).toBe(10);
    expect(rateOf(t, "10x")).toEqual({ pct: 5, n: 20, wins: 1 });
    expect(rateOf(tiers(), "2x").pct).toBeNull();
    expect(rateOf(undefined, "2x").pct).toBeNull();
  });

  it("sums a side and names the leader among rows with enough behind them", () => {
    const rows = [
      row("a", { graded: 40, won2x: 12 }),
      row("b", { graded: 50, won2x: 10 }),
      // The best rate, on too few to read.
      row("c", { graded: 5, won2x: 4 }),
    ];
    expect(sideTotal(rows, 7)).toMatchObject({ graded: 95, won2x: 26 });
    expect(sideTotal(rows, 1).graded).toBe(0);
    expect(leaderOf(rows, undefined, 7, "2x", 30)).toBe("a");
    expect(leaderOf(rows, undefined, 7, "4x", 30)).toBeNull();
    // The typical KOL leads once enough KOLs count.
    expect(leaderOf(rows, kol(12, 40), 7, "2x", 30)).toBe(KOL_ID);
    expect(leaderOf(rows, kol(2, 40), 7, "2x", 30)).toBe("a");
    expect(kolRate(kol(12, 40), "2x")).toEqual({ median: 40, mean: 45, shown: 45 });
    expect(kolRate(undefined, "10x")).toEqual({ median: null, mean: null, shown: null });
  });

  it("says who leads by how many points", () => {
    expect(edge(30, 20)).toEqual({ side: "models", pts: 10 });
    expect(edge(20.2, 20)).toEqual({ side: "tie", pts: 0 });
    expect(edge(10, 25)).toEqual({ side: "kols", pts: 15 });
    expect(edge(null, 20)).toBeNull();
  });

  it("formats windows and rates", () => {
    expect(windowName(1)).toBe("24h");
    expect(windowName(3)).toBe("3 days");
    expect(rateText(null)).toBe("–");
    expect(rateText(4.25)).toBe("4.3%");
    expect(rateText(42.4)).toBe("42%");
    expect(rateText(0)).toBe("0%");
  });
});
