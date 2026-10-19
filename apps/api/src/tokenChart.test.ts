import { describe, expect, it } from "vitest";
import {
  firstMinutes,
  CallBudget,
  CandleCache,
  drawableCandles,
  KeyedCache,
  markedWallets,
  MAX_MARKED_WALLETS,
  parseLiveTrades,
  onSupply,
  parseMcapCandles,
  withLiveTrades,
  withTrackedMarks,
  type ActivityRow,
  type McapCandle,
} from "./tokenChart.js";

describe("onSupply", () => {
  it("puts launch-billion candles on the supply left after burns, volume as it is", () => {
    const k = { t: 1, o: 100, h: 200, l: 50, c: 150, vol: 7 };
    expect(onSupply([k], 0.95)).toEqual([{ t: 1, o: 95, h: 190, l: 47.5, c: 142.5, vol: 7 }]);
    expect(onSupply([k], undefined)).toEqual([k]);
  });
});

describe("parseMcapCandles", () => {
  it("prices candles as market cap, oldest first, dropping unusable ones", () => {
    const out = parseMcapCandles([
      {
        timestamp: 120_000,
        open: "0.00002",
        high: "0.00003",
        low: "0.00001",
        close: "0.000025",
        volume: "412.5",
      },
      { timestamp: 60_000, open: "0.00001", high: "0.00001", low: "0.00001", close: "0.00001" },
      { timestamp: 180_000, open: "0", high: "1", low: "0", close: "1" },
      { timestamp: "x", open: "1", high: "1", low: "1", close: "1" },
    ]);
    expect(out.map((c) => c.t)).toEqual([60_000, 120_000]);
    expect(out[1]!.c).toBeCloseTo(25_000);
    expect(out[1]!.h).toBeCloseTo(30_000);
    expect(out[1]!.vol).toBeCloseTo(412.5);
    expect(out[0]!.vol).toBe(0);
  });

  it("widens a high or low that doesn't bracket the open and close", () => {
    const [c] = parseMcapCandles([{ timestamp: 1, open: 2, high: 1, low: 3, close: 2.5 }], 1);
    expect(c).toMatchObject({ h: 2.5, l: 2 });
  });

  it("drops candles with NaN, infinite or missing prices, so NaN never reaches the chart", () => {
    const out = parseMcapCandles([
      { timestamp: 1, open: "NaN", high: "1", low: "1", close: "1" },
      { timestamp: 2, open: "1", high: "Infinity", low: "1", close: "1" },
      { timestamp: 3, open: "1", high: "1", low: null, close: "1" },
      { timestamp: 4, open: "1", high: "1", low: "1", close: "-1" },
      { timestamp: 5, open: "1", high: "1", low: "1", close: "1", volume: "NaN" },
    ]);
    expect(out).toEqual([{ t: 5, o: 1e9, h: 1e9, l: 1e9, c: 1e9, vol: 0 }]);
  });

  it("answers a non-array body with no candles", () => {
    expect(parseMcapCandles({ error: "nope" })).toEqual([]);
  });
});

describe("firstMinutes", () => {
  const k = (t: number) => ({ t, o: 1, h: 1, l: 1, c: 1, vol: 0 });
  const launch = 1_000_000;

  it("keeps the candles of the first 15 minutes from the launch", () => {
    const candles = [k(launch + 2_000), k(launch + 60_000), k(launch + 899_000), k(launch + 900_000)];
    expect(firstMinutes(candles, launch)?.map((c) => c.t)).toEqual([
      launch + 2_000,
      launch + 60_000,
      launch + 899_000,
    ]);
  });

  it("starts at the first candle when the launch time is unknown", () => {
    expect(firstMinutes([k(5_000), k(5_000 + 900_000)], null)?.map((c) => c.t)).toEqual([5_000]);
  });

  it("gives null when the page no longer reaches back to the start", () => {
    expect(firstMinutes([k(launch + 5 * 60_000)], launch)).toBeNull();
    expect(firstMinutes([], launch)).toBeNull();
  });
});

