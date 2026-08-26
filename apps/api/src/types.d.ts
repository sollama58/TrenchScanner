import type { SessionSigner, SessionPayload } from "./auth/session.js";

declare module "fastify" {
  interface FastifyInstance {
    sessionSigner: SessionSigner;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: SessionPayload;
  }
}
