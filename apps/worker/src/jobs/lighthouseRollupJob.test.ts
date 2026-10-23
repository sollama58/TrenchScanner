import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, REPORTED_LABEL_RULE } from "@trenchscanner/core";
import { LIGHTHOUSE_ROLLUP_VERSION, runLighthouseRollupJob } from "./lighthouseRollupJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/**
 * The Lighthouse's history rollup: the hour's sums match what the Live tab's Lighthouse counts,
 * the day's label rows carry the coins read and the calls on them, and running it again lands on
 * the same rows.
 */

const TAG = "lighthouse-rollup-test";
const MINT_DOG = "RollDog1111111111111111111111111111111111111";
const MINT_DOG2 = "RollDog2111111111111111111111111111111111111";
const MINT_AI = "RollAi11111111111111111111111111111111111111";
const MINT_BAD = "RollBad1111111111111111111111111111111111111";
const MINTS = [MINT_DOG, MINT_DOG2, MINT_AI, MINT_BAD];
const HOUR_MS = 3_600_000;

// A fixed hour well in the past, so no other suite's rows share it.
const AT = new Date(Date.UTC(2024, 1, 3, 10, 20, 0));
const HOUR = new Date(Date.UTC(2024, 1, 3, 10));
const DAY = new Date(Date.UTC(2024, 1, 3));

async function cleanup() {
  await prisma.curatedAlert.deleteMany({ where: { source: TAG } });
  await prisma.candidateOutcome.deleteMany({ where: { token: { mintAddress: { in: MINTS } } } });
  await prisma.token.deleteMany({ where: { mintAddress: { in: MINTS } } });
  await prisma.tokenNarrative.deleteMany({ where: { mintAddress: { in: MINTS } } });
  await prisma.lighthouseHour.deleteMany({
    where: { hour: { gte: DAY, lt: new Date(DAY.getTime() + 4 * 24 * HOUR_MS) } },
  });
  await prisma.lighthouseDayLabel.deleteMany({
    where: { day: { gte: DAY, lt: new Date(DAY.getTime() + 4 * 24 * HOUR_MS) } },
  });
}

