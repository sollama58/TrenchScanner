// Must precede the @trenchscanner/core import (via ./siws.js) - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createSignInMessage, verifySignIn } from "@solana/wallet-standard-util";
import type { SolanaSignInInputWithRequiredFields } from "@solana/wallet-standard-util";
import type { SolanaSignInOutput } from "@solana/wallet-standard-features";
import { appDomainForOrigin, loadEnv, prisma } from "@trenchscanner/core";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server.js";
import { buildSignInMessage, buildSignInInput } from "./siws.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe("buildSignInMessage", () => {
  const wallet = "5BsFsz73yqe15X59thZnFEwPyE7NH3xP9ZvyZwNwf3Bz";
  const nonce = "39ffde1b9f79290e8e7ad56bc873aebf";
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");

  it("includes the wallet address, nonce, and ISO timestamp", () => {
    const message = buildSignInMessage(wallet, nonce, issuedAt, "holdex.live");
    expect(message).toContain(wallet);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain("Issued At: 2026-01-01T00:00:00.000Z");
  });

  it("is deterministic for the same inputs", () => {
    // Critical property: verification reconstructs this exact string server-side and compares
    // the signature against it - any nondeterminism here (e.g. Date.now() instead of the passed
    // issuedAt) breaks every sign-in. See the bug this guards against in siws.ts's issueNonce().
    const a = buildSignInMessage(wallet, nonce, issuedAt, "holdex.live");
    const b = buildSignInMessage(wallet, nonce, issuedAt, "holdex.live");
    expect(a).toBe(b);
  });

  it("names the real domain and URI in the standard SIWS text, so wallets can check the origin", () => {
    const message = buildSignInMessage(wallet, nonce, issuedAt, "holdex.live");
    expect(message.startsWith("holdex.live wants you to sign in with your Solana account:\n")).toBe(true);
    expect(message).toContain("URI: https://holdex.live");
    // Byte-identical to what wallet.signIn() would sign for the same input.
    expect(message).toBe(
      new TextDecoder().decode(
        createSignInMessage(
          buildSignInInput(wallet, nonce, issuedAt, "holdex.live") as SolanaSignInInputWithRequiredFields,
        ),
      ),
    );
  });

  it("produces a different message for a different nonce", () => {
    const a = buildSignInMessage(wallet, nonce, issuedAt, "holdex.live");
    const b = buildSignInMessage(wallet, "different-nonce", issuedAt, "holdex.live");
    expect(a).not.toBe(b);
  });
});

describe("buildSignInInput", () => {
  const nonce = "39ffde1b9f79290e8e7ad56bc873aebf";
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");
  const domain = "holdex.live";

  it("includes domain, address, and nonce", () => {
    const wallet = randomWallet();
    const input = buildSignInInput(wallet, nonce, issuedAt, domain);
    expect(input.domain).toBe(domain);
    expect(input.address).toBe(wallet);
    expect(input.nonce).toBe(nonce);
  });

  // These exercise the exact same reference implementation (@solana/wallet-standard-util) that
  // production code (siws.ts's verifySignInAndConsumeNonce) and real wallets both use, so a
  // pass/fail here reflects what would actually happen with a real Phantom/Solflare signature -
  // this is the core anti-phishing property the whole signIn flow exists for.
  describe("against the real Wallet Standard reference implementation", () => {
    it("verifies a signature produced for the real domain", () => {
      const { wallet, output } = signAsWallet(nonce, issuedAt, domain);
      const input = buildSignInInput(wallet, nonce, issuedAt, domain);
      expect(verifySignIn(input, output)).toBe(true);
    });

    it("rejects a signature produced for a different domain (simulated phishing)", () => {
      // The wallet signed what a phishing site asked for (a message claiming a different domain)...
      const { wallet, output } = signAsWallet(nonce, issuedAt, "phishing-site.example");
      // ...but our server only ever verifies against the real, server-configured domain.
      const realInput = buildSignInInput(wallet, nonce, issuedAt, domain);
      expect(verifySignIn(realInput, output)).toBe(false);
    });

    it("rejects a signature over a tampered nonce", () => {
      const { wallet, output } = signAsWallet("a-different-nonce", issuedAt, domain);
      const input = buildSignInInput(wallet, nonce, issuedAt, domain);
      expect(verifySignIn(input, output)).toBe(false);
    });

    it("rejects a signature from a different keypair than the one it claims to be", () => {
      const { output } = signAsWallet(nonce, issuedAt, domain);
      const input = buildSignInInput(randomWallet(), nonce, issuedAt, domain);
      expect(verifySignIn(input, output)).toBe(false);
    });
  });
});

/**
 * The legacy signMessage() path of POST /auth/verify, end to end. Its only guard is the ed25519
 * check in verifyAndConsumeNonce: replacing it with `true` used to leave every api test green
 * (full audit 2026-10-27, CH-1), so a refactor could let anyone holding a nonce for an admin
 * wallet sign in as it. Each case below signs something other than the message the server
 * rebuilds and must get 401 bad_signature with the nonce left unspent.
 */
