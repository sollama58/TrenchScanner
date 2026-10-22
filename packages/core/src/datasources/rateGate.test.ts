import { describe, expect, it } from "vitest";
import { RateGate, RateGateDeadlineError, RateGateOpenError } from "./rateGate.js";

/** A gate on a fake clock: sleeping advances time instead of waiting. */
function fakeGate(perMinute: number, burst: number, reserve?: number, minPauseMs?: number) {
  let now = 1_000_000;
  const gate = new RateGate({
    name: "test",
    perMinute,
    burst,
    reserve,
    minPauseMs,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  return { gate, clock: () => now };
}

describe("RateGate", () => {
  it("lets a burst through at once, then paces at the per-minute rate", async () => {
    const { gate, clock } = fakeGate(60, 3);
    const start = clock();
    for (let i = 0; i < 3; i++) await gate.acquire();
    expect(clock()).toBe(start);
    await gate.acquire();
    await gate.acquire();
    // 60 a minute is one a second once the burst is spent.
    expect(clock() - start).toBe(2_000);
    expect(gate.takeStats()).toMatchObject({ requests: 5, throttled: 0 });
  });

  it("holds every request through a 429 pause, then restarts from an empty bucket", async () => {
    const { gate, clock } = fakeGate(60, 10);
    await gate.acquire();
    const start = clock();
    gate.throttled(10_000);
    // A second 429 inside the same pause is the same episode.
    gate.throttled(5_000);
    await gate.acquire();
    expect(clock() - start).toBe(11_000);
    expect(gate.takeStats()).toMatchObject({ requests: 2, throttled: 1 });
  });

  it("pauses at least minPauseMs on a 429, however short the backoff asked for", async () => {
    const { gate, clock } = fakeGate(600, 10, 0, 2_000);
    const start = clock();
    gate.throttled(300);
    await gate.acquire();
    // The 2 s floor, then one slot at 600 a minute from the emptied bucket.
    expect(clock() - start).toBe(2_100);
  });

  it("gives up at once when the slot would open past the deadline", async () => {
    const { gate, clock } = fakeGate(60, 1);
    await gate.acquire();
    gate.throttled(30_000);
    const start = clock();
    await expect(gate.acquire(start + 5_000)).rejects.toBeInstanceOf(RateGateDeadlineError);
    expect(clock()).toBe(start);
    expect(gate.takeStats()).toMatchObject({ requests: 1, gaveUp: 1 });
  });

  it("keeps its reserve for priority requests: ordinary ones wait, priority ones go at once", async () => {
    const { gate, clock } = fakeGate(60, 5, 3);
    const start = clock();
    // Two ordinary requests take the slots above the reserve.
    await gate.acquire();
    await gate.acquire();
    expect(clock()).toBe(start);
    // The three reserved slots are there for priority requests, back to back.
    for (let i = 0; i < 3; i++) await gate.acquire(Infinity, true);
    expect(clock()).toBe(start);
    // Empty now: an ordinary request waits for the reserve to refill as well as its own slot.
    await gate.acquire();
    expect(clock() - start).toBe(4_000);
  });

  it("gives an ordinary request up at once when the reserve would hold it past the deadline", async () => {
    const { gate, clock } = fakeGate(60, 5, 3);
    await gate.acquire();
    await gate.acquire();
    const start = clock();
    await expect(gate.acquire(start + 500)).rejects.toBeInstanceOf(RateGateDeadlineError);
    // A priority request still has the reserve.
    await gate.acquire(start + 500, true);
    expect(clock()).toBe(start);
  });

  it("never reserves the whole burst", async () => {
    const { gate, clock } = fakeGate(60, 2, 5);
    const start = clock();
    await gate.acquire();
    expect(clock()).toBe(start);
  });

  it("resets its counts on each read", async () => {
    const { gate } = fakeGate(600, 5);
    await gate.acquire();
    gate.takeStats();
    expect(gate.takeStats()).toEqual({ requests: 0, throttled: 0, waitedMs: 0, gaveUp: 0 });
  });

  it("takes a batch's cost in tokens, never more than the bucket", async () => {
    const { gate, clock } = fakeGate(60, 10);
    const start = clock();
    await gate.acquire(Infinity, false, 8);
    await gate.acquire(Infinity, false, 2);
    expect(clock()).toBe(start);
    // Empty now: 5 more tokens is 5 s at one a second.
    await gate.acquire(Infinity, false, 5);
    expect(clock() - start).toBe(5_000);
    // A cost above the bucket waits for a full one, not forever.
    await gate.acquire(Infinity, false, 50);
    expect(clock() - start).toBe(15_000);
  });

  it("opens a breaker after enough 429s in its window, refusing ordinary requests but not priority ones", async () => {
    let now = 1_000_000;
    const gate = new RateGate({
      name: "test",
      perMinute: 600_000,
      burst: 1_000,
      minPauseMs: 5_000,
      breaker: { after: 3, withinMs: 60_000, openMs: 30_000 },
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    gate.throttled(0);
    now += 20_000;
    gate.throttled(0);
    expect(gate.isOpen()).toBe(false);
    // Three within the minute: open.
    now += 20_000;
    gate.throttled(0);
    expect(gate.isOpen()).toBe(true);
    await expect(gate.acquire()).rejects.toBeInstanceOf(RateGateOpenError);
    const at = now;
    await gate.acquire(Infinity, true);
    // The priority request still waited out the 5 s pause.
    expect(now - at).toBeGreaterThanOrEqual(5_000);
    now = at + 30_000;
    await gate.acquire();
    expect(gate.isOpen()).toBe(false);
  });

  it("doesn't open on 429s spread wider than its window", () => {
    let now = 0;
    const gate = new RateGate({
      name: "test",
      perMinute: 600,
      burst: 10,
      breaker: { after: 3, withinMs: 60_000, openMs: 30_000 },
      now: () => now,
    });
    for (let i = 0; i < 5; i += 1) {
      gate.throttled(0);
      now += 31_000;
    }
    expect(gate.isOpen()).toBe(false);
  });
});
