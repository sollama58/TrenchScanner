// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { tooltipBody } from "../content/ui";
import { DEFAULT_SETTINGS } from "./settings";
import { token } from "./testToken";
import { pillSegments } from "./pill";
import {
  cleanTooltip,
  DEFAULT_TOOLTIP,
  needsMap,
  pillParts,
  pillsNeedMap,
  shownLines,
  TIP_LINES,
} from "./tooltip";
import type { OverlayBubbleTotals } from "./types";
import { verdictFor } from "./verdict";

const call = {
  model: "rules",
  name: "Runner A",
  tier: "high",
  confidence: 80,
  calibratedPct: 41,
  at: new Date().toISOString(),
  mcapUsd: 4_000,
};
const totals = {
  kolBundledPct: 12.4,
  bundledPct: 30,
  sameMinutePct: null,
  devTiedPct: 3,
  transferredPct: null,
} as unknown as OverlayBubbleTotals;

describe("tooltip lines", () => {
  it("defaults to the old tooltip plus KOL bundled and the safety screen", () => {
    expect(shownLines(DEFAULT_TOOLTIP, DEFAULT_SETTINGS)).toEqual([
      "models",
      "filters",
      "ai",
      "aiReasoning",
      "mcap",
      "safety",
      "flag:bundledSupplyPct",
      "flag:sniperTopHolderCount",
      "flag:linkedWalletPct",
      "map:kolBundledPct",
      "statsAge",
      "link",
    ]);
    expect(needsMap(DEFAULT_TOOLTIP, DEFAULT_SETTINGS)).toBe(true);
  });

  it("keeps the reader's picks and order, and repairs what was stored", () => {
    const prefs = cleanTooltip({
      order: ["link", "nope", ...TIP_LINES.filter((l) => l !== "link" && l !== "holders")],
      on: { "map:kolBundledPct": false, "flag:devWalletPct": true, x: true },
    });
    expect(prefs.order[0]).toBe("link");
    // A line the stored order lacks lands after its default neighbour.
    expect(prefs.order.indexOf("holders")).toBe(prefs.order.indexOf("mcap") + 1);
    expect(prefs.order).toHaveLength(TIP_LINES.length);
    expect(prefs.on).toEqual({ "map:kolBundledPct": false, "flag:devWalletPct": true });
    const lines = shownLines(prefs, DEFAULT_SETTINGS);
    expect(lines[0]).toBe("link");
    expect(lines).toContain("flag:devWalletPct");
    expect(needsMap(prefs, DEFAULT_SETTINGS)).toBe(false);
    expect(cleanTooltip(null)).toEqual(DEFAULT_TOOLTIP);
  });

  it("draws the chosen lines in order, with map totals once read", () => {
    const t = token({ modelCalls: [call] });
    const v = verdictFor(t, DEFAULT_SETTINGS);
    const lines = shownLines(DEFAULT_TOOLTIP, DEFAULT_SETTINGS);
    expect(tooltipBody(t, v, lines).textContent).toContain("KOL bundled…");
    const body = tooltipBody(t, v, lines, totals);
    expect(body.textContent).toContain("KOL bundled12%");
    expect(body.textContent).toContain("Runner A");
    // No reading: the line is left out rather than shown empty.
    expect(tooltipBody(t, v, lines, null).textContent).not.toContain("KOL bundled");
    const only = tooltipBody(t, v, ["link", "map:devTiedPct", "mcap"], totals);
    expect(only.textContent).not.toContain("Runner A");
    expect([...only.querySelectorAll(".sec .l")].map((n) => n.textContent)).toEqual([
      "Tied to the dev",
      "Alerted at",
    ]);
  });

  it("builds the pills: the old one by default, and a second only when turned on", () => {
    const t = token({ modelCalls: [call], liveMcapUsd: 6_000 });
    const v = verdictFor(t, DEFAULT_SETTINGS);
    const { main, more } = pillParts(DEFAULT_TOOLTIP);
    expect(more).toBeNull();
    expect(pillsNeedMap(DEFAULT_TOOLTIP)).toBe(false);
    expect(pillSegments(main, t, v, DEFAULT_SETTINGS).map((s) => s.text)).toEqual(["Runner A", "41%"]);

    const prefs = cleanTooltip({ second: { enabled: true }, pill: { on: { odds: false, change: true } } });
    const parts = pillParts(prefs);
    expect(pillSegments(parts.main, t, v, DEFAULT_SETTINGS).map((s) => s.text)).toEqual(["Runner A", "+50%"]);
    expect(pillsNeedMap(prefs)).toBe(true);
    const second = pillSegments(parts.more!, t, v, DEFAULT_SETTINGS, totals);
    expect(second.map((s) => s.text)).toEqual(["+50%", "61h", "BNDL 2%", "LINK 14%", "KOLB 12%"]);
    // Map parts wait for the totals rather than showing a blank.
    expect(pillSegments(parts.more!, t, v, DEFAULT_SETTINGS).map((s) => s.text)).not.toContain("KOLB");
  });
});
