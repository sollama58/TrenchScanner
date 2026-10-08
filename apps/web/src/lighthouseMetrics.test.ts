import { describe, expect, it } from "vitest";
import type { LighthouseHistory, LighthouseSums } from "./api";
import {
  breakdownSeries,
  canAdd,
  defaultPanels,
  delta,
  hasPanel,
  historyCsv,
  isPanel,
  metricById,
  metricSeries,
  panelTitle,
  unitsOf,
} from "./lighthouseMetrics";

const sums = (
  over: Partial<LighthouseSums["screened"]> = {},
  alerts: Partial<LighthouseSums["alerts"]> = {},
): LighthouseSums => ({
  screened: {
    calls: 10,
    graded: 8,
    won2x: 4,
    won4x: 2,
    won10x: 1,
    tenXGraded: 5,
    returnN: 8,
    returnSum: 120,
    ...over,
  },
  reads: {
    total: 20,
    described: 18,
    deep: 9,
    failed: 2,
    referentConfidenceSum: 9,
    referentConfidenceN: 18,
    xFitSum: 4.5,
    xFitN: 9,
    copiesRecent: 3,
    copiesAnswered: 12,
    trendMatched: 2,
    trendAnswered: 8,
  },
  alerts: {
    total: 4,
    described: 3,
    graded: 2,
    won2x: 1,
    won4x: 0,
    won10x: 0,
    returnN: 2,
    returnSum: -30,
    ...alerts,
  },
});

const history = (): LighthouseHistory => ({
  window: { days: 7, since: "2026-10-01T00:00:00.000Z", bucket: "day", dimension: "category" },
  coverage: {
    oldestHour: "2026-09-01T00:00:00.000Z",
    newestHour: "2026-10-07T12:00:00.000Z",
    summedAt: "2026-10-07T12:05:00.000Z",
  },
  exitPlan: "half at 2x",
  totals: sums(),
  previous: sums({ won2x: 2 }),
  series: [
    { at: "2026-10-06T00:00:00.000Z", ...sums() },
    { at: "2026-10-07T00:00:00.000Z", ...sums({ graded: 0, won2x: 0, returnN: 0, returnSum: 0 }) },
  ],
  labels: {
    dimension: "category",
    bucket: "day",
    top: ["animal", "tech"],
    buckets: [
      {
        at: "2026-10-06T00:00:00.000Z",
        rows: [
          { label: "animal", count: 6, alerts: 6, graded: 6, won2x: 3, won4x: 0, won10x: 0 },
          { label: "tech", count: 2, alerts: 2, graded: 2, won2x: 2, won4x: 0, won10x: 0 },
          { label: "other", count: 2, alerts: 0, graded: 0, won2x: 0, won4x: 0, won10x: 0 },
        ],
      },
      { at: "2026-10-07T00:00:00.000Z", rows: [] },
    ],
  },
});

