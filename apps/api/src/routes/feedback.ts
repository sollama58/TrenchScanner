import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, walletTag, type Env } from "@trenchscanner/core";
import { clientIp } from "../clientIp.js";

/**
 * The bug button: a bug report or a suggestion, sent from the small icon at the bottom right of
 * every screen, by anyone (signed in or a guest), and read by admins in Admin > Reports.
 *
 * Open to guests, so it is held back three ways: a per-caller rate limit on the route, a daily
 * cap per sender kept in the table itself (it survives restarts and holds across API instances),
 * and a cap on guest reports from everyone together, which is what stops one person rotating
 * addresses. A hidden form field that only bots fill in is answered as if it worked and dropped.
 */

export const FEEDBACK_MESSAGE_MAX = 2000;
export const FEEDBACK_CONTACT_MAX = 200;
/**
 * A downscaled JPEG of a phone or desktop screen is 100-400KB as a data URL; this leaves room.
 * 500,000 since 2026-10-16 (900,000 before): the column is the report table's only weight, the
 * dialog shrinks the image to fit, and the nightly cleanup drops it a week after the report is done.
 */
export const FEEDBACK_SCREENSHOT_MAX = 500_000;
/** Reports one sender may file in a day. */
export const FEEDBACK_DAILY_CAP = 20;
/** Guest reports, from every guest together, in an hour. Signed-in senders are not counted. */
export const FEEDBACK_GUEST_HOURLY_CAP = 60;
/**
 * Reports from everyone together in an hour. A wallet costs nothing to sign in with, so the
 * per-sender caps alone would let someone with a stack of wallets fill the table.
 */
export const FEEDBACK_TOTAL_HOURLY_CAP = 300;
/** Screenshots stored from everyone together in a day: at most ~180MB a day at the size cap. */
export const FEEDBACK_SCREENSHOT_DAILY_CAP = 200;
export const FEEDBACK_STATUSES = ["new", "seen", "done"] as const;

/** Bursts: a report and a couple of corrections, not a flood. */
const SUBMIT_RATE_LIMIT = { max: 5, timeWindow: "10 minutes" };
/** The screenshot rides in the body, so this route takes more than the API's 64KB default. */
const SUBMIT_BODY_LIMIT = 1024 * 1024;

/**
 * Control characters (but newline and tab), bidi overrides and other invisible format marks. NUL
 * is refused by Postgres text and jsonb outright (a 500), and the bidi ones can make a report read
 * differently in the admin list than what was sent.
 */
const UNSAFE_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
export const clean = (value: string) => value.replace(UNSAFE_CHARS, "").trim();

const text = (max: number) => z.string().transform(clean).pipe(z.string().max(max));

/**
 * The page the report came from: an http(s) URL only, so the admin list's link can never be a
 * javascript: or data: URL someone posted. Anything else is dropped, not refused.
 */
const pageUrl = z
  .string()
  .max(2000)
  .transform((raw) => {
    try {
      const url = new URL(clean(raw));
      if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
      if (url.username || url.password) return undefined;
      return url.href.slice(0, 500);
    } catch {
      return undefined;
    }
  });

/**
 * A JPEG data URL (all the form's screen capture makes) whose bytes really start like one. An
 * <img> can't run script, but there is no reason to store anything else.
 */
const jpegDataUrl = z
  .string()
  .max(FEEDBACK_SCREENSHOT_MAX, "That screenshot is too large")
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/, "That screenshot isn't an image")
  .refine((v) => {
    const head = Buffer.from(v.slice(23, 31), "base64");
    return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  }, "That screenshot isn't an image");

const contextSchema = z
  .object({
    url: pageUrl,
    tab: text(40),
    appVersion: text(60),
    viewport: text(20),
    screen: text(20),
    dpr: z.number().min(0).max(10),
    userAgent: text(400),
    theme: text(20),
    language: text(20),
    timezone: text(60),
    signedIn: z.boolean(),
    guest: z.boolean(),
  })
  .partial()
  .strip();

const submitSchema = z.object({
  kind: z.enum(["bug", "idea"]),
  message: z
    .string()
    .transform(clean)
    .pipe(
      z
        .string()
        .min(5, "Say a little more about it")
        .max(FEEDBACK_MESSAGE_MAX, `Keep it under ${FEEDBACK_MESSAGE_MAX} characters`),
    ),
  contact: text(FEEDBACK_CONTACT_MAX).optional(),
  context: contextSchema.optional(),
  screenshot: jpegDataUrl.optional(),
  // The honeypot: hidden from people, filled in by form-filling bots.
  website: z.string().optional(),
});

/** A guest's address is kept only as a keyed hash: enough to cap them, not to identify them. */
function guestKey(secret: string, ip: string) {
  return `ip:${createHmac("sha256", secret).update(ip).digest("hex").slice(0, 32)}`;
}

