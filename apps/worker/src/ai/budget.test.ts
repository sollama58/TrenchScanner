// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { prisma, loadEnv, readAiBudget, type CurationDecision, type Env } from "@trenchscanner/core";
import {
  aiBudgetRoomUsd,
  failedCallCostUsd,
  reserveAiSpend,
  resetAiBudget,
  settleAiSpend,
} from "./budget.js";
import { reviewPriority } from "./reviewer.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
// A day of its own, so the ledger rows here never mix with a real day's.
const DAY = "2001-02-03";

describe.skipIf(!dbAvailable)("daily AI budget", () => {
  const base = dbAvailable ? loadEnv() : (undefined as never);
  const env: Env = dbAvailable ? { ...base, AI_DAILY_BUDGET_USD: 1, AI_BUDGET_REVIEW_RESERVE_PCT: 40 } : base;

  const clean = () => prisma.aiSpend.deleteMany({ where: { day: DAY } });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${DAY}T12:00:00Z`));
    resetAiBudget();
    await clean();
  });
  afterEach(() => vi.useRealTimers());
  afterAll(async () => {
    if (dbAvailable) await clean();
  });

  it("reserves, trues up, and refuses the call that would cross the cap", async () => {
    const a = await reserveAiSpend(env, "review", 0.5, "live");
    expect(a).not.toBeNull();
    await settleAiSpend(a!, 0.7, "review");
    // 0.7 spent: a 0.4 call would make 1.1 > 1.
    expect(await reserveAiSpend(env, "review", 0.4, "live")).toBeNull();
    expect(await reserveAiSpend(env, "review", 0.3, "live")).toBeNull(); // held after a refusal
    const status = await readAiBudget(env);
    expect(status.day).toBe(DAY);
    expect(status.spentUsd).toBeCloseTo(0.7);
    expect(status.stopped).toBe(true);
    expect(status.bySource).toEqual([{ source: "review", costUsd: 0.7, calls: 1, refused: 1 }]);
  });

  it("keeps the reserve for high-conviction reviews: background work stops at the cap less the reserve", async () => {
    expect(await reserveAiSpend(env, "text", 0.5, "background")).not.toBeNull();
    expect(await reserveAiSpend(env, "text", 0.2, "background")).toBeNull(); // 0.7 > 0.6
    expect(await aiBudgetRoomUsd(env, "background")).toBeCloseTo(0.1);
    // The live reviewer still has the rest of the cap.
    expect(await reserveAiSpend(env, "review", 0.4, "live")).not.toBeNull();
    const status = await readAiBudget(env);
    expect(status.backgroundPaused).toBe(true);
    expect(status.stopped).toBe(false);
  });

  it("refunds a call the API rejected, but keeps the estimate for one that timed out", async () => {
    const r = await reserveAiSpend(env, "review", 0.25, "live");
    const rejected = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    expect(failedCallCostUsd(rejected, r!)).toBe(0);
    expect(failedCallCostUsd(new Anthropic.APIConnectionTimeoutError(), r!)).toBe(0.25);
    await settleAiSpend(r!, 0);
    expect((await readAiBudget(env)).spentUsd).toBe(0);
  });

  it("calls nothing with a cap of 0", async () => {
    expect(await reserveAiSpend({ ...env, AI_DAILY_BUDGET_USD: 0 }, "review", 0.01, "live")).toBeNull();
  });
});

describe("which picks the reviewer is pointed at", () => {
  const env = { AI_REVIEW_STANDARD_PICKS: "spare" } as Env;
  const pick = (tier?: "high" | "standard") =>
    ({ curate: true, confidence: 70, reasons: [], tier }) as unknown as CurationDecision;

  it("reviews high-conviction picks from the whole budget and standard ones from what's spare", () => {
    expect(reviewPriority(pick("high"), env)).toBe("live");
    expect(reviewPriority(pick(), env)).toBe("live");
    expect(reviewPriority(pick("standard"), env)).toBe("background");
    expect(reviewPriority(pick("standard"), { ...env, AI_REVIEW_STANDARD_PICKS: "never" })).toBeNull();
  });
});
