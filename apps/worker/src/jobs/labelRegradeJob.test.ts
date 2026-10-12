// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError, prisma, type MinuteCandle } from "@trenchscanner/core";
import { resetRegradeCursor, runLabelRegradeJob } from "./labelRegradeJob.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `label-regrade-test-${Date.now()}`;
const MIN = 60_000;
// Far enough back that the job's own pending rows from other runs don't matter: every row the
// test seeds sits on one token the stub answers for, and the rest of the table is left alone.
const ANCHOR = Date.parse("2026-10-06T12:00:00Z");
const NOW = ANCHOR + 30 * 3_600_000;

const path = (fromMinute: number, prices: number[]): MinuteCandle[] =>
  prices.map((close, i) => ({ startMs: ANCHOR + (fromMinute + i) * MIN, close }));

async function seed(label: string, extra: { labelRule?: number; sampleKind?: string } = {}) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${label}`, symbol: "T" } });
  const row = await prisma.candidateOutcome.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(ANCHOR),
      anchorPriceUsd: 1,
      anchorMcapUsd: 1_000_000_000,
      features: { mcapUsd: 1_000_000_000 },
      sampleKind: extra.sampleKind ?? "event",
      labelRule: extra.labelRule ?? 3,
      entryAt: new Date(ANCHOR + MIN),
      signalPriceUsd: 1,
      nextCheckAt: new Date(NOW),
      peak1hPriceUsd: 2.5,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      hit2xAt: new Date(ANCHOR + 3 * MIN),
      peak24hPriceUsd: 2.5,
      finalizedAt: new Date(ANCHOR + 30 * MIN),
      finalized24hAt: new Date(ANCHOR + 24 * 3_600_000),
      hit2xIn1h: true,
      disqualified: false,
      labelValue: 1.3,
    },
  });
  return { token, row };
}

describe.skipIf(!dbAvailable)("label regrade job", () => {
  beforeEach(() => resetRegradeCursor());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("re-grades a rule-3 row from the last trade before the decision and keeps the old grade", async () => {
    const { token, row } = await seed("ran");
    // DexScreener showed 1; the coin had already traded at 1.6 and topped out at 2.5.
    const candles = path(-3, [1, 1.3, 1.6, 2, 2.5, ...Array(40).fill(1.5)]);
    const meta = await runLabelRegradeJob(
      { minuteCandles: async (mint) => (mint === token.mintAddress ? candles : []) },
      { spacingMs: 0, now: () => NOW, coinsPerRun: 1000 },
    );
    expect(meta.regraded).toBeGreaterThanOrEqual(1);
    const after = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.labelRule).toBe(4);
    expect(after.anchorPriceUsd).toBe(1.6);
    expect(after.anchorMcapUsd).toBeCloseTo(1_600_000_000);
    expect(after.hit2xIn1h).toBe(false);
    expect(after.regradedAt).not.toBeNull();
    expect((after.features as Record<string, number>).freshGapPct).toBeCloseTo(60);
    expect((after.features as Record<string, number>).mcapUsd).toBe(1_000_000_000);
    expect(after.rule3Grade).toMatchObject({ anchorPriceUsd: 1, hit2xIn1h: true, labelValue: 1.3 });
  });

  it("stamps a row the candles can't vouch for and leaves its grade, and skips other rules and kinds", async () => {
    const { token, row } = await seed("uncovered");
    const other = await seed("rule4", { labelRule: 4 });
    const match = await seed("match", { sampleKind: "match" });
    await runLabelRegradeJob(
      {
        minuteCandles: async (mint) =>
          mint === token.mintAddress
            ? path(5, [1, 1]).concat(Array(998).fill({ startMs: NOW, close: 1 }))
            : [],
      },
      { spacingMs: 0, now: () => NOW, coinsPerRun: 1000 },
    );
    const after = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.labelRule).toBe(3);
    expect(after.regradedAt).not.toBeNull();
    expect(after.rule3Grade).toBeNull();
    expect(after.hit2xIn1h).toBe(true);
    for (const id of [other.row.id, match.row.id]) {
      expect((await prisma.candidateOutcome.findUniqueOrThrow({ where: { id } })).regradedAt).toBeNull();
    }
  });

  it("leaves a row a curated alert points at, and puts back the old grade on one already re-graded", async () => {
    const { token, row } = await seed("alerted");
    const alertOn = (candidateOutcomeId: string, tokenId: string) =>
      prisma.curatedAlert.create({
        data: {
          tokenId,
          candidateOutcomeId,
          source: "heuristic-v1",
          confidence: 80,
          anchorPriceUsd: 1,
          anchorMcapUsd: 1e9,
        },
      });
    await alertOn(row.id, token.id);
    const candles = path(-3, [1, 1.3, 1.6, 2, 2.5, ...Array(40).fill(1.5)]);
    await runLabelRegradeJob(
      { minuteCandles: async (mint) => (mint === token.mintAddress ? candles : []) },
      { spacingMs: 0, now: () => NOW, coinsPerRun: 1000 },
    );
    expect(await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      labelRule: 3,
      regradedAt: null,
      anchorPriceUsd: 1,
    });

    // Re-graded before alerts were left alone: restored from rule3Grade on the next run.
    const late = await seed("alerted-late");
    await runLabelRegradeJob(
      { minuteCandles: async (mint) => (mint === late.token.mintAddress ? candles : []) },
      { spacingMs: 0, now: () => NOW, coinsPerRun: 1000 },
    );
    expect((await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: late.row.id } })).labelRule).toBe(
      4,
    );
    await alertOn(late.row.id, late.token.id);
    const meta = await runLabelRegradeJob(
      { minuteCandles: async () => [] },
      { spacingMs: 0, now: () => NOW },
    );
    expect(meta.restored).toBeGreaterThanOrEqual(1);
    const back = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: late.row.id } });
    expect(back).toMatchObject({
      labelRule: 3,
      anchorPriceUsd: 1,
      hit2xIn1h: true,
      labelValue: 1.3,
      rule3Grade: null,
    });
    expect(back.hit2xAt?.getTime()).toBe(ANCHOR + 3 * 60_000);
    expect((back.features as Record<string, unknown>).freshGapPct).toBeUndefined();
  });

  it("stops at Pump.fun's first 429 and leaves the coin for a later run", async () => {
    const { row } = await seed("throttled");
    const meta = await runLabelRegradeJob(
      {
        minuteCandles: async () => {
          throw new HttpError(429, "too many");
        },
      },
      { spacingMs: 0, now: () => NOW, coinsPerRun: 1000 },
    );
    expect(meta.throttled).toBe(true);
    expect(
      (await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } })).regradedAt,
    ).toBeNull();
  });
});
