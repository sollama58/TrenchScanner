import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { runCleanupJob } from "./cleanupJob.js";
import { PartialJobFailure } from "../scheduler.js";

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
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
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
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
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
    // held by nothing else once its outcome row ages out. (The review itself is inside the
    // outcome horizon here; the sweep that takes it past that is tested below.)
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
 * The AI reviewer's ledger goes on the outcome horizon, and a token it alone was holding goes in
 * the same run.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: AI reviewer ledger", () => {
  const TAG = "CleanupAiReviewTest";

  const env = {
    SNAPSHOT_RETENTION_DAYS: 3650,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 90,
    STALE_TOKEN_RETENTION_DAYS: 90,
  } as never;

  beforeEach(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  afterAll(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  const review = (tokenId: string, createdAt: Date) =>
    prisma.aiReview.create({
      data: {
        tokenId,
        createdAt,
        mode: "shadow",
        model: "test",
        decision: "no_buy",
        latencyMs: 1,
        anchorPriceUsd: 0.0001,
        anchorMcapUsd: 100_000,
      },
    });

  it("deletes reviews past the outcome horizon, in batches, and keeps the ones inside it", async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    // Still being reviewed: the old verdicts go, the fresh one keeps the token.
    const live = await prisma.token.create({
      data: { mintAddress: `${TAG}-still-reviewed`, firstSeenAt: old },
    });
    await review(live.id, old);
    await review(live.id, new Date(old.getTime() + 86_400_000));
    await review(live.id, new Date(Date.now() - 86_400_000));
    // Held by its reviews alone: once they are gone, the token sweep in the same run takes it.
    const stale = await prisma.token.create({
      data: { mintAddress: `${TAG}-only-old-reviews`, firstSeenAt: old },
    });
    await review(stale.id, old);
    await review(stale.id, new Date(old.getTime() + 86_400_000));

    // Four old rows at two a statement, so the loop's "fewer than a batch" exit is crossed.
    const meta = await runCleanupJob(env, { rowsPerBatch: 2, pauseMs: 0 });

    expect(meta.deletedAiReviews).toBe(4);
    const kept = await prisma.aiReview.findMany({ where: { tokenId: live.id }, select: { createdAt: true } });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.createdAt.getTime()).toBeGreaterThan(Date.now() - 2 * 86_400_000);
    expect(await prisma.token.findUnique({ where: { id: live.id } })).not.toBeNull();
    expect(await prisma.token.findUnique({ where: { id: stale.id } })).toBeNull();
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
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
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

    // One that traded but has not been live since long before the horizon: its old rows were
    // past every line on the nights it was still live, so the nightly sweep doesn't walk it.
    const dormant = await prisma.token.create({
      data: {
        mintAddress: `${TAG}-dormant`,
        firstSeenAt: new Date(oldSeen.getTime() + 120_000),
        lastLiveAt: new Date(Date.now() - 40 * DAY),
      },
    });
    await prisma.tokenSnapshot.create({
      data: {
        tokenId: dormant.id,
        priceUsd: 1,
        marketCapUsd: 100_000,
        takenAt: new Date(Date.now() - 40 * DAY),
      },
    });

    await runCleanupJob(env, { rowsPerBatch: 3, tokensPerBatch: 2, pauseMs: 0, fullSnapshotWalk: false });
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: quiet.id } })).toBe(1);
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: dormant.id } })).toBe(1);

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
    expect(await prisma.tokenSnapshot.count({ where: { tokenId: dormant.id } })).toBe(0);
  });
});

