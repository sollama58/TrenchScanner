import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bs58 from "bs58";
import {
  prisma,
  adminWalletSet,
  appDomainForOrigin,
  claimHeldBurns,
  starterFilterInput,
  type Env,
  type User,
} from "@trenchscanner/core";
import { issueNonce, verifyAndConsumeNonce, verifySignInAndConsumeNonce } from "../auth/siws.js";
import { SESSION_COOKIE_NAME, verifyRequestSessions } from "../auth/session.js";

// Length caps run before any base58 decode: bs58.decode is quadratic in input length, so an
// uncapped field let one unauthenticated request (a ~1MB walletAddress) block the event loop for
// minutes. A public key is at most 44 base58 chars, a 64-byte signature at most 88.
const MAX_SIGNATURE_CHARS = 100;
const MAX_SIGNED_MESSAGE_CHARS = 2048;
const MAX_NONCE_CHARS = 128;

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
    nonce: z.string().min(1).max(MAX_NONCE_CHARS),
    output: z.object({
      publicKey: z.string().min(1).max(44),
      signedMessage: z.string().min(1).max(MAX_SIGNED_MESSAGE_CHARS),
      signature: z.string().min(1).max(MAX_SIGNATURE_CHARS),
    }),
  }),
  z.object({
    method: z.literal("signMessage"),
    walletAddress: walletAddressSchema,
    nonce: z.string().min(1).max(MAX_NONCE_CHARS),
    signature: z.string().min(1).max(MAX_SIGNATURE_CHARS),
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
// of the dashboard's domain (api.trenchscanner.app), at which point Lax is correct and third-party
// cookie policy stops applying.
//
// Derived rather than configured so that switch needs no code change, no redeploy, and no flag
// day. Pointing api.trenchscanner.app at this service is enough: requests arriving on the old
// onrender.com host keep getting None while requests on the new one get Lax, so both work
// simultaneously and the cutover can happen at whatever pace DNS propagates.
//
// The Host header is client-controlled, which is harmless here: a request only ever influences the
// attributes of the cookie set on its own response, so the worst anyone can do is make their own
// session cookie more restrictive than it needed to be.
function isSameSiteAsDashboard(requestHost: string, appDomain: string): boolean {
  // Ports are irrelevant to what a browser considers a "site" - localhost:4000 and localhost:5173
  // are the same site - and PUBLIC_APP_DOMAIN carries one in local dev. It may also list more
  // than one dashboard (see appDomainList); being same-site with any of them is enough.
  const host = stripPort(requestHost);
  if (!host) return false;
  return appDomain.split(",").some((entry) => {
    const domain = stripPort(entry);
    return domain !== "" && (host === domain || host.endsWith(`.${domain}`));
  });
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

/**
 * Find the account for a wallet, or make one - reporting WHICH happened, which an upsert cannot.
 *
 * That distinction is the whole point: the starter filter must be created exactly once, on the
 * first ever sign-in, and an upsert's return value looks identical either way.
 *
 * The create is allowed to lose a race. Two sign-ins for the same new wallet arriving together
 * would both see no row; the loser's create fails on the unique constraint, and it then reads the
 * winner's row and reports `created: false` - so the filter is seeded once, by whoever won, and
 * not twice.
 */
async function findOrCreateUser(walletAddress: string): Promise<{ user: User; created: boolean }> {
  const existing = await prisma.user.findUnique({ where: { walletAddress } });
  if (existing) return { user: existing, created: false };

  try {
    return { user: await prisma.user.create({ data: { walletAddress } }), created: true };
  } catch {
    // Almost certainly the unique violation above. Anything else re-throws from here, since a
    // wallet with neither a row nor a creatable one is not something to paper over.
    return { user: await prisma.user.findUniqueOrThrow({ where: { walletAddress } }), created: false };
  }
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
      appDomainForOrigin(opts.env, request.headers.origin),
    );
    return { nonce, message, signInInput, expiresAt };
  });

  app.post("/verify", { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = verifyBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const body = parsed.data;
    // The same choice /nonce made for this page, so the rebuilt message matches what was signed.
    const domain = appDomainForOrigin(opts.env, request.headers.origin);

    const result =
      body.method === "signIn"
        ? await verifySignInAndConsumeNonce({
            walletAddress: body.walletAddress,
            nonce: body.nonce,
            domain,
            output: body.output,
          })
        : await verifyAndConsumeNonce({
            walletAddress: body.walletAddress,
            nonce: body.nonce,
            domain,
            signature: body.signature,
          });

    if (!result.ok) {
      return reply.code(401).send({ error: result.reason });
    }

    const { walletAddress } = body;
    const { user, created } = await findOrCreateUser(walletAddress);

    /**
     * A brand-new account gets one working filter, so the Live Feed has something to show
     * instead of an empty page that never explains you have to build something first.
     *
     * Gated on `created`, not on "has no filters": somebody who deliberately deletes every filter
     * has said what they want, and quietly rebuilding one on their next sign-in would be the app
     * arguing with them. Failure is logged and swallowed - an account without its starter filter
     * is a worse first run, but refusing the login over it is worse still.
     */
    if (created) {
      await prisma.userFilter
        .create({ data: { userId: user.id, ...starterFilterInput(opts.env) } })
        .then(() => request.log.info({ walletAddress }, "seeded the starter filter"))
        .catch((err: unknown) =>
          request.log.error({ err, walletAddress }, "could not seed the starter filter"),
        );
    }

    // Settle any burns this wallet made before it had an account here. Burning first and signing
    // in afterwards is a completely ordinary order of events - and the one a first-time user is
    // most likely to follow, since the paywall is what sends them to buy. Without this their
    // tokens would be gone and the ledger would hold a row nobody ever acted on.
    const heldMonths = await claimHeldBurns(user.id, walletAddress).catch((err: unknown) => {
      // Never block a login on this. The reconciler and the /subscription/claim path both settle
      // the same rows, so a failure here costs a delay, not the access.
      request.log.error({ err, walletAddress }, "failed to settle held burns on login");
      return 0;
    });
    if (heldMonths > 0) {
      request.log.info({ walletAddress, months: heldMonths }, "settled burns made before sign-up");
    }

    const token = await app.sessionSigner.sign({
      userId: user.id,
      walletAddress: user.walletAddress,
      sessionVersion: user.sessionVersion,
    });
    reply.setCookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      ...sessionCookieAttrs(request.hostname, opts.env.PUBLIC_APP_DOMAIN, request.protocol),
      // Kept in sync with the JWT's own expiry (see createSessionSigner) - a mismatch here would
      // mean the cookie either outlives the token it holds or expires before it does.
      maxAge: opts.env.SESSION_TTL_HOURS * 60 * 60,
    });

    // The same token in the body, for a browser that drops the cookie as third-party (see
    // sessionTokens): the dashboard keeps it only if a cookie-only /auth/me then fails.
    return { ...toUserResponse(user, opts.env), sessionToken: token };
  });

  app.post("/logout", async (request, reply) => {
    // Revoke, not just forget: clearing the cookie alone left a copied token valid for the rest
    // of SESSION_TTL_HOURS. Bumping sessionVersion invalidates every browser session this user
    // holds; a paired phone signing out switches off its own device row, the one thing that
    // revokes a device session (its token is good for a year otherwise). Every verified token on
    // the request counts - the cookie and a header can both be present, and the live one may be
    // either. A stale browser token matches no row, so it can't sign out newer sessions.
    for (const session of await verifyRequestSessions(app.sessionSigner, request)) {
      if (session.deviceId) {
        await prisma.linkedDevice.updateMany({
          where: { id: session.deviceId, userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } else {
        await prisma.user.updateMany({
          where: { id: session.userId, sessionVersion: session.sessionVersion ?? 0 },
          data: { sessionVersion: { increment: 1 } },
        });
      }
    }

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
  if (value.length < 32 || value.length > 44) return false;
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}
