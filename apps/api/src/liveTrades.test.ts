import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { pumpCurveAddressOf, pumpSwapPoolOf } from "@trenchscanner/core";
import {
  LIVE_TRADES_PER_USER,
  LiveTrades,
  MAX_FOLLOWED,
  MAX_TRADES,
  quotedInSol,
  type LiveTradesDeps,
} from "./liveTrades.js";

const MINT = "BfWF6DxxfjdZPqjc2dPQvMd4CJh8Xr7ZPeP3iLh2pump";
const OTHER = "EMRjzAdUDeKZi6w32yGJiERb7W9spV6UuL7827zUpump";
const PUMP = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMP_TOKEN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
const AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WALLET = "29osZx6o2d3CQMpzajE8cyvB9EdYeGhmaFda13CMLoCL";
const WALLET2 = "A1p8rxcap2fsswEBAQwjzZ2LneiYHJcfA5H3udXKK9wy";

/** A Pump.fun TradeEvent as the curve logs it, inside its own frame (core's pumpTradeEvents.ts). */
function curveLogs(
  t: { mint?: string; wallet?: string; buy?: boolean; lamports?: bigint; tokens?: bigint; ts?: bigint },
  vSol = 50_000_000_000n,
  vTok = 500_000_000_000_000n,
): string[] {
  const data = Buffer.alloc(113);
  Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]).copy(data, 0);
  Buffer.from(bs58.decode(t.mint ?? MINT)).copy(data, 8);
  data.writeBigUInt64LE(t.lamports ?? 1_000_000_000n, 40);
  data.writeBigUInt64LE(t.tokens ?? 10_000_000_000n, 48);
  data[56] = t.buy === false ? 0 : 1;
  Buffer.from(bs58.decode(t.wallet ?? WALLET)).copy(data, 57);
  data.writeBigInt64LE(t.ts ?? 1_792_368_579n, 89);
  data.writeBigUInt64LE(vSol, 97);
  data.writeBigUInt64LE(vTok, 105);
  return [
    `Program ${PUMP} invoke [1]`,
    `Program data: ${data.toString("base64")}`,
    `Program ${PUMP} success`,
  ];
}

/** A PumpSwap SellEvent on `pool`, inside its own frame. */
function poolSellLogs(pool: string): string[] {
  const data = Buffer.alloc(184);
  Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]).copy(data, 0);
  const field = (i: number, v: bigint) => data.writeBigUInt64LE(v, 8 + i * 8);
  field(0, 1_792_368_600n);
  field(1, 5_000_000n); // 5 tokens in
  field(5, 1_000_000_000_000n);
  field(6, 100_000_000_000n);
  field(12, 500_000n);
  field(13, 490_000n);
  Buffer.from(bs58.decode(pool)).copy(data, 120);
  Buffer.from(bs58.decode(WALLET2)).copy(data, 152);
  return [`Program ${AMM} invoke [1]`, `Program data: ${data.toString("base64")}`, `Program ${AMM} success`];
}

function setup(
  opts: {
    stream?: boolean;
    sol?: number | null;
    reader?: LiveTradesDeps["reader"];
    quotePrice?: LiveTradesDeps["quotePrice"];
  } = {},
) {
  let now = 1_000_000;
  const watched = new Map<string, string>();
  let covered: number | null = null;
  let onLogs: ((key: string, signature: string, logs: string[], slot: number | null) => void) | null = null;
  let started = 0;
  let stopped = 0;
  const trades = new LiveTrades({
    makeStream:
      opts.stream === false
        ? null
        : (cb) => {
            onLogs = cb;
            return {
              start: () => void (started += 1),
              stop: () => void (stopped += 1),
              watch: (key: string, accounts: readonly string[], _now?: number, kind?: string) => {
                expect(kind).toBe("logs");
                watched.set(key, accounts[0]!);
              },
              unwatch: (key: string) => void watched.delete(key),
              coveredSince: (key: string, account: string) => (watched.get(key) === account ? covered : null),
            };
          },
    solPrice: { get: async () => (opts.sol === undefined ? 100 : opts.sol) },
    reader: opts.reader,
    quotePrice: opts.quotePrice,
    now: () => now,
  });
  return {
    trades,
    watched,
    tick: (ms: number) => (now += ms),
    at: () => now,
    cover: (since: number | null) => (covered = since),
    push: (key: string, sig: string, logs: string[]) => onLogs!(key, sig, logs, 1),
    sockets: () => ({ started, stopped }),
  };
}

