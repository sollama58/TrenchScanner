import { describe, expect, it } from "vitest";
import { pumpCurveAddressOf, type CurveState } from "@trenchscanner/core";
import bs58 from "bs58";
import {
  curveMcapSol,
  LiveCurves,
  MAX_FOLLOWED,
  READ_EVERY_MS,
  VERIFY_EVERY_MS,
  VERIFY_GRACE_MS,
} from "./liveCurve.js";
import { ChartHealth } from "./chartHealth.js";
import { QuotePrice, SolPrice } from "./solPrice.js";

const MINT = "BfWF6DxxfjdZPqjc2dPQvMd4CJh8Xr7ZPeP3iLh2pump";
const pumpCurve = (mint: string) => pumpCurveAddressOf(mint)!;
const DISC = [23, 183, 248, 55, 96, 216, 172, 96];

/** A curve's account data, base64, as the stream delivers it. */
function curveData(vToken: bigint, vSol: bigint, complete = false): string {
  const data = new Uint8Array(115);
  data.set(DISC, 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, vToken, true);
  view.setBigUint64(16, vSol, true);
  data[48] = complete ? 1 : 0;
  return Buffer.from(data).toString("base64");
}

const state = (vSol: number, complete = false): CurveState => ({
  virtualToken: 1e15,
  virtualQuote: vSol,
  realQuote: 0,
  complete,
  quoteIsSol: true,
});

/** A token account's data, base64, cut to its amount as the stream's slice would carry it. */
function vaultData(amount: bigint): string {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return Buffer.from(data).toString("base64");
}

const VAULTS = { base: "base-vault", quote: "quote-vault", virtualQuote: 0 };

/** A PumpSwap pool account's data, base64, carrying its virtual quote reserve. */
function poolAccountData(virtualQuote: bigint): string {
  const data = new Uint8Array(301);
  data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  new DataView(data.buffer).setBigInt64(245, virtualQuote, true);
  return Buffer.from(data).toString("base64");
}

function setup(
  opts: {
    stream?: boolean;
    states?: (CurveState | null)[];
    /** After bonding: the pool's vaults (null: no pool) and their balances [base, quote]. */
    pool?: { vaults: typeof VAULTS | null; amounts: [number, number] };
    /** Prices a coin-quoted curve's quote. */
    quotePrice?: { get: (mint: string) => Promise<{ usd: number; decimals: number } | null> };
    /** The coins' supply now (mintSupply.ts); none known by default. */
    supplies?: Record<string, number>;
  } = {},
) {
  let now = 1_000_000;
  const reads: string[][] = [];
  const states = [...(opts.states ?? [state(5e10)])];
  const watched = new Set<string>();
  let covered: number | null = null;
  let onAccount: ((key: string, data: string, slot: number | null) => void) | null = null;
  const poolReads: string[][] = [];
  const resubscribed: string[] = [];
  const amounts = opts.pool ? [...opts.pool.amounts] : [0, 0];
  const health = new ChartHealth(() => now);
  const curves = new LiveCurves({
    health,
    makeStream: opts.stream
      ? (cb) => {
          onAccount = cb;
          return {
            start: () => {},
            stop: () => {},
            watch: (key: string) => void watched.add(key),
            unwatch: (key: string) => void watched.delete(key),
            coveredSince: (key: string) => (watched.has(key) ? covered : null),
            resubscribe: (key: string) => void resubscribed.push(key),
          };
        }
      : null,
    reader: {
      getCurveStatesBatch: async (list: string[]) => {
        reads.push(list);
        const s = states.length > 1 ? states.shift()! : states[0]!;
        return new Map(list.map((c) => [c, s]));
      },
      ...(opts.pool
        ? {
            getPoolVaultsBatch: async (pools: ReadonlyMap<string, { mint: string; quoteMint: string }>) =>
              new Map([...pools.keys()].map((p) => [p, opts.pool!.vaults])),
            getTokenAmountsBatch: async (list: string[]) => {
              poolReads.push(list);
              return new Map(list.map((a) => [a, a === VAULTS.base ? amounts[0]! : amounts[1]!]));
            },
          }
        : {}),
    },
    solPrice: { get: async () => 100 },
    quotePrice: opts.quotePrice,
    supplies: {
      get: async (mints) =>
        new Map(mints.flatMap((m) => (opts.supplies?.[m] ? [[m, opts.supplies[m]]] : []))),
    },
    now: () => now,
  });
  return {
    curves,
    reads,
    watched,
    tick: (ms: number) => (now += ms),
    at: () => now,
    cover: (since: number | null) => (covered = since),
    poolReads,
    resubscribed,
    health,
    /** What the RPC reads from now on (the stream may not have said). */
    next: (s: CurveState) => void states.splice(0, states.length, s),
    nextAmounts: (base: number, quote: number) => void amounts.splice(0, 2, base, quote),
    push: (data: string) => onAccount!(`chart:${MINT}`, data, null),
    pushVault: (side: "base" | "quote", amount: bigint, slot: number) =>
      onAccount!(`pool-${side}:${MINT}`, vaultData(amount), slot),
    pushPool: (virtualQuote: bigint) =>
      onAccount!(`pool-account:${MINT}`, poolAccountData(virtualQuote), null),
  };
}

