import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bs58 from "bs58";
import { prisma, type Env } from "@trenchscanner/core";
import { issueNonce, verifyAndConsumeNonce, verifySignInAndConsumeNonce } from "../auth/siws.js";
import { SESSION_COOKIE_NAME } from "../auth/session.js";

const nonceQuerySchema = z.object({
  wallet: z.string().refine(isValidSolanaAddress, "wallet must be a valid base58 Solana public key"),
});

const walletAddressSchema = z
  .string()
  .refine(isValidSolanaAddress, "walletAddress must be a valid base58 Solana public key");

// Two ways a client can prove wallet ownership: the preferred wallet.signIn() (Wallet Standard,
// domain-bound - see siws.ts) when the connected wallet supports it, or a plain signMessage()
// fallback for wallets that don't. Both consume the same nonce issued by GET /nonce.
const verifyBodySchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("signIn"),
    walletAddress: walletAddressSchema,
    nonce: z.string().min(1),
    output: z.object({
      publicKey: z.string().min(1),
      signedMessage: z.string().min(1),
      signature: z.string().min(1),
    }),
  }),
  z.object({
    method: z.literal("signMessage"),
    walletAddress: walletAddressSchema,
    nonce: z.string().min(1),
    signature: z.string().min(1),
  }),
]);

// The tightest limits in the API: both routes are unauthenticated (reachable by anyone) and
// touch the DB (a nonce row per /nonce call). The global default (server.ts) covers everything
// else; a legitimate user signing in a few times a minute is well within this.
const AUTH_ROUTE_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };

// onrender.com is on the Public Suffix List, so trenchscanner-web.onrender.com and
// trenchscanner-api.onrender.com are different "sites" to the browser despite sharing a parent
// domain - SameSite=Lax never gets attached to the dashboard's cross-site fetch() calls, so a
// cookie set with it is silently dropped by the browser on every request after the one that set
// it. SameSite=None is required for this cross-subdomain setup to work at all, but browsers
// reject SameSite=None without Secure - gated on production, since local dev (localhost:5173
// talking to localhost:4000) is same-site (differs only by port) and plain HTTP, where Lax
// already works and None+Secure wouldn't. Shared by both setCookie and clearCookie below -
// browsers key a cookie's identity on name+domain+path, not these attributes, but keeping them
// identical avoids relying on that rather than confirming it per browser.
const isProduction = process.env.NODE_ENV === "production";
const SESSION_COOKIE_ATTRS = {
  secure: isProduction,
  sameSite: isProduction ? ("none" as const) : ("lax" as const),
  path: "/",
};

export async function registerAuthRoutes(app: FastifyInstance, opts: { env: Env }) {
  app.get("/nonce", { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = nonceQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { nonce, message, signInInput, expiresAt } = await issueNonce(
      parsed.data.wallet,
      opts.env.PUBLIC_APP_DOMAIN,
    );
    return { nonce, message, signInInput, expiresAt };
  });

  app.post("/verify", { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const body = parsed.data;

    const result =
      body.method === "signIn"
        ? await verifySignInAndConsumeNonce({
            walletAddress: body.walletAddress,
            nonce: body.nonce,
            domain: opts.env.PUBLIC_APP_DOMAIN,
            output: body.output,
          })
        : await verifyAndConsumeNonce({
            walletAddress: body.walletAddress,
            nonce: body.nonce,
            signature: body.signature,
          });

    if (!result.ok) {
      return reply.code(401).send({ error: result.reason });
    }

    const { walletAddress } = body;
    const user = await prisma.user.upsert({
      where: { walletAddress },
      create: { walletAddress },
      update: {},
    });

    const token = await app.sessionSigner.sign({ userId: user.id, walletAddress: user.walletAddress });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      ...SESSION_COOKIE_ATTRS,
      // Kept in sync with the JWT's own expiry (see createSessionSigner) - a mismatch here would
      // mean the cookie either outlives the token it holds or expires before it does.
      maxAge: opts.env.SESSION_TTL_HOURS * 60 * 60,
    });

    return { id: user.id, walletAddress: user.walletAddress, createdAt: user.createdAt };
  });

  app.post("/logout", async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_ATTRS);
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.userId } });
    return { id: user.id, walletAddress: user.walletAddress, createdAt: user.createdAt };
  });
}

function isValidSolanaAddress(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