describe.skipIf(!dbAvailable)("POST /auth/verify, legacy signMessage path", () => {
  let app: FastifyInstance;
  const wallets: string[] = [];
  const env = loadEnv({ ...process.env });
  // What /auth/nonce chose for a request with no Origin, so a rebuilt message matches the issued one.
  const domain = appDomainForOrigin(env, undefined);

  beforeAll(async () => {
    app = await buildServer(env);
  });

  afterAll(async () => {
    await app?.close();
    if (!dbAvailable) return;
    await prisma.authNonce.deleteMany({ where: { walletAddress: { in: wallets } } });
    await prisma.user.deleteMany({ where: { walletAddress: { in: wallets } } });
  });

  function newWallet() {
    const kp = nacl.sign.keyPair();
    const wallet = bs58.encode(kp.publicKey);
    wallets.push(wallet);
    return { kp, wallet };
  }

  async function issue(wallet: string) {
    const res = await app.inject({ method: "POST", url: "/auth/nonce", payload: { wallet } });
    expect(res.statusCode).toBe(200);
    const { nonce, message } = res.json() as { nonce: string; message: string };
    const row = await prisma.authNonce.findUniqueOrThrow({ where: { nonce } });
    return { nonce, message, issuedAt: row.createdAt };
  }

  const sign = (text: string, kp: nacl.SignKeyPair) =>
    bs58.encode(nacl.sign.detached(new TextEncoder().encode(text), kp.secretKey));

  const verify = (walletAddress: string, nonce: string, signature: string) =>
    app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { method: "signMessage", walletAddress, nonce, signature },
    });

  async function expectRefused(res: Awaited<ReturnType<typeof verify>>, nonce: string) {
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "bad_signature" });
    expect(res.cookies.length).toBe(0);
    // A refused signature must not spend the nonce: the real owner can still use it.
    const row = await prisma.authNonce.findUniqueOrThrow({ where: { nonce } });
    expect(row.usedAt).toBeNull();
  }

  it("refuses the right message signed by a different key", async () => {
    const victim = newWallet();
    const attacker = nacl.sign.keyPair();
    const { nonce, message } = await issue(victim.wallet);
    await expectRefused(await verify(victim.wallet, nonce, sign(message, attacker)), nonce);
  });

  it("refuses a signature over a different nonce's message", async () => {
    const { kp, wallet } = newWallet();
    const { nonce, issuedAt } = await issue(wallet);
    const other = buildSignInMessage(wallet, "0".repeat(32), issuedAt, domain);
    await expectRefused(await verify(wallet, nonce, sign(other, kp)), nonce);
  });

  it("refuses a signature over the same nonce for a different domain (phishing page)", async () => {
    const { kp, wallet } = newWallet();
    const { nonce, issuedAt } = await issue(wallet);
    const phished = buildSignInMessage(wallet, nonce, issuedAt, "phishing-site.example");
    await expectRefused(await verify(wallet, nonce, sign(phished, kp)), nonce);
  });

  it("refuses a signature that is not a signature at all", async () => {
    const { wallet } = newWallet();
    const { nonce } = await issue(wallet);
    await expectRefused(await verify(wallet, nonce, bs58.encode(new Uint8Array(64))), nonce);
    await expectRefused(await verify(wallet, nonce, "not-base58-0OIl"), nonce);
  });

  it("signs in with the wallet's own signature over the issued message, once", async () => {
    const { kp, wallet } = newWallet();
    const { nonce, message } = await issue(wallet);
    const signature = sign(message, kp);

    const ok = await verify(wallet, nonce, signature);
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { sessionToken?: string }).sessionToken).toBeTruthy();
    expect(await prisma.user.findUnique({ where: { walletAddress: wallet } })).not.toBeNull();

    // The same signed nonce a second time is a replay.
    const replay = await verify(wallet, nonce, signature);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ error: "nonce_used" });
  });
});

function randomWallet(): string {
  return bs58.encode(nacl.sign.keyPair().publicKey);
}

/** Simulates exactly what a real Wallet-Standard wallet does inside wallet.signIn(input). */
function signAsWallet(
  nonce: string,
  issuedAt: Date,
  domain: string,
): { wallet: string; output: SolanaSignInOutput } {
  const keypair = nacl.sign.keyPair();
  const wallet = bs58.encode(keypair.publicKey);
  const input = buildSignInInput(wallet, nonce, issuedAt, domain) as SolanaSignInInputWithRequiredFields;
  const signedMessage = createSignInMessage(input);
  const signature = nacl.sign.detached(signedMessage, keypair.secretKey);

  const output: SolanaSignInOutput = {
    account: { address: wallet, publicKey: keypair.publicKey, chains: [], features: [] },
    signedMessage,
    signature,
  };
  return { wallet, output };
}
