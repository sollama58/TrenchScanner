import { describe, expect, it } from "vitest";
import { activePeakPct, alertFor, nowMcapFor } from "./telegramBoards.js";

describe("alertFor", () => {
  const sentAt = new Date("2026-10-10T22:00:00Z");
  const at = (r: { at: Date }) => r.at;
  const row = (tokenId: string, minutesBefore: number) => ({
    tokenId,
    at: new Date(sentAt.getTime() - minutesBefore * 60_000),
  });

  it("picks the earliest alert on the token that the send could have carried", () => {
    const rows = [row("a", 1), row("a", 6), row("b", 3)];
    expect(alertFor(rows, at, "a", sentAt)).toBe(rows[1]);
  });

  it("passes over alerts too old to have been sent, or raised after the send", () => {
    const rows = [row("a", 60), row("a", -5)];
    expect(alertFor(rows, at, "a", sentAt)).toBeUndefined();
  });
});

describe("nowMcapFor", () => {
  const calledAt = new Date("2026-10-12T12:00:00Z");
  const reading = (secondsAfter: number) => ({
    marketCapUsd: 47_500,
    at: new Date(calledAt.getTime() + secondsAfter * 1000),
  });

  it("leaves out a model call's readings from its first minute", () => {
    // CASINO: called at $11.4k; the reading 14 s later still showed the $47.5k from before it.
    expect(nowMcapFor({ calledAt }, reading(14))).toBeNull();
    expect(nowMcapFor({ calledAt }, reading(60))).toBe(47_500);
  });

  it("shows any reading on a filter alert", () => {
    expect(nowMcapFor({ calledAt: null }, reading(14))).toBe(47_500);
    expect(nowMcapFor({ calledAt: null }, undefined)).toBeNull();
  });
});

describe("activePeakPct", () => {
  it("raises the Peak to a Now above it", () => {
    expect(activePeakPct(50, 10_000, 40_000)).toBe(300);
    expect(activePeakPct(null, 10_000, 15_000)).toBe(50);
  });

  it("keeps the recorded Peak when Now is below it or unknown", () => {
    expect(activePeakPct(300, 10_000, 15_000)).toBe(300);
    expect(activePeakPct(20, 10_000, 8_000)).toBe(20);
    expect(activePeakPct(20, 10_000, null)).toBe(20);
    expect(activePeakPct(20, null, 50_000)).toBe(20);
  });
});
