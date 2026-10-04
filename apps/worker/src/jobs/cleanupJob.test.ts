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

/**
 * The stale-token sweep, and the one record it must never take with it.
 *
 * Token -> CuratedAlert is onDelete: Cascade, so anything that deletes a token deletes the
 * feed's public history for it too.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: stale tokens vs the curated record", () => {
  const TAG = "CleanupCuratedTest";

  // Everything else off; only the token sweep is under test.
  const env = {
    SNAPSHOT_RETENTION_DAYS: 3650,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 90,
  } as never;

  beforeEach(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("keeps a curated alert's token however old and unmatched it is", async () => {
    // A curated alert is emitted independently of user filters, so a curated token nobody's
    // filter also caught holds no Match. Its snapshots age out at 30 days and its outcome rows
    // at 180 - and on the first sweep after that the token itself qualified as stale, cascading
    // away the feed's public track record for it. The scoreboard's history was shrinking from
    // the far end while its numbers stayed plausible.
    const old = new Date(Date.now() - 400 * 86_400_000);
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-curated-ancient`, firstSeenAt: old },
    });
    await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        createdAt: old,
        source: "heuristic-v1",
        confidence: 0.9,
        reasons: [],
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 100_000,
      },
    });

    await runCleanupJob(env);

    expect(await prisma.token.findUnique({ where: { id: token.id } })).not.toBeNull();
    expect(await prisma.curatedAlert.count({ where: { tokenId: token.id } })).toBe(1);
  });

  it("keeps a token the AI reviewer has a verdict on", async () => {
    // Token -> AiReview is onDelete: Cascade too, and a "no buy" on a token no curator alerted is
    // held by nothing else once its outcome row ages out.
    const old = new Date(Date.now() - 400 * 86_400_000);
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-reviewed-ancient`, firstSeenAt: old },
    });
    await prisma.aiReview.create({
      data: {
        tokenId: token.id,
        createdAt: old,
        mode: "shadow",
        model: "test",
        decision: "no_buy",
        latencyMs: 1,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 100_000,
      },
    });

    await runCleanupJob(env);

    expect(await prisma.aiReview.count({ where: { tokenId: token.id } })).toBe(1);
  });

  it("still sweeps an equally old token nothing references", async () => {
    // The other half: the sweep has to keep doing its job, or the guard above is just a leak.
    const token = await prisma.token.create({
      data: {
        mintAddress: `${TAG}-plain-ancient`,
        firstSeenAt: new Date(Date.now() - 400 * 86_400_000),
      },
    });

    await runCleanupJob(env);

    expect(await prisma.token.findUnique({ where: { id: token.id } })).toBeNull();
  });
});

/**
 * The snapshot sweep runs in small batches (it walks tokens, then deletes through the
 * (tokenId, takenAt) index). Batch sizes are shrunk here so every loop boundary is crossed.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: batched snapshot sweep", () => {
  const TAG = "CleanupSnapshotTest";
  const WALLET = "CleanupSnapshotTestWallet111111111111111111";
  const DAY = 86_400_000;
  const env = {
    SNAPSHOT_RETENTION_DAYS: 30,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
  } as never;

  const cleanUp = async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: WALLET } });
  };
  beforeEach(cleanUp);
  afterAll(cleanUp);

  it("deletes every expired snapshot across batches, keeping matched and recent ones", async () => {
    const user = await prisma.user.create({ data: { walletAddress: WALLET } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id } });
    const oldSeen = new Date(Date.now() - 60 * DAY);
    const tokens = [];
    for (let i = 0; i < 5; i++) {
      tokens.push(
        await prisma.token.create({
          // Two share a firstSeenAt, so the keyset tie-break on id is exercised too.
          data: {
            mintAddress: `${TAG}-${i}`,
            firstSeenAt: new Date(oldSeen.getTime() + Math.min(i, 3) * 1000),
            lastLiveAt: new Date(),
          },
        }),
      );
    }
    for (const t of tokens) {
      await prisma.tokenSnapshot.createMany({
        data: Array.from({ length: 7 }, (_, k) => ({
          tokenId: t.id,
          priceUsd: 1,
          marketCapUsd: 100_000,
          takenAt: new Date(Date.now() - (40 + k) * DAY),
        })),
      });
      await prisma.tokenSnapshot.create({
        data: { tokenId: t.id, priceUsd: 1, marketCapUsd: 100_000, takenAt: new Date(Date.now() - DAY) },
      });
    }
    const matched = await prisma.tokenSnapshot.findFirstOrThrow({
      where: { tokenId: tokens[2]!.id, takenAt: { lt: new Date(Date.now() - 30 * DAY) } },
    });
    await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: tokens[2]!.id,
        snapshotId: matched.id,
        score: 60,
      },
    });

    // A launch that never traded: the nightly sweep skips it, the weekly full walk doesn't. First
    // seen after the others, so it sits on a later page than the first.
    const quiet = await prisma.token.create({
      data: { mintAddress: `${TAG}-quiet`, firstSeenAt: new Date(oldSeen.getTime() + 60_000) },
    });
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: quiet.id,
        priceUsd: 1,
        marketCapUsd: 100_000,
        takenAt: new Date(Date.now() - 40 * DAY),
      },
    });

    await runCleanupJob(env, { rowsPerBatch: 3, tokensPerBatch: 2, pauseMs: 0, fullSnapshotWalk: false });
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: quiet.id } })).toBe(1);

    const left = await prisma.tokenSnapshot.findMany({
      where: { tokenId: { in: tokens.map((t) => t.id) } },
      select: { id: true, takenAt: true },
    });
    // One recent snapshot per token, plus the one a Match still points to.
    expect(left).toHaveLength(tokens.length + 1);
    expect(left.some((s) => s.id === matched.id)).toBe(true);
    expect(left.filter((s) => s.takenAt.getTime() < Date.now() - 30 * DAY)).toHaveLength(1);
    await runCleanupJob(env, { rowsPerBatch: 3, tokensPerBatch: 2, pauseMs: 0, fullSnapshotWalk: true });
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: quiet.id } })).toBe(0);
  });
});

describe.skipIf(!dbAvailable)("runCleanupJob: untracked snapshot horizon", () => {
  const TAG = "CleanupUntrackedTest";
  const HOUR = 3_600_000;
  const env = {
    SNAPSHOT_RETENTION_DAYS: 30,
    SNAPSHOT_UNTRACKED_RETENTION_HOURS: 48,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
  } as never;

  const cleanUp = () => prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  beforeEach(cleanUp);
  afterAll(cleanUp);

  it("drops an untracked token's rows past the short horizon, and keeps a candidate's", async () => {
    const seen = new Date(Date.now() - 10 * 24 * HOUR);
    const make = (suffix: string) =>
      prisma.token.create({
        data: { mintAddress: `${TAG}-${suffix}`, firstSeenAt: seen, lastLiveAt: new Date() },
      });
    const untracked = await make("untracked");
    const candidate = await make("candidate");
    for (const t of [untracked, candidate]) {
      await prisma.tokenSnapshot.createMany({
        data: [72, 60, 50, 24, 1].map((h) => ({
          tokenId: t.id,
          priceUsd: 1,
          marketCapUsd: 50_000,
          takenAt: new Date(Date.now() - h * HOUR),
        })),
      });
    }
    await prisma.candidateOutcome.create({
      data: {
        tokenId: candidate.id,
        anchorAt: new Date(Date.now() - 60 * HOUR),
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
        features: {},
        nextCheckAt: new Date(),
        peak1hPriceUsd: 1,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 1,
      },
    });

    await runCleanupJob(env, { rowsPerBatch: 2, tokensPerBatch: 1, pauseMs: 0, fullSnapshotWalk: false });

    expect(await prisma.tokenSnapshot.count({ where: { tokenId: untracked.id } })).toBe(2);
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: candidate.id } })).toBe(5);
  });

  it("leaves untracked rows alone while the horizon is off", async () => {
    const t = await prisma.token.create({
      data: {
        mintAddress: `${TAG}-off`,
        firstSeenAt: new Date(Date.now() - 10 * 24 * HOUR),
        lastLiveAt: new Date(),
      },
    });
    await prisma.tokenSnapshot.create({
      data: { tokenId: t.id, priceUsd: 1, marketCapUsd: 50_000, takenAt: new Date(Date.now() - 72 * HOUR) },
    });
    await runCleanupJob({ ...(env as object), SNAPSHOT_UNTRACKED_RETENTION_HOURS: 0 } as never, {
      pauseMs: 0,
      fullSnapshotWalk: false,
    });
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: t.id } })).toBe(1);
  });
});
