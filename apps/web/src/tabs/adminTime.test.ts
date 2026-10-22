import { describe, expect, it } from "vitest";
import { formatAdminDay, formatAdminTime, formatDuration } from "./adminTime";

describe("admin times", () => {
  it("renders a UTC instant in Eastern Time with the zone label", () => {
    // October is EDT (UTC-4).
    expect(formatAdminTime("2026-10-22T20:13:00.000Z")).toBe("Oct 22, 4:13 PM ET");
    expect(formatAdminDay("2026-10-22T20:13:00.000Z")).toBe("Oct 22, 2026 ET");
  });

  it("formats durations without turning twelve hours into a pile of minutes", () => {
    expect(formatDuration(12 * 3_600_000)).toBe("12h");
    expect(formatDuration(90 * 60_000)).toBe("1.5h");
    expect(formatDuration(2 * 3_600_000)).toBe("2h");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(null)).toBe("–");
  });

  it("returns null for a missing or unreadable time", () => {
    expect(formatAdminTime(null)).toBeNull();
    expect(formatAdminTime("")).toBeNull();
    expect(formatAdminTime("not-a-time")).toBeNull();
    expect(formatAdminDay(undefined)).toBeNull();
  });
});
