import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { type Env, corsOriginList, createLogger } from "@trenchscanner/core";
import { createSessionSigner, SESSION_COOKIE_NAME } from "./auth/session.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerFilterRoutes } from "./routes/filters.js";
import { registerMatchRoutes } from "./routes/matches.js";
import { registerTokenRoutes } from "./routes/tokens.js";
import { registerTelegramRoutes } from "./routes/telegram.js";

const logger = createLogger("api");

export async function buildServer(env: Env): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: true });

  await app.register(cors, {
    origin: corsOriginList(env),
    credentials: true,
  });
  await app.register(cookie);

  app.decorate("sessionSigner", createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS));

  app.decorate("authenticate", async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    const session = token ? await app.sessionSigner.verify(token) : null;
    if (!session) {
      reply.code(401).send({ error: "unauthenticated" });
      return;
    }
    request.user = session;
  });

  app.get("/health", async () => ({ ok: true }));

  await app.register(registerAuthRoutes, { prefix: "/auth" });
  await app.register(registerFilterRoutes, { prefix: "/filters" });
  await app.register(registerMatchRoutes, { prefix: "/matches" });
  await app.register(registerTokenRoutes, { prefix: "/tokens" });
  await app.register(registerTelegramRoutes, { prefix: "/telegram", env });

  app.setErrorHandler((err: FastifyError, request, reply) => {
    logger.error("unhandled route error", { url: request.url, error: err.message });
    const status = err.statusCode ?? 500;
    reply.code(status).send({ error: status === 500 ? "internal_error" : err.message });
  });

  return app;
}