describe("CandleCache", () => {
  const candle: McapCandle = { t: 1, o: 1, h: 1, l: 1, c: 1, vol: 0 };

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

  it("keeps serving the last good candles, marked stale, while a refresh fails", async () => {
    let now = 0;
    let fail = false;
    let calls = 0;
    const cache = new CandleCache(
      async () => {
        calls += 1;
        if (fail) throw new Error("429");
        return [candle];
      },
      { ttlMs: 6_000, now: () => now },
    );
    expect(await cache.read("a")).toEqual({ candles: [candle], stale: false });
    fail = true;
    now = 7_000;
    expect(await cache.read("a")).toEqual({ candles: [candle], stale: true });
    // Backing off the failure: no call, still the good candles.
    now = 8_000;
    expect(await cache.read("a")).toEqual({ candles: [candle], stale: true });
    expect(calls).toBe(2);
    fail = false;
    now = 13_000;
    expect(await cache.read("a")).toEqual({ candles: [candle], stale: false });
    expect(calls).toBe(3);
  });

  it("never swaps good candles for an empty or missing answer", async () => {
    let now = 0;
    let answer: McapCandle[] | null = [candle];
    const cache = new CandleCache(async () => answer, { ttlMs: 1_000, now: () => now });
    await cache.read("a");
    answer = null;
    now = 2_000;
    expect(await cache.read("a")).toEqual({ candles: [candle], stale: true });
    answer = [];
    now = 8_000;
    expect(await cache.get("a")).toEqual([candle]);
  });

  it("serves the last good candles over budget, and stops once they are too old", async () => {
    let now = 0;
    const cache = new CandleCache(async () => [candle], {
      ttlMs: 1_000,
      callsPerMinute: 1,
      maxStaleMs: 30_000,
      now: () => now,
    });
    await cache.read("a");
    now = 20_000;
    expect(await cache.read("a")).toEqual({ candles: [candle], stale: true });
    now = 40_000;
    expect(await cache.read("a")).toEqual({ candles: null, stale: false });
  });

  it("answers from the last good candles when the refresh is slow, without waiting it out", async () => {
    let now = 0;
    let release: (v: McapCandle[]) => void = () => {};
    let first = true;
    const cache = new CandleCache(
      async () => {
        if (first) {
          first = false;
          return [candle];
        }
        return new Promise<McapCandle[]>((r) => (release = r));
      },
      { ttlMs: 1_000, refreshWaitMs: 10, now: () => now },
    );
    await cache.read("a");
    now = 2_000;
    expect(await cache.read("a")).toEqual({ candles: [candle], stale: true });
    const newer = { ...candle, t: 2 };
    release([newer]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await cache.read("a")).toEqual({ candles: [newer], stale: false });
  });

  it("holds every cache sharing a budget to it", async () => {
    const shared = new CallBudget(2, () => 0);
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return [candle];
    };
    const one = new CandleCache(fetch, { shared, now: () => 0 });
    const two = new CandleCache(fetch, { shared, now: () => 0 });
    await one.get("a");
    await two.get("b");
    expect(await two.get("c")).toBeNull();
    expect(calls).toBe(2);
  });

  it("peeks at the kept candles without a call", async () => {
    let calls = 0;
    const cache = new CandleCache(async () => {
      calls += 1;
      return [candle];
    });
    expect(cache.peek("a")).toEqual({ candles: null, stale: false });
    await cache.get("a");
    expect(cache.peek("a")).toEqual({ candles: [candle], stale: false });
    expect(calls).toBe(1);
  });
});

