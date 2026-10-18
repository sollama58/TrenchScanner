import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@trenchscanner/core";

/**
 * Admin announcements: a message an admin posts from the Admin tab to every visitor's dashboard.
 * One shows at a time - posting a new one ends the one before it - until it is ended by hand or
 * its expiry passes. Ending and replacing name the announcement the admin was looking at, so a
 * newer one posted from another tab is never taken down unseen (409 instead). Dismissal is the browser's business (it remembers the ids it closed), so a
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
  // The id the admin's screen shows as current (null: none). Absent skips the check.
  replaces: z.string().min(1).nullable().optional(),
});

const endSchema = z.object({ id: z.string().min(1, "id is required") });

const STALE_ERROR = "The current announcement changed since you loaded this page. Reload and try again.";

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

type Db = Pick<typeof prisma, "announcement">;

/** The announcement showing right now, if any. */
async function currentAnnouncement(now = new Date(), db: Db = prisma): Promise<PublicAnnouncement | null> {
  return db.announcement.findFirst({
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
    const { message, severity, expiresInHours, replaces } = parsed.data;
    const now = new Date();
    const created = await prisma.$transaction(async (tx) => {
      if (replaces !== undefined && ((await currentAnnouncement(now, tx))?.id ?? null) !== replaces) {
        return null;
      }
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
    if (!created) return reply.code(409).send({ error: STALE_ERROR });
    forgetCached();
    request.log.info({ id: created.id, by: request.user!.walletAddress }, "posted an announcement");
    return created;
  });

  /** Ends the announcement with this id, only while it is still the one showing. */
  app.post("/announcements/end", async (request, reply) => {
    const parsed = endSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { id } = parsed.data;
    const result = await prisma.$transaction(async (tx) => {
      const now = new Date();
      if ((await currentAnnouncement(now, tx))?.id !== id) return null;
      return tx.announcement.updateMany({ where: { id, endedAt: null }, data: { endedAt: now } });
    });
    if (!result?.count) return reply.code(409).send({ error: STALE_ERROR });
    forgetCached();
    request.log.info({ id, by: request.user!.walletAddress }, "ended the announcement");
    return { ended: result.count };
  });
}
