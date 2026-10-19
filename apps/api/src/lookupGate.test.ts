// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { RecentlyAllowed } from "./lookupGate.js";

describe("RecentlyAllowed", () => {
  it("lets a recent pass through a database error, and nothing else", async () => {
    let now = 0;
    const recent = new RecentlyAllowed(15 * 60_000, 100, () => now);
    const down = async (): Promise<boolean> => {
      throw new Error("db down");
    };
    // Never seen: the error stands.
    await expect(recent.pass("a", down, "test")).rejects.toThrow("db down");
    expect(await recent.pass("a", async () => true, "test")).toBe(true);
    now = 10 * 60_000;
    expect(await recent.pass("a", down, "test")).toBe(true);
    // A no from the database isn't remembered as a pass.
    expect(await recent.pass("b", async () => false, "test")).toBe(false);
    await expect(recent.pass("b", down, "test")).rejects.toThrow("db down");
    // Past the window the database must answer again.
    now = 26 * 60_000;
    await expect(recent.pass("a", down, "test")).rejects.toThrow("db down");
  });

  it("answers a yes again without asking, within reuseMs only", async () => {
    let now = 0;
    const recent = new RecentlyAllowed(15 * 60_000, 100, () => now);
    let asked = 0;
    const yes = async () => {
      asked += 1;
      return true;
    };
    expect(await recent.pass("a", yes, "test", 60_000)).toBe(true);
    now = 59_000;
    expect(await recent.pass("a", yes, "test", 60_000)).toBe(true);
    expect(asked).toBe(1);
    // Past it the check runs again, and a no then stands.
    now = 61_000;
    expect(await recent.pass("a", async () => false, "test", 60_000)).toBe(false);
    // Without reuseMs every call asks, as before.
    expect(await recent.pass("b", yes, "test")).toBe(true);
    expect(await recent.pass("b", yes, "test")).toBe(true);
    expect(asked).toBe(3);
  });

  it("keeps at most maxKeys, the oldest first out", () => {
    const recent = new RecentlyAllowed(60_000, 2, () => 0);
    recent.remember("a");
    recent.remember("b");
    recent.remember("c");
    expect([recent.has("a"), recent.has("b"), recent.has("c")]).toEqual([false, true, true]);
  });
});
