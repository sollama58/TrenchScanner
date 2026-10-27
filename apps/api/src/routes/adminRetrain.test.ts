// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AdminRetrain1111111111111111111111111111111";
const OTHER_WALLET = "NotAdminRetrain111111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

async function call(method: "GET" | "POST", as: "admin" | "other", payload: object = {}) {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: userIds[as],
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    return await app.inject({
      method,
      url: "/admin/curator/retrain",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
      ...(method === "POST" ? { payload } : {}),
    });
  } finally {
    await app.close();
  }
}

describe.skipIf(!dbAvailable)("admin retrain now", () => {
  beforeAll(async () => {
    await prisma.curatorRetrainRequest.deleteMany({});
    await prisma.systemHeartbeat.deleteMany({ where: { job: "curator-training" } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.curatorRetrainRequest.deleteMany({});
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
  });

  it("refuses a non-admin", async () => {
    expect((await call("GET", "other")).statusCode).toBe(403);
    expect((await call("POST", "other")).statusCode).toBe(403);
    expect(await prisma.curatorRetrainRequest.count()).toBe(0);
  });

  it("queues one request and refuses a second while it waits", async () => {
    const first = await call("POST", "admin");
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ queued: true, pending: { requestedBy: ADMIN_WALLET } });

    const second = await call("POST", "admin");
    expect(second.json()).toMatchObject({ queued: false, reason: "already queued" });
    expect(await prisma.curatorRetrainRequest.count({ where: { startedAt: null } })).toBe(1);

    // The trainer marks it started when its run begins; the panel then shows nothing queued.
    await prisma.curatorRetrainRequest.updateMany({ data: { startedAt: new Date() } });
    const state = await call("GET", "admin");
    expect(state.json()).toMatchObject({ pending: null, last: { requestedBy: ADMIN_WALLET } });
  });

  it("does not queue while a training run is going", async () => {
    await prisma.systemHeartbeat.upsert({
      where: { job: "curator-training" },
      update: { meta: { runningSince: new Date().toISOString() } },
      create: {
        job: "curator-training",
        lastRunAt: new Date(),
        meta: { runningSince: new Date().toISOString() },
      },
    });
    try {
      const res = await call("POST", "admin");
      expect(res.json()).toMatchObject({ queued: false, reason: "a training run is already going" });
    } finally {
      await prisma.systemHeartbeat.deleteMany({ where: { job: "curator-training" } });
    }
  });

  it("stops a run in flight on request, once, and shows where the run had got to", async () => {
    await prisma.curatorRetrainRequest.deleteMany({});
    // Hung: its step has not moved for 50 minutes.
    const since = new Date(Date.now() - 60 * 60_000);
    const meta = {
      intervalMs: 6 * 3_600_000,
      runningSince: since.toISOString(),
      runningStagesMs: { "load rows": 40_000 },
      runningStep: "exams: examining Trees (5 of up to 24)",
      runningStepAt: new Date(Date.now() - 50 * 60_000).toISOString(),
    };
    await prisma.systemHeartbeat.upsert({
      where: { job: "curator-training" },
      update: { lastRunAt: new Date(since.getTime() - 60_000), meta },
      create: { job: "curator-training", lastRunAt: new Date(since.getTime() - 60_000), meta },
    });
    try {
      const state = (await call("GET", "admin")).json();
      expect(state).toMatchObject({
        pending: null,
        job: {
          hung: true,
          runningStep: { step: "exams: examining Trees (5 of up to 24)" },
          runningStagesMs: { "load rows": 40_000 },
        },
      });

      const stop = await call("POST", "admin", { stop: true });
      expect(stop.json()).toMatchObject({
        queued: true,
        stopping: true,
        pending: { requestedBy: ADMIN_WALLET },
      });
      const again = await call("POST", "admin", { stop: true });
      expect(again.json()).toMatchObject({ queued: false, reason: "a stop is already requested" });
      expect(await prisma.curatorRetrainRequest.count({ where: { startedAt: null } })).toBe(1);
    } finally {
      await prisma.curatorRetrainRequest.deleteMany({});
      await prisma.systemHeartbeat.deleteMany({ where: { job: "curator-training" } });
    }
  });
});
