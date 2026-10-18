import { describe, expect, it } from "vitest";
import {
  CATCH_UP_COVERED_MS,
  CATCH_UP_UNCOVERED_MS,
  LazyTradeStream,
  streamKey,
  positionPnl,
  positionsOf,
  ProTradeWatcher,
  tradeStats,
  walletSwaps,
  type TradeRow,
  type WalletTx,
} from "./proTrades.js";

const W = "Wa11etAddre55xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const MINT = "CoinMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump";
const OTHER = "OtherMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function tx(opts: {
  payer?: string;
  sol: [number, number];
  pre?: { mint: string; owner?: string; amount: string }[];
  post?: { mint: string; owner?: string; amount: string }[];
  err?: unknown;
  blockTime?: number;
}): WalletTx {
  const bal = (list: { mint: string; owner?: string; amount: string }[] = []) =>
    list.map((b, i) => ({
      accountIndex: i + 1,
      mint: b.mint,
      owner: b.owner ?? W,
      uiTokenAmount: { amount: b.amount, decimals: 6 },
    }));
  return {
    blockTime: opts.blockTime ?? 1_700_000_000,
    meta: {
      err: opts.err ?? null,
      preBalances: [opts.sol[0]],
      postBalances: [opts.sol[1]],
      preTokenBalances: bal(opts.pre),
      postTokenBalances: bal(opts.post),
    },
    transaction: { message: { accountKeys: [{ pubkey: opts.payer ?? W }] } },
  } as WalletTx;
}

describe("walletSwaps", () => {
  it("reads a buy paid in SOL", () => {
    const out = walletSwaps("s1", tx({ sol: [2e9, 1.5e9], post: [{ mint: MINT, amount: "1000000" }] }), W, 0);
    expect(out).toEqual([
      expect.objectContaining({
        mint: MINT,
        side: "buy",
        lamports: -500_000_000n,
        tokens: 1_000_000n,
        decimals: 6,
      }),
    ]);
    expect(out[0]!.at.getTime()).toBe(1_700_000_000_000);
  });

  it("reads a sale, counting wrapped SOL as SOL", () => {
    const out = walletSwaps(
      "s2",
      tx({
        sol: [1e9, 0.999e9],
        pre: [
          { mint: MINT, amount: "1000000" },
          { mint: WSOL, amount: "0" },
        ],
        post: [
          { mint: MINT, amount: "0" },
          { mint: WSOL, amount: "800000000" },
        ],
      }),
      W,
      0,
    );
    expect(out).toEqual([
      expect.objectContaining({ side: "sell", lamports: 799_000_000n, tokens: -1_000_000n }),
    ]);
  });

  it("leaves out an airdrop, a transfer and a transaction someone else paid for", () => {
    // Coins in, only fees out: a transfer the wallet paid for.
    expect(
      walletSwaps("a", tx({ sol: [1e9, 1e9 - 5_000], post: [{ mint: MINT, amount: "5" }] }), W, 0),
    ).toEqual([]);
    // Someone else paid: never this wallet's trade.
    expect(
      walletSwaps(
        "b",
        tx({ payer: "Someone", sol: [1e9, 0.5e9], post: [{ mint: MINT, amount: "5" }] }),
        W,
        0,
      ),
    ).toEqual([]);
    // Failed.
    expect(
      walletSwaps("c", tx({ sol: [1e9, 0.5e9], post: [{ mint: MINT, amount: "5" }], err: { x: 1 } }), W, 0),
    ).toEqual([]);
    // Another wallet's balance.
    expect(
      walletSwaps("d", tx({ sol: [1e9, 0.5e9], post: [{ mint: MINT, owner: "Pool", amount: "5" }] }), W, 0),
    ).toEqual([]);
  });

  it("reads a buy paid in USDC with no SOL figure", () => {
    const out = walletSwaps(
      "u",
      tx({
        sol: [1e9, 1e9 - 5_000],
        pre: [{ mint: USDC, amount: "100" }],
        post: [
          { mint: USDC, amount: "0" },
          { mint: MINT, amount: "9" },
        ],
      }),
      W,
      0,
    );
    expect(out).toEqual([expect.objectContaining({ side: "buy", lamports: null, tokens: 9n })]);
  });

  it("can't split the SOL between two coins bought at once", () => {
    const out = walletSwaps(
      "m",
      tx({
        sol: [2e9, 1e9],
        post: [
          { mint: MINT, amount: "9" },
          { mint: OTHER, amount: "3" },
        ],
      }),
      W,
      0,
    );
    expect(out.map((t) => [t.mint, t.lamports])).toEqual([
      [MINT, null],
      [OTHER, null],
    ]);
  });

  it("takes the time it was seen when the stream carried no block time", () => {
    const t = tx({ sol: [2e9, 1.5e9], post: [{ mint: MINT, amount: "1" }] });
    delete (t as { blockTime?: number }).blockTime;
    expect(walletSwaps("s", t, W, 123_000)[0]!.at.getTime()).toBe(123_000);
  });
});

const row = (
  r: Partial<TradeRow> & Pick<TradeRow, "side" | "tokens" | "lamports">,
  min: number,
): TradeRow => ({
  signature: `sig${min}`,
  mint: MINT,
  decimals: 6,
  at: new Date(min * 60_000),
  entry: false,
  ...r,
});

