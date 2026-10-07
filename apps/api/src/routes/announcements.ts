import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trenchscanner/core";

/**
 * Admin announcements: a message an admin posts from the Admin tab to every visitor's dashboard.
 * One shows at a time - posting a new one ends the one before it - until it is ended by hand or
 * its expiry passes. Dismissal is the browser's business (it remembers the ids it closed), so a
 * new announcement shows again to everyone.
 */

export const ANNOUNCEMENT_MAX_LENGTH = 500;
/** Every open dashboard polls the public route; this keeps that off the database. */
const PUBLIC_CACHE_MS = 15_000;

const createSchema = z.object({
  message: z.string().trim().min(1, "message is empty").max(ANNOUNCEMENT_MAX_LENGTH),
  severity: z.enum(["info", "warning"]).default("info"),
  // Absent means it shows until ended by hand. Capped at 90 days so a typo doesn't pin a banner
  // up for years.
  expiresInHours: z.coerce
    .number()
    .positive()
    .max(90 * 24)
    .optional(),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface PublicAnnouncement {
  id: string;
  message: string;
  severity: string;
  createdAt: Date;
  expiresAt: Date | null;
}

/** The announcement showing right now, if any. */
async function currentAnnouncement(now = new Date()): Promise<PublicAnnouncement | null> {
  return prisma.announcement.findFirst({
    where: { endedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, message: true, severity: true, createdAt: true, expiresAt: true },
  });
}

/**
 * Shared between the public and admin plugins so an admin's change shows on their own next poll
 * rather than after the cache runs out. Other API instances catch up within PUBLIC_CACHE_MS.
 */
let cached: { at: number; body: { announcement: PublicAnnouncement | null } } | null = null;
const forgetCached = () => {
  cached = null;
};

/** GET /announcement - public, like /config: guests see announcements too. */
export async function registerAnnouncementRoutes(app: FastifyInstance) {
  app.get("/", async () => {
    const now = Date.now();
    // An expiry inside the cache window still ends on time.
    const live = cached?.body.announcement;
    const expired = live?.expiresAt && live.expiresAt.getTime() <= now;
    if (cached && now - cached.at < PUBLIC_CACHE_MS && !expired) return cached.body;
    const body = { announcement: await currentAnnouncement(new Date(now)) };
    cached = { at: now, body };
    return body;
  });
}

/** /admin/announcements - registered inside the authenticateAdmin gate. */
export async function registerAdminAnnouncementRoutes(app: FastifyInstance) {
  app.get("/announcements", async (request, reply) => {
    const parsed = historyQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const [current, history] = await Promise.all([
      currentAnnouncement(),
      prisma.announcement.findMany({ orderBy: { createdAt: "desc" }, take: parsed.data.limit }),
    ]);
    return { currentId: current?.id ?? null, history };
  });

  app.post("/announcements", async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { message, severity, expiresInHours } = parsed.data;
    const now = new Date();
    const created = await prisma.$transaction(async (tx) => {
      await tx.announcement.updateMany({ where: { endedAt: null }, data: { endedAt: now } });
      return tx.announcement.create({
        data: {
          message,
          severity,
          expiresAt: expiresInHours ? new Date(now.getTime() + expiresInHours * 3_600_000) : null,
          createdBy: request.user!.walletAddress,
        },
      });
    });
    forgetCached();
    request.log.info({ id: created.id, by: request.user!.walletAddress }, "posted an announcement");
    return created;
  });

  /** Ends whatever is showing. */
  app.post("/announcements/end", async (request) => {
    const result = await prisma.announcement.updateMany({
      where: { endedAt: null },
      data: { endedAt: new Date() },
    });
    forgetCached();
    request.log.info({ ended: result.count, by: request.user!.walletAddress }, "ended the announcement");
    return { ended: result.count };
  });
}
