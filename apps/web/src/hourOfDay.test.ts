import { describe, expect, it } from "vitest";
import { hourSpan, hourStats, localHours, niceCeil, type HourOfDayData, type HourRow } from "./hourOfDay";

const row = (hour: number, over: Partial<HourRow> = {}): HourRow => ({
  hour,
  calls: 100,
  graded: 100,
  hit2xPct: 10,
  avgReturnPct: -5,
  returnGraded: 100,
  ...over,
});

describe("niceCeil", () => {
  it("rounds axis tops up to a round number", () => {
    expect(niceCeil(915)).toBe(1000);
    expect(niceCeil(26.2)).toBe(30);
    expect(niceCeil(16)).toBe(20);
    expect(niceCeil(20)).toBe(20);
    expect(niceCeil(0)).toBe(1);
  });
});

describe("hourSpan", () => {
  it("writes a shared AM/PM once", () => {
    expect(hourSpan(1, 0, "en-US")).toBe("1–2 AM");
    expect(hourSpan(11, 0, "en-US")).toBe("11 AM–12 PM");
    expect(hourSpan(23, 0, "en-US")).toBe("11 PM–12 AM");
  });
  it("keeps the minutes when hours start part-way through", () => {
    expect(hourSpan(5, 30, "en-US")).toBe("05:30–06:30");
  });
});

describe("localHours", () => {
  const h = (timeZone?: string): HourOfDayData => ({
    timeZone,
    days: 3,
    hours: Array.from({ length: 24 }, (_, i) => row(i, { calls: i })),
  });
  it("keeps hours the API grouped in the reader's zone", () => {
    const { hours, minutes } = localHours(h("America/New_York"), {
      offsetHours: -4,
      minutes: 0,
      name: "EDT",
    });
    expect(hours[5]!.calls).toBe(5);
    expect(minutes).toBe(0);
  });
  it("shifts UTC hours onto the local clock", () => {
    const { hours, minutes } = localHours(h("UTC"), { offsetHours: 5, minutes: 30, name: "IST" });
    expect(hours[5]!.calls).toBe(0);
    expect(minutes).toBe(30);
  });
});

describe("hourStats", () => {
  it("weights the day by what each hour graded and skips thin hours for the best", () => {
    const hours = Array.from({ length: 24 }, (_, i) => row(i));
    hours[2] = row(2, { hit2xPct: 30, graded: 300, calls: 300 });
    hours[3] = row(3, { hit2xPct: 90, graded: 5, avgReturnPct: 80, returnGraded: 5 });
    hours[4] = row(4, { avgReturnPct: 12 });
    const st = hourStats(hours);
    expect(st.best2x?.hour).toBe(2);
    expect(st.bestReturn?.hour).toBe(4);
    expect(st.busiest?.hour).toBe(2);
    expect(st.calls).toBe(100 * 21 + 300 + 100 + 100);
    expect(st.hit2xPct).toBeCloseTo((10 * 2200 + 30 * 300 + 90 * 5) / 2505);
  });
});
