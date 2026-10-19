import { describe, expect, it } from "vitest";
import { CallerKeyBudget, FillGate, FillQueueFull } from "./fillGuard.js";

describe("CallerKeyBudget", () => {
  it("lets a caller start fills for a few keys a window, and its own keys again", () => {
    let now = 0;
    const budget = new CallerKeyBudget(2, 60_000, 100, () => now);
    expect(budget.allow("ip:1", "7:Europe/Berlin")).toBe(true);
    expect(budget.allow("ip:1", "7:Asia/Tokyo")).toBe(true);
    expect(budget.allow("ip:1", "7:America/Lima")).toBe(false);
    // A key it already used stays allowed; another caller has its own budget.
    expect(budget.allow("ip:1", "7:Europe/Berlin")).toBe(true);
    expect(budget.allow("ip:2", "7:America/Lima")).toBe(true);
    // A new window starts afresh.
    now = 60_000;
    expect(budget.allow("ip:1", "7:America/Lima")).toBe(true);
  });

  it("keeps at most maxCallers, the least recently seen first out", () => {
    const budget = new CallerKeyBudget(1, 60_000, 2, () => 0);
    budget.allow("a", "k1");
    budget.allow("b", "k1");
    budget.allow("c", "k1");
    // "a" was dropped, so its budget is fresh again.
    expect(budget.allow("a", "k2")).toBe(true);
    expect(budget.allow("c", "k2")).toBe(false);
  });
});

describe("FillGate", () => {
  it("runs one fill at a time, in order, and refuses past its queue", async () => {
    const gate = new FillGate(1, 2);
    const order: string[] = [];
    const releases: (() => void)[] = [];
    const fill = (name: string) => () =>
      new Promise<string>((resolve) => {
        order.push(`start ${name}`);
        releases.push(() => resolve(name));
      });
    const a = gate.run(fill("a"));
    const b = gate.run(fill("b"));
    const c = gate.run(fill("c"));
    await expect(gate.run(fill("d"))).rejects.toBeInstanceOf(FillQueueFull);
    await Promise.resolve();
    expect(order).toEqual(["start a"]);
    expect(gate.load).toEqual({ running: 1, queued: 2 });
    releases.shift()!();
    expect(await a).toBe("a");
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(["start a", "start b"]);
    releases.shift()!();
    expect(await b).toBe("b");
    await new Promise((r) => setTimeout(r, 0));
    releases.shift()!();
    expect(await c).toBe("c");
    expect(gate.load).toEqual({ running: 0, queued: 0 });
  });

  it("frees the slot when a fill fails", async () => {
    const gate = new FillGate(1, 0);
    await expect(gate.run(() => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    expect(await gate.run(async () => 1)).toBe(1);
    expect(gate.load).toEqual({ running: 0, queued: 0 });
  });
});
