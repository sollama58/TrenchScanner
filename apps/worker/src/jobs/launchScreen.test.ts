import { describe, expect, it } from "vitest";
import {
  LAUNCH_SCREEN_BATCH,
  LAUNCH_SCREEN_MAX_AGE_MS,
  LaunchScreen,
  type LaunchScreenOptions,
  type LaunchVerdict,
} from "./launchScreen.js";

/** A screen over a scripted chain: `verdicts` is what the lookup answers now, changed by the test. */
function harness(verdicts: Map<string, LaunchVerdict>, overrides: Partial<LaunchScreenOptions> = {}) {
  let now = 1_000_000;
  const launches: string[] = [];
  const settled = new Set<string>();
  const asked: string[][] = [];
  const cleared: string[][] = [];
  const screen = new LaunchScreen({
    newLaunches: () => [...launches].reverse(),
    settled: (mint) => settled.has(mint),
    screen: async (mints) => {
      asked.push([...mints]);
      const out = new Map<string, LaunchVerdict>();
      for (const mint of mints) {
        const v = verdicts.get(mint) ?? "pending";
        out.set(mint, v);
        if (v !== "pending") settled.add(mint);
      }
      return out;
    },
    onCleared: (mints) => cleared.push([...mints]),
    now: () => now,
    ...overrides,
  });
  return {
    screen,
    launches,
    settled,
    asked,
    cleared,
    tick: (advanceMs = 1_000) => {
      now += advanceMs;
      return screen.tick(now);
    },
  };
}

describe("LaunchScreen", () => {
  it("asks about a new launch on the next tick and hands the cleared ones on at once", async () => {
    const h = harness(
      new Map([
        ["a", "clear"],
        ["b", "mayhem"],
      ]),
    );
    h.launches.push("a", "b");
    await h.tick();
    expect(h.asked).toEqual([["b", "a"]]);
    expect(h.cleared).toEqual([["a"]]);
    expect(h.screen.waiting).toBe(0);
    const stats = h.screen.takeStats();
    expect(stats).toMatchObject({ calls: 1, asked: 2, cleared: 1, mayhem: 1, pending: 0, gaveUp: 0 });
    expect(stats.verdictMsMedian).toBe(0);
  });

  it("asks again a second later about a mint the chain does not show yet, and never about a settled one", async () => {
    const verdicts = new Map<string, LaunchVerdict>();
    const h = harness(verdicts);
    h.launches.push("young");
    await h.tick();
    await h.tick();
    expect(h.asked).toEqual([["young"], ["young"]]);
    expect(h.cleared).toEqual([]);
    verdicts.set("young", "clear");
    await h.tick();
    expect(h.cleared).toEqual([["young"]]);
    // settled now: not asked again, however long it stays in the launch buffer
    await h.tick();
    expect(h.asked).toHaveLength(3);
    const stats = h.screen.takeStats();
    expect(stats).toMatchObject({ calls: 3, asked: 1, cleared: 1, pending: 2 });
    expect(stats.verdictMsMedian).toBe(2_000);
    expect(stats.verdictMsMax).toBe(2_000);
  });

  it("leaves a launch unanswered too long to the round and the scan", async () => {
    const h = harness(new Map());
    h.launches.push("stuck");
    await h.tick();
    await h.tick(LAUNCH_SCREEN_MAX_AGE_MS + 1);
    expect(h.screen.waiting).toBe(0);
    expect(h.screen.takeStats()).toMatchObject({ asked: 1, gaveUp: 1, calls: 1 });
    // not asked again once given up
    await h.tick();
    expect(h.asked).toHaveLength(1);
  });

  it("skips a launch the round or a cycle settled first, and does not count it as asked", async () => {
    const h = harness(new Map([["a", "clear"]]));
    h.settled.add("done");
    h.launches.push("done", "a");
    await h.tick();
    expect(h.asked).toEqual([["a"]]);
    expect(h.screen.takeStats()).toMatchObject({ asked: 1, cleared: 1 });
  });

  it("splits a burst of launches into lookups of LAUNCH_SCREEN_BATCH", async () => {
    const mints = Array.from({ length: LAUNCH_SCREEN_BATCH + 3 }, (_, i) => `m${i}`);
    const h = harness(new Map(mints.map((m) => [m, "clear"] as const)));
    h.launches.push(...mints);
    await h.tick();
    expect(h.asked.map((a) => a.length)).toEqual([LAUNCH_SCREEN_BATCH, 3]);
    expect(h.cleared.flat()).toHaveLength(mints.length);
    expect(h.screen.takeStats()).toMatchObject({ calls: 2, cleared: mints.length });
  });

  it("survives a lookup that throws: the launches wait for the next tick", async () => {
    let fail = true;
    const h = harness(new Map([["a", "clear"]]), {
      screen: async (mints) => {
        if (fail) throw new Error("rpc down");
        return new Map(mints.map((m) => [m, "clear"] as const));
      },
    });
    h.launches.push("a");
    await h.tick();
    expect(h.screen.waiting).toBe(1);
    fail = false;
    await h.tick();
    expect(h.screen.waiting).toBe(0);
    expect(h.screen.takeStats()).toMatchObject({ calls: 2, cleared: 1 });
  });
});
