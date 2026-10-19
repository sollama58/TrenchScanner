import { describe, expect, it } from "vitest";
import { MAX_MAP_ZOOM, panZoom, zoomAround, zoomedBox } from "./mapZoom";

const box = { x: 0, y: 0, w: 200, h: 100 };

describe("map zoom", () => {
  it("shows the whole map with no zoom", () => {
    expect(zoomedBox(box, null)).toEqual(box);
    expect(zoomAround(box, null, 0.5)).toBeNull();
  });

  it("keeps the point zoomed at in place", () => {
    const z = zoomAround(box, null, 2, { x: 50, y: 25 });
    expect(z?.k).toBe(2);
    const v = zoomedBox(box, z);
    expect(v).toEqual({ x: 25, y: 12.5, w: 100, h: 50 });
    // (50, 25) sits a quarter of the way across, as it did in the whole map.
    expect((50 - v.x) / v.w).toBeCloseTo(0.25);
  });

  it("keeps the view inside the map", () => {
    const z = zoomAround(box, null, 4, { x: 200, y: 100 });
    expect(zoomedBox(box, z)).toEqual({ x: 150, y: 75, w: 50, h: 25 });
    const moved = panZoom(box, z, 500, 500);
    expect(zoomedBox(box, moved)).toEqual({ x: 150, y: 75, w: 50, h: 25 });
    const back = panZoom(box, z, -60, -10);
    expect(zoomedBox(box, back)).toEqual({ x: 90, y: 65, w: 50, h: 25 });
  });

  it("goes no further in than its limit, and back to none all the way out", () => {
    expect(zoomAround(box, null, 100)?.k).toBe(MAX_MAP_ZOOM);
    const z = zoomAround(box, null, 2);
    expect(zoomAround(box, z, 0.5)).toBeNull();
    expect(panZoom(box, null, 10, 10)).toBeNull();
  });
});
