// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { FEEDBACK_DAILY_CAP, FEEDBACK_TOTAL_HOURLY_CAP, clean } from "./feedback.js";

const ADMIN_WALLET = "FeedbackAdmin111111111111111111111111111111";
const USER_WALLET = "FeedbackUser1111111111111111111111111111111";
const CAPPED_WALLET = "FeedbackCapped11111111111111111111111111111";
const CLEAN_WALLET = "FeedbackClean111111111111111111111111111111";
const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `feedback-test-${Date.now()}`;
/** Starts with the JPEG magic bytes (FF D8 FF), which is all the route checks of the image. */
const PIXEL = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==";

describe.skipIf(!dbAvailable)("feedback reports", () => {
  let app: FastifyInstance;
  const cookies: Record<"admin" | "user" | "capped" | "clean", string> = {
    admin: "",
    user: "",
    capped: "",
    clean: "",
  };

  beforeAll(async () => {
    const env: Env = { ...loadEnv(), ADMIN_WALLET_ADDRESSES: ADMIN_WALLET };
    app = await buildServer(env);
    const signer = createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    for (const [who, wallet] of [
      ["admin", ADMIN_WALLET],
      ["user", USER_WALLET],
      ["capped", CAPPED_WALLET],
      ["clean", CLEAN_WALLET],
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

  it("strips control and bidi characters, and drops a page URL that isn't http(s)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("clean"),
      payload: {
        kind: "bug",
        message: "Null\u0000 byte and \u202Ereversed text",
        contact: "\u200Bme@example.com",
        context: { url: "javascript:alert(document.cookie)", tab: "live\u0000", extra: "ignored" },
      },
    });
    expect(res.statusCode).toBe(200);
    const row = await prisma.feedbackReport.findUniqueOrThrow({
      where: { id: (res.json() as { id: string }).id },
    });
    expect(row.message).toBe("Null byte and reversed text");
    expect(row.contact).toBe("me@example.com");
    expect(row.context).toEqual({ tab: "live" });

    const page = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("clean"),
      payload: {
        kind: "idea",
        message: "Keep this link",
        context: { url: "https://trenchscanner.app/#filters" },
      },
    });
    const kept = await prisma.feedbackReport.findUniqueOrThrow({
      where: { id: (page.json() as { id: string }).id },
    });
    expect(kept.context).toEqual({ url: "https://trenchscanner.app/#filters" });
    await prisma.feedbackReport.deleteMany({ where: { walletAddress: CLEAN_WALLET } });
  });

  it("only takes a JPEG screenshot whose bytes are a JPEG", async () => {
    for (const screenshot of [
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "data:image/jpeg;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+",
      "data:image/svg+xml;base64,PHN2Zz4=",
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        cookies: as("capped"),
        payload: { kind: "bug", message: "With a picture", screenshot },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("clean() leaves newlines and tabs", () => {
    expect(clean("  a\n\tb\u0007  ")).toBe("a\n\tb");
  });

  it("caps reports from everyone together per hour", async () => {
    await prisma.feedbackReport.createMany({
      data: Array.from({ length: FEEDBACK_TOTAL_HOURLY_CAP }, (_, i) => ({
        kind: "idea",
        message: `flood ${i}`,
        submitterKey: `w:flood${i}`,
        walletAddress: `flood${i}`,
      })),
    });
    const res = await app.inject({
      method: "POST",
      url: "/feedback",
      cookies: as("capped"),
      payload: { kind: "bug", message: "One more thing" },
    });
    expect(res.statusCode).toBe(429);
    await prisma.feedbackReport.deleteMany({ where: { walletAddress: { startsWith: "flood" } } });
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
