import { describe, expect, it } from "vitest";
import {
  CandleCache,
  KeyedCache,
  markedWallets,
  MAX_MARKED_WALLETS,
  parseLiveTrades,
  parseMcapCandles,
  withLiveTrades,
  type ActivityRow,
  type McapCandle,
} from "./tokenChart.js";

describe("parseMcapCandles", () => {
  it("prices candles as market cap, oldest first, dropping unusable ones", () => {
    const out = parseMcapCandles([
      { timestamp: 120_000, open: "0.00002", high: "0.00003", low: "0.00001", close: "0.000025" },
      { timestamp: 60_000, open: "0.00001", high: "0.00001", low: "0.00001", close: "0.00001" },
      { timestamp: 180_000, open: "0", high: "1", low: "0", close: "1" },
      { timestamp: "x", open: "1", high: "1", low: "1", close: "1" },
    ]);
    expect(out.map((c) => c.t)).toEqual([60_000, 120_000]);
    expect(out[1]!.c).toBeCloseTo(25_000);
    expect(out[1]!.h).toBeCloseTo(30_000);
  });

  it("widens a high or low that doesn't bracket the open and close", () => {
    const [c] = parseMcapCandles([{ timestamp: 1, open: 2, high: 1, low: 3, close: 2.5 }], 1);
    expect(c).toMatchObject({ h: 2.5, l: 2 });
  });

  it("answers a non-array body with no candles", () => {
    expect(parseMcapCandles({ error: "nope" })).toEqual([]);
  });
});

describe("CandleCache", () => {
  const candle: McapCandle = { t: 1, o: 1, h: 1, l: 1, c: 1 };

  it("shares one call per coin within the TTL", async () => {
    let calls = 0;
    let now = 0;
    const cache = new CandleCache(
      async () => {
        calls++;
        return [candle];
      },
      { ttlMs: 1000, now: () => now },
    );
    await Promise.all([cache.get("a"), cache.get("a"), cache.get("a")]);
    expect(calls).toBe(1);
    now = 1500;
    await cache.get("a");
    expect(calls).toBe(2);
  });

  it("answers null over the call budget, or the expired answer when it has one", async () => {
    let now = 0;
    const cache = new CandleCache(async () => [candle], { ttlMs: 10, callsPerMinute: 1, now: () => now });
    expect(await cache.get("a")).toEqual([candle]);
    expect(await cache.get("b")).toBeNull();
    now = 20;
    expect(await cache.get("a")).toEqual([candle]);
    now = 61_000;
    expect(await cache.get("b")).toEqual([candle]);
  });

  it("turns a failed call into null and retries it soon", async () => {
    let now = 0;
    let fail = true;
    const cache = new CandleCache(
      async () => {
        if (fail) throw new Error("down");
        return [candle];
      },
      { ttlMs: 60_000, now: () => now },
    );
    expect(await cache.get("a")).toBeNull();
    fail = false;
    now = 6_000;
    expect(await cache.get("a")).toEqual([candle]);
  });

  it("forgets the least recently read coin past its size", async () => {
    let calls = 0;
    const cache = new CandleCache(
      async () => {
        calls++;
        return [candle];
      },
      { maxEntries: 2, now: () => 0 },
    );
    await cache.get("a");
    await cache.get("b");
    await cache.get("a");
    await cache.get("c");
    expect(calls).toBe(3);
    await cache.get("a");
    expect(calls).toBe(3);
    await cache.get("b");
    expect(calls).toBe(4);
  });
});

