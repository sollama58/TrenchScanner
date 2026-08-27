import { describe, expect, it } from "vitest";
import { sessionCookieAttrs } from "./auth.js";

/**
 * The three states this has to get right, in order: local dev today, production today, and
 * production the moment api.holdex.live starts resolving. The point of deriving the attribute
 * from the request host is that the third needs no code change and no redeploy - so it is worth
 * pinning all three down.
 */
describe("sessionCookieAttrs", () => {
  it("uses Lax in local dev, where both halves are on localhost", () => {
    // Ports differ (4000 vs 5173) but a browser considers those the same site, and dev is plain
    // HTTP where SameSite=None would be rejected outright for lacking Secure.
    const attrs = sessionCookieAttrs("localhost:4000", "localhost:5173", "http");
    expect(attrs.sameSite).toBe("lax");
    expect(attrs.secure).toBe(false);
  });

  it("never emits None without Secure, the combination browsers silently discard", () => {
    // The two have to be decided from the same fact. Over https, cross-site gets both.
    const attrs = sessionCookieAttrs("trenchscanner-api.onrender.com", "holdex.live", "https");
    expect(attrs.sameSite).toBe("none");
    expect(attrs.secure).toBe(true);
  });

  it("uses None while the API is still on its own onrender.com host", () => {
    // Different registrable domains, so nothing but None survives the dashboard's fetch calls -
    // with the known cost that Safari and Brave drop it as a third-party cookie.
    expect(sessionCookieAttrs("trenchscanner-api.onrender.com", "holdex.live").sameSite).toBe("none");
  });

  it("switches to Lax as soon as the API answers on api.holdex.live", () => {
    // The whole point: this flips on DNS alone. No redeploy, no flag day, and both hosts behave
    // correctly at the same time while the cutover happens.
    expect(sessionCookieAttrs("api.holdex.live", "holdex.live").sameSite).toBe("lax");
  });

  it("treats the apex itself as same-site", () => {
    expect(sessionCookieAttrs("holdex.live", "holdex.live").sameSite).toBe("lax");
  });

  it("is not fooled by a domain that merely ends with the same text", () => {
    // "notholdex.live" ends with "holdex.live" as a string but is a different site entirely.
    expect(sessionCookieAttrs("api.notholdex.live", "holdex.live").sameSite).toBe("none");
  });

  it("ignores case and stray whitespace in either value", () => {
    expect(sessionCookieAttrs("API.HolDEX.live", " holdex.live ").sameSite).toBe("lax");
  });

  it("falls back to the cross-site setting when the host is missing", () => {
    // None still works cross-site; guessing Lax would silently drop the cookie instead.
    expect(sessionCookieAttrs("", "holdex.live").sameSite).toBe("none");
  });

  it("always sets path so set and clear agree", () => {
    expect(sessionCookieAttrs("api.holdex.live", "holdex.live").path).toBe("/");
  });
});
