// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, saveCandleChunks, type ChainTx } from "@trenchscanner/core";
import {
  seedCandleChainFillSpend,
  oneSecondHoles,
  resetCandleChainFill,
  runCandleChainFill,
  type ChainFillDeps,
} from "./candleChainFill.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/** 32 bytes of 8: the swap events name the coin by its key. */
const MINT = "YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// Now-relative, so the test's ask is the newest of any a database holds (a run reads the newest 50).
// Held an hour clear of UTC midnight: the fill forgets its day's state at midnight, so a run at
// NOW + 31 minutes crossing it read the quiet and unpriced coins again, and the tests that check
// they are left alone failed when CI ran between 23:29 and 00:00 UTC (2026-10-27).
const NOW = Math.min(Math.floor(Date.now() / MIN) * MIN, Math.floor(Date.now() / DAY) * DAY + DAY - 60 * MIN);
const LAUNCH = NOW - 3 * 60 * MIN;
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const BUYER = "4WPT9wLwQWYS5zyX36ZgoY3ESxxLgDmE12upKXDAyYbL";

/** A curve buy of the coin at `atMs`, logging virtual reserves of `vSol` lamports over a billion tokens. */
function buy(atMs: number, vSol: number): ChainTx {
  const b = Buffer.alloc(113);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(b, 0);
  Buffer.alloc(32, 8).copy(b, 8);
  b.writeBigUInt64LE(1_000_000_000n, 40);
  b.writeBigUInt64LE(1_000_000n, 48);
  b.writeUInt8(1, 56);
  b.writeBigInt64LE(BigInt(atMs / 1000), 89);
  b.writeBigUInt64LE(BigInt(vSol), 97);
  b.writeBigUInt64LE(1_000_000_000_000_000n, 105);
  return {
    blockTime: atMs / 1000,
    transaction: { signatures: [`sig-${atMs}`], message: { accountKeys: [BUYER, "ata"] } },
    meta: {
      err: null,
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: BUYER, uiTokenAmount: { amount: "1000000" } },
      ],
      preBalances: [10e9, 0],
      postBalances: [9e9, 0],
      logMessages: [
        `Program ${PUMP} invoke [1]`,
        `Program data: ${b.toString("base64")}`,
        `Program ${PUMP} success`,
      ],
    },
  };
}

