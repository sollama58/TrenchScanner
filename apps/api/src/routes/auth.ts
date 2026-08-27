import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bs58 from "bs58";
import { prisma, adminWalletSet, type Env, type User } from "@trenchscanner/core";
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

// Whether the session cookie has to survive a *cross-site* request, decided per request by
// comparing the host this API was actually reached on against the dashboard's own domain
// (PUBLIC_APP_DOMAIN).
//
// It matters because a cross-site cookie needs SameSite=None (Lax is simply never attached to the
// dashboard's fetch() calls, so the cookie is silently dropped on every request after the one that
// set it) - but SameSite=None is a third-party cookie, which Safari blocks outright and Chrome is
// progressively restricting. So None is what makes cross-site work at all, and also what makes it
// fail in some browsers. The real fix is to stop being cross-site: serve this API from a subdomain
// of the dashboard's domain (api.holdex.live), at which point Lax is correct and third-party
// cookie policy stops applying.
//
// Derived rather than configured so that switch needs no code change, no redeploy, and no flag
// day. Pointing api.holdex.live at this service is enough: requests arriving on the old
// onrender.com host keep getting None while requests on the new one get Lax, so both work
// simultaneously and the cutover can happen at whatever pace DNS propagates.
//
// The Host header is client-controlled, which is harmless here: a request only ever influences the
// attributes of the cookie set on its own response, so the worst anyone can do is make their own
// session cookie more restrictive than it needed to be.
function isSameSiteAsDashboard(requestHost: string, appDomain: string): boolean {
  // Ports are irrelevant to what a browser considers a "site" - localhost:4000 and localhost:5173
  // are the same site - and PUBLIC_APP_DOMAIN carries one in local dev.
  const host = stripPort(requestHost);
  const domain = stripPort(appDomain);
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function stripPort(value: string): string {
  return value.trim().toLowerCase().split(":")[0] ?? "";
}

/**
 * Secure is taken from the scheme the request actually arrived on rather than from NODE_ENV.
 * Browsers reject SameSite=None unless Secure is also set, so deciding the two independently means
 * a deployment that is cross-site but not flagged as production would emit a combination every
 * browser silently discards - a failure with no error anywhere, just a session that never sticks.
 * Reading the scheme couples them to the same fact instead. Fastify's `protocol` honours
 * X-Forwarded-Proto because the server sets trustProxy, which is what Render terminates TLS with.
 */
export function sessionCookieAttrs(requestHost: string, appDomain: string, protocol = "https") {
  return {
    secure: protocol === "https",
    sameSite: isSameSiteAsDashboard(requestHost, appDomain) ? ("lax" as const) : ("none" as const),
    path: "/",
  };
}

/** Shapes the public-facing user object - notably where isAdmin gets attached, since that's
 *  derived from config (ADMIN_WALLET_ADDRESSES) rather than stored on the User row itself. */
function toUserResponse(user: Pick<User, "id" | "walletAddress" | "createdAt">, env: Env) {
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    createdAt: user.createdAt,
    isAdmin: adminWalletSet(env).has(user.walletAddress),
  };
}

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
      ...sessionCookieAttrs(request.hostname, opts.env.PUBLIC_APP_DOMAIN, request.protocol),
      // Kept in sync with the JWT's own expiry (see createSessionSigner) - a mismatch here would
      // mean the cookie either outlives the token it holds or expires before it does.
      maxAge: opts.env.SESSION_TTL_HOURS * 60 * 60,
    });

    return toUserResponse(user, opts.env);
  });

  app.post("/logout", async (request, reply) => {
    // Same attributes as when it was set. Browsers key a cookie's identity on name+domain+path
    // rather than on these, but matching them avoids relying on that rather than confirming it
    // per browser.
    reply.clearCookie(
      SESSION_COOKIE_NAME,
      sessionCookieAttrs(request.hostname, opts.env.PUBLIC_APP_DOMAIN, request.protocol),
    );
    return { ok: true };
  });

  app.get("/me", { preHandler: app.authenticate }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.userId } });
    return toUserResponse(user, opts.env);
  });
}

function isValidSolanaAddress(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
