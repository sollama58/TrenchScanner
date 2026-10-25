// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { tooltipBody } from "../content/ui";
import { DEFAULT_SETTINGS } from "./settings";
import { token } from "./testToken";
import { cleanTooltip, DEFAULT_TOOLTIP, needsMap, shownLines, TIP_LINES } from "./tooltip";
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
  it("defaults to the old tooltip plus KOL bundled", () => {
    expect(shownLines(DEFAULT_TOOLTIP, DEFAULT_SETTINGS)).toEqual([
      "models",
      "filters",
      "ai",
      "aiReasoning",
      "mcap",
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
});
