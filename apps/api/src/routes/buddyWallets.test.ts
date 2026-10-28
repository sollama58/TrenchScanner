// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { AccessSource } from "@prisma/client";
import { loadEnv, prisma, type Env } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_SESSION_MAX_AGE_MS, createSessionSigner, SESSION_COOKIE_NAME } from "../auth/session.js";
import { forgetBuddyWallets } from "../buddyWallets.js";
import { resetContestStateCache } from "../contest.js";
import { resetOverlayLookupCache } from "../extensionLookup.js";
import { buildServer } from "../server.js";
import { resetExtensionAuthState } from "./extension.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `buddy-${Date.now()}`;
const mint = () => bs58.encode(randomBytes(32));

/**
 * Trade Buddy follows only wallets linked to the account by a signature (Card 11, AP-1), and the
 * Card 16 extension items: the lookup gate on the database-only routes (EX-5), the feed's switches
 * (EX-6), and admin keys that expire (AP-6).
 */
describe.skipIf(!dbAvailable)("Trade Buddy's linked wallets and the extension's gates", () => {
  let app: FastifyInstance;
  const env: Env = dbAvailable
    ? { ...loadEnv(), ADMIN_WALLET_ADDRESSES: `${TAG}-admin` }
    : (undefined as never);
  const signer = dbAvailable
    ? createSessionSigner(env.JWT_SECRET, env.SESSION_TTL_HOURS)
    : (undefined as never);
  const mints: string[] = [];

  async function makeUser(suffix: string, paid = true) {
    const walletAddress = `${TAG}-${suffix}`;
    const row = await prisma.user.create({
      data: { walletAddress, feedModels: ["rules"], curatedModel: "rules", followBestModel: false },
    });
    if (paid)
      await prisma.subscription.create({
        data: { userId: row.id, expiresAt: new Date(Date.now() + 86_400_000), source: AccessSource.BURN },
      });
    const cookie = await signer.sign({
      userId: row.id,
      walletAddress,
      sessionVersion: 0,
      issuedAtMs: Date.now(),
    });
    const key = (
      await app.inject({
        method: "POST",
        url: "/settings/extension-keys",
        cookies: { [SESSION_COOKIE_NAME]: cookie },
      })
    ).json().secret as string;
    return { id: row.id, walletAddress, cookie, key };
  }

  const site = (cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, cookies: { [SESSION_COOKIE_NAME]: cookie }, payload: payload as never });
  const ext = (key: string, method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      payload: payload as never,
      headers: {
        origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        authorization: `Bearer ${key}`,
      },
    });

  /** Asks for the link message and signs it with `pair`, as the wallet would. */
  async function signLink(cookie: string, pair: nacl.SignKeyPair, wallet = bs58.encode(pair.publicKey)) {
    const issued = await site(cookie, "POST", "/settings/buddy-wallets/nonce", { wallet });
    expect(issued.statusCode).toBe(200);
    const { nonce, message } = issued.json() as { nonce: string; message: string };
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), pair.secretKey));
    return { wallet, nonce, signature, message };
  }

  beforeAll(async () => {
    resetContestStateCache();
    resetOverlayLookupCache();
    resetExtensionAuthState();
    forgetBuddyWallets();
    app = await buildServer(env);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { in: mints } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  }, 30_000);

  it("links a wallet only with its own signature, once, and up to the cap", async () => {
    const user = await makeUser("link");
    const pair = nacl.sign.keyPair();
    const signed = await signLink(user.cookie, pair);
    expect(signed.message).toContain(signed.wallet);
    expect(signed.message).toContain(user.walletAddress);
    expect(signed.message).toMatch(/does not sign you in/);

    // Signed by another key: refused, and the nonce is still unspent.
    const stranger = nacl.sign.keyPair();
    const forged = bs58.encode(
      nacl.sign.detached(new TextEncoder().encode(signed.message), stranger.secretKey),
    );
    const refused = await site(user.cookie, "POST", "/settings/buddy-wallets", {
      ...signed,
      signature: forged,
    });
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error).toBe("bad_signature");

    const linked = await site(user.cookie, "POST", "/settings/buddy-wallets", signed);
    expect(linked.statusCode).toBe(200);
    expect(linked.json().wallets).toEqual([signed.wallet]);
    // A nonce links once.
    expect((await site(user.cookie, "POST", "/settings/buddy-wallets", signed)).json().error).toBe(
      "nonce_used",
    );
    // Another account can't spend this account's nonce for the same wallet.
    const other = await makeUser("link-other");
    const again = await signLink(user.cookie, pair);
    expect((await site(other.cookie, "POST", "/settings/buddy-wallets", again)).json().error).toBe(
      "nonce_not_found",
    );

    for (let i = 0; i < 2; i++) {
      const next = await signLink(user.cookie, nacl.sign.keyPair());
      expect((await site(user.cookie, "POST", "/settings/buddy-wallets", next)).statusCode).toBe(200);
    }
    const fourth = await signLink(user.cookie, nacl.sign.keyPair());
    expect((await site(user.cookie, "POST", "/settings/buddy-wallets", fourth)).statusCode).toBe(409);

    const list = await site(user.cookie, "GET", "/settings/buddy-wallets");
    expect(list.json().limit).toBe(3);
    expect((list.json().wallets as { wallet: string }[]).map((w) => w.wallet)[0]).toBe(signed.wallet);
    expect((await site(user.cookie, "DELETE", `/settings/buddy-wallets/${signed.wallet}`)).statusCode).toBe(
      200,
    );
    expect((await site(user.cookie, "DELETE", `/settings/buddy-wallets/${signed.wallet}`)).statusCode).toBe(
      404,
    );

    // The account's own wallet is followed already; a free account can't link.
    expect(
      (await site(user.cookie, "POST", "/settings/buddy-wallets/nonce", { wallet: user.walletAddress }))
        .statusCode,
    ).toBe(400);
    const free = await makeUser("link-free", false);
    expect(
      (await site(free.cookie, "POST", "/settings/buddy-wallets/nonce", { wallet: mint() })).statusCode,
    ).toBe(403);
  });

  it("follows only linked wallets on Trade Buddy, and says which asked-for ones aren't", async () => {
    const user = await makeUser("follow");
    const pair = nacl.sign.keyPair();
    const signed = await signLink(user.cookie, pair);
    expect((await site(user.cookie, "POST", "/settings/buddy-wallets", signed)).statusCode).toBe(200);
    const stranger = mint();

    const res = await ext(user.key, "GET", `/ext/v1/buddy?wallets=${signed.wallet},${stranger}`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { wallets: string[]; notLinked?: string[] };
    expect(body.notLinked).toEqual([stranger]);
    expect(body.wallets).not.toContain(stranger);
    // Without a list, every linked wallet is followed and nothing is refused.
    const all = (await ext(user.key, "GET", "/ext/v1/buddy")).json() as { notLinked?: string[] };
    expect(all.notLinked).toBeUndefined();
  });

  it("answers a coin's card and board numbers only for coins the reader opens free (EX-5)", async () => {
    const user = await makeUser("gate");
    const [tracked, lookedUp] = [mint(), mint()];
    mints.push(tracked, lookedUp);
    for (const [m, source] of [
      [tracked, "pumpfun"],
      [lookedUp, "utility"],
    ] as const) {
      const token = await prisma.token.create({
        data: { mintAddress: m, symbol: "GATE", discoverySource: source },
      });
      await prisma.tokenSnapshot.create({
        data: { tokenId: token.id, priceUsd: 0.00001, marketCapUsd: 9_000 },
      });
    }
    expect((await ext(user.key, "GET", `/ext/v1/token/${tracked}`)).json().token).not.toBeNull();
    expect((await ext(user.key, "GET", `/ext/v1/token/${lookedUp}`)).json().token).toBeNull();
    const stats = (await ext(user.key, "POST", "/ext/v1/stats", { mints: [tracked, lookedUp] })).json() as {
      tokens: Record<string, unknown>;
    };
    expect(Object.keys(stats.tokens)).toEqual([tracked]);
    const safety = (await ext(user.key, "POST", "/ext/v1/safety", { mints: [tracked, lookedUp] })).json() as {
      verdicts: Record<string, unknown>;
    };
    expect(Object.keys(safety.verdicts)).not.toContain(lookedUp);
  });

  it("keeps model calls off the panel's feed when the reader turned model alerts off (EX-6)", async () => {
    const user = await makeUser("switches");
    const called = mint();
    mints.push(called);
    const token = await prisma.token.create({ data: { mintAddress: called, symbol: "CALL" } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 0.00001, marketCapUsd: 7_000 },
    });
    await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        snapshotId: snapshot.id,
        source: "test",
        anchorPriceUsd: 0.00001,
        anchorMcapUsd: 7_000,
        liveMcapUsd: 7_400,
        model: "rules",
        modelName: "Rules",
        confidence: 70,
        tier: "standard",
      },
    });
    const feed = async () =>
      (
        (await ext(user.key, "GET", "/ext/v1/feed")).json() as {
          tokens: { mint: string; modelCalls: { mcapUsd: number }[] }[];
        }
      ).tokens;
    const on = (await feed()).find((t) => t.mint === called);
    // The cap at alert is Pump.fun's, as the web's card shows it (EX-7).
    expect(on?.modelCalls[0]?.mcapUsd).toBe(7_400);
    await prisma.user.update({ where: { id: user.id }, data: { showModelAlerts: false } });
    // Past the feed's own 4 s reuse.
    await new Promise((r) => setTimeout(r, 4_100));
    expect((await feed()).some((t) => t.mint === called)).toBe(false);
  });

  it("stops an admin's key after the admin sign-in's 7 days (AP-6)", async () => {
    const admin = await makeUser("admin", false);
    expect((await ext(admin.key, "GET", "/ext/v1/me")).statusCode).toBe(200);
    await prisma.extensionKey.updateMany({
      where: { userId: admin.id },
      data: { createdAt: new Date(Date.now() - ADMIN_SESSION_MAX_AGE_MS - 60_000) },
    });
    resetExtensionAuthState();
    const res = await ext(admin.key, "GET", "/ext/v1/me");
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/7 days/);
    // A paid reader's old key is untouched.
    const reader = await makeUser("old-reader");
    await prisma.extensionKey.updateMany({
      where: { userId: reader.id },
      data: { createdAt: new Date(Date.now() - 90 * 86_400_000) },
    });
    resetExtensionAuthState();
    expect((await ext(reader.key, "GET", "/ext/v1/me")).statusCode).toBe(200);
  });
});
