import { afterAll, describe, expect, it, vi } from "vitest";
import {
  prisma,
  launchLabPoolOf,
  STONK_MINT,
  pumpCurveAddressOf,
  pumpSwapPoolOf,
  HttpError,
  RateGateDeadlineError,
  CoinGeckoBudgetSpentError,
  type CandleChunkRow,
  type StoredBar,
} from "@trenchscanner/core";
import {
  coveredBack,
  MinuteBudget,
  poolsOf,
  stepBackfill,
  tick,
  YOUNG_RETRY_UNTIL_MS,
  YOUNG_RETRY_WAIT_MS,
  type BackfillDeps,
  type BackfillJob,
  type BackfillToken,
} from "./candleBackfill.js";

const M = 60_000;
const NOW = Date.UTC(2026, 9, 22, 12, 30);
const HOUR_START = Date.UTC(2026, 9, 22, 12);
const PUMP_MINT = "146DQMuXQy6zQsvU2r4oKRyowhAYn7XT2Pynfi1Gpump";
const OTHER_MINT = "9ZUHa3k3rYEb6Hn8V1x4VbqS4i8GLfd8cF3bPZpSLo4q";

const job = (over: Partial<BackfillJob> = {}): BackfillJob => ({
  mint: PUMP_MINT,
  pumpDone: true,
  poolIndex: 0,
  poolPages: 0,
  cursor: null,
  pages: 0,
  failures: 0,
  ...over,
});
const pumpToken: BackfillToken = {
  launchpad: "pumpfun",
  launchedAt: new Date(NOW - 3 * 86_400_000),
  pairAddress: "PAIR",
};

/** A GeckoTerminal body of `n` minutes ending just before `beforeMs`. */
function geckoBody(beforeMs: number, n: number) {
  const list = Array.from({ length: n }, (_, i) => {
    const ts = beforeMs / 1_000 - 60 * (i + 1);
    return [ts, 1e-6, 2e-6, 1e-6, 1.5e-6, 10];
  });
  return { data: { attributes: { ohlcv_list: list } } };
}

function deps(over: Partial<BackfillDeps> = {}) {
  const saved: CandleChunkRow[] = [];
  const pages: { pool: string; before: number }[] = [];
  const d: BackfillDeps = {
    pumpFiveMinute: vi.fn(async () => [] as StoredBar[]),
    geckoPage: vi.fn(async (pool: string, _mint: string, before: number) => {
      pages.push({ pool, before });
      return geckoBody(before, 1_000);
    }),
    budget: new MinuteBudget(100, () => NOW),
    save: async (rows) => void saved.push(...rows),
    covers: async () => [],
    maxPages: 60,
    keepDays: 90,
    ...over,
  };
  return { d, saved, pages };
}

describe("poolsOf", () => {
  it("pages the coin's own pair first, then its PumpSwap pool and its curve, never a side pool", () => {
    expect(poolsOf(PUMP_MINT, pumpToken)).toEqual([
      "PAIR",
      pumpSwapPoolOf(PUMP_MINT),
      pumpCurveAddressOf(PUMP_MINT),
    ]);
    expect(poolsOf(OTHER_MINT, { launchpad: null, launchedAt: null, pairAddress: "POOL" })).toEqual(["POOL"]);
    expect(poolsOf(OTHER_MINT, { launchpad: null, launchedAt: null, pairAddress: null })).toEqual([]);
  });

  it("pages a Stonks coin's LaunchLab curve, on its quote, after its pair", () => {
    const stonks = { launchpad: "stonks", launchedAt: null, pairAddress: null };
    expect(poolsOf(OTHER_MINT, stonks)).toEqual([launchLabPoolOf(OTHER_MINT)]);
    expect(poolsOf(OTHER_MINT, { ...stonks, quoteMint: STONK_MINT })).toEqual([
      launchLabPoolOf(OTHER_MINT, STONK_MINT),
    ]);
    expect(poolsOf(OTHER_MINT, { ...stonks, pairAddress: "CPMM" })).toEqual([
      "CPMM",
      launchLabPoolOf(OTHER_MINT),
    ]);
  });

  it("skips the PumpSwap pool of a young coin still priced on its curve: it has not graduated", () => {
    const curve = pumpCurveAddressOf(PUMP_MINT)!;
    const young = { ...pumpToken, launchedAt: new Date(NOW - 3_600_000), pairAddress: curve };
    expect(poolsOf(PUMP_MINT, young, NOW)).toEqual([curve]);
    // Past the scan's watchlist the curve address may be stale: the pool is asked too (TB-1).
    expect(poolsOf(PUMP_MINT, { ...pumpToken, pairAddress: curve }, NOW)).toEqual([
      pumpSwapPoolOf(PUMP_MINT),
      curve,
    ]);
    expect(poolsOf(PUMP_MINT, { ...young, launchedAt: null }, NOW)).toEqual([
      pumpSwapPoolOf(PUMP_MINT),
      curve,
    ]);
    // No pair known: graduated or not, both are asked.
    expect(poolsOf(PUMP_MINT, { ...pumpToken, pairAddress: null })).toEqual([
      pumpSwapPoolOf(PUMP_MINT),
      curve,
    ]);
  });
});

