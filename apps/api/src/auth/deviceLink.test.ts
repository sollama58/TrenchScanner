import "../bootstrap-env.js";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@trenchscanner/core";
import {
  issueLinkCode,
  redeemLinkCode,
  deviceIsActive,
  hashCode,
  LINK_CODE_TTL_MS,
  resetDeviceTouchThrottle,
  touchDevice,
  touchThrottleSize,
} from "./deviceLink.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `devicelink-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("mobile link codes", () => {
  let userId = "";

  beforeEach(async () => {
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-${Math.random()}` } });
    userId = user.id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("pairs a phone and hands back the desktop's own account", async () => {
    const { code } = await issueLinkCode(userId);
    const result = await redeemLinkCode(code, "iPhone Safari");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(userId);
    expect(await deviceIsActive(result.deviceId)).toBe(true);
  });

  it("never stores the code itself", async () => {
    // The raw value exists in the QR and the desktop's response; a dump of this table must not be
    // replayable into anyone's account.
    const { code } = await issueLinkCode(userId);
    const rows = await prisma.mobileLinkCode.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).not.toBe(code);
    expect(rows[0]!.codeHash).toBe(hashCode(code));
  });

  it("is single-use: the second redemption of the same code fails", async () => {
    const { code } = await issueLinkCode(userId);
    expect((await redeemLinkCode(code)).ok).toBe(true);
    expect((await redeemLinkCode(code)).ok).toBe(false);
    expect(await prisma.linkedDevice.count({ where: { userId } })).toBe(1);
  });

  it("cannot be claimed twice by two phones racing the same screen", async () => {
    // The claim is a conditional update precisely so this cannot happen. A read-then-write would
    // let both callers pass the check before either wrote - and a single-use code that is
    // occasionally double-use under concurrency is not single-use.
    const { code } = await issueLinkCode(userId);
    const results = await Promise.all([
      redeemLinkCode(code),
      redeemLinkCode(code),
      redeemLinkCode(code),
      redeemLinkCode(code),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.linkedDevice.count({ where: { userId } })).toBe(1);
  });

  it("expires, so a QR left on a screen stops being a key", async () => {
    const { code } = await issueLinkCode(userId);
    await prisma.mobileLinkCode.updateMany({
      where: { userId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await redeemLinkCode(code)).ok).toBe(false);
  });

  it("has a window measured in minutes, not hours", () => {
    expect(LINK_CODE_TTL_MS).toBeLessThanOrEqual(5 * 60_000);
  });

  it("rejects a malformed code without touching the database", async () => {
    expect((await redeemLinkCode("not-a-code")).ok).toBe(false);
    expect((await redeemLinkCode("")).ok).toBe(false);
    expect((await redeemLinkCode("A".repeat(64))).ok).toBe(false); // uppercase: not our alphabet
  });

  it("a revoked device stops being active immediately", async () => {
    const { code } = await issueLinkCode(userId);
    const result = await redeemLinkCode(code);
    if (!result.ok) throw new Error("expected the pairing to succeed");

    expect(await deviceIsActive(result.deviceId)).toBe(true);
    await prisma.linkedDevice.update({
      where: { id: result.deviceId },
      data: { revokedAt: new Date() },
    });
    // This is the whole revocation story: the JWT is still valid and still signed, and the
    // session is refused anyway because resolveSession asks this question on every request.
    expect(await deviceIsActive(result.deviceId)).toBe(false);
  });

  it("treats a device that no longer exists as inactive", async () => {
    expect(await deviceIsActive("clnonexistent0000000000000")).toBe(false);
  });

  it("one account's code cannot mint a device on another account", async () => {
    const other = await prisma.user.create({ data: { walletAddress: `${TAG}-other-${Math.random()}` } });
    const { code } = await issueLinkCode(userId);
    const result = await redeemLinkCode(code);
    if (!result.ok) throw new Error("expected the pairing to succeed");
    expect(result.userId).toBe(userId);
    expect(await prisma.linkedDevice.count({ where: { userId: other.id } })).toBe(0);
  });
});

/**
 * The "last seen" throttle is a plain Map on a process that runs for weeks, so the question worth
 * asking is not whether it throttles - it obviously does - but whether it ever gives anything
 * back. Without a sweep it holds one entry per device the API has ever served.
 *
 * No database needed: this is bookkeeping in front of a fire-and-forget write.
 */
describe("touchDevice throttle bookkeeping", () => {
  beforeEach(() => {
    resetDeviceTouchThrottle();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetDeviceTouchThrottle();
  });

  it("remembers a device it has just seen", () => {
    touchDevice("device-a");
    expect(touchThrottleSize()).toBe(1);
  });

  it("forgets devices that have gone quiet, rather than holding them for the life of the process", () => {
    touchDevice("device-a");
    touchDevice("device-b");
    expect(touchThrottleSize()).toBe(2);

    // Six minutes on: both entries are past the throttle window, so they say nothing the next
    // write would not say anyway. Any touch at all is enough to trigger the sweep.
    vi.advanceTimersByTime(6 * 60_000);
    touchDevice("device-c");

    expect(touchThrottleSize()).toBe(1);
  });

  it("keeps devices that are still inside their window", () => {
    touchDevice("device-a");
    // A minute is well inside the five-minute throttle, so nothing should be dropped and
    // device-a should still be throttled rather than written again.
    vi.advanceTimersByTime(60_000);
    touchDevice("device-b");

    expect(touchThrottleSize()).toBe(2);
  });

  it("lets a device through again once its window has passed", () => {
    touchDevice("device-a");
    vi.advanceTimersByTime(6 * 60_000);
    // The sweep drops the stale entry and the write goes ahead - the device is re-remembered
    // rather than lost, which is what keeps lastSeenAt moving for a long-lived phone.
    touchDevice("device-a");

    expect(touchThrottleSize()).toBe(1);
  });
});
