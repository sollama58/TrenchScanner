import { describe, expect, it } from "vitest";
import type { VsRow, VsTiers } from "../api";
import { edge, leaderOf, rateOf, rateText, sideTotal, windowName } from "./vsKolsView";

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
const row = (id: string, kind: VsRow["kind"], t: Partial<VsTiers>): VsRow => ({
  id,
  kind,
  name: id,
  twitter: null,
  avatar: null,
  windows: [tiers(t)],
});

describe("vsKolsView", () => {
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
      row("a", "model", { graded: 40, won2x: 12 }),
      row("b", "model", { graded: 50, won2x: 10 }),
      // The best rate, on too few to read.
      row("c", "kol", { graded: 5, won2x: 4 }),
    ];
    expect(sideTotal(rows, 7)).toMatchObject({ graded: 95, won2x: 26 });
    expect(sideTotal(rows, 1).graded).toBe(0);
    expect(leaderOf(rows, 7, "2x", 30)).toBe("a");
    expect(leaderOf(rows, 7, "4x", 30)).toBeNull();
  });

  it("says who leads by how many points", () => {
    expect(edge({ pct: 30, n: 10, wins: 3 }, { pct: 20, n: 10, wins: 2 })).toEqual({
      side: "models",
      pts: 10,
    });
    expect(edge({ pct: 20.2, n: 10, wins: 2 }, { pct: 20, n: 10, wins: 2 })).toEqual({ side: "tie", pts: 0 });
    expect(edge({ pct: null, n: 0, wins: 0 }, { pct: 20, n: 10, wins: 2 })).toBeNull();
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
