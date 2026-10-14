import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withApiFeature } from "@trenchscanner/core";
import { loadWalletProfile, type WalletLiveReader } from "../walletProfile.js";
import type { WalletIdentityReader } from "../walletIdentity.js";
import { loadWalletNames } from "../walletNames.js";
import { loadPossibleSides } from "../possibleSides.js";
import { allowLookupRead } from "../lookupGate.js";

/**
 * The wallet modal's read (GET /wallets/:wallet): one wallet in full, for anyone with access
 * (authenticateSubscriber, like the token modal it opens from). See walletProfile.ts. A wallet
 * TrenchScanner has never come across needs the reader's own paid lookup first (lookupGate.ts).
 * The holder lists' names (POST /wallets/names): the KOL, identity or exchange name of each wallet
 * on one list, in one read. Helius is asked only about wallets the database has seen, within each
 * account's own share of the budget. See walletNames.ts.
 * The bubble map's possible KOL side wallets (POST /wallets/possible-sides): which of a list's
 * wallets the Side Wallet Checker marks as a KOL's possible side wallet. See possibleSides.ts.
 */

const address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a Solana address");
const walletSchema = z.object({ wallet: address });
/** Each open reads the chain once (two 1-credit calls, cached): well above what a person clicks. */
const WALLET_ROUTE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };
/** One read per list a modal shows (holders, flagged wallets, linked wallets). */
const NAMES_ROUTE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };
/** The longest list read at once: two Helius batches. */
const MAX_NAMES = 200;
const namesSchema = z.object({ wallets: z.array(address).min(1).max(MAX_NAMES) });

export async function registerWalletRoutes(
  app: FastifyInstance,
  opts: { live: WalletLiveReader | null; identity?: WalletIdentityReader | null },
) {
  app.addHook("preHandler", app.authenticateSubscriber);

  app.get("/:wallet", { config: { rateLimit: WALLET_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = walletSchema.safeParse(request.params);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    if (!(await allowLookupRead(request, reply, "wallet", parsed.data.wallet))) return reply;
    reply.header("Cache-Control", "private, max-age=30");
    // Its chain reads count as "wallet-modal" in Admin > API usage.
    return withApiFeature("wallet-modal", () =>
      loadWalletProfile(parsed.data.wallet, opts.live, opts.identity ?? null),
    );
  });

  app.post("/names", { config: { rateLimit: NAMES_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = namesSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    // Its Helius reads count as "wallet-names" in Admin > API usage.
    return withApiFeature("wallet-names", () =>
      loadWalletNames(parsed.data.wallets, opts.identity ?? null, request.user!.userId),
    );
  });

  // A read of the hourly table only: no outside calls.
  app.post("/possible-sides", { config: { rateLimit: NAMES_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = namesSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    return { sides: await loadPossibleSides(parsed.data.wallets) };
  });
}
