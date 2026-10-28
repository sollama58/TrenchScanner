import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminWalletSet, appDomainForOrigin, resolveAccess, type Env } from "@trenchscanner/core";
import { issueBuddyLink, linkBuddyWallet, listBuddyWallets, unlinkBuddyWallet } from "../buddyWallets.js";
import { BUDDY_EXTRA_WALLETS } from "../extensionBuddy.js";
import { extensionKeyAccess, extensionKeyDeniedMessage } from "../extensionKey.js";
import { isMintAddress } from "../extensionLookup.js";

/** Link messages asked for an hour: a few tries at each of a few wallets. */
const NONCE_RATE_LIMIT = { max: 20, timeWindow: "1 hour" };
/**
 * Wallets linked a day, the backstop behind the signature (Card 11): an account changes its
 * other wallets rarely, and unlinking and linking again can't turn the cap into a revolving door.
 */
const LINK_RATE_LIMIT = { max: 6, timeWindow: "1 day" };

const walletSchema = z.string().refine(isMintAddress, "not a valid wallet address");

/**
 * Settings' Trade Buddy wallets (user decision 2026-10-27, Card 11): the reader links each of their
 * other wallets by signing a message with it, and Trade Buddy follows only those (buddyWallets.ts).
 * Listing and unlinking always work; linking needs the extension's paid access.
 *
 *   GET    /settings/buddy-wallets          the linked wallets and the cap
 *   POST   /settings/buddy-wallets/nonce    { wallet } -> the message to sign
 *   POST   /settings/buddy-wallets          { wallet, nonce, signature } -> links it
 *   DELETE /settings/buddy-wallets/:wallet
 */
export async function registerBuddyWalletRoutes(app: FastifyInstance, { env }: { env: Env }) {
  const admins = adminWalletSet(env);
  app.addHook("preHandler", app.authenticate);

  app.get("/buddy-wallets", async (request) => ({
    wallets: await listBuddyWallets(request.user!.userId),
    limit: BUDDY_EXTRA_WALLETS,
  }));

  app.post("/buddy-wallets/nonce", { config: { rateLimit: NONCE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = z.object({ wallet: walletSchema }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "not a valid wallet address" });
    const { userId, walletAddress } = request.user!;
    const { wallet } = parsed.data;
    if (wallet === walletAddress)
      return reply
        .code(400)
        .send({ error: "This is the account's own wallet: Trade Buddy follows it already." });
    const access = await resolveAccess(walletAddress, admins);
    if (!extensionKeyAccess(access))
      return reply.code(403).send({ error: extensionKeyDeniedMessage(access.reason) });
    const issued = await issueBuddyLink(
      userId,
      walletAddress,
      wallet,
      appDomainForOrigin(env, request.headers.origin),
    );
    return issued;
  });

  app.post("/buddy-wallets", { config: { rateLimit: LINK_RATE_LIMIT } }, async (request, reply) => {
    const parsed = z
      .object({
        wallet: walletSchema,
        nonce: z.string().min(1).max(64),
        signature: z.string().min(1).max(128),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const { userId, walletAddress } = request.user!;
    const result = await linkBuddyWallet({
      userId,
      accountWallet: walletAddress,
      ...parsed.data,
      // The same choice /nonce made for this page, so the rebuilt message matches what was signed.
      domain: appDomainForOrigin(env, request.headers.origin),
    });
    if (result.ok) return { wallets: result.wallets };
    if (result.reason === "full")
      return reply.code(409).send({
        error: `You already have ${BUDDY_EXTRA_WALLETS} wallets linked. Unlink one to link another.`,
      });
    return reply.code(401).send({ error: result.reason });
  });

  app.delete("/buddy-wallets/:wallet", async (request, reply) => {
    const parsed = z.object({ wallet: walletSchema }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "not a valid wallet address" });
    if (!(await unlinkBuddyWallet(request.user!.userId, parsed.data.wallet)))
      return reply.code(404).send({ error: "not_found" });
    return { wallet: parsed.data.wallet };
  });
}
