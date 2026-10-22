import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccessState } from "@trenchscanner/core";

/** Active (not revoked) Model Alert keys one user may hold. */
export const MAX_MODEL_ALERT_KEYS = 3;
/**
 * Open sockets one key may hold on this process. Two covers a live client and a reconnect
 * that overlaps it. A third is refused so one key cannot fan an alert out without bound.
 */
export const MAX_SOCKETS_PER_KEY = 2;
/**
 * Open sockets one user may hold on this process, across every key. Lower than
 * keys × per-key so the three keys cannot each sit at their own cap at once.
 */
export const MAX_SOCKETS_PER_USER = 4;

const PREFIX_LENGTH = 12;
/** `tsma_` plus 32 bytes of base64url, which is 43 characters and no padding. */
const SECRET_BYTES = 32;
const KEY_SHAPE = /^tsma_[A-Za-z0-9_-]{43}$/;

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

/** True only for a secret this server would issue. Shorter tokens are rejected before a lookup. */
export function isModelAlertKeyShape(secret: string): boolean {
  return KEY_SHAPE.test(secret);
}

/**
 * Pepper for Model Alert key hashes. Derived from JWT_SECRET, the server secret the process
 * already requires, so a copied `secretHash` column cannot be checked without this process.
 * Domain-separated from the two-factor keys, which use the same input for a different purpose.
 */
function pepper(serverSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", serverSecret, "trenchscanner-model-alert-key", "hmac", 32));
}

/**
 * HMAC-SHA256 hex of the secret, keyed with the pepper. The secret itself is never stored.
 * A bare SHA-256 of the secret is not this value: that digest would let anyone with the
 * database test candidate keys offline.
 */
export function hashModelAlertKey(secret: string, serverSecret: string): string {
  return createHmac("sha256", pepper(serverSecret)).update(secret).digest("hex");
}

/**
 * Compares a presented secret to a stored HMAC in constant time.
 *
 * The lookup is by the HMAC, so a hit has already matched; this compare is the check that
 * the row we read is that HMAC, and the miss path compares against a stand-in of the same
 * length so a missing row does not return before the compare.
 */
export function modelAlertKeyMatches(secret: string, storedHex: string, serverSecret: string): boolean {
  const computed = Buffer.from(hashModelAlertKey(secret, serverSecret), "hex");
  const stored = /^[0-9a-f]{64}$/i.test(storedHex)
    ? Buffer.from(storedHex, "hex")
    : Buffer.alloc(computed.length);
  if (stored.length !== computed.length) {
    timingSafeEqual(computed, Buffer.alloc(computed.length));
    return false;
  }
  return timingSafeEqual(computed, stored);
}

/**
 * A new secret. `prefix` is what Settings shows later; it is not enough to authenticate.
 * `secret` is returned to the user once, from the generate route only.
 */
export function newModelAlertKey(serverSecret: string): {
  secret: string;
  prefix: string;
  secretHash: string;
} {
  const secret = `tsma_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  if (!isModelAlertKeyShape(secret)) {
    throw new Error("model alert key generator produced an unexpected shape");
  }
  return {
    secret,
    prefix: secret.slice(0, PREFIX_LENGTH),
    secretHash: hashModelAlertKey(secret, serverSecret),
  };
}

/** The advisory-lock key for issuing or revoking one user's keys, so the cap of three holds. */
export function modelAlertKeyLock(userId: string): string {
  return `model-alert-key:${userId}`;
}
