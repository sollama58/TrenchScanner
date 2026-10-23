import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import websocket from "@fastify/websocket";
import {
  type Env,
  corsOriginList,
  adminWalletSet,
  createLogger,
  DexScreenerClient,
  GeckoTerminalClient,
  HeliusClient,
  HeliusIdentityClient,
  JupiterClient,
  SolanaRpc,
  resolveAccess,
  decideAccess,
  prisma,
  withApiFeature,
  configureMintSupplies,
  MintSupplies,
} from "@trenchscanner/core";
import { registerEtag } from "./etag.js";
import { SAVED_FEED_SELECT, toSavedFeed } from "./contest.js";
import {
  adminSessionFresh,
  createSessionSigner,
  verifyRequestSessions,
  type SessionPayload,
} from "./auth/session.js";
import { deviceIsActive, touchDevice } from "./auth/deviceLink.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceLinkRoutes } from "./routes/deviceLink.js";
import { registerTwoFactorRoutes } from "./routes/twoFactor.js";
import { registerFilterRoutes } from "./routes/filters.js";
import { registerMatchRoutes } from "./routes/matches.js";
import { createReportCaches, registerCuratedRoutes } from "./routes/curated.js";
import { registerGuestRoutes } from "./routes/guest.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerCandleRoutes } from "./routes/candles.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerKolAvatarRoutes } from "./routes/kolAvatars.js";
import { registerAdminRoutes, registerAdminSubscriptionRoutes } from "./routes/admin.js";
import { registerAdminOpsRoutes } from "./routes/adminOps.js";
import { registerAdminCreditRoutes } from "./routes/adminCredits.js";
import { registerAdminUsageRoutes } from "./routes/adminUsage.js";
import { registerAdminEnvRoutes } from "./routes/adminEnv.js";
import { registerAdminRetrainRoutes } from "./routes/adminRetrain.js";
import { registerAdminJobRunRoutes } from "./routes/adminJobRuns.js";
import { registerAdminInsightRoutes } from "./routes/adminInsights.js";
import { registerAdminModelRoutes } from "./routes/adminModels.js";
import { registerAdminWalletRoutes } from "./routes/adminWallets.js";
import { registerAdminBackupRoutes } from "./routes/adminBackups.js";
import { registerAdminFreeAccessRoutes } from "./routes/adminFreeAccess.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerAdminAnnouncementRoutes, registerAnnouncementRoutes } from "./routes/announcements.js";
import { registerAdminFeedbackRoutes, registerFeedbackRoutes } from "./routes/feedback.js";
import { registerClientErrorRoutes } from "./routes/clientErrors.js";
import { registerLeaderboardRoutes } from "./routes/leaderboard.js";
import { registerSubscriptionRoutes } from "./routes/subscription.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { registerStatsModelRoutes } from "./routes/statsModels.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerModelAlertKeyRoutes } from "./routes/modelAlertKeys.js";
import { registerModelAlertSocket } from "./routes/modelAlertSocket.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { registerUtilityRoutes } from "./routes/utilities.js";
import { registerXPreviewRoutes } from "./routes/xPreview.js";
import { registerWalletRoutes } from "./routes/wallets.js";
import { WalletLiveReader } from "./walletProfile.js";
import { prismaIdentityStore, WalletIdentityReader } from "./walletIdentity.js";
import { registerTradingRoutes } from "./routes/trading.js";
import { registerProTradeRoutes } from "./routes/proTrade.js";
import { registerPortfolioRoutes } from "./routes/portfolio.js";
import { registerProTradesRoutes } from "./routes/proTrades.js";
import { registerAdminProModeRoutes } from "./routes/adminProMode.js";
import { MatchStream } from "./matchStream.js";
import { ModelAlertHub } from "./modelAlertHub.js";
import { loadModelAlert } from "./modelAlertPayload.js";
import { modelAlertKeyAccess } from "./modelAlertKey.js";
import { ViewStampBuffer } from "./viewStamps.js";
import { OnDemandLiveRefresher } from "./liveRefresh.js";
import { registerLiveRoutes, LIVE_TICK_MAX_TOKENS } from "./routes/live.js";
import { registerLaunchRoutes } from "./routes/launches.js";
import { clientIp } from "./clientIp.js";
import { RouteTimings } from "./routeTimings.js";
import { fastifyLogger } from "./fastifyLogger.js";
import { liveCurves, liveCurvesFor, setLiveCurves } from "./liveCurve.js";
import { liveTrades, liveTradesFor, setLiveTrades } from "./liveTrades.js";
import { FlaggedTradeSaver, prismaFlaggedTradeStore } from "./chartFlaggedTrades.js";
import { defaultChartMarkFiller, setChartMarkFiller } from "./chartMarkFill.js";
import { dexScreenerQuote, jupiterQuote, QuotePrice, sharedSolPrice } from "./solPrice.js";
import { recordAdminActions } from "./adminActionLog.js";
import { chartReaderFor } from "./chartRpc.js";
import { startChartAlerts } from "./chartHealth.js";
import { adminTelegramNotifier } from "./adminTelegram.js";

