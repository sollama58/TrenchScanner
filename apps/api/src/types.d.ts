import type { SessionSigner, SessionPayload } from "./auth/session.js";
import type { MatchStream } from "./matchStream.js";
import type { AccessState } from "@trenchscanner/core";

declare module "fastify" {
  interface FastifyInstance {
    sessionSigner: SessionSigner;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Like `authenticate`, but additionally 403s anyone not in ADMIN_WALLET_ADDRESSES - see routes/admin.ts. */
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /**
     * Like `authenticate`, but additionally 402s anyone without a live subscription, whitelist
     * entry or admin flag - see resolveAccess() in packages/core.
     */
    authenticateSubscriber: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** Push channel for newly created matches - see matchStream.ts. Exposed for /health to report on. */
    matchStream: MatchStream;
  }
  interface FastifyRequest {
    user?: SessionPayload;
    /** Set by `authenticateSubscriber` - why this request was let through, and until when. */
    access?: AccessState;
  }
}
