// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, loadEnv, type Env } from "@trenchscanner/core";
import { JobFailure } from "../scheduler.js";
import {
  findProblems,
  notificationText,
  restartStep,
  runPipelineWatch,
  WATCH_ANNOUNCER,
  WATCHED_JOBS,
  type FlowCheck,
} from "./pipelineWatchJob.js";

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

describe("pipeline watch: restarting on a long stall", () => {
  it("warns at 5 minutes, warns again and restarts at 9, then holds off", () => {
    expect(restartStep(null, 0, null, NOW)).toBe("none");
    expect(restartStep(3 * MIN, 0, null, NOW)).toBe("none");
    expect(restartStep(5 * MIN, 0, null, NOW)).toBe("warn5");
    expect(restartStep(6 * MIN, 1, null, NOW)).toBe("none");
    expect(restartStep(9 * MIN, 1, null, NOW)).toBe("warn1");
    // A stall first seen late still gets the last warning before its restart.
    expect(restartStep(9 * MIN, 0, null, NOW)).toBe("warn1");
    // Restart pending: nothing more.
    expect(restartStep(10 * MIN, 2, NOW, NOW)).toBe("none");
  });

  it("restarts at most once an hour, and says so once when it can't", () => {
    // Still stalled after the restart: notify, don't restart again.
    expect(restartStep(15 * MIN, 2, NOW - 5 * MIN, NOW)).toBe("capped");
    expect(restartStep(16 * MIN, -1, NOW - 6 * MIN, NOW)).toBe("none");
    // A new stall 30 minutes after the last restart.
    expect(restartStep(5 * MIN, 0, NOW - 30 * MIN, NOW)).toBe("capped");
    // An hour on, it may restart again.
    expect(restartStep(9 * MIN, 1, NOW - 61 * MIN, NOW)).toBe("warn1");
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("pipeline watch against the database", () => {
  const env: Env = dbAvailable ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: "" } : (undefined as never);
  const TAG = `pw-test-${Date.now()}`;
  /** The alert-path jobs ran just now (other tests leave old heartbeats behind). */
  const jobsRanAt = (at: number) =>
    Promise.all(
      WATCHED_JOBS.map((job) =>
        prisma.systemHeartbeat.upsert({
          where: { job },
          create: { job, lastRunAt: new Date(at) },
          update: { lastRunAt: new Date(at), meta: {} },
        }),
      ),
    );

  beforeEach(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.systemHeartbeat.deleteMany({ where: { job: "pipeline-watch" } });
    await prisma.announcement.deleteMany({ where: { createdBy: WATCH_ANNOUNCER } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.systemHeartbeat.deleteMany({ where: { job: "pipeline-watch" } });
    await prisma.announcement.deleteMany({ where: { createdBy: WATCH_ANNOUNCER } });
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
    await jobsRanAt(now);
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

  it("tells only the admins' private chats, never a group an admin linked", async () => {
    const now = Date.now();
    const wallet = `${TAG}-admin`;
    const privateChat = BigInt(Date.now());
    const user = await prisma.user.create({ data: { walletAddress: wallet } });
    await prisma.telegramChat.createMany({
      data: [
        { chatId: privateChat, kind: "private", userId: user.id },
        { chatId: -privateChat, kind: "supergroup", userId: user.id },
      ],
    });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-c`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(now - 60 * MIN),
      },
    });
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: `${TAG}-b` } });
    await jobsRanAt(now);
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, result: {} });
    await runPipelineWatch(
      { ...env, ADMIN_WALLET_ADDRESSES: wallet },
      { now, telegram: { sendMessage } },
    ).catch(() => undefined);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toBe(privateChat);
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("warns visitors, restarts once, and takes the banner down when it flows again", async () => {
    const t0 = Date.now();
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-d`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(t0 - 60 * MIN),
      },
    });
    const restart = vi.fn();
    // The scheduler stores a failed run's meta on the heartbeat; do the same between runs.
    const run = async (now: number) => {
      await jobsRanAt(now);
      const out = await runPipelineWatch(env, { now, restart }).catch((e: unknown) => e);
      const meta = out instanceof JobFailure ? out.meta : (out as Record<string, unknown>);
      await prisma.systemHeartbeat.upsert({
        where: { job: "pipeline-watch" },
        create: { job: "pipeline-watch", lastRunAt: new Date(now), meta: meta as object },
        update: { lastRunAt: new Date(now), meta: meta as object },
      });
      return meta;
    };
    const banners = () =>
      prisma.announcement.findMany({ where: { createdBy: WATCH_ANNOUNCER, endedAt: null } });

    await run(t0);
    expect(await banners()).toHaveLength(0);
    await run(t0 + 5 * MIN);
    expect((await banners()).map((b) => b.message)).toEqual([expect.stringContaining("about 5 minutes")]);
    expect(restart).not.toHaveBeenCalled();
    await run(t0 + 9 * MIN);
    expect(restart).toHaveBeenCalledTimes(1);
    expect((await banners()).some((b) => b.message.includes("about a minute"))).toBe(true);
    // Still stalled after the restart: no second one within the hour.
    expect(await run(t0 + 14 * MIN)).toMatchObject({ warned: -1 });
    expect(restart).toHaveBeenCalledTimes(1);

    await prisma.tokenNarrative.create({
      data: {
        mintAddress: `${TAG}-e`,
        depth: "basic",
        status: "complete",
        checkedAt: new Date(t0 + 15 * MIN),
      },
    });
    expect(await run(t0 + 16 * MIN)).toMatchObject({ stalled: 0, warned: 0 });
    expect(await banners()).toHaveLength(0);
  });
});