const logger = createLogger("api");

/** Tokens one live refresh may look up: the live tick's limit, one DexScreener call. */
const LIVE_REFRESH_TOKEN_LIMIT = LIVE_TICK_MAX_TOKENS;
/**
 * DexScreener calls the API may spend on live refreshes per minute, across all readers. Its batch
 * endpoint allows 300 a minute; the worker uses its share from its own host. 120 covers ~20
 * distinct pages ticking every 10s; past it readers see the worker's once-a-minute numbers.
 */
const LIVE_REFRESH_CALLS_PER_MINUTE = 120;
/**
 * The share of that one reader may spend. One dashboard ticking every 10s needs about 6 a minute;
 * 15 leaves room for paging and a second tab, while keeping one subscriber walking
 * /matches?page=2..500 from spending the budget every other reader's live tick runs on.
 */
const LIVE_REFRESH_CALLS_PER_USER_PER_MINUTE = 15;
/** A request this slow gets a log line of its own, so a slow call shows up without asking. */
const SLOW_REQUEST_LOG_MS = 2_000;
/**
 * Longest a fresh instance answers /health with 503 while its report caches fill; past this it
 * goes healthy regardless, with whatever the keeper has filled (the Models tab's reports come
 * first). Under a minute on purpose: Render restarts a running instance whose checks fail for
 * 60 seconds, so a longer hold could turn a crash restart into a restart loop.
 */
const REPORT_WARM_CAP_MS = 45_000;
/**
 * Largest request body any route takes unless it sets its own. Every body the API reads is a small
 * JSON object (the biggest real one, POST /wallets/names with 200 addresses, is ~10KB), and a body
 * is read and parsed BEFORE the auth preHandlers run, so Fastify's 1MB default let an anonymous
 * caller make the API parse a megabyte of JSON per request on any authenticated POST before
 * answering 401. The Telegram webhook and the admin backup import set their own larger limits.
 */
const BODY_LIMIT_BYTES = 64 * 1024;
/**
 * How long a client may take to send its whole request (headers and body). Fastify's default is
 * no limit, so a client trickling a body a byte at a time held a socket open indefinitely. Two
 * minutes leaves the 64MB admin backup import room on a slow upload. Responses are not covered:
 * the live streams stay open as long as the tab does.
 */
const REQUEST_TIMEOUT_MS = 120_000;
/**
 * Rate-limit buckets held in memory, across every route (one entry per caller per route). The
 * plugin's default of 5,000 is a least-recently-used map: a few thousand rotating source addresses
 * pushed every real caller's bucket out, and an evicted bucket starts again at zero, so every
 * limit - the sign-in ones and the per-user Helius budgets alike - stopped holding exactly when
 * it mattered. An entry is a couple of hundred bytes, so this is ~20MB at the worst.
 */
const RATE_LIMIT_BUCKETS = 100_000;

