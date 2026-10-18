import { describe, expect, it } from "vitest";
import type { CurveState } from "@trenchscanner/core";
import { curveMcapSol, LiveCurves, READ_EVERY_MS } from "./liveCurve.js";
import { SolPrice } from "./solPrice.js";

const MINT = "BfWF6DxxfjdZPqjc2dPQvMd4CJh8Xr7ZPeP3iLh2pump";
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

const VAULTS = { base: "base-vault", quote: "quote-vault" };

function setup(
  opts: {
    stream?: boolean;
    states?: (CurveState | null)[];
    /** After bonding: the pool's vaults (null: no pool) and their balances [base, quote]. */
    pool?: { vaults: typeof VAULTS | null; amounts: [number, number] };
  } = {},
) {
  let now = 1_000_000;
  const reads: string[][] = [];
  const states = [...(opts.states ?? [state(5e10)])];
  const watched = new Set<string>();
  let covered: number | null = null;
  let onAccount: ((key: string, data: string, slot: number | null) => void) | null = null;
  const poolReads: string[][] = [];
  const curves = new LiveCurves({
    makeStream: opts.stream
      ? (cb) => {
          onAccount = cb;
          return {
            start: () => {},
            stop: () => {},
            watch: (key: string) => void watched.add(key),
            unwatch: (key: string) => void watched.delete(key),
            coveredSince: (key: string) => (watched.has(key) ? covered : null),
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
            getPoolVaultsBatch: async (pools: ReadonlyMap<string, string>) =>
              new Map([...pools.keys()].map((p) => [p, opts.pool!.vaults])),
            getTokenAmountsBatch: async (list: string[]) => {
              poolReads.push(list);
              return new Map(
                list.map((a) => [a, a === VAULTS.base ? opts.pool!.amounts[0] : opts.pool!.amounts[1]]),
              );
            },
          }
        : {}),
    },
    solPrice: { get: async () => 100 },
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
    push: (data: string) => onAccount!(`chart:${MINT}`, data, null),
    pushVault: (side: "base" | "quote", amount: bigint, slot: number) =>
      onAccount!(`pool-${side}:${MINT}`, vaultData(amount), slot),
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
    expect(a.readAt).toBe(t.at());
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
    expect(t.watched).toEqual(new Set([`pool-base:${MINT}`, `pool-quote:${MINT}`]));
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
    now = 120_000;
    expect(await price.get()).toBe(100);
    await new Promise((r) => setTimeout(r, 0));
    jupiterUp = true;
    now = 125_000;
    // Still inside the retry wait after the failure.
    expect(await price.get()).toBe(100);
    now = 131_000;
    // A stale price is served while the refresh runs; the next read has the new one.
    expect(await price.get()).toBe(100);
    await new Promise((r) => setTimeout(r, 0));
    expect(await price.get()).toBe(101);
  });
});

describe("LiveCurves.quotes (the feed cards' Now)", () => {
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

  it("stamps a streamed curve as current at the ask", async () => {
    const t = setup({ stream: true });
    t.cover(t.at() - 1);
    await t.curves.quotes([MINT], 2_500);
    t.tick(5_000);
    const q = await t.curves.quotes([MINT], 2_500);
    expect(q.get(MINT)?.at).toBe(t.at());
    t.curves.stop();
  });
});
