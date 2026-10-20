import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, normalizeAppearance, withPreset } from "./appearance";
import {
  DEFAULT_CHART_EVENT_FIRST,
  DEFAULT_CHART_EVENT_KINDS,
  chartEventsToDraw,
  chartFlagKind,
  type ChartEventKind,
} from "./chartEvents";

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
