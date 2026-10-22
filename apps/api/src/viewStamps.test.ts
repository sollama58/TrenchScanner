import "./bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { holderStampClearAt, releaseHolderStamps, ViewStampBuffer } from "./viewStamps.js";

describe("holderStampClearAt", () => {
  it("clears through the flush time, which is later than the poll the release stored", () => {
    const pollAt = 1_700_000_000_000;
    const writtenAt = pollAt + 4_000;
    expect(holderStampClearAt(pollAt, { pollAt, writtenAt })).toBe(writtenAt);
    // A stamp from a later poll is not this release's.
    expect(holderStampClearAt(pollAt, { pollAt: pollAt + 30_000, writtenAt: pollAt + 34_000 })).toBe(pollAt);
    // The previous flush, still the stamp in the column when a newer poll was dismissed unflushed.
    expect(holderStampClearAt(pollAt + 30_000, { pollAt, writtenAt })).toBe(pollAt + 30_000);
    expect(holderStampClearAt(pollAt, undefined)).toBe(pollAt);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `view-stamp-test-${Date.now()}`;

describe.skipIf(!dbAvailable)("ViewStampBuffer", () => {
  let tokenIds: string[] = [];

  beforeEach(async () => {
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
    tokenIds = [];
    for (let i = 0; i < 3; i++) {
      const token = await prisma.token.create({
        data: { mintAddress: `${TAG}-${i}-${Math.random()}`, symbol: "T", name: "T" },
      });
      tokenIds.push(token.id);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.token.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  const stampedCount = () =>
    prisma.token.count({ where: { id: { in: tokenIds }, lastViewedAt: { not: null } } });

  it("does not touch the database until it flushes", async () => {
    // This is the property the request path depends on: record() returns having done no I/O.
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    buffer.record(tokenIds);

    expect(await stampedCount()).toBe(0);

    await buffer.flush();
    expect(await stampedCount()).toBe(3);
    await buffer.stop();
  });

  it("stamps holdersViewedAt by mint for the bubble map's reads, and leaves lastViewedAt alone", async () => {
    const tokens = await prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { mintAddress: true },
    });
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000, stamp: "holders" });
    buffer.record(tokens.slice(0, 2).map((t) => t.mintAddress));
    await buffer.flush();
    expect(
      await prisma.token.count({ where: { id: { in: tokenIds }, holdersViewedAt: { not: null } } }),
    ).toBe(2);
    expect(await stampedCount()).toBe(0);
    await buffer.stop();
  });

  it("collapses repeated views of the same tokens into one write", async () => {
    // The curated feed's shape: many readers, one set of twelve tokens. Before buffering this was
    // one transaction per reader, all contending for the same rows.
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    for (let reader = 0; reader < 50; reader++) buffer.record(tokenIds);

    await buffer.flush();

    expect(await stampedCount()).toBe(3);
    await buffer.stop();
  });

  it("stop() writes the stamps that arrived during a write already in flight", async () => {
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    buffer.record(tokenIds.slice(0, 1));
    const inFlight = buffer.flush();
    // Landed after the first batch was swapped out: before, stop() saw a flush in progress,
    // returned at once, and these were never written.
    buffer.record(tokenIds.slice(1));
    await buffer.stop();
    await inFlight;

    expect(await stampedCount()).toBe(3);
  });

  it("flushes on its own once the interval elapses", async () => {
    const buffer = new ViewStampBuffer({ flushIntervalMs: 50 });
    buffer.record(tokenIds);

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await stampedCount()).toBe(3);
    await buffer.stop();
  });

  it("flushes early rather than growing past its ceiling", async () => {
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000, maxPending: 3 });
    buffer.record(tokenIds);

    // No flush() call and no waiting: reaching maxPending is what writes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await stampedCount()).toBe(3);
    await buffer.stop();
  });

  it("keeps stamps that arrive while a flush is in progress", async () => {
    // The batch is swapped out before the await, so a stamp landing mid-write belongs to the next
    // batch instead of being cleared unwritten.
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    buffer.record([tokenIds[0]!]);
    const inFlight = buffer.flush();
    buffer.record([tokenIds[1]!, tokenIds[2]!]);
    await inFlight;

    expect(await stampedCount()).toBe(1);

    await buffer.flush();
    expect(await stampedCount()).toBe(3);
    await buffer.stop();
  });

  it("writes what is still buffered when the server shuts down", async () => {
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    buffer.record(tokenIds);

    await buffer.stop();

    expect(await stampedCount()).toBe(3);
  });

  it("clears a flushed bubble-map stamp at the time that was written, not the earlier poll", async () => {
    const tokens = await prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { mintAddress: true },
    });
    const mint = tokens[0]!.mintAddress;
    const kept = tokens[1]!.mintAddress;
    const pollAt = Date.now() - 5_000;
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000, stamp: "holders" });
    buffer.record([mint], pollAt);
    await buffer.flush();
    const stamped = await prisma.token.findUnique({
      where: { mintAddress: mint },
      select: { holdersViewedAt: true },
    });
    expect(stamped?.holdersViewedAt).not.toBeNull();
    expect(stamped!.holdersViewedAt!.getTime()).toBeGreaterThan(pollAt);
    // A later poll's stamp, written after this flush, must survive a release of the earlier poll.
    const later = new Date(stamped!.holdersViewedAt!.getTime() + 60_000);
    await prisma.token.update({ where: { mintAddress: kept }, data: { holdersViewedAt: later } });
    await releaseHolderStamps(buffer, [
      { mint, at: pollAt },
      { mint: kept, at: pollAt },
    ]);
    const rows = await prisma.token.findMany({
      where: { mintAddress: { in: [mint, kept] } },
      select: { mintAddress: true, holdersViewedAt: true },
    });
    const at = (id: string) => rows.find((row) => row.mintAddress === id)?.holdersViewedAt ?? null;
    expect(at(mint)).toBeNull();
    expect(at(kept)?.toISOString()).toBe(later.toISOString());
    await buffer.stop();
  });

  it("clears a released bubble-map stamp, and leaves a newer one", async () => {
    const tokens = await prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { mintAddress: true },
    });
    const older = tokens[0]!;
    const newer = tokens[1]!;
    const pending = tokens[2]!;
    const oldAt = new Date("2026-10-21T17:00:00Z");
    const newAt = new Date("2026-10-21T17:05:00Z");
    await prisma.token.update({ where: { id: tokenIds[0] }, data: { holdersViewedAt: oldAt } });
    await prisma.token.update({ where: { id: tokenIds[1] }, data: { holdersViewedAt: newAt } });
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000, stamp: "holders" });
    buffer.record([pending.mintAddress]);
    // 2026-10-21 user ask: releasing drops a pending stamp of that mint, clears a stamp from the
    // poll that was released, and does not clear a stamp a later poll already wrote.
    await releaseHolderStamps(buffer, [
      { mint: older.mintAddress, at: oldAt.getTime() },
      { mint: newer.mintAddress, at: oldAt.getTime() },
      { mint: pending.mintAddress, at: oldAt.getTime() },
    ]);
    await buffer.flush();
    const rows = await prisma.token.findMany({
      where: { id: { in: tokenIds } },
      select: { mintAddress: true, holdersViewedAt: true },
    });
    const at = (mint: string) => rows.find((row) => row.mintAddress === mint)?.holdersViewedAt ?? null;
    expect(at(older.mintAddress)).toBeNull();
    expect(at(newer.mintAddress)?.toISOString()).toBe(newAt.toISOString());
    expect(at(pending.mintAddress)).toBeNull();
    await buffer.stop();
  });

  it("ignores stamps recorded after shutdown", async () => {
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    await buffer.stop();
    buffer.record(tokenIds);
    await buffer.flush();

    expect(await stampedCount()).toBe(0);
  });
});
