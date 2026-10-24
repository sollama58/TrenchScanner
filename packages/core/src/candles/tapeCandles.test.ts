import { describe, expect, it } from "vitest";
import { PUMP_SUPPLY_TOKENS, type ChainTx, type TapeTrade } from "../wallets/tradeTape.js";
import { markPriceSol, markTapeTrades, tapeCandleRows } from "./tapeCandles.js";

const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
/** A real curve sell's event (pumpTradeEvents.test.ts, tx 3wK3u2u5WTZF...). */
const CURVE_SELL_DATA =
  "Program data: vdt/007mYe57UWQtYHszYJzT83b9CYgKJ7zrx5AJJkfG+wN0h58NH8TAZwAAAAAA1W9FzawkAAAAER1U4rad3LCdGm4TCdz0ZxpDgxOVt93LgYgQGyogGKHDX9VqAAAAAOEkuwYAAAAAzrbQUseFAgAf4TYEAAAAAM4evgY2hwEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAFT8AAAAAAAAixcXNVNntyTIgEFjuwzSQL4zAq4SExOv6UGOwli6+bseAAAAAAAAAK9PAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAHNlbGwBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADEwGcAAAAAAOEkuwYAAAAAH+E2BAAAAAAAAAAAAAAAAAAAAAAAAAAALYMqAAAAAAA=";
const CURVE_SELL_MINT = "9JP8XNc6tJ5M49AvAgdDwh9xUzjWNG5EgN3jUzWgpump";
const CURVE_SELL_PRICE = 0.112927969 / 710041087.817422;

const tx = (sig: string, logs: string[], err: unknown = null): ChainTx => ({
  blockTime: 1792368579,
  meta: { err, logMessages: logs },
  transaction: { signatures: [sig] },
});
const framed = (data: string) => [`Program ${PUMP} invoke [1]`, data, `Program ${PUMP} success`];

const trade = (atMs: number, sol: number, mark?: TapeTrade["mark"], tx = `t${atMs}`): TapeTrade => ({
  wallet: "w",
  side: "buy",
  sol,
  tokens: 1,
  atMs,
  tx,
  ...(mark ? { mark } : {}),
});

describe("markTapeTrades", () => {
  it("marks each trade with the price its transaction's swap event left", () => {
    const trades = [trade(1792368579000, 0.0068, undefined, "a"), trade(1792368579000, 1, undefined, "b")];
    const marked = markTapeTrades(CURVE_SELL_MINT, [tx("a", framed(CURVE_SELL_DATA)), tx("b", [])], trades);
    expect(marked).toBe(1);
    expect(trades[0]!.mark).toEqual({ curve: CURVE_SELL_PRICE });
    expect(trades[1]!.mark).toBeUndefined();
  });

  it("skips another coin's event and a failed transaction", () => {
    const trades = [trade(1, 1, undefined, "a"), trade(2, 1, undefined, "b")];
    const txs = [tx("a", framed(CURVE_SELL_DATA)), tx("b", framed(CURVE_SELL_DATA), { failed: 1 })];
    expect(markTapeTrades("EMRjzAdUDeKZi6w32yGJiERb7W9spV6UuL7827zUpump", txs, trades)).toBe(0);
    expect(markTapeTrades(CURVE_SELL_MINT, [txs[1]!], trades)).toBe(0);
  });
});

describe("markPriceSol", () => {
  it("prices a pool mark on its vaults plus the virtual quote reserve", () => {
    expect(markPriceSol({ quote: 80e9, base: 200_000_000e6 }, 20e9)).toBeCloseTo(100 / 200_000_000, 15);
    expect(markPriceSol({ quote: 80e9, base: 0 })).toBeNull();
    expect(markPriceSol({ curve: 0 })).toBeNull();
  });
});

