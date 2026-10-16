// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { FEEDBACK_DAILY_CAP } from "./feedback.js";

const ADMIN_WALLET = "FeedbackAdmin111111111111111111111111111111";
const USER_WALLET = "FeedbackUser1111111111111111111111111111111";
const CAPPED_WALLET = "FeedbackCapped11111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `feedback-test-${Date.now()}`;
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe.skipIf(!dbAvailable)("feedback reports", () => {
  let app: FastifyInstance;
  const cookies: Record<"admin" | "user" | "capped", string> = { admin: "", user: "", capped: "" };

  beforeAll(async () => {
    const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
    app = await buildServer(env);
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const [who, wallet] of [
      ["admin", ADMIN_WALLET],
      ["user", USER_WALLET],
      ["capped", CAPPED_WALLET],
    ] as const) {
      const row = await prisma.user.create({ data: { walletAddress: `${TAG}-${who}` } });
      cookies[who] = await signer.sign({ userId: row.id, walletAddress: wallet });
    }
    await prisma.feedbackReport.deleteMany({});
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.feedbackReport.deleteMany({});
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
    await app?.close();
  });

  const as = (who: keyof typeof cookies) => ({ [SESSION_COOKIE_NAME]: cookies[who] });

  it("takes a guest's report without a wallet and a signed-in one with theirs", async () => {
    const guest = await app.inject({
      method: "POST",
      url: "/feedback",
      payload: {
        kind: "bug",
        message: "  The feed froze on my phone  ",
        context: { tab: "live", viewport: "390x844", appVersion: "abc123", guest: true },
        screenshot: PIXEL,
      },
    });
    expect(guest.statusCode).toBe(200);
    const signedIn = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("user"),
      payload: { kind: "idea", message: "Add a dark chart option", contact: "@someone" },
    });
    expect(signedIn.statusCode).toBe(200);

    const rows = await prisma.feedbackReport.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "bug",
      message: "The feed froze on my phone",
      walletAddress: null,
      status: "new",
      screenshot: PIXEL,
    });
    expect(rows[0]!.submitterKey).toMatch(/^ip:[0-9a-f]{32}$/);
    expect(rows[1]).toMatchObject({ kind: "idea", walletAddress: USER_WALLET, contact: "@someone" });
  });

  it("rejects an empty message and a screenshot that isn't an image, and drops honeypot posts", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("user"),
      payload: { kind: "bug", message: "  " },
    });
    expect(empty.statusCode).toBe(400);
    const notImage = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("user"),
      payload: { kind: "bug", message: "Look at this", screenshot: "data:text/html;base64,PGgxPg==" },
    });
    expect(notImage.statusCode).toBe(400);
    const bot = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("user"),
      payload: { kind: "bug", message: "Buy cheap followers", website: "spam.example" },
    });
    expect(bot.statusCode).toBe(200);
    expect(await prisma.feedbackReport.count({ where: { message: { contains: "followers" } } })).toBe(0);
  });

  it("caps one sender's reports per day", async () => {
    await prisma.feedbackReport.createMany({
      data: Array.from({ length: FEEDBACK_DAILY_CAP }, (_, i) => ({
        kind: "bug",
        message: `old report ${i}`,
        walletAddress: CAPPED_WALLET,
        submitterKey: `w:${CAPPED_WALLET}`,
      })),
    });
    const res = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("capped"),
      payload: { kind: "bug", message: "One more thing" },
    });
    expect(res.statusCode).toBe(429);
    await prisma.feedbackReport.deleteMany({ where: { walletAddress: CAPPED_WALLET } });
  });

  it("lists reports for admins only, without screenshots, and lets them triage", async () => {
    const anon = await app.inject({ method: "GET", url: "/admin/feedback" });
    expect(anon.statusCode).toBe(401);
    const notAdmin = await app.inject({ method: "GET", url: "/admin/feedback", cookies: as("user") });
    expect(notAdmin.statusCode).toBe(403);

    const list = await app.inject({ method: "GET", url: "/admin/feedback", cookies: as("admin") });
    expect(list.statusCode).toBe(200);
    const body = list.json() as {
      reports: {
        id: string;
        kind: string;
        hasScreenshot: boolean;
        screenshot?: string;
        submitterKey?: string;
      }[];
      counts: Record<string, number>;
    };
    expect(body.counts).toEqual({ new: 2, seen: 0, done: 0 });
    const bug = body.reports.find((r) => r.kind === "bug")!;
    expect(bug.hasScreenshot).toBe(true);
    expect(bug.screenshot).toBeUndefined();
    expect(bug.submitterKey).toBeUndefined();

    const shot = await app.inject({
      method: "GET",
      url: `/admin/feedback/${bug.id}/screenshot`,
      cookies: as("admin"),
    });
    expect(shot.json()).toEqual({ screenshot: PIXEL });

    const done = await app.inject({
      method: "PATCH",
      url: `/admin/feedback/${bug.id}`,
      cookies: as("admin"),
      payload: { status: "done", adminNote: "Fixed in the next deploy" },
    });
    expect(done.statusCode).toBe(200);
    const counts = await app.inject({ method: "GET", url: "/admin/feedback/counts", cookies: as("admin") });
    expect(counts.json()).toEqual({ new: 1, seen: 0, done: 1 });
    const newOnly = await app.inject({
      method: "GET",
      url: "/admin/feedback?status=new",
      cookies: as("admin"),
    });
    expect((newOnly.json() as { reports: { kind: string }[] }).reports.map((r) => r.kind)).toEqual(["idea"]);

    const gone = await app.inject({
      method: "DELETE",
      url: `/admin/feedback/${bug.id}`,
      cookies: as("admin"),
    });
    expect(gone.statusCode).toBe(200);
    const missing = await app.inject({
      method: "PATCH",
      url: `/admin/feedback/${bug.id}`,
      cookies: as("admin"),
      payload: { status: "seen" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("rate-limits a burst from one sender", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        cookies: as("admin"),
        payload: { kind: "idea", message: `burst number ${i}` },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[5]).toBe(429);
  });
});
