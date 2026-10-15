// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AdminFilterDel11111111111111111111111111111";
const OTHER_WALLET = "NotAdminFilterDel11111111111111111111111111";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const userIds: Record<"admin" | "other", string> = { admin: "", other: "" };

async function call(method: "GET" | "POST", url: string, as: "admin" | "other", payload?: object) {
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
      ...(payload ? { payload } : {}),
    });
  } finally {
    await app.close();
  }
}

/** A filter owned by the non-admin user, retired (deleted by them) or still live. */
async function filter(retired: boolean) {
  return prisma.userFilter.create({
    data: {
      userId: userIds.other,
      name: retired ? "Retired board filter" : "Live filter",
      shareOnLeaderboard: true,
      bestRank: 1,
      isActive: !retired,
      deletedAt: retired ? new Date() : null,
    },
  });
}

describe.skipIf(!dbAvailable)("admin delete of a retired filter", () => {
  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
    userIds.admin = (await prisma.user.create({ data: { walletAddress: ADMIN_WALLET } })).id;
    userIds.other = (await prisma.user.create({ data: { walletAddress: OTHER_WALLET } })).id;
  });
  beforeEach(async () => {
    await prisma.userFilter.deleteMany({ where: { userId: userIds.other } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { in: [ADMIN_WALLET, OTHER_WALLET] } } });
  });

  it("refuses a non-admin", async () => {
    const f = await filter(true);
    const res = await call("POST", `/admin/filters/${f.id}/delete`, "other", { confirm: true });
    expect(res.statusCode).toBe(403);
    expect(await prisma.userFilter.count({ where: { id: f.id } })).toBe(1);
  });

  it("needs the confirm flag", async () => {
    const f = await filter(true);
    const res = await call("POST", `/admin/filters/${f.id}/delete`, "admin", {});
    expect(res.statusCode).toBe(400);
    expect(await prisma.userFilter.count({ where: { id: f.id } })).toBe(1);
  });

  it("deletes a retired filter for good and drops it from the admin list", async () => {
    const f = await filter(true);
    const res = await call("POST", `/admin/filters/${f.id}/delete`, "admin", { confirm: true });
    expect(res.statusCode, res.body).toBe(204);
    expect(await prisma.userFilter.count({ where: { id: f.id } })).toBe(0);
    const list = await call("GET", "/admin/filters", "admin");
    expect(list.json().filters.some((x: { id: string }) => x.id === f.id)).toBe(false);
  });

  it("won't delete a live filter, and 404s an unknown one", async () => {
    const f = await filter(false);
    const res = await call("POST", `/admin/filters/${f.id}/delete`, "admin", { confirm: true });
    expect(res.statusCode).toBe(409);
    expect(await prisma.userFilter.count({ where: { id: f.id } })).toBe(1);
    const missing = await call("POST", "/admin/filters/nope/delete", "admin", { confirm: true });
    expect(missing.statusCode).toBe(404);
  });
});
