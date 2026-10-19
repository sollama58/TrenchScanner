import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PlatformTradeRecord } from "@trenchscanner/core";

/**
 * A Pro trade's build, carried by the trader between /pro/trade/build and /pro/trade/send
 * (routes/proTrade.ts), so a send on any API instance can check it: a deploy moves traffic between
 * the two, and a build kept only in the old instance's memory was refused on the new one
 * (trading robustness audit 2026-10-19, #2).
 *
 * `<payload>.<mac>`, both base64url: the payload is the build as JSON, the mac an HMAC-SHA256 over
 * the payload with a key derived from JWT_SECRET for this use alone, so neither a session cookie
 * nor anything else signed with that secret can pass for a build, nor a build for them.
 */

const DOMAIN = "trenchscanner/pro-trade/build-token/v1";

export interface BuildClaims {
  /** The build's id: PlatformTrade.buildId is unique, so a build is sent once on any instance. */
  id: string;
  wallet: string;
  /** The built message bytes, base64: what the signed transaction must match (signedMatchesBuild). */
  message: string;
  lastValidBlockHeight: number;
  side: "buy" | "sell";
  /** An access-token buy by a wallet without Pro Mode: sends without Pro Mode too. */
  access: boolean;
  /** A sale of the whole balance: exempt from the trade limits. */
  closing: boolean;
  mint: string;
  lamports: bigint;
  networkFeeLamports: bigint;
  /** The Sacrifice worked out at build, as the send records (and takes) it. */
  sacrifice: PlatformTradeRecord["sacrifice"];
  /** Good for a send until then, ms since the epoch. */
  expiresAt: number;
}

const u64 = z.string().regex(/^\d{1,20}$/);
const claimsSchema = z.object({
  id: z.string().min(1).max(64),
  wallet: z.string().min(1).max(64),
  message: z.string().min(1).max(4_000),
  lastValidBlockHeight: z.number().int().nonnegative(),
  side: z.enum(["buy", "sell"]),
  access: z.boolean(),
  closing: z.boolean(),
  mint: z.string().min(1).max(64),
  lamports: u64,
  networkFeeLamports: u64,
  sacrifice: z.object({
    mode: z.enum(["off", "shadow", "on"]),
    tier: z.string().nullable(),
    pays: z.boolean(),
    asdfRaw: u64.nullable(),
    lamports: u64.nullable(),
    asdfPerSol: z.number().nullable(),
  }),
  expiresAt: z.number().int(),
});

/** A new build's id. */
export const newBuildId = () => randomBytes(16).toString("base64url");

const keyFor = (secret: string) => createHmac("sha256", secret).update(DOMAIN).digest();
const macOf = (key: Buffer, payload: string) => createHmac("sha256", key).update(payload).digest();

export function signBuildToken(secret: string, claims: BuildClaims): string {
  const big = (v: bigint | null) => (v === null ? null : v.toString());
  const payload = Buffer.from(
    JSON.stringify({
      ...claims,
      lamports: claims.lamports.toString(),
      networkFeeLamports: claims.networkFeeLamports.toString(),
      sacrifice: {
        ...claims.sacrifice,
        asdfRaw: big(claims.sacrifice.asdfRaw),
        lamports: big(claims.sacrifice.lamports),
      },
    }),
  ).toString("base64url");
  return `${payload}.${macOf(keyFor(secret), payload).toString("base64url")}`;
}

/** The build a token carries, when this secret signed it unchanged and it is still good; else null. */
export function verifyBuildToken(secret: string, token: string, now = Date.now()): BuildClaims | null {
  const [payload, mac, extra] = token.split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const expected = macOf(keyFor(secret), payload);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let parsed;
  try {
    parsed = claimsSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (!parsed.success || parsed.data.expiresAt <= now) return null;
  const c = parsed.data;
  const big = (v: string | null) => (v === null ? null : BigInt(v));
  return {
    ...c,
    lamports: BigInt(c.lamports),
    networkFeeLamports: BigInt(c.networkFeeLamports),
    sacrifice: {
      ...c.sacrifice,
      tier: c.sacrifice.tier as PlatformTradeRecord["sacrifice"]["tier"],
      asdfRaw: big(c.sacrifice.asdfRaw),
      lamports: big(c.sacrifice.lamports),
    },
  };
}
