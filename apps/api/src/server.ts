import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { type Env, corsOriginList, adminWalletSet, createLogger } from "@trenchscanner/core";
import { createSessionSigner, SESSION_COOKIE_NAME } from "./auth/session.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFilterRoutes } from "./routes/filters.js";
import { registerMatchRoutes } from "./routes/matches.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerTelegramRoutes } from "./routes/telegram.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAdminRoutes } from "./routes/admin.js";

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

  await app.register(registerHealthRoutes, { prefix: "/health" });

  await app.register(registerAuthRoutes, { prefix: "/auth", env });
  await app.register(registerFilterRoutes, { prefix: "/filters" });
  await app.register(registerMatchRoutes, { prefix: "/matches" });
  await app.register(registerTokenRoutes, { prefix: "/tokens" });
  await app.register(registerTelegramRoutes, { prefix: "/telegram", env });
  await app.register(registerAdminRoutes, { prefix: "/admin", env });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    logger.error("unhandled route error", { url: request.url, error: err.message });
    const status = err.statusCode ?? 500;
    reply.code(status).send({ error: status === 500 ? "internal_error" : err.message });
  });

  return app;
}
