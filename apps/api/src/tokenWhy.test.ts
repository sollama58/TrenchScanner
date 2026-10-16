import { describe, expect, it } from "vitest";
import { gateMiss, topPctOf } from "./tokenWhy.js";

const band = { min: 10_000, max: 500_000 };
const ready = { marketCapUsd: 50_000, buys1h: 80, sells1h: 20, priceChange5mPct: 4, ageMinutes: 30 };

describe("gateMiss", () => {
  it("passes a scan the pre-gate would pass", () => {
    expect(gateMiss(ready, band)).toBeNull();
  });
  it("names the test a scan misses", () => {
    expect(gateMiss({ ...ready, marketCapUsd: 5_000 }, band)).toMatch(/outside the band/);
    expect(gateMiss({ ...ready, ageMinutes: 400 }, band)).toMatch(/hours old/);
    expect(gateMiss({ ...ready, buys1h: 0, sells1h: 0 }, band)).toMatch(/no trades/);
    expect(gateMiss({ ...ready, buys1h: 30, sells1h: 70 }, band)).toMatch(/buys were under/);
    expect(gateMiss({ ...ready, priceChange5mPct: -3 }, band)).toMatch(/falling/);
    expect(gateMiss({ ...ready, ageMinutes: 90, priceChange5mPct: 5 }, band)).toMatch(/wasn't up/);
  });
});

describe("topPctOf", () => {
  const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05];
  it("reads where a score sits among best-first scores", () => {
    expect(topPctOf(scores, 0.95)).toBe(10);
    expect(topPctOf(scores, 0.75)).toBe(30);
    expect(topPctOf(scores, 0.01)).toBe(100);
  });
});
