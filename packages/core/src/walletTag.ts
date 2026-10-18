import { createHash } from "node:crypto";

/**
 * A user's wallet as it goes into a log line: the first 12 hex characters of its SHA-256, so one
 * user's lines can still be followed (and matched to a wallet an admin already has) without the
 * logs holding anyone's address (user ask 2026-10-18: our users' wallets are never exposed).
 * On-chain wallets the product labels on purpose (holders, KOLs, sides) are logged as they are.
 */
export function walletTag(wallet: string): string {
  return createHash("sha256").update(wallet).digest("hex").slice(0, 12);
}
