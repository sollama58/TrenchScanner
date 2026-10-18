// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { SignJWT, errors, generateKeyPair, type KeyLike } from "jose";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, prisma, SUBSCRIPTION_MINT, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { PrivyUnavailable, privyTestDoubles, verifyPrivyToken } from "../privy.js";
import { openSecret, resetTwoFactorFailuresForTests, sealSecret, totpCode } from "../twoFactor.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const APP_ID = "privy-test-app";
/** A real wallet address (an ed25519 public key: on the curve, as a wallet's is). */
const wallet = () =>
  bs58.encode(generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).subarray(-32));
const ADMIN = wallet();

/** Privy's API, as the stand-in answers it: did -> its embedded wallet (or none). */
const privyWallets = new Map<string, string | null>();

let privateKey: KeyLike;
let otherKey: KeyLike;

async function privyToken(did: string, opts: { key?: KeyLike; audience?: string; expired?: boolean } = {}) {
  const jwt = new SignJWT({ sid: "s" })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(opts.audience ?? APP_ID)
    .setSubject(did)
    .setIssuedAt();
  jwt.setExpirationTime(opts.expired ? Math.floor(Date.now() / 1000) - 60 : "1h");
  return jwt.sign(opts.key ?? privateKey);
}

describe("verifyPrivyToken", () => {
  const env = {
    PRIVY_APP_ID: APP_ID,
    PRIVY_APP_SECRET: "x",
    PRIVY_JWKS_ENDPOINT: "https://auth.privy.io/api/v1/apps/x/jwks.json",
  } as Env;

  beforeAll(async () => {
    otherKey = (await generateKeyPair("ES256")).privateKey;
  });

  it("accepts Privy's token for this app and returns the account", async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    privyTestDoubles.keys = async () => pair.publicKey;
    expect(await verifyPrivyToken(env, await privyToken("did:privy:abc"))).toBe("did:privy:abc");
  });

  it("refuses another app's token, an expired one, one signed by another key, and a non-Privy subject", async () => {
    expect(await verifyPrivyToken(env, await privyToken("did:privy:abc", { audience: "other" }))).toBeNull();
    expect(await verifyPrivyToken(env, await privyToken("did:privy:abc", { expired: true }))).toBeNull();
    expect(await verifyPrivyToken(env, await privyToken("did:privy:abc", { key: otherKey }))).toBeNull();
    expect(await verifyPrivyToken(env, await privyToken("someone-else"))).toBeNull();
    expect(await verifyPrivyToken(env, "not-a-token")).toBeNull();
  });

  it("reads Privy's keys out of reach as an outage, not a bad token", async () => {
    const keys = privyTestDoubles.keys;
    const token = await privyToken("did:privy:abc");
    try {
      privyTestDoubles.keys = async () => {
        throw new errors.JWKSTimeout();
      };
      await expect(verifyPrivyToken(env, token)).rejects.toBeInstanceOf(PrivyUnavailable);
      privyTestDoubles.keys = async () => {
        throw new errors.JOSEError("Expected 200 OK from the JSON Web Key Set HTTP response");
      };
      await expect(verifyPrivyToken(env, token)).rejects.toBeInstanceOf(PrivyUnavailable);
      privyTestDoubles.keys = async () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      };
      await expect(verifyPrivyToken(env, token)).rejects.toBeInstanceOf(PrivyUnavailable);
    } finally {
      privyTestDoubles.keys = keys;
    }
  });
});

