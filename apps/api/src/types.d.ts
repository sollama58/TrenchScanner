import type { SessionSigner, SessionPayload } from "./auth/session.js";
import type { MatchStream } from "./matchStream.js";
import type { AccessState } from "@trenchscanner/core";
import type { SavedFeed } from "./contest.js";
import type { User } from "@prisma/client";

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
    /**
     * The user's saved feed settings, read alongside the sessionVersion check for browser sessions.
     * Undefined when they weren't loaded (device sessions) - see savedFeed() in contest.ts.
     */
    savedFeed?: SavedFeed;
    /**
     * The columns /auth/me answers with, read by the same sessionVersion lookup that validates a
     * browser session - so that route does not read the User row a second time. Undefined when
     * the session was validated some other way (device sessions, the subscriber gate's joined read).
     */
    sessionUser?: Pick<User, "id" | "walletAddress" | "createdAt">;
  }
}
