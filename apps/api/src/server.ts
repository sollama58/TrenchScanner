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
  SolanaRpc,
  resolveAccess,
  prisma,
} from "@trenchscanner/core";
import { SAVED_FEED_SELECT, toSavedFeed } from "./contest.js";
import { createSessionSigner, SESSION_COOKIE_NAME, type SessionPayload } from "./auth/session.js";
import { deviceIsActive, touchDevice } from "./auth/deviceLink.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerDeviceLinkRoutes } from "./routes/deviceLink.js";
import { registerFilterRoutes } from "./routes/filters.js";
import { registerMatchRoutes } from "./routes/matches.js";
import { registerCuratedRoutes } from "./routes/curated.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAdminRoutes, registerAdminSubscriptionRoutes } from "./routes/admin.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerLeaderboardRoutes } from "./routes/leaderboard.js";
import { registerSubscriptionRoutes } from "./routes/subscription.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { MatchStream } from "./matchStream.js";
import { ViewStampBuffer } from "./viewStamps.js";
import { clientIp } from "./clientIp.js";

const logger = createLogger("api");

export async function buildServer(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });

  // Set before any route plugin is registered: Fastify hands each plugin the error handler in
  // force when it is registered, so a handler set at the end only covered the root context and
  // every routed 500 fell through to Fastify's default body - which carries the raw error
  // message (for Prisma, the database hostname). Details stay in the log; clients get a code.
  app.setErrorHandler((err: FastifyError, request, reply) => {
    logger.error("unhandled route error", { url: request.url, error: err.message });
    const status = err.statusCode ?? 500;
    reply.code(status).send({ error: status >= 500 ? "internal_error" : err.message });
  });

  await app.register(cors, {
    origin: corsOriginList(env),
    credentials: true,
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
  const verifiedSessions = new WeakMap<FastifyRequest, SessionPayload | null>();
  async function verifySession(request: FastifyRequest): Promise<SessionPayload | null> {
    if (verifiedSessions.has(request)) return verifiedSessions.get(request) ?? null;
    const token = request.cookies[SESSION_COOKIE_NAME];
    const session = token ? await app.sessionSigner.verify(token) : null;
    verifiedSessions.set(request, session);
    return session;
  }

  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    keyGenerator: async (request) => {
      // Verified, never merely present: an unverified cookie would let one client mint a fresh
      // bucket per request simply by changing the value, which is no rate limit at all.
      const session = await verifySession(request).catch(() => null);
      return session ? `user:${session.userId}` : `ip:${clientIp(request)}`;
    },
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

  async function resolveSession(request: FastifyRequest) {
    const session = await verifySession(request);
    if (!session) return null;
    return (await sessionStillValid(request, session)) ? session : null;
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
    const session = await verifySession(request);
    // The access lookup is read-only and keyed on the signed wallet, so it can start before the
    // revocation check finishes; its answer is only used once that check has passed.
    const [valid, access] = session
      ? await Promise.all([sessionStillValid(request, session), resolveAccess(session.walletAddress, admins)])
      : [false, null];
    if (!session || !valid || !access) {
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

  // The API's only outbound data source. Used for one thing: refreshing the market caps on a page
  // the moment it's opened, instead of leaving them until the worker's next tick - see
  // liveRefresh.ts for how that's kept from becoming a per-request upstream call.
  const dexScreener = new DexScreenerClient({ baseUrl: env.DEXSCREENER_BASE_URL });

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

  await app.register(registerHealthRoutes, { prefix: "/health" });
  await app.register(registerConfigRoutes, { prefix: "/config", env });

  await app.register(registerAuthRoutes, { prefix: "/auth", env });

  await app.register(registerDeviceLinkRoutes, { prefix: "/auth", env });
  await app.register(registerFilterRoutes, { prefix: "/filters", env });
  await app.register(registerMatchRoutes, { prefix: "/matches", env, dexScreener, matchStream, viewStamps });
  await app.register(registerCuratedRoutes, {
    prefix: "/curated",
    env,
    dexScreener,
    matchStream,
    viewStamps,
  });
  await app.register(registerTokenRoutes, { prefix: "/tokens" });
  await app.register(registerLeaderboardRoutes, { prefix: "/leaderboard" });
  await app.register(registerSubscriptionRoutes, { prefix: "/subscription", env, rpc });
  // Token-guarded (STATS_API_TOKEN), not session-guarded: read by scripts, not the dashboard.
  await app.register(registerStatsRoutes, { prefix: "/stats", env });
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

  return app;
}
