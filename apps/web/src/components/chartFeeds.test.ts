import { describe, expect, it } from "vitest";
import { mergeFine, type FineCandles } from "./chartFeeds";

const k = (t: number, c = 1) => ({ t, o: c, h: c, l: c, c });
const page = (candles: FineCandles["candles"], extra: Partial<FineCandles> = {}): FineCandles => ({
  mint: "m",
  stepSec: 1,
  candles,
  ...extra,
});

describe("mergeFine", () => {
  it("keeps the older seconds a stream-only answer no longer reaches", () => {
    const pump = page([k(1_000), k(2_000), k(5_000)], { source: "pumpfun" });
    const stream = page([k(5_000, 2), k(6_000, 3)], { source: "stream" });
    const out = mergeFine(pump, stream);
    expect(out.candles?.map((x) => [x.t, x.c])).toEqual([
      [1_000, 1],
      [2_000, 1],
      [5_000, 2],
      [6_000, 3],
    ]);
    expect(out.source).toBe("stream");
  });

  it("keeps what it had through an empty answer, and starts over on another width", () => {
    const held = page([k(1_000)]);
    expect(mergeFine(held, page(null))).toBe(held);
    const quarter = { ...page([k(15_000)]), stepSec: 15 as const };
    expect(mergeFine(held, quarter)).toBe(quarter);
    expect(mergeFine(null, held)).toBe(held);
  });
});