describe.skipIf(!dbAvailable)("lighthouse rollup", () => {
  beforeAll(async () => {
    await cleanup();
    const tokens = await Promise.all(
      MINTS.map((mintAddress) =>
        prisma.token.create({ data: { mintAddress, symbol: "ROLL", firstSeenAt: AT } }),
      ),
    );
    await prisma.tokenNarrative.createMany({
      data: [
        {
          mintAddress: MINT_DOG,
          depth: "full",
          status: "complete",
          categories: [
            { label: "meme", confidence: 0.4 },
            { label: "rlanimal/dog", confidence: 0.9 },
          ],
          referentKind: "animal",
          referentSupport: ["name", "x"],
          referentConfidence: 0.8,
          flags: ["copycat"],
          xVerdict: "about_this_coin",
          xFit: 0.6,
          copiesRecent: true,
          trendMatched: true,
          checkedAt: AT,
        },
        {
          mintAddress: MINT_DOG2,
          depth: "basic",
          status: "complete",
          categories: [{ label: "rlanimal/dog", confidence: 0.7 }],
          referentKind: "animal",
          referentConfidence: 0.4,
          referentGeneric: true,
          copiesRecent: false,
          checkedAt: AT,
        },
        {
          mintAddress: MINT_AI,
          depth: "basic",
          status: "partial",
          categories: [{ label: "rltech/ai", confidence: "high" }],
          checkedAt: AT,
        },
        { mintAddress: MINT_BAD, depth: "basic", status: "failed", failReason: "nope", checkedAt: AT },
      ],
    });
    const row = {
      anchorAt: AT,
      anchorPriceUsd: 1,
      anchorMcapUsd: 50_000,
      features: {},
      nextCheckAt: AT,
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
      sampleKind: "event",
    };
    await prisma.candidateOutcome.createMany({
      data: [
        {
          ...row,
          tokenId: tokens[0]!.id,
          hit2xIn1h: true,
          hit4xIn1h: true,
          hit10xIn1h: false,
          simReturnPct: 150,
        },
        {
          ...row,
          tokenId: tokens[1]!.id,
          hit2xIn1h: true,
          disqualified: true,
          hit4xIn1h: false,
          simReturnPct: -50,
        },
        { ...row, tokenId: tokens[2]!.id, hit2xIn1h: false, hit4xIn1h: false, simReturnPct: -20 },
        { ...row, tokenId: tokens[3]!.id },
        { ...row, tokenId: tokens[3]!.id, sampleKind: "hourly", hit2xIn1h: true, simReturnPct: 900 },
        // A decision moment the safety screen rejects today (empty-wallet cut): out of the
        // screened field, as on the Live tab.
        {
          ...row,
          tokenId: tokens[2]!.id,
          features: { emptyTop10WalletPct: 85 },
          hit2xIn1h: true,
          hit4xIn1h: true,
          simReturnPct: 500,
        },
      ],
    });
    // The safety screen's verdicts: the first dog failed then cleared it (accepted), the second
    // cleared it (accepted), the AI coin never did (rejected), and the last was never scanned.
    const snap = { priceUsd: 1, marketCapUsd: 50_000 };
    await prisma.tokenSnapshot.createMany({
      data: [
        { ...snap, tokenId: tokens[0]!.id, takenAt: AT, rugScreenPassed: false },
        { ...snap, tokenId: tokens[0]!.id, takenAt: new Date(AT.getTime() + 60_000), rugScreenPassed: true },
        { ...snap, tokenId: tokens[1]!.id, takenAt: AT, rugScreenPassed: true },
        { ...snap, tokenId: tokens[2]!.id, takenAt: AT, rugScreenPassed: false },
        { ...snap, tokenId: tokens[2]!.id, takenAt: new Date(AT.getTime() + 60_000), rugScreenPassed: false },
      ],
    });
    const base = { source: TAG, confidence: 80, anchorPriceUsd: 1, anchorMcapUsd: 50_000, createdAt: AT };
    await prisma.curatedAlert.createMany({
      data: [
        { ...base, tokenId: tokens[0]!.id, hit2xIn1h: true, hit4xIn1h: false, simReturnPct: 40 },
        { ...base, tokenId: tokens[1]!.id, hit2xIn1h: false, hit4xIn1h: false, simReturnPct: -50 },
        { ...base, tokenId: tokens[3]!.id },
        // A 2x reached after the stop is graded, and a loss.
        {
          ...base,
          tokenId: tokens[2]!.id,
          hit2xIn1h: true,
          disqualified: true,
          hit4xIn1h: false,
          simReturnPct: -40,
        },
      ],
    });
  });

  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  it("sums the hour the way the Lighthouse counts, and writes quiet hours as zeros", async () => {
    const meta = await runLighthouseRollupJob({ from: DAY, now: new Date(DAY.getTime() + 13 * HOUR_MS) });
    expect(meta).toMatchObject({ hoursWritten: 14, daysWritten: 1 });

    const hour = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: HOUR } });
    expect(hour).toMatchObject({
      screenedCalls: 4,
      screenedGraded: 3,
      screenedWon2x: 1,
      screenedWon4x: 1,
      screenedWon10x: 0,
      screenedTenXGraded: 3,
      screenedReturnN: 3,
      screenedReturnSum: 80,
      readsTotal: 4,
      readsDescribed: 3,
      readsDeep: 1,
      readsFailed: 1,
      referentConfidenceN: 2,
      xFitN: 1,
      xFitSum: 0.6,
      copiesRecent: 1,
      copiesAnswered: 2,
      trendMatched: 1,
      trendAnswered: 1,
      alerts: 4,
      alertsDescribed: 3,
      alertsGraded: 3,
      // 10x is settled on two calls: the stopped-out loss and the disqualified 2x. The clean
      // 2x still has its 10x window open.
      alertsTenXGraded: 2,
      alertsWon2x: 1,
      alertsWon4x: 0,
      alertsReturnN: 3,
      alertsReturnSum: -50,
      screenAccepted: 2,
      screenRejected: 1,
    });
    expect(hour.referentConfidenceSum).toBeCloseTo(1.2);

    const quiet = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: DAY } });
    expect(quiet).toMatchObject({ screenedCalls: 0, readsTotal: 0, alerts: 0, screenAccepted: 0 });
  });

  it("keeps each day's label breakdowns with the calls on those coins", async () => {
    const rows = await prisma.lighthouseDayLabel.findMany({ where: { day: DAY } });
    const find = (dimension: string, label: string) =>
      rows.find((r) => r.dimension === dimension && r.label === label);
    expect(find("category", "rlanimal")).toMatchObject({
      count: 2,
      alerts: 2,
      graded: 2,
      tenXGraded: 1,
      won2x: 1,
    });
    // A malformed confidence still files the coin under its only label.
    expect(find("category", "rltech")).toMatchObject({ count: 1, alerts: 0 });
    // The call on that coin files under "uncategorized" (no usable confidence), graded as a loss:
    // its 2x came after the stop.
    expect(find("category", "uncategorized")).toMatchObject({
      alerts: 1,
      graded: 1,
      tenXGraded: 1,
      won2x: 0,
    });
    expect(find("subcategory", "rlanimal/dog")).toMatchObject({ count: 2, alerts: 2 });
    expect(find("flag", "copycat")).toMatchObject({ count: 1, alerts: 1, won2x: 1 });
    expect(find("referentKind", "animal")?.count).toBe(1);
    expect(find("referentKind", "animal (kind only)")?.count).toBe(1);
    expect(find("referentSupport", "x")?.count).toBe(1);
    expect(find("xVerdict", "about_this_coin")).toMatchObject({ count: 1, alerts: 1 });
    expect(find("copy", "copies a recent coin")).toMatchObject({ count: 1, alerts: 1 });
    expect(find("copy", "original")).toMatchObject({ count: 1, alerts: 1, won2x: 0 });
    expect(find("news", "in the news")?.count).toBe(1);
    // Never a mint, name or summary.
    for (const r of rows) for (const m of MINTS) expect(r.label).not.toContain(m);
  });

  it("lands on the same rows when run again", async () => {
    const before = await prisma.lighthouseDayLabel.count({ where: { day: DAY } });
    await runLighthouseRollupJob({ from: DAY, now: new Date(DAY.getTime() + 13 * HOUR_MS) });
    expect(await prisma.lighthouseDayLabel.count({ where: { day: DAY } })).toBe(before);
    expect(
      await prisma.lighthouseHour.count({
        where: { hour: { gte: DAY, lt: new Date(DAY.getTime() + 14 * HOUR_MS) } },
      }),
    ).toBe(14);
    const hour = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: HOUR } });
    expect(hour.screenedCalls).toBe(4);
  });

  it("keeps an old hour's screen counts when re-summed past the snapshot horizon", async () => {
    // Three days on, the cleanup has taken the untracked rejected token's snapshots: a re-sum
    // asked to start at that hour re-sums everything else but leaves the frozen screen counts alone.
    const ai = await prisma.token.findUniqueOrThrow({ where: { mintAddress: MINT_AI } });
    await prisma.tokenSnapshot.deleteMany({ where: { tokenId: ai.id } });
    await runLighthouseRollupJob({ from: DAY, now: new Date(DAY.getTime() + 72 * HOUR_MS) });
    const hour = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: HOUR } });
    expect(hour).toMatchObject({ screenedCalls: 4, screenAccepted: 2, screenRejected: 1 });
  });

  it("re-sums an hour summed under older rules once, inside the kept horizon only", async () => {
    // Summed before the label-rule filter: an old-rule moment counted among the screened calls.
    const dog = await prisma.token.findUniqueOrThrow({ where: { mintAddress: MINT_DOG } });
    await prisma.candidateOutcome.create({
      data: {
        tokenId: dog.id,
        sampleKind: "event",
        labelRule: REPORTED_LABEL_RULE - 1,
        anchorAt: AT,
        anchorPriceUsd: 1,
        anchorMcapUsd: 50_000,
        features: {},
        nextCheckAt: AT,
        peak1hPriceUsd: 1,
        low1hPriceUsd: 1,
        lowBefore2xPriceUsd: 1,
        peak24hPriceUsd: 1,
        hit2xIn1h: true,
      },
    });
    await prisma.lighthouseHour.update({
      where: { hour: HOUR },
      data: { screenedCalls: 5, readsTotal: 40, rollupVersion: 0 },
    });
    // The day's first hour is past the kept horizon here (a 2-day retention two days on): its
    // decision moments may be partly swept, so it is never re-summed.
    await prisma.lighthouseHour.update({
      where: { hour: DAY },
      data: { screenedCalls: 7, rollupVersion: 0 },
    });

    const run = () =>
      runLighthouseRollupJob({
        from: new Date(DAY.getTime() + 24 * HOUR_MS),
        now: new Date(DAY.getTime() + 48 * HOUR_MS),
        outcomeRetentionDays: 2,
      });
    const meta = await run();
    expect(meta).toMatchObject({ catchUp: { hours: 1 } });

    const hour = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: HOUR } });
    // Only the screened counts are re-summed; the old-rule moment stays out, and the reads stay frozen.
    expect(hour).toMatchObject({
      screenedCalls: 4,
      screenedGraded: 3,
      readsTotal: 40,
      rollupVersion: LIGHTHOUSE_ROLLUP_VERSION,
    });
    const past = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: DAY } });
    expect(past).toMatchObject({ screenedCalls: 7, rollupVersion: 0 });

    // Once: the next run finds nothing left to catch up.
    expect(await run()).not.toHaveProperty("catchUp");
  });
});