describe("LiveTrades", () => {
  it("lets the chart's candles read a followed coin's trades without following anything", async () => {
    const t = setup();
    expect(await t.trades.recent(MINT)).toBeNull();
    expect(t.watched.size).toBe(0);
    t.cover(t.at());
    await t.trades.read(MINT, 0);
    t.push(`trades-curve:${MINT}`, "sig-1", curveLogs({}));
    const r = await t.trades.recent(MINT);
    expect(r?.since).toBe(t.at());
    expect(r?.trades).toHaveLength(1);
    expect(r?.trades[0]?.mcapUsd).toBeGreaterThan(0);
    // A read of it isn't an ask: the coin is still let go once nobody asks.
    t.tick(31_000);
    await t.trades.recent(MINT);
    t.trades.round();
    expect(await t.trades.recent(MINT)).toBeNull();
    t.trades.stop();
  });

  it("follows a coin's curve and pool logs, pending until both are live", async () => {
    const t = setup();
    const a = await t.trades.read(MINT, 0);
    expect(a).toEqual({ status: "pending", since: null, cursor: 0, trades: [], held: false });
    expect(t.watched.get(`trades-curve:${MINT}`)).toBe(pumpCurveAddressOf(MINT));
    expect(t.watched.get(`trades-pool:${MINT}`)).toBe(pumpSwapPoolOf(MINT));
    t.cover(t.at());
    const b = await t.trades.read(MINT, 0);
    expect(b.status).toBe("live");
    expect(b.since).toBe(t.at());
    t.trades.stop();
  });

  it("answers unavailable with no stream, and for a string that isn't a mint", async () => {
    const off = setup({ stream: false });
    expect(await off.trades.read(MINT, 0, 5_000)).toEqual({
      status: "unavailable",
      since: null,
      cursor: 0,
      trades: [],
      held: false,
    });
    const on = setup();
    expect((await on.trades.read("not-a-mint", 0)).status).toBe("unavailable");
    on.trades.stop();
  });

  it("keeps each trade once, with its market cap, and sends only those after the cursor", async () => {
    const t = setup();
    t.cover(t.at());
    await t.trades.read(MINT, 0);
    t.push(`trades-curve:${MINT}`, "sig-1", curveLogs({}));
    // The same transaction from the pool's key too, and another coin's trade: neither is added.
    t.push(`trades-pool:${MINT}`, "sig-1", curveLogs({}));
    t.push(`trades-curve:${MINT}`, "sig-x", curveLogs({ mint: OTHER }));
    const a = await t.trades.read(MINT, 0);
    expect(a.trades).toHaveLength(1);
    // 50 SOL over 500M tokens: 1e-7 SOL a token, a billion of them at $100 a SOL.
    expect(a.trades[0]).toMatchObject({
      sig: "sig-1",
      wallet: WALLET,
      side: "buy",
      sol: 1,
      tokens: 10_000,
      atMs: 1_792_368_579_000,
    });
    expect(a.trades[0]!.mcapUsd).toBeCloseTo(10_000);
    expect(a.cursor).toBe(a.trades[0]!.seq);

    t.push(`trades-pool:${MINT}`, "sig-2", poolSellLogs(pumpSwapPoolOf(MINT)!));
    const b = await t.trades.read(MINT, a.cursor);
    expect(b.trades.map((x) => [x.sig, x.side, x.wallet, x.sol])).toEqual([
      ["sig-2", "sell", WALLET2, 0.00049],
    ]);
    expect(b.cursor).toBeGreaterThan(a.cursor);
    // A cursor from past anything this process gave out (a restart) reads as a fresh ask.
    expect((await t.trades.read(MINT, 1e9)).trades).toHaveLength(2);
    t.trades.stop();
  });

  it("prices a pool trade on the pool's quote vault plus its virtual quote reserve", async () => {
    const pool = pumpSwapPoolOf(MINT)!;
    const reader = {
      getCurveStatesBatch: async (curves: string[]) =>
        new Map(curves.map((c) => [c, { quoteIsSol: true, quoteMint: null }])),
      getPoolVaultsBatch: async (pools: ReadonlyMap<string, unknown>) =>
        new Map([...pools.keys()].map((p) => [p, { base: "b", quote: "q", virtualQuote: 500_000 }])),
    } as unknown as LiveTradesDeps["reader"];
    const t = setup({ reader });
    t.cover(t.at());
    await t.trades.read(MINT, 0);
    await t.trades.readPools();
    expect(t.watched.get(`trades-pool:${MINT}`)).toBe(pool);
    t.push(`trades-pool:${MINT}`, "sig-p", poolSellLogs(pool));
    const [trade] = (await t.trades.read(MINT, 0)).trades;
    // 99_999.5 SOL in the vault after the sell, plus the 0.0005 virtual: 100 SOL over 1_000_005 tokens.
    expect(trade!.sol).toBe(0.00049);
    expect(trade!.mcapUsd).toBeCloseTo((100 / 1_000_005) * 1e9 * 100);
    t.trades.stop();
  });

  it("follows a coin quoted in PUMP on its PUMP pool, and prices its trades in SOL", async () => {
    const pool = pumpSwapPoolOf(MINT, PUMP_TOKEN)!;
    const reader = {
      getCurveStatesBatch: async (curves: string[]) =>
        new Map(curves.map((c) => [c, { quoteIsSol: false, quoteMint: PUMP_TOKEN }])),
      getPoolVaultsBatch: async (pools: ReadonlyMap<string, { quoteMint: string }>) =>
        new Map(
          [...pools].map(([p, { quoteMint }]) => [
            p,
            quoteMint === PUMP_TOKEN ? { base: "b", quote: "q", virtualQuote: 500_000 } : null,
          ]),
        ),
    } as unknown as LiveTradesDeps["reader"];
    const t = setup({ reader, quotePrice: { get: async () => ({ usd: 0.005, decimals: 6 }) } });
    t.cover(t.at());
    await t.trades.read(MINT, 0);
    await t.trades.readPools();
    expect(t.watched.get(`trades-pool:${MINT}`)).toBe(pool);
    t.push(`trades-pool:${MINT}`, "sig-q", poolSellLogs(pool));
    const [trade] = (await t.trades.read(MINT, 0)).trades;
    // 0.49 PUMP at $0.005, SOL at $100; 100_000 PUMP over 1_000_005 tokens, a billion of them.
    expect(trade!.sol).toBeCloseTo((0.49 * 0.005) / 100);
    expect(trade!.mcapUsd).toBeCloseTo((100_000 / 1_000_005) * 0.005 * 1e9);
    t.trades.stop();
  });

  it("merges one wallet's split swaps in a transaction and keeps the newest MAX_TRADES", async () => {
    const t = setup({ sol: null });
    t.cover(t.at());
    await t.trades.read(MINT, 0);
    t.push(`trades-curve:${MINT}`, "split", [...curveLogs({}), ...curveLogs({})]);
    const a = await t.trades.read(MINT, 0);
    expect(a.trades).toHaveLength(1);
    expect(a.trades[0]).toMatchObject({ sol: 2, tokens: 20_000, mcapUsd: null });
    for (let i = 0; i < MAX_TRADES + 10; i += 1) t.push(`trades-curve:${MINT}`, `s${i}`, curveLogs({}));
    const b = await t.trades.read(MINT, 0);
    expect(b.trades).toHaveLength(MAX_TRADES);
    expect(b.trades[b.trades.length - 1]!.sig).toBe(`s${MAX_TRADES + 9}`);
    t.trades.stop();
  });

  it("holds an ask with a wait until the next trade", async () => {
    const t = setup();
    t.cover(t.at());
    const first = await t.trades.read(MINT, 0);
    const held = t.trades.read(MINT, first.cursor, 5_000);
    await new Promise((r) => setTimeout(r, 10));
    t.push(`trades-curve:${MINT}`, "sig-1", curveLogs({ buy: false }));
    const a = await held;
    expect(a.held).toBe(true);
    expect(a.trades.map((x) => x.side)).toEqual(["sell"]);
    t.trades.stop();
  });

  it("wakes a held ask when the coin's subscriptions go live, and lets go on abort", async () => {
    const t = setup();
    await t.trades.read(MINT, 0);
    const held = t.trades.read(MINT, 0, 5_000);
    await new Promise((r) => setTimeout(r, 10));
    t.cover(t.at());
    t.trades.round();
    expect((await held).status).toBe("live");

    const ctl = new AbortController();
    const waiting = t.trades.read(MINT, 0, 5_000, ctl.signal);
    ctl.abort();
    expect((await waiting).held).toBe(true);
    t.trades.stop();
  });

  it("lets a coin go after 30 s unasked, and closes the socket 2 minutes after the last", async () => {
    const t = setup();
    await t.trades.read(MINT, 0);
    expect(t.sockets().started).toBe(1);
    t.tick(31_000);
    t.trades.round();
    expect(t.watched.size).toBe(0);
    t.tick(60_000);
    t.trades.round();
    expect(t.sockets().stopped).toBe(0);
    t.tick(61_000);
    t.trades.round();
    expect(t.sockets().stopped).toBe(1);
    // The next page opens it again.
    await t.trades.read(MINT, 0);
    expect(t.sockets().started).toBe(2);
    t.trades.stop();
  });

  it("never lets a watched coin go for a new one: past 50 the new one is busy until one idles", async () => {
    const t = setup();
    const mints = Array.from({ length: 51 }, (_, i) => bs58.encode(Buffer.alloc(32, i + 1)));
    for (const m of mints.slice(0, 50)) {
      await t.trades.read(m, 0);
      t.tick(10);
    }
    expect(t.trades.stats().followed).toBe(MAX_FOLLOWED);
    expect(await t.trades.read(mints[50]!, 0, 5_000)).toMatchObject({
      status: "unavailable",
      reason: "busy",
      held: false,
    });
    expect(t.watched.has(`trades-curve:${mints[0]}`)).toBe(true);
    expect(t.watched.has(`trades-curve:${mints[50]}`)).toBe(false);
    // The first coin's page closed: once it has gone unasked past IDLE_MS, its slot is free.
    t.tick(20_000);
    for (const m of mints.slice(1, 50)) await t.trades.read(m, 0);
    t.tick(15_000);
    expect((await t.trades.read(mints[50]!, 0)).status).not.toBe("unavailable");
    expect(t.watched.has(`trades-curve:${mints[0]}`)).toBe(false);
    expect(t.trades.stats().followed).toBe(MAX_FOLLOWED);
    t.trades.stop();
  });

  it("lets one account follow at most four coins at once, and a fifth once one idles", async () => {
    const t = setup();
    const mints = Array.from({ length: 6 }, (_, i) => bs58.encode(Buffer.alloc(32, i + 1)));
    for (const m of mints.slice(0, LIVE_TRADES_PER_USER))
      expect((await t.trades.read(m, 0, 0, undefined, "u1")).status).not.toBe("unavailable");
    expect(await t.trades.read(mints[4]!, 0, 0, undefined, "u1")).toMatchObject({
      status: "unavailable",
      reason: "busy",
    });
    expect(t.watched.has(`trades-curve:${mints[4]}`)).toBe(false);
    // A coin it already follows still answers, and another account isn't held by its cap.
    expect((await t.trades.read(mints[0]!, 0, 0, undefined, "u1")).status).not.toBe("unavailable");
    expect((await t.trades.read(mints[4]!, 0, 0, undefined, "u2")).status).not.toBe("unavailable");
    // Its other three tabs go on asking; the second coin's closed. Past IDLE_MS it frees a slot.
    t.tick(20_000);
    for (const m of [mints[0]!, mints[2]!, mints[3]!]) await t.trades.read(m, 0, 0, undefined, "u1");
    t.tick(11_000);
    expect((await t.trades.read(mints[5]!, 0, 0, undefined, "u1")).status).not.toBe("unavailable");
    expect(await t.trades.read(mints[1]!, 0, 0, undefined, "u1")).toMatchObject({ reason: "busy" });
    t.trades.stop();
  });

  it("prices a trade in a quote coin in SOL, with the market cap it left", () => {
    // 19,749.77 PUMP at $0.0045 with SOL at $180: 0.49 SOL.
    const q = {
      mint: "pump",
      amount: 19_749_766_583,
      reserve: 2_763_738_546_166,
      tokenReserve: 309_321_957.3,
    };
    const priced = quotedInSol(q, { usd: 0.0045, decimals: 6 }, 180)!;
    expect(priced.sol).toBeCloseTo(0.4937, 3);
    // 2,763,738 PUMP over 309.3M tokens, times $0.0045, over the billion supply.
    expect(priced.mcapUsd).toBeCloseTo(40_207, -1);
    expect(quotedInSol(q, null, 180)).toBeNull();
    expect(quotedInSol(q, { usd: 0.0045, decimals: 6 }, null)).toBeNull();
  });
});
