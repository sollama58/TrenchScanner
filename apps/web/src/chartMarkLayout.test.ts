import { describe, expect, it } from "vitest";
import { atLiveEnd, layoutMarks, LIVE_LAG_MS, markAt, MAX_LEVELS, type MarkSpot } from "./chartMarkLayout";

const spot = (item: string, side: "buy" | "sell", x: number, r = 8): MarkSpot<string> => ({
  item,
  side,
  x,
  priceY: 100,
  edgeY: side === "buy" ? 110 : 90,
  r,
});

describe("layoutMarks", () => {
  it("hangs buys under the price's low and sets sales over its high", () => {
    const [buy, sell] = layoutMarks([spot("b", "buy", 50), spot("s", "sell", 50)], 20, 400);
    expect(buy!.y).toBeGreaterThan(110);
    expect(sell!.y).toBeLessThan(90);
    expect(buy!.level).toBe(0);
    expect(sell!.level).toBe(0);
  });

  it("keeps marks that clear each other on the first level", () => {
    const out = layoutMarks([spot("a", "buy", 10), spot("b", "buy", 40)], 20, 400);
    expect(out.map((p) => p.level)).toEqual([0, 0]);
  });

  it("stacks marks that would touch away from the price, then folds the rest into a +N", () => {
    const spots = ["a", "b", "c", "d", "e"].map((id, i) => spot(id, "buy", 50 + i));
    const out = layoutMarks(spots, 20, 400);
    expect(out.map((p) => p.level)).toEqual([0, 1, 2]);
    expect(out[1]!.y).toBeGreaterThan(out[0]!.y);
    expect(out[MAX_LEVELS - 1]!.more).toEqual(["d", "e"]);
  });

  it("keeps marks on the plot", () => {
    const [p] = layoutMarks([{ ...spot("a", "buy", 50), edgeY: 395 }], 20, 400);
    expect(p!.y).toBeLessThanOrEqual(400 - 8 - 1);
  });
});

describe("markAt", () => {
  it("finds the mark under a point, the nearest of several", () => {
    const placed = layoutMarks([spot("a", "buy", 50), spot("b", "buy", 80)], 20, 400);
    expect(markAt(placed, 51, placed[0]!.y)?.item).toBe("a");
    expect(markAt(placed, 79, placed[1]!.y + 2)?.item).toBe("b");
    expect(markAt(placed, 65, 10)).toBeNull();
  });
});

describe("atLiveEnd", () => {
  it("puts a live trade read before its candle on the newest candle", () => {
    const out = atLiveEnd([{ t: 500 }, { t: 1_000 }, { t: 1_030 }], 1_000);
    expect(out.map((m) => m.t)).toEqual([500, 999, 999]);
  });

  it("leaves trades alone on a view that ends before now, and ones far past the end", () => {
    const items = [{ t: 2_000 }];
    expect(atLiveEnd(items, null)).toBe(items);
    expect(atLiveEnd([{ t: 1_000 + LIVE_LAG_MS }], 1_000)[0]!.t).toBe(1_000 + LIVE_LAG_MS);
  });
});
