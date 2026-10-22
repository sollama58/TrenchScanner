// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AdminDesk1111111111111111111111111111111111";
const OTHER_WALLET = "NotAdminDesk1111111111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
let adminId = "";
let otherId = "";

async function call(as: "admin" | "other") {
  const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
  const app = await buildServer(env);
  try {
    const cookie = await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
      userId: as === "admin" ? adminId : otherId,
      walletAddress: as === "admin" ? ADMIN_WALLET : OTHER_WALLET,
    });
    return await app.inject({
      method: "GET",
      url: "/admin/models/desk",
      cookies: { [SESSION_COOKIE_NAME]: cookie },
    });
  } finally {
    await app.close();
  }
}

describe.skipIf(!dbAvailable)("admin models desk", () => {
  it("is admin-only and reports the trainer spec without inventing a run", async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    adminId = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    otherId = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
    try {
      expect((await call("other")).statusCode).toBe(403);
      const res = await call("admin");
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.caps.maxRows).toEqual(expect.any(Number));
      expect(body.caps.windowDays).toEqual(expect.any(Number));
      expect(body.labels.summary).toMatch(/not stored on the model row/);
      expect(body.labels.fitRule).toEqual(expect.any(Number));
      expect(Array.isArray(body.roster)).toBe(true);
      expect(body.roster.some((r: { id: string; enabled: boolean }) => r.id === "rules" && r.enabled)).toBe(
        true,
      );
      expect(body.schedule.nextRunBasis).toEqual(expect.any(String));
      expect(body.aiBudget.capUsd).toEqual(expect.any(Number));
      expect(body.runHistoryNote).toMatch(/heartbeat/);
      expect(Array.isArray(body.stages)).toBe(true);
      expect(body.stages).toContain("exams");
    } finally {
      await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    }
  });
});
