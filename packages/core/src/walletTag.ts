import { createHash, createHmac } from "node:crypto";

/**
 * A user's wallet as it goes into a log line: the first 12 hex characters of its HMAC-SHA-256
 * under WALLET_TAG_SECRET, so one user's lines can still be followed without the logs holding
 * anyone's address (user ask 2026-10-18: our users' wallets are never exposed). Keyed, so nobody
 * holding the logs can turn a tag back into a wallet by hashing the chain's wallets. Without the
 * secret (local runs, tests) it is a plain SHA-256.
 * On-chain wallets the product labels on purpose (holders, KOLs, sides) are logged as they are.
 */
export function walletTag(wallet: string): string {
  const secret = process.env.WALLET_TAG_SECRET;
  const hash = secret ? createHmac("sha256", secret) : createHash("sha256");
  return hash.update(wallet).digest("hex").slice(0, 12);
}
