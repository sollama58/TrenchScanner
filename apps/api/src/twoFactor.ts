import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { appDomainForOrigin, prisma, type Env } from "@trenchscanner/core";

/**
 * Optional two-factor (user ask 2026-10-18): an authenticator app (TOTP codes), passkeys, or
 * both, with each user choosing which actions ask for it. It works the same for wallet and Privy
 * accounts. Passing the check for an action gives a short-lived pass (a signed token the
 * dashboard sends back as `x-ts-2fa`) for that action alone.
 *
 * What it can and can't stop: the api checks it before it builds a trade, pairs a phone or opens
 * a session for a new browser, so a stolen session or email can't do those. A burn and a Privy key
 * export happen between the user's wallet and the chain (or Privy) without us, so for those the
 * dashboard asks before starting them, and Privy's own two-factor guards the key itself.
 */

/** What a user can choose to protect. */
export const TWO_FACTOR_ACTIONS = ["signin", "buy", "buyOver", "sell", "burn", "pair", "export"] as const;
export type TwoFactorAction = (typeof TWO_FACTOR_ACTIONS)[number] | "manage";
/** Always asked once two-factor is on: exporting the wallet key, and changing two-factor itself. */
const ALWAYS: TwoFactorAction[] = ["export", "manage"];

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
/** A pass lasts this long: a run of quick trades doesn't ask each time. */
export const PASS_TTL_SECONDS = 5 * 60;
const CHALLENGE_TTL_SECONDS = 5 * 60;
const BACKUP_CODE_COUNT = 10;
/** Wrong codes allowed in the window before the account's checks pause. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60_000;

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────

function derived(env: Env, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", env.JWT_SECRET, "trenchscanner-2fa", purpose, 32));
}

/** The authenticator secret, sealed to its user: a copy of the database alone doesn't open it. */
export function sealSecret(env: Env, userId: string, secret: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derived(env, "totp-secret"), iv);
  cipher.setAAD(Buffer.from(userId));
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
}

export function openSecret(env: Env, userId: string, sealed: string): Buffer {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", derived(env, "totp-secret"), iv!);
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(body!), decipher.final()]);
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 seconds: what every authenticator app reads) ─────────

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return bin.toString().padStart(TOTP_DIGITS, "0");
}

/** The step a code matches, allowing one step of clock drift either way; null if none does. */
export function matchTotp(secret: Buffer, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const step = Math.floor(now / 1000 / TOTP_STEP_SECONDS);
  for (const s of [step, step - 1, step + 1]) {
    if (timingSafeEqual(Buffer.from(totpCode(secret, s)), Buffer.from(code))) return s;
  }
  return null;
}

