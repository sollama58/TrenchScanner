import type { SessionSigner, SessionPayload } from "./auth/session.js";

declare module "fastify" {
  interface FastifyInstance {
    sessionSigner: SessionSigner;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Like `authenticate`, but additionally 403s anyone not in ADMIN_WALLET_ADDRESSES - see routes/admin.ts. */
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: SessionPayload;
  }
}
