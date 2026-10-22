import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DexInfoLabel, dexInfoChartMark, dexInfoLabel } from "./dexInfoLabel";

const PAID = "2026-10-21T12:00:00.000Z";
const NOW = Date.parse(PAID) + 2 * 60 * 60_000 + 1;

describe("dexInfoLabel", () => {
  it("shows DP for a payment, an update, and info alone, and keeps each event in the title", () => {
    expect(dexInfoLabel({ dexInfo: true, dexInfoPaidAt: PAID }, NOW)).toEqual({
      text: "DP",
      title: "DexScreener token info paid 2h ago",
      paidAtMs: Date.parse(PAID),
    });
    expect(dexInfoLabel({ dexInfoPaidAt: PAID }, NOW)).toEqual({
      text: "DP",
      title: "DexScreener token info paid 2h ago",
      paidAtMs: Date.parse(PAID),
    });
    expect(dexInfoLabel({ dexInfo: true, dexInfoPaidAt: PAID, dexInfoUpdated: true }, NOW)).toEqual({
      text: "DP",
      title: "DexScreener token info updated 2h ago",
      paidAtMs: Date.parse(PAID),
    });
    expect(dexInfoLabel({ dexInfo: true })).toEqual({
      text: "DP",
      title: "DexScreener token info. The pair lists a profile, and there is no payment time.",
      paidAtMs: null,
    });
    expect(dexInfoLabel({ dexInfo: true, dexInfoPaidAt: "not-a-time" })).toEqual({
      text: "DP",
      title: "DexScreener token info. The pair lists a profile, and there is no payment time.",
      paidAtMs: null,
    });
    expect(dexInfoLabel({})).toBeNull();
    expect(dexInfoLabel({ dexInfo: false, dexInfoPaidAt: null })).toBeNull();
  });

  it("does not invent a chart time from a profile with no payment timestamp", () => {
    expect(dexInfoChartMark({ dexInfo: true })).toBeNull();
    expect(dexInfoChartMark({ dexInfo: true, dexInfoPaidAt: "not-a-time" })).toBeNull();
    expect(dexInfoChartMark({ dexInfoPaidAt: PAID }, NOW)).toEqual({
      t: Date.parse(PAID),
      text: "DexScreener token info paid 2h ago",
      updated: false,
    });
    expect(dexInfoChartMark({ dexInfoPaidAt: PAID, dexInfoUpdated: true }, NOW)).toEqual({
      t: Date.parse(PAID),
      text: "DexScreener token info updated 2h ago",
      updated: true,
    });
  });

  it("renders the pill as DP and puts the event only in the title", () => {
    const updated = renderToStaticMarkup(
      createElement(DexInfoLabel, {
        token: { dexInfo: true, dexInfoPaidAt: PAID, dexInfoUpdated: true },
        now: NOW,
      }),
    );
    expect(updated).toBe(
      '<span class="pill dex-info" title="DexScreener token info updated 2h ago">DP</span>',
    );
    const info = renderToStaticMarkup(createElement(DexInfoLabel, { token: { dexInfo: true }, now: NOW }));
    expect(info).toBe(
      '<span class="pill dex-info" title="DexScreener token info. The pair lists a profile, and there is no payment time.">DP</span>',
    );
    expect(renderToStaticMarkup(createElement(DexInfoLabel, { token: {}, now: NOW }))).toBe("");
  });
});
