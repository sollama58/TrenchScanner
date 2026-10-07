import { post, type User } from "./api";
import { adoptSession } from "./sessionCheck";

/**
 * Signing a phone in from a signed-in desktop by scanning a QR (the API half is
 * apps/api/src/routes/deviceLink.ts, the same design as HolDEX's Mobile Connect).
 *
 * The desktop asks the API for a single-use code that lives two minutes and shows it as a QR of
 * `<this site>/#link=<code>`. The phone's camera opens that link, this page redeems the code once
 * and gets a session of its own, tied to a device row the desktop can switch off. No long-lived
 * credential is ever in the QR: the code is worthless once used or two minutes old.
 *
 * The code rides in the URL fragment, never the query string: a fragment is never sent to a
 * server, so it stays out of access logs, Referer headers and analytics. The page takes it out of
 * the address bar the moment it has read it (takeLinkCode), so a screenshot or the browser
 * history of the phone holds nothing.
 */

const HASH_PREFIX = "link=";
const CODE_RE = /^[a-f0-9]{64}$/;

/** What the API answers from POST /auth/link/code. */
export interface IssuedLinkCode {
  code: string;
  expiresAt: string;
  ttlMs: number;
}

export interface LinkedDevice {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
  userAgent: string | null;
}

export interface DeviceList {
  devices: LinkedDevice[];
  currentDeviceId: string | null;
}

/** The link the QR carries. */
export function buildLinkUrl(origin: string, code: string): string {
  return `${origin}/#${HASH_PREFIX}${code}`;
}

/**
 * Whether a hash is a pairing link (well-formed or not). index.html checks the same prefix to skip
 * its boot requests, which would only come back 401 on a phone that isn't signed in yet.
 */
export function isLinkHash(hash: string): boolean {
  return hash.replace(/^#/, "").startsWith(HASH_PREFIX);
}

/** The code in a pairing link, or null if the hash isn't one or the code is malformed. */
export function parseLinkHash(hash: string): string | null {
  if (!isLinkHash(hash)) return null;
  const code = hash.replace(/^#/, "").slice(HASH_PREFIX.length).toLowerCase();
  return CODE_RE.test(code) ? code : null;
}

/**
 * Read once, at load, before anything else can look at the hash (the tab router would read it as
 * "live" anyway). `undefined` = this page wasn't opened from a pairing link; `null` = it was, but
 * the code in it is malformed (a half-copied link), which the page reports like an expired one.
 */
let pending: string | null | undefined = undefined;
if (typeof window !== "undefined" && isLinkHash(window.location.hash)) {
  pending = parseLinkHash(window.location.hash);
  try {
    // Out of the address bar and out of history: replaceState, not a new entry.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {
    window.location.hash = "";
  }
}

/** The pairing code this page was opened with, handed out exactly once. */
export function takeLinkCode(): string | null | undefined {
  const code = pending;
  pending = undefined;
  return code;
}

/** Whether this page load came from a pairing link that hasn't been taken yet. */
export function hasPendingLink(): boolean {
  return pending !== undefined;
}

/** Phone side: trade the code for a session, and make sure that session sticks. */
export async function redeemLinkCode(code: string): Promise<User> {
  const res = await post<{ walletAddress: string; deviceId: string; sessionToken?: string }>(
    "/auth/link/redeem",
    { code },
  );
  return adoptSession(res.sessionToken, "Your phone was paired");
}

/**
 * A user-agent turned into something a person can recognise in a list ("iPhone · Safari").
 * Best-effort on purpose; an unfamiliar string says so rather than guessing. Rendered as text
 * only: the phone chose this string.
 */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const ua = userAgent;
  const os = /iPhone/i.test(ua)
    ? "iPhone"
    : /iPad/i.test(ua)
      ? "iPad"
      : /Android/i.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/i.test(ua)
          ? "Mac"
          : /Windows/i.test(ua)
            ? "Windows"
            : /Linux/i.test(ua)
              ? "Linux"
              : null;
  // Order matters: Edge, Opera and Chrome all also claim "Safari".
  const browser = /Edg(A|iOS)?\//i.test(ua)
    ? "Edge"
    : /OPR\//i.test(ua)
      ? "Opera"
      : /Firefox\/|FxiOS\//i.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//i.test(ua)
          ? "Chrome"
          : /Safari\//i.test(ua)
            ? "Safari"
            : null;
  if (os && browser) return `${os} · ${browser}`;
  return os ?? browser ?? "Unknown device";
}
