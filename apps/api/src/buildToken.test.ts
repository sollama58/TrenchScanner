import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newBuildId, signBuildToken, verifyBuildToken, type BuildClaims } from "./buildToken.js";

const SECRET = "test-secret-test-secret-test-secret-0000";
const NOW = 1_800_000_000_000;

const claims = (over: Partial<BuildClaims> = {}): BuildClaims => ({
  id: newBuildId(),
  wallet: "ProModeAdmin1111111111111111111111111111111",
  message: Buffer.from("the built message bytes").toString("base64"),
  lastValidBlockHeight: 312_345_678,
  side: "buy",
  access: false,
  closing: false,
  mint: "So11111111111111111111111111111111111111112",
  lamports: 18_446_744_073_709_551_615n,
  networkFeeLamports: 125_000n,
  sacrifice: {
    mode: "on",
    tier: "holder",
    pays: true,
    asdfRaw: 123_456_789_012n,
    lamports: 200_000n,
    asdfPerSol: 1234.5,
  },
  expiresAt: NOW + 120_000,
  ...over,
});

describe("build tokens", () => {
  it("round-trips a build exactly, u64s and the Sacrifice included", () => {
    const c = claims();
    expect(verifyBuildToken(SECRET, signBuildToken(SECRET, c), NOW)).toEqual(c);
    const off = claims({
      sacrifice: { mode: "off", tier: null, pays: false, asdfRaw: null, lamports: null, asdfPerSol: null },
      side: "sell",
      closing: true,
      access: true,
    });
    expect(verifyBuildToken(SECRET, signBuildToken(SECRET, off), NOW)).toEqual(off);
  });

  it("refuses a token changed in any way, signed with another secret, or expired", () => {
    const token = signBuildToken(SECRET, claims());
    const [payload, mac] = token.split(".") as [string, string];
    // Another build's payload under this one's mac: a cheaper Sacrifice, say.
    const cheaper = signBuildToken(SECRET, claims({ sacrifice: { ...claims().sacrifice, asdfRaw: 1n } }));
    expect(verifyBuildToken(SECRET, `${cheaper.split(".")[0]}.${mac}`, NOW)).toBeNull();
    // One character of the payload or the mac.
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === "A" ? "B" : "A") + s.slice(i + 1);
    expect(verifyBuildToken(SECRET, `${flip(payload, 10)}.${mac}`, NOW)).toBeNull();
    expect(verifyBuildToken(SECRET, `${payload}.${flip(mac, 5)}`, NOW)).toBeNull();
    expect(verifyBuildToken(SECRET, `${payload}.`, NOW)).toBeNull();
    expect(verifyBuildToken(SECRET, `${payload}.${mac}.x`, NOW)).toBeNull();
    expect(verifyBuildToken(SECRET, "garbage", NOW)).toBeNull();
    // Another secret, and a plain HMAC under JWT_SECRET itself (the key is derived for this use).
    expect(verifyBuildToken(`${SECRET}x`, token, NOW)).toBeNull();
    const plain = createHmac("sha256", SECRET).update(payload).digest("base64url");
    expect(verifyBuildToken(SECRET, `${payload}.${plain}`, NOW)).toBeNull();
    // Good until it expires, and not after.
    expect(verifyBuildToken(SECRET, token, NOW + 119_999)).not.toBeNull();
    expect(verifyBuildToken(SECRET, token, NOW + 120_000)).toBeNull();
  });
});