describe("tapeCandleRows", () => {
  const SOL = 200;
  const mcap = (priceSol: number) => priceSol * PUMP_SUPPLY_TOKENS * SOL;
  const T0 = 1_792_368_000_000; // a whole minute

  it("folds marked trades into joined 1s bars with every trade's volume", () => {
    const trades = [
      trade(T0 + 1_000, 1, { curve: 1e-7 }),
      trade(T0 + 1_400, 2, { curve: 2e-7 }),
      trade(T0 + 1_700, 0.5),
      trade(T0 + 3_000, 1, { curve: 1.5e-7 }),
    ];
    const rows = tapeCandleRows("m", trades, { from: T0, to: T0 + 60_000 }, SOL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      mint: "m",
      res: 1,
      source: "tape",
      startAt: T0,
      coverFrom: T0,
      coverTo: T0 + 60_000,
    });
    expect(rows[0]!.bars).toEqual([
      { t: T0 + 1_000, o: mcap(1e-7), h: mcap(2e-7), l: mcap(1e-7), c: mcap(2e-7), vol: 3.5 * SOL },
      { t: T0 + 3_000, o: mcap(2e-7), h: mcap(2e-7), l: mcap(1.5e-7), c: mcap(1.5e-7), vol: 1 * SOL },
    ]);
  });

  it("opens the cover's first bar at the price before it and leaves out bars outside it", () => {
    const trades = [
      trade(T0 - 5_000, 1, { curve: 1e-7 }),
      trade(T0 + 2_000, 1, { curve: 3e-7 }),
      trade(T0 + 70_000, 1, { curve: 4e-7 }),
    ];
    const rows = tapeCandleRows("m", trades, { from: T0, to: T0 + 60_000 }, SOL);
    expect(rows.flatMap((r) => r.bars)).toEqual([
      { t: T0 + 2_000, o: mcap(1e-7), h: mcap(3e-7), l: mcap(1e-7), c: mcap(3e-7), vol: SOL },
    ]);
  });

  it("runs each chunk's cover on to the next chunk, so quiet minutes read as quiet", () => {
    const trades = [trade(T0 + 1_000, 1, { curve: 1e-7 }), trade(T0 + 600_000, 1, { curve: 2e-7 })];
    const rows = tapeCandleRows("m", trades, { from: T0, to: T0 + 900_000 }, SOL);
    expect(rows.map((r) => [r.startAt, r.coverFrom, r.coverTo])).toEqual([
      [T0, T0, T0 + 600_000],
      [T0 + 600_000, T0 + 600_000, T0 + 900_000],
    ]);
  });

  it("caps a quiet stretch's cover at four hours past the chunk", () => {
    const rows = tapeCandleRows(
      "m",
      [trade(T0 + 1_000, 1, { curve: 1e-7 })],
      { from: T0, to: T0 + 6 * 3_600_000 },
      SOL,
    );
    expect(rows[0]!.coverTo).toBe(T0 + 4 * 3_600_000);
  });

  it("prices each trade at SOL's price when it happened, when given one by time", () => {
    const trades = [trade(T0 + 1_000, 1, { curve: 1e-7 }), trade(T0 + 61_000, 1, { curve: 1e-7 })];
    const rows = tapeCandleRows("m", trades, { from: T0, to: T0 + 120_000 }, (at) =>
      at < T0 + 60_000 ? 100 : 200,
    );
    const bars = rows.flatMap((r) => r.bars);
    expect(bars.map((b) => [b.c, b.vol])).toEqual([
      [1e-7 * PUMP_SUPPLY_TOKENS * 100, 100],
      [1e-7 * PUMP_SUPPLY_TOKENS * 200, 200],
    ]);
  });

  it("saves nothing without a SOL price, a cover or a marked trade", () => {
    const trades = [trade(T0 + 1_000, 1, { curve: 1e-7 })];
    expect(tapeCandleRows("m", trades, { from: T0, to: T0 + 60_000 }, 0)).toEqual([]);
    expect(tapeCandleRows("m", trades, { from: T0, to: T0 }, SOL)).toEqual([]);
    expect(tapeCandleRows("m", [trade(T0 + 1_000, 1)], { from: T0, to: T0 + 60_000 }, SOL)).toEqual([]);
  });
});
