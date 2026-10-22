import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, normalizeAppearance, preferDeviceChartPrefs, withPreset } from "./appearance";
import { FIB_LEVELS } from "./chartDrawings";
import {
  CHART_FIB_LEVELS,
  CHART_TIMEFRAME_MS,
  DEFAULT_CHART_EVENT_FIRST,
  DEFAULT_CHART_EVENT_KINDS,
  DEFAULT_CHART_INDICATORS,
  chartColorReference,
  chartEventsToDraw,
  chartFlagKind,
  chartFlagPrice,
  chartFlagsToDraw,
  chartPrefsFromDevice,
  eventEmphasisColor,
  eventFlagMetrics,
  horizontalFlagPrices,
  type ChartEventKind,
} from "./chartEvents";
import { TIMEFRAMES } from "./priceChart";

const flag = (kind: ChartEventKind, t: number, label: string) => ({ kind, t, label });

describe("chart event appearance", () => {
  it("shows every kind but the screen pass, and collapses filter and model only", () => {
    expect(DEFAULT_APPEARANCE.chartEventKinds).toEqual([...DEFAULT_CHART_EVENT_KINDS]);
    expect(DEFAULT_APPEARANCE.chartEventKinds).not.toContain("screen");
    expect(DEFAULT_APPEARANCE.chartEventKinds).toEqual(
      expect.arrayContaining(["alert", "filter", "model", "graduation", "scanned"]),
    );
    expect(DEFAULT_APPEARANCE.chartEventFirst).toEqual([...DEFAULT_CHART_EVENT_FIRST]);
    expect(normalizeAppearance({}).chartEventKinds).toEqual([...DEFAULT_CHART_EVENT_KINDS]);
    expect(normalizeAppearance({}).chartEventFirst).toEqual(["filter", "model"]);
  });

  it("keeps a real list and falls back when a value is not a kind", () => {
    expect(normalizeAppearance({ chartEventKinds: ["screen", "alert"] }).chartEventKinds).toEqual([
      "alert",
      "screen",
    ]);
    expect(normalizeAppearance({ chartEventKinds: [] }).chartEventKinds).toEqual([]);
    expect(normalizeAppearance({ chartEventFirst: ["alert"] }).chartEventFirst).toEqual(["alert"]);
    for (const bad of ["nope", 1, null, ["alert", "nope"], ["filter", "filter"]]) {
      expect(normalizeAppearance({ chartEventKinds: bad }).chartEventKinds).toEqual([
        ...DEFAULT_CHART_EVENT_KINDS,
      ]);
      expect(normalizeAppearance({ chartEventFirst: bad }).chartEventFirst).toEqual(["filter", "model"]);
    }
  });

  it("keeps the reader's chart events when a preset is applied", () => {
    const current = normalizeAppearance({ chartEventKinds: ["model"], chartEventFirst: ["alert"] });
    const next = withPreset(current, { density: "compact" });
    expect(next.chartEventKinds).toEqual(["model"]);
    expect(next.chartEventFirst).toEqual(["alert"]);
    expect(next.density).toBe("compact");
  });
});

describe("chartEventsToDraw", () => {
  const events = [
    flag("screen", 1_000, "Passed screen"),
    flag("filter", 2_000, "First filter"),
    flag("model", 3_000, "First model"),
    flag("alert", 4_000, "First alert"),
    flag("filter", 5_000, "Second filter"),
    flag("model", 6_000, "Second model"),
    flag("alert", 7_000, "Second alert"),
  ];
  const prefs = {
    kinds: DEFAULT_CHART_EVENT_KINDS,
    first: DEFAULT_CHART_EVENT_FIRST,
  };

  it("drops the screen pass, later filters and models, and keeps every alert", () => {
    expect(chartEventsToDraw(events, prefs).map((e) => e.label)).toEqual([
      "First filter",
      "First model",
      "First alert",
      "Second alert",
    ]);
  });

  it("includes the screen pass once that kind is on", () => {
    const shown = chartEventsToDraw(events, {
      kinds: [...DEFAULT_CHART_EVENT_KINDS, "screen"],
      first: DEFAULT_CHART_EVENT_FIRST,
    });
    expect(shown.map((e) => e.label)).toContain("Passed screen");
    expect(shown.filter((e) => e.kind === "screen")).toHaveLength(1);
  });

  it("keeps later alerts unless only-the-first alert is on", () => {
    const collapsed = chartEventsToDraw(events, {
      kinds: DEFAULT_CHART_EVENT_KINDS,
      first: ["alert", "filter", "model"],
    });
    expect(collapsed.map((e) => e.label)).toEqual(["First filter", "First model", "First alert"]);
  });
});

