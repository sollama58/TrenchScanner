import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import type { AccessState } from "@trenchscanner/core";

/**
 * Keys for the browser extension overlay (Axiom, Terminal and GMGN).
 *
 * The same construction as Model Alert keys (modelAlertKey.ts): 32 random bytes behind a prefix,
 * shown once, stored as an HMAC peppered with the server secret. A different prefix and a
 * different pepper, so a key of one kind can never pass as the other. Who may hold one is
 * extensionKeyAccess: admins only until the extension is listed (user decision 2026-10-23, audit
 * CE-1). The feed carries the AI reviewer's verdict and reasoning, which the site shows admins only.
 *
 * What a key can do is the /ext/v1 routes and nothing else: read the owner's alerts, token stats
 * and overlay settings, and save the overlay settings. It is never a session.
 */

/** Active (not revoked) extension keys one user may hold: one per browser, a few browsers. */
export const MAX_EXTENSION_KEYS = 3;

const PREFIX_LENGTH = 11;
const SECRET_BYTES = 32;
const KEY_SHAPE = /^tsx_[A-Za-z0-9_-]{43}$/;

/** True only for a secret this server would issue. Anything else is refused before a lookup. */
export function isExtensionKeyShape(secret: string): boolean {
  return KEY_SHAPE.test(secret);
}

function pepper(serverSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", serverSecret, "trenchscanner-extension-key", "hmac", 32));
}

/** HMAC-SHA256 hex of the secret, keyed with the pepper. The secret itself is never stored. */
export function hashExtensionKey(secret: string, serverSecret: string): string {
  return createHmac("sha256", pepper(serverSecret)).update(secret).digest("hex");
}

/** Constant-time compare of a presented secret against a stored HMAC (see modelAlertKeyMatches). */
export function extensionKeyMatches(secret: string, storedHex: string, serverSecret: string): boolean {
  const computed = Buffer.from(hashExtensionKey(secret, serverSecret), "hex");
  const stored = /^[0-9a-f]{64}$/i.test(storedHex)
    ? Buffer.from(storedHex, "hex")
    : Buffer.alloc(computed.length);
  if (stored.length !== computed.length) {
    timingSafeEqual(computed, Buffer.alloc(computed.length));
    return false;
  }
  return timingSafeEqual(computed, stored);
}

/** A new secret. `prefix` is what Settings lists later; `secret` leaves the server once. */
export function newExtensionKey(serverSecret: string): {
  secret: string;
  prefix: string;
  secretHash: string;
} {
  const secret = `tsx_${randomBytes(SECRET_BYTES).toString("base64url")}`;
  if (!isExtensionKeyShape(secret)) throw new Error("extension key generator produced an unexpected shape");
  return {
    secret,
    prefix: secret.slice(0, PREFIX_LENGTH),
    secretHash: hashExtensionKey(secret, serverSecret),
  };
}

/**
 * Who may hold and use an extension key: admins, until the extension is listed (user decision
 * 2026-10-23). Checked when a key is made and on every request, so a key made before is cut off too.
 */
export function extensionKeyAccess(access: AccessState): boolean {
  return access.reason === "admin";
}

/** The 403 body for a wallet that may use the site but not the extension. */
export function extensionKeyDeniedMessage(_reason: AccessState["reason"]): string {
  return "The browser extension is open to admins only until it is listed.";
}

/** The advisory-lock key for issuing or revoking one user's extension keys, so the cap holds. */
export function extensionKeyLock(userId: string): string {
  return `extension-key:${userId}`;
}

/** The bearer secret on a request, if the header carries one at all. Never logged. */
export function extensionKeyFromHeader(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

/**
 * The rate-limit bucket for an /ext/v1 request: a digest of a well-formed key, else the address.
 * A digest and not the prefix, so the bucket can't be picked by sending someone else's prefix.
 * Made-up keys get buckets of their own but fail authentication, which is capped per address.
 */
export function extensionRateLimitBucket(header: string | string[] | undefined, address: string): string {
  const secret = extensionKeyFromHeader(header);
  if (secret && isExtensionKeyShape(secret)) {
    return `ext:${createHash("sha256").update(secret).digest("hex").slice(0, 32)}`;
  }
  return address;
}
