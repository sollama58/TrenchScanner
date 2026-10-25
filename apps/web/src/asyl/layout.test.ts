import { describe, expect, it } from "vitest";
import { gridCell, newLayout, snapToGrid } from "./layout";
import type { AsylGraph } from "./graph";

const g = (ids: string[], edges: [string, string][] = []): AsylGraph => ({
  nodes: ids.map((id) => ({ id, kind: "wallet", name: null, tags: [] })),
  edges: edges.map(([a, b]) => ({
    a,
    b,
    kind: "funded",
    weight: 1,
    label: "",
    source: "stored",
    mint: null,
  })),
});

describe("grid mode", () => {
  it("sizes a cell for the biggest bubble and the longest name, with room between", () => {
    const c = gridCell(
      g(["a", "b"]),
      (id) => (id === "a" ? 30 : 10),
      (id) => (id === "b" ? "x".repeat(20) : "a"),
    );
    expect(c.w).toBe(140 + 84);
    expect(c.h).toBe(60 + 22 + 84);
  });

  it("puts every bubble on its own cell, nearest first, and leaves a snapped map as it is", () => {
    const map = g(["a", "b", "c"], [["a", "b"]]);
    const s = newLayout();
    s.pos.set("a", { x: 10, y: 5 });
    s.pos.set("b", { x: -8, y: 12 });
    s.pos.set("c", { x: 260, y: 90 });
    const cell = { w: 200, h: 150 };
    snapToGrid(s, map, cell);
    const at = [...s.pos.values()].map((p) => `${p.x / cell.w},${p.y / cell.h}`);
    expect(new Set(at).size).toBe(3);
    for (const p of s.pos.values()) {
      expect(Number.isInteger(p.x / cell.w)).toBe(true);
      expect(Number.isInteger(p.y / cell.h)).toBe(true);
    }
    expect(s.pos.get("c")).toEqual({ x: 200, y: 150 });
    const before = JSON.stringify([...s.pos]);
    snapToGrid(s, map, cell);
    expect(JSON.stringify([...s.pos])).toBe(before);
  });
});
