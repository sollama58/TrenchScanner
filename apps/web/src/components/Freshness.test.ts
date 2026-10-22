import { describe, expect, it } from "vitest";
import { countdown, holderStatusText, nextBeat, nextUpdateText, secondsAgo } from "./Freshness";

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

  it("says Live only when the stream is pushing and nothing is scheduled", () => {
    expect(holderStatusText(t, t - 42_000, null, { live: true })).toBe("Live");
    expect(holderStatusText(t, t - 42_000, null, { live: true })).not.toMatch(/ago|Next update|Updating/);
  });

  it("counts down from the chain read when a next-read time exists, and does not say live", () => {
    expect(holderStatusText(t, t - 42_000, t + 48_000)).toBe("42s ago · Next update in 0:48");
    expect(holderStatusText(t, t - 42_000, t + 48_000, { live: true })).toBe("42s ago · Next update in 0:48");
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
