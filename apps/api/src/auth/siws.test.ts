import { describe, expect, it } from "vitest";
import { buildSignInMessage } from "./siws.js";

describe("buildSignInMessage", () => {
  const wallet = "5BsFsz73yqe15X59thZnFEwPyE7NH3xP9ZvyZwNwf3Bz";
  const nonce = "39ffde1b9f79290e8e7ad56bc873aebf";
  const issuedAt = new Date("2026-01-01T00:00:00.000Z");

  it("includes the wallet address, nonce, and ISO timestamp", () => {
    const message = buildSignInMessage(wallet, nonce, issuedAt);
    expect(message).toContain(wallet);
    expect(message).toContain(`Nonce: ${nonce}`);
    expect(message).toContain("Issued At: 2026-01-01T00:00:00.000Z");
  });

  it("is deterministic for the same inputs", () => {
    // Critical property: verification reconstructs this exact string server-side and compares
    // the signature against it - any nondeterminism here (e.g. Date.now() instead of the passed
    // issuedAt) breaks every sign-in. See the bug this guards against in siws.ts's issueNonce().
    const a = buildSignInMessage(wallet, nonce, issuedAt);
    const b = buildSignInMessage(wallet, nonce, issuedAt);
    expect(a).toBe(b);
  });

  it("produces a different message for a different nonce", () => {
    const a = buildSignInMessage(wallet, nonce, issuedAt);
    const b = buildSignInMessage(wallet, "different-nonce", issuedAt);
    expect(a).not.toBe(b);
  });
});