describe.skipIf(!dbAvailable)("runCleanupJob: untracked snapshot horizon", () => {
  const TAG = "CleanupUntrackedTest";
  const HOUR = 3_600_000;
  const env = {
    SNAPSHOT_RETENTION_DAYS: 30,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
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

describe.skipIf(!dbAvailable)("runCleanupJob: tracked snapshot downsampling", () => {
  const TAG = "CleanupDownsampleTest";
  const WALLET = "CleanupDownsampleTestWallet1111111111111111";
  const DAY = 86_400_000;
  const env = {
    SNAPSHOT_RETENTION_DAYS: 30,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    SNAPSHOT_UNTRACKED_RETENTION_HOURS: 0,
    SNAPSHOT_DOWNSAMPLE_AFTER_DAYS: 7,
    SNAPSHOT_DOWNSAMPLE_BUCKET_MINUTES: 5,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
  } as never;

  const cleanUp = async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: WALLET } });
  };
  beforeEach(cleanUp);
  afterAll(cleanUp);

  it("keeps each old bucket's peak and every matched row, and leaves recent history whole", async () => {
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-a`, firstSeenAt: new Date(Date.now() - 20 * DAY), lastLiveAt: new Date() },
    });
    // One old 5-minute bucket with four rows (peak in the middle), and three recent rows.
    const bucketStart = Math.floor((Date.now() - 10 * DAY) / 300_000) * 300_000;
    const old = [10, 30, 20, 15].map((mcap, i) => ({
      tokenId: token.id,
      priceUsd: 1,
      marketCapUsd: mcap,
      takenAt: new Date(bucketStart + i * 30_000),
    }));
    const recent = [1, 2, 3].map((i) => ({
      tokenId: token.id,
      priceUsd: 1,
      marketCapUsd: 5,
      takenAt: new Date(Date.now() - i * 60_000),
    }));
    await prisma.tokenSnapshot.createMany({ data: [...old, ...recent] });
    const matchedRow = await prisma.tokenSnapshot.findFirstOrThrow({
      where: { tokenId: token.id, marketCapUsd: 10 },
    });
    const user = await prisma.user.create({ data: { walletAddress: WALLET } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id } });
    await prisma.match.create({
      data: { userId: user.id, filterId: filter.id, tokenId: token.id, snapshotId: matchedRow.id, score: 50 },
    });

    for (let run = 0; run < 2; run++) {
      await runCleanupJob(env, { rowsPerBatch: 1, tokensPerBatch: 5, pauseMs: 0, fullSnapshotWalk: true });
    }

    const left = await prisma.tokenSnapshot.findMany({ where: { tokenId: token.id } });
    expect(
      left
        .filter((s) => s.takenAt.getTime() < Date.now() - 7 * DAY)
        .map((s) => s.marketCapUsd)
        .sort(),
    ).toEqual([10, 30]);
    expect(left.filter((s) => s.takenAt.getTime() > Date.now() - DAY)).toHaveLength(3);
  });

  it("keeps the newest row carrying a holder list, but not an older one", async () => {
    const token = await prisma.token.create({
      data: { mintAddress: `${TAG}-b`, firstSeenAt: new Date(Date.now() - 20 * DAY), lastLiveAt: new Date() },
    });
    const bucketStart = Math.floor((Date.now() - 10 * DAY) / 300_000) * 300_000;
    const list = [{ wallet: "w", pct: 1 }];
    await prisma.tokenSnapshot.createMany({
      data: [
        { tokenId: token.id, priceUsd: 1, marketCapUsd: 30, takenAt: new Date(bucketStart) },
        {
          tokenId: token.id,
          priceUsd: 1,
          marketCapUsd: 10,
          takenAt: new Date(bucketStart + 30_000),
          linkedHolders: list,
        },
        {
          tokenId: token.id,
          priceUsd: 1,
          marketCapUsd: 20,
          takenAt: new Date(bucketStart + 60_000),
          linkedHolders: list,
        },
        { tokenId: token.id, priceUsd: 1, marketCapUsd: 15, takenAt: new Date(bucketStart + 90_000) },
      ],
    });

    await runCleanupJob(env, { rowsPerBatch: 10, tokensPerBatch: 5, pauseMs: 0, fullSnapshotWalk: true });

    const left = await prisma.tokenSnapshot.findMany({ where: { tokenId: token.id } });
    expect(left.map((s) => s.marketCapUsd).sort()).toEqual([20, 30]);
  });

  it("thins to the same rows the per-batch re-ranking statement did, across groups and slices", async () => {
    // Three tokens, three old buckets each, rows with tied peaks, holder lists, a matched row and a
    // curated row - deleted in slices of 2 over groups of 2 tokens.
    const bucketStart = Math.floor((Date.now() - 10 * DAY) / 300_000) * 300_000;
    const tokenIds: string[] = [];
    for (let t = 0; t < 3; t++) {
      const token = await prisma.token.create({
        data: {
          mintAddress: `${TAG}-same-${t}`,
          firstSeenAt: new Date(Date.now() - 20 * DAY - t),
          lastLiveAt: new Date(),
        },
      });
      tokenIds.push(token.id);
      const rows = [];
      for (let b = 0; b < 3; b++) {
        for (let i = 0; i < 5; i++) {
          rows.push({
            tokenId: token.id,
            priceUsd: 1,
            marketCapUsd: ((t * 7 + b * 5 + i * 3) % 4) * 10,
            takenAt: new Date(bucketStart + b * 300_000 + i * 30_000),
            ...((t + b + i) % 3 === 0 ? { linkedHolders: [{ wallet: "w", pct: 1 }] } : {}),
          });
        }
      }
      await prisma.tokenSnapshot.createMany({ data: rows });
    }
    const all = await prisma.tokenSnapshot.findMany({
      where: { tokenId: { in: tokenIds } },
      orderBy: [{ tokenId: "asc" }, { takenAt: "asc" }],
    });
    const user = await prisma.user.create({ data: { walletAddress: WALLET } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id } });
    await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: tokenIds[0]!,
        snapshotId: all[1]!.id,
        score: 50,
      },
    });
    await prisma.curatedAlert.create({
      data: {
        tokenId: tokenIds[1]!,
        snapshotId: all[17]!.id,
        source: "heuristic-v1",
        confidence: 0.9,
        reasons: [],
        anchorPriceUsd: 1,
        anchorMcapUsd: 1,
      },
    });

    // The statement as it was, rerun with a LIMIT until a batch comes up short, then rolled back.
    const ROLLBACK = new Error("rollback");
    let expected: string[] = [];
    await prisma
      .$transaction(async (tx) => {
        for (;;) {
          const n = await tx.$executeRawUnsafe(
            `DELETE FROM "TokenSnapshot" WHERE "id" IN (
              SELECT r."id" FROM (
                SELECT s."id", s."tokenId", s."takenAt", s."linkedHolders" IS NOT NULL AS "hasList", row_number() OVER (
                         PARTITION BY s."tokenId", floor(extract(epoch FROM s."takenAt") / $4)
                         ORDER BY s."marketCapUsd" DESC, s."takenAt" ASC) AS rn
                  FROM "TokenSnapshot" s
                 WHERE s."tokenId" = ANY($1::text[]) AND s."takenAt" < $2 AND s."takenAt" >= $3
              ) r
               WHERE r.rn > 1
                 AND NOT EXISTS (SELECT 1 FROM "Match" m WHERE m."snapshotId" = r."id")
                 AND NOT EXISTS (SELECT 1 FROM "CuratedAlert" a WHERE a."snapshotId" = r."id")
                 AND NOT (r."hasList" AND NOT EXISTS (
                       SELECT 1 FROM "TokenSnapshot" n
                        WHERE n."tokenId" = r."tokenId" AND n."takenAt" > r."takenAt" AND n."linkedHolders" IS NOT NULL))
               LIMIT $5)`,
            tokenIds,
            new Date(Date.now() - 7 * DAY),
            new Date(Date.now() - 30 * DAY),
            300,
            2,
          );
          if (n < 2) break;
        }
        const kept = await tx.tokenSnapshot.findMany({ where: { tokenId: { in: tokenIds } } });
        expected = kept.map((r) => r.id).sort();
        throw ROLLBACK;
      })
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    expect(expected.length).toBeGreaterThan(9);
    expect(expected.length).toBeLessThan(all.length);

    const meta = await runCleanupJob(env, {
      rowsPerBatch: 2,
      tokensPerBatch: 2,
      pauseMs: 0,
      fullSnapshotWalk: true,
    });
    const left = await prisma.tokenSnapshot.findMany({ where: { tokenId: { in: tokenIds } } });
    expect(left.map((r) => r.id).sort()).toEqual(expected);
    expect(meta.downsampledSnapshots).toBeGreaterThanOrEqual(all.length - expected.length);
    expect(left.map((r) => r.id)).toEqual(expect.arrayContaining([all[1]!.id, all[17]!.id]));
  });
});

/**
 * Graded filter-alert anchors ("match" rows) go on MATCH_OUTCOME_RETENTION_DAYS: their verdict
 * already sits on the Match rows. Training rows, ungraded anchors (the report reads those to call
 * an alert ungradable) and anchors a curated alert shares stay.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: graded filter-alert anchors", () => {
  const TAG = "CleanupMatchAnchorTest";
  const DAY = 86_400_000;
  const env = {
    SNAPSHOT_RETENTION_DAYS: 3650,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
    MATCH_OUTCOME_RETENTION_DAYS: 7,
  } as never;

  const cleanUp = () => prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  beforeEach(cleanUp);
  afterAll(cleanUp);

  it("prunes old graded match anchors and keeps everything else", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-a` } });
    const row = (kind: string, ageDays: number, graded: boolean | "ungraded") =>
      prisma.candidateOutcome.create({
        data: {
          tokenId: token.id,
          sampleKind: kind,
          anchorAt: new Date(Date.now() - ageDays * DAY),
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          features: {},
          nextCheckAt: new Date(),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          finalizedAt: graded === true ? new Date(Date.now() - ageDays * DAY) : null,
          finalized24hAt: graded === false ? null : new Date(Date.now() - ageDays * DAY),
          peak24hReturnPct: graded === true ? 300 : null,
          hit2xIn1h: graded === true ? true : null,
          hit4xIn1h: graded === true ? false : null,
          disqualified: graded === true ? false : null,
        },
      });
    const oldGraded = await row("match", 10, true);
    // Its alert retired before run peaks were copied: the sweep hands the peak over first.
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-user-${Date.now()}` } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id, name: "f" } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 1, marketCapUsd: 50_000 },
    });
    const alert = await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: 50,
        candidateOutcomeId: oldGraded.id,
        // Its verdict copy never landed either: the sweep hands that over too.
      },
    });
    const recentGraded = await row("match", 3, true);
    const oldUngraded = await row("match", 10, "ungraded");
    const oldEvent = await row("event", 10, true);
    const shared = await row("match", 10, true);
    await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: shared.id,
        source: "heuristic-v1",
        confidence: 0.9,
        reasons: [],
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
      },
    });

    const meta = await runCleanupJob(env, { rowsPerBatch: 1, pauseMs: 0 });

    const left = new Set(
      (await prisma.candidateOutcome.findMany({ where: { tokenId: token.id } })).map((r) => r.id),
    );
    expect(left.has(oldGraded.id)).toBe(false);
    expect([recentGraded.id, oldUngraded.id, oldEvent.id, shared.id].every((id) => left.has(id))).toBe(true);
    expect((meta as { deletedMatchOutcomes: number }).deletedMatchOutcomes).toBe(1);
    const copied = await prisma.match.findUniqueOrThrow({ where: { id: alert.id } });
    expect(copied.peak24hReturnPct).toBe(300);
    expect(copied.hit2xIn1h).toBe(true);
    expect(copied.hit4xIn1h).toBe(false);
    await prisma.user.delete({ where: { id: user.id } });
  });

  // The general age sweep takes match anchors too; the copy must reach them first whichever
  // horizon is shorter, and with the match horizon off.
  it.each([0, 120])(
    "copies the verdict before the age sweep (MATCH_OUTCOME_RETENTION_DAYS=%i)",
    async (days) => {
      const token = await prisma.token.create({ data: { mintAddress: `${TAG}-age-${days}` } });
      const anchor = await prisma.candidateOutcome.create({
        data: {
          tokenId: token.id,
          sampleKind: "match",
          anchorAt: new Date(Date.now() - 40 * DAY),
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          features: {},
          nextCheckAt: new Date(),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          finalizedAt: new Date(Date.now() - 40 * DAY),
          finalized24hAt: new Date(Date.now() - 40 * DAY),
          peak24hReturnPct: 300,
          hit2xIn1h: true,
          hit4xIn1h: false,
          disqualified: false,
        },
      });
      const user = await prisma.user.create({ data: { walletAddress: `${TAG}-user-${Date.now()}` } });
      const filter = await prisma.userFilter.create({ data: { userId: user.id, name: "f" } });
      const snapshot = await prisma.tokenSnapshot.create({
        data: { tokenId: token.id, priceUsd: 1, marketCapUsd: 50_000 },
      });
      const alert = await prisma.match.create({
        data: {
          userId: user.id,
          filterId: filter.id,
          tokenId: token.id,
          snapshotId: snapshot.id,
          score: 50,
          candidateOutcomeId: anchor.id,
        },
      });

      await runCleanupJob(
        {
          ...(env as object),
          CANDIDATE_OUTCOME_RETENTION_DAYS: 30,
          MATCH_OUTCOME_RETENTION_DAYS: days,
        } as never,
        { rowsPerBatch: 1, pauseMs: 0 },
      );

      expect(await prisma.candidateOutcome.findUnique({ where: { id: anchor.id } })).toBeNull();
      const copied = await prisma.match.findUniqueOrThrow({ where: { id: alert.id } });
      expect(copied.hit2xIn1h).toBe(true);
      expect(copied.peak24hReturnPct).toBe(300);
      await prisma.user.delete({ where: { id: user.id } });
    },
  );
});

describe.skipIf(!dbAvailable)("runCleanupJob: TokenSage narratives", () => {
  const env = {
    SNAPSHOT_RETENTION_DAYS: 3650,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
  } as never;
  const TAG = `cleanup-narrative-${Date.now()}`;
  const day = 86_400_000;

  afterAll(async () => {
    await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("drops the raw document after the training window, keeps the row, and deletes it at 90 days", async () => {
    const row = (suffix: string, ageDays: number) =>
      prisma.tokenNarrative.create({
        data: {
          mintAddress: `${TAG}-${suffix}`,
          depth: "full",
          status: "complete",
          pairKind: "token",
          analysis: { summary: "a dog coin" },
          checkedAt: new Date(Date.now() - ageDays * day),
        },
      });
    // Every row here has a coin in the band, so only the age rules apply to it.
    for (const suffix of ["fresh", "old", "older", "gone"]) {
      await prisma.token.create({
        data: { mintAddress: `${TAG}-${suffix}`, firstInBandAt: new Date(Date.now() - 100 * day) },
      });
    }
    // "old" crossed the 21-day line recently (the nightly strip only looks a few days back);
    // "older" is a row the nightly pass missed, which the weekly full walk picks up.
    await Promise.all([row("fresh", 5), row("old", 22), row("older", 40), row("gone", 100)]);
    await runCleanupJob(env, { rowsPerBatch: 10, pauseMs: 0, fullSnapshotWalk: false });
    const nightly = await prisma.tokenNarrative.findMany({
      where: { mintAddress: { startsWith: TAG } },
      orderBy: { mintAddress: "asc" },
    });
    expect(nightly.map((r) => [r.mintAddress.slice(TAG.length + 1), r.analysis !== null])).toEqual([
      ["fresh", true],
      ["old", false],
      ["older", true],
    ]);
    await runCleanupJob(env, { rowsPerBatch: 10, pauseMs: 0, fullSnapshotWalk: true });
    const left = await prisma.tokenNarrative.findMany({
      where: { mintAddress: { startsWith: TAG } },
      orderBy: { mintAddress: "asc" },
    });
    expect(left.map((r) => [r.mintAddress.slice(TAG.length + 1), r.analysis, r.pairKind])).toEqual([
      ["fresh", { summary: "a dog coin" }, "token"],
      ["old", null, "token"],
      ["older", null, "token"],
    ]);
  });

  it("drops the document of a coin that never reached the band after two days, and the row once its coin is gone", async () => {
    const T = `${TAG}-u`;
    const row = (suffix: string, ageHours: number, depth = "basic") =>
      prisma.tokenNarrative.create({
        data: {
          mintAddress: `${T}-${suffix}`,
          depth,
          status: "complete",
          pairKind: "sol",
          analysis: { summary: "a frog coin" },
          checkedAt: new Date(Date.now() - ageHours * 3_600_000),
        },
      });
    // A coin still outside the band, one that reached it, and one whose Token row the stale sweep
    // already removed (its read is older than STALE_TOKEN_RETENTION_DAYS, 3650 days here).
    await prisma.token.create({ data: { mintAddress: `${T}-outside` } });
    await prisma.token.create({ data: { mintAddress: `${T}-inband`, firstInBandAt: new Date() } });
    await Promise.all([
      row("outside", 72),
      row("outside-young", 12),
      row("inband", 72),
      row("gone", 3651 * 24),
      row("gone-young", 72),
    ]);
    await runCleanupJob(env, { rowsPerBatch: 10, pauseMs: 0, fullSnapshotWalk: false });
    const left = await prisma.tokenNarrative.findMany({
      where: { mintAddress: { startsWith: T } },
      orderBy: { mintAddress: "asc" },
    });
    expect(left.map((r) => [r.mintAddress.slice(T.length + 1), r.analysis !== null, r.pairKind])).toEqual([
      // No Token row and younger than the token horizon: the document goes, the row stays for now.
      ["gone-young", false, "sol"],
      ["inband", true, "sol"],
      ["outside", false, "sol"],
      ["outside-young", true, "sol"],
    ]);
  });

  it("walks the days that newly crossed each line on a weeknight, and every row on the weekly walk", async () => {
    const T = `${TAG}-w`;
    const shortTokens = {
      SNAPSHOT_RETENTION_DAYS: 3650,
      PRICE_PATH_RETENTION_DAYS: 21,
      CANDLE_FINE_RETENTION_DAYS: 30,
      CANDLE_RETENTION_DAYS: 90,
      CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
      STALE_TOKEN_RETENTION_DAYS: 14,
    } as never;
    const row = (suffix: string, ageHours: number) =>
      prisma.tokenNarrative.create({
        data: {
          mintAddress: `${T}-${suffix}`,
          depth: "basic",
          status: "complete",
          pairKind: "sol",
          analysis: { summary: "a cat coin" },
          checkedAt: new Date(Date.now() - ageHours * 3_600_000),
        },
      });
    // Two coins outside the band: read three days ago (crossed the 48-hour line since the last few
    // sweeps) and ten days ago (a row the nightly slice does not reach). Two narratives with no
    // Token: read just past the 14-day token horizon, and long past it.
    await prisma.token.create({ data: { mintAddress: `${T}-recent` } });
    await prisma.token.create({ data: { mintAddress: `${T}-missed` } });
    await Promise.all([
      row("recent", 72),
      row("missed", 240),
      row("gone", 15 * 24),
      row("gone-missed", 40 * 24),
    ]);
    const nightly = (await runCleanupJob(shortTokens, {
      rowsPerBatch: 10,
      pauseMs: 0,
      fullSnapshotWalk: false,
    })) as Record<string, unknown>;
    const after = async () =>
      (
        await prisma.tokenNarrative.findMany({
          where: { mintAddress: { startsWith: T } },
          orderBy: { mintAddress: "asc" },
        })
      ).map((r) => [r.mintAddress.slice(T.length + 1), r.analysis !== null]);
    expect(await after()).toEqual([
      ["gone-missed", true],
      ["missed", true],
      ["recent", false],
    ]);
    // The heartbeat's view of the run: every stage's count (BubbleMapAtAlert's was dropped before
    // 2026-10-16) and what each took.
    expect(nightly.deletedBubbleMapsAtAlert).toBe(0);
    expect(nightly.deletedOrphanNarratives).toBe(1);
    const durations = nightly.stagesMs as Record<string, number>;
    expect(typeof durations.orphanNarratives).toBe("number");
    expect(typeof durations.untrackedNarrativeDocs).toBe("number");
    expect(nightly.heldStages).toBeUndefined();
    await runCleanupJob(shortTokens, { rowsPerBatch: 10, pauseMs: 0, fullSnapshotWalk: true });
    expect(await after()).toEqual([
      ["missed", false],
      ["recent", false],
    ]);
  });
});

/**
 * Matches past MATCH_ARCHIVE_DAYS move to MatchArchive (user decision P21), releasing their alert
 * snapshot and token to the sweeps - except the token of an archived 2x, which the all-time
 * Leaderboard still shows.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: match archive", () => {
  const TAG = "CleanupMatchArchiveTest";
  const WALLET = "CleanupMatchArchiveTestWallet1111111111111";
  const DAY = 86_400_000;
  const env = {
    SNAPSHOT_RETENTION_DAYS: 30,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 90,
    MATCH_ARCHIVE_DAYS: 60,
  } as never;

  const cleanUp = async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    // Cascades to the user's filters, matches and archived matches.
    await prisma.user.deleteMany({ where: { walletAddress: WALLET } });
  };
  beforeEach(cleanUp);
  afterAll(cleanUp);

  it("moves old matches with their verdicts, then lets their snapshots and tokens go", async () => {
    const user = await prisma.user.create({ data: { walletAddress: WALLET } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id } });
    const coin = async (name: string, ageDays: number) => {
      const token = await prisma.token.create({
        data: {
          mintAddress: `${TAG}-${name}`,
          symbol: name.toUpperCase(),
          name,
          firstSeenAt: new Date(Date.now() - (ageDays + 1) * DAY),
        },
      });
      const snapshot = await prisma.tokenSnapshot.create({
        data: {
          tokenId: token.id,
          priceUsd: 1,
          marketCapUsd: 20_000,
          takenAt: new Date(Date.now() - ageDays * DAY),
        },
      });
      return { token, snapshot };
    };
    const match = (c: Awaited<ReturnType<typeof coin>>, ageDays: number, extra: object = {}) =>
      prisma.match.create({
        data: {
          userId: user.id,
          filterId: filter.id,
          tokenId: c.token.id,
          snapshotId: c.snapshot.id,
          score: 60,
          matchedAt: new Date(Date.now() - ageDays * DAY),
          ...extra,
        },
      });
    const winner = await coin("winner", 100);
    const loser = await coin("loser", 100);
    const recent = await coin("recent", 10);
    const won = await match(winner, 100, {
      peakMcapUsd: 70_000,
      peakReturnPct: 250,
      hitHundredPctAt: new Date(Date.now() - 100 * DAY),
      hit2xIn1h: true,
      hit4xIn1h: false,
      disqualified: false,
    });
    const lost = await match(loser, 100, { hit2xIn1h: false, alertMcapUsd: 21_000 });
    const kept = await match(recent, 10);

    // One row a statement, so the loop's "fewer than a batch" exit is crossed.
    const first = await runCleanupJob(env, { rowsPerBatch: 1, pauseMs: 0, fullSnapshotWalk: true });
    expect(first.archivedMatches).toBe(2);
    expect(await prisma.match.findMany({ where: { userId: user.id }, select: { id: true } })).toEqual([
      { id: kept.id },
    ]);
    const archived = await prisma.matchArchive.findMany({
      where: { userId: user.id },
      orderBy: { id: "asc" },
    });
    expect(archived.map((a) => a.id).sort()).toEqual([won.id, lost.id].sort());
    expect(archived.find((a) => a.id === won.id)).toMatchObject({
      filterId: filter.id,
      tokenId: winner.token.id,
      mintAddress: `${TAG}-winner`,
      symbol: "WINNER",
      snapshotId: winner.snapshot.id,
      snapshotMarketCapUsd: 20_000,
      matchedAt: won.matchedAt,
      peakReturnPct: 250,
      hitHundredPctAt: won.hitHundredPctAt,
      hit2xIn1h: true,
      hit4xIn1h: false,
    });
    expect(archived.find((a) => a.id === lost.id)).toMatchObject({ alertMcapUsd: 21_000, hit2xIn1h: false });
    // The snapshot sweep ran before the move, so the alert snapshots go on the next run.
    expect(await prisma.tokenSnapshot.count({ where: { id: winner.snapshot.id } })).toBe(1);

    const second = await runCleanupJob(env, { rowsPerBatch: 1, pauseMs: 0, fullSnapshotWalk: true });
    expect(second.archivedMatches).toBe(0);
    expect(
      await prisma.tokenSnapshot.count({ where: { id: { in: [winner.snapshot.id, loser.snapshot.id] } } }),
    ).toBe(0);
    // The archived 2x keeps its coin for the Leaderboard's card; the other coin is swept.
    expect(await prisma.token.findUnique({ where: { id: winner.token.id } })).not.toBeNull();
    expect(await prisma.token.findUnique({ where: { id: loser.token.id } })).toBeNull();
    expect(await prisma.matchArchive.count({ where: { userId: user.id } })).toBe(2);
  });

  it("is off at 0, and never archives inside the snapshot horizon", async () => {
    const user = await prisma.user.create({ data: { walletAddress: WALLET } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-young` } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 1, marketCapUsd: 20_000, takenAt: new Date() },
    });
    await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: 60,
        matchedAt: new Date(Date.now() - 20 * DAY),
      },
    });
    const off = await runCleanupJob({ ...(env as object), MATCH_ARCHIVE_DAYS: 0 } as never, { pauseMs: 0 });
    expect(off.archivedMatches).toBe(0);
    // 10 days asked for, but a match is archived no sooner than SNAPSHOT_RETENTION_DAYS (30).
    const early = await runCleanupJob({ ...(env as object), MATCH_ARCHIVE_DAYS: 10 } as never, {
      pauseMs: 0,
    });
    expect(early.archivedMatches).toBe(0);
    expect(await prisma.match.count({ where: { userId: user.id } })).toBe(1);
  });
});

