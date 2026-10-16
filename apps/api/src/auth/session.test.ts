import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { ADMIN_SESSION_MAX_AGE_MS, adminSessionFresh, createSessionSigner } from "./session.js";

const SECRET = "session-test-secret-0000000000000000000000";

describe("admin session age", () => {
  it("reads when a session was signed in", async () => {
    const signer = createSessionSigner(SECRET, 24 * 30);
    const before = Date.now();
    const session = await signer.verify(await signer.sign({ userId: "u1", walletAddress: "w1" }));
    expect(session?.issuedAtMs).toBeGreaterThanOrEqual(Math.floor(before / 1000) * 1000);
    expect(adminSessionFresh(session!)).toBe(true);
  });

  it("ends an admin session seven days after its sign-in, however long the token itself runs", async () => {
    expect(ADMIN_SESSION_MAX_AGE_MS).toBe(7 * 24 * 3_600_000);
    const eightDaysAgo = Math.floor((Date.now() - 8 * 24 * 3_600_000) / 1000);
    const token = await new SignJWT({ walletAddress: "w1", sv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuedAt(eightDaysAgo)
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(SECRET));
    const session = await createSessionSigner(SECRET, 24 * 30).verify(token);
    expect(session).not.toBeNull();
    expect(adminSessionFresh(session!)).toBe(false);
  });

  it("treats a session with no sign-in time as stale", () => {
    expect(adminSessionFresh({ userId: "u1", walletAddress: "w1" })).toBe(false);
  });
});
