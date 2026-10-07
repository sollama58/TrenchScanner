import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { runLighthouseRollupJob } from "./lighthouseRollupJob.js";

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
    where: { hour: { gte: DAY, lt: new Date(DAY.getTime() + 2 * 24 * HOUR_MS) } },
  });
  await prisma.lighthouseDayLabel.deleteMany({
    where: { day: { gte: DAY, lt: new Date(DAY.getTime() + 2 * 24 * HOUR_MS) } },
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
    });
    expect(hour.referentConfidenceSum).toBeCloseTo(1.2);

    const quiet = await prisma.lighthouseHour.findUniqueOrThrow({ where: { hour: DAY } });
    expect(quiet).toMatchObject({ screenedCalls: 0, readsTotal: 0, alerts: 0 });
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
});
