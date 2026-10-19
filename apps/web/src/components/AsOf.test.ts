import { describe, expect, it } from "vitest";
import { asOfText } from "./AsOf";

describe("asOfText", () => {
  const now = new Date(2026, 9, 19, 14, 0).getTime();
  const time = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("gives the clock time alone while the figures are recent", () => {
    const at = new Date(2026, 9, 19, 13, 50);
    expect(asOfText(at.toISOString(), now)).toBe(`as of ${time(at)}`);
  });

  it("adds how long ago once they are older, and the date when it isn't today", () => {
    const hours = new Date(2026, 9, 19, 11, 0);
    expect(asOfText(hours.toISOString(), now)).toBe(`as of ${time(hours)}, 3h ago`);
    const yesterday = new Date(2026, 9, 18, 20, 0);
    expect(asOfText(yesterday.toISOString(), now)).toMatch(/^as of .+, .+, 18h ago$/);
  });
});
