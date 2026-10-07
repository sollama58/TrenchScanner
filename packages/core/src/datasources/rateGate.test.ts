import { describe, expect, it } from "vitest";
import { RateGate, RateGateDeadlineError } from "./rateGate.js";

/** A gate on a fake clock: sleeping advances time instead of waiting. */
function fakeGate(perMinute: number, burst: number) {
  let now = 1_000_000;
  const gate = new RateGate({
    name: "test",
    perMinute,
    burst,
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

  it("gives up at once when the slot would open past the deadline", async () => {
    const { gate, clock } = fakeGate(60, 1);
    await gate.acquire();
    gate.throttled(30_000);
    const start = clock();
    await expect(gate.acquire(start + 5_000)).rejects.toBeInstanceOf(RateGateDeadlineError);
    expect(clock()).toBe(start);
    expect(gate.takeStats()).toMatchObject({ requests: 1, gaveUp: 1 });
  });

  it("resets its counts on each read", async () => {
    const { gate } = fakeGate(600, 5);
    await gate.acquire();
    gate.takeStats();
    expect(gate.takeStats()).toEqual({ requests: 0, throttled: 0, waitedMs: 0, gaveUp: 0 });
  });
});
