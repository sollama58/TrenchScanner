import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import bs58 from "bs58";
import { ipRateLimitKey } from "../clientIp.js";
import {
  prisma,
  adminWalletSet,
  appDomainForOrigin,
  claimHeldBurns,
  enrollInFreeAccess,
  starterFilterData,
  walletTag,
  type Env,
  type User,
} from "@trenchscanner/core";
import { issueNonce, verifyAndConsumeNonce, verifySignInAndConsumeNonce } from "../auth/siws.js";
import { SESSION_COOKIE_NAME, verifyRequestSessions } from "../auth/session.js";
import { PRO_OFF, proStatus } from "../proMode.js";
import { PrivyUnavailable, privyEmbeddedSolanaWallet, privyEnabled, verifyPrivyToken } from "../privy.js";
import {
  KNOWN_DEVICE_COOKIE,
  KNOWN_DEVICE_TTL_SECONDS,
  asksFor,
  checkSecondFactor,
  factorFields,
  issueKnownDevice,
  issueSignInTicket,
  isKnownDevice,
  passkeyAuthenticationOptions,
  readSignInTicket,
  spendTicket,
  twoFactorState,
} from "../twoFactor.js";

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
// Keyed by address, never by session: see ipRateLimitKey.
const AUTH_ROUTE_RATE_LIMIT = { max: 20, timeWindow: "1 minute", keyGenerator: ipRateLimitKey };

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
async function toUserResponse(
  user: Pick<User, "id" | "walletAddress" | "createdAt"> & { privyUserId?: string | null },
  env: Env,
) {
  // Sign-in never fails on Pro Mode: a hiccup on its tables reads as no Pro Mode, for this answer.
  const pro = await proStatus(env, user.walletAddress).catch(() => PRO_OFF);
  const twoFactor = await twoFactorState(user.id).catch(() => null);
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    createdAt: user.createdAt,
    // How the account signs in: its own wallet, or Privy (email or Google/X, a wallet Privy holds).
    signInMethod: user.privyUserId ? ("privy" as const) : ("wallet" as const),
    // Two-factor on, and which actions ask for it (the dashboard asks before burns and exports).
    twoFactor: twoFactor
      ? {
          enabled: twoFactor.enabled,
          actions: twoFactor.actions,
          buyOverLamports: twoFactor.buyOverLamports?.toString() ?? null,
        }
      : { enabled: false, actions: [], buyOverLamports: null },
    isAdmin: adminWalletSet(env).has(user.walletAddress),
    // Pro Mode: whether the token modal shows its Trade panel (proMode.ts), and the rest of it:
    // where it comes from, and a grace period's end. canClose matches isPro: no sells without Pro Mode.
    isPro: pro.pro,
    proMode: {
      source: pro.source,
      canClose: pro.canClose,
      ...(pro.rank !== undefined ? { rank: pro.rank } : {}),
      ...(pro.graceEndsAt ? { graceEndsAt: pro.graceEndsAt, graceReason: pro.graceReason } : {}),
    },
  };
}