describe.skipIf(!dbAvailable)("chart chain fill", () => {
  const cleanup = async () => {
    await prisma.candleChunk.deleteMany({ where: { mint: MINT } });
    await prisma.candleBackfill.deleteMany({ where: { mint: MINT } });
    await prisma.token.deleteMany({ where: { mintAddress: MINT } });
  };
  beforeEach(async () => {
    resetCandleChainFill();
    await cleanup();
    await prisma.token.create({ data: { mintAddress: MINT, symbol: "T", launchedAt: new Date(LAUNCH) } });
    await prisma.candleBackfill.create({
      data: { mint: MINT, reason: "call", requestedAt: new Date(NOW) },
    });
    // The curve tape held the coin's first minute only.
    await saveCandleChunks([
      {
        mint: MINT,
        res: 1,
        startAt: LAUNCH,
        source: "curve",
        coverFrom: LAUNCH,
        coverTo: LAUNCH + MIN,
        coarse: false,
        bars: [{ t: LAUNCH, o: 1, h: 1, l: 1, c: 1, vol: 0 }],
      },
    ]);
  });
  afterAll(async () => {
    if (dbAvailable) await cleanup();
  });

  const stub = (pages: ChainTx[][]) => {
    const asked: { from?: number; until?: number }[] = [];
    const helius: ChainFillDeps["helius"] = {
      gtfaUsable: true,
      getMintTransactionsPage: async (_mint, opts) => {
        asked.push({ from: opts?.fromBlockTime, until: opts?.untilBlockTime });
        const txs = pages[asked.length - 1] ?? [];
        return { status: "ok", txs, paginationToken: txs.length >= 2 ? "more" : null };
      },
    };
    return { helius, asked };
  };
  const opts = {
    creditsPerDay: 1_000,
    pagesPerRun: 5,
    maxPagesPerCoin: 30,
    windowMinutes: 120,
    now: () => NOW,
  };

  it("reads the coin's first hole off the chain and saves it, then asks nothing more", async () => {
    expect(await oneSecondHoles(MINT, LAUNCH, LAUNCH + 120 * MIN)).toEqual([
      [LAUNCH + MIN, LAUNCH + 120 * MIN],
    ]);
    const { helius, asked } = stub([[buy(LAUNCH + 5 * MIN, 30e9)]]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    expect(asked).toEqual([{ from: (LAUNCH + MIN) / 1000, until: (LAUNCH + 120 * MIN) / 1000 }]);
    // Saved from its trade on, and the quiet minutes before it vouched for by the curve's chunk.
    expect(await oneSecondHoles(MINT, LAUNCH, LAUNCH + 120 * MIN)).toEqual([]);
    const tape = await prisma.candleChunk.findMany({ where: { mint: MINT, source: "tape" } });
    expect(tape.map((r) => [r.startAt.getTime(), r.bars])).toEqual([[LAUNCH + 5 * MIN, 1]]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    expect(asked).toHaveLength(1);
  });

  it("takes a full page as far as its newest second, and the rest next run", async () => {
    const { helius, asked } = stub([[buy(LAUNCH + 2 * MIN, 30e9), buy(LAUNCH + 3 * MIN, 31e9)], []]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    // One page a coin a run while the hole stays open.
    expect(asked).toHaveLength(1);
    expect(await oneSecondHoles(MINT, LAUNCH, LAUNCH + 120 * MIN)).toEqual([
      [LAUNCH + 3 * MIN, LAUNCH + 120 * MIN],
    ]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    expect(asked[1]).toEqual({ from: (LAUNCH + 3 * MIN) / 1000, until: (LAUNCH + 120 * MIN) / 1000 });
  });

  it("lets the newest ask's coin take a burst of pages a run, the holes read again after each", async () => {
    const { helius, asked } = stub([
      [buy(LAUNCH + 2 * MIN, 30e9), buy(LAUNCH + 3 * MIN, 31e9)],
      [buy(LAUNCH + 4 * MIN, 30e9), buy(LAUNCH + 5 * MIN, 31e9)],
      [buy(LAUNCH + 6 * MIN, 30e9), buy(LAUNCH + 7 * MIN, 31e9)],
      [buy(LAUNCH + 8 * MIN, 30e9), buy(LAUNCH + 9 * MIN, 31e9)],
    ]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, { ...opts, burstPages: 3 });
    expect(asked.map((a) => a.from)).toEqual([
      (LAUNCH + MIN) / 1000,
      (LAUNCH + 3 * MIN) / 1000,
      (LAUNCH + 5 * MIN) / 1000,
    ]);
    expect(await oneSecondHoles(MINT, LAUNCH, LAUNCH + 120 * MIN)).toEqual([
      [LAUNCH + 7 * MIN, LAUNCH + 120 * MIN],
    ]);
    // The run's pages cap the burst too.
    await runCandleChainFill(
      { helius, sink: { solUsd: async () => 200 } },
      { ...opts, burstPages: 3, pagesPerRun: 1 },
    );
    expect(asked).toHaveLength(4);
  });

  it("fills a hole no chunk ends exactly at, vouching for the quiet lead-in with the chunk it saved", async () => {
    // Born two minutes before the curve tape's first chunk: the first hole starts where no
    // 1-second cover ends. Before 2026-10-23 that parked the coin for the day.
    await prisma.token.update({
      where: { mintAddress: MINT },
      data: { launchedAt: new Date(LAUNCH - 2 * MIN) },
    });
    expect(await oneSecondHoles(MINT, LAUNCH - 2 * MIN, LAUNCH + 120 * MIN)).toEqual([
      [LAUNCH - 2 * MIN, LAUNCH],
      [LAUNCH + MIN, LAUNCH + 120 * MIN],
    ]);
    const { helius, asked } = stub([[buy(LAUNCH - MIN, 30e9)], [buy(LAUNCH + 5 * MIN, 31e9)]]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    // The first hole closed whole, so the coin's next one was read in the same run.
    expect(asked).toEqual([
      { from: (LAUNCH - 2 * MIN) / 1000, until: LAUNCH / 1000 },
      { from: (LAUNCH + MIN) / 1000, until: (LAUNCH + 118 * MIN) / 1000 },
    ]);
    expect(await oneSecondHoles(MINT, LAUNCH - 2 * MIN, LAUNCH + 118 * MIN)).toEqual([]);
  });

  it("vouches for a dead coin's quiet stretch with a chunk of its own, then leaves it be for a while", async () => {
    // Born two minutes before the curve tape's first chunk, and no trade on the chain at all.
    await prisma.token.update({
      where: { mintAddress: MINT },
      data: { launchedAt: new Date(LAUNCH - 2 * MIN) },
    });
    const { helius, asked } = stub([[], []]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    // The first hole, which no 1-second chunk ends at, got a chunk with no bar; the second ran the
    // curve chunk's cover on. Both closed in one run.
    expect(asked).toHaveLength(2);
    expect(await oneSecondHoles(MINT, LAUNCH - 2 * MIN, LAUNCH + 118 * MIN)).toEqual([]);
    const quiet = await prisma.candleChunk.findMany({ where: { mint: MINT, source: "tape" } });
    expect(quiet.map((r) => [r.coverFrom.getTime(), r.coverTo.getTime(), r.bars])).toEqual([
      [LAUNCH - 2 * MIN, LAUNCH, 0],
    ]);
    // Its window grows a minute a minute, but a dead coin is not read again for a while.
    const wider = { ...opts, windowMinutes: 130 };
    await runCandleChainFill(
      { helius, sink: { solUsd: async () => 200 } },
      { ...wider, now: () => NOW + 5 * MIN },
    );
    expect(asked).toHaveLength(2);
    await runCandleChainFill(
      { helius, sink: { solUsd: async () => 200 } },
      { ...wider, now: () => NOW + 31 * MIN },
    );
    expect(asked).toHaveLength(3);
    expect(await oneSecondHoles(MINT, LAUNCH - 2 * MIN, LAUNCH + 128 * MIN)).toEqual([]);
  });

  it("vouches for nothing over trades it can't price, and leaves that hole for the day", async () => {
    // A coin quoted in another coin: the chain holds its trades, but no swap event the fill can
    // price (no SOL in it).
    const unpriced = { ...buy(LAUNCH + 5 * MIN, 30e9) };
    unpriced.meta = { ...unpriced.meta!, logMessages: [] };
    const { helius, asked } = stub([[unpriced]]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    expect(asked).toHaveLength(1);
    expect(await prisma.candleChunk.count({ where: { mint: MINT, source: "tape" } })).toBe(0);
    expect(await oneSecondHoles(MINT, LAUNCH, LAUNCH + 120 * MIN)).toEqual([
      [LAUNCH + MIN, LAUNCH + 120 * MIN],
    ]);
    await runCandleChainFill(
      { helius, sink: { solUsd: async () => 200 } },
      { ...opts, now: () => NOW + 2 * MIN },
    );
    expect(asked).toHaveLength(1);
  });

  it("carries the day's spend over from the scan heartbeat", async () => {
    const { helius, asked } = stub([[buy(LAUNCH + 2 * MIN, 30e9)]]);
    seedCandleChainFillSpend(995, new Date(NOW), NOW);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    expect(asked).toHaveLength(0);
    // Another day's reading is not today's.
    resetCandleChainFill();
    seedCandleChainFillSpend(995, new Date(NOW - 86_400_000), NOW);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, opts);
    expect(asked).toHaveLength(1);
  });

  it("stops at the day's credits", async () => {
    const { helius, asked } = stub([[buy(LAUNCH + 2 * MIN, 30e9), buy(LAUNCH + 3 * MIN, 31e9)], []]);
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, { ...opts, creditsPerDay: 10 });
    await runCandleChainFill({ helius, sink: { solUsd: async () => 200 } }, { ...opts, creditsPerDay: 10 });
    expect(asked).toHaveLength(1);
  });
});
