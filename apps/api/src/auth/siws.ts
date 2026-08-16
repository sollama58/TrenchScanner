import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { prisma, createLogger } from "@trenchscanner/core";

const logger = createLogger("siws");

const NONCE_TTL_MINUTES = 5;
const APP_DOMAIN = "TrenchScanner";

/** Issues a fresh one-time nonce for a wallet address and persists it for later verification. */
export async function issueNonce(walletAddress: string): Promise<{ nonce: string; message: string; expiresAt: Date }> {
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

  return { nonce, message: buildSignInMessage(walletAddress, nonce, issuedAt), expiresAt };
}

/** The exact message the wallet must sign - must match what the client displays/signs, byte for byte. */
export function buildSignInMessage(walletAddress: string, nonce: string, issuedAt: Date): string {
  return [
    `${APP_DOMAIN} wants you to sign in with your Solana account:`,
    walletAddress,
    "",
    "Sign in to view and manage your token filters. This request will not trigger a blockchain transaction or cost any fees.",
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ].join("\n");
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "nonce_not_found" | "nonce_expired" | "nonce_used" | "bad_signature" };

/**
 * Verifies a wallet's signature over the nonce message and, on success,
 * consumes the nonce (single use). Signature and wallet address are both
 * expected base58-encoded, matching Solana/wallet-adapter conventions.
 */
export async function verifyAndConsumeNonce(params: {
  walletAddress: string;
  nonce: string;
  signature: string;
}): Promise<VerifyResult> {
  const { walletAddress, nonce, signature } = params;

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

  const message = buildSignInMessage(walletAddress, nonce, record.createdAt);
  const valid = verifySignature(walletAddress, message, signature);
  if (!valid) {
    return { ok: false, reason: "bad_signature" };
  }

  await prisma.authNonce.update({ where: { id: record.id }, data: { usedAt: new Date() } });
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