export function otpauthUrl(secret: string, label: string): string {
  const params = new URLSearchParams({ secret, issuer: "TrenchScanner", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(`TrenchScanner:${label}`)}?${params.toString()}`;
}

// ── Backup codes ─────────────────────────────────────────────────────────────────────────────

function hashBackupCode(env: Env, code: string): string {
  return createHmac("sha256", derived(env, "backup-codes"))
    .update(code.replace(/[^A-Z2-7]/gi, "").toUpperCase())
    .digest("hex");
}

/** A fresh set of backup codes, replacing any left. Returns the codes, shown to the user once. */
export async function newBackupCodes(env: Env, userId: string): Promise<string[]> {
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const raw = base32(randomBytes(5)); // 8 characters
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
  });
  await prisma.$transaction([
    prisma.twoFactorBackupCode.deleteMany({ where: { userId } }),
    prisma.twoFactorBackupCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: hashBackupCode(env, c) })),
    }),
  ]);
  return codes;
}

// ── State ────────────────────────────────────────────────────────────────────────────────────

export interface TwoFactorState {
  enabled: boolean;
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }[];
  actions: string[];
  buyOverLamports: bigint | null;
  backupCodesLeft: number;
  /**
   * Changes with every sign-out (sessionVersion), every factor added, replaced or removed, and
   * every new set of backup codes: passes and the known-device cookie carry it and die with it
   * (user asks 2026-10-18 and 2026-10-20).
   */
  epoch: string;
}

/**
 * The account's two-factor epoch (TwoFactorState.epoch) from its parts. `backupSet` names the
 * current set of backup codes (any one id of it: a new set replaces every row), so using a code
 * leaves it alone and making new ones moves it.
 */
export function twoFactorEpoch(
  sessionVersion: number,
  totpSecret: string | null,
  passkeyIds: string[],
  backupSet: string | null = null,
) {
  return createHash("sha256")
    .update(`${sessionVersion}|${totpSecret ?? ""}|${[...passkeyIds].sort().join(",")}|${backupSet ?? ""}`)
    .digest("base64url")
    .slice(0, 16);
}

export async function twoFactorState(userId: string): Promise<TwoFactorState> {
  const [settings, passkeys, backupCodesLeft, backupSet, user] = await Promise.all([
    prisma.twoFactorSettings.findUnique({ where: { userId } }),
    prisma.twoFactorPasskey.findMany({
      where: { userId },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.twoFactorBackupCode.count({ where: { userId, usedAt: null } }),
    prisma.twoFactorBackupCode.findFirst({ where: { userId }, select: { id: true }, orderBy: { id: "asc" } }),
    prisma.user.findUnique({ where: { id: userId }, select: { sessionVersion: true } }),
  ]);
  const totp = Boolean(settings?.totpSecret);
  return {
    enabled: totp || passkeys.length > 0,
    totp,
    passkeys,
    actions: settings?.actions ?? ["signin", "pair", "export"],
    buyOverLamports: settings?.buyOverLamports ?? null,
    backupCodesLeft,
    epoch: twoFactorEpoch(
      user?.sessionVersion ?? 0,
      settings?.totpSecret ?? null,
      passkeys.map((p) => p.id),
      backupSet?.id ?? null,
    ),
  };
}

/** Whether this action asks for two-factor, for a user in this state. */
export function asksFor(
  state: Pick<TwoFactorState, "enabled" | "actions" | "buyOverLamports">,
  action: TwoFactorAction,
  opts: { lamports?: bigint } = {},
): boolean {
  if (!state.enabled) return false;
  if (ALWAYS.includes(action)) return true;
  if (action === "buy") {
    if (state.actions.includes("buy")) return true;
    return (
      state.actions.includes("buyOver") &&
      state.buyOverLamports !== null &&
      opts.lamports !== undefined &&
      opts.lamports >= state.buyOverLamports
    );
  }
  return state.actions.includes(action);
}

// ── Signed tokens: passes, sign-in tickets, passkey challenges ───────────────────────────────

async function sign(env: Env, claims: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setJti(randomBytes(12).toString("base64url"))
    .sign(derived(env, "tokens"));
}

async function read(env: Env, token: string, kind: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, derived(env, "tokens"), { algorithms: ["HS256"] });
    return payload.kind === kind ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Marks a single-use token (a passkey challenge or a sign-in ticket) used. True only for the first
 * use: the row's primary key makes a second insert fail, on any instance and across restarts.
 */
async function spend(jti: unknown): Promise<boolean> {
  if (typeof jti !== "string" || jti.length > 64) return false;
  const now = new Date();
  await prisma.twoFactorSpentToken.deleteMany({ where: { expiresAt: { lt: now } } }).catch(() => undefined);
  try {
    await prisma.twoFactorSpentToken.create({
      data: { jti, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000 + 60_000) },
    });
    return true;
  } catch {
    return false;
  }
}

export function issuePass(env: Env, userId: string, action: TwoFactorAction, epoch: string): Promise<string> {
  return sign(env, { kind: "pass", sub: userId, act: action, ep: epoch }, PASS_TTL_SECONDS);
}

/** Whether the request carries a pass for this action, from the account's current epoch. */
export async function hasPass(
  env: Env,
  request: FastifyRequest,
  userId: string,
  action: TwoFactorAction,
  epoch?: string,
) {
  const header = request.headers["x-ts-2fa"];
  if (typeof header !== "string" || header.length > 2048) return false;
  const claims = await read(env, header, "pass");
  if (claims?.sub !== userId || claims.act !== action) return false;
  return claims.ep === (epoch ?? (await twoFactorState(userId)).epoch);
}

/** A sign-in that passed its first step and now needs the second (see /auth/2fa/signin). */
export function issueSignInTicket(env: Env, userId: string, sessionVersion: number): Promise<string> {
  return sign(env, { kind: "ticket", sub: userId, sv: sessionVersion }, CHALLENGE_TTL_SECONDS);
}

export async function readSignInTicket(env: Env, ticket: string) {
  const claims = await read(env, ticket, "ticket");
  return claims && typeof claims.sub === "string" && typeof claims.sv === "number"
    ? { userId: claims.sub, jti: claims.jti, sessionVersion: claims.sv }
    : null;
}

export function spendTicket(jti: unknown): Promise<boolean> {
  return spend(jti);
}

/**
 * Asks for two-factor when this user's choices say so. True when the request may go on; when not,
 * it has answered 403 with `twoFactor: { action }`, which the dashboard reads as "ask, then retry".
 */
export async function requireTwoFactor(
  env: Env,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  action: TwoFactorAction,
  opts: { lamports?: bigint; extra?: Record<string, unknown> } = {},
): Promise<boolean> {
  const state = await twoFactorState(userId);
  if (!asksFor(state, action, opts)) return true;
  if (await hasPass(env, request, userId, action, state.epoch)) return true;
  void reply.code(403).send({
    error: "Two-factor check needed",
    twoFactor: { action, totp: state.totp, passkey: state.passkeys.length > 0 },
    ...opts.extra,
  });
  return false;
}

/**
 * The pass a device cookie carries: this browser passed a sign-in check for this user, since the
 * last sign-out and the last change to the account's factors or backup codes (its epoch).
 */
export const KNOWN_DEVICE_COOKIE = "ts_2fa_device";
const KNOWN_DEVICE_TTL_SECONDS = 180 * 24 * 60 * 60;

export function issueKnownDevice(env: Env, userId: string, epoch: string): Promise<string> {
  return sign(env, { kind: "device", sub: userId, ep: epoch }, KNOWN_DEVICE_TTL_SECONDS);
}

export async function isKnownDevice(
  env: Env,
  request: FastifyRequest,
  userId: string,
  epoch: string,
): Promise<boolean> {
  const cookie = request.cookies?.[KNOWN_DEVICE_COOKIE];
  if (!cookie) return false;
  const claims = await read(env, cookie, "device");
  return claims?.sub === userId && claims.ep === epoch;
}

export { KNOWN_DEVICE_TTL_SECONDS };

// ── Passkeys (WebAuthn) ──────────────────────────────────────────────────────────────────────

/** The relying party for the dashboard host the request came from: www and apex share passkeys. */
export function relyingParty(env: Env, origin: string | undefined): { rpID: string; origin: string } | null {
  if (!origin) return null;
  const host = appDomainForOrigin(env, origin);
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.host.toLowerCase() !== host) return null;
  return { rpID: url.hostname.replace(/^www\./, ""), origin: url.origin };
}

export async function passkeyRegistrationOptions(env: Env, userId: string, label: string, origin?: string) {
  const rp = relyingParty(env, origin);
  if (!rp) return null;
  const existing = await prisma.twoFactorPasskey.findMany({
    where: { userId },
    select: { credentialId: true },
  });
  const options = await generateRegistrationOptions({
    rpName: "TrenchScanner",
    rpID: rp.rpID,
    userName: label,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const token = await sign(env, { kind: "reg", sub: userId, ch: options.challenge }, CHALLENGE_TTL_SECONDS);
  return { options, token };
}

export async function finishPasskeyRegistration(
  env: Env,
  userId: string,
  token: string,
  response: RegistrationResponseJSON,
  name: string,
  origin?: string,
): Promise<boolean> {
  const rp = relyingParty(env, origin);
  const claims = await read(env, token, "reg");
  if (!rp || claims?.sub !== userId || !(await spend(claims.jti))) return false;
  let verified;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: String(claims.ch),
      expectedOrigin: rp.origin,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
  } catch {
    return false;
  }
  if (!verified.verified || !verified.registrationInfo) return false;
  const { credential } = verified.registrationInfo;
  try {
    await prisma.twoFactorPasskey.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
        name: name.trim().slice(0, 60) || "Passkey",
      },
    });
  } catch (err) {
    // The same passkey already added (here or on another account): refuse it, not a 500.
    if ((err as { code?: unknown } | null)?.code === "P2002") return false;
    throw err;
  }
  return true;
}

export async function passkeyAuthenticationOptions(env: Env, userId: string, origin?: string) {
  const rp = relyingParty(env, origin);
  if (!rp) return null;
  const passkeys = await prisma.twoFactorPasskey.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });
  if (passkeys.length === 0) return null;
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: passkeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports as AuthenticatorTransportFuture[],
    })),
    userVerification: "preferred",
  });
  const token = await sign(env, { kind: "auth", sub: userId, ch: options.challenge }, CHALLENGE_TTL_SECONDS);
  return { options, token };
}

// ── Checking a second factor ─────────────────────────────────────────────────────────────────

export interface SecondFactor {
  code?: string;
  backupCode?: string;
  passkey?: { token: string; response: AuthenticationResponseJSON };
}

/** A second factor as a request body carries it; the passkey's own fields are WebAuthn's to check. */
const webauthnJson = z
  .object({ id: z.string().min(1).max(1024), type: z.literal("public-key") })
  .passthrough()
  .refine((v) => JSON.stringify(v).length < 16_384, "too large");

export const factorFields = {
  code: z.string().max(12).optional(),
  backupCode: z.string().max(20).optional(),
  passkey: z
    .object({
      token: z.string().max(2048),
      response: webauthnJson.transform((v) => v as unknown as AuthenticationResponseJSON),
    })
    .optional(),
};

export const registrationJson = webauthnJson.transform((v) => v as unknown as RegistrationResponseJSON);

const failures = new Map<string, { count: number; since: number }>();

function lockedOut(userId: string): boolean {
  const f = failures.get(userId);
  if (!f) return false;
  if (Date.now() - f.since > FAILURE_WINDOW_MS) {
    failures.delete(userId);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

/** Users whose failed tries are remembered. Past it the oldest window is dropped, not all of them. */
export const MAX_TRACKED_FAILURES = 50_000;

function fail(userId: string): void {
  const f = failures.get(userId);
  if (f && Date.now() - f.since <= FAILURE_WINDOW_MS) {
    f.count++;
    return;
  }
  // A new window goes to the back, so the first entry is always the oldest. Clearing the whole
  // map here would have lifted every lockout in progress.
  failures.delete(userId);
  if (failures.size >= MAX_TRACKED_FAILURES) failures.delete(failures.keys().next().value!);
  failures.set(userId, { count: 1, since: Date.now() });
}

/** Takes back one try counted by fail() (a check that errored rather than answered). */
function unfail(userId: string): void {
  const f = failures.get(userId);
  if (!f) return;
  if (f.count <= 1) failures.delete(userId);
  else f.count--;
}

/** Tests: forget failed attempts. */
export function resetTwoFactorFailuresForTests(): void {
  failures.clear();
}

/** Tests: count a wrong try, and read the lockout, without a check. */
export { fail as failTwoFactorForTests, lockedOut as twoFactorLockedOutForTests };

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** Checks one second factor for the user: an app code, a backup code, or a passkey. */
export async function checkSecondFactor(
  env: Env,
  userId: string,
  factor: SecondFactor,
  origin?: string,
): Promise<CheckResult> {
  if (lockedOut(userId)) return { ok: false, reason: "Too many wrong tries. Wait 15 minutes and try again." };
  // Counted as a wrong try BEFORE the check, in the same tick as the lockout test above, and
  // taken back if it matches. Counting after the awaited check let a burst of guesses sent at
  // once all pass the lockout test before any of them was counted, so the five-tries cap held
  // only for guesses sent one at a time: a stolen session (or a sign-in ticket) could try
  // hundreds of codes per 15 minutes by sending them in parallel.
  fail(userId);
  let ok: boolean;
  try {
    ok = await check(env, userId, factor, origin);
  } catch (err) {
    // A database error is no wrong code: the try is taken back, and the error stands.
    unfail(userId);
    throw err;
  }
  if (ok) {
    failures.delete(userId);
    return { ok: true };
  }
  return { ok: false, reason: "That didn't match. Try again." };
}

async function check(env: Env, userId: string, factor: SecondFactor, origin?: string): Promise<boolean> {
  if (factor.code) {
    const settings = await prisma.twoFactorSettings.findUnique({ where: { userId } });
    if (!settings?.totpSecret) return false;
    const step = matchTotp(openSecret(env, userId, settings.totpSecret), factor.code.trim());
    if (step === null || (settings.lastTotpStep !== null && step <= settings.lastTotpStep)) return false;
    // A code works once: only the request that moves lastTotpStep past it wins.
    const moved = await prisma.twoFactorSettings.updateMany({
      where: { userId, OR: [{ lastTotpStep: null }, { lastTotpStep: { lt: step } }] },
      data: { lastTotpStep: step },
    });
    return moved.count === 1;
  }
  if (factor.backupCode) {
    const used = await prisma.twoFactorBackupCode.updateMany({
      where: { userId, usedAt: null, codeHash: hashBackupCode(env, factor.backupCode) },
      data: { usedAt: new Date() },
    });
    return used.count >= 1;
  }
  if (factor.passkey) {
    const rp = relyingParty(env, origin);
    const claims = await read(env, factor.passkey.token, "auth");
    if (!rp || claims?.sub !== userId || !(await spend(claims.jti))) return false;
    const passkey = await prisma.twoFactorPasskey.findUnique({
      where: { credentialId: factor.passkey.response.id },
    });
    if (!passkey || passkey.userId !== userId) return false;
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: factor.passkey.response,
        expectedChallenge: String(claims.ch),
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
        requireUserVerification: false,
      });
    } catch {
      return false;
    }
    if (!verified.verified) return false;
    await prisma.twoFactorPasskey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(verified.authenticationInfo.newCounter), lastUsedAt: new Date() },
    });
    return true;
  }
  return false;
}
