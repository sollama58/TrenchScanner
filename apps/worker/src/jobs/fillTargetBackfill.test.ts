// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  chunkBars,
  FILL_NET_FACTOR,
  prisma,
  saveCandleChunks,
  type CandleRes,
  type StoredBar,
} from "@trenchscanner/core";
import { resetFillTargetBackfill, runFillTargetBackfill } from "./fillTargetBackfill.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `fill-backfill-test-${Date.now()}`;
const MINUTE = 60_000;
// On the minute, an hour ago: bars sit on their grids.
const ANCHOR = Math.floor((Date.now() - 60 * MINUTE) / MINUTE) * MINUTE;
const NOW = ANCHOR + 60 * MINUTE;
/** A bar whose close is `price` dollars a token (bars are market cap on a billion tokens). */
const bar = (t: number, price: number): StoredBar => {
  const c = price * 1e9;
  return { t, o: c, h: c, l: c, c, vol: 1 };
};

async function seed(suffix: string, bars: { res: CandleRes; list: StoredBar[] }[], extra: object = {}) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${suffix}` } });
  for (const { res, list } of bars) {
    await saveCandleChunks(
      chunkBars(token.mintAddress, res, res === 1 ? "curve" : "pumpfun", list, {
        from: ANCHOR - MINUTE,
        to: ANCHOR + 31 * MINUTE,
      }),
    );
  }
  const row = await prisma.candidateOutcome.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(ANCHOR),
      anchorPriceUsd: 1,
      anchorMcapUsd: 100_000,
      features: {},
      score: 50,
      nextCheckAt: new Date(NOW),
      peak1hPriceUsd: 1,
      low1hPriceUsd: 1,
      lowBefore2xPriceUsd: 1,
      peak24hPriceUsd: 1,
      finalizedAt: new Date(ANCHOR + 30 * MINUTE),
      hit2xIn1h: false,
      disqualified: false,
      labelValue: 0,
      ...extra,
    },
  });
  return { token, row };
}

const run = () => runFillTargetBackfill({ now: () => NOW, fineRetentionDays: 30, rowsPerRun: 500 });

describe.skipIf(!dbAvailable)("fill-target backfill", () => {
  beforeEach(() => resetFillTargetBackfill());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.candleChunk.deleteMany({ where: { mint: { startsWith: TAG } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("grades a finalized row from the coin's 1-second bars and copies the verdict to its alert", async () => {
    // 1.0 through the fill, then 2.5 from the second minute: 2x the 1.01 fill.
    const { token, row } = await seed("fine", [
      { res: 1, list: [bar(ANCHOR - 2_000, 1), bar(ANCHOR + 17_000, 1), bar(ANCHOR + 90_000, 2.5)] },
    ]);
    const alert = await prisma.curatedAlert.create({
      data: {
        tokenId: token.id,
        candidateOutcomeId: row.id,
        source: "heuristic-v1",
        confidence: 80,
        anchorPriceUsd: 1,
        anchorMcapUsd: 100_000,
      },
    });

    await run();

    const graded = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(graded.fillSource).toBe("bars-1s");
    expect(graded.fillPriceUsd).toBeCloseTo(1.01);
    expect(graded.fillAt).toEqual(new Date(ANCHOR + 18_000));
    expect(graded.fillHit2xAt).not.toBeNull();
    expect(graded.fillWin).toBe(true);
    expect(graded.fillReturnPct).toBeCloseTo((2 * FILL_NET_FACTOR - 1) * 100);
    // The labels the models learn are not touched.
    expect(graded.hit2xIn1h).toBe(false);
    expect(graded.labelValue).toBe(0);
    const copied = await prisma.curatedAlert.findUniqueOrThrow({ where: { id: alert.id } });
    expect(copied).toMatchObject({ fillWin: true, fillSource: "bars-1s" });
    expect(copied.fillReturnPct).toBeCloseTo(graded.fillReturnPct!);
  });

  it("falls back to minute bars, marks a row with no candles, and leaves live grades and open rows alone", async () => {
    // Minute bars alone: filled at the first bar's end, stopped by the second.
    const minute = await seed("minute", [{ res: 60, list: [bar(ANCHOR, 1), bar(ANCHOR + MINUTE, 0.5)] }]);
    const bare = await seed("bare", []);
    const live = await seed("live", [{ res: 60, list: [bar(ANCHOR, 1), bar(ANCHOR + MINUTE, 5)] }], {
      fillSource: "tape",
      fillPriceUsd: 1.01,
      fillWin: false,
      fillReturnPct: -30,
    });
    const open = await seed("open", [{ res: 60, list: [bar(ANCHOR, 1), bar(ANCHOR + MINUTE, 5)] }], {
      finalizedAt: null,
      hit2xIn1h: null,
      disqualified: null,
      labelValue: null,
    });

    await run();

    const of = (id: string) => prisma.candidateOutcome.findUniqueOrThrow({ where: { id } });
    const m = await of(minute.row.id);
    expect(m.fillSource).toBe("bars-1m");
    expect(m.fillWin).toBe(false);
    expect(m.fillStoppedAt).toEqual(new Date(ANCHOR + 2 * MINUTE));
    expect(m.fillReturnPct).toBeCloseTo(((0.5 / 1.01) * FILL_NET_FACTOR - 1) * 100);
    expect(await of(bare.row.id)).toMatchObject({ fillSource: "none", fillWin: null, fillPriceUsd: null });
    expect(await of(live.row.id)).toMatchObject({ fillSource: "tape", fillWin: false, fillReturnPct: -30 });
    expect(await of(open.row.id)).toMatchObject({ fillSource: null, fillWin: null });
  });

  it("stops asking once it is through", async () => {
    // Every earlier row in the window is graded or marked by now; the pass ends on an empty batch.
    let runs = 0;
    while ((await run()) !== null && runs < 50) runs += 1;
    expect(await run()).toBeNull();
    const left = await prisma.candidateOutcome.count({
      where: { token: { mintAddress: { startsWith: TAG } }, finalizedAt: { not: null }, fillSource: null },
    });
    expect(left).toBe(0);
  });
});
