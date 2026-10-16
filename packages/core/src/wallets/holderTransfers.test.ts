import { describe, expect, it } from "vitest";
import {
  holderTransfersReading,
  linkingTransfers,
  sharedSignatures,
  transferMovesOf,
  inboundSideTier,
  TRANSFER_SIDE_OUTBOUND_TIERS,
  transferSideTier,
} from "./holderTransfers.js";
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

  it("keeps each transfer with its signature, newest first", () => {
    const r = holderTransfersReading(
      ["a", "b"],
      [
        { atMs: 1_000, signature: "s1", moves: [{ from: "a", to: "b", amount: "10000000" }] },
        { atMs: 3_000, signature: "s2", moves: [{ from: "b", to: "a", amount: "5000000" }] },
      ],
      1_000_000_000n,
    )!;
    expect(r.events).toEqual([
      { signature: "s2", from: "b", to: "a", pct: 0.5, atMs: 3_000 },
      { signature: "s1", from: "a", to: "b", pct: 1, atMs: 1_000 },
    ]);
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

describe("linkingTransfers", () => {
  const pctOf = new Map([
    ["a", 5],
    ["b", 3],
    ["c", 0.01],
    ["hot", 2],
  ]);
  const notHot = (w: string) => w === "hot";

  it("keeps transfers past the dust floor between holders, clear of hot wallets", () => {
    const t = [
      { from: "a", to: "b", pct: 0.05 }, // at the % floor
      { from: "a", to: "b", pct: 0.01 }, // dust: 0.01 of a 5% bag
      { from: "c", to: "b", pct: 0.005 }, // small, but a third of what c held
      { from: "hot", to: "a", pct: 1 }, // an exchange
      { from: "a", to: "outsider", pct: 1 }, // not a holder
      { from: "a", to: "a", pct: 1 },
    ];
    expect(linkingTransfers(t, pctOf, notHot)).toEqual([t[0], t[2]]);
  });

  it("is empty without transfers", () => {
    expect(linkingTransfers(null, pctOf, notHot)).toEqual([]);
  });
});

describe("transferSideTier", () => {
  const H = 3_600_000;
  it("flags 4 transfers within 48 hours", () => {
    expect(transferSideTier([0, 10 * H, 20 * H, 47 * H])).toEqual({ hours: 48, transfers: 4 });
    expect(transferSideTier([0, 10 * H, 20 * H, 49 * H])).toBeNull();
  });

  it("flags a run of transfers in 72 hours, and ignores ones out of order or without a time", () => {
    const run = Array.from({ length: 10 }, (_, i) => (9 - i) * 8 * H);
    expect(transferSideTier(run)).toEqual({ hours: 48, transfers: 7 });
    expect(transferSideTier([0, Number.NaN, 100 * H, 200 * H])).toBeNull();
  });

  it("needs 6 in 24 hours, 10 in 48 or 25 in 72 from a KOL", () => {
    const every = (n: number, gap: number) => Array.from({ length: n }, (_, i) => i * gap * H);
    expect(transferSideTier(every(6, 4), TRANSFER_SIDE_OUTBOUND_TIERS)).toEqual({ hours: 24, transfers: 6 });
    expect(transferSideTier(every(5, 4), TRANSFER_SIDE_OUTBOUND_TIERS)).toBeNull();
    expect(transferSideTier(every(10, 5), TRANSFER_SIDE_OUTBOUND_TIERS)).toEqual({
      hours: 48,
      transfers: 10,
    });
    expect(transferSideTier(every(25, 2.9), TRANSFER_SIDE_OUTBOUND_TIERS)?.hours).toBe(24);
  });
});

describe("inboundSideTier", () => {
  const H = 3_600_000;
  const run = (n: number, pct: number, gap: number) =>
    Array.from({ length: n }, (_, i) => ({ atMs: i * gap * H, pct }));

  it("needs 8 over 1% in 24 hours", () => {
    expect(inboundSideTier(run(8, 1.5, 3))).toEqual({ hours: 24, transfers: 8 });
    expect(inboundSideTier(run(8, 1, 3))).toBeNull(); // not over 1%
    expect(inboundSideTier(run(7, 1.5, 3))).toBeNull();
  });

  it("or 16 over 0.5% in 24 hours, or 16 over 2% in 72", () => {
    expect(inboundSideTier(run(16, 0.6, 1.5))).toEqual({ hours: 24, transfers: 16 });
    expect(inboundSideTier(run(16, 2.5, 4.5))).toEqual({ hours: 72, transfers: 16 });
    expect(inboundSideTier(run(16, 1.5, 4.5))).toBeNull();
  });
});
