import type { FastifyInstance } from "fastify";
import bs58 from "bs58";
import { z } from "zod";
import { burnsMint } from "../burnWire.js";
import {
  adminWalletSet,
  claimHeldBurns,
  creditBurn,
  describeRejection,
  parseBurnTransaction,
  prisma,
  resolveAccess,
  SolanaRpc,
  SPL_TOKEN_PROGRAM_ID,
  SUBSCRIPTION_DAYS,
  SUBSCRIPTION_MINT,
  SUBSCRIPTION_MINT_DECIMALS,
  SUBSCRIPTION_TOKENS_PER_MONTH,
  type Env,
} from "@trenchscanner/core";

/** Base58, 80-90 chars - the shape of a 64-byte Solana transaction signature. */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/;

const claimSchema = z.object({ signature: z.string().regex(SIGNATURE_RE, "invalid transaction signature") });
const sendSchema = z.object({
  // A signed transaction is a few hundred bytes; the cap stops this being a way to post megabytes
  // at the RPC on our credentials.
  transaction: z.string().min(1).max(4000),
});

/**
 * What /send is willing to relay, per session.
 *
 * Buying access is a handful of transactions in a lifetime, so anything above this is not a
 * subscriber. The route relays through SOLANA_RPC_URL - in production a paid endpoint on the
 * operator's key - and signing in costs nothing, so without a bound any wallet could push its
 * traffic through here and have it billed to, and attributed to, us.
 */
const SEND_ROUTE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };
// /blockhash and /claim each spend a paid RPC call (getTransaction retries on top) and need only a
// free sign-in, so they get their own limit instead of the global 300/min.
const RPC_ROUTE_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

/**
 * The transaction's own id - its first signature - read straight off the signed wire bytes.
 *
 * A signed transaction opens with a compact-u16 count and then the 64-byte signatures, and the
 * first one is the id the chain will know it by. Knowing it before the relay means a relay whose
 * reply is lost (a timeout, a dropped connection) can still hand the client something to check on,
 * instead of an answer nobody can act on. Null for anything that doesn't parse or isn't signed.
 */
