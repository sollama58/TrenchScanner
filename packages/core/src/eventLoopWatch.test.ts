import { afterEach, describe, expect, it } from "vitest";
import { eventLoopReport, resetEventLoopReport, startEventLoopWatch } from "./eventLoopWatch.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function holdLoop(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Busy on purpose: the stall the watch exists to catch.
  }
}

describe("startEventLoopWatch", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
    resetEventLoopReport();
  });

  it("records a held loop with what was running", async () => {
    stop = startEventLoopWatch({ stallMs: 150, tickMs: 20, context: () => ({ scan: 1234 }) });
    await wait(30);
    holdLoop(300);
    await wait(50);
    const report = eventLoopReport();
    expect(report.stalls).toBe(1);
    expect(report.worst?.blockedMs).toBeGreaterThanOrEqual(150);
    expect(report.last?.during).toEqual({ scan: 1234 });
  });

  it("stays quiet on a loop that keeps up", async () => {
    stop = startEventLoopWatch({ stallMs: 150, tickMs: 20 });
    await wait(120);
    expect(eventLoopReport().stalls).toBe(0);
  });
});
