import { describe, expect, it } from "vitest";
import { aiBudgetResetsAt, modelPrice, summarizeAiBudget, usageCostUsd } from "./aiSpend.js";

describe("AI pricing", () => {
  it("matches the longest prefix and prices unknown ids as the dearest model", () => {
    expect(modelPrice("claude-opus-5-5").input).toBe(4);
    expect(modelPrice("claude-opus-5").input).toBe(5);
    expect(modelPrice("claude-sonnet-5-5").output).toBe(10);
    expect(modelPrice("claude-haiku-4-5-20251001").input).toBe(1);
    expect(modelPrice("anthropic.claude-opus-5-5").input).toBe(4);
    expect(modelPrice("claude-opus-5-55").input).toBe(10);
    expect(modelPrice("something-new").output).toBe(50);
  });

  it("costs input, cache writes and reads, and output; batches at half", () => {
    const usage = {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_creation_input_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
    };
    // 4 + 0.1 * 4 * 1.25 + 0.2 + 0.1 * 20
    expect(usageCostUsd("claude-opus-5-5", usage)).toBeCloseTo(6.7);
    expect(usageCostUsd("claude-opus-5-5", usage, { batch: true })).toBeCloseTo(3.35);
    // A fallback to a dearer model is charged at the dearer rate.
    expect(usageCostUsd(["claude-opus-5-5", "claude-fable-5-1"], usage)).toBeGreaterThan(6.7);
  });
});

describe("AI budget status", () => {
  const env = { AI_DAILY_BUDGET_USD: 10, AI_BUDGET_REVIEW_RESERVE_PCT: 40 };
  const now = new Date("2026-10-05T15:00:00Z");
  const row = (source: string, costUsd: number, refused = 0, capUsd = 10) => ({
    source,
    costUsd,
    calls: 1,
    refused,
    capUsd,
    updatedAt: now,
  });

  it("is open with nothing spent, and resets at the next UTC midnight", () => {
    const s = summarizeAiBudget(env, "2026-10-05", [], now);
    expect(s).toMatchObject({ spentUsd: 0, remainingUsd: 10, stopped: false, backgroundPaused: false });
    expect(s.resetsAt).toBe("2026-10-06T00:00:00.000Z");
    expect(aiBudgetResetsAt(new Date("2026-10-05T00:00:00Z")).toISOString()).toBe("2026-10-06T00:00:00.000Z");
  });

  it("pauses background work at the reserve and stops at the cap", () => {
    expect(summarizeAiBudget(env, "d", [row("text", 6.5)], now)).toMatchObject({
      backgroundPaused: true,
      stopped: false,
    });
    expect(summarizeAiBudget(env, "d", [row("review", 2), row("text", 1, 3)], now).backgroundPaused).toBe(
      true,
    );
    expect(summarizeAiBudget(env, "d", [row("review", 9.9, 1)], now).stopped).toBe(true);
    expect(summarizeAiBudget(env, "d", [row("review", 10)], now)).toMatchObject({
      stopped: true,
      remainingUsd: 0,
    });
  });

  it("reports the cap the worker enforced, not this process's", () => {
    expect(summarizeAiBudget(env, "d", [row("review", 1, 0, 25)], now).capUsd).toBe(25);
  });
});