describe("markedWallets", () => {
  const row = (wallet: string, extra: Partial<ActivityRow> = {}): ActivityRow => ({
    wallet,
    isCreator: false,
    solIn: 1,
    solOut: 0,
    heldPctAtAnchor: null,
    firstBuyAt: new Date(1_000),
    firstSellAt: null,
    trades: null,
    ...extra,
  });
  const opts = { riskyScore: 70, dumperDumps: 2 };

  it("marks risky wallets, known dumpers, linked wallets and the creator, and no one else", () => {
    const risk = new Map([
      ["risky", { score: 82, dumps: 1, appearances: 6 }],
      ["dumper", { score: 55, dumps: 3, appearances: 9 }],
      ["calm", { score: 20, dumps: 0, appearances: 4 }],
    ]);
    const out = markedWallets(
      [
        row("risky"),
        row("dumper"),
        row("calm"),
        row("linked"),
        row("dev", { isCreator: true }),
        row("nobody"),
      ],
      risk,
      [{ funder: "F", wallets: [{ wallet: "linked" }] }],
      opts,
    );
    expect(out.map((w) => w.wallet)).toEqual(["dev", "risky", "dumper", "linked"]);
    expect(out.find((w) => w.wallet === "linked")).toMatchObject({
      tags: ["linked"],
      funder: "F",
      score: null,
    });
    expect(out.find((w) => w.wallet === "dumper")!.tags).toEqual(["dumper"]);
  });

  it("marks a known KOL with its name, ahead of unscored linked wallets", () => {
    const out = markedWallets(
      [row("linked"), row("kol"), row("anon-kol"), row("nobody")],
      new Map(),
      [{ funder: "F", wallets: [{ wallet: "linked" }] }],
      opts,
      new Map<string, string | null>([
        ["kol", "Cupsey"],
        ["anon-kol", null],
      ]),
    );
    expect(out.map((w) => [w.wallet, w.tags, w.kol])).toEqual([
      ["kol", ["kol"], "Cupsey"],
      ["anon-kol", ["kol"], ""],
      ["linked", ["linked"], null],
    ]);
  });

  it("reads stored trades, dropping malformed ones, else falls back to first buy and sell", () => {
    const risk = new Map([
      ["a", { score: 90, dumps: 0, appearances: 3 }],
      ["b", { score: 90, dumps: 0, appearances: 3 }],
    ]);
    const [a, b] = markedWallets(
      [
        row("a", {
          trades: [
            [3_000, -1, 0.5, 10],
            [2_000, 1, 1.25, 20],
            ["x", 1, 1, 1],
            [4_000, 0, 1, 1],
          ],
        }),
        row("b", { firstBuyAt: new Date(5_000), firstSellAt: new Date(6_000), solIn: 0.5 }),
      ],
      risk,
      [],
      opts,
    );
    expect(a!.trades).toEqual([
      [2_000, 1, 1.25],
      [3_000, -1, 0.5],
    ]);
    expect(b!.trades).toEqual([
      [5_000, 1, null],
      [6_000, -1, null],
    ]);
  });

  it("caps the wallets kept", () => {
    const rows = Array.from({ length: MAX_MARKED_WALLETS + 5 }, (_, i) => row(`w${i}`));
    const risk = new Map(rows.map((r, i) => [r.wallet, { score: 70 + (i % 30), dumps: 0, appearances: 2 }]));
    const out = markedWallets(rows, risk, [], opts);
    expect(out).toHaveLength(MAX_MARKED_WALLETS);
    expect(out[0]!.score).toBe(99);
  });
});

describe("KeyedCache", () => {
  it("shares a fill per key in the TTL and forgets a failed one", async () => {
    let now = 0;
    let fills = 0;
    const cache = new KeyedCache<number>(1000, 10, () => now);
    const fill = async () => ++fills;
    expect(await Promise.all([cache.get("a", fill), cache.get("a", fill)])).toEqual([1, 1]);
    expect(await cache.get("b", fill)).toBe(2);
    now = 2000;
    expect(await cache.get("a", fill)).toBe(3);
    await expect(cache.get("c", () => Promise.reject(new Error("db")))).rejects.toThrow("db");
    expect(await cache.get("c", fill)).toBe(4);
  });
});

describe("withLiveTrades", () => {
  const opts = { riskyScore: 70, dumperDumps: 2 };
  const live = parseLiveTrades([
    { wallet: "Dumper", side: "sell", sol: 1.5, atMs: 90_000, score: 40, dumps: 3 },
    { wallet: "Risky", side: "buy", sol: 2, atMs: 61_000, score: 80, dumps: 0 },
    { wallet: "Risky", side: "buy", sol: 2, atMs: 61_000, score: 80, dumps: 0 }, // a later reading's copy
    { wallet: "Dumper", side: "buy", sol: 1, atMs: 30_000, score: 40, dumps: 3 },
    { wallet: "Bad", side: "swap", sol: 1, atMs: 1 },
  ]);

  it("marks the live tape's wallets before the post-call tape has read the coin", () => {
    const out = withLiveTrades([], live, new Map(), opts);
    expect(out.map((w) => [w.wallet, w.tags, w.trades])).toEqual([
      ["Risky", ["risky"], [[61_000, 1, 2]]],
      [
        "Dumper",
        ["dumper"],
        [
          [30_000, 1, 1],
          [90_000, -1, 1.5],
        ],
      ],
    ]);
    expect(out[1]).toMatchObject({ solIn: 1, solOut: 1.5, score: 40, heldPct: null });
  });

  it("adds only the trades the post-call tape doesn't hold, and takes the current score", () => {
    const tape = markedWallets(
      [
        {
          wallet: "Risky",
          isCreator: false,
          solIn: 2,
          solOut: 3,
          heldPctAtAnchor: 1,
          firstBuyAt: null,
          firstSellAt: null,
          trades: [
            [60_500, 1, 2, 10],
            [200_000, -1, 3, 10],
          ],
        },
      ],
      new Map([["Risky", { score: 75, dumps: 0, appearances: 4 }]]),
      [],
      opts,
    );
    const risk = new Map([
      ["Risky", { score: 75, dumps: 0, appearances: 4 }],
      ["Dumper", { score: 20, dumps: 5, appearances: 9 }],
    ]);
    const out = withLiveTrades(tape, live, risk, opts);
    const risky = out.find((w) => w.wallet === "Risky")!;
    expect(risky.trades).toEqual([
      [60_500, 1, 2],
      [200_000, -1, 3],
    ]);
    expect(risky).toMatchObject({ solIn: 2, solOut: 3, heldPct: 1 });
    expect(out.find((w) => w.wallet === "Dumper")).toMatchObject({ score: 20, dumps: 5, coins: 9 });
  });
});
