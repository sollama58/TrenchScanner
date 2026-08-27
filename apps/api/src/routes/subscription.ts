import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  adminWalletSet,
  claimHeldBurns,
  creditBurn,
  describeRejection,
  parseBurnTransaction,
  prisma,
  resolveAccess,
  SolanaRpc,
  SUBSCRIPTION_DAYS,
  SUBSCRIPTION_MINT,
  SUBSCRIPTION_MINT_DECIMALS,
  SUBSCRIPTION_TOKENS_PER_MONTH,
  type Env,
} from "@trenchscanner/core";

/** Base58, 32-44 chars - the shape of every Solana address and signature we accept. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

const claimSchema = z.object({ signature: z.string().regex(SIGNATURE_RE, "invalid transaction signature") });
const sendSchema = z.object({
  // A signed transaction is a few hundred bytes; the cap stops this being a way to post megabytes
  // at the RPC on our credentials.
  transaction: z.string().min(1).max(4000),
});

export interface SubscriptionRouteOptions {
  env: Env;
  rpc: SolanaRpc;
}

export async function registerSubscriptionRoutes(
  app: FastifyInstance,
  { env, rpc }: SubscriptionRouteOptions,
) {
  const admins = adminWalletSet(env);

  // Everything here needs a session but must NOT need a subscription - this is where someone
  // without one comes to get one. Gating it behind the paywall would be a locked door with the
  // key inside.
  app.addHook("preHandler", app.authenticate);

  /** What access this wallet has, and what it would cost to get some. */
  app.get("/", async (request) => {
    const wallet = request.user!.walletAddress;
    const access = await resolveAccess(wallet, admins);

    const [burnCount, lastBurn] = await Promise.all([
      prisma.burnEvent.count({ where: { burnerWallet: wallet } }),
      prisma.burnEvent.findFirst({
        where: { burnerWallet: wallet },
        orderBy: { createdAt: "desc" },
        select: { signature: true, createdAt: true, monthsCredited: true, creditedAt: true },
      }),
    ]);

    return {
      hasAccess: access.hasAccess,
      reason: access.reason,
      expiresAt: access.expiresAt,
      price: {
        mint: SUBSCRIPTION_MINT,
        decimals: SUBSCRIPTION_MINT_DECIMALS,
        tokensPerMonth: SUBSCRIPTION_TOKENS_PER_MONTH,
        daysPerMonth: SUBSCRIPTION_DAYS,
      },
      burnCount,
      lastBurn,
    };
  });

  /**
   * A recent blockhash, and by existing at all, proof this API is reachable.
   *
   * The frontend calls this immediately before asking the wallet to sign. That ordering is the
   * point: a burn is irreversible, so finding out the backend is down AFTER destroying the tokens
   * is the one failure this whole feature is meant to avoid. Cheap pre-flight, no downside.
   */
  app.get("/blockhash", async (_request, reply) => {
    const result = await rpc.getLatestBlockhash();
    if (!result) {
      return reply
        .code(503)
        .send({ error: "Couldn't reach Solana just now. Nothing was burned - try again shortly." });
    }
    return result;
  });

  /**
   * Relay a signed burn, recording the signature before returning it.
   *
   * The server sends it rather than the browser for one reason: the moment a signature exists, it
   * is written down here. If the tab dies a millisecond later - closed, crashed, out of battery -
   * the burn is still ours to find, because we knew about it before the client did. The client's
   * later /claim call is then an optimisation, not the mechanism.
   */
  app.post("/send", async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }

    const result = await rpc.sendRawTransaction(parsed.data.transaction);
    if ("error" in result) {
      // The transaction did not go out. Say so plainly - the user still has their tokens, and the
      // frontend needs to be able to tell them that rather than leave them wondering.
      request.log.warn({ error: result.error }, "burn relay failed");
      return reply
        .code(502)
        .send({ error: "Transaction was rejected by the network. Your tokens were not burned." });
    }

    request.log.info(
      { signature: result.signature, wallet: request.user!.walletAddress },
      "burn transaction relayed",
    );
    return { signature: result.signature };
  });

  /**
   * Verify a burn and turn it into access.
   *
   * Deliberately does NOT require the caller to be the burner: the signature identifies the burn,
   * the burn's own authority identifies who gets the months. Someone pasting a signature they did
   * not sign therefore gives access to the wallet that actually paid, not to themselves.
   *
   * Also deliberately has no recency limit. The obvious version rejects transactions older than a
   * few minutes, which turns "I burned, then my laptop slept" into tokens destroyed and a claim
   * endpoint that refuses forever. The unique constraint - not a clock - is what stops replay.
   */
  app.post("/claim", async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { signature } = parsed.data;

    const existing = await prisma.burnEvent.findUnique({ where: { signature } });
    if (existing) {
      // Already in the ledger. Settle anything held for this wallet - covers the case where the
      // reconciler recorded the burn before this user's account existed - and report success,
      // because from the caller's point of view the burn did count.
      await claimHeldBurns(request.user!.userId, request.user!.walletAddress);
      const access = await resolveAccess(request.user!.walletAddress, admins);
      return { status: "already_credited", hasAccess: access.hasAccess, expiresAt: access.expiresAt };
    }

    const tx = await rpc.getParsedTransaction(signature);
    if (!tx) {
      // Not found is not the same as invalid: at `finalized` this is the normal answer for a burn
      // that landed seconds ago. 202 tells the client to keep polling, and the reconciler will
      // pick it up regardless of whether the client ever does.
      return reply.code(202).send({
        status: "pending",
        message:
          "That burn hasn't finalised yet. This page will keep checking, and your access is safe either way.",
      });
    }

    const verdict = parseBurnTransaction(tx);
    if (!verdict.ok) {
      return reply.code(400).send({ status: "rejected", error: describeRejection(verdict.reason) });
    }

    const outcome = await creditBurn(signature, verdict.credit, SUBSCRIPTION_MINT, "claim");
    if (outcome.status === "held") {
      // The burn was authorised by a wallet with no account here. Credited to that wallet the
      // moment it signs in - not to whoever happened to submit the signature.
      return reply.code(202).send({
        status: "held",
        message: "That burn was made by a different wallet. Sign in with that wallet to use it.",
      });
    }

    await claimHeldBurns(request.user!.userId, request.user!.walletAddress);
    const access = await resolveAccess(request.user!.walletAddress, admins);
    return { status: outcome.status, hasAccess: access.hasAccess, expiresAt: access.expiresAt };
  });
}
