import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { createSignInMessage, verifySignIn } from "@solana/wallet-standard-util";
import type { SolanaSignInInputWithRequiredFields } from "@solana/wallet-standard-util";
import type { SolanaSignInOutput } from "@solana/wallet-standard-features";
import { buildSignInMessage, buildSignInInput } from "./siws.js";

describe("buildSignInMessage", () => {
  const wallet = "5BsFsz73yqe15X59thZnFEwPyE7NH3xP9ZvyZwNwf3Bz";
  const nonce = "39ffde1b9f79290e8e7ad56bc873aebf";
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");

  it("includes the wallet address, nonce, and ISO timestamp", () => {
    const message = buildSignInMessage(wallet, nonce, issuedAt);
    expect(message).toContain(wallet);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain("Issued At: 2026-01-01T00:00:00.000Z");
  });

  it("is deterministic for the same inputs", () => {
    // Critical property: verification reconstructs this exact string server-side and compares
    // the signature against it - any nondeterminism here (e.g. Date.now() instead of the passed
    // issuedAt) breaks every sign-in. See the bug this guards against in siws.ts's issueNonce().
    const a = buildSignInMessage(wallet, nonce, issuedAt);
    const b = buildSignInMessage(wallet, nonce, issuedAt);
    expect(a).toBe(b);
  });

  it("produces a different message for a different nonce", () => {
    const a = buildSignInMessage(wallet, nonce, issuedAt);
    const b = buildSignInMessage(wallet, "different-nonce", issuedAt);
    expect(a).not.toBe(b);
  });
});

describe("buildSignInInput", () => {
  const nonce = "39ffde1b9f79290e8e7ad56bc873aebf";
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");
  const domain = "trenchscanner-web.onrender.com";

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
