import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import {
  type Env,
  corsOriginList,
  adminWalletSet,
  createLogger,
  DexScreenerClient,
  GeckoTerminalClient,
  SolanaRpc,
  resolveAccess,
  decideAccess,
  prisma,
} from "@trenchscanner/core";
import { SAVED_FEED_SELECT, toSavedFeed } from "./contest.js";
import { createSessionSigner, verifyRequestSessions, type SessionPayload } from "./auth/session.js";
import { deviceIsActive, touchDevice } from "./auth/deviceLink.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceLinkRoutes } from "./routes/deviceLink.js";
import { registerFilterRoutes } from "./routes/filters.js";
import { registerMatchRoutes } from "./routes/matches.js";
import { createReportCaches, registerCuratedRoutes } from "./routes/curated.js";
import { registerGuestRoutes } from "./routes/guest.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAdminRoutes, registerAdminSubscriptionRoutes } from "./routes/admin.js";
import { registerAdminOpsRoutes } from "./routes/adminOps.js";
import { registerAdminInsightRoutes } from "./routes/adminInsights.js";
import { registerAdminBackupRoutes } from "./routes/adminBackups.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerLeaderboardRoutes } from "./routes/leaderboard.js";
import { registerSubscriptionRoutes } from "./routes/subscription.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerStatsModelRoutes } from "./routes/statsModels.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { MatchStream } from "./matchStream.js";
import { ViewStampBuffer } from "./viewStamps.js";
import { OnDemandLiveRefresher } from "./liveRefresh.js";
import { registerLiveRoutes, LIVE_TICK_MAX_TOKENS } from "./routes/live.js";
import { clientIp } from "./clientIp.js";
import { RouteTimings } from "./routeTimings.js";

const logger = createLogger("api");

/** Tokens one live refresh may look up: the live tick's limit, one DexScreener call. */
const LIVE_REFRESH_TOKEN_LIMIT = LIVE_TICK_MAX_TOKENS;
/**
 * DexScreener calls the API may spend on live refreshes per minute, across all readers. Its batch
 * endpoint allows 300 a minute; the worker uses its share from its own host. 120 covers ~20
 * distinct pages ticking every 10s; past it readers see the worker's once-a-minute numbers.
 */
const LIVE_REFRESH_CALLS_PER_MINUTE = 120;
/** A request this slow gets a log line of its own, so a slow call shows up without asking. */
const SLOW_REQUEST_LOG_MS = 2_000;

