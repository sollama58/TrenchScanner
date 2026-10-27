import { describe, expect, it } from "vitest";
import { BoardWaits } from "./boardWaits.js";

describe("BoardWaits", () => {
  it("answers with the coins written while it was held, gathered for a moment", async () => {
    const waits = new BoardWaits(10, 20);
    const a = waits.wait(["A", "B", "C"], 5_000);
    const other = waits.wait(["D"], 30);
    waits.wake(["A", "X"]);
    waits.wake(["C"]);
    expect(await a).toEqual({ changed: ["A", "C"], pushed: true });
    expect(await other).toEqual({ changed: [], pushed: true });
    expect(waits.size).toBe(0);
  });

  it("lets every wait go, with no coins, after a reconnect", async () => {
    const waits = new BoardWaits(10, 5);
    const all = [waits.wait(["A"], 5_000), waits.wait(["B"], 5_000)];
    waits.wake(null);
    expect(await Promise.all(all)).toEqual([
      { changed: [], pushed: true },
      { changed: [], pushed: true },
    ]);
  });

  it("lets go when the board leaves, and answers at once past its capacity", async () => {
    const waits = new BoardWaits(1, 5);
    const ctl = new AbortController();
    const held = waits.wait(["A"], 5_000, ctl.signal);
    expect(await waits.wait(["B"], 5_000)).toEqual({ changed: [], pushed: false });
    ctl.abort();
    expect(await held).toEqual({ changed: [], pushed: true });
    expect(waits.size).toBe(0);
  });
});