/**
 * The scan volume (the Live tab's market bar): each token's last snapshot in an hour, its trailing
 * hour's volume scaled to the part inside the hour and never before the token existed.
 */
describe.skipIf(!dbAvailable)("lighthouse rollup scan volume", () => {
  const VOL_DAY = new Date(DAY.getTime() + 3 * 24 * HOUR_MS);
  const at = (h: number, m = 0) => new Date(VOL_DAY.getTime() + h * HOUR_MS + m * 60_000);
  const VOL_MINTS = [
    "RollVol11111111111111111111111111111111111111",
    "RollVol21111111111111111111111111111111111111",
    "RollVol31111111111111111111111111111111111111",
  ];

  const clean = async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { in: VOL_MINTS } } });
    // The re-sum run below starts from the trailing hours behind the newest one, so back to DAY.
    await prisma.lighthouseHour.deleteMany({ where: { hour: { gte: DAY, lt: at(24) } } });
  };

  beforeAll(async () => {
    await clean();
    // Launched at 11:30 and followed into hour 12; first scanned at 09:00 and last read at 11:10;
    // never seen live (no market), so never counted whatever its snapshots say.
    const [young, old, dead] = await Promise.all([
      prisma.token.create({
        data: { mintAddress: VOL_MINTS[0]!, firstSeenAt: at(11, 30), lastLiveAt: at(13) },
      }),
      prisma.token.create({
        data: { mintAddress: VOL_MINTS[1]!, firstSeenAt: at(9), lastLiveAt: at(11, 10) },
      }),
      prisma.token.create({ data: { mintAddress: VOL_MINTS[2]!, firstSeenAt: at(11) } }),
    ]);
    const snap = { priceUsd: 1, marketCapUsd: 50_000 };
    await prisma.tokenSnapshot.createMany({
      data: [
        { ...snap, tokenId: young.id, takenAt: at(11, 40), volume1hUsd: 500 },
        // The hour's last reading, 20 minutes after launch: all of it inside hour 11.
        { ...snap, tokenId: young.id, takenAt: at(11, 50), volume1hUsd: 1_200 },
        // 12:55: its trailing hour reaches back to 11:55, so 55 of its 60 minutes are hour 12's.
        { ...snap, tokenId: young.id, takenAt: at(12, 55), volume1hUsd: 600 },
        { ...snap, tokenId: old.id, takenAt: at(10, 30), volume1hUsd: 3_000 },
        // 11:10: only its last 10 minutes are hour 11's; the rest was hour 10's own reading.
        { ...snap, tokenId: old.id, takenAt: at(11, 10), volume1hUsd: 900 },
        { ...snap, tokenId: dead.id, takenAt: at(11, 20), volume1hUsd: 10_000 },
      ],
    });
  });

  afterAll(async () => {
    if (dbAvailable) await clean();
  });

  it("sums each hour's last reading per token, scaled to the hour", async () => {
    await runLighthouseRollupJob({ from: at(10), now: at(14, 5) });
    const rows = await prisma.lighthouseHour.findMany({
      where: { hour: { gte: at(10), lt: at(15) } },
      orderBy: { hour: "asc" },
      select: { hour: true, scanVolumeUsd: true, scanVolumeTokens: true },
    });
    const by = new Map(rows.map((r) => [r.hour.getTime(), r]));
    // 10:30: half of its trailing hour (09:30-10:30) is hour 10's.
    expect(by.get(at(10).getTime())).toMatchObject({ scanVolumeUsd: 1_500, scanVolumeTokens: 1 });
    expect(by.get(at(11).getTime())!.scanVolumeUsd).toBeCloseTo(1_200 + 150, 6);
    expect(by.get(at(11).getTime())!.scanVolumeTokens).toBe(2);
    expect(by.get(at(12).getTime())!.scanVolumeUsd).toBeCloseTo(550, 6);
    // Summed and quiet: zero, not null.
    expect(by.get(at(13).getTime())).toMatchObject({ scanVolumeUsd: 0, scanVolumeTokens: 0 });
  });

  it("leaves an hour's volume alone once it is past the re-sum window", async () => {
    await prisma.lighthouseHour.update({ where: { hour: at(10) }, data: { scanVolumeUsd: 42 } });
    // Some hour carries a volume, so a run re-sums only the trailing VOLUME_RECOMPUTE_HOURS.
    await runLighthouseRollupJob({ now: at(14, 5) });
    const hour = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: at(10) } });
    expect(hour.scanVolumeUsd).toBe(42);
  });
});
