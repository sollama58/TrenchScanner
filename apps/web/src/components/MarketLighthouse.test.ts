import { describe, expect, it } from "vitest";
import { fillBuckets } from "./MarketLighthouse";

const H = 3_600_000;
const row = (t: number, graded: number) => ({
  at: new Date(t).toISOString(),
  graded,
  hit2xPct: 50,
  hit4xPct: 25,
  hit10xPct: 0,
  avgReturnPct: 4,
});

describe("fillBuckets", () => {
  it("fills every bucket start from the window's first to now, so the axis stays linear in time", () => {
    const t0 = Date.UTC(2026, 9, 10);
    const out = fillBuckets(
      [row(t0 + 3 * H, 4), row(t0 + 12 * H, 2)],
      3,
      new Date(t0 + H).toISOString(),
      t0 + 22 * H,
    );
    expect(out.map((b) => (Date.parse(b.at) - t0) / H)).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
    expect(out[1]!.graded).toBe(4);
    expect(out[2]).toMatchObject({ graded: 0, hit2xPct: null, avgReturnPct: null });
  });

  it("keeps a bucket the API sent even when nothing in it is graded yet", () => {
    const t0 = Date.UTC(2026, 9, 10);
    const out = fillBuckets([row(t0, 0)], 24, new Date(t0).toISOString(), t0 + 2 * 24 * H);
    expect(out).toHaveLength(3);
    expect(out[0]!.hit2xPct).toBe(50);
  });
});