export async function registerAuthRoutes(app: FastifyInstance, opts: { env: Env }) {
  // POST with the wallet in the body is how the dashboard asks: a query string lands in hosting
  // and proxy access logs, and this is every user's wallet at every sign-in (user ask 2026-10-18:
  // our users' wallets are never exposed). GET stays for a dashboard tab loaded before the change.
  const nonce = async (input: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const parsed = nonceQuerySchema.safeParse(input);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "invalid request" });
    }
    const { nonce, message, signInInput, expiresAt } = await issueNonce(
      parsed.data.wallet,
      appDomainForOrigin(opts.env, request.headers.origin),
    );
    return { nonce, message, signInInput, expiresAt };
  };
  app.post("/nonce", { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } }, (request, reply) =>
    nonce(request.body, request, reply),
  );
  app.get("/nonce", { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } }, (request, reply) =>
    nonce(request.query, request, reply),
  );

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
    return finishSignIn(request, reply, user, created);
  });

  /** Privy sign-in: on when PRIVY_APP_ID, its secret and its verification key are all set. */
  app.get("/privy/config", async () => {
    if (!privyEnabled(opts.env)) return { enabled: false, accessSwap: accessSwapOpen(opts.env) };
    const accounts = await prisma.user.count({ where: { privyUserId: { not: null } } });
    return {
      enabled: true,
      appId: opts.env.PRIVY_APP_ID,
      // At the cap the sign-in screen hides email sign-in before anyone opens Privy's window:
      // Privy counts everyone who logs in there as a monthly user, even one we then turn away.
      signupsOpen: accounts < opts.env.PRIVY_SIGNUP_CAP,
      // The in-app $ASDFASDFA buy (routes/proTrade.ts), open with Pro trading for everyone.
      accessSwap: accessSwapOpen(opts.env),
    };
  });

  app.post("/privy", { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    if (!privyEnabled(opts.env)) return reply.code(404).send({ error: "not found" });
    const parsed = z.object({ accessToken: z.string().min(20).max(4096) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    let did: string | null;
    try {
      did = await verifyPrivyToken(opts.env, parsed.data.accessToken);
    } catch (err) {
      request.log.warn(
        { err: err instanceof PrivyUnavailable ? err.message : err },
        "privy keys fetch failed",
      );
      return reply.code(503).send({ error: "Privy isn't answering right now. Try again in a minute." });
    }
    if (!did) return reply.code(401).send({ error: "That sign-in didn't check out. Try again." });

    let user = await prisma.user.findUnique({ where: { privyUserId: did } });
    let created = false;
    if (!user) {
      // The wallet comes from Privy's API, never from the browser.
      let wallet: string | null;
      try {
        wallet = await privyEmbeddedSolanaWallet(opts.env, did);
      } catch (err) {
        request.log.warn(
          { err: err instanceof PrivyUnavailable ? err.message : err },
          "privy user read failed",
        );
        return reply.code(503).send({ error: "Privy isn't answering right now. Try again in a minute." });
      }
      if (!wallet)
        return reply
          .code(409)
          .send({ error: "Your Privy wallet isn't ready yet. Wait a moment and try again." });
      // Admins sign in with their own wallet only (user decision 2026-10-18).
      if (adminWalletSet(opts.env).has(wallet))
        return reply.code(403).send({ error: "Sign in with your wallet." });
      const outcome = await createPrivyUser(did, wallet, opts.env.PRIVY_SIGNUP_CAP);
      if (outcome === "full")
        return reply.code(403).send({
          error: "Email sign-ups are full for now. You can still sign in with a Solana wallet.",
          signupsFull: true,
        });
      if (outcome === "taken")
        return reply
          .code(409)
          .send({ error: "That wallet already has an account here. Sign in with the wallet." });
      user = outcome.user;
      created = outcome.created;
      request.log.info(
        { wallet: walletTag(wallet) },
        created ? "privy account created" : "privy account found",
      );
    }
    // Checked at every sign-in, not only the first: a wallet made admin later still signs in with
    // its own key, never through Privy.
    if (adminWalletSet(opts.env).has(user.walletAddress))
      return reply.code(403).send({ error: "Sign in with your wallet." });
    return finishSignIn(request, reply, user, created);
  });

  /** The second step of a sign-in that asks for two-factor: the ticket the first step gave, and a factor. */
  app.post(
    "/2fa/signin/passkey-options",
    { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = z.object({ ticket: z.string().max(2048) }).safeParse(request.body);
      const ticket = parsed.success ? await readSignInTicket(opts.env, parsed.data.ticket) : null;
      if (!ticket) return reply.code(401).send({ error: "That sign-in has expired. Start again." });
      const out = await passkeyAuthenticationOptions(opts.env, ticket.userId, request.headers.origin);
      if (!out) return reply.code(404).send({ error: "No passkey on this account" });
      return out;
    },
  );

  app.post("/2fa/signin", { config: { rateLimit: AUTH_ROUTE_RATE_LIMIT } }, async (request, reply) => {
    const parsed = signInFactorSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid request" });
    const ticket = await readSignInTicket(opts.env, parsed.data.ticket);
    if (!ticket) return reply.code(401).send({ error: "That sign-in has expired. Start again." });
    const result = await checkSecondFactor(opts.env, ticket.userId, parsed.data, request.headers.origin);
    if (!result.ok) return reply.code(401).send({ error: result.reason });
    // The ticket works once, and only after a factor matched (a wrong code can be retried).
    if (!(await spendTicket(ticket.jti)))
      return reply.code(401).send({ error: "That sign-in has expired. Start again." });
    const user = await prisma.user.findUnique({ where: { id: ticket.userId } });
    // A sign-out everywhere since the ticket was given (sessionVersion moved on) ends it too.
    if (!user || user.sessionVersion !== ticket.sessionVersion)
      return reply.code(401).send({ error: "That sign-in has expired. Start again." });
    const { epoch } = await twoFactorState(user.id);
    reply.setCookie(KNOWN_DEVICE_COOKIE, await issueKnownDevice(opts.env, user.id, epoch), {
      httpOnly: true,
      ...sessionCookieAttrs(request.hostname, opts.env.PUBLIC_APP_DOMAIN, request.protocol),
      maxAge: KNOWN_DEVICE_TTL_SECONDS,
    });
    return issueSession(request, reply, user);
  });

  /**
   * After the first step of any sign-in (wallet or Privy): the new-account steps, then the
   * session, or a ticket for the second step when this account asks for two-factor at sign-in
   * on a browser it hasn't passed it on before.
   */
  async function finishSignIn(request: FastifyRequest, reply: FastifyReply, user: User, created: boolean) {
    const { walletAddress } = user;
    /**
     * A brand-new account gets one working filter, so the Live Feed has something to show
     * instead of an empty page that never explains you have to build something first: the
     * frozen copy of Gemerald, named Default (core's filters/starterFilterStore.ts).
     *
     * Gated on `created`, not on "has no filters": somebody who deliberately deletes every filter
     * has said what they want, and quietly rebuilding one on their next sign-in would be the app
     * arguing with them. Failure is logged and swallowed - an account without its starter filter
     * is a worse first run, but refusing the login over it is worse still.
     */
    if (created) {
      await starterFilterData(opts.env)
        .then((data) => prisma.userFilter.create({ data: { ...data, userId: user.id } }))
        .then(() => request.log.info({ wallet: walletTag(walletAddress) }, "seeded the starter filter"))
        .catch((err: unknown) =>
          request.log.error({ err, wallet: walletTag(walletAddress) }, "could not seed the starter filter"),
        );
    }

    // While a Free Access sign-in window is open, signing in is what enrolls a wallet; `created`
    // marks the accounts this period made, the only ones its cleanup may delete. A failure costs
    // the free access (the paywall shows), never the sign-in. Privy accounts are left out: their
    // sign-in promises no free start, and the window's cleanup must not delete them.
    if (!user.privyUserId) {
      await enrollInFreeAccess(user, created, adminWalletSet(opts.env)).catch((err: unknown) =>
        request.log.error(
          { err, wallet: walletTag(walletAddress) },
          "could not enroll the wallet in free access",
        ),
      );
    }

    // Settle any burns this wallet made before it had an account here. Burning first and signing
    // in afterwards is a completely ordinary order of events - and the one a first-time user is
    // most likely to follow, since the paywall is what sends them to buy. Without this their
    // tokens would be gone and the ledger would hold a row nobody ever acted on.
    const heldMonths = await claimHeldBurns(user.id, walletAddress).catch((err: unknown) => {
      // Never block a login on this. The reconciler and the /subscription/claim path both settle
      // the same rows, so a failure here costs a delay, not the access.
      request.log.error({ err, wallet: walletTag(walletAddress) }, "failed to settle held burns on login");
      return 0;
    });
    if (heldMonths > 0) {
      request.log.info(
        { wallet: walletTag(walletAddress), months: heldMonths },
        "settled burns made before sign-up",
      );
    }

    const twoFactor = await twoFactorState(user.id);
    if (asksFor(twoFactor, "signin") && !(await isKnownDevice(opts.env, request, user.id, twoFactor.epoch))) {
      return {
        twoFactorRequired: true,
        ticket: await issueSignInTicket(opts.env, user.id, user.sessionVersion),
        totp: twoFactor.totp,
        passkey: twoFactor.passkeys.length > 0,
      };
    }
    return issueSession(request, reply, user);
  }

  async function issueSession(request: FastifyRequest, reply: FastifyReply, user: User) {
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
    return { ...(await toUserResponse(user, opts.env)), sessionToken: token };
  }

  app.post("/logout", async (request, reply) => {
    // Revoke, not just forget: clearing the cookie alone left a copied token valid for the rest
    // of SESSION_TTL_HOURS. Bumping sessionVersion invalidates every browser session this user
    // holds, and its paired phones are switched off with it; a paired phone signing out switches
    // off only its own device row, the one thing that revokes a device session (its token is good
    // for a year otherwise). Every verified token on
    // the request counts - the cookie and a header can both be present, and the live one may be
    // either. A stale browser token matches no row, so it can't sign out newer sessions.
    for (const session of await verifyRequestSessions(app.sessionSigner, request)) {
      if (session.deviceId) {
        await prisma.linkedDevice.updateMany({
          where: { id: session.deviceId, userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      } else {
        const bumped = await prisma.user.updateMany({
          where: { id: session.userId, sessionVersion: session.sessionVersion ?? 0 },
          data: { sessionVersion: { increment: 1 } },
        });
        // Signing out in a browser signs out the account's paired phones too (user decision
        // 2026-10-18: sign out everywhere, the safest choice). A phone's session lasts a year and
        // isn't tied to sessionVersion, so without this a phone paired from a stolen session
        // outlived the owner's sign-out. Only a live session does it, like the bump above.
        if (bumped.count === 1) {
          await prisma.linkedDevice.updateMany({
            where: { userId: session.userId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }
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
    // A browser session's row was already read to check its sessionVersion; only a device
    // session (validated on its device row instead) needs the User row read here.
    const user =
      request.sessionUser ?? (await prisma.user.findUniqueOrThrow({ where: { id: request.user!.userId } }));
    return toUserResponse(user, opts.env);
  });
}

/**
 * The in-app $ASDFASDFA buy (routes/proTrade.ts): open to every signed-in wallet whenever Pro
 * trading is on at all (user ask 2026-10-18: always let people buy the access token here, even
 * while the rest of trading is admins only). PRO_TRADING_ENABLED stays the kill switch.
 */
export function accessSwapOpen(env: Env): boolean {
  return env.PRO_TRADING_ENABLED;
}

const signInFactorSchema = z.object({ ticket: z.string().max(2048), ...factorFields });

/**
 * A new account for a Privy sign-in, under the cap. The count and the create run under one lock,
 * so two sign-ins at the 399th account can't both get in. "taken": the Privy wallet already has a
 * wallet account here (its key was exported and signed in with), which stays as it is.
 */
async function createPrivyUser(
  privyUserId: string,
  walletAddress: string,
  cap: number,
): Promise<{ user: User; created: boolean } | "full" | "taken"> {
  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('privy-signup'))`;
      const again = await tx.user.findUnique({ where: { privyUserId } });
      if (again) return { user: again, created: false };
      if (await tx.user.findUnique({ where: { walletAddress }, select: { id: true } })) return "taken";
      if ((await tx.user.count({ where: { privyUserId: { not: null } } })) >= cap) return "full";
      return { user: await tx.user.create({ data: { walletAddress, privyUserId } }), created: true };
    })
    .catch((err: unknown) => {
      // A wallet sign-in made the same wallet's account at the same moment (it takes no lock).
      if ((err as { code?: unknown } | null)?.code === "P2002") return "taken" as const;
      throw err;
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
