import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@trenchscanner/core";
import { backfillStatus, jobStatus, resetBackfillStatus, type BackfillJobRow } from "./backfillStatus.js";
import { resetCandleTopUp } from "./candleTopUp.js";

const M = 60_000;
const NOW = Date.UTC(2026, 9, 24, 12, 0);
const job = (over: Partial<BackfillJobRow> = {}): BackfillJobRow => ({
  reason: "chart",
  requestedAt: new Date(NOW - M),
  nextAt: new Date(NOW),
  cursor: null,
  pages: 0,
  doneAt: null,
  ...over,
});

describe("jobStatus", () => {
  it("counts the pages ahead and the coin's own back to launch, at the worker's pace", () => {
    // Launched 2,500 minutes ago: three pages of its own, two more ahead, a page every 3 s.
    const s = jobStatus(job(), new Date(NOW - 2_500 * M), 2, 3_000, 60, NOW);
    expect(s).toEqual({ etaMs: 15_000, progress: 0 });
  });

  it("shows how far back the backfill has paged", () => {
    const s = jobStatus(
      job({ cursor: new Date(NOW - 1_000 * M), pages: 1 }),
      new Date(NOW - 2_000 * M),
      0,
      1_000,
      60,
      NOW,
    );
    expect(s).toEqual({ etaMs: 1_000, progress: 0.5 });
  });

  it("waits out the job's backoff, and knows no progress without a launch", () => {
    const s = jobStatus(job({ nextAt: new Date(NOW + 20_000) }), null, 0, 1_000, 60, NOW);
    expect(s).toEqual({ etaMs: 21_000, progress: null });
  });

  it("has nothing for a done job or none", () => {
    expect(jobStatus(job({ doneAt: new Date(NOW) }), null, 0, 1_000, 60, NOW)).toBeNull();
    expect(jobStatus(null, null, 0, 1_000, 60, NOW)).toBeNull();
  });
});

describe("backfillStatus", () => {
  const A = "BfStatusA111111111111111111111111111";
  const B = "BfStatusB111111111111111111111111111";
  const C = "BfStatusC111111111111111111111111111";
  const mints = [A, B, C];
  beforeAll(async () => {
    await prisma.candleBackfill.deleteMany({ where: { mint: { in: mints } } });
    await prisma.candleBackfill.createMany({
      data: [
        { mint: A, reason: "chart", requestedAt: new Date(NOW - 5 * M), nextAt: new Date(NOW - M) },
        { mint: B, reason: "call", requestedAt: new Date(NOW - M), nextAt: new Date(NOW - M) },
        { mint: C, reason: "chart", requestedAt: new Date(NOW - 2 * M), nextAt: new Date(NOW - M) },
      ],
    });
  });
  afterEach(() => {
    resetBackfillStatus();
    resetCandleTopUp();
  });
  afterAll(async () => {
    await prisma.candleBackfill.deleteMany({ where: { mint: { in: mints } } });
  });

  it("puts a call and an older chart ask ahead of the coin", async () => {
    // Other tests' jobs may be queued too: at least A's and B's page are ahead of C.
    const s = await backfillStatus(C, null, { stepMs: 1_000, maxPages: 60, topUp: false, now: NOW });
    expect(s?.etaMs).toBeGreaterThanOrEqual(3_000);
    const b = await backfillStatus(B, null, { stepMs: 1_000, maxPages: 60, topUp: false, now: NOW });
    expect(b?.etaMs).toBeLessThan(s!.etaMs!);
  });

  it("has only the top-up's wait for a coin with no job", async () => {
    const opts = { stepMs: 1_000, maxPages: 60, now: NOW };
    const none = "BfStatusNone1111111111111111111111111";
    expect(await backfillStatus(none, null, { ...opts, topUp: true })).toEqual({
      etaMs: 4_000,
      progress: null,
    });
    expect(await backfillStatus(none, null, { ...opts, topUp: false })).toBeNull();
  });
});