export async function buildServer(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });

  // Set before any route plugin is registered: Fastify hands each plugin the error handler in
  // force when it is registered, so a handler set at the end only covered the root context and
  // every routed 500 fell through to Fastify's default body - which carries the raw error
  // message (for Prisma, the database hostname). Details stay in the log; clients get a code.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    logger.error("unhandled route error", { url: request.url, error: err.message, stack: err.stack });
    const status = err.statusCode ?? 500;
    reply.code(status).send({ error: status >= 500 ? "internal_error" : err.message });
  });

  // Per-route response times for GET /stats/routes (see routeTimings.ts), and a Server-Timing
  // header so a browser's network panel shows how much of a slow request was the server. Event
  // streams are left out: they are hijacked and stay open for as long as the tab does.
  const timings = new RouteTimings();
  const routeKey = (request: FastifyRequest) =>
    `${request.method} ${request.routeOptions.url ?? "(unmatched)"}`;
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("server-timing", `app;dur=${reply.elapsedTime.toFixed(1)}`);
    return payload;
  });
  app.addHook("onResponse", async (request, reply) => {
    const route = routeKey(request);
    if (route.endsWith("/stream")) return;
    const ms = reply.elapsedTime;
    timings.record(route, ms, reply.statusCode);
    if (ms >= SLOW_REQUEST_LOG_MS)
      logger.warn("slow request", { route, ms: Math.round(ms), status: reply.statusCode });
  });

  await app.register(cors, {
    origin: corsOriginList(env),
    credentials: true,
    // Lets browsers reuse a preflight for 2h (Chrome's cap) instead of their 5s default, so the
    // dashboard's saves (feed settings, filters) don't each wait on an extra OPTIONS round trip.
    maxAge: 7200,
  });
  await app.register(cookie);

  /**
   * Cross-site request forgery guard for anything that changes state.
   *
   * The session cookie is SameSite=None while the API answers on onrender.com (see
   * sessionCookieAttrs), so a page on any site can make the browser attach it. CORS stops that
   * page READING the response, not the request running: a plain form POST still executes. Today
   * every write either takes a JSON body (which a form cannot send) or is harmless, but that is a
   * property of each route rather than a guarantee. Browsers always send Origin on a cross-site
   * POST/PUT/PATCH/DELETE, so refusing one from an origin outside CORS_ORIGINS closes the class.
   * Requests with no Origin (scripts, curl, server-to-server) are not browser CSRF and pass.
   */
  const allowedOrigins = new Set(corsOriginList(env));
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const origin = request.headers.origin;
    if (origin === undefined || allowedOrigins.has(origin)) return;
    reply.code(403).send({ error: "origin_not_allowed" });
  });

  /**
   * Compression. The feed responses are the reason: a page of twelve cards is ~33KB of JSON and
   * ~2.7KB gzipped, so this is a ~92% cut in what a phone on a bad connection has to pull down
   * before the dashboard can paint - and the dashboard re-fetches that page every 45 seconds.
   *
   * gzip only, deliberately. Brotli compresses these payloads a little smaller but costs several
   * times the CPU per response, and the API is CPU-bound before it is bandwidth-bound at the
   * concurrency this is sized for; spending cores to save a few hundred bytes is the wrong trade
   * here. Every browser that speaks brotli speaks gzip.
   *
   * The 1KB threshold keeps small replies (errors, /config, /health) uncompressed, where the
   * framing overhead can exceed the saving.
   *
   * Note this never touches the SSE endpoints: those call reply.hijack(), which skips Fastify's
   * onSend hooks entirely, so the stream stays unbuffered and un-encoded - which is what an event
   * stream needs.
   */
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["gzip", "deflate"],
  });

  // Pure JSON API - CSP/script-src directives don't apply to anything we serve, so they're
  // switched off to avoid meaningless header bloat. Everything else (nosniff, frame-deny, HSTS,
  // referrer-policy, ...) still applies.
  await app.register(helmet, { contentSecurityPolicy: false });

  /**
   * Registered globally so every route gets a sane default; individual routes (see auth.ts's
   * /nonce and /verify - the only unauthenticated, state-touching endpoints) tighten this further
   * via their own `config.rateLimit`.
   *
   * Keyed by session, falling back to IP. Keying purely by IP - which respects trustProxy above,
   * so it reads the real client address rather than Render's proxy - punishes people for who
   * their ISP is: a mobile carrier's CGNAT or an office egress puts many subscribers behind one
   * address, and they then share one budget. The dashboard makes roughly two to four requests a
   * minute per open tab, so a single IP could carry only a few dozen users before the rest
   * started getting 429s for someone else's polling. A signed session cookie is the better
   * identity here - it is per-user, it cannot be spoofed to somebody else's bucket, and it is
   * already parsed further down the request.
   *
   * Unauthenticated traffic still falls back to IP, which is the only identity it has, and that
   * is also the traffic the tighter per-route limits exist for.
   */
  app.decorate("sessionSigner", createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS));

  /**
   * The JWT verification, memoised per request.
   *
   * Both the rate limiter's key and the auth hooks need to know who is calling, and verifying the
   * same cookie twice per request is pure waste. Only the signature check is cached - the device
   * revocation lookup in resolveSession deliberately is not, because that check IS the revocation
   * and has to run every time.
   */
  const verifiedSessions = new WeakMap<FastifyRequest, SessionPayload[]>();
  async function verifySessions(request: FastifyRequest): Promise<SessionPayload[]> {
    const cached = verifiedSessions.get(request);
    if (cached) return cached;
    // The cookie, and the Authorization header from a browser that drops third-party cookies.
    const sessions = await verifyRequestSessions(app.sessionSigner, request);
    verifiedSessions.set(request, sessions);
    return sessions;
  }

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: async (request) => {
      // Verified, never merely present: an unverified cookie would let one client mint a fresh
      // bucket per request simply by changing the value, which is no rate limit at all.
      // Keyed by the session's revocation discriminator too, so a signed-out cookie somebody
      // copied before sign-out lands in its own bucket instead of draining the live user's.
      const session = (await verifySessions(request).catch(() => []))[0];
      if (!session) return `ip:${clientIp(request)}`;
      return `user:${session.userId}:${session.deviceId ? `d${session.deviceId}` : `v${session.sessionVersion}`}`;
    },
    // A preflight carries no credentials and is answered from a table; counting it against the
    // IP bucket let one office on a shared address spend its limit on OPTIONS.
    allowList: (request) => request.method === "OPTIONS",
  });

  // Shared by the three auth hooks below so the cookie-read-and-verify step (and any future
  // change to it) only lives in one place.
  //
  // Split from verifySession so authenticateSubscriber can run this revocation check and the
  // access lookup side by side: they are independent reads, and doing them one after the other
  // put three sequential round trips in front of every dashboard request.
  async function sessionStillValid(request: FastifyRequest, session: SessionPayload): Promise<boolean> {
    // A paired-phone session is only as good as its device row. The JWT itself cannot be
    // withdrawn once signed, so this lookup IS the revocation: switch the device off and the very
    // next request from that phone fails here. Desktop sessions carry no deviceId and skip it.
    if (session.deviceId) {
      if (!(await deviceIsActive(session.deviceId, session.userId))) return false;
      touchDevice(session.deviceId);
      return true;
    }

    // A browser session is only as good as the user's current sessionVersion: signing out bumps
    // it, so a copied cookie stops working everywhere at once instead of living out its TTL.
    // The feed settings ride along on the same row so the feeds don't look the user up again.
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { sessionVersion: true, ...SAVED_FEED_SELECT },
    });
    if (!user || user.sessionVersion !== (session.sessionVersion ?? 0)) return false;
    request.savedFeed = toSavedFeed(user);
    return true;
  }

  // The first of the request's sessions that is still live: a signed-out cookie must not shadow
  // a good header (or the reverse), so each is checked rather than only the first that verifies.
  async function resolveSession(request: FastifyRequest) {
    for (const session of await verifySessions(request)) {
      if (await sessionStillValid(request, session)) return session;
    }
    return null;
  }

  app.decorate("authenticate", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    request.user = session;
  });

  // Computed once at startup, not per-request - ADMIN_WALLET_ADDRESSES only ever changes via a
  // redeploy anyway.
  const admins = adminWalletSet(env);
  app.decorate("authenticateAdmin", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    request.user = session;
    if (!admins.has(session.walletAddress)) {
      reply.code(403).send({ error: "forbidden" });
      return;
    }
  });

  /**
   * Authenticated AND paid up - the Trenches paywall.
   *
   * 402 rather than 403, and that distinction carries real weight for the client: 401 means "sign
   * in", 403 means "this isn't for you", 402 means "this is for you once you've paid". The
   * frontend shows a different screen for each, and folding the third into the second would leave
   * a paying customer staring at a permission error.
   *
   * The response carries `expiresAt` even when it's in the past, so the paywall can say "expired
   * three days ago" rather than the much less helpful "you have no access".
   */
  app.decorate("authenticateSubscriber", async (request, reply) => {
    let session: SessionPayload | null = null;
    let access: Awaited<ReturnType<typeof subscriberCheck>> = null;
    // Same rule as resolveSession: the first session that is still live, not merely signed.
    for (const candidate of await verifySessions(request)) {
      access = await subscriberCheck(request, candidate);
      if (access) {
        session = candidate;
        break;
      }
    }
    if (!session || !access) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    request.user = session;

    if (!access.hasAccess) {
      reply.code(402).send({
        error: "subscription_required",
        expiresAt: access.expiresAt,
      });
      return;
    }
    request.access = access;
  });

  /**
   * The subscriber gate's reads: the session check and the access lookup. Null means the session
   * is no longer valid.
   *
   * A browser session - nearly every dashboard request - gets all of it from ONE statement: the
   * user's sessionVersion and feed settings, the wallet's Whitelist row, and the subscription of
   * whoever owns the wallet. That used to be four Prisma queries (the nested subscription select
   * is two) on three pool connections at once, in front of every request; the dashboard opens
   * with six requests together, so the gate alone wanted eighteen of the twelve connections the
   * API has, and the feed queries queued behind it. Device sessions keep the separate checks:
   * their revocation lives on the device row, and they are rare.
   */
  async function subscriberCheck(request: FastifyRequest, session: SessionPayload) {
    if (session.deviceId) {
      const [valid, access] = await Promise.all([
        sessionStillValid(request, session),
        resolveAccess(session.walletAddress, admins),
      ]);
      return valid ? access : null;
    }
    const rows = await prisma.$queryRaw<
      {
        found: boolean;
        sessionVersion: number | null;
        curatedModel: string | null;
        feedModels: string[] | null;
        showModelAlerts: boolean | null;
        followBestModel: boolean | null;
        whitelisted: boolean;
        whitelistExpiresAt: Date | null;
        subscriptionExpiresAt: Date | null;
      }[]
    >`
      SELECT (u."id" IS NOT NULL) AS found,
             u."sessionVersion", u."curatedModel", u."feedModels", u."showModelAlerts", u."followBestModel",
             (w."walletAddress" IS NOT NULL) AS whitelisted,
             w."expiresAt" AS "whitelistExpiresAt",
             (SELECT s."expiresAt"
                FROM "User" owner
                JOIN "Subscription" s ON s."userId" = owner."id"
               WHERE owner."walletAddress" = ${session.walletAddress}) AS "subscriptionExpiresAt"
      FROM (VALUES (1)) AS one(x)
      LEFT JOIN "User" u ON u."id" = ${session.userId}
      LEFT JOIN "Whitelist" w ON w."walletAddress" = ${session.walletAddress}`;
    const row = rows[0];
    // Same rule as sessionStillValid: signing out bumps sessionVersion, killing every older cookie.
    if (!row?.found || row.sessionVersion !== (session.sessionVersion ?? 0)) return null;
    request.savedFeed = toSavedFeed({
      curatedModel: row.curatedModel,
      feedModels: row.feedModels ?? [],
      showModelAlerts: row.showModelAlerts ?? true,
      followBestModel: row.followBestModel ?? true,
    });
    return decideAccess(
      session.walletAddress,
      admins,
      row.whitelisted ? { expiresAt: row.whitelistExpiresAt } : null,
      row.subscriptionExpiresAt,
    );
  }

  // The API's only outbound data source. Used for one thing: refreshing the market caps on a page
  // the moment it's opened, instead of leaving them until the worker's next tick - see
  // liveRefresh.ts for how that's kept from becoming a per-request upstream call.
  const dexScreener = new DexScreenerClient({
    baseUrl: env.DEXSCREENER_BASE_URL,
    requestsPerMinute: LIVE_REFRESH_CALLS_PER_MINUTE,
    // A small share of GeckoTerminal's 30 a minute: the worker takes the rest.
    fallback: new GeckoTerminalClient(
      env.COINGECKO_API_KEY
        ? { apiKey: env.COINGECKO_API_KEY, priorityPerMinute: 1, backgroundPerMinute: 30 }
        : { priorityPerMinute: 1, backgroundPerMinute: 6 },
    ),
  });
  // One per process, shared by every route, so its in-flight sharing, cooldown and call budget
  // hold across the feeds and the live tick rather than per route.
  const liveRefresher = new OnDemandLiveRefresher(dexScreener, {
    maxAgeMs: env.LIVE_PRICE_INTERVAL_MINUTES * 60_000,
    limit: LIVE_REFRESH_TOKEN_LIMIT,
    callsPerMinute: LIVE_REFRESH_CALLS_PER_MINUTE,
    peakWindowDays: env.SNAPSHOT_RETENTION_DAYS,
  });

  // Reads the chain for the subscription gate: verifying burns, relaying signed transactions, and
  // feeding the reconciler. Separate from the enrichment path's Helius client because this one
  // insists on `finalized` commitment - see SolanaRpc.
  const rpc = new SolanaRpc({
    rpcUrl: env.SOLANA_RPC_URL || undefined,
    apiKey: env.HELIUS_API_KEY || undefined,
  });

  // Holds one Postgres LISTEN connection and pushes new matches to connected dashboards the moment
  // the worker records them - see matchStream.ts. Built here rather than in index.ts so a server
  // constructed for a test gets a working stream too, and torn down on close so nothing leaks
  // between test servers or blocks shutdown.
  //
  // preClose, not onClose: Fastify runs onClose only after the HTTP server has finished closing,
  // and the server waits for every open connection - which a hijacked event stream never ends on
  // its own. With one tab open, close() hung forever and the hook that would have ended the
  // stream never ran.
  //
  // Declared before any route is registered, not after: Fastify creates a plugin's encapsulated
  // instance at register time, so a decoration added later only reaches it through the prototype
  // chain. That happens to work, but it is far too subtle a thing for /health/stream to depend on.
  const matchStream = new MatchStream(env.DATABASE_URL);
  matchStream.start();
  app.decorate("matchStream", matchStream);
  app.addHook("preClose", async () => {
    await matchStream.stop();
  });

  // Batches the Token.lastViewedAt stamps both feeds make, so a page load no longer pays for a
  // write transaction and concurrent readers of the same page stop queueing on the same rows.
  // Flushed on shutdown so the last page anyone opened still counts. See viewStamps.ts.
  const viewStamps = new ViewStampBuffer();
  app.addHook("onClose", async () => {
    await viewStamps.stop();
  });

  await app.register(registerHealthRoutes, { prefix: "/health", env });
  await app.register(registerConfigRoutes, { prefix: "/config", env });

  await app.register(registerAuthRoutes, { prefix: "/auth", env });

  await app.register(registerDeviceLinkRoutes, { prefix: "/auth", env });
  await app.register(registerFilterRoutes, { prefix: "/filters", env });
  await app.register(registerMatchRoutes, {
    prefix: "/matches",
    env,
    liveRefresher,
    matchStream,
    viewStamps,
  });
  await app.register(registerLiveRoutes, { prefix: "/live", liveRefresher, viewStamps });
  // Report caches warm themselves once the server is actually listening - so a real start pays
  // for its first fills before any reader does, and a test server (inject, never listen) runs none.
  const warmers: (() => void)[] = [];
  app.addHook("onListen", async () => {
    for (const warm of warmers) warm();
  });

  // The Models tab's reports, read by subscribers (/curated) and guests (/guest) from one fill.
  const reports = createReportCaches();
  await app.register(registerCuratedRoutes, {
    prefix: "/curated",
    reports,
    env,
    liveRefresher,
    matchStream,
    viewStamps,
    warmers,
  });
  // The read-only feed for visitors without a wallet: its own route, so no paid route's gate is loosened.
  await app.register(registerGuestRoutes, { prefix: "/guest", env, viewStamps, reports });
  await app.register(registerTokenRoutes, { prefix: "/tokens" });
  await app.register(registerLeaderboardRoutes, { prefix: "/leaderboard" });
  await app.register(registerSubscriptionRoutes, { prefix: "/subscription", env, rpc });
  await app.register(registerSettingsRoutes, { prefix: "/settings", env });
  // Token-guarded (STATS_API_TOKEN), not session-guarded: read by scripts, not the dashboard.
  await app.register(registerStatsRoutes, { prefix: "/stats", env, timings, liveRefresher });
  await app.register(registerStatsModelRoutes, { prefix: "/stats", env });
  await app.register(registerAdminRoutes, { prefix: "/admin", env });
  // Same /admin prefix and the same authenticateAdmin gate, registered separately only to keep
  // the subscription surface in its own readable block - see routes/admin.ts.
  await app.register(
    async (instance) => {
      instance.addHook("preHandler", instance.authenticateAdmin);
      await registerAdminSubscriptionRoutes(instance);
    },
    { prefix: "/admin" },
  );
  // The dashboard Admin tab's operational reads (worker, hit rates, database, API, AI) - the
  // /stats reports behind the admin wallet check instead of the script token. See routes/adminOps.ts.
  await app.register(
    async (instance) => {
      instance.addHook("preHandler", instance.authenticateAdmin);
      await registerAdminOpsRoutes(instance, { env, timings, liveRefresher });
      // TokenSage, the safety screen, training history, filters and outside lookups.
      await registerAdminInsightRoutes(instance);
    },
    { prefix: "/admin" },
  );
  // Model backups: list, take, download, import, pin, restore - see routes/adminBackups.ts. Gated
  // at onRequest rather than preHandler: the import takes a large body, and nobody but an admin
  // should get as far as having one read.
  await app.register(
    async (instance) => {
      instance.addHook("onRequest", instance.authenticateAdmin);
      await registerAdminBackupRoutes(instance, { env });
    },
    { prefix: "/admin" },
  );

  return app;
}