describe.skipIf(!dbAvailable)("Privy sign-in and two-factor", () => {
  let env: Env;
  let app: FastifyInstance;
  const dids: string[] = [];
  const userIds: string[] = [];

  const newDid = () => {
    const did = `did:privy:test${randomBytes(6).toString("hex")}`;
    dids.push(did);
    return did;
  };

  const signIn = (accessToken: string, cookies: Record<string, string> = {}) =>
    app.inject({ method: "POST", url: "/auth/privy", payload: { accessToken }, cookies });

  beforeAll(async () => {
    const pair = await generateKeyPair("ES256");
    privateKey = pair.privateKey;
    privyTestDoubles.keys = async () => pair.publicKey;
    privyTestDoubles.fetch = (async (url: string) => {
      const did = decodeURIComponent(String(url).split("/users/")[1] ?? "");
      if (!privyWallets.has(did)) return new Response("{}", { status: 404 });
      const address = privyWallets.get(did);
      return Response.json({
        id: did,
        linked_accounts: address
          ? [
              { type: "email", address: "someone@example.com" },
              { type: "wallet", chain_type: "solana", wallet_client_type: "privy", address },
            ]
          : [],
      });
    }) as typeof fetch;
    env = {
      ...loadEnv(),
      ADMIN_WALLET_ADDRESSES: ADMIN,
      PRIVY_APP_ID: APP_ID,
      PRIVY_APP_SECRET: "secret",
      PRIVY_JWKS_ENDPOINT: "https://auth.privy.io/api/v1/apps/x/jwks.json",
      PRIVY_SIGNUP_CAP: 100_000,
    };
    app = await buildServer(env);
  });

  beforeEach(() => resetTwoFactorFailuresForTests());

  afterEach(() => {
    env.PRIVY_SIGNUP_CAP = 100_000;
  });

  afterAll(async () => {
    privyTestDoubles.keys = null;
    privyTestDoubles.fetch = null;
    if (!dbAvailable) return;
    await app?.close();
    await prisma.user.deleteMany({ where: { OR: [{ privyUserId: { in: dids } }, { id: { in: userIds } }] } });
  });

  it("says email sign-in is on, with sign-ups open", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/privy/config" });
    expect(res.json()).toMatchObject({ enabled: true, appId: APP_ID, signupsOpen: true });
  });

  it("makes an account for a new Privy login, with the wallet from Privy's API, and finds it again", async () => {
    const did = newDid();
    const address = wallet();
    privyWallets.set(did, address);
    const first = await signIn(await privyToken(did));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ walletAddress: address, signInMethod: "privy", isAdmin: false });
    expect(first.cookies.some((c) => c.name === SESSION_COOKIE_NAME)).toBe(true);
    // A later login is the same account, even if Privy's API would now answer differently.
    privyWallets.set(did, wallet());
    const again = await signIn(await privyToken(did));
    expect(again.json()).toMatchObject({ walletAddress: address });
    expect(await prisma.user.count({ where: { privyUserId: did } })).toBe(1);
  });

  it("ignores any wallet the browser sends: only Privy's API names it", async () => {
    const did = newDid();
    const address = wallet();
    privyWallets.set(did, address);
    const res = await app.inject({
      method: "POST",
      url: "/auth/privy",
      payload: { accessToken: await privyToken(did), walletAddress: ADMIN },
    });
    expect(res.json()).toMatchObject({ walletAddress: address });
  });

  it("refuses a bad token, a wallet not made yet, an admin wallet, and a wallet that already has an account", async () => {
    expect((await signIn("x".repeat(40))).statusCode).toBe(401);
    const noWallet = newDid();
    privyWallets.set(noWallet, null);
    expect((await signIn(await privyToken(noWallet))).statusCode).toBe(409);

    const admin = newDid();
    privyWallets.set(admin, ADMIN);
    expect((await signIn(await privyToken(admin))).statusCode).toBe(403);

    const taken = wallet();
    const existing = await prisma.user.create({ data: { walletAddress: taken } });
    userIds.push(existing.id);
    const did = newDid();
    privyWallets.set(did, taken);
    expect((await signIn(await privyToken(did))).statusCode).toBe(409);
    expect(await prisma.user.findUnique({ where: { id: existing.id } })).toMatchObject({ privyUserId: null });
  });

  it("refuses a Privy account whose wallet was made an admin later", async () => {
    const did = newDid();
    const address = wallet();
    privyWallets.set(did, address);
    expect((await signIn(await privyToken(did))).statusCode).toBe(200);
    const was = env.ADMIN_WALLET_ADDRESSES;
    try {
      env.ADMIN_WALLET_ADDRESSES = `${ADMIN},${address}`;
      expect((await signIn(await privyToken(did))).statusCode).toBe(403);
    } finally {
      env.ADMIN_WALLET_ADDRESSES = was;
    }
  });

  it("stops new Privy accounts at the cap, but not existing ones", async () => {
    const existing = newDid();
    privyWallets.set(existing, wallet());
    expect((await signIn(await privyToken(existing))).statusCode).toBe(200);

    env.PRIVY_SIGNUP_CAP = await prisma.user.count({ where: { privyUserId: { not: null } } });
    expect((await app.inject({ method: "GET", url: "/auth/privy/config" })).json()).toMatchObject({
      signupsOpen: false,
    });
    const late = newDid();
    privyWallets.set(late, wallet());
    const refused = await signIn(await privyToken(late));
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ signupsFull: true });
    expect(await prisma.user.count({ where: { privyUserId: late } })).toBe(0);
    expect((await signIn(await privyToken(existing))).statusCode).toBe(200);
  });

  it("never pairs a phone for a Privy account", async () => {
    const did = newDid();
    privyWallets.set(did, wallet());
    const session = (await signIn(await privyToken(did))).json() as { sessionToken: string };
    const res = await app.inject({
      method: "POST",
      url: "/auth/link/code",
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/wallet sign-ins/);
  });

  describe("two-factor", () => {
    let userId: string;
    let address: string;
    let cookie: string;
    let backupCodes: string[] = [];
    const signer = () => createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS);
    const as = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, headers = {}) =>
      app.inject({ method, url, payload, headers, cookies: { [SESSION_COOKIE_NAME]: cookie } });

    /** The authenticator's code for `offset` steps from now (each code works once). */
    const codeAt = async (offset = 0) => {
      const s = await prisma.twoFactorSettings.findUniqueOrThrow({ where: { userId } });
      const secret = openSecret(env, userId, s.totpSecret ?? s.pendingTotpSecret!);
      return totpCode(secret, Math.floor(Date.now() / 30_000) + offset);
    };

    beforeAll(async () => {
      address = wallet();
      const user = await prisma.user.create({ data: { walletAddress: address } });
      userId = user.id;
      userIds.push(userId);
      cookie = await signer().sign({ userId, walletAddress: address });
    });

    it("turns on with an authenticator app, giving backup codes once", async () => {
      expect((await as("GET", "/auth/2fa")).json()).toMatchObject({ enabled: false, totp: false });
      const setup = await as("POST", "/auth/2fa/totp/setup");
      expect(setup.statusCode).toBe(200);
      expect(setup.json().otpauthUrl).not.toContain(address);
      expect((await as("POST", "/auth/2fa/totp/confirm", { code: "000000" })).statusCode).toBe(401);
      const confirmed = await as("POST", "/auth/2fa/totp/confirm", { code: await codeAt() });
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().backupCodes).toHaveLength(10);
      backupCodes = confirmed.json().backupCodes;
      const state = (await as("GET", "/auth/2fa")).json();
      expect(state).toMatchObject({ enabled: true, totp: true, backupCodesLeft: 10 });
      // The secret is stored sealed, not as the base32 the app was shown.
      const row = await prisma.twoFactorSettings.findUniqueOrThrow({ where: { userId } });
      expect(row.totpSecret).not.toContain(setup.json().secret);
    });

    it("asks for it before changing two-factor, and takes a pass for that", async () => {
      const refused = await as("PUT", "/auth/2fa/actions", { actions: ["signin", "sell"] });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ twoFactor: { action: "manage" } });
      const pass = (await as("POST", "/auth/2fa/verify", { action: "manage", code: await codeAt(1) })).json()
        .pass;
      const saved = await as(
        "PUT",
        "/auth/2fa/actions",
        { actions: ["signin", "sell"] },
        { "x-ts-2fa": pass },
      );
      expect(saved.statusCode).toBe(200);
      expect(saved.json().actions).toEqual(expect.arrayContaining(["signin", "sell", "export"]));
      // A pass for one action doesn't open another.
      expect((await as("POST", "/auth/2fa/backup-codes", undefined, { "x-ts-2fa": "nope" })).statusCode).toBe(
        403,
      );
    });

    it("won't take the same code twice", async () => {
      const used = await codeAt(1);
      expect((await as("POST", "/auth/2fa/verify", { action: "sell", code: used })).statusCode).toBe(401);
    });

    it("takes a backup code once", async () => {
      const code = backupCodes[0]!;
      const first = await as("POST", "/auth/2fa/verify", { action: "sell", backupCode: code.toLowerCase() });
      expect(first.statusCode).toBe(200);
      expect((await as("POST", "/auth/2fa/verify", { action: "sell", backupCode: code })).statusCode).toBe(
        401,
      );
      expect((await as("GET", "/auth/2fa")).json()).toMatchObject({ backupCodesLeft: 9 });
    });

    it("pauses checks after five wrong tries", async () => {
      for (let i = 0; i < 5; i++)
        expect((await as("POST", "/auth/2fa/verify", { action: "sell", code: "000000" })).statusCode).toBe(
          401,
        );
      const locked = await as("POST", "/auth/2fa/verify", { action: "sell", backupCode: backupCodes[1]! });
      expect(locked.statusCode).toBe(401);
      expect(locked.json().error).toMatch(/Too many/);
    });

    it("asks at sign-in on a new browser, then lets that browser through", async () => {
      // Wallet sign-in's first step is a signature; the shared second half is what's under test,
      // so this signs in a Privy account with the same settings.
      const did = newDid();
      const privyWallet = wallet();
      privyWallets.set(did, privyWallet);
      const created = (await signIn(await privyToken(did))).json() as { id: string; sessionToken: string };
      const auth = { authorization: `Bearer ${created.sessionToken}` };
      const setup = await app.inject({ method: "POST", url: "/auth/2fa/totp/setup", headers: auth });
      expect(setup.statusCode).toBe(200);
      const secret = openSecret(
        env,
        created.id,
        (await prisma.twoFactorSettings.findUniqueOrThrow({ where: { userId: created.id } }))
          .pendingTotpSecret!,
      );
      const step = Math.floor(Date.now() / 30_000);
      const confirmed = await app.inject({
        method: "POST",
        url: "/auth/2fa/totp/confirm",
        headers: auth,
        payload: { code: totpCode(secret, step) },
      });

      const first = await signIn(await privyToken(did));
      expect(first.statusCode).toBe(200);
      const body = first.json();
      expect(body).toMatchObject({ twoFactorRequired: true, totp: true, passkey: false });
      expect(body.sessionToken).toBeUndefined();
      expect(first.cookies.some((c) => c.name === SESSION_COOKIE_NAME)).toBe(false);

      const wrong = await app.inject({
        method: "POST",
        url: "/auth/2fa/signin",
        payload: { ticket: body.ticket, code: "123456" },
      });
      expect(wrong.statusCode).toBe(401);
      const ok = await app.inject({
        method: "POST",
        url: "/auth/2fa/signin",
        payload: { ticket: body.ticket, code: totpCode(secret, step + 1) },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ walletAddress: privyWallet });
      // A ticket from before a sign-out everywhere no longer works.
      const before = (await signIn(await privyToken(did))).json() as { ticket?: string };
      await prisma.user.update({ where: { id: created.id }, data: { sessionVersion: { increment: 1 } } });
      const stale = await app.inject({
        method: "POST",
        url: "/auth/2fa/signin",
        payload: { ticket: before.ticket, code: totpCode(secret, step + 1) },
      });
      expect(stale.statusCode).toBe(401);
      // The ticket is spent.
      const reused = await app.inject({
        method: "POST",
        url: "/auth/2fa/signin",
        payload: { ticket: body.ticket, backupCode: "AAAA-AAAA" },
      });
      expect(reused.statusCode).toBe(401);
      // The browser that passed is remembered only until a sign-out (the bump above): it is
      // asked again.
      const device = ok.cookies.find((c) => c.name === "ts_2fa_device");
      expect(device).toBeDefined();
      const afterSignOut = await signIn(await privyToken(did), { ts_2fa_device: device!.value });
      expect(afterSignOut.json()).toMatchObject({ twoFactorRequired: true });
      // Passing again remembers it: no second ask.
      const again = await app.inject({
        method: "POST",
        url: "/auth/2fa/signin",
        payload: { ticket: afterSignOut.json().ticket, backupCode: confirmed.json().backupCodes[0] },
      });
      expect(again.statusCode).toBe(200);
      const fresh = again.cookies.find((c) => c.name === "ts_2fa_device");
      const known = await signIn(await privyToken(did), { ts_2fa_device: fresh!.value });
      expect(known.json()).toMatchObject({ walletAddress: privyWallet });
      expect(known.json().twoFactorRequired).toBeUndefined();
    });

    it("keeps a paired phone from turning two-factor on", async () => {
      const did = newDid();
      privyWallets.set(did, wallet());
      const created = (await signIn(await privyToken(did))).json() as { id: string };
      const device = await prisma.linkedDevice.create({ data: { userId: created.id } });
      const token = await app.sessionSigner.sign({
        userId: created.id,
        walletAddress: (await prisma.user.findUniqueOrThrow({ where: { id: created.id } })).walletAddress,
        deviceId: device.id,
      });
      const res = await app.inject({
        method: "POST",
        url: "/auth/2fa/totp/setup",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("trades", () => {
    const build = (cookie: string, body: object) =>
      app.inject({
        method: "POST",
        url: "/pro/trade/build",
        payload: { slippageBps: 100, speed: "eco", ...body },
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      });
    const sessionFor = async (address: string) => {
      const user = await prisma.user.upsert({
        where: { walletAddress: address },
        update: {},
        create: { walletAddress: address },
      });
      userIds.push(user.id);
      return {
        user,
        cookie: await createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS).sign({
          userId: user.id,
          walletAddress: address,
        }),
      };
    };

    it("asks for two-factor before building a buy, when the user chose it", async () => {
      const { user, cookie } = await sessionFor(ADMIN);
      await prisma.twoFactorSettings.upsert({
        where: { userId: user.id },
        update: { totpSecret: sealSecret(env, user.id, randomBytes(20)), actions: ["buy"] },
        create: { userId: user.id, totpSecret: sealSecret(env, user.id, randomBytes(20)), actions: ["buy"] },
      });
      const res = await build(cookie, { mint: SUBSCRIPTION_MINT, side: "buy", amount: "10000000" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ twoFactor: { action: "buy", totp: true, passkey: false } });
      const forged = await app.inject({
        method: "POST",
        url: "/pro/trade/build",
        payload: { mint: SUBSCRIPTION_MINT, side: "buy", amount: "10000000", slippageBps: 100, speed: "eco" },
        headers: { "x-ts-2fa": "forged" },
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      });
      expect(forged.statusCode).toBe(403);
    });

    it("lets a wallet without Pro Mode buy only the access token, up to 5 SOL, once trading is public", async () => {
      const { cookie } = await sessionFor(wallet());
      const was = env.PRO_TRADING_PUBLIC;
      try {
        env.PRO_TRADING_PUBLIC = false;
        expect(
          (await build(cookie, { mint: SUBSCRIPTION_MINT, side: "buy", amount: "10000000" })).statusCode,
        ).toBe(404);
        env.PRO_TRADING_PUBLIC = true;
        // The kill switch closes it too.
        const enabled = env.PRO_TRADING_ENABLED;
        env.PRO_TRADING_ENABLED = false;
        expect(
          (await build(cookie, { mint: SUBSCRIPTION_MINT, side: "buy", amount: "10000000" })).statusCode,
        ).toBe(404);
        env.PRO_TRADING_ENABLED = enabled;
        const other = await build(cookie, {
          mint: "So11111111111111111111111111111111111111112",
          side: "buy",
          amount: "10000000",
        });
        expect([403, 404]).toContain(other.statusCode);
        expect(
          (await build(cookie, { mint: SUBSCRIPTION_MINT, side: "buy", amount: String(6e9) })).statusCode,
        ).toBe(422);
        expect(
          (await build(cookie, { mint: SUBSCRIPTION_MINT, side: "sell", amount: "1000" })).statusCode,
        ).not.toBe(200);
      } finally {
        env.PRO_TRADING_PUBLIC = was;
      }
    });
  });
});
