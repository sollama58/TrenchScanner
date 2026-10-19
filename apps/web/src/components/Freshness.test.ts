import { describe, expect, it } from "vitest";
import { countdown, nextUpdateText, secondsAgo } from "./Freshness";

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

  it("counts down to the next update, then says it is due", () => {
    expect(countdown(48_000)).toBe("0:48");
    expect(countdown(47_200)).toBe("0:48");
    expect(countdown(725_000)).toBe("12:05");
    expect(countdown(3_725_000)).toBe("1:02:05");
    expect(nextUpdateText(t + 48_000, t)).toBe("Next update in 0:48");
    expect(nextUpdateText(t + 500, t)).toBe("Next update due now");
    expect(nextUpdateText(t - 5_000, t)).toBe("Next update due now");
  });
});