/**
 * Retention decided 2026-10-16: archived matches go after 90 days unless they ran (180), training
 * rows after 90 unless they doubled or a curated call points at them (180), the trade tape's
 * wallet rows after two weeks, and a bug report's screenshot a week after it is done.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: retention tiers", () => {
  const TAG = "CleanupRetentionTiersTest";
  const WALLET = "CleanupRetentionTiersTestWallet111111111111";
  const DAY = 86_400_000;
  const env = {
    SNAPSHOT_RETENTION_DAYS: 30,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    TWA_RETENTION_DAYS: 14,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 90,
    CANDIDATE_OUTCOME_HIT_RETENTION_DAYS: 180,
    STALE_TOKEN_RETENTION_DAYS: 3650,
    MATCH_ARCHIVE_DAYS: 30,
    MATCH_ARCHIVE_RETENTION_DAYS: 90,
    MATCH_ARCHIVE_HIT_RETENTION_DAYS: 180,
  } as never;
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  const cleanUp = async () => {
    await prisma.feedbackReport.deleteMany({ where: { submitterKey: TAG } });
    await prisma.chartFlaggedTrade.deleteMany({ where: { mint: { startsWith: TAG } } });
    await prisma.chartMarkCoin.deleteMany({ where: { mint: { startsWith: TAG } } });
    await prisma.launchRead.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: WALLET } });
  };
  beforeEach(cleanUp);
  afterAll(cleanUp);

  it("keeps a tracked coin's complete launch read past three days, and sweeps the rest", async () => {
    // Helius audit 2026-10-23, N-5: a deploy re-read old coins back in band for 10-30 credits each.
    await prisma.token.create({ data: { mintAddress: `${TAG}-tracked` } });
    await prisma.token.create({ data: { mintAddress: `${TAG}-tracked-incomplete` } });
    const read = (suffix: string, ageDays: number, complete = true) =>
      prisma.launchRead.create({
        data: { mintAddress: `${TAG}-${suffix}`, reading: {}, complete, checkedAt: ago(ageDays) },
      });
    await read("tracked", 5);
    await read("tracked-incomplete", 5, false);
    await read("gone", 5);
    await read("gone-recent", 1);

    await runCleanupJob(env, { rowsPerBatch: 1, pauseMs: 0 });
    const left = await prisma.launchRead.findMany({
      where: { mintAddress: { startsWith: TAG } },
      select: { mintAddress: true },
    });
    expect(left.map((r) => r.mintAddress).sort()).toEqual([`${TAG}-gone-recent`, `${TAG}-tracked`]);
  });

  it("keeps the archived runners to 180 days and lets the rest go at 90", async () => {
    const user = await prisma.user.create({ data: { walletAddress: WALLET } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id } });
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-archived` } });
    const archived = (name: string, ageDays: number, extra: object = {}) =>
      prisma.matchArchive.create({
        data: {
          id: `${TAG}-${name}`,
          userId: user.id,
          filterId: filter.id,
          tokenId: token.id,
          mintAddress: token.mintAddress,
          snapshotId: `${TAG}-snap`,
          snapshotMarketCapUsd: 20_000,
          matchedAt: ago(ageDays),
          score: 60,
          deliveredDashboard: true,
          ...extra,
        },
      });
    await archived("recent-loser", 80, { hit2xIn1h: false });
    await archived("old-loser", 100, { hit2xIn1h: false, peakReturnPct: 40 });
    await archived("old-doubler", 100, { hit2xIn1h: true });
    await archived("old-hundred", 100, { hitHundredPctAt: ago(100) });
    await archived("old-peak", 100, { peakReturnPct: 120 });
    await archived("ancient-doubler", 200, { hit2xIn1h: true });

    const meta = await runCleanupJob(env, { rowsPerBatch: 1, pauseMs: 0 });
    expect(meta.deletedArchivedMatches).toBe(2);
    const left = await prisma.matchArchive.findMany({ where: { userId: user.id }, select: { id: true } });
    expect(left.map((a) => a.id).sort()).toEqual(
      [`${TAG}-recent-loser`, `${TAG}-old-doubler`, `${TAG}-old-hundred`, `${TAG}-old-peak`].sort(),
    );

    // Off: nothing archived is ever deleted.
    await archived("off-loser", 100, { hit2xIn1h: false });
    const off = await runCleanupJob({ ...(env as object), MATCH_ARCHIVE_RETENTION_DAYS: 0 } as never, {
      pauseMs: 0,
    });
    expect(off.deletedArchivedMatches).toBe(0);
    expect(await prisma.matchArchive.count({ where: { userId: user.id } })).toBe(5);
  });

  it("keeps the training rows that doubled, or that a curated call points at, to 180 days", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-outcomes` } });
    const outcome = (ageDays: number, extra: object = {}) =>
      prisma.candidateOutcome.create({
        data: {
          tokenId: token.id,
          sampleKind: "event",
          anchorAt: ago(ageDays),
          anchorPriceUsd: 1,
          anchorMcapUsd: 50_000,
          features: {},
          nextCheckAt: new Date(),
          peak1hPriceUsd: 1,
          low1hPriceUsd: 1,
          lowBefore2xPriceUsd: 1,
          peak24hPriceUsd: 1,
          finalizedAt: ago(ageDays),
          ...extra,
        },
      });
    const recent = await outcome(80, { hit2xIn1h: false });
    const oldMiss = await outcome(100, { hit2xIn1h: false });
    const oldUngraded = await outcome(100);
    const oldHit = await outcome(100, { hit2xIn1h: true });
    const oldCurated = await outcome(100, { hit2xIn1h: false });
    await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: oldCurated.id,
        createdAt: ago(100),
        source: "heuristic-v1",
        confidence: 0.9,
        reasons: [],
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
      },
    });
    const ancientHit = await outcome(200, { hit2xIn1h: true });

    const meta = await runCleanupJob(env, { rowsPerBatch: 1, pauseMs: 0 });
    expect(meta.deletedCandidateOutcomes).toBe(3);
    const left = await prisma.candidateOutcome.findMany({
      where: { tokenId: token.id },
      select: { id: true },
    });
    expect(left.map((o) => o.id).sort()).toEqual([recent.id, oldHit.id, oldCurated.id].sort());
    expect([oldMiss.id, oldUngraded.id, ancientHit.id].some((id) => left.some((o) => o.id === id))).toBe(
      false,
    );

    // With the hit horizon no longer than the general one, age alone decides, as before.
    const flat = await runCleanupJob(
      { ...(env as object), CANDIDATE_OUTCOME_HIT_RETENTION_DAYS: 90 } as never,
      { pauseMs: 0 },
    );
    expect(flat.deletedCandidateOutcomes).toBe(2);
    expect(await prisma.candidateOutcome.count({ where: { tokenId: token.id } })).toBe(1);
  });

  it("prunes the trade tape's wallet rows on their own two-week horizon", async () => {
    const token = await prisma.token.create({ data: { mintAddress: `${TAG}-tape` } });
    const row = (wallet: string, ageDays: number) =>
      prisma.tokenWalletActivity.create({ data: { tokenId: token.id, wallet, createdAt: ago(ageDays) } });
    await row("fresh", 10);
    await row("stale", 20);
    await row("older", 40);

    const meta = await runCleanupJob(env, { rowsPerBatch: 1, pauseMs: 0 });
    expect(meta.deletedWalletActivity).toBe(2);
    expect(await prisma.tokenWalletActivity.findMany({ where: { tokenId: token.id } })).toMatchObject([
      { wallet: "fresh" },
    ]);

    // 0 falls back to the snapshot horizon.
    await row("stale-again", 20);
    const fallback = await runCleanupJob({ ...(env as object), TWA_RETENTION_DAYS: 0 } as never, {
      pauseMs: 0,
    });
    expect(fallback.deletedWalletActivity).toBe(0);
    expect(await prisma.tokenWalletActivity.count({ where: { tokenId: token.id } })).toBe(2);
  });

  it("drops the chart's saved flagged trades on the trade tape's horizon", async () => {
    const mint = `${TAG}-flagged`;
    const trade = (sig: string, ageDays: number) =>
      prisma.chartFlaggedTrade.create({
        data: { sig, wallet: "w", side: 1, mint, sol: 1, at: ago(ageDays) },
      });
    await trade("fresh", 10);
    await trade("stale", 20);

    const meta = await runCleanupJob(env, { pauseMs: 0 });
    expect(meta.deletedChartFlaggedTrades).toBe(1);
    expect(await prisma.chartFlaggedTrade.findMany({ where: { mint }, select: { sig: true } })).toEqual([
      { sig: "fresh" },
    ]);
  });

  it("keeps a recently opened coin's saved flagged trades past the horizon, and trims a lapsed coin's fill span", async () => {
    const kept = `${TAG}-kept`;
    const lapsed = `${TAG}-lapsed`;
    const gone = `${TAG}-gone`;
    for (const mint of [kept, lapsed])
      await prisma.chartFlaggedTrade.create({
        data: { sig: `${mint}-old`, wallet: "w", side: 1, mint, sol: 1, at: ago(20) },
      });
    await prisma.chartMarkCoin.createMany({
      data: [
        { mint: kept, keepUntil: ago(-3), filledFrom: ago(25), filledTo: ago(1) },
        { mint: lapsed, keepUntil: ago(1), filledFrom: ago(25), filledTo: ago(2) },
        { mint: gone, keepUntil: ago(1), filledFrom: ago(25), filledTo: ago(16) },
      ],
    });

    const meta = await runCleanupJob(env, { pauseMs: 0 });
    expect(meta.deletedChartFlaggedTrades).toBe(1);
    expect(
      await prisma.chartFlaggedTrade.findMany({
        where: { mint: { in: [kept, lapsed] } },
        select: { mint: true },
      }),
    ).toEqual([{ mint: kept }]);
    const coins = await prisma.chartMarkCoin.findMany({
      where: { mint: { startsWith: TAG } },
      orderBy: { mint: "asc" },
      select: { mint: true, filledFrom: true },
    });
    expect(coins.map((c) => c.mint)).toEqual([kept, lapsed]);
    // The lapsed coin's span now starts where its kept marks do: the next open reads the rest again.
    expect(coins[1]!.filledFrom!.getTime()).toBeGreaterThan(ago(15).getTime());
    expect(coins[0]!.filledFrom!.getTime()).toBeLessThan(ago(24).getTime());
  });

  it("drops a bug report's screenshot once it is done or a month old, and the done report after a quarter", async () => {
    const report = (name: string, status: string, createdDays: number, updatedDays: number) =>
      prisma.feedbackReport.create({
        data: {
          kind: "bug",
          message: name,
          status,
          submitterKey: TAG,
          screenshot: "data:image/jpeg;base64,AAAA",
          createdAt: ago(createdDays),
          updatedAt: ago(updatedDays),
        },
      });
    await report("open-fresh", "new", 5, 5);
    await report("done-fresh", "done", 5, 2);
    await report("done-week", "done", 20, 8);
    await report("open-month", "new", 35, 35);
    await report("done-quarter", "done", 120, 100);

    const meta = await runCleanupJob(env, { pauseMs: 0 });
    expect(meta.strippedFeedbackScreenshots).toBe(3);
    expect(meta.deletedFeedbackReports).toBe(1);
    const left = await prisma.feedbackReport.findMany({
      where: { submitterKey: TAG },
      select: { message: true, screenshot: true },
      orderBy: { message: "asc" },
    });
    expect(left).toEqual([
      { message: "done-fresh", screenshot: "data:image/jpeg;base64,AAAA" },
      { message: "done-week", screenshot: null },
      { message: "open-fresh", screenshot: "data:image/jpeg;base64,AAAA" },
      { message: "open-month", screenshot: null },
    ]);
  });
});

/**
 * A run cut off by a deploy: the next boot's catch-up skips the stages it already finished, so a
 * trainer restarting every few minutes still gets through the whole sweep over a few attempts.
 */
