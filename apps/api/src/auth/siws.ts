import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { verifySignIn } from "@solana/wallet-standard-util";
import type { SolanaSignInInput, SolanaSignInOutput } from "@solana/wallet-standard-features";
import type { WalletAccount } from "@wallet-standard/base";
import { prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("siws");

const NONCE_TTL_MINUTES = 5;
/** Legacy plain-text flow only - see buildSignInMessage(). The signIn flow uses `domain` instead (a real host, not a brand name). */
const APP_DOMAIN = "TrenchScanner";
const SIWS_STATEMENT =
  "Sign in to view and manage your token filters. This request will not trigger a blockchain transaction or cost any fees.";
const SIWS_VERSION = "1";

export interface IssuedNonce {
  nonce: string;
  expiresAt: Date;
  /** Legacy flow: plain text for wallets without solana:signIn support (see verifyAndConsumeNonce). */
  message: string;
  /** Preferred flow: structured input for wallet.signIn() - see verifySignInAndConsumeNonce(). */
  signInInput: SolanaSignInInput;
}

/** Issues a fresh one-time nonce for a wallet address and persists it for later verification. */
export async function issueNonce(walletAddress: string, domain: string): Promise<IssuedNonce> {
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MINUTES * 60_000);

  await prisma.authNonce.create({
    // createdAt is set explicitly (rather than relying on the schema's @default(now())) so it
    // exactly matches the `issuedAt` baked into the signed message below - the DB write happens
    // a few ms after `issuedAt` was computed, and that drift would otherwise make the message
    // verify() reconstructs never match what the wallet actually signed.
    data: { walletAddress, nonce, expiresAt, createdAt: issuedAt },
  });

  return {
    nonce,
    expiresAt,
    message: buildSignInMessage(walletAddress, nonce, issuedAt),
    signInInput: buildSignInInput(walletAddress, nonce, issuedAt, domain),
  };
}

/** The exact message the wallet must sign - must match what the client displays/signs, byte for byte. */
export function buildSignInMessage(walletAddress: string, nonce: string, issuedAt: Date): string {
  return [
    `${APP_DOMAIN} wants you to sign in with your Solana account:`,
    walletAddress,
    "",
    SIWS_STATEMENT,
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ].join("\n");
}

/**
 * The structured Sign-In-With-Solana input for wallet.signIn(). `domain` is the field that
 * actually buys us anything over the legacy plain-message flow: Wallet-Standard-compliant
 * wallets (Phantom, Solflare) cross-check it against the page's real origin before signing, so a
 * phishing site cannot get a valid signature for our domain no matter what message text it shows.
 */
export function buildSignInInput(
  walletAddress: string,
  nonce: string,
  issuedAt: Date,
  domain: string,
): SolanaSignInInput {
  return {
    domain,
    address: walletAddress,
    statement: SIWS_STATEMENT,
    uri: `https://${domain}`,
    version: SIWS_VERSION,
    nonce,
    issuedAt: issuedAt.toISOString(),
  };
}

type NonceLookupFailureReason = "nonce_not_found" | "nonce_expired" | "nonce_used";
export type VerifyResult = { ok: true } | { ok: false; reason: NonceLookupFailureReason | "bad_signature" };

interface ValidNonceRecord {
  id: string;
  walletAddress: string;
  createdAt: Date;
}

/** Shared nonce lookup/validation for both the legacy and signIn verification flows. Does not consume the nonce. */
async function findValidNonce(
  nonce: string,
  walletAddress: string,
): Promise<{ ok: true; record: ValidNonceRecord } | { ok: false; reason: NonceLookupFailureReason }> {
  const record = await prisma.authNonce.findUnique({ where: { nonce } });
  if (!record || record.walletAddress !== walletAddress) {
    return { ok: false, reason: "nonce_not_found" };
  }
  if (record.usedAt) {
    return { ok: false, reason: "nonce_used" };
  }
  if (record.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "nonce_expired" };
  }
  return { ok: true, record };
}

