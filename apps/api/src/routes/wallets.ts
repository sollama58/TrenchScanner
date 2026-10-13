import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { loadWalletProfile, type WalletLiveReader } from "../walletProfile.js";

/**
 * The wallet modal's read (GET /wallets/:wallet): one wallet in full, for anyone with access
 * (authenticateSubscriber, like the token modal it opens from). See walletProfile.ts.
 */

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a Solana address");
const walletSchema = z.object({ wallet: address });
/** Each open reads the chain once (two 1-credit calls, cached): well above what a person clicks. */
const WALLET_ROUTE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

export async function registerWalletRoutes(app: FastifyInstance, opts: { live: WalletLiveReader | null }) {
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/:wallet", { config: { rateLimit: WALLET_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = walletSchema.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    reply.header("Cache-Control", "private, max-age=30");
    return loadWalletProfile(parsed.data.wallet, opts.live);
  });
}
