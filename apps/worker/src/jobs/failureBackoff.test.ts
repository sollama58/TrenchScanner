import { describe, expect, it } from "vitest";
import { FailureBackoff } from "./failureBackoff.js";

const MIN = 60_000;

describe("FailureBackoff", () => {
  it("waits 2 minutes after one failure, doubling to a 20-minute cap", () => {
    const backoff = new FailureBackoff();
    let now = 0;
    const waits: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      backoff.fail("w", now);
      let wait = 0;
      while (backoff.blocked("w", now + wait * MIN)) wait += 1;
      waits.push(wait);
      now += wait * MIN;
    }
    expect(waits).toEqual([2, 4, 8, 16, 20, 20]);
  });

  it("forgets a key on success", () => {
    const backoff = new FailureBackoff();
    backoff.fail("w", 0);
    backoff.fail("w", 2 * MIN);
    backoff.succeed("w");
    expect(backoff.blocked("w", 2 * MIN)).toBe(false);
    backoff.fail("w", 3 * MIN);
    expect(backoff.blocked("w", 5 * MIN - 1)).toBe(true);
    expect(backoff.blocked("w", 5 * MIN)).toBe(false);
  });

  it("takes a fixed wait without escalating", () => {
    const backoff = new FailureBackoff();
    backoff.fail("m", 0, 1);
    backoff.fail("m", MIN, 1);
    expect(backoff.blocked("m", 2 * MIN)).toBe(false);
    backoff.fail("m", 2 * MIN);
    expect(backoff.blocked("m", 4 * MIN - 1)).toBe(true);
    expect(backoff.blocked("m", 4 * MIN)).toBe(false);
  });

  it("starts a key over once it has been quiet past the cap", () => {
    const backoff = new FailureBackoff();
    backoff.fail("w", 0);
    backoff.prune(2 * MIN + 20 * MIN);
    backoff.fail("w", 22 * MIN);
    expect(backoff.blocked("w", 24 * MIN)).toBe(false);
  });
});
