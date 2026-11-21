import { describe, expect, it } from "vitest";
import { findSpot, ON_PICTURES, stillFits, TIGHT } from "./placement";

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

  // A packed card (user ask 2026-11-21): no roomy patch, so the old corner fallback sat on MC.
  const packed = { w: 300, h: 60 };
  const packedObstacles = [
    { x: 4, y: 4, w: 52, h: 52, soft: true }, // picture
    { x: 62, y: 6, w: 120, h: 20 }, // name
    { x: 62, y: 32, w: 120, h: 20 }, // age and icons
    { x: 190, y: 6, w: 106, h: 20 }, // MC
    { x: 190, y: 28, w: 106, h: 26 }, // V, buy button
  ];

  it("finds no roomy spot on a packed card, but never offers one over its numbers", () => {
    expect(findSpot(packed, packedObstacles, 40, 14)).toBeNull();
    expect(findSpot(packed, packedObstacles, 40, 14, TIGHT)).toBeNull();
  });

  it("sits on the picture as a last resort, clear of the text", () => {
    const spot = findSpot(packed, packedObstacles, 40, 14, ON_PICTURES)!;
    expect(spot).not.toBeNull();
    const box = { ...spot, w: 40, h: 14 };
    for (const o of packedObstacles.filter((o) => !o.soft)) {
      const apart = box.x + box.w <= o.x || o.x + o.w <= box.x || box.y + box.h <= o.y || o.y + o.h <= box.y;
      expect(apart).toBe(true);
    }
    expect(stillFits(packed, packedObstacles, box, ON_PICTURES)).toBe(true);
    expect(stillFits(packed, packedObstacles, box)).toBe(false);
  });

  it("fits a tight gap the roomy margins miss", () => {
    const row = { w: 200, h: 24 };
    expect(findSpot(row, [], 60, 18)).toBeNull();
    expect(findSpot(row, [], 60, 18, TIGHT)).toEqual({ x: 139, y: 1 });
  });
});
