import { describe, expect, it } from "vitest";
import { EMPTY_CURVE_PATH } from "../curation/curveTape.js";
import { EMPTY_PRICE_PATH } from "../curation/pricePath.js";
import { alertGuardBlocks } from "./alertGuard.js";

describe("alertGuardBlocks", () => {
  const dumped5m = { priceChange5mPct: -85, buys1h: 80, sells1h: 20 };
  const flushing = { priceChange5mPct: -30, buys1h: 80, sells1h: 20 };
  const dipping = { priceChange5mPct: -5, buys1h: 80, sells1h: 20 };
  const sellerHour = { priceChange5mPct: 4, buys1h: 40, sells1h: 60 };
  const healthy = { priceChange5mPct: 6, buys1h: 70, sells1h: 30 };
  const curve = (curveRet1mPct: number | null) => ({ ...EMPTY_CURVE_PATH, curveRet1mPct });
  const path = (pathRet1mPct: number | null) => ({ ...EMPTY_PRICE_PATH, pathRet1mPct });

  it("lets everything through when off", () => {
    expect(alertGuardBlocks(dumped5m, "off")).toBeNull();
  });

  it("holds back only a collapse in flush mode, not a 25-80% dip", () => {
    expect(alertGuardBlocks(dumped5m, "flush")).toBe("collapse");
    expect(alertGuardBlocks(flushing, "flush")).toBeNull();
    expect(alertGuardBlocks(dipping, "flush")).toBeNull();
    expect(alertGuardBlocks(sellerHour, "flush")).toBeNull();
  });

  it("sees a one-minute collapse on the curve first, the scan's tape without it", () => {
    expect(alertGuardBlocks({ ...healthy, curvePath: curve(-70) }, "flush")).toBe("collapse");
    expect(alertGuardBlocks({ ...healthy, curvePath: curve(-40), pricePath: path(-70) }, "flush")).toBeNull();
    expect(alertGuardBlocks({ ...healthy, curvePath: curve(null), pricePath: path(-70) }, "flush")).toBe(
      "collapse",
    );
    expect(alertGuardBlocks({ ...healthy, pricePath: path(-50) }, "flush")).toBeNull();
  });

  it("also wants buyers in control and a non-red five minutes in ready mode", () => {
    expect(alertGuardBlocks(dumped5m, "ready")).toBe("collapse");
    expect(alertGuardBlocks(flushing, "ready")).toBe("falling");
    expect(alertGuardBlocks(dipping, "ready")).toBe("falling");
    expect(alertGuardBlocks(sellerHour, "ready")).toBe("sellers");
    expect(alertGuardBlocks(healthy, "ready")).toBeNull();
  });

  it("does not block on short-window data nobody sent", () => {
    expect(alertGuardBlocks({}, "ready")).toBeNull();
  });
});