/** POST /feedback - public; a signed-in caller's wallet is attached. */
export async function registerFeedbackRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.post(
    "/",
    {
      bodyLimit: SUBMIT_BODY_LIMIT,
      preHandler: app.identify,
      config: { rateLimit: SUBMIT_RATE_LIMIT },
    },
    async (request, reply) => {
      const parsed = submitSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
      }
      const { kind, message, contact, context, screenshot, website } = parsed.data;
      if (website) {
        request.log.info("dropped a feedback report that filled the honeypot");
        return { ok: true };
      }

      const wallet = request.user?.walletAddress ?? null;
      const submitterKey = wallet ? `w:${wallet}` : guestKey(opts.env.JWT_SECRET, clientIp(request));
      const now = Date.now();
      const hourAgo = new Date(now - 3_600_000);
      const [today, guestsThisHour, everyoneThisHour, shotsToday] = await Promise.all([
        prisma.feedbackReport.count({
          where: { submitterKey, createdAt: { gt: new Date(now - 24 * 3_600_000) } },
        }),
        wallet
          ? Promise.resolve(0)
          : prisma.feedbackReport.count({ where: { walletAddress: null, createdAt: { gt: hourAgo } } }),
        prisma.feedbackReport.count({ where: { createdAt: { gt: hourAgo } } }),
        screenshot
          ? prisma.feedbackReport.count({
              where: { screenshot: { not: null }, createdAt: { gt: new Date(now - 24 * 3_600_000) } },
            })
          : Promise.resolve(0),
      ]);
      if (today >= FEEDBACK_DAILY_CAP) {
        return reply.code(429).send({ error: "You've sent a lot of reports today. Try again tomorrow." });
      }
      if (guestsThisHour >= FEEDBACK_GUEST_HOURLY_CAP || everyoneThisHour >= FEEDBACK_TOTAL_HOURLY_CAP) {
        return reply
          .code(429)
          .send({ error: "Lots of reports are coming in right now. Connect a wallet or try again later." });
      }

      const created = await prisma.feedbackReport.create({
        data: {
          kind,
          message,
          contact: contact || null,
          walletAddress: wallet,
          submitterKey,
          context: context ?? undefined,
          // Past the day's screenshot budget the report still goes in, without its picture.
          screenshot: screenshot && shotsToday < FEEDBACK_SCREENSHOT_DAILY_CAP ? screenshot : null,
        },
        select: { id: true },
      });
      request.log.info(
        { id: created.id, kind, wallet: wallet && walletTag(wallet) },
        "received a feedback report",
      );
      return { ok: true, id: created.id };
    },
  );
}

const listQuerySchema = z.object({
  status: z.enum([...FEEDBACK_STATUSES, "all"]).default("all"),
  kind: z.enum(["bug", "idea", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const updateSchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES),
    adminNote: text(1000).nullable(),
  })
  .partial()
  .refine((v) => v.status !== undefined || v.adminNote !== undefined, "nothing to change");

/** Every column but the screenshot (large) and the sender key (a hash nobody needs to read). */
const LIST_SELECT = {
  id: true,
  createdAt: true,
  updatedAt: true,
  kind: true,
  message: true,
  contact: true,
  status: true,
  walletAddress: true,
  context: true,
  adminNote: true,
  handledBy: true,
} as const;

/** Report ids are cuids. */
const idParams = z.object({ id: z.string().regex(/^[a-z0-9]{1,64}$/) });

async function statusCounts() {
  const rows = await prisma.feedbackReport.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<(typeof FEEDBACK_STATUSES)[number], number> = { new: 0, seen: 0, done: 0 };
  for (const r of rows) if (r.status in counts) counts[r.status as keyof typeof counts] = r._count._all;
  return counts;
}

/** /admin/feedback - registered inside the authenticateAdmin gate. */
export async function registerAdminFeedbackRoutes(app: FastifyInstance) {
  /** The Admin tab's badge: how many are waiting. */
  app.get("/feedback/counts", async () => statusCounts());

  /** Newest first, without the screenshots (fetched one at a time below). */
  app.get("/feedback", async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { status, kind, limit } = parsed.data;
    const where = {
      ...(status === "all" ? {} : { status }),
      ...(kind === "all" ? {} : { kind }),
    };
    const [reports, counts] = await Promise.all([
      prisma.feedbackReport.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        select: LIST_SELECT,
      }),
      statusCounts(),
    ]);
    const withShot = new Set(
      (
        await prisma.feedbackReport.findMany({
          where: { id: { in: reports.map((r) => r.id) }, screenshot: { not: null } },
          select: { id: true },
        })
      ).map((r) => r.id),
    );
    return { reports: reports.map((r) => ({ ...r, hasScreenshot: withShot.has(r.id) })), counts };
  });

  app.get("/feedback/:id/screenshot", async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid id" });
    const row = await prisma.feedbackReport.findUnique({
      where: { id: parsed.data.id },
      select: { screenshot: true },
    });
    if (!row?.screenshot) return reply.code(404).send({ error: "no screenshot" });
    return { screenshot: row.screenshot };
  });

  app.patch("/feedback/:id", async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    if (!body.success) {
      return reply.code(400).send({ error: body.error.issues[0]?.message ?? "invalid request" });
    }
    const { status, adminNote } = body.data;
    const result = await prisma.feedbackReport.updateMany({
      where: { id: params.data.id },
      data: {
        ...(status ? { status } : {}),
        ...(adminNote !== undefined ? { adminNote: adminNote || null } : {}),
        handledBy: request.user!.walletAddress,
      },
    });
    if (result.count === 0) return reply.code(404).send({ error: "not found" });
    return { ok: true };
  });

  /** For spam: a report that is only noise. */
  app.delete("/feedback/:id", async (request, reply) => {
    const parsed = idParams.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid id" });
    const result = await prisma.feedbackReport.deleteMany({ where: { id: parsed.data.id } });
    if (result.count === 0) return reply.code(404).send({ error: "not found" });
    request.log.info({ id: parsed.data.id, by: request.user!.walletAddress }, "deleted a feedback report");
    return { ok: true };
  });
}
