import { beforeEach, describe, expect, it, vi } from "vitest";
import { distToSegment, Drawings, fibValue, loadDrawings, type DrawScale } from "./chartDrawings";

/** A plain scale: 1 px a ms, 1 px a dollar (down the screen). */
const scale: DrawScale = { x: (t) => t, y: (v) => 1_000 - v, t: (x) => x, v: (y) => 1_000 - y };

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
});

describe("Drawings", () => {
  it("places a trendline with two clicks, saves it and selects it", () => {
    const onChange = vi.fn();
    const d = new Drawings("k", onChange);
    d.setTool("trend");
    d.click(100, 900, scale, false);
    expect(d.placing).toBe(true);
    d.click(300, 700, scale, false);
    expect(d.count).toBe(1);
    expect(d.tool).toBeNull();
    expect(d.selectedId).not.toBeNull();
    expect(loadDrawings("k")[0]).toMatchObject({
      type: "trend",
      p1: { t: 100, v: 100 },
      p2: { t: 300, v: 300 },
    });
    expect(onChange).toHaveBeenCalled();
  });

  it("selects a drawing clicked near it, and deletes it", () => {
    const d = new Drawings("k", () => {});
    d.setTool("trend");
    d.click(100, 900, scale, false);
    d.click(300, 900, scale, false);
    d.cancel();
    expect(d.click(200, 905, scale, false)).toBe(true);
    expect(d.deleteSelected()).toBe(true);
    expect(d.count).toBe(0);
    expect(store.has("k")).toBe(false);
  });

  it("drops a saved drawing that doesn't make sense", () => {
    store.set(
      "k",
      JSON.stringify([{ id: "a", type: "trend", p1: { t: 1, v: -1 }, p2: { t: 2, v: 2 } }, { id: "b" }]),
    );
    expect(loadDrawings("k")).toEqual([]);
  });
});

describe("drawing geometry", () => {
  it("measures a point's distance from a segment", () => {
    expect(distToSegment(5, 5, 0, 0, 10, 0)).toBe(5);
    expect(distToSegment(-3, 4, 0, 0, 10, 0)).toBe(5);
  });
  it("puts level 1 at the first point and 0 at the second", () => {
    const d = { id: "f", type: "fib" as const, p1: { t: 0, v: 200 }, p2: { t: 1, v: 100 } };
    expect(fibValue(d, 1)).toBe(200);
    expect(fibValue(d, 0)).toBe(100);
    expect(fibValue(d, 0.5)).toBe(150);
  });
});
