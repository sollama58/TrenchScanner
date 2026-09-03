import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, type Env, type SolanaRpc } from "@trenchscanner/core";
import { reconcileBurns } from "./burnReconciler.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

/**
 * The cold-start backfill cursor.
 *
 * One pass is capped at MAX_PAGES_PER_PASS pages, and the default 400-day floor is about twice
 * that many signatures at this mint's measured rate - so the first pass stops short of the floor
 * by design. What it must NOT do is then point every later pass at only what is newer, which is
 * what setting lastSignature to the tip and clearing scanFloor used to mean: the older half of
 * the documented window was jumped over, and a burn sitting in it could never be credited.
 *
 * These cases drive the resume path directly rather than simulating ten thousand signatures.
 */
describe.skipIf(!dbAvailable)("reconcileBurns: cold-start backfill", () => {
  const env = { BURN_SCAN_COLD_START_DAYS: 400 } as Env;
  const DAY = 86_400_000;

  beforeEach(async () => {
    await prisma.burnScanCursor.deleteMany({ where: { id: "burn-scan" } });
  });

  afterAll(async () => {
    await prisma.burnScanCursor.deleteMany({ where: { id: "burn-scan" } });
  });

  /**
   * An RPC serving one fixed run of signatures, newest first. `before` slices to what is older
   * than that signature, mirroring the real endpoint; every transaction parses as a non-burn, so
   * these cases are about cursor movement rather than crediting.
   */
  function stubRpc(signatures: { signature: string; ageDays: number }[]) {
    const rpc = {
      async getSignaturesForAddress(_mint: string, opts: { limit: number; before?: string; until?: string }) {
        let rows = signatures;
        if (opts.before) {
          const idx = rows.findIndex((r) => r.signature === opts.before);
          rows = idx === -1 ? [] : rows.slice(idx + 1);
        }
        if (opts.until) {
          const idx = rows.findIndex((r) => r.signature === opts.until);
          rows = idx === -1 ? rows : rows.slice(0, idx);
        }
        return rows.slice(0, opts.limit).map((r) => ({
          signature: r.signature,
          blockTime: Math.floor((Date.now() - r.ageDays * DAY) / 1000),
          err: null,
        }));
      },
      async getParsedTransactions(sigs: string[]) {
        return new Map(sigs.map((s) => [s, { meta: { err: null }, transaction: {} }]));
      },
    } as unknown as SolanaRpc;
    return { rpc };
  }

  it("resumes from the backfill cursor and clears it once the floor is reached", async () => {
    // A cursor mid-backfill: the tip is already processed, and everything older than `sig-mid`
    // is still owed. The oldest row here sits beyond the 400-day floor.
    await prisma.burnScanCursor.create({
      data: {
        id: "burn-scan",
        lastSignature: "sig-tip",
        backfillBefore: "sig-mid",
        scanFloor: new Date(Date.now() - 400 * DAY),
      },
    });

    const { rpc } = stubRpc([
      { signature: "sig-tip", ageDays: 1 },
      { signature: "sig-mid", ageDays: 100 },
      { signature: "sig-old", ageDays: 200 },
      { signature: "sig-ancient", ageDays: 500 },
    ]);

    const result = await reconcileBurns(env, rpc);

    // sig-old is inside the window and was walked; sig-ancient is past the floor and stops it.
    expect(result.scanned).toBe(1);
    const cursor = await prisma.burnScanCursor.findUniqueOrThrow({ where: { id: "burn-scan" } });
    expect(cursor.backfillBefore).toBeNull();
    expect(cursor.scanFloor).toBeNull();
  });

  it("leaves the resume point alone when the RPC fails mid-backfill", async () => {
    await prisma.burnScanCursor.create({
      data: {
        id: "burn-scan",
        lastSignature: "sig-tip",
        backfillBefore: "sig-mid",
        scanFloor: new Date(Date.now() - 400 * DAY),
      },
    });

    // Signatures come back, but the transactions behind them do not - the pass must stop where
    // it stands rather than advance over ground nothing has looked at.
    const rpc = {
      async getSignaturesForAddress(_mint: string, opts: { limit: number; before?: string }) {
        if (!opts.before) return [];
        return [
          {
            signature: "sig-old",
            blockTime: Math.floor((Date.now() - 200 * DAY) / 1000),
            err: null,
          },
        ];
      },
      async getParsedTransactions(sigs: string[]) {
        return new Map(sigs.map((s) => [s, null]));
      },
    } as unknown as SolanaRpc;

    await reconcileBurns(env, rpc);

    const cursor = await prisma.burnScanCursor.findUniqueOrThrow({ where: { id: "burn-scan" } });
    expect(cursor.backfillBefore).toBe("sig-mid");
    expect(cursor.scanFloor).not.toBeNull();
  });

  it("a cold start that reaches the floor in one pass owes no backfill", async () => {
    const { rpc } = stubRpc([
      { signature: "sig-new", ageDays: 2 },
      { signature: "sig-past-floor", ageDays: 500 },
    ]);

    await reconcileBurns(env, rpc);

    const cursor = await prisma.burnScanCursor.findUniqueOrThrow({ where: { id: "burn-scan" } });
    expect(cursor.lastSignature).toBe("sig-new");
    expect(cursor.backfillBefore).toBeNull();
    expect(cursor.scanFloor).toBeNull();
  });
});
