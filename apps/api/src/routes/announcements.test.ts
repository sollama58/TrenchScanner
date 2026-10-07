// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";

const ADMIN_WALLET = "AnnounceAdmin1111111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `announcement-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("announcements", () => {
  let app: FastifyInstance;
  const cookies: Record<"admin" | "other", string> = { admin: "", other: "" };

  beforeAll(async () => {
    const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
    app = await buildServer(env);
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    const admin = await prisma.user.create({ data: { walletAddress: `${TAG}-admin` } });
    const other = await prisma.user.create({ data: { walletAddress: `${TAG}-other` } });
    cookies.admin = await signer.sign({ userId: admin.id, walletAddress: ADMIN_WALLET });
    cookies.other = await signer.sign({
      userId: other.id,
      walletAddress: "NotAnAdmin111111111111111111111111111111111",
    });
    await prisma.announcement.deleteMany({});
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.announcement.deleteMany({});
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await app?.close();
  });

  const as = (who: "admin" | "other") => ({ [SESSION_COOKIE_NAME]: cookies[who] });
  const current = async () => {
    const res = await app.inject({ method: "GET", url: "/announcement" });
    expect(res.statusCode).toBe(200);
    return (res.json() as { announcement: { id: string; message: string; severity: string } | null })
      .announcement;
  };

  it("shows nothing until an admin posts, then the newest one alone", async () => {
    expect(await current()).toBeNull();

    const first = await app.inject({
      method: "POST",
      url: "/admin/announcements",
      cookies: as("admin"),
      payload: { message: "  Maintenance at 22:00 UTC  " },
    });
    expect(first.statusCode).toBe(200);
    expect(await current()).toMatchObject({ message: "Maintenance at 22:00 UTC", severity: "info" });

    const second = await app.inject({
      method: "POST",
      url: "/admin/announcements",
      cookies: as("admin"),
      payload: { message: "Feed delayed", severity: "warning", expiresInHours: 2 },
    });
    const secondId = (second.json() as { id: string }).id;
    expect(await current()).toMatchObject({ id: secondId, severity: "warning" });

    // Posting ended the first rather than leaving two live.
    const live = await prisma.announcement.count({ where: { endedAt: null } });
    expect(live).toBe(1);
  });

  it("stops showing once ended", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/announcements/end", cookies: as("admin") });
    expect(res.statusCode).toBe(200);
    expect(await current()).toBeNull();
    const history = await app.inject({ method: "GET", url: "/admin/announcements", cookies: as("admin") });
    expect(history.json()).toMatchObject({ currentId: null });
    expect((history.json() as { history: unknown[] }).history.length).toBeGreaterThanOrEqual(2);
  });

  it("does not show an expired announcement", async () => {
    // Ending through the route clears the public route's short cache, so the read below hits the
    // database.
    await app.inject({ method: "POST", url: "/admin/announcements/end", cookies: as("admin") });
    await prisma.announcement.create({
      data: { message: "old news", expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(await current()).toBeNull();
  });

  it("rejects an empty or oversized message and non-admins", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/admin/announcements",
      cookies: as("admin"),
      payload: { message: "   " },
    });
    expect(empty.statusCode).toBe(400);
    const long = await app.inject({
      method: "POST",
      url: "/admin/announcements",
      cookies: as("admin"),
      payload: { message: "x".repeat(501) },
    });
    expect(long.statusCode).toBe(400);
    const notAdmin = await app.inject({
      method: "POST",
      url: "/admin/announcements",
      cookies: as("other"),
      payload: { message: "hi" },
    });
    expect(notAdmin.statusCode).toBe(403);
    const anon = await app.inject({ method: "POST", url: "/admin/announcements/end" });
    expect(anon.statusCode).toBe(401);
  });
});