describe("coveredBack", () => {
  it("walks back over stored covers that join up, and stops at a gap", () => {
    const covers = [
      { from: 100 * M, to: 160 * M },
      { from: 40 * M, to: 99.5 * M },
      { from: 0, to: 20 * M },
    ];
    expect(coveredBack(160 * M, covers)).toBe(40 * M);
    expect(coveredBack(200 * M, covers)).toBe(200 * M);
  });
});

describe("stepBackfill", () => {
  it("reads a Pump.fun coin's 5-minute page first, saved as coarse closed bars", async () => {
    const five: StoredBar[] = [
      { t: NOW - 10 * M, o: 1, h: 2, l: 1, c: 2, vol: 1 },
      { t: Math.floor(NOW / (5 * M)) * 5 * M, o: 2, h: 2, l: 2, c: 2, vol: 1 },
    ];
    const { d, saved } = deps({ pumpFiveMinute: vi.fn(async () => five) });
    const patch = await stepBackfill(job({ pumpDone: false }), pumpToken, d, NOW);
    expect(patch.pumpDone).toBe(true);
    expect(d.geckoPage).not.toHaveBeenCalled();
    // The forming 5 minutes are left for later.
    expect(saved.flatMap((r) => r.bars.map((b) => b.t))).toEqual([NOW - 10 * M]);
    expect(saved.every((r) => r.res === 300 && r.coarse)).toBe(true);
  });

  it("pages GeckoTerminal back from now, a page a step", async () => {
    const { d, saved, pages } = deps();
    const patch = await stepBackfill(job(), pumpToken, d, NOW);
    expect(pages).toEqual([{ pool: "PAIR", before: NOW }]);
    expect(patch.pages).toBe(1);
    expect(patch.cursor!.getTime()).toBe(NOW - 1_000 * M);
    expect(patch.poolIndex).toBeUndefined();
    expect(saved.every((r) => r.source === "gecko" && r.res === 60)).toBe(true);
    expect(saved.reduce((n, r) => n + r.bars.length, 0)).toBe(1_000);
  });

  it("steps over what the store already covers instead of asking for it again", async () => {
    const { d, pages } = deps({ covers: async () => [{ from: HOUR_START - 600 * M, to: NOW }] });
    await stepBackfill(job(), pumpToken, d, NOW);
    expect(pages[0]!.before).toBe(HOUR_START - 600 * M);
  });

  it("moves to the next pool on a short page, an empty one or an unknown pool", async () => {
    const short = deps({ geckoPage: vi.fn(async (_p, _m, before) => geckoBody(before, 10)) });
    expect((await stepBackfill(job(), pumpToken, short.d, NOW)).poolIndex).toBe(1);
    const unknown = deps({ geckoPage: vi.fn(async () => null) });
    const patch = await stepBackfill(
      job({ cursor: new Date(HOUR_START - 5 * M) }),
      pumpToken,
      unknown.d,
      NOW,
    );
    expect(patch.poolIndex).toBe(1);
    expect(patch.cursor!.getTime()).toBe(HOUR_START - 5 * M);
  });

  it("stays on a pool whose full page also listed the bar at the cursor", async () => {
    // GeckoTerminal's page before a minute often lists that minute too: 1,000 rows, 999 kept. Until
    // 2026-10-29 the 999 counted as short and the pool's paging ended after one page (chart audit D2).
    const cursor = HOUR_START - 5 * M;
    const { d } = deps({ geckoPage: vi.fn(async (_p, _m, before) => geckoBody(before + M, 1_000)) });
    const patch = await stepBackfill(
      job({ cursor: new Date(cursor), pages: 1, poolPages: 1 }),
      pumpToken,
      d,
      NOW,
    );
    expect(patch.poolIndex).toBeUndefined();
    expect(patch.poolPages).toBe(2);
    expect(patch.cursor!.getTime()).toBe(cursor - 999 * M);
    // A page that listed fewer than 1,000 rows still ends the pool.
    const short = deps({ geckoPage: vi.fn(async (_p, _m, before) => geckoBody(before + M, 999)) });
    const ended = await stepBackfill(
      job({ cursor: new Date(cursor), pages: 1, poolPages: 1 }),
      pumpToken,
      short.d,
      NOW,
    );
    expect(ended).toMatchObject({ poolIndex: 1, poolPages: 0 });
  });

  it("vouches for no quiet minutes up to where the pool before began on a later pool's first page", async () => {
    // A graduated coin: its pool's history begins at the cursor; the curve's last bar is an hour
    // before (graduation, as far as these pages go). The stretch between is the pool's to draw,
    // not the curve's silence (chart audit 2026-10-29, D2).
    const cursor = HOUR_START - 5 * M;
    const curve = (before: number) => geckoBody(before - 60 * M, 100);
    const first = deps({ geckoPage: vi.fn(async (_p, _m, before) => curve(before)) });
    const patch = await stepBackfill(
      job({ cursor: new Date(cursor), poolIndex: 2, poolPages: 0, pages: 3 }),
      pumpToken,
      first.d,
      NOW,
    );
    expect(patch).toMatchObject({ poolIndex: 3, poolPages: 0 });
    expect(Math.max(...first.saved.map((r) => r.coverTo))).toBe(cursor - 60 * M);
    // Its later pages vouch for the quiet up to the cursor its own page set, as before.
    const later = deps({ geckoPage: vi.fn(async (_p, _m, before) => curve(before)) });
    await stepBackfill(
      job({ cursor: new Date(cursor), poolIndex: 2, poolPages: 1, pages: 4 }),
      pumpToken,
      later.d,
      NOW,
    );
    expect(Math.max(...later.saved.map((r) => r.coverTo))).toBe(cursor);
  });

  it("ends at the launch, when the pools run out, or at the page cap", async () => {
    const { d } = deps();
    const atLaunch = job({ cursor: new Date(pumpToken.launchedAt!.getTime() - 2 * M) });
    expect((await stepBackfill(atLaunch, pumpToken, d, NOW)).done).toBe(true);
    expect((await stepBackfill(job({ poolIndex: 3 }), pumpToken, d, NOW)).done).toBe(true);
  });

  // A call minutes after a launch found no pool on GeckoTerminal yet (its pool is indexed some
  // minutes after the first trade) and marked the coin done with no pages: its chart stayed empty
  // until the six-hour redo (chart audit 2026-10-24).
  it("asks a coin launched minutes ago again when no pool had a page yet, instead of giving it up", async () => {
    const { d } = deps({ geckoPage: vi.fn(async () => null) });
    const young = { ...pumpToken, launchedAt: new Date(NOW - 5 * M) };
    const pools = poolsOf(PUMP_MINT, young, NOW);
    const retry = await stepBackfill(job({ poolIndex: pools.length }), young, d, NOW);
    expect(retry.done).toBeUndefined();
    expect(retry.poolIndex).toBe(0);
    expect(retry.nextAt.getTime()).toBe(NOW + YOUNG_RETRY_WAIT_MS);
    // Once it has a page, or past its first minutes, an exhausted pool list ends it as before.
    expect((await stepBackfill(job({ poolIndex: pools.length, pages: 1 }), young, d, NOW)).done).toBe(true);
    const later = NOW + YOUNG_RETRY_UNTIL_MS;
    const olderPools = poolsOf(PUMP_MINT, young, later);
    expect((await stepBackfill(job({ poolIndex: olderPools.length }), young, d, later)).done).toBe(true);
    expect((await stepBackfill(job({ pages: 60 }), pumpToken, d, NOW)).done).toBe(true);
    expect(d.geckoPage).not.toHaveBeenCalled();
  });

  it("waits, without a call or a failure, when the budget has no room or the shared gate is full", async () => {
    const budget = new MinuteBudget(1, () => NOW);
    budget.spend();
    const { d } = deps({ budget });
    const held = await stepBackfill(job(), pumpToken, d, NOW);
    expect(d.geckoPage).not.toHaveBeenCalled();
    expect(held.nextAt.getTime()).toBe(NOW + 15_000);
    expect(held.failures).toBeUndefined();
    const gated = deps({
      geckoPage: vi.fn(async () => {
        throw new RateGateDeadlineError();
      }),
    });
    const waited = await stepBackfill(job(), pumpToken, gated.d, NOW);
    expect(waited.failures).toBeUndefined();
    expect(waited.nextAt.getTime()).toBe(NOW + 15_000);
  });

  it("waits half an hour when the day's CoinGecko budget for charts is spent, keeping the coin", async () => {
    const { d } = deps({
      geckoPage: vi.fn(async () => {
        throw new CoinGeckoBudgetSpentError("charts");
      }),
    });
    const held = await stepBackfill(job({ failures: 2 }), pumpToken, d, NOW);
    expect(held.failures).toBeUndefined();
    expect(held.done).toBeUndefined();
    expect(held.nextAt.getTime()).toBe(NOW + 30 * M);
  });

  it("waits a minute on a 429 without counting it against the coin", async () => {
    const { d } = deps({
      geckoPage: vi.fn(async () => {
        throw new HttpError(429, "https://pro-api.coingecko.com/x");
      }),
    });
    const patch = await stepBackfill(job({ failures: 4 }), pumpToken, d, NOW);
    expect(patch.failures).toBeUndefined();
    expect(patch.done).toBeUndefined();
    expect(patch.nextAt.getTime()).toBe(NOW + 60_000);
  });

  it("goes on to GeckoTerminal when Pump.fun's 5-minute page fails", async () => {
    const { d } = deps({
      pumpFiveMinute: vi.fn(async () => {
        throw new Error("HTTP 403");
      }),
    });
    const patch = await stepBackfill(job({ pumpDone: false }), pumpToken, d, NOW);
    expect(patch).toMatchObject({ pumpDone: true, nextAt: new Date(NOW) });
    expect(patch.failures).toBeUndefined();
    expect(patch.done).toBeUndefined();
  });

  it("backs off a failing coin and gives it up after five failures", async () => {
    const { d } = deps({
      geckoPage: vi.fn(async () => {
        throw new Error("HTTP 500");
      }),
    });
    const first = await stepBackfill(job(), pumpToken, d, NOW);
    expect(first.failures).toBe(1);
    expect(first.nextAt.getTime()).toBe(NOW + 5 * M);
    expect(first.done).toBeUndefined();
    expect((await stepBackfill(job({ failures: 4 }), pumpToken, d, NOW)).done).toBe(true);
  });

  it("pages a non-Pump coin's own pool back until its history ends", async () => {
    const token = { launchpad: null, launchedAt: null, pairAddress: "POOL" };
    const { d, pages } = deps({
      geckoPage: vi.fn(async (pool, _m, before) => (pages.push({ pool, before }), geckoBody(before, 400))),
    });
    const patch = await stepBackfill(job({ mint: OTHER_MINT, pumpDone: false }), token, d, NOW);
    expect(d.pumpFiveMinute).not.toHaveBeenCalled();
    expect(pages.map((p) => p.pool)).toEqual(["POOL"]);
    expect(patch.poolIndex).toBe(1);
  });

  it("vouches for the quiet minutes a page leaves out, and the newest page's tail up to three minutes ago", async () => {
    const token = { launchpad: null, launchedAt: null, pairAddress: "POOL" };
    // A page whose bars end ten minutes ago with no bar from 50 to 40 minutes ago: GeckoTerminal
    // leaves a minute with no trade out, so those minutes were quiet, not unread (user report
    // 2026-10-23: a quiet stretch inside a page was drawn as a hole).
    const quiet = (before: number) => {
      const body = geckoBody(before - 10 * M, 100);
      body.data.attributes.ohlcv_list = body.data.attributes.ohlcv_list.filter(
        ([ts]) => ts! * 1_000 < before - 50 * M || ts! * 1_000 >= before - 40 * M,
      );
      return body;
    };
    const first = deps({ geckoPage: vi.fn(async (_p, _m, before) => quiet(before)) });
    await stepBackfill(job({ mint: OTHER_MINT, pumpDone: false }), token, first.d, NOW);
    const covers = first.saved.map((r) => [r.coverFrom, r.coverTo] as const).sort((a, b) => a[0] - b[0]);
    // One cover after another with no break between the page's first bar and three minutes ago.
    expect(covers[0]![0]).toBe(NOW - 110 * M);
    for (let i = 1; i < covers.length; i++) expect(covers[i]![0]).toBeLessThanOrEqual(covers[i - 1]![1]);
    expect(Math.max(...covers.map((c) => c[1]))).toBe(NOW - 3 * M);
    // An older page (the cursor set) was read for everything before the cursor: the quiet minutes
    // between its newest bar and the cursor are vouched for too, so its covers join the next page's.
    const older = deps({ geckoPage: vi.fn(async (_p, _m, before) => quiet(before)) });
    await stepBackfill(job({ mint: OTHER_MINT, cursor: new Date(NOW - 200 * M) }), token, older.d, NOW);
    expect(Math.max(...older.saved.map((r) => r.coverTo))).toBe(NOW - 200 * M);
  });

  it("pages a non-Pump coin from now, not the hour start: no live page holds its newest stretch", async () => {
    const token = { launchpad: null, launchedAt: null, pairAddress: "POOL" };
    // GeckoTerminal two minutes late: the store is vouched for only to its newest bar.
    const { d, saved, pages } = deps({
      geckoPage: vi.fn(async (pool, _m, before) => {
        pages.push({ pool, before });
        return geckoBody(before - 2 * M, 100);
      }),
    });
    await stepBackfill(job({ mint: OTHER_MINT, pumpDone: false }), token, d, NOW);
    expect(pages).toEqual([{ pool: "POOL", before: NOW }]);
    expect(Math.max(...saved.map((r) => r.coverTo))).toBe(NOW - 2 * M);
  });
});