describe.skipIf(!dbAvailable)("runCleanupJob: resuming a cut-off run", () => {
  const env = {
    SNAPSHOT_RETENTION_DAYS: 3650,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
  } as never;
  const hour = 3_600_000;

  const setResume = (startedAt: Date, done: string[]) =>
    prisma.systemHeartbeat.upsert({
      where: { job: "cleanup" },
      create: {
        job: "cleanup",
        lastRunAt: startedAt,
        meta: { cleanupResume: { startedAt: startedAt.toISOString(), done } },
      },
      update: { meta: { cleanupResume: { startedAt: startedAt.toISOString(), done } } },
    });
  const resumeState = async () => {
    const row = await prisma.systemHeartbeat.findUnique({ where: { job: "cleanup" } });
    return (row?.meta as Record<string, unknown> | null)?.cleanupResume ?? null;
  };

  beforeEach(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job: "cleanup" } });
  });
  afterAll(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job: "cleanup" } });
  });

  it("skips the stages a recent cut-off run finished, then clears the note", async () => {
    await setResume(new Date(Date.now() - hour), ["snapshots", "matchOutcomeCopies", "nonces"]);

    const meta = (await runCleanupJob(env)) as Record<string, unknown>;

    expect(meta.resumedSkippedStages).toBe("snapshots, matchOutcomeCopies, nonces");
    expect(await resumeState()).toBeNull();
  });

  it("starts from the first stage when the cut-off run is from an earlier night", async () => {
    await setResume(new Date(Date.now() - 22 * hour), ["snapshots"]);

    const meta = (await runCleanupJob(env)) as Record<string, unknown>;

    expect(meta.resumedSkippedStages).toBeUndefined();
    expect(await resumeState()).toBeNull();
  });
});

