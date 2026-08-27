import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import {
  type Env,
  corsOriginList,
  adminWalletSet,
  createLogger,
  DexScreenerClient,
  SolanaRpc,
  resolveAccess,
} from "@trenchscanner/core";
import { createSessionSigner, SESSION_COOKIE_NAME } from "./auth/session.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFilterRoutes } from "./routes/filters.js";
import { registerMatchRoutes } from "./routes/matches.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAdminRoutes, registerAdminSubscriptionRoutes } from "./routes/admin.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerLeaderboardRoutes } from "./routes/leaderboard.js";
import { registerSubscriptionRoutes } from "./routes/subscription.js";
import { MatchStream } from "./matchStream.js";

const logger = createLogger("api");

export async function buildServer(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(cors, {
    origin: corsOriginList(env),
    credentials: true,
  });
  await app.register(cookie);

  // Pure JSON API - CSP/script-src directives don't apply to anything we serve, so they're
  // switched off to avoid meaningless header bloat. Everything else (nosniff, frame-deny, HSTS,
  // referrer-policy, ...) still applies.
  await app.register(helmet, { contentSecurityPolicy: false });

  // Registered globally so every route gets a sane default; individual routes (see auth.ts's
  // /nonce and /verify - the only unauthenticated, state-touching endpoints) tighten this further
  // via their own `config.rateLimit`. Keyed by request.ip, which respects trustProxy above, so
  // this reads the real client IP through Render's proxy rather than rate-limiting the proxy itself.
  await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  app.decorate("sessionSigner", createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS));

  // Shared by authenticate and authenticateAdmin below so the cookie-read-and-verify step (and
  // any future change to it) only lives in one place.
  async function resolveSession(request: FastifyRequest) {
    const token = request.cookies[SESSION_COOKIE_NAME];
    return token ? await app.sessionSigner.verify(token) : null;
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
    const session = await resolveSession(request);
    if (!session) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    request.user = session;

    const access = await resolveAccess(session.walletAddress, admins);
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
  // constructed for a test gets a working stream too, and torn down via onClose so nothing leaks
  // between test servers or blocks shutdown.
  //
  // Declared before any route is registered, not after: Fastify creates a plugin's encapsulated
  // instance at register time, so a decoration added later only reaches it through the prototype
  // chain. That happens to work, but it is far too subtle a thing for /health/stream to depend on.
  const matchStream = new MatchStream(env.DATABASE_URL);
  matchStream.start();
  app.decorate("matchStream", matchStream);
  app.addHook("onClose", async () => {
    await matchStream.stop();
  });

  await app.register(registerHealthRoutes, { prefix: "/health" });
  await app.register(registerConfigRoutes, { prefix: "/config", env });

  await app.register(registerAuthRoutes, { prefix: "/auth", env });
  await app.register(registerFilterRoutes, { prefix: "/filters", env });
  await app.register(registerMatchRoutes, { prefix: "/matches", env, dexScreener, matchStream });
  await app.register(registerTokenRoutes, { prefix: "/tokens" });
  await app.register(registerLeaderboardRoutes, { prefix: "/leaderboard" });
  await app.register(registerSubscriptionRoutes, { prefix: "/subscription", env, rpc });
  await app.register(registerTelegramRoutes, { prefix: "/telegram", env });
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

  app.setErrorHandler((err: FastifyError, request, reply) => {
    logger.error("unhandled route error", { url: request.url, error: err.message });
    const status = err.statusCode ?? 500;
    reply.code(status).send({ error: status === 500 ? "internal_error" : err.message });
  });

  return app;
}
