import { describe, expect, it } from "vitest";
import { holderTransfersReading, sharedSignatures, transferMovesOf } from "./holderTransfers.js";
import type { ChainTx } from "./tradeTape.js";

const MINT = "mint";
const OTHER = "other-coin";
/** Wallets are any name but the curve's and the pool's. */
const isWallet = (a: string) => a !== "curve" && a !== "pool";

function tx(
  pre: [owner: string, amount: number, mint?: string][],
  post: [owner: string, amount: number, mint?: string][],
  err: unknown = null,
): ChainTx {
  const bal = (rows: [string, number, string?][]) =>
    rows.map(([owner, amount, mint], i) => ({
      accountIndex: i,
      mint: mint ?? MINT,
      owner,
      uiTokenAmount: { amount: String(amount), decimals: 6 },
    }));
  return { meta: { err, preTokenBalances: bal(pre), postTokenBalances: bal(post) } } as unknown as ChainTx;
}

describe("transferMovesOf", () => {
  it("reads a plain transfer from one wallet to another", () => {
    expect(
      transferMovesOf(
        MINT,
        tx(
          [["a", 100]],
          [
            ["a", 40],
            ["b", 60],
          ],
        ),
        isWallet,
      ),
    ).toEqual([{ from: "a", to: "b", amount: "60" }]);
  });

  it("splits a send to several wallets, one move each", () => {
    expect(
      transferMovesOf(
        MINT,
        tx(
          [["a", 100]],
          [
            ["b", 30],
            ["c", 70],
          ],
        ),
        isWallet,
      ),
    ).toEqual([
      { from: "a", to: "b", amount: "30" },
      { from: "a", to: "c", amount: "70" },
    ]);
  });

  it("leaves out a trade: the curve's or a pool's balance moved", () => {
    // A buy: the curve sends to the buyer.
    expect(
      transferMovesOf(
        MINT,
        tx(
          [["curve", 1000]],
          [
            ["curve", 900],
            ["a", 100],
          ],
        ),
        isWallet,
      ),
    ).toBeNull();
    // Two holders buying in one bundled transaction.
    expect(
      transferMovesOf(
        MINT,
        tx(
          [["pool", 1000]],
          [
            ["pool", 800],
            ["a", 100],
            ["b", 100],
          ],
        ),
        isWallet,
      ),
    ).toBeNull();
  });

  it("reads only the coin itself: other coins moving the other way change nothing", () => {
    const moves = transferMovesOf(
      MINT,
      tx(
        [
          ["a", 100],
          ["b", 500, OTHER],
        ],
        [
          ["a", 0],
          ["b", 100],
          ["a", 500, OTHER],
        ],
      ),
      isWallet,
    );
    expect(moves).toEqual([{ from: "a", to: "b", amount: "100" }]);
  });

  it("is null for a failed transaction or one where the coin didn't move between two wallets", () => {
    expect(
      transferMovesOf(
        MINT,
        tx(
          [["a", 100]],
          [
            ["a", 40],
            ["b", 60],
          ],
          { e: 1 },
        ),
        isWallet,
      ),
    ).toBeNull();
    expect(transferMovesOf(MINT, tx([["a", 100]], [["a", 100]]), isWallet)).toBeNull();
    expect(transferMovesOf(MINT, tx([], [["a", 100, OTHER]]), isWallet)).toBeNull();
    expect(transferMovesOf(MINT, null, isWallet)).toBeNull();
  });
});

describe("holderTransfersReading", () => {
  it("sums each sender-receiver pair among the holders, as % of supply, largest first", () => {
    const r = holderTransfersReading(
      ["a", "b", "c"],
      [
        { atMs: 1_000, moves: [{ from: "a", to: "b", amount: "10000000" }] },
        { atMs: 3_000, moves: [{ from: "a", to: "b", amount: "5000000" }] },
        { atMs: 2_000, moves: [{ from: "c", to: "a", amount: "20000000" }] },
        // Out of the holders: left out.
        { atMs: 4_000, moves: [{ from: "b", to: "outsider", amount: "90000000" }] },
      ],
      1_000_000_000n,
    )!;
    expect(r.transfers).toEqual([
      { from: "c", to: "a", pct: 2, count: 1, lastAtMs: 2_000 },
      { from: "a", to: "b", pct: 1.5, count: 2, lastAtMs: 3_000 },
    ]);
    expect(r.transferredSupplyPct).toBe(3.5);
    expect(r.transferWalletCount).toBe(3);
    expect(r.holdersChecked).toBe(3);
  });

  it("reads zero when no two holders moved the coin between them", () => {
    const r = holderTransfersReading(["a", "b"], [], 1_000n)!;
    expect(r).toEqual({ transfers: [], transferredSupplyPct: 0, transferWalletCount: 0, holdersChecked: 2 });
  });

  it("is null without a supply or holders", () => {
    expect(holderTransfersReading(["a"], [], 0n)).toBeNull();
    expect(holderTransfersReading([], [], 10n)).toBeNull();
  });
});

describe("sharedSignatures", () => {
  it("keeps the signatures two different holders' accounts both list", () => {
    const sigs: Record<string, string[]> = {
      "a-1": ["s1", "s2"],
      "a-2": ["s2", "s3"],
      "b-1": ["s3", "s4"],
      "c-1": ["s5"],
    };
    const accountsOf = new Map([
      ["a", ["a-1", "a-2"]],
      ["b", ["b-1"]],
      ["c", ["c-1"]],
    ]);
    // s2 is in two of a's own accounts, not two holders'.
    expect([...sharedSignatures(accountsOf, (acc) => sigs[acc] ?? [])]).toEqual(["s3"]);
  });
});
