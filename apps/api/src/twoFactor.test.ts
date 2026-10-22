// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it } from "vitest";
import type { Env } from "@trenchscanner/core";
import {
  asksFor,
  base32,
  failTwoFactorForTests,
  matchTotp,
  MAX_TRACKED_FAILURES,
  openSecret,
  otpauthUrl,
  resetTwoFactorFailuresForTests,
  sealSecret,
  totpCode,
  twoFactorLockedOutForTests,
} from "./twoFactor.js";

const env = { JWT_SECRET: "a".repeat(64) } as Env;
// RFC 6238's SHA-1 test secret.
const RFC_SECRET = Buffer.from("12345678901234567890");

describe("TOTP", () => {
  it("matches RFC 6238's SHA-1 vectors (last 6 digits)", () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe("081804");
    expect(totpCode(RFC_SECRET, Math.floor(1234567890 / 30))).toBe("005924");
    expect(totpCode(RFC_SECRET, Math.floor(2000000000 / 30))).toBe("279037");
  });

  it("allows one step of drift either way, and no more", () => {
    const now = 1234567890 * 1000;
    const step = Math.floor(1234567890 / 30);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now)).toBe(step);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now)).toBeNull();
    expect(matchTotp(RFC_SECRET, "12345", now)).toBeNull();
    expect(matchTotp(RFC_SECRET, "abcdef", now)).toBeNull();
  });

  it("writes base32 the way authenticator apps read it", () => {
    expect(base32(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("names the app, never a wallet, in the authenticator entry", () => {
    const url = otpauthUrl("ABC", "account");
    expect(url).toMatch(/^otpauth:\/\/totp\/TrenchScanner%3Aaccount\?/);
    expect(url).toContain("issuer=TrenchScanner");
  });
});

describe("sealed secrets", () => {
  it("open only for the user they were sealed to, with the same JWT_SECRET", () => {
    const secret = Buffer.from("0123456789abcdefghij");
    const sealed = sealSecret(env, "user-1", secret);
    expect(sealed).not.toContain(secret.toString("base64url"));
    expect(openSecret(env, "user-1", sealed).equals(secret)).toBe(true);
    expect(() => openSecret(env, "user-2", sealed)).toThrow();
    expect(() => openSecret({ JWT_SECRET: "b".repeat(64) } as Env, "user-1", sealed)).toThrow();
  });
});

describe("asksFor", () => {
  const on = { enabled: true, actions: ["signin", "pair"], buyOverLamports: null };

  it("asks nothing while two-factor is off", () => {
    for (const a of ["signin", "buy", "export", "manage"] as const)
      expect(asksFor({ ...on, enabled: false }, a)).toBe(false);
  });

  it("always asks for export and for changing two-factor once it's on", () => {
    expect(asksFor({ ...on, actions: [] }, "export")).toBe(true);
    expect(asksFor({ ...on, actions: [] }, "manage")).toBe(true);
  });

  it("asks for the actions the user picked, and only those", () => {
    expect(asksFor(on, "signin")).toBe(true);
    expect(asksFor(on, "pair")).toBe(true);
    expect(asksFor(on, "sell")).toBe(false);
    expect(asksFor(on, "buy", { lamports: 10n ** 12n })).toBe(false);
  });

  it("asks for buys at or over the size the user set", () => {
    const over = { ...on, actions: ["buyOver"], buyOverLamports: 1_000_000_000n };
    expect(asksFor(over, "buy", { lamports: 999_999_999n })).toBe(false);
    expect(asksFor(over, "buy", { lamports: 1_000_000_000n })).toBe(true);
    expect(asksFor({ ...on, actions: ["buy"] }, "buy", { lamports: 1n })).toBe(true);
  });
});

describe("wrong-try memory", () => {
  it("drops only the oldest user past the cap, not every count in progress", () => {
    resetTwoFactorFailuresForTests();
    for (let i = 0; i < 5; i += 1) failTwoFactorForTests("locked");
    expect(twoFactorLockedOutForTests("locked")).toBe(true);
    failTwoFactorForTests("oldest");
    // "locked" is first in the map; one more user past the cap drops it and nobody else.
    for (let i = 0; i < MAX_TRACKED_FAILURES - 1; i += 1) failTwoFactorForTests(`u${i}`);
    expect(twoFactorLockedOutForTests("locked")).toBe(false);
    for (let i = 0; i < 4; i += 1) failTwoFactorForTests("oldest");
    expect(twoFactorLockedOutForTests("oldest")).toBe(true);
    resetTwoFactorFailuresForTests();
  });
});
