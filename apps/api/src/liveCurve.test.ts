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

function setup(opts: { stream?: boolean; states?: (CurveState | null)[] } = {}) {
  let now = 1_000_000;
  const reads: string[][] = [];
  const states = [...(opts.states ?? [state(5e10)])];
  const watched = new Set<string>();
  let covered: number | null = null;
  let onAccount: ((key: string, data: string) => void) | null = null;
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
    push: (data: string) => onAccount!(`chart:${MINT}`, data),
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
    jupiterUp = true;
    now = 125_000;
    // Still inside the retry wait after the failure.
    expect(await price.get()).toBe(100);
    now = 131_000;
    expect(await price.get()).toBe(101);
  });
});