describe("positionsOf and positionPnl", () => {
  it("follows the trade from its latest entry", () => {
    const rows = [
      // An earlier round trip, closed.
      row({ side: "buy", tokens: 1_000_000n, lamports: -1_000_000_000n, entry: true }, 0),
      row({ side: "sell", tokens: -1_000_000n, lamports: 2_000_000_000n }, 5),
      // The current one: in for 1 SOL, half sold for 1.5 SOL.
      row({ side: "buy", tokens: 2_000_000n, lamports: -1_000_000_000n, entry: true }, 10),
      row({ side: "sell", tokens: -1_000_000n, lamports: 1_500_000_000n }, 20),
    ];
    const [p] = positionsOf(rows);
    expect(p).toMatchObject({
      buys: 1,
      sells: 1,
      spentSol: 1,
      gotSol: 1.5,
      held: 1,
      closed: false,
      entryPriceSol: 0.5,
    });
    expect(p!.entryAt.getTime()).toBe(10 * 60_000);
    // Held coin at 0.25 SOL: 1.5 + 0.25 - 1 = +0.75.
    expect(positionPnl(p!, 0.25)).toEqual({ sol: 0.75, pct: 75 });
    // An open coin with no price can't be valued.
    expect(positionPnl(p!, null)).toBeNull();
  });

  it("calls a coin sold down to dust closed, and orders newest entry first", () => {
    const rows = [
      row({ side: "buy", tokens: 1_000n, lamports: -100_000_000n, entry: true }, 0),
      row({ side: "sell", tokens: -995n, lamports: 50_000_000n }, 3),
      row({ mint: OTHER, side: "buy", tokens: 5n, lamports: -10_000_000n, entry: true }, 8),
    ];
    const list = positionsOf(rows);
    expect(list.map((p) => p.mint)).toEqual([OTHER, MINT]);
    expect(list[1]!.closed).toBe(true);
    expect(positionPnl(list[1]!, null)).toEqual({ sol: -0.05, pct: -50 });
  });
});

describe("tradeStats", () => {
  it("adds the window up", () => {
    const rows = [
      row({ side: "buy", tokens: 10n, lamports: -1_000_000_000n, entry: true }, 0),
      row({ side: "sell", tokens: -10n, lamports: 3_000_000_000n }, 30),
      row({ mint: OTHER, side: "buy", tokens: 10n, lamports: -1_000_000_000n, entry: true }, 40),
      row({ mint: OTHER, side: "sell", tokens: -10n, lamports: 500_000_000n }, 50),
    ];
    const positions = positionsOf(rows);
    const stats = tradeStats(
      rows,
      positions,
      () => null,
      (mint) => mint === MINT,
      24,
    );
    expect(stats).toMatchObject({
      trades: 4,
      buys: 2,
      sells: 2,
      coins: 2,
      volumeSol: 2,
      closed: 2,
      open: 0,
      winRatePct: 50,
      realizedSol: 1.5,
      unrealizedSol: 0,
      bestMultiple: 3,
      medianHoldMinutes: 30,
      calledFirst: 1,
      entries: 2,
    });
  });
});

describe("ProTradeWatcher.touch", () => {
  class Counting extends ProTradeWatcher {
    calls = 0;
    override async catchUp(): Promise<void> {
      this.calls += 1;
    }
  }

  it("catches up every minute while the stream isn't covering, and keeps the wallet followed", async () => {
    let now = 1_000_000;
    const watched: string[] = [];
    const w = new Counting({
      stream: { watch: (k) => watched.push(k), coveredSince: () => null, start() {}, stop() {} },
      rpc: { getSignaturesForAddress: async () => [], getTransactionJson: async () => null },
      onEntry: async () => {},
      now: () => now,
    });
    await w.touch(W);
    await w.touch(W);
    expect(w.calls).toBe(1);
    now += CATCH_UP_UNCOVERED_MS;
    await w.touch(W);
    expect(w.calls).toBe(2);
    // The key names the wallet by a tag, never its address (wallet privacy rule).
    expect(watched).toEqual([streamKey(W), streamKey(W), streamKey(W)]);
    expect(watched[0]).not.toContain(W);
  });

  it("reads far less often once the stream covers the wallet", async () => {
    let now = 1_000_000;
    let covered: number | null = null;
    const w = new Counting({
      stream: { watch() {}, coveredSince: () => covered, start() {}, stop() {} },
      rpc: { getSignaturesForAddress: async () => [], getTransactionJson: async () => null },
      onEntry: async () => {},
      now: () => now,
    });
    covered = now - 120_000;
    await w.touch(W);
    expect(w.calls).toBe(1);
    now += CATCH_UP_UNCOVERED_MS;
    await w.touch(W);
    expect(w.calls).toBe(1);
    now += CATCH_UP_COVERED_MS;
    await w.touch(W);
    expect(w.calls).toBe(2);
  });
});

describe("LazyTradeStream", () => {
  it("opens on the first watch and closes once nothing has been watched for a while", () => {
    let now = 0;
    let made = 0;
    let stopped = 0;
    const lazy = new LazyTradeStream(
      () => {
        made += 1;
        return { watch() {}, coveredSince: () => 5, start() {}, stop: () => void (stopped += 1) };
      },
      16 * 60_000,
      () => now,
    );
    expect(lazy.open).toBe(false);
    expect(lazy.coveredSince("k", "a")).toBeNull();
    lazy.watch("k", ["a"]);
    expect(lazy.open).toBe(true);
    expect(lazy.coveredSince("k", "a")).toBe(5);
    now = 10 * 60_000;
    lazy.watch("k", ["a"]);
    now = 20 * 60_000;
    lazy.closeIfIdle();
    expect(lazy.open).toBe(true);
    now = 27 * 60_000;
    lazy.closeIfIdle();
    expect(lazy.open).toBe(false);
    expect(stopped).toBe(1);
    lazy.watch("k", ["a"]);
    expect(made).toBe(2);
    lazy.stop();
  });
});
