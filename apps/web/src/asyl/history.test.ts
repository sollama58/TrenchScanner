import { describe, expect, it } from "vitest";
import { History } from "./history";

describe("History", () => {
  it("undoes and redoes in order", () => {
    const h = new History<number>();
    h.record(1);
    h.record(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
    expect(h.redo(1)).toBe(2);
    expect(h.redo(2)).toBe(3);
    expect(h.redo(3)).toBeNull();
  });

  it("drops the redo steps on a new change", () => {
    const h = new History<number>();
    h.record(1);
    expect(h.undo(2)).toBe(1);
    expect(h.canRedo).toBe(true);
    h.record(1);
    expect(h.canRedo).toBe(false);
  });

  it("keeps at most its limit, forgetting the oldest", () => {
    const h = new History<number>(3);
    for (let i = 0; i < 5; i++) h.record(i);
    expect(h.depth.back).toBe(3);
    expect(h.undo(5)).toBe(4);
    expect(h.undo(4)).toBe(3);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBeNull();
  });
});