describe.skipIf(!dbAvailable)("runCleanupJob: index maintenance", () => {
  const env = {
    SNAPSHOT_RETENTION_DAYS: 3650,
    PRICE_PATH_RETENTION_DAYS: 21,
    CANDLE_FINE_RETENTION_DAYS: 30,
    CANDLE_RETENTION_DAYS: 90,
    CANDIDATE_OUTCOME_RETENTION_DAYS: 3650,
    STALE_TOKEN_RETENTION_DAYS: 3650,
  } as never;
  const TABLE = "CleanupIndexTest";

  beforeEach(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job: "cleanup" } });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
  });
  afterAll(async () => {
    await prisma.systemHeartbeat.deleteMany({ where: { job: "cleanup" } });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
  });

  it("names an invalid index in the run's error, and still runs every sweep", async () => {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${TABLE}" (dup int)`);
    await prisma.$executeRawUnsafe(`INSERT INTO "${TABLE}" VALUES (1), (1)`);
    // A unique build over duplicates fails and leaves its index INVALID, as a timed-out migration does.
    await prisma
      .$executeRawUnsafe(`CREATE UNIQUE INDEX CONCURRENTLY "${TABLE}_dup_key" ON "${TABLE}" (dup)`)
      .catch(() => undefined);

    const err = await runCleanupJob(env, { reindex: false }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PartialJobFailure);
    expect((err as PartialJobFailure).message).toBe("cleanup: 1 stage(s) failed: invalidIndexes");
    expect((err as PartialJobFailure).meta.failedStages).toContain(`${TABLE}.${TABLE}_dup_key`);
    expect((err as PartialJobFailure).meta).toHaveProperty("deletedSnapshots");
  });

  it("reports the weekly rebuild, and rebuilds nothing with the disk line off", async () => {
    const meta = (await runCleanupJob(env, { reindex: true })) as Record<string, unknown>;
    expect(meta.reindexed).toBe("");
    expect(meta.reindexSkipped).toContain("TokenSnapshot_pkey (DB_DISK_ALERT_MB is off)");
    const quiet = (await runCleanupJob(env, { reindex: false })) as Record<string, unknown>;
    expect(quiet).not.toHaveProperty("reindexSkipped");
  });
});
