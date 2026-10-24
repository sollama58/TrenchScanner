import { describe, expect, it, vi } from "vitest";
import {
  countdown,
  holderStatusText,
  liveAt,
  nextBeat,
  nextUpdateText,
  secondsAgo,
  subscribeClock,
} from "./Freshness";

describe("freshness text", () => {
  const t = 1_000_000_000;

  it("says the age to the second", () => {
    expect(secondsAgo(t, t + 400)).toBe("0s ago");
    expect(secondsAgo(t, t + 42_000)).toBe("42s ago");
    expect(secondsAgo(t, t + 185_000)).toBe("3m 05s ago");
    expect(secondsAgo(t, t + (2 * 3600 + 4 * 60) * 1_000)).toBe("2h 04m ago");
    // A clock a little ahead of the scan's stamp doesn't read as the future.
    expect(secondsAgo(t, t - 3_000)).toBe("0s ago");
  });

  it("counts down to the next update, then says it is updating", () => {
    expect(countdown(48_000)).toBe("0:48");
    expect(countdown(47_200)).toBe("0:48");
    expect(countdown(725_000)).toBe("12:05");
    expect(countdown(3_725_000)).toBe("1:02:05");
    expect(nextUpdateText(t + 48_000, t)).toBe("Next update in 0:48");
    expect(nextUpdateText(t + 500, t)).toBe("Updating…");
    expect(nextUpdateText(t - 5_000, t)).toBe("Updating…");
    // A read since the update was due found none: the countdown is to the next look for it.
    expect(nextUpdateText(t + 12_000, t, true)).toBe("Checking again in 0:12");
  });

  it("says Live with the list's age, never Live alone (user ask 2026-10-24)", () => {
    expect(holderStatusText(t, t - 42_000, null, { live: true })).toBe("Live · 42s ago");
    expect(holderStatusText(t, t - 42_000, t + 48_000, { live: true })).toBe("Live · 42s ago");
    expect(holderStatusText(t, t - 4 * 60_000, null, { live: true })).toBe("Live · 4m 00s ago");
  });

  it("is live only until liveUntil", () => {
    expect(liveAt(t, true, t + 1)).toBe(true);
    expect(liveAt(t, true, t)).toBe(false);
    expect(liveAt(t, true, null)).toBe(true);
    expect(liveAt(t, false, t + 1)).toBe(false);
  });

  it("counts down from the chain read when it is not live, and does not say live", () => {
    expect(holderStatusText(t, t - 42_000, t + 48_000)).toBe("42s ago · Next update in 0:48");
    expect(holderStatusText(t, t - 42_000, t + 500)).toBe("42s ago · Updating…");
    expect(holderStatusText(t, t - 42_000, t + 48_000).toLowerCase()).not.toContain("live");
  });

  it("finds a poll's next beat from when its timer started", () => {
    const schedule = { from: t, every: 30_000 };
    expect(nextBeat(schedule, t - 2_000)).toBe(t);
    expect(nextBeat(schedule, t + 1)).toBe(t + 30_000);
    expect(nextBeat(schedule, t + 30_000)).toBe(t + 30_000);
    expect(nextBeat(schedule, t + 61_000)).toBe(t + 90_000);
  });
});

describe("the one-second clock", () => {
  it("skips ticks in a hidden tab and catches up on return", () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const doc = {
      visibilityState: "visible",
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    };
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("document", doc);
    try {
      let ticks = 0;
      const stop = subscribeClock(() => (ticks += 1));
      vi.advanceTimersByTime(3_000);
      expect(ticks).toBe(3);
      doc.visibilityState = "hidden";
      vi.advanceTimersByTime(60_000);
      expect(ticks).toBe(3);
      // Shown again: the clock catches up at once, not at the next tick.
      doc.visibilityState = "visible";
      for (const fn of listeners) fn();
      expect(ticks).toBe(4);
      vi.advanceTimersByTime(1_000);
      expect(ticks).toBe(5);
      stop();
      expect(listeners.size).toBe(0);
      vi.advanceTimersByTime(5_000);
      expect(ticks).toBe(5);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
