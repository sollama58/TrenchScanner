import { describe, expect, it } from "vitest";
import { findSpot } from "./placement";

describe("badge placement", () => {
  // A Terminal row, roughly: picture and name on the left, MC / V / F stacked top-right,
  // chips along the bottom and the quick-buy button bottom-right. The gap is under F.
  const row = { w: 580, h: 200 };
  const obstacles = [
    { x: 12, y: 40, w: 90, h: 90 }, // picture
    { x: 126, y: 45, w: 120, h: 24 }, // name
    { x: 126, y: 75, w: 170, h: 24 }, // age and icons
    { x: 478, y: 38, w: 92, h: 24 }, // MC
    { x: 500, y: 64, w: 70, h: 24 }, // V
    { x: 505, y: 92, w: 62, h: 18 }, // F
    { x: 12, y: 172, w: 390, h: 26 }, // chips
    { x: 458, y: 172, w: 110, h: 26 }, // 0.5 SOL
  ];

  it("finds the empty space instead of covering the numbers", () => {
    const spot = findSpot(row, obstacles, 96, 18)!;
    expect(spot).not.toBeNull();
    const box = { ...spot, w: 96, h: 18 };
    for (const o of obstacles) {
      const clear = box.x + box.w <= o.x || o.x + o.w <= box.x || box.y + box.h <= o.y || o.y + o.h <= box.y;
      expect(clear).toBe(true);
    }
    // It lands on the right-hand side, in or near the circled gap.
    expect(spot.x).toBeGreaterThan(380);
  });

  it("returns null when nothing fits, so the caller can fall back to the dot", () => {
    expect(findSpot({ w: 100, h: 30 }, [{ x: 0, y: 0, w: 100, h: 30 }], 40, 18)).toBeNull();
    expect(findSpot({ w: 30, h: 10 }, [], 40, 18)).toBeNull();
  });

  it("uses the top-right corner of an empty row", () => {
    expect(findSpot({ w: 300, h: 100 }, [], 80, 18)).toEqual({ x: 216, y: 4 });
  });
});