export function firstSignature(base64Transaction: string): string | null {
  const bytes = Buffer.from(base64Transaction, "base64");
  let count = 0;
  let offset = 0;
  for (let shift = 0; shift < 21; shift += 7) {
    const byte = bytes[offset];
    if (byte === undefined) return null;
    offset += 1;
    count |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
  }
  if (count < 1 || bytes.length < offset + 64) return null;
  const signature = bytes.subarray(offset, offset + 64);
  if (signature.every((b) => b === 0)) return null;
  return bs58.encode(signature);
}

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
    // All three are independent reads keyed on the signed wallet - one round trip, not two.
    const [access, burnCount, lastBurn] = await Promise.all([
      resolveAccess(wallet, admins),
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
  app.get("/blockhash", { config: { rateLimit: RPC_ROUTE_RATE_LIMIT } }, async (_request, reply) => {
    const result = await rpc.getLatestBlockhash();
    if (!result) {
      return reply
        .code(503)
        .send({ error: "Couldn't reach Solana just now. Nothing was burned - try again shortly." });
    }
    return result;
  });

  /**
   * The signed-in wallet's $ASDFASDFA, for the dashboard's burn button.
   *
   * The dashboard builds the burn transaction itself and needs the token account to burn from; it
   * carries no RPC client, and the browser asking a public RPC directly would be rate-limited off
   * it. Only accounts the parser would credit are offered: owned by the classic SPL Token program
   * (a Token-2022 burn of this mint is not a subscription payment) and not frozen (the chain
   * refuses to burn from a frozen account, after the fee). Largest first, since the button burns
   * from one account.
   */
  app.get("/balance", { config: { rateLimit: RPC_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const accounts = await rpc.getTokenAccountsByOwner(request.user!.walletAddress, SUBSCRIPTION_MINT);
    if (!accounts) {
      return reply
        .code(503)
        .send({ error: "Couldn't read your balance from Solana just now. Try again shortly." });
    }
    const burnable = accounts
      .filter((a) => a.programId === SPL_TOKEN_PROGRAM_ID && a.state === "initialized")
      .sort((a, b) =>
        BigInt(b.rawAmount) > BigInt(a.rawAmount) ? 1 : BigInt(b.rawAmount) < BigInt(a.rawAmount) ? -1 : 0,
      );
    const total = accounts.reduce((sum, a) => sum + BigInt(a.rawAmount), 0n);
    return {
      mint: SUBSCRIPTION_MINT,
      decimals: SUBSCRIPTION_MINT_DECIMALS,
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
      totalRaw: total.toString(),
      accounts: burnable.map((a) => ({ address: a.address, rawAmount: a.rawAmount })),
    };
  });

  /**
   * Relay a signed burn and return its signature.
   *
   * Nothing is written to the ledger here: the transaction has not landed yet, and a row for it
   * would have to be verified later anyway. What makes a dead tab safe is the burn reconciler,
   * which reads every transaction on the mint and credits the burn whether or not the client ever
   * calls /claim. The signature is logged here, so a support question can still be traced. /claim
   * is the fast path, not the mechanism.
   */
  app.post("/send", { config: { rateLimit: SEND_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = sendSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }

    // This endpoint exists to relay ONE kind of transaction. Nothing here originally required the
    // payload to have anything to do with the subscription - not the mint, not the caller's own
    // wallet - so any signed-in wallet (and signing in is free) could push arbitrary transactions
    // through the operator's paid RPC key, at the global rate limit, with the traffic attributed
    // to us. The payload is decoded and relayed only when it burns the mint (burnWire.ts says what
    // that does and does not check); the burn itself is verified on-chain afterwards by /claim.
    const wire = burnsMint(parsed.data.transaction, SUBSCRIPTION_MINT);
    if (!wire.ok) {
      request.log.warn(
        { wallet: request.user!.walletAddress, reason: wire.reason },
        "refused to relay a non-burn transaction",
      );
      return reply.code(400).send({ error: "That transaction doesn't burn $ASDFASDFA. Nothing was sent." });
    }

    const signature = firstSignature(parsed.data.transaction);
    const result = await rpc.sendRawTransaction(parsed.data.transaction);
    if ("error" in result) {
      request.log.warn(
        { error: result.error, rejected: result.rejected, signature, wallet: request.user!.walletAddress },
        "burn relay failed",
      );
      if (result.rejected) {
        // The RPC refused it: the transaction did not go out and the user still has their tokens.
        return reply
          .code(502)
          .send({ error: "Transaction was rejected by the network. Your tokens were not burned." });
      }
      // The reply was lost, not refused: the RPC may well have sent it. "Your tokens were not
      // burned" here was a guess, and a wrong one invites a second burn. The signature lets the
      // client keep checking /claim; the reconciler credits it regardless if it landed.
      return reply.code(502).send({
        error:
          "We couldn't confirm the network received that. Check your wallet before trying again - if it went through, your access arrives on its own.",
        signature,
      });
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
   * the burned token account's owner identifies who gets the months (parseBurnTransaction). Someone pasting a signature they did
   * not sign therefore gives access to the wallet that actually paid, not to themselves.
   *
   * Also deliberately has no recency limit. The obvious version rejects transactions older than a
   * few minutes, which turns "I burned, then my laptop slept" into tokens destroyed and a claim
   * endpoint that refuses forever. The unique constraint - not a clock - is what stops replay.
   */
  app.post("/claim", { config: { rateLimit: RPC_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = claimSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { signature } = parsed.data;

    const existing = await prisma.burnEvent.findUnique({ where: { signature } });
    if (existing && existing.burnerWallet !== request.user!.walletAddress) {
      // In the ledger under another wallet: nothing here is this caller's, and saying "credited"
      // would show them access they don't have.
      return reply.code(202).send({
        status: "held",
        message: "That burn was made by a different wallet. Sign in with that wallet to use it.",
      });
    }
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

    const verdict = parseBurnTransaction(tx, signature);
    if (!verdict.ok) {
      return reply.code(400).send({ status: "rejected", error: describeRejection(verdict.reason) });
    }

    const outcome = await creditBurn(signature, verdict.credit, SUBSCRIPTION_MINT, "claim");
    if (outcome.status === "held" || verdict.credit.burnerWallet !== request.user!.walletAddress) {
      // The burn was another wallet's tokens: held for it if it has no account here yet,
      // credited to it if it does. Either way none of it is this caller's, and answering
      // "credited" with the caller's own access (as the fresh path used to, unlike the ledger path
      // above) told them a burn counted when their access hadn't moved.
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
