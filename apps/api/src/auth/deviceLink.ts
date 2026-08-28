import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@trenchscanner/core";

/**
 * Pairing a phone with a signed-in desktop, and keeping the resulting session revocable.
 *
 * The shape of the thing: the desktop mints a single-use code and renders it as a QR; the phone
 * redeems it once, within a short window, and gets a session of its own. What makes that safe is
 * that the code is useless the moment it is used or the window closes, and that the session it
 * produces is attached to a device row somebody can switch off.
 */

/**
 * How long a QR stays good for. A code on a screen is visible to everyone in the room and to
 * anything pointed at it, so the honest lifetime is "long enough to lift a phone and scan".
 * Single-use alone would not do: an unscanned code left on a screen would stay live indefinitely.
 */
export const LINK_CODE_TTL_MS = 2 * 60_000;

/** 32 bytes of entropy, hex-encoded. Guessing is not a threat model at this size. */
function generateCode(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Codes are stored hashed, never raw - the same reasoning as a password. The raw value lives in
 * the desktop's response and in the QR's pixels; a dump of this table gives an attacker nothing
 * replayable. SHA-256 without a salt is right here and would not be for a password: the input is
 * 32 random bytes, so there is no dictionary to precompute.
 */
export function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export interface IssuedLinkCode {
  code: string;
  expiresAt: Date;
}

/** Mints a code for an already-authenticated desktop session. */
export async function issueLinkCode(userId: string): Promise<IssuedLinkCode> {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);
  await prisma.mobileLinkCode.create({ data: { codeHash: hashCode(code), userId, expiresAt } });
  return { code, expiresAt };
}

export type RedeemResult =
  { ok: true; userId: string; walletAddress: string; deviceId: string } | { ok: false };

/**
 * Redeems a code and creates the device it pairs, or refuses.
 *
 * The claim is a CONDITIONAL update rather than a read-then-write: `updateMany` with
 * `claimedAt: null` in the where clause is settled inside the database, so two phones scanning
 * the same screen at the same moment cannot both come away with a session. A read followed by a
 * write would let both pass the check before either wrote - the classic way single-use codes turn
 * out to be double-use under exactly the conditions that matter.
 *
 * Every failure returns the same bare `{ ok: false }`: whether a code was wrong, already used or
 * expired is not something a caller needs to know, and saying so distinguishes "never existed"
 * from "existed and was spent".
 */
export async function redeemLinkCode(code: string, userAgent?: string): Promise<RedeemResult> {
  if (!/^[a-f0-9]{64}$/.test(code)) return { ok: false };

  const claimed = await prisma.mobileLinkCode.updateMany({
    where: { codeHash: hashCode(code), claimedAt: null, expiresAt: { gt: new Date() } },
    data: { claimedAt: new Date() },
  });
  if (claimed.count !== 1) return { ok: false };

  const row = await prisma.mobileLinkCode.findUnique({
    where: { codeHash: hashCode(code) },
    include: { user: { select: { id: true, walletAddress: true } } },
  });
  if (!row) return { ok: false };

  const device = await prisma.linkedDevice.create({
    data: { userId: row.userId, userAgent: userAgent?.slice(0, 300) ?? null },
  });
  return { ok: true, userId: row.user.id, walletAddress: row.user.walletAddress, deviceId: device.id };
}

/**
 * Whether a device session is still allowed, called on every request that carries one.
 * A revoked or deleted device fails closed - that IS the revocation.
 */
export async function deviceIsActive(deviceId: string): Promise<boolean> {
  const device = await prisma.linkedDevice.findUnique({
    where: { id: deviceId },
    select: { revokedAt: true },
  });
  return device !== null && device.revokedAt === null;
}

/**
 * "Last seen" for the device list, written at most once every few minutes per device rather than
 * on every request - the column exists so someone can recognise which phone is which, and that
 * does not need second precision at the cost of a write per API call.
 */
const TOUCH_INTERVAL_MS = 5 * 60_000;
const lastTouched = new Map<string, number>();

/**
 * The map would otherwise hold one entry per device seen since the process started, and a
 * long-lived API process eventually sees every device there is - a slow leak rather than a fast
 * one, but a leak.
 *
 * An entry older than the throttle window is already dead weight: the next touch writes whatever
 * it says. So sweeping on that basis keeps the map to roughly the devices active in the last few
 * minutes, which is the working set it is meant to represent. The hard cap below it is a
 * backstop for the case where they really are all active at once.
 */
const MAX_TOUCH_ENTRIES = 10_000;

let lastSweep = 0;

function sweepTouches(now: number): void {
  lastSweep = now;
  for (const [id, at] of lastTouched) {
    if (now - at >= TOUCH_INTERVAL_MS) lastTouched.delete(id);
  }
  if (lastTouched.size <= MAX_TOUCH_ENTRIES) return;
  // Everything left is inside its window, so age cannot separate them. Map iteration is in
  // insertion order, so this drops the longest-standing first. Losing a live entry costs one
  // redundant UPDATE and nothing else, which is why it is the safe thing to spend here.
  let excess = lastTouched.size - MAX_TOUCH_ENTRIES;
  for (const id of lastTouched.keys()) {
    lastTouched.delete(id);
    if (--excess <= 0) break;
  }
}

export function touchDevice(deviceId: string): void {
  const now = Date.now();
  // Before the throttle check, not after: a sweep may drop this device's own stale entry, and
  // when it does the write below is exactly what should happen next.
  if (now - lastSweep >= TOUCH_INTERVAL_MS || lastTouched.size >= MAX_TOUCH_ENTRIES) {
    sweepTouches(now);
  }
  if (now - (lastTouched.get(deviceId) ?? 0) < TOUCH_INTERVAL_MS) return;
  lastTouched.set(deviceId, now);
  void prisma.linkedDevice
    .updateMany({ where: { id: deviceId, revokedAt: null }, data: { lastSeenAt: new Date(now) } })
    .catch(() => {
      // Bookkeeping only - a failed timestamp must never cost someone their request.
    });
}

/** Test hook: forget the throttle so a test can observe consecutive touches. */
export function resetDeviceTouchThrottle(): void {
  lastTouched.clear();
  lastSweep = 0;
}

/** Test hook: how many devices the throttle is currently remembering. */
export function touchThrottleSize(): number {
  return lastTouched.size;
}
