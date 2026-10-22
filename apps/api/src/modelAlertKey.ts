import { createHash, randomBytes } from "node:crypto";
import type { AccessState } from "@trenchscanner/core";

/** Active (not revoked) Model Alert keys one user may hold. */
export const MAX_MODEL_ALERT_KEYS = 3;

const PREFIX_LENGTH = 12;

/**
 * Who may generate a key or hold a Model Alert socket open.
 *
 * The same three reasons decideAccess uses for paid access: an admin wallet, a live whitelist
 * entry, or a subscription whose expiresAt is still in the future (a burn writes that row).
 * free_access is a real sign-in and passes the dashboard paywall, and it is deliberately not
 * enough here. `none` is not either.
 */
export function modelAlertKeyAccess(access: AccessState): boolean {
  return access.reason === "admin" || access.reason === "whitelist" || access.reason === "subscription";
}

/** The 403 body for a wallet that may use the site but not this API. */
export function modelAlertKeyDeniedMessage(reason: AccessState["reason"]): string {
  if (reason === "free_access") {
    return "Free access does not include Model Alert API keys. A paid subscription, admin wallet, or whitelist entry is required.";
  }
  return "Model Alert API keys require a paid subscription, an admin wallet, or a whitelist entry.";
}

/** SHA-256 hex of the secret. The secret itself is never stored or logged. */
export function hashModelAlertKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/**
 * A new secret. `prefix` is what Settings shows later; it is not enough to authenticate.
 * `secret` is returned to the user once, from the generate route only.
 */
export function newModelAlertKey(): { secret: string; prefix: string; secretHash: string } {
  const secret = `tsma_${randomBytes(32).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, PREFIX_LENGTH), secretHash: hashModelAlertKey(secret) };
}

/** The advisory-lock key for issuing or revoking one user's keys, so the cap of three holds. */
export function modelAlertKeyLock(userId: string): string {
  return `model-alert-key:${userId}`;
}
