import "./bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { ViewStampBuffer } from "./viewStamps.js";

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

  it("collapses repeated views of the same tokens into one write", async () => {
    // The curated feed's shape: many readers, one set of twelve tokens. Before buffering this was
    // one transaction per reader, all contending for the same rows.
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    for (let reader = 0; reader < 50; reader++) buffer.record(tokenIds);

    await buffer.flush();

    expect(await stampedCount()).toBe(3);
    await buffer.stop();
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

  it("ignores stamps recorded after shutdown", async () => {
    const buffer = new ViewStampBuffer({ flushIntervalMs: 60_000 });
    await buffer.stop();
    buffer.record(tokenIds);
    await buffer.flush();

    expect(await stampedCount()).toBe(0);
  });
});
