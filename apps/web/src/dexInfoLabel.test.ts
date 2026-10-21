import { describe, expect, it } from "vitest";
import { dexInfoChartMark, dexInfoLabel } from "./dexInfoLabel";

const PAID = "2026-10-21T12:00:00.000Z";
const NOW = Date.parse(PAID) + 2 * 60 * 60_000 + 1;

describe("dexInfoLabel", () => {
  it("says paid or updated with the payment time, and info alone when there is no time", () => {
    expect(dexInfoLabel({ dexInfo: true, dexInfoPaidAt: PAID }, NOW)).toEqual({
      text: "DS paid 2h ago",
      title: "DexScreener token info paid 2h ago",
      paidAtMs: Date.parse(PAID),
    });
    const updated = dexInfoLabel({ dexInfo: true, dexInfoPaidAt: PAID, dexInfoUpdated: true }, NOW);
    expect(updated?.text).toBe("DS updated 2h ago");
    expect(dexInfoLabel({ dexInfo: true })).toEqual({
      text: "DS info",
      title: "DexScreener token info. The pair lists a profile, and there is no payment time.",
      paidAtMs: null,
    });
    expect(dexInfoLabel({})).toBeNull();
    expect(dexInfoLabel({ dexInfo: false, dexInfoPaidAt: null })).toBeNull();
  });

  it("does not invent a chart time from a profile with no payment timestamp", () => {
    expect(dexInfoChartMark({ dexInfo: true })).toBeNull();
    expect(dexInfoChartMark({ dexInfo: true, dexInfoPaidAt: "not-a-time" })).toBeNull();
    expect(dexInfoChartMark({ dexInfoPaidAt: PAID, dexInfoUpdated: true }, NOW)).toEqual({
      t: Date.parse(PAID),
      text: "DexScreener token info updated 2h ago",
      updated: true,
    });
  });
});
