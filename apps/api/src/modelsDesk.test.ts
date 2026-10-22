import { describe, expect, it } from "vitest";
import { labelRuleSummary, readExam, trainingScheduleView } from "./modelsDesk.js";

describe("readExam", () => {
  it("reads a stored exam and leaves missing optional fields empty", () => {
    expect(
      readExam({
        calls: 20,
        graded: 10,
        wins: 4,
        goals: 1,
        sumLabel: 8,
        tenX: 1,
        simCalls: 10,
        sumSimReturnPct: 250,
        sumRun: 12,
      }),
    ).toEqual({
      calls: 20,
      graded: 10,
      wins: 4,
      goals: 1,
      tenX: 1,
      avgDoublings: 0.8,
      avgRunDoublings: 1.2,
      simCalls: 10,
      avgReturnPct: 25,
    });
  });

  it("does not invent a return or a peak the exam did not store", () => {
    expect(readExam({ calls: 4, graded: 4, wins: 1, goals: 0 })).toMatchObject({
      tenX: null,
      avgDoublings: null,
      avgRunDoublings: null,
      avgReturnPct: null,
      simCalls: null,
    });
  });

  it("returns null for an empty or unusable exam, and does not divide by zero", () => {
    expect(readExam(null)).toBeNull();
    expect(readExam([])).toBeNull();
    expect(readExam({ calls: 1 })).toBeNull();
    expect(
      readExam({ calls: 0, graded: 0, wins: 0, goals: 0, sumLabel: 3, simCalls: 0, sumSimReturnPct: 10 }),
    ).toMatchObject({
      avgDoublings: null,
      avgReturnPct: null,
    });
  });
});

describe("trainingScheduleView", () => {
  const last = "2026-10-22T12:00:00.000Z";
  const hour = 3_600_000;

  it("names the slot one interval after the last heartbeat", () => {
    const view = trainingScheduleView({
      nowMs: Date.parse("2026-10-22T18:00:00.000Z"),
      intervalMs: 12 * hour,
      lastRunAt: last,
      running: false,
      pending: false,
    });
    expect(view.nextRunAt).toBe("2026-10-23T00:00:00.000Z");
    expect(view.basis).toMatch(/one interval after the last heartbeat/i);
  });

  it("keeps the passed slot and says the delay is not visible", () => {
    const view = trainingScheduleView({
      nowMs: Date.parse("2026-10-23T02:00:00.000Z"),
      intervalMs: 12 * hour,
      lastRunAt: last,
      running: false,
      pending: false,
    });
    expect(view.nextRunAt).toBe("2026-10-23T00:00:00.000Z");
    expect(view.basis).toMatch(/slot has passed/i);
  });

  it("does not invent a finish time while a run is going or a retrain is queued", () => {
    expect(
      trainingScheduleView({ nowMs: 0, intervalMs: hour, lastRunAt: last, running: true, pending: false })
        .nextRunAt,
    ).toBeNull();
    expect(
      trainingScheduleView({ nowMs: 0, intervalMs: hour, lastRunAt: last, running: false, pending: true })
        .basis,
    ).toMatch(/queued/i);
  });

  it("says when the next run cannot be known", () => {
    expect(
      trainingScheduleView({ nowMs: 0, intervalMs: hour, lastRunAt: null, running: false, pending: false })
        .basis,
    ).toMatch(/no curator-training heartbeat/i);
    expect(
      trainingScheduleView({ nowMs: 0, intervalMs: null, lastRunAt: last, running: false, pending: false })
        .basis,
    ).toMatch(/interval is not/i);
  });
});

describe("labelRuleSummary", () => {
  it("states the fit rule and that it is not stored per model", () => {
    const text = labelRuleSummary({ fitRule: 4, fineTickRule: 5, reportedRule: 3, excludeFineTick: false });
    expect(text).toMatch(/rule 4 or newer/);
    expect(text).toMatch(/Rule 5/);
    expect(text).toMatch(/rule 3 and newer/);
    expect(text).toMatch(/not stored on the model row/);
  });

  it("says when fine-tick rows are held out", () => {
    expect(labelRuleSummary({ fitRule: 4, fineTickRule: 5, reportedRule: 3, excludeFineTick: true })).toMatch(
      /excluded/,
    );
  });
});
