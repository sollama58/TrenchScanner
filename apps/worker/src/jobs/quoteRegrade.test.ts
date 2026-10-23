// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, type MinuteCandle } from "@trenchscanner/core";
import { resetQuoteRegrade, runQuoteRegrade } from "./quoteRegrade.js";
import { CandlesUnavailableError, PUMP_PAUSED_NO_KEY } from "./minuteCandleReader.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `quote-regrade-test-${Date.now()}`;
const MIN = 60_000;
const ANCHOR = Date.parse("2026-10-10T12:00:00Z");
const NOW = ANCHOR + 30 * 3_600_000;

const path = (fromMinute: number, prices: number[]): MinuteCandle[] =>
  prices.map((close, i) => ({ startMs: ANCHOR + (fromMinute + i) * MIN, close }));

/** A row graded a miss: the watcher read the coin as $0, so it never saw the run. */
async function seed(label: string, extra: { labelRule?: number } = {}) {
  const token = await prisma.token.create({ data: { mintAddress: `${TAG}-${label}`, symbol: "T" } });
  const row = await prisma.candidateOutcome.create({
    data: {
      tokenId: token.id,
      anchorAt: new Date(ANCHOR),
      anchorPriceUsd: 1,
      anchorMcapUsd: 1_000_000_000,
      features: { mcapUsd: 1_000_000_000, freshGapPct: null },
      sampleKind: "hourly",
      labelRule: extra.labelRule ?? 4,
      entryAt: new Date(ANCHOR + MIN),
      signalPriceUsd: 1,
      nextCheckAt: new Date(NOW),
      peak1hPriceUsd: 1.2,
      low1hPriceUsd: 0.9,
      lowBefore2xPriceUsd: 0.9,
      peak24hPriceUsd: 1.2,
      finalizedAt: new Date(ANCHOR + 60 * MIN),
      finalized24hAt: new Date(ANCHOR + 24 * 3_600_000),
      hit2xIn1h: false,
      disqualified: false,
      labelValue: 0,
    },
  });
  return { token, row };
}

// The coin ran from 1 to 2.5 in the minutes after the decision.
const RAN = path(-3, [1, 1, 1, 1.3, 1.6, 2, 2.5, ...Array(40).fill(2.2)]);

describe.skipIf(!dbAvailable)("quote re-grade", () => {
  beforeEach(() => resetQuoteRegrade());
  afterAll(async () => {
    if (!dbAvailable) return;
    const tokens = await prisma.token.findMany({
      where: { mintAddress: { startsWith: TAG } },
      select: { id: true },
    });
    const rows = await prisma.candidateOutcome.findMany({
      where: { tokenId: { in: tokens.map((t) => t.id) } },
      select: { id: true },
    });
    await prisma.quoteRegrade.deleteMany({ where: { outcomeId: { in: rows.map((r) => r.id) } } });
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("re-grades a listed coin's rows from its candles once, keeping what they had", async () => {
    const { token, row } = await seed("ran");
    const other = await seed("not-listed");
    const stub = { minuteCandles: async () => RAN };
    const counts = await runQuoteRegrade(stub, { spacingMs: 0, now: () => NOW, mints: [token.mintAddress] });
    expect(counts).toMatchObject({ coins: 1, regraded: 1, wins: 1, winsBefore: 0 });

    const after = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.hit2xIn1h).toBe(true);
    expect(after.labelRule).toBe(4);
    // Born rule 4: no rule-3 grade is made up for it, and its features are left alone.
    expect(after.rule3Grade).toBeNull();
    expect(after.features).toEqual({ mcapUsd: 1_000_000_000, freshGapPct: null });
    const record = await prisma.quoteRegrade.findUniqueOrThrow({ where: { outcomeId: row.id } });
    expect(record.result).toBe("regraded");
    expect(record.previous).toMatchObject({ hit2xIn1h: false, labelRule: 4, peak1hPriceUsd: 1.2 });

    // A coin off the list is untouched.
    const untouched = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: other.row.id } });
    expect(untouched.hit2xIn1h).toBe(false);

    // Done once: the next run finds nothing left and stops asking.
    let asked = 0;
    const counting = { minuteCandles: async () => (asked++, RAN) };
    expect(
      await runQuoteRegrade(counting, { spacingMs: 0, now: () => NOW, mints: [token.mintAddress] }),
    ).toBeNull();
    expect(
      await runQuoteRegrade(counting, { spacingMs: 0, now: () => NOW, mints: [token.mintAddress] }),
    ).toBeNull();
    expect(asked).toBe(0);
  });

  it("keeps a rule-3 row's old grade as rule3Grade, as the history re-grade does", async () => {
    const { token, row } = await seed("rule3", { labelRule: 3 });
    await runQuoteRegrade(
      { minuteCandles: async () => RAN },
      { spacingMs: 0, now: () => NOW, mints: [token.mintAddress] },
    );
    const after = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.labelRule).toBe(4);
    expect(after.rule3Grade).toMatchObject({ hit2xIn1h: false, peak1hPriceUsd: 1.2 });
    expect((after.features as Record<string, unknown>).freshGapPct).toBe(0);
  });

  it("leaves a row the candles can't vouch for as it was, marked done", async () => {
    const { token, row } = await seed("no-candles");
    await runQuoteRegrade(
      { minuteCandles: async () => [] },
      { spacingMs: 0, now: () => NOW, mints: [token.mintAddress] },
    );
    const after = await prisma.candidateOutcome.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.hit2xIn1h).toBe(false);
    expect((await prisma.quoteRegrade.findUniqueOrThrow({ where: { outcomeId: row.id } })).result).toBe(
      "no-candles",
    );
  });

  it("backs off a coin no source can answer, and marks it no-candles once its row is a week old", async () => {
    const { token, row } = await seed("unavailable");
    let asked = 0;
    const stub = {
      minuteCandles: async (mint: string): Promise<MinuteCandle[]> => {
        asked += 1;
        throw new CandlesUnavailableError(mint, "GeckoTerminal knows none of the coin's pools");
      },
    };
    const run = (at: number) =>
      runQuoteRegrade(stub, { spacingMs: 0, now: () => at, mints: [token.mintAddress] });
    expect(await run(NOW)).toMatchObject({ coins: 0, unavailable: 1 });
    expect(await prisma.quoteRegrade.findUnique({ where: { outcomeId: row.id } })).toBeNull();
    // Backed off: not asked, and not finished either.
    expect(await run(NOW + 5 * MIN)).toMatchObject({ backedOff: 1, unavailable: 0 });
    expect(asked).toBe(1);
    await run(ANCHOR + 8 * 86_400_000);
    expect(asked).toBe(2);
    expect((await prisma.quoteRegrade.findUniqueOrThrow({ where: { outcomeId: row.id } })).result).toBe(
      "no-candles",
    );
  });

  it("stops the run once a few coins in a row find Pump.fun paused with no CoinGecko key", async () => {
    const seeded = await Promise.all([1, 2, 3, 4].map((n) => seed(`paused-${n}`)));
    let calls = 0;
    await runQuoteRegrade(
      {
        minuteCandles: async (mint) => {
          calls += 1;
          throw new CandlesUnavailableError(mint, PUMP_PAUSED_NO_KEY);
        },
      },
      { spacingMs: 0, now: () => NOW, mints: seeded.map((s) => s.token.mintAddress) },
    );
    expect(calls).toBe(3);
  });
});
