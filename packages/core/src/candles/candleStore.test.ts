import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../db.js";
import { chunkBars, type CandleChunkRow, type StoredBar } from "./candleChunk.js";
import {
  BACKFILL_REDO_AFTER_MS,
  BACKFILL_TOP_UP_AFTER_MS,
  minuteCoversBefore,
  oldestCandleCover,
  pruneCandleStore,
  queueBackfillsForRecentCalls,
  readCandleChunks,
  requestCandleBackfill,
  saveCandleChunks,
} from "./candleStore.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `candles-test-${Date.now()}`;
const KEPT = `${TAG}-kept`;
const GONE = `${TAG}-gone`;
const DAY = 86_400_000;
const M = 60_000;
const NOW = Date.UTC(2026, 9, 22, 12);

const bar = (t: number, c: number): StoredBar => ({ t, o: c, h: c, l: c, c, vol: 1 });
const minutes = (from: number, n: number) => Array.from({ length: n }, (_, i) => bar(from + i * M, i + 1));

describe.skipIf(!dbAvailable)("candle store", () => {
  const clean = async () => {
    await prisma.candleChunk.deleteMany({ where: { mint: { startsWith: TAG } } });
    await prisma.candleBackfill.deleteMany({ where: { mint: { startsWith: TAG } } });
  };
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { walletAddress: { startsWith: TAG } } });
  });

  it("saves chunks, reads them back decoded, and never thins a chunk with a partial reading", async () => {
    const hour = Math.floor(NOW / 3_600_000) * 3_600_000 - 3_600_000;
    const full = chunkBars(KEPT, 60, "pumpfun", minutes(hour, 60), { from: hour, to: hour + 3_600_000 });
    await saveCandleChunks(full);
    // A later page reaching only the chunk's last 10 minutes.
    const part = chunkBars(KEPT, 60, "pumpfun", minutes(hour + 50 * M, 10), {
      from: hour + 50 * M,
      to: hour + 3_600_000,
    });
    await saveCandleChunks(part);
    const [row] = await readCandleChunks(KEPT, hour, hour + 3_600_000);
    expect(row!.bars).toHaveLength(60);
    expect(row!.coverFrom).toBe(hour);
    expect(await oldestCandleCover(KEPT)).toBe(hour);
    expect(await minuteCoversBefore(KEPT, hour + 3_600_000)).toEqual([{ from: hour, to: hour + 3_600_000 }]);
  });

  it("saves several coins' chunks in one batch, each coin locked once", async () => {
    const hour = Math.floor(NOW / 3_600_000) * 3_600_000 - 3_600_000;
    const rows = [GONE, KEPT, `${TAG}-third`].flatMap((mint) => [
      ...chunkBars(mint, 60, "gecko", minutes(hour, 60), { from: hour, to: hour + 3_600_000 }),
      ...chunkBars(mint, 1, "curve", [bar(hour, 5)], { from: hour, to: hour + 60_000 }),
    ]);
    expect(await saveCandleChunks(rows)).toBe(6);
    for (const mint of [GONE, KEPT, `${TAG}-third`])
      expect(
        (await readCandleChunks(mint, hour, hour + 3_600_000)).map((r) => r.res).sort((a, b) => a - b),
      ).toEqual([1, 60]);
  });

  it("merges two pages of the same chunk: both halves' bars stay and their covers join", async () => {
    const hour = Math.floor(NOW / 3_600_000) * 3_600_000 - 3_600_000;
    // A backfill's two GeckoTerminal pages each hold half the hour (user report 2026-10-23: the
    // second page, no fuller than the first, used to be dropped whole, a 3-minute run with it).
    const late = chunkBars(KEPT, 60, "gecko", minutes(hour + 30 * M, 30), {
      from: hour + 30 * M,
      to: hour + 60 * M,
    });
    const early = chunkBars(KEPT, 60, "gecko", minutes(hour, 30), { from: hour, to: hour + 30 * M });
    await saveCandleChunks(late);
    await saveCandleChunks(early);
    const [row] = await readCandleChunks(KEPT, hour, hour + 3_600_000);
    expect(row!.bars).toHaveLength(60);
    expect([row!.coverFrom, row!.coverTo]).toEqual([hour, hour + 60 * M]);
    // Two pages of one chunk in one save merge too.
    await prisma.candleChunk.deleteMany({ where: { mint: KEPT } });
    await saveCandleChunks([...late, ...early]);
    const [again] = await readCandleChunks(KEPT, hour, hour + 3_600_000);
    expect(again!.bars).toHaveLength(60);
    expect([again!.coverFrom, again!.coverTo]).toEqual([hour, hour + 60 * M]);
  });

  it("keeps a chunk with no bar for the quiet stretch its cover vouches for", async () => {
    const quiet = {
      mint: KEPT,
      res: 1 as const,
      startAt: NOW - 10 * M,
      source: "tape" as const,
      coarse: false,
    };
    await saveCandleChunks([{ ...quiet, coverFrom: NOW - 10 * M, coverTo: NOW - 5 * M, bars: [] }]);
    const [row] = await readCandleChunks(KEPT, NOW - 10 * M, NOW);
    expect(row).toMatchObject({ coverFrom: NOW - 10 * M, coverTo: NOW - 5 * M, bars: [] });
    // A later bar in the same chunk (its minute) joins it, the cover kept.
    const at = NOW - 10 * M + 30_000;
    await saveCandleChunks([{ ...quiet, coverFrom: at, coverTo: at + 1_000, bars: [bar(at, 2)] }]);
    const [again] = await readCandleChunks(KEPT, NOW - 10 * M, NOW);
    expect(again).toMatchObject({ coverFrom: NOW - 10 * M, coverTo: NOW - 5 * M });
    expect(again!.bars.map((b) => b.t)).toEqual([at]);
    // Neither a bar nor a cover: nothing to keep.
    await saveCandleChunks([
      { ...quiet, startAt: NOW - 3 * M, coverFrom: NOW - 3 * M, coverTo: NOW - 3 * M, bars: [] },
    ]);
    expect(await readCandleChunks(KEPT, NOW - 3 * M, NOW)).toEqual([]);
  });

  it("finds a minute chunk whose cover runs on from far back over the window, not a 1-second one", async () => {
    const far = NOW - 8 * 3_600_000;
    // A quiet night: the last minute bar's chunk vouches for the hours after it.
    await saveCandleChunks([
      {
        mint: KEPT,
        res: 60,
        startAt: far,
        source: "gecko",
        coverFrom: far,
        coverTo: NOW,
        coarse: false,
        bars: [bar(far, 1)],
      },
      {
        mint: KEPT,
        res: 1,
        startAt: far,
        source: "tape",
        coverFrom: far,
        coverTo: NOW,
        coarse: false,
        bars: [bar(far, 1)],
      },
    ]);
    const rows = await readCandleChunks(KEPT, NOW - 3_600_000, NOW);
    expect(rows.map((r) => [r.res, r.coverTo])).toEqual([[60, NOW]]);
    // Asked for one width, that width alone.
    expect((await readCandleChunks(KEPT, NOW - 3_600_000, NOW, { res: 60 })).map((r) => r.res)).toEqual([60]);
    expect(await readCandleChunks(KEPT, NOW - 3_600_000, NOW, { res: 1 })).toEqual([]);
  });

  // User report 2026-10-24: a coin a filter put on the Live Feed had no history until opened.
  it("sweeps a coin matched lately that has no backfill row yet into the queue", async () => {
    const mint = `${TAG}-matched`;
    const token = await prisma.token.create({ data: { mintAddress: mint } });
    const user = await prisma.user.create({ data: { walletAddress: `${TAG}-user` } });
    const filter = await prisma.userFilter.create({ data: { userId: user.id, name: "f" } });
    const snapshot = await prisma.tokenSnapshot.create({
      data: { tokenId: token.id, priceUsd: 0.00001, marketCapUsd: 10_000 },
    });
    const matchedAt = new Date(Date.now() - 5 * M);
    await prisma.match.create({
      data: {
        userId: user.id,
        filterId: filter.id,
        tokenId: token.id,
        snapshotId: snapshot.id,
        score: 1,
        matchedAt,
      },
    });
    expect(await queueBackfillsForRecentCalls(60 * M)).toBeGreaterThanOrEqual(1);
    const row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint } });
    expect(row.reason).toBe("match");
    expect(row.requestedAt.getTime()).toBe(matchedAt.getTime());
    // Queued once: the next sweep leaves it be.
    await queueBackfillsForRecentCalls(60 * M);
    expect(await prisma.candleBackfill.count({ where: { mint } })).toBe(1);
  });

  it("queues a backfill once, moves a chart's ask ahead on a call, and redoes a long-finished one", async () => {
    await requestCandleBackfill(KEPT, "chart", NOW);
    await requestCandleBackfill(KEPT, "chart", NOW + 1_000);
    let row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: KEPT } });
    expect(row.reason).toBe("chart");
    expect(row.requestedAt.getTime()).toBe(NOW);
    await requestCandleBackfill(KEPT, "call", NOW + 2_000);
    row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: KEPT } });
    expect(row.reason).toBe("call");
    // Finished: asked again soon after, nothing changes; long after, it starts over.
    await prisma.candleBackfill.update({
      where: { mint: KEPT },
      data: { doneAt: new Date(NOW), pages: 7, pumpDone: true, cursor: new Date(NOW - DAY) },
    });
    await requestCandleBackfill(KEPT, "chart", NOW + 60_000);
    row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: KEPT } });
    expect(row.doneAt).not.toBeNull();
    await requestCandleBackfill(KEPT, "chart", NOW + BACKFILL_REDO_AFTER_MS + 1);
    row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: KEPT } });
    expect(row.doneAt).toBeNull();
    expect([row.pages, row.pumpDone, row.cursor]).toEqual([0, false, null]);
  });

  it("tops a finished coin up after BACKFILL_TOP_UP_AFTER_MS when asked to", async () => {
    await requestCandleBackfill(GONE, "chart", NOW);
    await prisma.candleBackfill.update({ where: { mint: GONE }, data: { doneAt: new Date(NOW) } });
    await requestCandleBackfill(GONE, "chart", NOW + 60_000, BACKFILL_TOP_UP_AFTER_MS);
    let row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: GONE } });
    expect(row.doneAt).not.toBeNull();
    await requestCandleBackfill(GONE, "chart", NOW + BACKFILL_TOP_UP_AFTER_MS + 1, BACKFILL_TOP_UP_AFTER_MS);
    row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: GONE } });
    expect(row.doneAt).toBeNull();
  });

  it("prunes fine bars past their days, wider ones past the horizon, and coins gone from Token", async () => {
    await prisma.token.upsert({ where: { mintAddress: KEPT }, update: {}, create: { mintAddress: KEPT } });
    const rows: CandleChunkRow[] = [];
    const add = (mint: string, res: 1 | 60, ageDays: number) => {
      const t = Math.floor((NOW - ageDays * DAY) / (res * 60_000)) * res * 60_000;
      rows.push(
        ...chunkBars(mint, res, res === 1 ? "curve" : "gecko", [bar(t, 1)], { from: t, to: t + res * 1_000 }),
      );
    };
    add(KEPT, 1, 31); // fine, past 30 days: goes
    add(KEPT, 1, 29); // fine, inside: stays
    add(KEPT, 60, 89); // minute, inside 90: stays
    add(KEPT, 60, 91); // minute, past 90: goes
    add(GONE, 60, 2); // its coin is gone from Token: goes
    await saveCandleChunks(rows);
    await prisma.candleBackfill.create({
      data: { mint: GONE, reason: "chart", requestedAt: new Date(NOW - 2 * DAY) },
    });
    const out = await pruneCandleStore({ fineDays: 30, keepDays: 90, rowsPerBatch: 1 }, NOW);
    expect(out.chunks).toBeGreaterThanOrEqual(3);
    const left = await prisma.candleChunk.findMany({
      where: { mint: { startsWith: TAG } },
      select: { mint: true, res: true },
      orderBy: { startAt: "asc" },
    });
    expect(left).toEqual([
      { mint: KEPT, res: 60 },
      { mint: KEPT, res: 1 },
    ]);
    expect(await prisma.candleBackfill.count({ where: { mint: GONE } })).toBe(0);
  });
});
