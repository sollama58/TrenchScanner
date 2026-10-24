import { describe, expect, it } from "vitest";
import { fitBox } from "./asylCard";

describe("fitBox", () => {
  const box = { x: 0, y: 0, w: 1000, h: 300 };
  it("fits a small map at one scale, centred, and never blows it up past 2×", () => {
    const f = fitBox({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, box);
    expect(f.sx).toBe(2);
    expect(f.sy).toBe(2);
    expect(f.stretched).toBe(false);
    expect(f.ox + 50 * f.sx).toBeCloseTo(500);
  });
  it("stretches a tall map that would read too small, to fill the wide box", () => {
    const f = fitBox({ minX: 0, minY: 0, maxX: 600, maxY: 900 }, box);
    expect(f.sy).toBeCloseTo(300 / 900);
    expect(f.sx).toBeGreaterThan(f.sy);
    expect(f.sx).toBeLessThanOrEqual(f.sy * 1.7 + 1e-9);
    expect(f.stretched).toBe(true);
  });
});
