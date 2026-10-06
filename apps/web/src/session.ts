/**
 * The session token, kept here only for browsers that refuse the API's session cookie.
 *
 * While this page and the API sit on different sites, the cookie is third-party: Safari, Brave,
 * Edge with strict tracking prevention (and every InPrivate window), and any browser set to block
 * third-party cookies drop it silently, so sign-in looked like it worked and the next request was
 * signed out. Sign-in (wallet.ts) checks whether the cookie stuck and, only when it didn't, keeps
 * the token the API also returns and sends it as an Authorization header instead. Browsers where
 * the cookie works never store it.
 *
 * index.html reads the same key for its boot requests, so keep the two in step.
 */
const KEY = "ts-session-token";

let token: string | null = read();

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function sessionToken(): string | null {
  return token;
}

export function setSessionToken(value: string | null): void {
  token = value;
  try {
    if (value) localStorage.setItem(KEY, value);
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the token still works for this page load.
  }
}

/** Headers that carry the fallback token, when this browser needs it. */
export function authHeaders(headers: Headers): Headers {
  if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

/**
 * Whether this browser chose to look around as a guest (no wallet). Remembered so a returning
 * guest lands on the guest feed again instead of the sign-in page; connecting a wallet clears it.
 * index.html reads the same key to pick its boot requests, so keep the two in step.
 */
const GUEST_KEY = "ts-guest";

export function isGuest(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === "1";
  } catch {
    return false;
  }
}

export function setGuest(on: boolean): void {
  try {
    if (on) localStorage.setItem(GUEST_KEY, "1");
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    // Storage blocked: guest mode still works for this page load.
  }
}

/** How late guests see each call; the API's GUEST_DELAY_MINUTES (routes/guest.ts) sets the real delay. */
export const GUEST_DELAY_MINUTES = 5;