export async function buildServer(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: fastifyLogger(),
    disableRequestLogging: true,
    trustProxy: true,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
  });

  // Set before any route plugin is registered: Fastify hands each plugin the error handler in
  // force when it is registered, so a handler set at the end only covered the root context and
  // every routed 500 fell through to Fastify's default body - which carries the raw error
  // message (for Prisma, the database hostname). Details stay in the log; clients get a code.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    const status = err.statusCode ?? 500;
    // The route's pattern, not the URL: a URL can carry a user's wallet (a 429 on /wallets/<their
    // own>), and logs never hold our users' wallets (user ask 2026-10-18). No route: the bare path.
    const url = request.routeOptions.url ?? request.url.split("?")[0];
    // A 4xx here is the client's fault (a body over the cap, malformed JSON): one short line, no
    // stack, so a caller sending junk on a loop can't fill the log with stack traces.
    if (status >= 500) logger.error("unhandled route error", { url, error: err.message, stack: err.stack });
    else logger.warn("rejected request", { url, status, error: err.message });
    reply.code(status).send({ error: status >= 500 ? "internal_error" : err.message });
  });

  // Outside calls a route makes (a live price, a burn check, chart candles) are counted under the
  // route in Admin > API usage - see withApiFeature in core's apiUsage.ts. Added before any route
  // is registered, so every plugin's routes inherit it.
  app.addHook("onRoute", (route) => {
    // The websocket handler is (socket, request), not (request, reply). Wrapping it would hand
    // the socket to withApiFeature as if it were a request. @fastify/websocket reads route.handler.
    if ((route as { websocket?: boolean }).websocket) return;
    const handler = route.handler;
    const feature = `api ${route.url}`;
    route.handler = function (this: FastifyInstance, request, reply) {
      return withApiFeature(feature, () => handler.call(this, request, reply));
    };
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
    // Streams and the Model Alert socket stay open for the life of the connection. Timing them
    // would record that whole life as one slow request.
    if (route.endsWith("/stream") || route.endsWith("/v1/model-alerts")) return;
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
    return reply.code(403).send({ error: "origin_not_allowed" });
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
  // Before compression: it hashes the JSON, and a 304 it answers has no body to compress.
  registerEtag(app);
  await app.register(compress, {
    global: true,
    threshold: 1024,
    encodings: ["gzip", "deflate"],
  });

  // Pure JSON API - CSP/script-src directives don't apply to anything we serve, so they're
  // switched off to avoid meaningless header bloat. Everything else (nosniff, frame-deny, HSTS,
  // referrer-policy, ...) still applies.
  await app.register(helmet, { contentSecurityPolicy: false });
  // Before any route: the Model Alert socket is a later plugin, and this one adds the upgrade
  // hook the route's `websocket: true` depends on. Errors here must not log the request URL:
  // it can carry the API key.
  await app.register(websocket, {
    // One inbound frame is an auth message of a few dozen bytes. The library's default is
    // 100MB, which a client can make this process buffer. Over the cap the socket is closed.
    options: { maxPayload: 1024 },
    errorHandler: (error, socket, request) => {
      // The route pattern, never the URL: a client can still put a key in the query string,
      // and this log must not keep it. A too-large frame is a fixed line, not error.message,
      // so the frame itself cannot ride along in the log.
      const tooBig = (error as { code?: string }).code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      logger.warn(tooBig ? "websocket frame rejected" : "websocket error", {
        url: request.routeOptions?.url ?? request.url.split("?")[0],
        error: tooBig ? "frame_too_large" : error.message,
      });
      if (tooBig) {
        try {
          socket.close(1009, "message_too_big");
        } catch {
          socket.terminate();
        }
        return;
      }
      socket.terminate();
    },
  });

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
  // Computed once at startup, not per-request - ADMIN_WALLET_ADDRESSES only ever changes via a
  // redeploy anyway.
  const admins = adminWalletSet(env);
  async function verifySessions(request: FastifyRequest): Promise<SessionPayload[]> {
    const cached = verifiedSessions.get(request);
    if (cached) return cached;
    // The cookie, and the Authorization header from a browser that drops third-party cookies.
    // An admin wallet's session, browser or paired phone, lasts at most ADMIN_SESSION_MAX_AGE_MS
    // from its sign-in whatever its own expiry says (user decision after the 2026-10-16 security
    // audit): admin then signs in with the wallet again, or scans a fresh QR.
    const now = Date.now();
    const sessions = (await verifyRequestSessions(app.sessionSigner, request)).filter(
      (s) => !admins.has(s.walletAddress) || adminSessionFresh(s, now),
    );
    verifiedSessions.set(request, sessions);
    return sessions;
  }

  const rateLimitKey = async (request: FastifyRequest): Promise<string> => {
    // Verified, never merely present: an unverified cookie would let one client mint a fresh
    // bucket per request simply by changing the value, which is no rate limit at all.
    // Keyed by the session's revocation discriminator too, so a signed-out cookie somebody
    // copied before sign-out lands in its own bucket instead of draining the live user's.
    const session = (await verifySessions(request).catch(() => []))[0];
    if (!session) return `ip:${clientIp(request)}`;
    return `user:${session.userId}:${session.deviceId ? `d${session.deviceId}` : `v${session.sessionVersion}`}`;
  };
  // Routes that key their own limit finer (the charts' long polls, per coin: longPollLimit.ts) start from it.
  app.decorate("rateLimitKey", rateLimitKey);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    cache: RATE_LIMIT_BUCKETS,
    keyGenerator: rateLimitKey,
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
    // The columns /auth/me returns ride along too: that route used to read the row again.
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: {
        sessionVersion: true,
        id: true,
        walletAddress: true,
        createdAt: true,
        privyUserId: true,
        ...SAVED_FEED_SELECT,
      },
    });
    if (!user || user.sessionVersion !== (session.sessionVersion ?? 0)) return false;
    request.savedFeed = toSavedFeed(user);
    // privyUserId is how /auth/me tells a Privy account from a wallet one: without it every re-read
    // answered "wallet" and Settings dropped the Privy wallet card after the first check.
    request.sessionUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      createdAt: user.createdAt,
      privyUserId: user.privyUserId,
    };
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
      return reply.code(401).send({ error: "unauthenticated" });
    }
    request.user = session;
  });

  app.decorate("identify", async (request) => {
    const session = await resolveSession(request);
    if (session) request.user = session;
  });

  app.decorate("authenticateAdmin", async (request, reply) => {
    const session = await resolveSession(request);
    if (!session) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    request.user = session;
    if (!admins.has(session.walletAddress)) {
      return reply.code(403).send({ error: "forbidden" });
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
      return reply.code(401).send({ error: "unauthenticated" });
    }
    request.user = session;

    if (!access.hasAccess) {
      return reply.code(402).send({
        error: "subscription_required",
        expiresAt: access.expiresAt,
      });
    }
    request.access = access;
  });

  /**
   * The subscriber gate's reads: the session check and the access lookup. Null means the session
   * is no longer valid.
   *
   * A browser session - nearly every dashboard request - gets all of it from ONE statement: the
   * user's sessionVersion and feed settings, the wallet's Whitelist row, the subscription of
   * whoever owns the wallet, and its free access (freeAccess.ts in core). That used to be four
   * Prisma queries (the nested subscription select is two) on three pool connections at once, in front of every request; the dashboard opens
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
        feedBothOnly: boolean | null;
        whitelisted: boolean;
        whitelistExpiresAt: Date | null;
        subscriptionExpiresAt: Date | null;
        freeAccessUntil: Date | null;
      }[]
    >`
      SELECT (u."id" IS NOT NULL) AS found,
             u."sessionVersion", u."curatedModel", u."feedModels", u."showModelAlerts", u."followBestModel", u."feedBothOnly",
             (w."walletAddress" IS NOT NULL) AS whitelisted,
             w."expiresAt" AS "whitelistExpiresAt",
             (SELECT s."expiresAt"
                FROM "User" owner
                JOIN "Subscription" s ON s."userId" = owner."id"
               WHERE owner."walletAddress" = ${session.walletAddress}) AS "subscriptionExpiresAt",
             (SELECT MAX(p."accessEndsAt")
                FROM "FreeAccessGrant" g
                JOIN "FreeAccessPeriod" p ON p."id" = g."periodId"
               WHERE g."walletAddress" = ${session.walletAddress}
                 AND p."purgedAt" IS NULL AND p."disabledAt" IS NULL) AS "freeAccessUntil"
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
      feedBothOnly: row.feedBothOnly ?? false,
    });
    return decideAccess(
      session.walletAddress,
      admins,
      row.whitelisted ? { expiresAt: row.whitelistExpiresAt } : null,
      row.subscriptionExpiresAt,
      new Date(),
      row.freeAccessUntil,
    );
  }

  // The API's only outbound data sources. Used for one thing: refreshing the market caps on a page
  // the moment it's opened, instead of leaving them until the worker's next tick - see
  // liveRefresh.ts for how that's kept from becoming a per-request upstream call.
  const dexScreener = new DexScreenerClient({
    baseUrl: env.DEXSCREENER_BASE_URL,
    requestsPerMinute: LIVE_REFRESH_CALLS_PER_MINUTE,
    // A small share of GeckoTerminal's 30 a minute: the worker takes the rest.
    launchHomeClock: env.LAUNCH_HOME_CLOCK,
    fallback: new GeckoTerminalClient(
      env.COINGECKO_API_KEY
        ? {
            apiKey: env.COINGECKO_API_KEY,
            priorityPerMinute: 1,
            backgroundPerMinute: 30,
            launchHomeClock: env.LAUNCH_HOME_CLOCK,
          }
        : { priorityPerMinute: 1, backgroundPerMinute: 6, launchHomeClock: env.LAUNCH_HOME_CLOCK },
    ),
    // A page's "Now" (and the Peak it folds in) re-priced from Jupiter when DexScreener's reading
    // has stopped at a stale price - see DexScreenerClient.correctStalePrices. A handful of calls a
    // minute at most: 100 mints a call, each asked about at most every two minutes.
    staleCheck: env.JUPITER_API_KEY
      ? new JupiterClient({
          apiKey: env.JUPITER_API_KEY,
          requestsPerMinute: 6,
          burst: 2,
          launchHomeClock: env.LAUNCH_HOME_CLOCK,
        })
      : undefined,
  });
  // One per process, shared by every route, so its in-flight sharing, cooldown and call budget
  // hold across the feeds and the live tick rather than per route.
  const liveRefresher = new OnDemandLiveRefresher(dexScreener, {
    maxAgeMs: env.LIVE_PRICE_INTERVAL_MINUTES * 60_000,
    limit: LIVE_REFRESH_TOKEN_LIMIT,
    callsPerMinute: LIVE_REFRESH_CALLS_PER_MINUTE,
    callsPerUserPerMinute: LIVE_REFRESH_CALLS_PER_USER_PER_MINUTE,
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
  // Curated NOTIFY ids, for sockets that authenticated with a Model Alert key. Stopped in the
  // same preClose as the LISTEN connection, before the HTTP server waits on open sockets.
  const modelAlertHub = new ModelAlertHub(
    matchStream,
    loadModelAlert,
    async (wallet) => modelAlertKeyAccess(await resolveAccess(wallet, admins)),
    async (keyIds) => {
      if (keyIds.length === 0) return new Set<string>();
      const rows = await prisma.userApiKey.findMany({
        where: { id: { in: [...keyIds] }, revokedAt: null },
        select: { id: true },
      });
      return new Set(rows.map((row) => row.id));
    },
  );
  app.addHook("preClose", async () => {
    modelAlertHub.stop();
    await matchStream.stop();
  });

  // Batches the Token.lastViewedAt stamps both feeds make, so a page load no longer pays for a
  // write transaction and concurrent readers of the same page stop queueing on the same rows.
  // Flushed on shutdown so the last page anyone opened still counts. See viewStamps.ts.
  const viewStamps = new ViewStampBuffer();
  // The same for Token.holdersViewedAt: a token view with its bubble map open (user ask 2026-10-19).
  const holderStamps = new ViewStampBuffer({ stamp: "holders" });
  app.addHook("onClose", async () => {
    await Promise.all([viewStamps.stop(), holderStamps.stop()]);
  });

  // Set once listening, cleared when the report keeper's first pass ends (or REPORT_WARM_CAP_MS
  // passes): /health answers 503 meanwhile. Never set on a test server, which never listens.
  let warming = false;
  await app.register(registerHealthRoutes, { prefix: "/health", env, warming: () => warming });
  await app.register(registerConfigRoutes, { prefix: "/config", env });
  // KOLs' X pictures (user ask 2026-10-18): public, as on X, since an <img> sends no session.
  await app.register(registerKolAvatarRoutes, { prefix: "/kol-avatars" });
  // Public like /config: the admin's banner shows to guests and the signed-out page too.
  await app.register(registerAnnouncementRoutes, { prefix: "/announcement" });

  // The bug button's reports: guests may send them too, so this is outside every auth gate.
  await app.register(registerFeedbackRoutes, { prefix: "/feedback", env });
  // The web's error boundaries, reported and counted in chart health (clientErrors.ts): outside
  // every auth gate too, since a crash can come before sign-in.
  await app.register(registerClientErrorRoutes, { prefix: "/client-errors" });

  await app.register(registerAuthRoutes, { prefix: "/auth", env });

  await app.register(registerDeviceLinkRoutes, { prefix: "/auth", env });
  await app.register(registerTwoFactorRoutes, { prefix: "/auth/2fa", env });
  await app.register(registerFilterRoutes, { prefix: "/filters", env });
  await app.register(registerMatchRoutes, {
    prefix: "/matches",
    env,
    liveRefresher,
    matchStream,
    viewStamps,
  });
  await app.register(registerLiveRoutes, {
    prefix: "/live",
    liveRefresher,
    viewStamps,
    peakWindowDays: env.SNAPSHOT_RETENTION_DAYS,
  });
  // The dashboard's Stream: every new token that passed the safety screen inside the band.
  await app.register(registerLaunchRoutes, { prefix: "/launches", env });
  // Report caches warm themselves once the server is actually listening - so a real start pays
  // for its first fills before any reader does, and a test server (inject, never listen) runs none.
  const warmers: (() => void)[] = [];
  let warmCap: ReturnType<typeof setTimeout> | undefined;
  const warmed = () => {
    warming = false;
    clearTimeout(warmCap);
  };
  app.addHook("onListen", async () => {
    warming = true;
    // However slow the first pass is, the instance goes healthy within the cap: a deploy must
    // never fail because the database was slow to answer a report.
    warmCap = setTimeout(warmed, REPORT_WARM_CAP_MS);
    warmCap.unref();
    for (const warm of warmers) warm();
  });

  // The Models tab's reports, read by subscribers (/curated) and guests (/guest) from one fill.
  const reports = createReportCaches(env);
  await app.register(registerCuratedRoutes, {
    prefix: "/curated",
    reports,
    env,
    liveRefresher,
    matchStream,
    viewStamps,
    warmers,
    ready: warmed,
  });
  // The read-only feed for visitors without a wallet: its own route, so no paid route's gate is loosened.
  await app.register(registerGuestRoutes, { prefix: "/guest", env, viewStamps, reports });
  // The wallet modal. Its chain read (balance, history, a missing funder) needs a Helius key;
  // without one the modal shows what the database knows. The token modal's Stonk fee card reads
  // through the same client.
  const walletHelius = env.HELIUS_API_KEY ? new HeliusClient({ apiKey: env.HELIUS_API_KEY }) : null;
  // The chart, live tail, live trades and positions put Pump.fun's launch-billion caps on each coin's
  // supply now (mintSupply.ts): a mint read, shared by every reader of the coin for a minute.
  configureMintSupplies(new MintSupplies(walletHelius ?? new HeliusClient({})));
  // The token chart's live tail follows open charts' curves on its own Helius socket (liveCurve.ts).
  const solPrice = sharedSolPrice;
  // Read once listening, so the first chart answers after a deploy don't wait on three providers
  // (charts audit item 12). A test server never listens and reads none.
  app.addHook("onListen", async () => {
    void solPrice.warm();
  });
  // One quote-coin price for both: a coin quoted in PUMP or USD1 is read once for its chart and trades.
  // Jupiter first, then DexScreener (its decimals off the mint, by Helius) when Jupiter fails.
  const quotePrice = new QuotePrice(
    walletHelius
      ? [jupiterQuote, dexScreenerQuote(dexScreener, (mints) => walletHelius.getMintDecimals(mints))]
      : [jupiterQuote],
  );
  // Its RPC reads go on their own Helius 429 lane, and what Helius doesn't answer is asked once more
  // of SOLANA_RPC_URL when that is another endpoint (chartRpc.ts; user ask 2026-10-19: "can we have
  // multiple data sources?").
  setLiveCurves(
    liveCurvesFor(
      env.HELIUS_API_KEY,
      env.CHART_LIVE_CURVES,
      chartReaderFor(env.HELIUS_API_KEY, env.SOLANA_RPC_URL),
      solPrice,
      quotePrice,
    ),
  );
  app.addHook("onClose", async () => liveCurves().stop());
  // After a deploy every open chart asks again at once: the chart socket is open before they do.
  app.addHook("onListen", async () => void liveCurves().warm());
  // The charts' health (chartHealth.ts): the admins hear on Telegram when candles go blank or the
  // chart socket stalls for many users at once.
  const notifyAdmins = adminTelegramNotifier(env);
  if (notifyAdmins) {
    const stopAlerts = startChartAlerts(notifyAdmins);
    app.addHook("onClose", async () => stopAlerts());
  }
  // The token page's live trades follow open pages' coins' logs on another Helius socket
  // (liveTrades.ts), behind the same switch as the chart's.
  setLiveTrades(liveTradesFor(env.HELIUS_API_KEY, env.CHART_LIVE_CURVES, solPrice, quotePrice, walletHelius));
  app.addHook("onClose", async () => liveTrades().stop());
  // Flagged wallets' trades among them are saved for the chart's marks (chartFlaggedTrades.ts),
  // once listening: a test server never listens and saves none.
  const flaggedSaver = new FlaggedTradeSaver(liveTrades(), prismaFlaggedTradeStore);
  app.addHook("onListen", async () => flaggedSaver.start());
  app.addHook("onClose", async () => flaggedSaver.stop());
  // Opening a coin's chart keeps its saved marks longer and fills in the stretches nobody watched
  // (chartMarkFill.ts), from Pump.fun's free trade API; once listening, as the saver.
  app.addHook("onListen", async () => setChartMarkFiller(defaultChartMarkFiller()));
  app.addHook("onClose", async () => setChartMarkFiller(null));
  await app.register(registerTokenRoutes, {
    prefix: "/tokens",
    env,
    stonkFees: walletHelius,
    holderStamps,
    dexScreener,
  });
  // GET /tokens/:mint/candles: the closed-candle store's bars, one timeframe (routes/candles.ts).
  await app.register(registerCandleRoutes, { prefix: "/tokens", env });
  const walletLive = walletHelius ? new WalletLiveReader(walletHelius) : null;
  // Helius's name for it (exchanges, protocols, services): its identity API, on paid plans.
  const walletIdentity = env.HELIUS_API_KEY
    ? new WalletIdentityReader(new HeliusIdentityClient(env.HELIUS_API_KEY), {}, prismaIdentityStore())
    : null;
  app.addHook("onClose", async () => walletIdentity?.stop());
  await app.register(registerWalletRoutes, {
    prefix: "/wallets",
    env,
    live: walletLive,
    identity: walletIdentity,
  });
  await app.register(registerLeaderboardRoutes, { prefix: "/leaderboard" });
  await app.register(registerSubscriptionRoutes, { prefix: "/subscription", env, rpc });
  // The Utilities tab: token and wallet lookups paid for with Burn Credits.
  await app.register(registerUtilityRoutes, {
    prefix: "/utilities",
    dexScreener,
    rpc,
    viewStamps,
    walletLive,
  });
  // Hover previews of a coin's X link, read through FxTwitter so the browser never loads X.
  await app.register(registerXPreviewRoutes, { prefix: "/x-preview" });
  await app.register(registerSettingsRoutes, { prefix: "/settings", env });
  await app.register(registerModelAlertKeyRoutes, { prefix: "/settings", env, hub: modelAlertHub });
  await app.register(registerModelAlertSocket, { hub: modelAlertHub, env });
  // Telegram alerts: link codes and chats for the signed-in account, and the bot's webhook.
  await app.register(registerTelegramRoutes, { prefix: "/telegram", env });
  // The trading bot (admin-only; nothing is registered without TRADING_BOT_ENABLED).
  await app.register(registerTradingRoutes, { prefix: "/trading", env });
  // Pro Mode trades from the token modal: the trader's own wallet signs; nothing custodial.
  await app.register(registerProTradeRoutes, { prefix: "/pro", env });
  // The TRADES panel: a Pro Mode wallet's own trades, followed on the Helius stream (proTrades.ts).
  await app.register(registerProTradesRoutes, { prefix: "/pro/trades", env, dexScreener, viewStamps });
  // The Portfolio tab: the signed-in wallet's own account, holdings, trades and alerts.
  await app.register(registerPortfolioRoutes, { prefix: "/portfolio", env });
  // Token-guarded (STATS_API_TOKEN), not session-guarded: read by scripts, not the dashboard.
  await app.register(registerStatsRoutes, { prefix: "/stats", env, timings, liveRefresher });
  await app.register(registerStatsModelRoutes, { prefix: "/stats", env });
  // Every admin write lands in AdminAction (adminActionLog.ts), in each /admin plugin below.
  await app.register(registerAdminRoutes, { prefix: "/admin", env, admins });
  // Same /admin prefix and the same authenticateAdmin gate, registered separately only to keep
  // the subscription surface in its own readable block - see routes/admin.ts.
  await app.register(
    async (instance) => {
      instance.addHook("preHandler", instance.authenticateAdmin);
      recordAdminActions(instance, admins);
      await registerAdminSubscriptionRoutes(instance);
      // Burn Credits: the ratio, each utility's cost, grants and the ledger.
      await registerAdminCreditRoutes(instance);
      await registerAdminAnnouncementRoutes(instance);
      // The bug button's reports, to read and triage.
      await registerAdminFeedbackRoutes(instance);
      // Free Access: open sign-in to everyone for a while, and clean up after it.
      await registerAdminFreeAccessRoutes(instance, { env });
      // Pro Mode: who besides the admins sees the token modal's Trade panel.
      await registerAdminProModeRoutes(instance, { env });
    },
    { prefix: "/admin" },
  );
  // The dashboard Admin tab's operational reads (worker, hit rates, database, API, AI) - the
  // /stats reports behind the admin wallet check instead of the script token. See routes/adminOps.ts.
  await app.register(
    async (instance) => {
      instance.addHook("preHandler", instance.authenticateAdmin);
      recordAdminActions(instance, admins);
      await registerAdminOpsRoutes(instance, { env, timings, liveRefresher });
      // TokenSage, the safety screen, training history, filters and outside lookups.
      await registerAdminInsightRoutes(instance);
      // How each model decides: recipes, inputs, member weights, cutoffs, one call explained.
      await registerAdminModelRoutes(instance, { env, reports });
      // Wallet risk: the riskiest wallets, one wallet's coins, one coin's wallets, stop causes.
      await registerAdminWalletRoutes(instance);
      // The "Retrain now" button: a request row the trainer picks up within a minute.
      await registerAdminRetrainRoutes(instance);
      // Admin > Worker's "Run now": a request row the worker that owns the job picks up.
      await registerAdminJobRunRoutes(instance);
      // Outside API calls and Helius credits per provider, endpoint and feature.
      await registerAdminUsageRoutes(instance, { env });
      // Which expected env vars each service (and TokenSage's) has set, never their values.
      await registerAdminEnvRoutes(instance, { env });
    },
    { prefix: "/admin" },
  );
  // Model backups: list, take, download, import, pin, restore - see routes/adminBackups.ts. Gated
  // at onRequest rather than preHandler: the import takes a large body, and nobody but an admin
  // should get as far as having one read.
  await app.register(
    async (instance) => {
      instance.addHook("onRequest", instance.authenticateAdmin);
      recordAdminActions(instance, admins);
      await registerAdminBackupRoutes(instance, { env });
    },
    { prefix: "/admin" },
  );

  return app;
}
