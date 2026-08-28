import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { issueLinkCode, redeemLinkCode, deviceIsActive, hashCode, LINK_CODE_TTL_MS } from "./deviceLink.js";

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
