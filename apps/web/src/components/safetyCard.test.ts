import { describe, expect, it } from "vitest";
import { sinceUtc, splitPctText } from "./safetyCard";

describe("splitPctText", () => {
  it("shows both sides to one decimal when the smaller is under 10%, adding to 100", () => {
    expect(splitPctText(7.44, 92.56)).toEqual({ ok: "7.4%", rug: "92.6%" });
    expect(splitPctText(96.6, 3.4)).toEqual({ ok: "96.6%", rug: "3.4%" });
  });

  it("uses whole percents otherwise, still adding to 100", () => {
    expect(splitPctText(37.5, 62.5)).toEqual({ ok: "37%", rug: "63%" });
    expect(splitPctText(100, 0)).toEqual({ ok: "100%", rug: "0%" });
  });
});

describe("sinceUtc", () => {
  it("names the hour in UTC", () => {
    expect(sinceUtc(new Date("2026-10-10T23:00:00Z"))).toBe("Oct 10, 23:00 UTC");
  });
});
