import type { SessionSigner, SessionPayload } from "./auth/session.js";
import type { MatchStream } from "./matchStream.js";

declare module "fastify" {
  interface FastifyInstance {
    sessionSigner: SessionSigner;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Like `authenticate`, but additionally 403s anyone not in ADMIN_WALLET_ADDRESSES - see routes/admin.ts. */
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Push channel for newly created matches - see matchStream.ts. Exposed for /health to report on. */
    matchStream: MatchStream;
  }
  interface FastifyRequest {
    user?: SessionPayload;
  }
}