describe("MinuteBudget", () => {
  it("lets through its calls a rolling minute", () => {
    let now = 0;
    const b = new MinuteBudget(2, () => now);
    b.spend();
    b.spend();
    expect(b.hasRoom()).toBe(false);
    now = 60_001;
    expect(b.hasRoom()).toBe(true);
  });
});

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

describe.skipIf(!dbAvailable)("tick", () => {
  const MINT = `backfill-test-${Date.now()}pump`;
  afterAll(async () => {
    await prisma.candleChunk.deleteMany({ where: { mint: MINT } });
    await prisma.candleBackfill.deleteMany({ where: { mint: MINT } });
    await prisma.token.deleteMany({ where: { mintAddress: MINT } });
  });

  it("claims a due coin, takes one step and writes the row back unleased", async () => {
    await prisma.token.create({ data: { mintAddress: MINT, launchpad: "pumpfun", pairAddress: "PAIR" } });
    await prisma.candleBackfill.create({
      data: { mint: MINT, reason: "call", nextAt: new Date(NOW - 1_000) },
    });
    const { d, saved } = deps({ save: async (rows) => void saved.push(...rows) });
    await tick(d, NOW);
    let row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: MINT } });
    expect([row.pumpDone, row.leaseUntil, row.doneAt]).toEqual([true, null, null]);
    await tick(d, NOW);
    row = await prisma.candleBackfill.findUniqueOrThrow({ where: { mint: MINT } });
    expect(row.pages).toBe(1);
    expect(row.poolPages).toBe(1);
    expect(row.cursor!.getTime()).toBe(NOW - 1_000 * M);
    expect(saved.length).toBeGreaterThan(0);
  });
});
