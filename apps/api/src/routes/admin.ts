import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, type Env } from "@trenchscanner/core";

const DAY_MS = 86_400_000;

const usersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const liveFeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

/**
 * Everything behind ADMIN_WALLET_ADDRESSES (see authenticateAdmin in server.ts). Nothing here
 * writes anything the worker depends on, and there's no cross-process way to reach into the
 * worker from the API anyway (Render background workers have no inbound HTTP - see
 * apps/worker/src/telegram/bot.ts) - these are read/moderate-only tools, not remote job control.
 */
export async function registerAdminRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.addHook("preHandler", app.authenticateAdmin);

  /** Top-line counts for the admin overview. */
  app.get("/stats", async () => {
    const dayAgo = new Date(Date.now() - DAY_MS);
    const [
      totalUsers,
      totalActiveFilters,
      totalTrackedTokens,
      totalMatches,
      matches24h,
      telegramLinkedUsers,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.userFilter.count({ where: { isActive: true } }),
      prisma.token.count(),
      prisma.match.count(),
      prisma.match.count({ where: { matchedAt: { gt: dayAgo } } }),
      prisma.telegramLink.count({ where: { chatId: { not: null } } }),
    ]);
    return {
      totalUsers,
      totalActiveFilters,
      totalTrackedTokens,
      totalMatches,
      matches24h,
      telegramLinkedUsers,
    };
  });

  /**
   * Every tracked token's most recent snapshot, newest first - deliberately upstream of both the
   * rug screen and per-user filter matching (see scanJob.ts: a snapshot is written for every
   * in-band candidate regardless of rugScreenPassed, and Match rows only exist for the subset
   * that also matched an active filter). This is what lets an admin see rejected/unmatched
   * tokens that never surface anywhere else in the product - including *why* the rug screen
   * rejected one (rugScreenReasons).
   *
   * `distinct: ["tokenId"]` combined with `orderBy: { takenAt: "desc" }` is Prisma's documented
   * pattern for "most recent row per group" - verified directly against a real DB before relying
   * on it (see the PR description).
   */
  app.get("/live-feed", async (request, reply) => {
    const parsed = liveFeedQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }

    const [snapshots, watchlistOnlyCount] = await Promise.all([
      prisma.tokenSnapshot.findMany({
        orderBy: { takenAt: "desc" },
        distinct: ["tokenId"],
        take: parsed.data.limit,
        include: { token: true },
      }),
      // Freshly-discovered mints that have never had a snapshot written at all - outside the mcap
      // band, or not yet re-checked this cycle. Reported as a count rather than bare rows in the
      // same feed, since there's no score/mcap/anything else to show for them yet.
      prisma.token.count({ where: { snapshots: { none: {} } } }),
    ]);

    return { snapshots, watchlistOnlyCount };
  });

  /** All users, newest first, with enough context to moderate without a DB console. */
  app.get("/users", async (request, reply) => {
    const parsed = usersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }

    const users = await prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: parsed.data.limit,
      include: {
        _count: { select: { filters: true, matches: true } },
        telegramLink: { select: { chatId: true, alertMode: true } },
      },
    });

    return users.map((u) => ({
      id: u.id,
      walletAddress: u.walletAddress,
      createdAt: u.createdAt,
      filterCount: u._count.filters,
      matchCount: u._count.matches,
      telegramLinked: Boolean(u.telegramLink?.chatId),
      alertMode: u.telegramLink?.alertMode ?? null,
    }));
  });

  /** Moderation action: force-unlink a user's Telegram (e.g. abuse, a stuck/duplicate link). */
  app.post("/users/:id/unlink-telegram", async (request) => {
    const { id } = request.params as { id: string };
    const result = await prisma.telegramLink.deleteMany({ where: { userId: id } });
    return { ok: true, unlinked: result.count > 0 };
  });

  /**
   * The non-secret half of the shared env schema - scan cadence, mcap band, retention windows,
   * etc. Secrets (DATABASE_URL, JWT_SECRET, HELIUS_API_KEY, TELEGRAM_BOT_TOKEN) are deliberately
   * left out; this exists so an admin can see what's actually configured on this deployment
   * without digging through the Render dashboard, not to expose credentials over the API.
   */
  app.get("/config", async () => {
    const { env } = opts;
    return {
      scanIntervalMinutes: env.SCAN_INTERVAL_MINUTES,
      digestHourUtc: env.DIGEST_HOUR_UTC,
      mcapFilterMin: env.MCAP_FILTER_MIN,
      mcapFilterMax: env.MCAP_FILTER_MAX,
      watchlistTtlHours: env.WATCHLIST_TTL_HOURS,
      watchlistMaxTracked: env.WATCHLIST_MAX_TRACKED,
      cleanupHourUtc: env.CLEANUP_HOUR_UTC,
      snapshotRetentionDays: env.SNAPSHOT_RETENTION_DAYS,
      staleTokenRetentionDays: env.STALE_TOKEN_RETENTION_DAYS,
      outcomeTrackingHourUtc: env.OUTCOME_TRACKING_HOUR_UTC,
      telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
    };
  });
}
