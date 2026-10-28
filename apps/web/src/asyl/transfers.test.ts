import { describe, expect, it } from "vitest";
import { coverNote, rowKey } from "./TransfersPanel";
import type { BetweenRead, BetweenTransfer } from "./asylApi";

const A = "2cER2peZXLpnJAaStnoDHmXAEmgzkEPMU2f1gbpT5ABv";
const B = "8faJMzdGivifdQUjtLuWVfmHLL5bXb3Ra8yrLFvpiFkS";
const name = (id: string) => (id === A ? "Alpha" : "Beta");
const read = (chain: BetweenRead["chain"]): BetweenRead => ({
  wallets: [A, B],
  transfers: [],
  more: false,
  coins: [],
  chain,
});

describe("coverNote", () => {
  it("says nothing without a chain read, and so when every history was read whole", () => {
    expect(coverNote(read(null), name)).toBe("");
    const whole = read({
      covers: [
        { wallet: A, txs: 10, complete: true, fromMs: 1 },
        { wallet: B, txs: 4, complete: true, fromMs: 1 },
      ],
      shared: 2,
      read: 2,
      stop: "done",
      readAt: 0,
    });
    expect(coverNote(whole, name)).toBe("Every wallet's whole history was read.");
  });

  it("names a wallet read only part way, and shared transactions the allowance left unread", () => {
    const note = coverNote(
      read({
        covers: [
          { wallet: A, txs: 5000, complete: false, fromMs: Date.UTC(2026, 5, 1) },
          { wallet: B, txs: 4, complete: true, fromMs: 1 },
        ],
        shared: 300,
        read: 120,
        stop: "allowance",
        readAt: 0,
      }),
      name,
    );
    expect(note).toContain("Alpha back to");
    expect(note).toContain("5,000 transactions");
    expect(note).toContain("120 of the 300 transactions");
    expect(note).toContain("allowance ran short");
  });
});

describe("rowKey", () => {
  it("tells apart moves of two assets in one transaction, and first fundings by time", () => {
    const t: BetweenTransfer = {
      signature: "sig",
      at: 5,
      from: A,
      to: B,
      mint: null,
      amount: 1,
      pct: null,
      kind: "transfer",
      source: "chain",
    };
    expect(rowKey(t)).not.toBe(rowKey({ ...t, mint: "M" }));
    expect(rowKey({ ...t, signature: null, kind: "funding" })).toBe(`funding@5|${A}|${B}|`);
  });
});
