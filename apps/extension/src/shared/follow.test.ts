import { describe, expect, it } from "vitest";
import { FOLLOW_IDLE_MS, followMap, type FollowDeps, type WaitAnswer } from "./follow";

/** Timers run by hand, a page that can be hidden and shown, and the asks answered by the test. */
function harness() {
  let visible = true;
  let onShow: (() => void) | null = null;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const asks: ((a: WaitAnswer) => void)[] = [];
  const deps: FollowDeps = {
    visible: () => visible,
    onVisible: (listener) => {
      onShow = listener;
      return () => (onShow = null);
    },
    setTimer: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimer: (t) => void timers.delete(t),
  };
  const wait = () => new Promise<WaitAnswer>((resolve) => asks.push(resolve));
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    deps,
    wait,
    asks,
    timers,
    settle,
    hide: () => (visible = false),
    show: () => {
      visible = true;
      onShow?.();
    },
    /** Runs the one pending timer, returning its delay. */
    fire: () => {
      const [key, t] = [...timers][0]!;
      timers.delete(key);
      t.fn();
      return t.ms;
    },
  };
}

describe("followMap", () => {
  it("re-reads the map when a reading is written and holds again at once", async () => {
    const h = harness();
    let reads = 0;
    const stop = followMap(h.wait, () => reads++, h.deps);
    expect(h.asks).toHaveLength(1);
    h.asks[0]!({ changed: true, pushed: true });
    await h.settle();
    expect(reads).toBe(1);
    expect(h.fire()).toBe(0);
    expect(h.asks).toHaveLength(2);
    // Nothing written in the hold: no read, ask again.
    h.asks[1]!({ changed: false, pushed: true });
    await h.settle();
    expect(reads).toBe(1);
    expect(h.fire()).toBe(0);
    stop();
    h.asks[2]!({ changed: true, pushed: true });
    await h.settle();
    expect(reads).toBe(1);
    expect(h.timers.size).toBe(0);
  });

  it("waits a minute when nothing could be held, and backs off after failures", async () => {
    const h = harness();
    followMap(h.wait, () => undefined, h.deps);
    h.asks[0]!({ changed: false, pushed: false });
    await h.settle();
    expect(h.fire()).toBe(FOLLOW_IDLE_MS);
    h.asks[1]!(null);
    await h.settle();
    expect(h.fire()).toBe(2_000);
    h.asks[2]!(null);
    await h.settle();
    expect(h.fire()).toBe(4_000);
  });

  it("holds nothing while the page is hidden, and reads and resumes when it shows", async () => {
    const h = harness();
    let reads = 0;
    followMap(h.wait, () => reads++, h.deps);
    h.hide();
    h.asks[0]!({ changed: false, pushed: true });
    await h.settle();
    h.fire();
    await h.settle();
    expect(h.asks).toHaveLength(1);
    expect(h.timers.size).toBe(0);
    h.show();
    expect(reads).toBe(1);
    h.fire();
    await h.settle();
    expect(h.asks).toHaveLength(2);
  });
});
