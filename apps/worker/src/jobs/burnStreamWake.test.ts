// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { BURN_RECHECK_MS, BurnStreamWake } from "./burnReconciler.js";

describe("BurnStreamWake", () => {
  it("owes a pass at once and another once the burn has had time to finalize", () => {
    const wake = new BurnStreamWake();
    expect(wake.take(0)).toBe(false);
    wake.wake(1_000);
    expect(wake.take(1_000)).toBe(true);
    expect(wake.take(2_000)).toBe(false);
    expect(wake.take(1_000 + BURN_RECHECK_MS)).toBe(true);
    expect(wake.take(10 * BURN_RECHECK_MS)).toBe(false);
  });

  it("folds sightings that are due together into one pass", () => {
    const wake = new BurnStreamWake();
    wake.wake(0);
    wake.wake(10);
    expect(wake.take(20)).toBe(true);
    expect(wake.take(30)).toBe(false);
    expect(wake.take(10 + BURN_RECHECK_MS)).toBe(true);
  });
});
