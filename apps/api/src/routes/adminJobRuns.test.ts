// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AdminJobRuns11111111111111111111111111111111";
const OTHER_WALLET = "NotAdminJobRuns1111111111111111111111111111";
const JOBS = ["wallet-risk", "score-weights", "curator-training", "kol-wallets"];

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

async function call(method: "GET" | "POST", url: string, as: "admin" | "other", payload: object = {}) {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    return await app.inject({
      method,
      url,
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      ...(method === "POST" ? { payload } : {}),
    });
  } finally {
    await app.close();
  }
}

/** A heartbeat row for `job`, as a finished run (or one in flight) leaves it. */
async function beat(job: string, opts: { running?: boolean; error?: string } = {}) {
  const lastRunAt = new Date(Date.now() - 10 * 60_000);
  const meta = opts.running
    ? { durationMs: 4_000, runningSince: new Date().toISOString() }
    : { durationMs: 4_000 };
  await prisma.systemHeartbeat.upsert({
    where: { job },
    update: { lastRunAt, lastSuccessAt: lastRunAt, lastError: opts.error ?? null, meta },
    create: { job, lastRunAt, lastSuccessAt: lastRunAt, lastError: opts.error ?? null, meta },
  });
}

async function clear() {
  await prisma.jobRunRequest.deleteMany({});
  await prisma.curatorRetrainRequest.deleteMany({});
  await prisma.systemHeartbeat.deleteMany({ where: { job: { in: JOBS } } });
}

describe.skipIf(!dbAvailable)("admin run-now", () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
  });
  beforeEach(clear);
  afterAll(async () => {
    if (!dbAvailable) return;
    await clear();
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
  });

  it("refuses a non-admin", async () => {
    expect((await call("GET", "/admin/jobs/run-now", "other")).statusCode).toBe(403);
    expect((await call("POST", "/admin/jobs/wallet-risk/run-now", "other")).statusCode).toBe(403);
    expect(await prisma.jobRunRequest.count()).toBe(0);
  });

  it("lists the runnable jobs with their last run, and the excluded ones with why", async () => {
    await beat("wallet-risk", { error: "boom" });
    const res = await call("GET", "/admin/jobs/run-now", "admin");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.jobs.find((j: { job: string }) => j.job === "wallet-risk")).toMatchObject({
      heavy: false,
      role: "trainer",
      lastError: "boom",
      durationMs: 4_000,
      runningForMs: null,
      pending: null,
    });
    expect(body.excluded.map((e: { job: string }) => e.job)).toEqual(
      expect.arrayContaining(["cleanup", "pipeline-watch", "telegram-dispatch", "scan"]),
    );
  });

  it("queues one run and refuses a second while it waits", async () => {
    await beat("wallet-risk");
    const first = await call("POST", "/admin/jobs/wallet-risk/run-now", "admin");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ queued: true, job: { pending: { requestedBy: ADMIN_WALLET } } });
    const second = await call("POST", "/admin/jobs/wallet-risk/run-now", "admin");
    expect(second.json()).toMatchObject({ queued: false, reason: "already queued" });
    expect(await prisma.jobRunRequest.count({ where: { job: "wallet-risk", startedAt: null } })).toBe(1);
  });

  it("refuses a job that can't be run by hand, saying why", async () => {
    const res = await call("POST", "/admin/jobs/cleanup/run-now", "admin");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/cleanup can't be run by hand/);
    expect((await call("POST", "/admin/jobs/nope/run-now", "admin")).json()).toEqual({
      error: "unknown job",
    });
    expect(await prisma.jobRunRequest.count()).toBe(0);
  });

  it("needs a confirm for a heavy job", async () => {
    await beat("score-weights");
    const bare = await call("POST", "/admin/jobs/score-weights/run-now", "admin");
    expect(bare.statusCode).toBe(400);
    const confirmed = await call("POST", "/admin/jobs/score-weights/run-now", "admin", { confirm: true });
    expect(confirmed.json()).toMatchObject({ queued: true });
  });

  it("does not queue while a run is going, or for a job no worker runs", async () => {
    await beat("wallet-risk", { running: true });
    const running = await call("POST", "/admin/jobs/wallet-risk/run-now", "admin");
    expect(running.json()).toMatchObject({ queued: false, reason: "a run is already going" });
    const never = await call("POST", "/admin/jobs/kol-wallets/run-now", "admin");
    expect(never.json()).toMatchObject({ queued: false, reason: expect.stringMatching(/never run/) });
    expect(await prisma.jobRunRequest.count()).toBe(0);
  });

  it("queues curator training as a retrain request", async () => {
    await beat("curator-training");
    const res = await call("POST", "/admin/jobs/curator-training/run-now", "admin", { confirm: true });
    expect(res.json()).toMatchObject({ queued: true, job: { pending: { requestedBy: ADMIN_WALLET } } });
    expect(await prisma.curatorRetrainRequest.count({ where: { startedAt: null } })).toBe(1);
    expect(await prisma.jobRunRequest.count()).toBe(0);
  });
});
