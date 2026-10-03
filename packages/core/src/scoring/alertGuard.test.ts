import { describe, expect, it } from "vitest";
import { alertGuardBlocks } from "./alertGuard.js";

describe("alertGuardBlocks", () => {
  const flushing = { priceChange5mPct: -30, buys1h: 80, sells1h: 20 };
  const dipping = { priceChange5mPct: -5, buys1h: 80, sells1h: 20 };
  const sellerHour = { priceChange5mPct: 4, buys1h: 40, sells1h: 60 };
  const healthy = { priceChange5mPct: 6, buys1h: 70, sells1h: 30 };

  it("lets everything through when off", () => {
    expect(alertGuardBlocks(flushing, "off")).toBeNull();
  });

  it("holds back only a five-minute flush in flush mode", () => {
    expect(alertGuardBlocks(flushing, "flush")).toBe("flush");
    expect(alertGuardBlocks(dipping, "flush")).toBeNull();
    expect(alertGuardBlocks(sellerHour, "flush")).toBeNull();
  });

  it("also wants buyers in control and a non-red five minutes in ready mode", () => {
    expect(alertGuardBlocks(flushing, "ready")).toBe("flush");
    expect(alertGuardBlocks(dipping, "ready")).toBe("falling");
    expect(alertGuardBlocks(sellerHour, "ready")).toBe("sellers");
    expect(alertGuardBlocks(healthy, "ready")).toBeNull();
  });

  it("does not block on short-window data DexScreener didn't send", () => {
    expect(alertGuardBlocks({}, "ready")).toBeNull();
  });
});
