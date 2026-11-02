import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedTrade } from "@trenchscanner/core";

const decoded = vi.hoisted(() => ({ trades: [] as DecodedTrade[] }));
vi.mock("@trenchscanner/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@trenchscanner/core")>()),
  tradesFromLogs: vi.fn(() => decoded.trades),
}));

import { pumpCurveAddressOf, pumpSwapPoolOf } from "@trenchscanner/core";
import {
  CEILING_WINDOW_MS,
  CURVE_KEY_PREFIX,
  IDLE_MS,
  MAX_TRADES,
  NOISY_HOLD_MS,
  POOL_KEY_PREFIX,
  TapeLogsFeed,
} from "./tapeLogsFeed.js";

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
    expect(feed.takeStats(0)).toEqual({
      logsCoins: 1,
      logsCovered: 0,
      logsTrades: 0,
      logsCapped: 1,
      logsCredits: 0,
      logsDropped: 0,
    });
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

  it("counts its logs' bytes as credits, for the page budget and the heartbeat", () => {
    const feed = new TapeLogsFeed(fakeStream(), 10);
    feed.follow([MINT], 0);
    feed.onLogs(CURVE_KEY_PREFIX + MINT, "sig1", [], 30_000);
    // Billed after the coin was let go too; not another feed's key.
    feed.onLogs(POOL_KEY_PREFIX + MINT2, "sig2", [], 20_000);
    feed.onLogs("other:key", "sig3", [], 50_000);
    expect(feed.takeCredits()).toBeCloseTo(1, 6);
    expect(feed.takeCredits()).toBe(0);
    expect(feed.takeStats(0).logsCredits).toBe(1);
    expect(feed.takeStats(0).logsCredits).toBe(0);
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

  it("lets the costliest coin go once the last minute's logs are over the ceiling, and holds it off", () => {
    const stream = fakeStream();
    const feed = new TapeLogsFeed(stream, 10);
    // 100 credits a minute = 5 MB. MINT costs 4 MB (a failed-swap storm: no logs, bytes all the
    // same), MINT2 2 MB: together over the line, so the heavier one goes and the lighter stays.
    feed.follow([MINT, MINT2], 0, 100);
    feed.onLogs(CURVE_KEY_PREFIX + MINT, "f1", [], 4_000_000, 1_000);
    feed.onLogs(POOL_KEY_PREFIX + MINT2, "f2", [], 2_000_000, 1_000);
    stream.unwatch.mockClear();
    feed.follow([MINT, MINT2], 2_000, 100);
    expect(stream.unwatch).toHaveBeenCalledWith(CURVE_KEY_PREFIX + MINT);
    expect(stream.unwatch).toHaveBeenCalledWith(POOL_KEY_PREFIX + MINT);
    expect(stream.unwatch).toHaveBeenCalledTimes(2);
    expect(feed.coveredSince(MINT, 2_000)).toBeNull();
    const stats = feed.takeStats(2_000);
    expect(stats).toMatchObject({ logsCoins: 1, logsDropped: 1, logsCredits: 120 });

    // Asked again inside the hold: not taken back. After it: followed again.
    stream.watch.mockClear();
    feed.follow([MINT], 3_000, 100);
    expect(stream.watch).not.toHaveBeenCalledWith(CURVE_KEY_PREFIX + MINT, expect.anything(), 3_000, "logs");
    feed.follow([MINT], 2_000 + NOISY_HOLD_MS + CEILING_WINDOW_MS, 100);
    expect(stream.watch).toHaveBeenCalledWith(
      CURVE_KEY_PREFIX + MINT,
      [pumpCurveAddressOf(MINT)],
      2_000 + NOISY_HOLD_MS + CEILING_WINDOW_MS,
      "logs",
    );
  });

  it("takes no new coin on while the minute is spent, and forgets bytes older than the window", () => {
    const stream = fakeStream();
    const feed = new TapeLogsFeed(stream, 10);
    feed.follow([MINT], 0, 100);
    // Exactly at the ceiling: MINT stays (nothing to let go that would help), but MINT2 waits.
    feed.onLogs(CURVE_KEY_PREFIX + MINT, "f1", [], 5_000_000, 1_000);
    feed.follow([MINT, MINT2], 2_000, 100);
    expect(stream.unwatch).not.toHaveBeenCalled();
    expect(stream.watch).not.toHaveBeenCalledWith(CURVE_KEY_PREFIX + MINT2, expect.anything(), 2_000, "logs");
    expect(feed.takeStats(2_000)).toMatchObject({ logsCoins: 1, logsDropped: 0, logsCapped: 0 });
    // A minute on, those bytes no longer count and MINT2 is taken on.
    feed.follow([MINT, MINT2], 1_000 + CEILING_WINDOW_MS + 1, 100);
    expect(stream.watch).toHaveBeenCalledWith(
      CURVE_KEY_PREFIX + MINT2,
      [pumpCurveAddressOf(MINT2)],
      1_000 + CEILING_WINDOW_MS + 1,
      "logs",
    );
    expect(feed.takeStats(1_000 + CEILING_WINDOW_MS + 1).logsCoins).toBe(2);
  });

  it("never lets a coin go for its cost without a ceiling", () => {
    const stream = fakeStream();
    const feed = new TapeLogsFeed(stream, 10);
    feed.follow([MINT], 0);
    feed.onLogs(CURVE_KEY_PREFIX + MINT, "f1", [], 50_000_000, 1_000);
    feed.follow([MINT], 2_000);
    expect(stream.unwatch).not.toHaveBeenCalled();
    expect(feed.takeStats(2_000).logsDropped).toBe(0);
  });
});
