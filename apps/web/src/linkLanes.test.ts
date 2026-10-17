import { describe, expect, it } from "vitest";
import { laneMid, laneOffsets, laneRoute, pairSign } from "./linkLanes";

describe("laneOffsets", () => {
  it("centres the lanes on the bundle's middle, edge to edge by their widths", () => {
    expect(laneOffsets([])).toEqual([]);
    expect(laneOffsets([2])).toEqual([0]);
    const [a, b, c] = laneOffsets([2, 2, 4], 2);
    expect(b! - a!).toBeCloseTo(4);
    expect(c! - b!).toBeCloseTo(5);
    expect(a! + c!).toBeCloseTo(0);
  });
});

describe("laneRoute", () => {
  it("sits its middle the offset across, and its ends on the rims", () => {
    const a = { x: 0, y: 0, r: 10 };
    const b = { x: 100, y: 0, r: 20 };
    const r = laneRoute(a, b, 0, 4);
    expect(Math.abs(laneMid(r).y - 4)).toBeLessThan(1);
    expect(Math.hypot(r.x1 - a.x, r.y1 - a.y)).toBeCloseTo(a.r);
    expect(Math.hypot(r.x2 - b.x, r.y2 - b.y)).toBeCloseTo(b.r);
    // Ends turned toward the lane's side, so parallel lanes enter side by side.
    expect(r.y1).toBeGreaterThan(0);
    expect(r.y2).toBeGreaterThan(0);
    // A gap past the rim, and the bow.
    const bowed = laneRoute(a, b, 0.2, 0, 2, 3);
    expect(Math.hypot(bowed.x2 - b.x, bowed.y2 - b.y)).toBeCloseTo(b.r + 3);
    expect(laneMid(bowed).y).toBeGreaterThan(5);
  });

  it("reads a pair the same way round whichever end is first", () => {
    expect(pairSign("a", "b")).toBe(1);
    expect(pairSign("b", "a")).toBe(-1);
  });
});
