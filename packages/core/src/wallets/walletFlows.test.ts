import { describe, expect, it } from "vitest";
import { BRIDGE_PROGRAMS, flowsFromTransactions } from "./walletFlows.js";

const WSOL_MINT = "So11111111111111111111111111111111111111112";
import type { ChainTx } from "./tradeTape.js";

const ME = "me";
const COIN = "coin";
/** Wallets are any name but the pool's and the program's. */
const isWallet = (a: string) => a !== "pool" && a !== "program";
const SOL = 1_000_000_000;

function tx(opts: {
  keys: string[];
  pre: number[];
  post: number[];
  fee?: number;
  tokensPre?: [owner: string, amount: number, mint?: string][];
  tokensPost?: [owner: string, amount: number, mint?: string][];
  at?: number;
  err?: unknown;
}): ChainTx {
  const bal = (rows: [string, number, string?][] = []) =>
    rows.map(([owner, amount, mint], i) => ({
      accountIndex: 100 + i,
      owner,
      mint: mint ?? COIN,
      uiTokenAmount: { amount: String(amount * 1e6), decimals: 6 },
    }));
  return {
    blockTime: opts.at ?? 1_700_000_000,
    meta: {
      err: opts.err ?? null,
      fee: opts.fee ?? 5000,
      preBalances: opts.pre.map((s) => s * SOL),
      postBalances: opts.post.map((s) => s * SOL),
      preTokenBalances: bal(opts.tokensPre),
      postTokenBalances: bal(opts.tokensPost),
    },
    transaction: { message: { accountKeys: opts.keys } },
  } as ChainTx;
}