describe("horizontal and vertical flags", () => {
  const events = [
    flag("screen", 1_000, "Passed screen"),
    flag("alert", 2_000, "Alert"),
    flag("model", 3_000, "Trees"),
  ].map((e, i) => ({ ...e, mcap: (i + 1) * 10_000 }));

  it("drops a kind from both orientations, and brings it back when the kind is on", () => {
    const off = { kinds: DEFAULT_CHART_EVENT_KINDS, first: DEFAULT_CHART_EVENT_FIRST };
    const hidden = chartFlagsToDraw(events, off);
    expect(hidden.map((e) => e.kind)).not.toContain("screen");
    expect(horizontalFlagPrices(hidden, () => null).map((f) => f.event.kind)).not.toContain("screen");
    expect(chartFlagsToDraw(events, off)).toEqual(chartEventsToDraw(events, off));
    // The colour split still uses the hidden pass. The flags and their price lines do not.
    expect(chartColorReference(events)?.kind).toBe("screen");

    const on = { kinds: [...DEFAULT_CHART_EVENT_KINDS, "screen" as const], first: DEFAULT_CHART_EVENT_FIRST };
    const shown = chartFlagsToDraw(events, on);
    expect(shown.map((e) => e.kind)).toContain("screen");
    expect(horizontalFlagPrices(shown, () => null).map((f) => f.event.label)).toContain("Passed screen");
    expect(horizontalFlagPrices(shown, () => null).map((f) => f.price)).toEqual([10_000, 20_000, 30_000]);
  });

  it("collapses only-first onto the price lines as well as the vertical flags", () => {
    const many = [
      flag("filter", 1, "Alert"),
      flag("filter", 2, "Alert again"),
      flag("alert", 3, "Called"),
      flag("model", 4, "Trees"),
      flag("model", 5, "Oaks"),
    ].map((e, i) => ({ ...e, mcap: (i + 1) * 1_000 }));
    const drawn = chartFlagsToDraw(many, {
      kinds: DEFAULT_CHART_EVENT_KINDS,
      first: ["filter", "model"],
    });
    expect(horizontalFlagPrices(drawn, () => null).map((f) => f.event.label)).toEqual([
      "Alert",
      "Called",
      "Trees",
    ]);
    expect(drawn).toEqual(chartEventsToDraw(many, { kinds: DEFAULT_CHART_EVENT_KINDS, first: ["filter", "model"] }));
  });

  it("hides every flag when the master switch is off, and keeps the colour reference", () => {
    const prefs = { on: false, kinds: [...DEFAULT_CHART_EVENT_KINDS, "screen" as const], first: [] as const };
    expect(chartFlagsToDraw(events, prefs)).toEqual([]);
    expect(horizontalFlagPrices(chartFlagsToDraw(events, prefs), () => 1)).toEqual([]);
    expect(chartColorReference(events)?.kind).toBe("screen");
  });

  it("prices a flag from its market cap, then the candle, and skips a missing price", () => {
    expect(chartFlagPrice(12_000, 9_000)).toBe(12_000);
    expect(chartFlagPrice(null, 9_000)).toBe(9_000);
    expect(chartFlagPrice(undefined, null)).toBeNull();
    expect(chartFlagPrice(0, -1)).toBeNull();
    const unpriced = horizontalFlagPrices([{ mcap: null }, { mcap: 4 }], () => null);
    expect(unpriced).toEqual([{ event: { mcap: 4 }, price: 4 }]);
  });

  it("keeps labels, size and emphasis, and a device's old chart prefs", () => {
    expect(DEFAULT_APPEARANCE).toMatchObject({
      chartEvents: true,
      chartEventLabels: true,
      chartEventScale: "m",
      chartEventEmphasis: "brand",
      chartTimeframeMs: null,
      chartLogScale: false,
      chartIndicators: [...DEFAULT_CHART_INDICATORS],
      chartShowDrawings: true,
      chartFibLevels: [...CHART_FIB_LEVELS],
      chartTrendExtend: false,
    });
    const saved = normalizeAppearance({
      chartEventLabels: false,
      chartEventScale: "l",
      chartEventEmphasis: "win",
      chartTimeframeMs: 60_000,
      chartLogScale: true,
      chartIndicators: ["rsi", "vol"],
      chartShowDrawings: false,
      chartFibLevels: [0, 0.5, 1],
      chartTrendExtend: true,
    });
    expect(saved.chartIndicators).toEqual(["vol", "rsi"]);
    expect(saved.chartFibLevels).toEqual([0, 0.5, 1]);
    expect(saved.chartTimeframeMs).toBe(60_000);
    expect(normalizeAppearance({ chartTimeframeMs: 123, chartEventEmphasis: "rainbow" }).chartTimeframeMs).toBe(
      null,
    );
    expect(normalizeAppearance({ chartEventEmphasis: "rainbow" }).chartEventEmphasis).toBe("brand");
    expect(normalizeAppearance({ chartIndicators: ["nope"] }).chartIndicators).toEqual([...DEFAULT_CHART_INDICATORS]);
    expect(eventFlagMetrics("m")).toEqual({ factor: 1, line: 1 });
    expect(eventFlagMetrics("s").factor).toBeLessThan(1);
    expect(eventFlagMetrics("s").line).toBe(1);
    expect(eventFlagMetrics("l").factor).toBeGreaterThan(1);
    expect(eventFlagMetrics("l").line).toBe(2);
    expect([...CHART_TIMEFRAME_MS]).toEqual(TIMEFRAMES.map((f) => f.ms));
    expect([...CHART_FIB_LEVELS]).toEqual([...FIB_LEVELS]);
    expect(eventEmphasisColor("off", { brand: "b", win: "w", loss: "l", mine: "m" })).toBeNull();
    expect(eventEmphasisColor("win", { brand: "b", win: "w", loss: "l", mine: "m" })).toBe("w");
    expect(eventEmphasisColor("brand", { brand: "b", win: "w", loss: "l", mine: "m" })).toBe("b");

    const kept = withPreset(saved, { density: "compact" });
    expect(kept.chartLogScale).toBe(true);
    expect(kept.chartEventLabels).toBe(false);
    expect(kept.chartIndicators).toEqual(["vol", "rsi"]);
    expect(kept.density).toBe("compact");

    const patch = chartPrefsFromDevice({ chartLogScale: false }, (key) =>
      key === "ts.chartIndicators" ? '["ema50"]' : key === "ts.chartLogScale" ? "1" : null,
    );
    expect(patch.chartIndicators).toEqual(["ema50"]);
    expect(patch.chartLogScale).toBeUndefined();
    const local = normalizeAppearance({ chartLogScale: true, chartIndicators: ["rsi"] });
    // The account has not stored these keys yet: this browser's choice stays.
    expect(preferDeviceChartPrefs({}, local).chartLogScale).toBe(true);
    expect(preferDeviceChartPrefs({}, local).chartIndicators).toEqual(["rsi"]);
    // The account stored the default on purpose. It wins over this browser's old value.
    expect(preferDeviceChartPrefs({ chartLogScale: false }, local).chartLogScale).toBe(false);
    expect(preferDeviceChartPrefs({ chartLogScale: false }, local).chartIndicators).toEqual(["rsi"]);
    expect(
      preferDeviceChartPrefs({ chartLogScale: true }, normalizeAppearance({ chartLogScale: false })).chartLogScale,
    ).toBe(true);
    // A parsed account look has every key. The key list says which of those were really stored.
    const parsed = normalizeAppearance({});
    expect(preferDeviceChartPrefs(parsed, local, []).chartLogScale).toBe(true);
    expect(preferDeviceChartPrefs(parsed, local, []).chartIndicators).toEqual(["rsi"]);
    expect(preferDeviceChartPrefs(parsed, local, ["chartLogScale"]).chartLogScale).toBe(false);
    expect(preferDeviceChartPrefs(parsed, local, ["chartLogScale"]).chartIndicators).toEqual(["rsi"]);
  });
});

describe("chartFlagKind", () => {
  it("names the flags the chart already draws", () => {
    expect(chartFlagKind("Alert", "primary", "match")).toBe("filter");
    expect(chartFlagKind("Model alert", "primary", "curated")).toBe("model");
    expect(chartFlagKind("Passed screen", "primary", "stream")).toBe("screen");
    expect(chartFlagKind("Passed screen", "screen")).toBe("screen");
    expect(chartFlagKind("Trees", "model")).toBe("model");
    expect(chartFlagKind("Graduated", "primary", "stream")).toBe("graduation");
    expect(chartFlagKind("Scanned", "primary", "match")).toBe("scanned");
    expect(chartFlagKind("Alert", "primary")).toBe("alert");
  });
});
