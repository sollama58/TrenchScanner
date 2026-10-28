import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { prisma } from "@trenchscanner/core";
import { BUDDY_EXTRA_WALLETS } from "./extensionBuddy.js";

/**
 * Trade Buddy's linked wallets (user decision 2026-10-27, Card 11): the reader's other wallets
 * (Axiom's, Terminal's...) are followed only once the reader has signed a message with each one on
 * Settings. Before, any paid key could name any three wallets a poll, and the server followed
 * strangers' busy wallets on our Helius key (audit 2026-10-27, AP-1 = EX-1).
 *
 * The message is plain text of its own, never the Sign-In-With-Solana text: a link signature can't
 * sign anyone in, and a sign-in signature can't link a wallet. Its nonce is an AuthNonce row tied to
 * the account and the wallet both, so it links only that wallet to that account, once.
 */

/** How long a link message may wait for its signature. */
const LINK_NONCE_TTL_MS = 5 * 60_000;
/** One account's linked wallets are reused this long by Trade Buddy's polls; a change here drops them. */
const LINKED_CACHE_MS = 30_000;
const LINKED_CACHE_MAX = 5_000;

const linkedCache = new Map<string, { at: number; wallets: string[] }>();

/** The AuthNonce key of a link: the account and the wallet, so the nonce links nothing else. */
const nonceKey = (userId: string, wallet: string) => `buddy:${userId}:${wallet}`;

/** The exact text the wallet signs. */
export function buddyLinkMessage(
  domain: string,
  accountWallet: string,
  wallet: string,
  nonce: string,
  issuedAt: Date,
): string {
  return [
    `${domain} asks you to link this wallet to a TrenchScanner account.`,
    "",
    "Trade Buddy will list this wallet's trades in the account's browser extension. This request will not trigger a blockchain transaction or cost any fees, and it does not sign you in.",
    "",
    `Wallet: ${wallet}`,
    `Account: ${accountWallet}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt.toISOString()}`,
  ].join("\n");
}

export async function issueBuddyLink(
  userId: string,
  accountWallet: string,
  wallet: string,
  domain: string,
): Promise<{ nonce: string; message: string; expiresAt: Date }> {
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + LINK_NONCE_TTL_MS);
  await prisma.authNonce.create({
    data: { walletAddress: nonceKey(userId, wallet), nonce, expiresAt, createdAt: issuedAt },
  });
  return { nonce, message: buddyLinkMessage(domain, accountWallet, wallet, nonce, issuedAt), expiresAt };
}

export type LinkResult =
  | { ok: true; wallets: string[] }
  | { ok: false; reason: "nonce_not_found" | "nonce_expired" | "nonce_used" | "bad_signature" | "full" };

/** Checks the signature, spends the nonce, and links the wallet, within the account's cap. */
export async function linkBuddyWallet(params: {
  userId: string;
  accountWallet: string;
  wallet: string;
  nonce: string;
  signature: string;
  domain: string;
}): Promise<LinkResult> {
  const { userId, accountWallet, wallet, nonce, signature, domain } = params;
  const record = await prisma.authNonce.findUnique({ where: { nonce } });
  if (!record || record.walletAddress !== nonceKey(userId, wallet))
    return { ok: false, reason: "nonce_not_found" };
  if (record.usedAt) return { ok: false, reason: "nonce_used" };
  if (record.expiresAt.getTime() < Date.now()) return { ok: false, reason: "nonce_expired" };
  const message = buddyLinkMessage(domain, accountWallet, wallet, nonce, record.createdAt);
  if (!signedBy(wallet, message, signature)) return { ok: false, reason: "bad_signature" };
  const spent = await prisma.authNonce.updateMany({
    where: { id: record.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (spent.count !== 1) return { ok: false, reason: "nonce_used" };
  const linked = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buddy-wallets:${userId}`}))`;
    const rows = await tx.buddyWallet.findMany({ where: { userId }, select: { wallet: true } });
    if (rows.some((r) => r.wallet === wallet)) return rows.map((r) => r.wallet);
    if (rows.length >= BUDDY_EXTRA_WALLETS) return null;
    await tx.buddyWallet.create({ data: { userId, wallet } });
    return [...rows.map((r) => r.wallet), wallet];
  });
  forgetBuddyWallets(userId);
  return linked ? { ok: true, wallets: linked } : { ok: false, reason: "full" };
}

export async function unlinkBuddyWallet(userId: string, wallet: string): Promise<boolean> {
  const { count } = await prisma.buddyWallet.deleteMany({ where: { userId, wallet } });
  forgetBuddyWallets(userId);
  return count > 0;
}

/** The account's linked wallets, oldest first. */
export async function listBuddyWallets(userId: string): Promise<{ wallet: string; createdAt: Date }[]> {
  return prisma.buddyWallet.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { wallet: true, createdAt: true },
  });
}

/** The linked wallets Trade Buddy follows, from a short per-process cache. */
export async function linkedBuddyWallets(userId: string, now = Date.now()): Promise<string[]> {
  const hit = linkedCache.get(userId);
  if (hit && now - hit.at < LINKED_CACHE_MS) return hit.wallets;
  const wallets = (await listBuddyWallets(userId)).map((r) => r.wallet);
  if (!linkedCache.has(userId) && linkedCache.size >= LINKED_CACHE_MAX) {
    const oldest = linkedCache.keys().next().value;
    if (oldest !== undefined) linkedCache.delete(oldest);
  }
  linkedCache.set(userId, { at: now, wallets });
  return wallets;
}

export function forgetBuddyWallets(userId?: string): void {
  if (userId === undefined) linkedCache.clear();
  else linkedCache.delete(userId);
}

function signedBy(wallet: string, message: string, signatureBase58: string): boolean {
  try {
    return nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      bs58.decode(signatureBase58),
      bs58.decode(wallet),
    );
  } catch {
    return false;
  }
}
