import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { runCleanupJob } from "./cleanupJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/**
 * The Mobile Connect sweeps. These are the only part of the cleanup job that deletes rows a live
 * request might still be about to read, so the interesting assertions are the ones about what
 * SURVIVES: a code somebody is mid-scan of, and a device somebody is still using.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: Mobile Connect debris", () => {
  const WALLET = "CleanupJobTestWallet1111111111111111111111";
  let userId: string;

  // Only these two sweeps are under test; the job's other passes read env thresholds.
  const env = {
    SNAPSHOT_RETENTION_DAYS: 3650,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
  } as never;

  beforeEach(async () => {
    const user = await prisma.user.upsert({
      where: { walletAddress: WALLET },
      update: {},
      create: { walletAddress: WALLET },
    });
    userId = user.id;
    await prisma.mobileLinkCode.deleteMany({ where: { userId } });
    await prisma.linkedDevice.deleteMany({ where: { userId } });
  });

  afterAll(async () => {
    await prisma.mobileLinkCode.deleteMany({ where: { user: { walletAddress: WALLET } } });
    await prisma.linkedDevice.deleteMany({ where: { user: { walletAddress: WALLET } } });
    await prisma.user.deleteMany({ where: { walletAddress: WALLET } });
  });

  const hour = 3_600_000;
  const day = 86_400_000;

  it("collects the codes nobody can use any more, and leaves the ones in flight", async () => {
    await prisma.mobileLinkCode.createMany({
      data: [
        // Long expired: a QR rendered yesterday and never scanned.
        { codeHash: "a".repeat(64), userId, expiresAt: new Date(Date.now() - 2 * day) },
        // Expired, but only just - inside the hour of slack, so still swept up next time round.
        { codeHash: "b".repeat(64), userId, expiresAt: new Date(Date.now() - 60_000) },
        // Live: somebody is looking at this QR right now.
        { codeHash: "c".repeat(64), userId, expiresAt: new Date(Date.now() + 90_000) },
      ],
    });

    await runCleanupJob(env);

    const left = await prisma.mobileLinkCode.findMany({ where: { userId }, select: { codeHash: true } });
    const hashes = left.map((r) => r.codeHash).sort();
    expect(hashes).toEqual(["b".repeat(64), "c".repeat(64)].sort());
  });

  it("keeps a claimed code until its window closes, so a double-scan still gets a straight no", async () => {
    // The single-use guarantee is enforced by claimedAt, and deleting the row would turn a
    // second scan from "already used" into "never existed" - the same answer, but reached by
    // forgetting rather than by refusing. Only age removes it.
    await prisma.mobileLinkCode.create({
      data: {
        codeHash: "d".repeat(64),
        userId,
        expiresAt: new Date(Date.now() + 90_000),
        claimedAt: new Date(),
      },
    });

    await runCleanupJob(env);

    expect(await prisma.mobileLinkCode.count({ where: { userId } })).toBe(1);
  });

  it("forgets long-revoked devices but never a live one", async () => {
    const live = await prisma.linkedDevice.create({ data: { userId } });
    const justRevoked = await prisma.linkedDevice.create({
      data: { userId, revokedAt: new Date(Date.now() - hour) },
    });
    const longRevoked = await prisma.linkedDevice.create({
      data: { userId, revokedAt: new Date(Date.now() - 31 * day) },
    });

    await runCleanupJob(env);

    const left = (await prisma.linkedDevice.findMany({ where: { userId }, select: { id: true } })).map(
      (d) => d.id,
    );
    expect(left).toContain(live.id);
    // Recently revoked rows are kept on purpose: "which phone did I just disconnect" is a
    // question people ask minutes later, usually because something stopped working.
    expect(left).toContain(justRevoked.id);
    expect(left).not.toContain(longRevoked.id);
  });
});
