import { createHash } from "node:crypto";

/**
 * A wallet as logs name it: the first 12 hex characters of its sha256, so log lines about one
 * wallet can be matched up without the address itself ever reaching the logs (user rule
 * 2026-10-18: wallet addresses stay private). Same algorithm as core's walletTag, which replaces
 * this once it is on main.
 */
export function walletTag(wallet: string): string {
  return createHash("sha256").update(wallet).digest("hex").slice(0, 12);
}