describe("flowsFromTransactions", () => {
  it("reads a SOL transfer out and in, fee aside", () => {
    const out = tx({ keys: [ME, "friend"], pre: [10, 1], post: [10 - 2 - 0.000005, 3] });
    const back = tx({ keys: ["friend", ME], pre: [3, 7.99], post: [2 - 0.000005, 8.99], at: 1_700_000_100 });
    const flows = flowsFromTransactions(ME, [out, back], isWallet);
    expect(flows.txs).toBe(2);
    expect(flows.transfers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ counterparty: "friend", dir: "out", mint: null, count: 1 }),
        expect.objectContaining({ counterparty: "friend", dir: "in", mint: null, count: 1 }),
      ]),
    );
    const sent = flows.transfers.find((t) => t.dir === "out")!;
    expect(sent.amount).toBeCloseTo(2, 6);
    expect(flows.fromMs).toBe(1_700_000_000_000);
    expect(flows.toMs).toBe(1_700_000_100_000);
  });

  it("names the wallet behind a token account, never the account itself", () => {
    // SOL sent as wrapped SOL into the friend's WSOL account ("acct"), which a check by address
    // alone would take for a wallet; and rent for a new coin account ("rent") on the side.
    const t = {
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        fee: 5000,
        preBalances: [5 * SOL, 0.00204 * SOL, 0],
        postBalances: [(5 - 1 - 0.0204 - 0.000005) * SOL, 1.00204 * SOL, 0.0204 * SOL],
        preTokenBalances: [
          { accountIndex: 1, owner: "friend", mint: WSOL_MINT, uiTokenAmount: { amount: "0", decimals: 9 } },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            owner: "friend",
            mint: WSOL_MINT,
            uiTokenAmount: { amount: String(SOL), decimals: 9 },
          },
          { accountIndex: 2, owner: "other", mint: COIN, uiTokenAmount: { amount: "0", decimals: 6 } },
        ],
      },
      transaction: { message: { accountKeys: [ME, "acct", "rent"] } },
    } as unknown as ChainTx;
    const flows = flowsFromTransactions(ME, [t], isWallet);
    const who = flows.transfers.map((f) => f.counterparty);
    expect(who).not.toContain("acct");
    expect(who).not.toContain("rent");
    expect(flows.transfers).toEqual([
      expect.objectContaining({ counterparty: "friend", dir: "out", mint: null, count: 1 }),
    ]);
    expect(flows.transfers[0]!.amount).toBeCloseTo(1, 6);
  });

  it("reads a coin transfer, with rent paid for the new account", () => {
    const t = tx({
      keys: [ME, "fresh"],
      pre: [5, 0],
      post: [5 - 0.00204 - 0.000005, 0],
      tokensPre: [[ME, 1000]],
      tokensPost: [
        [ME, 400],
        ["fresh", 600],
      ],
    });
    const flows = flowsFromTransactions(ME, [t], isWallet);
    expect(flows.trades).toEqual([]);
    expect(flows.transfers).toEqual([
      expect.objectContaining({ counterparty: "fresh", dir: "out", mint: COIN, amount: 600, count: 1 }),
    ]);
  });

  it("reads a buy through a pool as a trade, never a transfer", () => {
    const t = tx({
      keys: [ME, "pool"],
      pre: [5, 100],
      post: [4, 101],
      tokensPre: [["pool", 1_000_000]],
      tokensPost: [
        ["pool", 990_000],
        [ME, 10_000],
      ],
    });
    const flows = flowsFromTransactions(ME, [t], isWallet);
    expect(flows.transfers).toEqual([]);
    expect(flows.trades).toEqual([expect.objectContaining({ mint: COIN, buys: 1, sells: 0 })]);
    expect(flows.trades[0]!.solIn).toBeCloseTo(1, 4);
  });

  it("counts wrapped SOL as SOL on a sell", () => {
    const t = tx({
      keys: [ME, "pool"],
      pre: [1, 100],
      post: [1 - 0.000005, 100],
      tokensPre: [
        [ME, 500],
        [ME, 0, WSOL_MINT],
      ],
      tokensPost: [
        [ME, 0],
        [ME, 2, WSOL_MINT],
      ],
    });
    const flows = flowsFromTransactions(ME, [t], isWallet);
    expect(flows.trades).toEqual([expect.objectContaining({ mint: COIN, sells: 1 })]);
    expect(flows.trades[0]!.solOut).toBeCloseTo(2, 4);
  });

  it("skips a coin move a program account took part in", () => {
    const t = tx({
      keys: [ME, "program"],
      pre: [1, 0],
      post: [1 - 0.000005, 0],
      tokensPre: [[ME, 10]],
      tokensPost: [
        [ME, 0],
        ["program", 10],
      ],
    });
    expect(flowsFromTransactions(ME, [t], isWallet).transfers).toEqual([]);
  });

  it("ignores failed transactions and dust", () => {
    const failed = tx({ keys: [ME, "friend"], pre: [10, 1], post: [8, 3], err: { InstructionError: [] } });
    const dust = tx({ keys: [ME, "friend"], pre: [10, 1], post: [9.999, 1.001] });
    const flows = flowsFromTransactions(ME, [failed, dust], isWallet);
    expect(flows.txs).toBe(1);
    expect(flows.transfers).toEqual([]);
  });

  it("adds repeated transfers to one counterparty together", () => {
    const one = tx({ keys: [ME, "friend"], pre: [10, 0], post: [9 - 0.000005, 1], at: 1 });
    const two = tx({ keys: [ME, "friend"], pre: [9, 1], post: [8.5 - 0.000005, 1.5], at: 2 });
    const [row] = flowsFromTransactions(ME, [one, two], isWallet).transfers;
    expect(row).toMatchObject({ counterparty: "friend", dir: "out", count: 2, firstAt: 1000, lastAt: 2000 });
    expect(row!.amount).toBeCloseTo(1.5, 6);
  });

  it("reads a bridge call as a bridge move, not a transfer or a trade", () => {
    const WORMHOLE = [...BRIDGE_PROGRAMS].find(([, n]) => n === "Wormhole")![0];
    const MAYAN = [...BRIDGE_PROGRAMS].find(([, n]) => n === "Mayan")![0];
    const solOut = tx({ keys: [ME, "custody", WORMHOLE], pre: [10, 0, 1], post: [7 - 0.000005, 3, 1] });
    (solOut.transaction as { signatures?: string[] }).signatures = ["sig1"];
    const coinIn = tx({
      keys: ["relayer", ME, MAYAN],
      pre: [5, 1, 1],
      post: [5 - 0.000005, 1, 1],
      tokensPre: [[ME, 0, "usdc"]],
      tokensPost: [[ME, 250, "usdc"]],
      at: 1_700_000_500,
    });
    const flows = flowsFromTransactions(ME, [solOut, coinIn], isWallet);
    expect(flows.transfers).toEqual([]);
    expect(flows.trades).toEqual([]);
    expect(flows.bridges).toEqual([
      {
        bridge: "Mayan",
        program: MAYAN,
        dir: "in",
        mint: "usdc",
        amount: 250,
        at: 1_700_000_500_000,
        signature: null,
      },
      expect.objectContaining({ bridge: "Wormhole", dir: "out", mint: null, signature: "sig1" }),
    ]);
    expect(flows.bridges![1]!.amount).toBeCloseTo(3, 6);
  });
});
