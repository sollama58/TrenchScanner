import { describe, expect, it } from "vitest";
import { HolderWaits } from "./holderWaits.js";

describe("HolderWaits", () => {
  it("wakes the waits for the coin written, not another", async () => {
    const waits = new HolderWaits();
    const a = waits.wait("A", 5_000);
    const b = waits.wait("B", 20);
    waits.wake("A");
    expect(await a).toEqual({ changed: true, pushed: true });
    expect(await b).toEqual({ changed: false, pushed: true });
    expect(waits.size).toBe(0);
  });

  it("wakes every wait after a reconnect", async () => {
    const waits = new HolderWaits();
    const all = [waits.wait("A", 5_000), waits.wait("B", 5_000)];
    waits.wake(null);
    expect((await Promise.all(all)).every((r) => r.changed)).toBe(true);
  });

  it("lets go when the reader leaves", async () => {
    const waits = new HolderWaits();
    const ctl = new AbortController();
    const a = waits.wait("A", 5_000, ctl.signal);
    ctl.abort();
    expect(await a).toEqual({ changed: false, pushed: true });
    expect(waits.size).toBe(0);
  });

  it("answers at once past its capacity", async () => {
    const waits = new HolderWaits(1);
    const held = waits.wait("A", 5_000);
    expect(await waits.wait("B", 5_000)).toEqual({ changed: false, pushed: false });
    waits.wake("A");
    await held;
  });
});
