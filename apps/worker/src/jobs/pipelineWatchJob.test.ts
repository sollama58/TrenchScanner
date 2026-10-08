// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, type Env } from "@trenchscanner/core";
import { JobFailure } from "../scheduler.js";
import { findProblems, notificationText, runPipelineWatch, type FlowCheck } from "./pipelineWatchJob.js";

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 8, 13, 30);

const flow = (key: string, recent: number, baseline: number): FlowCheck => ({
  key,
  label: key,
  windowMinutes: 15,
  recent,
  baseline,
});

describe("pipeline watch: what counts as stalled", () => {
  it("flags a flow that produced nothing in its window but did the day before", () => {
    const problems = findProblems([flow("tokensage", 0, 4_000), flow("decisions", 12, 900)], [], NOW);
    expect(problems.map((p) => p.key)).toEqual(["tokensage"]);
  });

  it("leaves a flow that isn't in use alone", () => {
    expect(findProblems([flow("tokensage", 0, 0)], [], NOW)).toEqual([]);
  });

  it("flags an alert-path job that stopped running or whose run never returned", () => {
    const problems = findProblems(
      [],
      [
        { job: "scan", lastRunAt: new Date(NOW - 30 * MIN), intervalMs: 30_000, runningSince: null },
        { job: "fast-match", lastRunAt: new Date(NOW - MIN), intervalMs: 15_000, runningSince: null },
        {
          job: "telegram-dispatch",
          lastRunAt: new Date(NOW - MIN),
          intervalMs: 10_000,
          runningSince: new Date(NOW - 20 * MIN),
        },
        // Never ran (not deployed here): nothing to judge.
        { job: "candidate-watch", lastRunAt: null, intervalMs: null, runningSince: null },
      ],
      NOW,
    );
    expect(problems.map((p) => p.key)).toEqual(["job:scan", "job:telegram-dispatch"]);
  });

  it("flags Telegram delivery when a linked chat's cursor falls behind", () => {
    expect(findProblems([], [], NOW, new Date(NOW - 2 * MIN))).toEqual([]);
    expect(findProblems([], [], NOW, new Date(NOW - 40 * MIN)).map((p) => p.key)).toEqual(["telegram"]);
  });

  it("words the notice: what stalled, what recovered, what is still out", () => {
    const text = notificationText(
      [{ key: "tokensage", text: "TokenSage reads stored: none in the last 15 min <x>" }],
      ["decisions"],
      [
        { key: "tokensage", text: "..." },
        { key: "job:scan", text: "..." },
      ],
    );
    expect(text).toContain("pipeline stalled");
    expect(text).toContain("&lt;x&gt;");
    expect(text).toContain("Flowing again:</b> decisions");
    expect(text).toContain("Still stalled: job:scan");
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("pipeline watch against the database", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: "" } : (undefined as never);
  const TAG = `pw-test-${Date.now()}`;

  beforeEach(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job: "pipeline-watch" } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.systemHeartbeat.deleteMany({ where: { job: "pipeline-watch" } });
  });

  it("fails the run naming the stalled flow, and stays quiet once it flows again", async () => {
    const now = Date.now();
    // A read stored an hour ago and none since: TokenSage reads have stopped.
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-a`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(now - 60 * MIN),
      },
    });
    const sendMessage = vi.fn();
    const err = await runPipelineWatch(env, { now, telegram: { sendMessage } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JobFailure);
    expect((err as JobFailure).message).toContain("TokenSage reads stored");
    expect((err as JobFailure).meta).toMatchObject({ stalledKeys: expect.stringContaining("tokensage") });
    // No admin wallets configured: nobody to tell.
    expect(sendMessage).not.toHaveBeenCalled();

    await prisma.tokenNarrative.create({
      data: { mintAddress: `${TAG}-b`, depth: "basic", status: "complete", checkedAt: new Date(now - MIN) },
    });
    const again = await runPipelineWatch(env, { now, telegram: { sendMessage } }).catch((e: unknown) => e);
    const keys =
      again instanceof JobFailure
        ? String(again.meta.stalledKeys)
        : String((again as { stalledKeys?: string }).stalledKeys);
    expect(keys).not.toContain("tokensage");
  });
});
