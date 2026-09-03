import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma, AccessSource, type Env } from "@trenchscanner/core";

const DAY_MS = 86_400_000;

const usersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const liveFeedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(300).default(100),
});

/** Base58 - the shape of every Solana address. Rejects the empty string and obvious typos. */
const SOLANA_ADDRESS = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a valid Solana address");

const whitelistSchema = z.object({
  walletAddress: SOLANA_ADDRESS,
  note: z.string().max(200).optional(),
  // Null/absent means indefinite; a date lets you hand out a trial without having to remember to
  // revoke it.
  expiresAt: z.coerce.date().optional(),
});

const grantSchema = z.object({
  walletAddress: SOLANA_ADDRESS,
  // Capped at two years: a manual grant is a fix for a specific problem, and a typo'd 3650 should
  // not silently become a decade of free access.
  days: z.coerce.number().int().min(1).max(730),
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
   * Served by a raw DISTINCT ON rather than Prisma's `distinct` + `orderBy` + `take`.
   *
   * That combination returns the right ROWS - it is Prisma's documented pattern for "most recent
   * row per group" - but it applies `distinct` in memory (nativeDistinct is not enabled on this
   * schema) and deliberately omits the LIMIT while doing so, since deduping has to happen before
   * the cap can mean anything. The emitted SQL is `SELECT <every column> FROM "TokenSnapshot"
   * ORDER BY "takenAt" DESC OFFSET $1` - the entire table, streamed into the API process on
   * every load of this tab, on the smallest Postgres tier, against a table that grows by ~50-100
   * wide rows a minute and is kept for 30 days. Confirmed by logging the emitted query.
   *
   * DISTINCT ON does the same job in the database and keeps the LIMIT: dedupe by tokenId taking
   * the newest row of each, then re-sort that much smaller set by recency and cap it. The token
   * join is a second query keyed by the ids that survived, which keeps the row shape identical to
   * what the include produced.
   */
  app.get("/live-feed", async (request, reply) => {
    const parsed = liveFeedQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }

    const [latestIds, watchlistOnlyCount] = await Promise.all([
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM (
          SELECT DISTINCT ON ("tokenId") id, "takenAt"
          FROM "TokenSnapshot"
          ORDER BY "tokenId", "takenAt" DESC
        ) newest
        ORDER BY "takenAt" DESC
        LIMIT ${parsed.data.limit}
      `,
      // Freshly-discovered mints that have never had a snapshot written at all - outside the mcap
      // band, or not yet re-checked this cycle. Reported as a count rather than bare rows in the
      // same feed, since there's no score/mcap/anything else to show for them yet.
      prisma.token.count({ where: { snapshots: { none: {} } } }),
    ]);

    // Ordered here rather than trusting the second query's own ordering: an `in` lookup makes no
    // promise about row order, and this feed is read newest-first.
    const rows = await prisma.tokenSnapshot.findMany({
      where: { id: { in: latestIds.map((r) => r.id) } },
      orderBy: { takenAt: "desc" },
      include: { token: true },
    });

    return { snapshots: rows, watchlistOnlyCount };
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
      livePriceIntervalMinutes: env.LIVE_PRICE_INTERVAL_MINUTES,
      livePriceMaxTracked: env.LIVE_PRICE_MAX_TRACKED,
      activeViewWindowMinutes: env.ACTIVE_VIEW_WINDOW_MINUTES,
      // The constraint that lets the scan run every minute without multiplying RugCheck traffic
      // one-for-one - see the worker's rugCheckProfiles.ts. Worth reading next to the scan
      // interval, since the two are only sound in combination.
      rugCheckCacheTtlMinutes: env.RUGCHECK_CACHE_TTL_MINUTES,
      // The most consequential one to be able to read back: this is the span every user's
      // minHolderGrowthPct threshold is actually measured over, so "is +5% growth a lot?" cannot
      // be answered without it.
      holderGrowthWindowMinutes: env.HOLDER_GROWTH_WINDOW_MINUTES,
      // Not a scan setting, but the value that decides both the SIWS domain binding and the
      // session cookie's SameSite - the two things most likely to be behind "sign-in doesn't work
      // in this browser", and otherwise only visible in the Render dashboard.
      publicAppDomain: env.PUBLIC_APP_DOMAIN,
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

/**
 * Subscription administration: who has access, what came in, and the two levers for fixing it by
 * hand.
 *
 * Registered as its own function rather than inlined above so the burn/whitelist surface stays
 * legible next to the operational stats it sits beside. Everything here is already behind
 * `authenticateAdmin` via the parent plugin's preHandler.
 */
export async function registerAdminSubscriptionRoutes(app: FastifyInstance) {
  /** Headline numbers for the Subscriptions tab. */
  app.get("/subscriptions/stats", async () => {
    const now = new Date();
    const [active, expired, whitelisted, burns, unattributed, totals, cursor] = await Promise.all([
      prisma.subscription.count({ where: { expiresAt: { gt: now } } }),
      prisma.subscription.count({ where: { expiresAt: { lte: now } } }),
      prisma.whitelist.count(),
      prisma.burnEvent.count(),
      prisma.burnEvent.count({ where: { userId: null } }),
      prisma.burnEvent.aggregate({ _sum: { monthsCredited: true } }),
      prisma.burnScanCursor.findUnique({ where: { id: "burn-scan" } }),
    ]);

    // Summed in SQL as numeric rather than in JS: rawAmount is a u64 string, and adding those up
    // through Number would start losing precision once the ledger gets big.
    const summed = await prisma.$queryRaw<{ total: string | null }[]>`
      SELECT SUM("rawAmount"::numeric)::text AS total FROM "BurnEvent"
    `;
    // SUM over no rows still returns one row holding NULL, so this should always have an element -
    // but reading [0] off an array the type system says may be empty is exactly the assumption that
    // turns an empty ledger into a 500 on the admin page.
    const total = summed[0]?.total ?? null;

    return {
      activeSubscriptions: active,
      expiredSubscriptions: expired,
      whitelisted,
      totalBurns: burns,
      unattributedBurns: unattributed,
      totalMonthsCredited: totals._sum.monthsCredited ?? 0,
      totalRawBurned: total ?? "0",
      scanCursor: cursor?.lastSignature ?? null,
      scanCursorUpdatedAt: cursor?.updatedAt ?? null,
    };
  });

  /** The burn ledger, newest first. `unattributed=true` narrows it to burns with no account. */
  app.get("/subscriptions/burns", async (request) => {
    const query = request.query as { limit?: string; unattributed?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const burns = await prisma.burnEvent.findMany({
      where: query.unattributed === "true" ? { userId: null } : {},
      orderBy: { createdAt: "desc" },
      take: limit,
      include: { user: { select: { walletAddress: true } } },
    });
    return burns.map((b) => ({
      signature: b.signature,
      burnerWallet: b.burnerWallet,
      rawAmount: b.rawAmount,
      monthsCredited: b.monthsCredited,
      blockTime: b.blockTime,
      creditedAt: b.creditedAt,
      discoveredBy: b.discoveredBy,
      // Distinct from burnerWallet only when a burn was credited to an account by hand.
      linkedWallet: b.user?.walletAddress ?? null,
      slot: b.slot.toString(),
    }));
  });

  /** Everyone with a subscription row, live or lapsed. */
  app.get("/subscriptions", async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const subs = await prisma.subscription.findMany({
      orderBy: { expiresAt: "desc" },
      take: limit,
      include: { user: { select: { walletAddress: true, _count: { select: { burns: true } } } } },
    });
    return subs.map((s) => ({
      walletAddress: s.user.walletAddress,
      expiresAt: s.expiresAt,
      source: s.source,
      burnCount: s.user._count.burns,
      updatedAt: s.updatedAt,
    }));
  });

  app.get("/whitelist", async () => {
    return prisma.whitelist.findMany({ orderBy: { createdAt: "desc" } });
  });

  app.post("/whitelist", async (request, reply) => {
    const parsed = whitelistSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { walletAddress, note, expiresAt } = parsed.data;
    const entry = await prisma.whitelist.upsert({
      where: { walletAddress },
      update: { note: note ?? null, expiresAt: expiresAt ?? null },
      create: {
        walletAddress,
        note: note ?? null,
        expiresAt: expiresAt ?? null,
        addedBy: request.user!.walletAddress,
      },
    });
    request.log.info({ walletAddress, by: request.user!.walletAddress }, "whitelisted a wallet");
    return entry;
  });

  app.delete("/whitelist/:walletAddress", async (request) => {
    const { walletAddress } = request.params as { walletAddress: string };
    const result = await prisma.whitelist.deleteMany({ where: { walletAddress } });
    request.log.info(
      { walletAddress, by: request.user!.walletAddress },
      "removed a wallet from the whitelist",
    );
    return { ok: true, removed: result.count > 0 };
  });

  /**
   * Extend a wallet's access by hand.
   *
   * The escape hatch for the cases automation can't reach: a burn from a wallet other than the one
   * they sign in with, a chain reorg nobody expected, a refund. Creates the user if they have
   * never signed in, so an address pasted from a support conversation works without them having to
   * log in first.
   */
  app.post("/subscriptions/grant", async (request, reply) => {
    const parsed = grantSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { walletAddress, days } = parsed.data;

    const user = await prisma.user.upsert({
      where: { walletAddress },
      update: {},
      create: { walletAddress },
      select: { id: true, subscription: { select: { expiresAt: true } } },
    });

    const current = user.subscription?.expiresAt ?? null;
    const now = new Date();
    const base = current !== null && current > now ? current : now;
    const expiresAt = new Date(base.getTime() + days * 86_400_000);

    await prisma.subscription.upsert({
      where: { userId: user.id },
      update: { expiresAt, source: AccessSource.ADMIN_GRANT },
      create: { userId: user.id, expiresAt, source: AccessSource.ADMIN_GRANT },
    });

    request.log.info({ walletAddress, days, by: request.user!.walletAddress }, "granted access by hand");
    return { walletAddress, expiresAt };
  });

  /**
   * One JSON snapshot of everything the chain cannot rebuild.
   *
   * The burn ledger is reconstructible by rescanning the mint - the chain is a second source of
   * truth for it. The whitelist and manual grants are not: they exist nowhere but this database,
   * so they are the part of the subscription system a database loss actually destroys. This
   * endpoint exists so an admin (or a cron hitting it with an admin session) can keep an
   * off-database copy of exactly that irreplaceable slice. Burns are included too - not because
   * they need backing up, but because restoring from a snapshot that already has them beats
   * waiting for a 400-day rescan.
   */
  app.get("/subscriptions/export", async () => {
    const [whitelist, subscriptions, burns] = await Promise.all([
      prisma.whitelist.findMany({ orderBy: { createdAt: "asc" } }),
      prisma.subscription.findMany({
        include: { user: { select: { walletAddress: true } } },
        orderBy: { updatedAt: "asc" },
      }),
      prisma.burnEvent.findMany({ orderBy: { createdAt: "asc" } }),
    ]);
    return {
      exportedAt: new Date(),
      whitelist,
      subscriptions: subscriptions.map((s) => ({
        walletAddress: s.user.walletAddress,
        expiresAt: s.expiresAt,
        source: s.source,
        updatedAt: s.updatedAt,
      })),
      burns: burns.map((b) => ({
        signature: b.signature,
        burnerWallet: b.burnerWallet,
        mint: b.mint,
        rawAmount: b.rawAmount,
        monthsCredited: b.monthsCredited,
        // BigInt cannot survive JSON.stringify - serialised explicitly, like the ledger route.
        slot: b.slot.toString(),
        blockTime: b.blockTime,
        creditedAt: b.creditedAt,
        discoveredBy: b.discoveredBy,
      })),
    };
  });

  /**
   * Revoke access outright, for a refund or an abuse case.
   *
   * Deletes the subscription rather than back-dating it, so the row doesn't linger looking like a
   * lapsed customer. The burn ledger is untouched - that is the record of what happened, and
   * editing it to make the present tidier would be falsifying it.
   */
  app.delete("/subscriptions/:walletAddress", async (request) => {
    const { walletAddress } = request.params as { walletAddress: string };
    const user = await prisma.user.findUnique({ where: { walletAddress }, select: { id: true } });
    if (!user) return { ok: true, revoked: false };
    const result = await prisma.subscription.deleteMany({ where: { userId: user.id } });
    request.log.info({ walletAddress, by: request.user!.walletAddress }, "revoked access");
    return { ok: true, revoked: result.count > 0 };
  });
}