describe("lighthouse metrics", () => {
  it("computes rates from sums and withholds them with nothing graded", () => {
    const s = sums();
    expect(metricById("field2x").value(s)).toBe(50);
    expect(metricById("field10x").value(s)).toBe(20);
    expect(metricById("fieldReturn").value(s)).toBe(15);
    expect(metricById("storyConfidence").value(s)).toBe(50);
    expect(metricById("copycatShare").value(s)).toBe(25);
    expect(metricById("calls2x").value(s)).toBe(50);
    // 10x is measured over the calls whose 10x window has closed, not every graded call.
    expect(metricById("calls10x").value(sums({}, { won10x: 1, tenXGraded: 1 }))).toBe(100);
    expect(metricById("calls10x").value(sums({}, { won10x: 1 }))).toBe(50);
    expect(metricById("field2x").value(sums({ graded: 0 }))).toBeNull();
    expect(metricById("fieldReturn").value(sums({ returnN: 0 }))).toBeNull();
  });

  it("draws a metrics panel against the targets", () => {
    const series = metricSeries(history(), ["field2x", "coinsRead"], { hitRate2xPct: 75, hitRate4xPct: 50 });
    expect(series.map((s) => s.values)).toEqual([
      [50, null],
      [18, 18],
    ]);
    expect(series[0]).toMatchObject({ slot: 1, unit: "pct", target: 75 });
    expect(series[1]).toMatchObject({ slot: 2, unit: "count", target: undefined });
  });

  it("lets two scales share a chart but not three, and at most five colors", () => {
    expect(unitsOf(["field2x", "coinsRead"])).toEqual(["pct", "count"]);
    expect(canAdd(["field2x", "coinsRead"], "fieldReturn")).toBe(false);
    expect(canAdd(["field2x", "coinsRead"], "calls2x")).toBe(true);
    expect(canAdd(["field2x", "field4x", "field10x", "calls2x", "calls4x"], "calls10x")).toBe(false);
    expect(isPanel({ id: "a", kind: "line", metrics: ["field2x", "coinsRead", "fieldReturn"] })).toBe(false);
    expect(isPanel({ id: "a", kind: "bars", breakdown: "share", dimension: "flag" })).toBe(true);
    expect(isPanel({ id: "a", kind: "bars", breakdown: "share" })).toBe(false);
    expect(isPanel({ id: "a", kind: "pie", metrics: [] })).toBe(false);
    expect(defaultPanels().every(isPanel)).toBe(true);
  });

  it("knows when a chart is already on the page, so it is not added twice", () => {
    const panels = defaultPanels();
    expect(hasPanel(panels, { id: "x", kind: "bars", metrics: ["field2x", "field4x", "field10x"] })).toBe(
      true,
    );
    expect(hasPanel(panels, { id: "x", kind: "line", metrics: ["field4x", "field2x", "field10x"] })).toBe(
      false,
    );
    expect(hasPanel(panels, { id: "x", kind: "line", breakdown: "count", dimension: "category" })).toBe(true);
    expect(hasPanel(panels, { id: "x", kind: "bars", breakdown: "count", dimension: "flag" })).toBe(false);
    expect(hasPanel(panels, { id: "x", kind: "bars", breakdown: "share", dimension: "category" })).toBe(
      false,
    );
    expect(hasPanel([], { id: "x", kind: "line", metrics: [] })).toBe(false);
    expect(defaultPanels().every((p, i, all) => all.findIndex((q) => hasPanel([q], p)) === i)).toBe(true);
  });

  it("breaks a dimension down per label, with thin 2x rates withheld", () => {
    const h = history();
    const counts = breakdownSeries(h, "count");
    expect(counts.map((s) => [s.id, s.slot, s.values])).toEqual([
      ["animal", 1, [6, 0]],
      ["tech", 2, [2, 0]],
      ["other", 0, [2, 0]],
    ]);
    // An older API without the coins read: the label total stands in.
    const share = breakdownSeries(h, "share");
    expect(share[0]!.values).toEqual([60, null]);
    // Of the coins read, not of the labels: 6 of 40 coins, whatever the other 30 carried.
    h.labels.buckets[0]!.described = 40;
    h.labels.buckets[1]!.described = 0;
    expect(breakdownSeries(h, "share")[0]!.values).toEqual([15, null]);
    const rates = breakdownSeries(h, "rate2x");
    // tech has 2 graded calls: too few for a verdict; other has none and so no series.
    expect(rates.map((s) => [s.id, s.values])).toEqual([
      ["animal", [50, null]],
      ["tech", [null, null]],
    ]);
  });

  it("names panels and writes the window as CSV", () => {
    expect(panelTitle({ id: "a", kind: "bars", breakdown: "count", dimension: "flag" })).toBe(
      "Coins read by flag raised",
    );
    expect(panelTitle({ id: "a", kind: "line", metrics: ["field2x", "calls2x"] })).toBe(
      "2x rate, screened field · 2x rate, model calls",
    );
    const csv = historyCsv(history());
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^bucket_start_utc,field2x,/);
    expect(lines[0]).not.toContain("deep");
    expect(lines[1]).toMatch(/^2026-10-06T00:00:00.000Z,50,25,20,15,10,8,/);
    // Nothing graded on the 7th: the rate cells are empty, not zero.
    expect(lines[2]!.split(",")[1]).toBe("");
  });

  it("measures a KPI against the span before", () => {
    const h = history();
    expect(delta(metricById("field2x"), h.totals, h.previous)).toBe(25);
    expect(delta(metricById("field2x"), h.totals, null)).toBeNull();
  });
});
