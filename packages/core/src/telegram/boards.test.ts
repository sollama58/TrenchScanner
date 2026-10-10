import { describe, expect, it } from "vitest";
import {
  ACTIVE_ALERTS_MAX,
  boardWindow,
  currentReturnPct,
  formatActiveAlerts,
  formatTrenchboard,
  signedPct,
  statusText,
  trenchboardKeyboard,
  type ActiveAlert,
  type BoardStats,
} from "./boards.js";

const NOW = Date.parse("2026-10-10T23:00:00Z");
const links = { dashboardUrl: "https://trenchscanner.app" };

function alert(over: Partial<ActiveAlert> = {}): ActiveAlert {
  return {
    mintAddress: "So11111111111111111111111111111111111111112",
    symbol: "PEPE",
    name: "Pepe",
    sentAt: new Date(NOW - 12 * 60_000),
    source: { kind: "model", name: "Atlas" },
    alertMcapUsd: 40_000,
    nowMcapUsd: 58_000,
    peakPct: 140,
    status: "watching",
    hit2x: false,
    minutesLeft: 3,
    ...over,
  };
}

const stats: BoardStats = {
  hours: 24,
  alerts: 23,
  graded: 18,
  won: 11,
  lost: 7,
  pending: 5,
  settled: 15,
  avgReturnPct: 34.2,
  best: { symbol: "MOON", mintAddress: "x".repeat(44), peakPct: 840 },
  recordedSince: null,
};

describe("boardWindow", () => {
  it("reads the windows and their everyday spellings", () => {
    expect(boardWindow("3h")?.hours).toBe(3);
    expect(boardWindow("12")?.hours).toBe(12);
    expect(boardWindow("24")?.key).toBe("24h");
    expect(boardWindow("1d")?.key).toBe("24h");
    expect(boardWindow("7D")?.hours).toBe(168);
    expect(boardWindow("week")?.key).toBe("7d");
    expect(boardWindow("5h")).toBeNull();
    expect(boardWindow("")).toBeNull();
  });
});

describe("the active alerts message", () => {
  it("shows each alert's return now on its alert market cap, its Peak and where it stands", () => {
    const html = formatActiveAlerts(
      [
        alert(),
        alert({
          symbol: "OLD",
          sentAt: new Date(NOW - 3 * 3_600_000),
          source: { kind: "filter", name: "f" },
          nowMcapUsd: 30_000,
          status: "won",
          hit2x: true,
          minutesLeft: null,
        }),
      ],
      links,
      NOW,
    );
    expect(html).toContain("2 tracking");
    expect(html).toContain("<b>1.</b> 🟢 <b>$PEPE</b>  ·  12m ago  ·  ⏳ 3m left");
    expect(html).toContain("Now <b>+45%</b>  ·  MC $58.0k  ·  Peak +140%");
    expect(html).toContain("<b>2.</b> 🎯 <b>$OLD</b>  ·  3h 0m ago  ·  ✅ 2x");
    expect(html).toContain("Now <b>−25%</b>");
    expect(html).toContain('href="https://trenchscanner.app/#live"');
  });

  it("says so when nothing is being tracked, and counts past the cap", () => {
    expect(formatActiveAlerts([], links, NOW)).toContain("Nothing this chat was alerted on");
    const many = Array.from({ length: ACTIVE_ALERTS_MAX + 4 }, (_, i) =>
      alert({ sentAt: new Date(NOW - i * 60_000) }),
    );
    expect(formatActiveAlerts(many, links, NOW)).toContain("… and 4 more");
  });

  it("escapes token text", () => {
    expect(formatActiveAlerts([alert({ symbol: "<b>" })], links, NOW)).toContain("$&lt;b&gt;");
  });

  it("reads statuses and returns as the feed card does", () => {
    expect(statusText({ status: "watching", hit2x: true, minutesLeft: 4 })).toBe("🚀 2x hit");
    expect(statusText({ status: "disqualified", hit2x: true, minutesLeft: null })).toBe("🛑 stopped out");
    expect(currentReturnPct({ alertMcapUsd: 0, nowMcapUsd: 5 })).toBeNull();
    expect(currentReturnPct({ alertMcapUsd: 100, nowMcapUsd: null })).toBeNull();
    expect(signedPct(1240.4)).toBe("+1,240%");
    expect(signedPct(-0.2)).toBe("0%");
  });
});

describe("the trenchboard", () => {
  it("shows the count, hit rate with wins and losses, average return and best run", () => {
    const html = formatTrenchboard(stats);
    expect(html).toContain("last 24h");
    expect(html).toContain("🔔 Alerts  <b>23</b>");
    expect(html).toContain("🎯 2x hit rate  <b>61%</b>  (11 W · 7 L)");
    expect(html).toContain("💵 Avg return  <b>+34%</b>  over 15 settled");
    expect(html).toContain("⏳ 5 still in their 15-minute window");
    expect(html).toContain("🚀 Best  <b>$MOON</b>  +840%");
  });

  it("names a week as 7d, and says where the record starts", () => {
    const html = formatTrenchboard({ ...stats, hours: 168, recordedSince: new Date("2026-10-10T21:30:00Z") });
    expect(html).toContain("last 7d");
    expect(html).toContain("Counting from Oct 10, 21:30 UTC.");
  });

  it("reads an empty window plainly", () => {
    const html = formatTrenchboard({
      ...stats,
      alerts: 0,
      graded: 0,
      won: 0,
      lost: 0,
      pending: 0,
      settled: 0,
      avgReturnPct: null,
      best: null,
    });
    expect(html).toContain("No alerts in this chat over this window.");
    expect(html).not.toContain("hit rate");
  });

  it("marks the window shown among the buttons", () => {
    const row = trenchboardKeyboard("6h").inline_keyboard[0]!;
    expect(row.map((b) => b.text)).toEqual(["3h", "• 6h •", "12h", "24h", "7d"]);
    expect(row.map((b) => b.callback_data)).toEqual(["tb:3h", "tb:6h", "tb:12h", "tb:24h", "tb:7d"]);
  });
});
