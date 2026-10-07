import { api, ApiError, type User } from "./api";
import { setSessionToken } from "./session";

/**
 * Makes sure a fresh session actually sticks before calling sign-in done. Shared by wallet
 * sign-in (wallet.ts) and phone pairing (deviceLink.ts), which both get a cookie and a token back.
 *
 * The API's cookie is third-party while it lives on another site, and some browsers (Edge with
 * strict tracking prevention or InPrivate, Safari, Brave, anything blocking third-party cookies)
 * drop it without an error. So ask who we are with the cookie alone; if that fails, keep the token
 * the API returned and send it as a header from now on (session.ts), and check again.
 *
 * `what` starts the error sentences ("Your wallet signed", "Your phone was paired").
 */
export async function adoptSession(sessionToken: string | undefined, what: string): Promise<User> {
  setSessionToken(null);
  try {
    return await api<User>("/auth/me");
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) throw e;
    // The credential was accepted (the API answered); only the session failed to stick. An API
    // without the token fallback leaves nothing to retry with, and saying "didn't verify" would
    // send the user back to start over for nothing.
    if (!sessionToken)
      throw new Error(
        `${what}, but this browser blocked the session cookie. Allow cookies for this site, ` +
          "or turn tracking prevention to Balanced, then try again.",
        { cause: e },
      );
  }
  setSessionToken(sessionToken);
  try {
    return await api<User>("/auth/me");
  } catch (e) {
    setSessionToken(null);
    throw new Error(
      `${what}, but this browser blocked the session (${e instanceof Error ? e.message : String(e)}). ` +
        "Allow cookies for this site, or turn tracking prevention to Balanced, then try again.",
      { cause: e },
    );
  }
}
