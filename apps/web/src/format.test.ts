import { describe, expect, it } from "vitest";
import { ago, change, multiple, pct, shortAddress, tokenLabel, usd } from "./format";

describe("format", () => {
  it("abbreviates dollar figures", () => {
    expect(usd(950)).toBe("$950");
    expect(usd(12_345)).toBe("$12.3K");
    expect(usd(1_250_000)).toBe("$1.25M");
    expect(usd(null)).toBe("–");
  });

  it("turns a return into a price multiple", () => {
    expect(multiple(100)).toBe("2.0x");
    expect(multiple(300)).toBe("4.0x");
    expect(multiple(1900)).toBe("20x");
    expect(multiple(null)).toBe("–");
  });

  it("measures change and handles a missing base", () => {
    expect(change(100, 150)).toBe(50);
    expect(change(0, 150)).toBeNull();
    expect(change(100, null)).toBeNull();
  });

  it("formats rates, ages and labels", () => {
    expect(pct(75.4)).toBe("75%");
    expect(pct(null)).toBe("–");
    const now = Date.parse("2026-10-03T12:00:00Z");
    expect(ago("2026-10-03T11:55:00Z", now)).toBe("5m ago");
    expect(ago("2026-10-03T09:00:00Z", now)).toBe("3h ago");
    expect(shortAddress("So11111111111111111111111111111111111111112")).toBe("So11…1112");
    expect(tokenLabel({ symbol: "WIF", name: "dogwifhat", mintAddress: "x" })).toBe("$WIF");
  });
});
