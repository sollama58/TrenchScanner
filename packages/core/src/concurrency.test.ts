import { describe, expect, it } from "vitest";
import { forEachWithConcurrency } from "./concurrency.js";

describe("forEachWithConcurrency", () => {
  it("calls fn exactly once for every item", async () => {
    const seen: number[] = [];
    await forEachWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never runs more than `concurrency` operations at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await forEachWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("handles an empty list without starting any workers", async () => {
    let calls = 0;
    await forEachWithConcurrency([], 5, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it("doesn't start more workers than there are items", async () => {
    let started = 0;
    await forEachWithConcurrency([1, 2], 10, async () => {
      started += 1;
    });
    expect(started).toBe(2);
  });

  it("propagates a thrown error from fn", async () => {
    await expect(
      forEachWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
