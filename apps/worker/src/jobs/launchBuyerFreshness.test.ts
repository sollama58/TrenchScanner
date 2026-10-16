import { describe, expect, it } from "vitest";
import { EMPTY_TRADE_FLOW } from "@trenchscanner/core";
import { computeFreshLaunchBuyerPct } from "./launchBuyerFreshness.js";
import { withLaunchSnipers } from "./scanJob.js";

const HOUR = 3_600_000;
const LAUNCH = new Date("2026-10-12T17:20:20Z");
const before = (hours: number) => new Date(LAUNCH.getTime() - hours * HOUR);

describe("computeFreshLaunchBuyerPct", () => {
  it("counts wallets first used within 24h before the launch, however old the coin is now", () => {
    // The 2026-10-12 bundle: wallets made ~2.7h before launch, next to a long-lived bot.
    const earliest = new Map<string, Date | null>([
      ["bundle-1", before(2.7)],
      ["bundle-2", before(2.8)],
      ["bot", before(24 * 200)],
      ["warm", before(5 * 24)],
    ]);
    expect(computeFreshLaunchBuyerPct(["bundle-1", "bundle-2", "bot", "warm"], LAUNCH, earliest)).toBe(50);
  });

  it("is unknown while any wallet is unread, and counts an undatable one as not fresh", () => {
    expect(computeFreshLaunchBuyerPct(["a", "b"], LAUNCH, new Map([["a", before(1)]]))).toBeNull();
    expect(
      computeFreshLaunchBuyerPct(
        ["a", "b"],
        LAUNCH,
        new Map([
          ["a", before(1)],
          ["b", null],
        ]),
      ),
    ).toBe(50);
    expect(computeFreshLaunchBuyerPct([], LAUNCH, new Map())).toBeNull();
  });
});

describe("withLaunchSnipers and the launch-buyer share", () => {
  const snipers = {
    holding: 7,
    holdingCut: 4,
    seen: 25,
    devHolding: null,
    firstBuyersSupplyPct: 25,
    launchBundledBuyers: 3,
    devBuySupplyPct: 2,
  };

  it("carries the share with the launch shape", () => {
    expect(withLaunchSnipers(undefined, snipers, 80)?.freshLaunchBuyerPct).toBe(80);
    expect(withLaunchSnipers(undefined, snipers)?.freshLaunchBuyerPct).toBeNull();
  });

  it("keeps it while the holdings figure is stale, and leaves the flow alone without either", () => {
    expect(withLaunchSnipers(undefined, undefined, 40)).toEqual({
      ...EMPTY_TRADE_FLOW,
      freshLaunchBuyerPct: 40,
    });
    expect(withLaunchSnipers(undefined, undefined)).toBeUndefined();
  });
});