describe("curveMcapSol", () => {
  it("prices a curve as market cap in SOL over Pump.fun's billion supply", () => {
    // 30 SOL against 1.073B tokens at launch: about 28 SOL.
    expect(curveMcapSol({ virtualQuote: 30e9, virtualToken: 1_073_000_000e6 })).toBeCloseTo(27.96, 2);
  });
});

describe("LiveCurves", () => {
  it("seeds a curve on its first ask and answers in USD", async () => {
    const t = setup();
    const a = await t.curves.read(MINT, 0);
    expect(t.reads).toHaveLength(1);
    expect(a.source).toBe("rpc");
    expect(a.ticks).toEqual([[t.at(), curveMcapSol(state(5e10)) * 100]]);
    t.curves.stop();
  });

  it("reads again off the stream every READ_EVERY_MS, and only sends what is new", async () => {
    const t = setup({ states: [state(5e10), state(6e10)] });
    const first = await t.curves.read(MINT, 0);
    t.tick(READ_EVERY_MS);
    await t.curves.round();
    const next = await t.curves.read(MINT, first.ticks[0]![0]);
    expect(next.ticks).toHaveLength(1);
    expect(next.ticks[0]![1]).toBeCloseTo(curveMcapSol(state(6e10)) * 100);
    t.curves.stop();
  });

  it("takes every change from the stream once a read follows the subscription", async () => {
    const t = setup({ stream: true });
    t.cover(t.at());
    await t.curves.read(MINT, 0);
    t.tick(400);
    t.push(curveData(1_000_000_000_000_000n, 70_000_000_000n));
    t.tick(400);
    const a = await t.curves.read(MINT, 0);
    expect(a.source).toBe("stream");
    expect(a.ticks).toHaveLength(2);
    // Known current as of the delivery, not the ask.
    expect(a.readAt).toBe(t.at() - 400);
    // Covered by the stream: no polling.
    t.tick(READ_EVERY_MS * 3);
    await t.curves.round();
    expect(t.reads).toHaveLength(1);
    t.curves.stop();
  });

  it("holds a waiting ask until the stream's next change, and answers at once with one ready", async () => {
    const t = setup({ stream: true });
    t.cover(t.at());
    const seed = await t.curves.read(MINT, 0, 5_000);
    expect(seed).toMatchObject({ held: true });
    expect(seed.ticks).toHaveLength(1);
    const after = seed.ticks[0]![0];
    let answered = false;
    const held = t.curves.read(MINT, after, 5_000).then((a) => {
      answered = true;
      return a;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(answered).toBe(false);
    t.tick(400);
    t.push(curveData(1_000_000_000_000_000n, 70_000_000_000n));
    const a = await held;
    expect(a.held).toBe(true);
    expect(a.ticks).toEqual([[t.at(), 7_000]]);
    t.curves.stop();
  });

  it("lets a held ask go when its wait runs out or the reader leaves", async () => {
    const t = setup({ stream: true });
    t.cover(t.at());
    const seed = await t.curves.read(MINT, 0);
    const after = seed.ticks[0]![0];
    expect(seed.held).toBeUndefined();
    const timedOut = await t.curves.read(MINT, after, 30);
    expect(timedOut).toMatchObject({ held: true, ticks: [] });
    const ctl = new AbortController();
    const left = t.curves.read(MINT, after, 5_000, ctl.signal);
    ctl.abort();
    expect(await left).toMatchObject({ held: true, ticks: [] });
    t.curves.stop();
  });

  it("ignores stream updates before the seed read", async () => {
    const t = setup({ stream: true, states: [state(5e10)] });
    t.cover(t.at());
    const a = await t.curves.read(MINT, 0);
    expect(a.ticks).toHaveLength(1);
    t.curves.stop();
  });

  it("stops at a graduated curve and at an address with no curve", async () => {
    const done = setup({ states: [state(5e10, true)] });
    expect((await done.curves.read(MINT, 0)).complete).toBe(true);
    done.curves.stop();
    const gone = setup({ states: [null] });
    const a = await gone.curves.read(MINT, 0);
    expect(a.source).toBe("none");
    expect(a.complete).toBe(true);
    gone.curves.stop();
  });

  it("follows the PumpSwap pool after bonding, pairing both vaults of a slot into one price", async () => {
    const t = setup({
      stream: true,
      states: [state(5e10, true)],
      pool: { vaults: VAULTS, amounts: [2e14, 8e10] },
    });
    t.cover(t.at());
    const a = await t.curves.read(MINT, 0);
    expect(a).toMatchObject({ venue: "pool", complete: false, source: "stream" });
    expect(t.watched).toEqual(new Set([`pool-base:${MINT}`, `pool-quote:${MINT}`, `pool-account:${MINT}`]));
    const poolMcap = (quote: number, base: number) =>
      curveMcapSol({ virtualQuote: quote, virtualToken: base }) * 100;
    expect(a.ticks[a.ticks.length - 1]![1]).toBeCloseTo(poolMcap(8e10, 2e14));
    // A buy: SOL in, coins out, in one slot: one new price, not a half-made one in between.
    t.tick(400);
    t.pushVault("quote", 90_000_000_000n, 7);
    t.pushVault("base", 190_000_000_000_000n, 7);
    const b = await t.curves.read(MINT, t.at() - 1);
    expect(b.ticks).toHaveLength(1);
    expect(b.ticks[0]![1]).toBeCloseTo(poolMcap(9e10, 1.9e14));
    // Covered by the stream: no more vault reads.
    t.tick(READ_EVERY_MS * 3);
    await t.curves.round();
    expect(t.poolReads).toHaveLength(1);
    t.curves.stop();
  });

  it("prices a pool on its quote vault plus the pool's virtual quote reserve", async () => {
    // As 6AZCEf's PUMP pool read on 2026-10-19, in SOL units here: 2.77 in the vault, 0.49 virtual.
    const t = setup({
      stream: true,
      states: [state(5e10, true)],
      pool: { vaults: { ...VAULTS, virtualQuote: 4.9e8 }, amounts: [1.54e14, 2.77e9] },
    });
    t.cover(t.at());
    const a = await t.curves.read(MINT, 0);
    const poolMcap = (quote: number, base: number) =>
      curveMcapSol({ virtualQuote: quote, virtualToken: base }) * 100;
    expect(a.ticks.at(-1)![1]).toBeCloseTo(poolMcap(2.77e9 + 4.9e8, 1.54e14));
    // The reserve moves on the pool account, which the stream follows too.
    t.tick(400);
    t.pushPool(500_000_000n);
    const b = await t.curves.read(MINT, t.at() - 1);
    expect(b.ticks.at(-1)![1]).toBeCloseTo(poolMcap(2.77e9 + 5e8, 1.54e14));
    t.curves.stop();
  });

  it("goes on to the pool from a curve emptied at graduation, as Pump.fun leaves it", async () => {
    const emptied: CurveState = {
      virtualToken: 0,
      virtualQuote: 0,
      realQuote: 0,
      complete: true,
      quoteIsSol: true,
    };
    const t = setup({ states: [emptied], pool: { vaults: VAULTS, amounts: [2e14, 8e10] } });
    const a = await t.curves.read(MINT, 0);
    expect(a).toMatchObject({ venue: "pool", complete: false });
    expect(a.ticks).toHaveLength(1);
    expect(a.ticks[0]![1]).toBeCloseTo(curveMcapSol({ virtualQuote: 8e10, virtualToken: 2e14 }) * 100);
    t.curves.stop();
  });

  it("prices a curve paired with another coin at that coin's USD price", async () => {
    const SPCX = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";
    // 52.6 SPCX (6 decimals) against 465M tokens, SPCX at $145.
    const paired: CurveState = {
      virtualToken: 465_090_932_988_809,
      virtualQuote: 52_637_853,
      realQuote: 0,
      complete: false,
      quoteIsSol: false,
      quoteMint: SPCX,
    };
    const priced = setup({
      states: [paired],
      quotePrice: { get: async (mint) => (mint === SPCX ? { usd: 145, decimals: 6 } : null) },
    });
    const a = await priced.curves.read(MINT, 0);
    expect(a).toMatchObject({ source: "rpc", complete: false });
    expect(a.ticks[0]![1]).toBeCloseTo((52_637_853 / 465_090_932_988_809) * 1e9 * 145, 0);
    priced.curves.stop();
    // With nothing to price its quote, it isn't followed.
    const unpriced = setup({ states: [paired] });
    expect((await unpriced.curves.read(MINT, 0)).source).toBe("none");
    unpriced.curves.stop();
  });

  it("follows a Stonks coin's LaunchLab pool where there is no Pump.fun curve", async () => {
    const onPool: CurveState = { ...state(6e10), quoteIsSol: true };
    let scans = 0;
    const curves = new LiveCurves({
      makeStream: null,
      reader: {
        getCurveStatesBatch: async (list: string[]) =>
          new Map(list.map((c) => [c, c === "ll-pool" ? onPool : null])),
        findLaunchLabPool: async () => {
          scans += 1;
          return "ll-pool";
        },
      },
      solPrice: { get: async () => 100 },
    });
    // The first answer waits for the scan and the pool's first read (discovery, then prices).
    const a = await curves.read(MINT, 0);
    expect(a).toMatchObject({ source: "rpc", complete: false });
    await curves.round();
    expect(a.ticks[0]![1]).toBeCloseTo(curveMcapSol(onPool) * 100);
    expect(scans).toBe(1);
    curves.stop();
  });

  it("follows a graduated Stonks coin's Raydium CPMM pool", async () => {
    const graduated: CurveState = { ...state(0), virtualToken: 0, virtualQuote: 0, complete: true };
    const curves = new LiveCurves({
      makeStream: null,
      reader: {
        getCurveStatesBatch: async (list: string[]) =>
          new Map(list.map((c) => [c, c === "ll-pool" ? graduated : null])),
        findLaunchLabPool: async () => "ll-pool",
        findCpmmPoolVaults: async () => VAULTS,
        getPoolVaultsBatch: async () => new Map(),
        getTokenAmountsBatch: async (list: string[]) =>
          new Map(list.map((a) => [a, a === VAULTS.base ? 2e14 : 8e10])),
      },
      solPrice: { get: async () => 100 },
    });
    await curves.read(MINT, 0);
    await curves.round();
    await curves.round();
    const a = await curves.read(MINT, 0);
    expect(a).toMatchObject({ venue: "pool", complete: false });
    expect(a.ticks[a.ticks.length - 1]![1]).toBeCloseTo(
      curveMcapSol({ virtualQuote: 8e10, virtualToken: 2e14 }) * 100,
    );
    curves.stop();
  });

  it("reads a pool by RPC every READ_EVERY_MS off the stream", async () => {
    const t = setup({ states: [state(5e10, true)], pool: { vaults: VAULTS, amounts: [2e14, 8e10] } });
    expect(await t.curves.read(MINT, 0)).toMatchObject({ venue: "pool", complete: false, source: "rpc" });
    t.tick(READ_EVERY_MS);
    await t.curves.round();
    expect(t.poolReads).toHaveLength(2);
    t.curves.stop();
  });

  it("stops after bonding when there is no SOL pool to follow", async () => {
    const t = setup({ states: [state(5e10, true)], pool: { vaults: null, amounts: [0, 0] } });
    expect(await t.curves.read(MINT, 0)).toMatchObject({ complete: true });
    t.curves.stop();
  });

  it("lets a curve go once nobody asks", async () => {
    const t = setup({ stream: true });
    await t.curves.read(MINT, 0);
    expect(t.watched.size).toBe(1);
    t.tick(31_000);
    await t.curves.round();
    expect(t.watched.size).toBe(0);
    expect(t.curves.stats().followed).toBe(0);
    t.curves.stop();
  });
});

describe("LiveCurves.history (the chart's own candles)", () => {
  it("answers a followed coin's ticks in USD without following anything", async () => {
    const t = setup();
    expect(await t.curves.history(MINT)).toBeNull();
    expect(t.curves.stats().followed).toBe(0);
    await t.curves.read(MINT, 0);
    const h = await t.curves.history(MINT);
    expect(h?.ticks).toEqual([[t.at(), curveMcapSol(state(5e10)) * 100]]);
    expect(h?.coveredFrom).toBe(t.at());
    t.curves.stop();
  });
});

describe("SolPrice", () => {
  it("falls through to the next source and keeps the last price when all fail", async () => {
    let now = 0;
    let jupiterUp = false;
    const price = new SolPrice(
      [
        {
          name: "jupiter",
          read: async () => {
            if (!jupiterUp) throw new Error("429");
            return 101;
          },
        },
        { name: "coinbase", read: async () => (now < 100_000 ? 100 : Number.NaN) },
      ],
      60_000,
      10_000,
      () => now,
    );
    expect(await price.get()).toBe(100);
    expect(price.source()).toBe("coinbase");
    expect(price.readAt()).toBe(new Date(0).toISOString());
    now = 120_000;
    expect(await price.get()).toBe(100);
    await new Promise((r) => setTimeout(r, 0));
    // Every source failed: the kept price still says when it was read.
    expect(price.readAt()).toBe(new Date(0).toISOString());
    jupiterUp = true;
    now = 125_000;
    // Still inside the retry wait after the failure.
    expect(await price.get()).toBe(100);
    now = 131_000;
    // A stale price is served while the refresh runs; the next read has the new one.
    expect(await price.get()).toBe(100);
    await new Promise((r) => setTimeout(r, 0));
    expect(await price.get()).toBe(101);
    expect(price.readAt()).toBe(new Date(131_000).toISOString());
  });
});

describe("LiveCurves stream checks (audit 2026-10-19, item 3)", () => {
  it("keeps readAt at the last real read: an ask doesn't move it, a matching check does", async () => {
    const t = setup({ stream: true });
    t.cover(t.at());
    const seededAt = t.at();
    expect(await t.curves.read(MINT, 0)).toMatchObject({ source: "stream", readAt: seededAt });
    t.tick(5_000);
    expect((await t.curves.read(MINT, 0)).readAt).toBe(seededAt);
    // Quiet coin, healthy stream: the check every VERIFY_EVERY_MS matches and moves readAt.
    t.tick(VERIFY_EVERY_MS - 5_000);
    await t.curves.round();
    expect(t.reads).toHaveLength(2);
    expect(await t.curves.read(MINT, 0)).toMatchObject({ source: "stream", readAt: t.at() });
    expect(t.health.snapshot().stream).toMatchObject({ verified: 1, mismatches: 0 });
    // Not again until the next VERIFY_EVERY_MS.
    t.tick(1_000);
    await t.curves.round();
    expect(t.reads).toHaveLength(2);
    t.curves.stop();
  });

  it("drops a cover the stream silently lost, records the read and resubscribes", async () => {
    const t = setup({ stream: true });
    t.cover(t.at());
    await t.curves.read(MINT, 0);
    // A trade the stream never delivered.
    t.next(state(7e10));
    t.tick(VERIFY_EVERY_MS);
    const checkedAt = t.at();
    await t.curves.round();
    // Held for the grace: the change may still be on its way.
    expect(t.resubscribed).toEqual([]);
    expect((await t.curves.read(MINT, 0)).source).toBe("stream");
    t.tick(VERIFY_GRACE_MS);
    await t.curves.round();
    expect(t.resubscribed).toEqual([`chart:${MINT}`]);
    expect(t.health.snapshot().stream.mismatches).toBe(1);
    const a = await t.curves.read(MINT, 0);
    expect(a.source).toBe("rpc");
    expect(a.ticks.find(([at]) => at === checkedAt)?.[1]).toBeCloseTo(curveMcapSol(state(7e10)) * 100);
    // Off the stream: read by RPC every READ_EVERY_MS until the new subscription covers it.
    const reads = t.reads.length;
    t.tick(READ_EVERY_MS);
    await t.curves.round();
    expect(t.reads.length).toBe(reads + 1);
    t.tick(100);
    t.cover(t.at());
    await t.curves.round();
    expect((await t.curves.read(MINT, 0)).source).toBe("stream");
    t.curves.stop();
  });

  it("keeps the cover when a delivery explains the difference within the grace", async () => {
    const t = setup({ stream: true });
    t.cover(t.at());
    await t.curves.read(MINT, 0);
    t.next(state(7e10));
    t.tick(VERIFY_EVERY_MS);
    await t.curves.round();
    t.tick(300);
    t.push(curveData(1_000_000_000_000_000n, 70_000_000_000n));
    t.tick(VERIFY_GRACE_MS);
    await t.curves.round();
    expect(t.resubscribed).toEqual([]);
    expect(t.health.snapshot().stream.mismatches).toBe(0);
    expect((await t.curves.read(MINT, 0)).source).toBe("stream");
    t.curves.stop();
  });

  it("checks a streamed pool's vaults the same way", async () => {
    const t = setup({
      stream: true,
      states: [state(5e10, true)],
      pool: { vaults: VAULTS, amounts: [2e14, 8e10] },
    });
    t.cover(t.at());
    expect(await t.curves.read(MINT, 0)).toMatchObject({ venue: "pool", source: "stream" });
    t.nextAmounts(1.9e14, 9e10);
    t.tick(VERIFY_EVERY_MS);
    await t.curves.round();
    t.tick(VERIFY_GRACE_MS);
    await t.curves.round();
    expect(t.resubscribed).toEqual([`pool-base:${MINT}`, `pool-quote:${MINT}`, `pool-account:${MINT}`]);
    expect(t.health.snapshot().stream.mismatches).toBe(1);
    const a = await t.curves.read(MINT, 0);
    expect(a.source).toBe("rpc");
    expect(a.ticks.at(-1)![1]).toBeCloseTo(curveMcapSol({ virtualQuote: 9e10, virtualToken: 1.9e14 }) * 100);
    t.curves.stop();
  });

  it("counts every live tail answer by source", async () => {
    const t = setup({ stream: true });
    t.cover(t.at());
    await t.curves.read(MINT, 0);
    await t.curves.read(MINT, 0);
    expect(t.health.snapshot().liveTail).toEqual({ answers: 2, bySource: { stream: 2 } });
    t.curves.stop();
  });
});

describe("LiveCurves follows (audit 2026-10-19, items 10 and 11)", () => {
  const mintOf = (i: number) => {
    const bytes = new Uint8Array(32);
    bytes[0] = 7;
    new DataView(bytes.buffer).setUint32(1, i);
    return bs58.encode(bytes);
  };

  it("never lets a feed card's follow evict an open chart", async () => {
    const curves = new LiveCurves({
      makeStream: null,
      reader: { getCurveStatesBatch: async (list: string[]) => new Map(list.map((c) => [c, state(5e10)])) },
      solPrice: { get: async () => 100 },
      health: new ChartHealth(),
    });
    const charts = Array.from({ length: 150 }, (_, i) => mintOf(i));
    for (const mint of charts) await curves.read(mint, 0);
    await curves.quotes(
      Array.from({ length: MAX_FOLLOWED }, (_, i) => mintOf(10_000 + i)),
      0,
    );
    expect(curves.stats()).toMatchObject({ followed: MAX_FOLLOWED, charts: 150 });
    // Each chart is still followed: its next answer comes straight from its tape.
    for (const mint of charts.slice(0, 5)) expect((await curves.read(mint, 0)).ticks).toHaveLength(1);
    curves.stop();
  });

  it("answers a chart while another coin's pool scan hangs", async () => {
    const OTHER = mintOf(1);
    const curves = new LiveCurves({
      makeStream: null,
      reader: {
        getCurveStatesBatch: async (list: string[]) =>
          new Map(list.map((c) => [c, c === pumpCurve(OTHER) ? null : state(5e10)])),
        // A program scan that never comes back.
        findLaunchLabPool: () => new Promise<never>(() => {}),
      },
      solPrice: { get: async () => 100 },
      health: new ChartHealth(),
    });
    // The other coin's first answer waits out its seed, its scan still out.
    await curves.read(OTHER, 0);
    const started = Date.now();
    const a = await curves.read(MINT, 0);
    expect(a).toMatchObject({ source: "rpc" });
    expect(Date.now() - started).toBeLessThan(1_000);
    curves.stop();
  });
});

describe("LiveCurves.quotes (the feed cards' Now)", () => {
  it("puts the cap on the supply now once burns have taken some of the billion", async () => {
    const t = setup({ supplies: { [MINT]: 950_000_000 } });
    const q = await t.curves.quotes([MINT], 2_500);
    const mcap = curveMcapSol(state(5e10)) * 100;
    expect(q.get(MINT)!.marketCapUsd).toBeCloseTo(mcap * 0.95);
    // The price is the curve's, whatever the supply.
    expect(q.get(MINT)!.priceUsd).toBeCloseTo(mcap / 1e9);
    const live = await t.curves.read(MINT, 0);
    expect(live.ticks.at(-1)![1]).toBeCloseTo(mcap * 0.95);
  });

  it("prices a coin still on its curve in USD, and marks it on the curve", async () => {
    const t = setup();
    expect(t.curves.onCurve(MINT)).toBe(false);
    const q = await t.curves.quotes([MINT], 2_500);
    const mcap = curveMcapSol(state(5e10)) * 100;
    expect(q.get(MINT)).toEqual({ marketCapUsd: mcap, priceUsd: mcap / 1e9, at: t.at() });
    expect(t.curves.onCurve(MINT)).toBe(true);
    // Reads failing from here: once the price is no longer current, DexScreener prices it again.
    t.tick(20_000);
    expect(t.curves.onCurve(MINT)).toBe(false);
    expect((await t.curves.quotes([MINT], 0)).size).toBe(0);
    t.curves.stop();
  });

  it("leaves out graduated coins and mints with no curve, for DexScreener to price", async () => {
    const graduated = setup({ states: [state(5e10, true)] });
    expect((await graduated.curves.quotes([MINT], 2_500)).size).toBe(0);
    expect(graduated.curves.onCurve(MINT)).toBe(false);
    graduated.curves.stop();
    const none = setup({ states: [null] });
    expect((await none.curves.quotes([MINT], 2_500)).size).toBe(0);
    none.curves.stop();
  });

  it("stamps a streamed curve with its last delivery, not the ask", async () => {
    const t = setup({ stream: true });
    t.cover(t.at() - 1);
    const seededAt = t.at();
    await t.curves.quotes([MINT], 2_500);
    t.tick(5_000);
    expect((await t.curves.quotes([MINT], 2_500)).get(MINT)?.at).toBe(seededAt);
    t.push(curveData(1_000_000_000_000_000n, 50_000_000_000n));
    expect((await t.curves.quotes([MINT], 2_500)).get(MINT)?.at).toBe(t.at());
    t.curves.stop();
  });
});

describe("QuotePrice", () => {
  it("reuses a price for its ttl, and keeps the last one through a failed read", async () => {
    let now = 0;
    let calls = 0;
    let fail = false;
    const q = new QuotePrice(
      async () => {
        calls += 1;
        if (fail) throw new Error("down");
        return { usd: 145, decimals: 6 };
      },
      30_000,
      10_000,
      () => now,
    );
    expect(await q.get("SPCX")).toEqual({ usd: 145, decimals: 6 });
    await q.get("SPCX");
    expect(calls).toBe(1);
    now = 31_000;
    fail = true;
    expect(await q.get("SPCX")).toEqual({ usd: 145, decimals: 6 });
    await Promise.resolve();
    expect(await q.get("SPCX")).toEqual({ usd: 145, decimals: 6 });
  });
});
