import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedTrade } from "@trenchscanner/core";

const decoded = vi.hoisted(() => ({ trades: [] as DecodedTrade[] }));
vi.mock("@trenchscanner/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@trenchscanner/core")>()),
  tradesFromLogs: vi.fn(() => decoded.trades),
}));

import { pumpCurveAddressOf, pumpSwapPoolOf } from "@trenchscanner/core";
import { CURVE_KEY_PREFIX, IDLE_MS, MAX_TRADES, POOL_KEY_PREFIX, TapeLogsFeed } from "./tapeLogsFeed.js";

// Real 32-byte mints: the feed derives each coin's curve and pool from them.
const MINT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT2 = "bwamJzztZsepfkteWRChggmXuiiCQvpLqPietdNfSXa";

function fakeStream() {
  const covered = new Map<string, number | null>();
  return {
    covered,
    watch: vi.fn(),
    unwatch: vi.fn(),
    coveredSince: vi.fn((key: string) => covered.get(key) ?? null),
  };
}

function trade(over: Partial<DecodedTrade> = {}): DecodedTrade {
  return { wallet: "w1", side: "buy", sol: 1, tokens: 1000, atMs: 10_000, priceSol: 0.001, ...over };
}

describe("tape logs feed", () => {
  beforeEach(() => {
    decoded.trades = [];
  });

  it("watches a followed coin's curve and pool logs, and lets it go once idle", () => {
    const stream = fakeStream();
    const feed = new TapeLogsFeed(stream, 10);
    feed.follow([MINT, "not-a-mint"], 0);
    expect(stream.watch).toHaveBeenCalledWith(CURVE_KEY_PREFIX + MINT, [pumpCurveAddressOf(MINT)], 0, "logs");
    expect(stream.watch).toHaveBeenCalledWith(POOL_KEY_PREFIX + MINT, [pumpSwapPoolOf(MINT)], 0, "logs");
    expect(stream.watch).toHaveBeenCalledTimes(2);

    feed.follow([MINT2], IDLE_MS);
    expect(stream.unwatch).not.toHaveBeenCalled();
    feed.follow([MINT2], IDLE_MS + 1);
    expect(stream.unwatch).toHaveBeenCalledWith(CURVE_KEY_PREFIX + MINT);
    expect(stream.unwatch).toHaveBeenCalledWith(POOL_KEY_PREFIX + MINT);
    expect(feed.takeStats(IDLE_MS + 1).logsCoins).toBe(1);
  });

  it("turns new coins away at its cap and counts them", () => {
    const feed = new TapeLogsFeed(fakeStream(), 1);
    feed.follow([MINT, MINT2], 0);
    expect(feed.takeStats(0)).toEqual({ logsCoins: 1, logsCovered: 0, logsTrades: 0, logsCapped: 1 });
    expect(feed.takeStats(0).logsCapped).toBe(0);
  });

  it("is covered only while both its curve and its pool are, from the later of the two", () => {
    const stream = fakeStream();
    const feed = new TapeLogsFeed(stream, 10);
    expect(feed.coveredSince(MINT, 0)).toBeNull();
    feed.follow([MINT], 0);
    stream.covered.set(CURVE_KEY_PREFIX + MINT, 1_000);
    expect(feed.coveredSince(MINT, 5_000)).toBeNull();
    stream.covered.set(POOL_KEY_PREFIX + MINT, 3_000);
    expect(feed.coveredSince(MINT, 5_000)).toBe(3_000);
    expect(feed.takeStats(5_000).logsCovered).toBe(1);
  });

  it("keeps each trade once, as a tape trade with its mark", () => {
    const stream = fakeStream();
    const feed = new TapeLogsFeed(stream, 10);
    feed.follow([MINT], 0);
    decoded.trades = [
      trade(),
      trade({
        wallet: "w2",
        side: "sell",
        atMs: 12_000,
        priceSol: null,
        pool: { amount: 5, quoteReserve: 80, baseReserve: 9 },
      } as Partial<DecodedTrade>),
    ];
    expect(feed.onLogs(CURVE_KEY_PREFIX + MINT, "sig1", [])).toBe(true);
    // The pool's key delivers the same transaction again.
    expect(feed.onLogs(POOL_KEY_PREFIX + MINT, "sig1", [])).toBe(true);
    expect(feed.tradesSince(MINT, 0)).toEqual([
      { wallet: "w1", side: "buy", sol: 1, tokens: 1000, atMs: 10_000, tx: "sig1", mark: { curve: 0.001 } },
      {
        wallet: "w2",
        side: "sell",
        sol: 1,
        tokens: 1000,
        atMs: 12_000,
        tx: "sig1",
        mark: { quote: 80, base: 9 },
      },
    ]);
    expect(feed.tradesSince(MINT, 11_000)).toHaveLength(1);
    expect(feed.takeStats(0).logsTrades).toBe(2);
    expect(feed.onLogs("other:key", "sig2", [])).toBe(false);
  });

  it("stops vouching for a coin it saw a trade it couldn't price", () => {
    const stream = fakeStream();
    const feed = new TapeLogsFeed(stream, 10);
    feed.follow([MINT], 0);
    stream.covered.set(CURVE_KEY_PREFIX + MINT, 0);
    stream.covered.set(POOL_KEY_PREFIX + MINT, 0);
    expect(feed.coveredSince(MINT, 1)).toBe(0);
    decoded.trades = [trade({ sol: null })];
    feed.onLogs(CURVE_KEY_PREFIX + MINT, "sig1", []);
    expect(feed.coveredSince(MINT, 1)).toBeNull();
  });

  it("keeps the newest MAX_TRADES trades", () => {
    const feed = new TapeLogsFeed(fakeStream(), 10);
    feed.follow([MINT], 0);
    for (let i = 0; i < MAX_TRADES + 5; i += 1) {
      decoded.trades = [trade({ atMs: i })];
      feed.onLogs(CURVE_KEY_PREFIX + MINT, `sig${i}`, []);
    }
    const kept = feed.tradesSince(MINT, 0);
    expect(kept).toHaveLength(MAX_TRADES);
    expect(kept[0]?.atMs).toBe(5);
  });
});