/**
 * Legacy path: verifies a plain-message signMessage() signature. Kept for wallets that don't
 * implement the solana:signIn Wallet Standard feature - prefer verifySignInAndConsumeNonce()
 * whenever the connected wallet supports it, since only that path is domain-bound.
 */
export async function verifyAndConsumeNonce(params: {
  walletAddress: string;
  nonce: string;
  signature: string;
}): Promise<VerifyResult> {
  const { walletAddress, nonce, signature } = params;

  const lookup = await findValidNonce(nonce, walletAddress);
  if (!lookup.ok) return lookup;

  const message = buildSignInMessage(walletAddress, nonce, lookup.record.createdAt);
  const valid = verifySignature(walletAddress, message, signature);
  if (!valid) {
    return { ok: false, reason: "bad_signature" };
  }

  await prisma.authNonce.update({ where: { id: lookup.record.id }, data: { usedAt: new Date() } });
  return { ok: true };
}

export interface SignInOutputWire {
  /** base58-encoded */
  publicKey: string;
  /** base58-encoded */
  signedMessage: string;
  /** base58-encoded */
  signature: string;
}

/**
 * Preferred path: verifies a wallet.signIn() result. Reconstructs the expected
 * SolanaSignInInput entirely from server-held state (never from anything the client claims it
 * used) and delegates the actual message/signature verification to the same reference
 * implementation (@solana/wallet-standard-util) that wallets themselves are built on - this
 * guarantees byte-for-byte agreement with the Wallet Standard's message format rather than a
 * hand-rolled reimplementation.
 *
 * verifySignIn() alone only proves "some keypair signed a message that says `<address>` wants to
 * sign in" - it does NOT itself check that the signing keypair actually corresponds to that
 * address (nothing stops a malicious client from asking to sign in as a victim's address text
 * while signing with its own, unrelated key). We close that gap explicitly below.
 */
export async function verifySignInAndConsumeNonce(params: {
  walletAddress: string;
  nonce: string;
  domain: string;
  output: SignInOutputWire;
}): Promise<VerifyResult> {
  const { walletAddress, nonce, domain, output } = params;

  const lookup = await findValidNonce(nonce, walletAddress);
  if (!lookup.ok) return lookup;

  let valid: boolean;
  try {
    const publicKeyBytes = bs58.decode(output.publicKey);

    // The keypair that produced this signature must be the one for the address this nonce was
    // actually issued to - verifySignIn below checks the message text says the right address,
    // but never ties that text back to the signing key itself.
    if (bs58.encode(publicKeyBytes) !== walletAddress) {
      return { ok: false, reason: "bad_signature" };
    }

    const input = buildSignInInput(walletAddress, nonce, lookup.record.createdAt, domain);
    const account: WalletAccount = {
      address: walletAddress,
      publicKey: publicKeyBytes,
      chains: ["solana:mainnet"],
      features: ["solana:signIn"],
    };
    const signInOutput: SolanaSignInOutput = {
      account,
      signedMessage: bs58.decode(output.signedMessage),
      signature: bs58.decode(output.signature),
    };

    valid = verifySignIn(input, signInOutput);
  } catch (err) {
    logger.warn("signIn verification threw", { walletAddress, error: String(err) });
    valid = false;
  }

  if (!valid) {
    return { ok: false, reason: "bad_signature" };
  }

  await prisma.authNonce.update({ where: { id: lookup.record.id }, data: { usedAt: new Date() } });
  return { ok: true };
}

function verifySignature(walletAddress: string, message: string, signatureBase58: string): boolean {
  try {
    const publicKeyBytes = bs58.decode(walletAddress);
    const signatureBytes = bs58.decode(signatureBase58);
    const messageBytes = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch (err) {
    logger.warn("signature verification threw", { walletAddress, error: String(err) });
    return false;
  }
}