describe("drawableCandles", () => {
  it("drops candles a chart can't draw, and zeroes a broken volume", () => {
    const ok = { t: 1, o: 1, h: 2, l: 1, c: 2, vol: 3 };
    expect(
      drawableCandles([
        ok,
        { ...ok, t: 2, c: Number.NaN },
        { ...ok, t: 3, h: Number.POSITIVE_INFINITY },
        { ...ok, t: 4, l: 0 },
        { ...ok, t: Number.NaN },
        { ...ok, t: 5, vol: Number.NaN },
      ]),
    ).toEqual([ok, { ...ok, t: 5, vol: 0 }]);
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
  const opts = { riskyScore: 70 };

  it("marks risky wallets, known dumpers, linked wallets and the creator, and no one else", () => {
    const risk = new Map([
      ["risky", { score: 82, dumps: 1, appearances: 6 }],
      ["dumper", { score: 55, dumps: 7, appearances: 9, dumper: true }],
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

  it("marks a KOL's funded wallets and Probable Sides, but never relabels a KOL", () => {
    const sides = new Map([
      ["funded", { kind: "funded" as const, kolWallet: "K", kolName: "Cupsey" }],
      ["probable", { kind: "probable" as const, kolWallet: "K", kolName: null }],
      ["kol", { kind: "probable" as const, kolWallet: "K2", kolName: null }],
    ]);
    const out = markedWallets(
      [row("linked"), row("probable"), row("funded"), row("kol"), row("nobody")],
      new Map(),
      [{ funder: "F", wallets: [{ wallet: "linked" }] }],
      opts,
      new Map<string, string | null>([["kol", "Ansem"]]),
      new Map(),
      sides,
    );
    expect(out.map((w) => [w.wallet, w.tags])).toEqual([
      ["kol", ["kol"]],
      ["probable", ["side"]],
      ["funded", ["side"]],
      ["linked", ["linked"]],
    ]);
    expect(out.find((w) => w.wallet === "funded")!.side).toEqual(sides.get("funded"));
    expect(out.find((w) => w.wallet === "kol")!.side).toBeUndefined();
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

  it("keeps a failed fill for failureTtlMs, so retries don't all rerun it", async () => {
    let now = 0;
    let fills = 0;
    const cache = new KeyedCache<number>(60_000, 10, () => now, 5_000);
    const failing = async () => {
      fills += 1;
      throw new Error("db");
    };
    await expect(cache.get("a", failing)).rejects.toThrow("db");
    await expect(cache.get("a", failing)).rejects.toThrow("db");
    expect(fills).toBe(1);
    now = 5_001;
    expect(await cache.get("a", async () => 7)).toBe(7);
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
      ["Dumper", { score: 20, dumps: 5, appearances: 9, dumper: true }],
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

describe("withTrackedMarks", () => {
  const row = (wallet: string, over: Partial<ActivityRowForTest> = {}): ActivityRowForTest => ({
    wallet,
    isCreator: false,
    solIn: 1,
    solOut: 0,
    heldPctAtAnchor: null,
    firstBuyAt: new Date(1_000),
    firstSellAt: null,
    trades: [[1_000, 1, 1]],
    ...over,
  });
  type ActivityRowForTest = Parameters<typeof withTrackedMarks>[1][number];
  const shared = markedWallets(
    [row("risky1")],
    new Map([["risky1", { score: 90, dumps: 0, appearances: 3 }]]),
    [],
    {
      riskyScore: 70,
    },
  );

  it("lays the reader's labels and their sides over the shared marks without changing them", () => {
    const before = JSON.stringify(shared);
    const out = withTrackedMarks(
      shared,
      [row("risky1"), row("mine"), row("funded")],
      [
        { wallet: "risky1", name: "Pal", category: "kol" },
        { wallet: "mine", name: "Mine", category: "tracked" },
      ],
      { funded: [{ kolWallet: "mine", kolName: "Mine", funded: true, tracked: "tracked" }] },
    );
    expect(JSON.stringify(shared)).toBe(before);
    expect(out.find((w) => w.wallet === "risky1")).toMatchObject({ tags: ["risky", "kol"], kol: "Pal" });
    expect(out.find((w) => w.wallet === "mine")).toMatchObject({ tags: ["tracked"], tracked: "Mine" });
    expect(out.find((w) => w.wallet === "funded")).toMatchObject({
      tags: ["side"],
      side: { kind: "funded", kolWallet: "mine", kolName: "Mine", tracked: "tracked" },
    });
  });

  it("adds nothing without labels", () => {
    expect(withTrackedMarks(shared, [row("mine")], [], {})).toEqual(shared);
  });
});
