// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSignaturesResult, ChainTx, TopHoldersResult } from "@trenchscanner/core";
import { readTopHolders, resetLinkedWallets } from "./linkedWallets.js";
import {
  ACCOUNT_REREAD_MS,
  holderTransfersOf,
  resetHolderTransfers,
  resolveHolderTransfers,
  takeHolderTransferStats,
} from "./holderTransfers.js";

// Real wallet addresses: a transfer counts only between wallets on the ed25519 curve.
const A = "HYi9a633brCmNtqLgat8fDo8huRYuYpUxsoJhuSzJiaP";
const B = "4WPT9wLwQWYS5zyX36ZgoY3ESxxLgDmE12upKXDAyYbL";
const C = "E8UYm3eH1vod7a2kpkWotNyosY2W7x6K9yCDZbkqwW12";
const MINT = "transfer-test-mint";
const SUPPLY = 1_000_000_000n;
const NOW = 1_800_000_000_000;

/** A's 3% went to B: 30,000,000 of the 1,000,000,000 supply. */
const transfer: ChainTx = {
  meta: {
    err: null,
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: A, uiTokenAmount: { amount: "50000000" } }],
    postTokenBalances: [
      { accountIndex: 1, mint: MINT, owner: A, uiTokenAmount: { amount: "20000000" } },
      { accountIndex: 2, mint: MINT, owner: B, uiTokenAmount: { amount: "30000000" } },
    ],
  },
} as unknown as ChainTx;

function fakeHelius(sigs: Record<string, string[]>, txs: Record<string, ChainTx>) {
  return {
    getTopHoldersBatch: vi.fn(
      async (mints: string[]): Promise<Map<string, TopHoldersResult>> =>
        new Map(
          mints.map((m) => [
            m,
            {
              status: "found",
              supply: SUPPLY.toString(),
              holders: [
                { owner: A, pct: 5, accounts: ["acc-a"] },
                { owner: B, pct: 3, accounts: ["acc-b"] },
                { owner: C, pct: 1, accounts: ["acc-c"] },
              ],
            },
          ]),
        ),
    ),
    getAccountSignaturesBatch: vi.fn(
      async (reads: readonly { address: string; until?: string | null }[]) =>
        new Map<string, AccountSignaturesResult>(
          reads.map((r) => [
            r.address,
            {
              status: "found",
              signatures: (sigs[r.address] ?? []).map((signature) => ({
                signature,
                ok: true,
                atMs: NOW - 60_000,
              })),
              full: false,
            },
          ]),
        ),
    ),
    getTransactionsBatch: vi.fn(
      async (signatures: readonly string[]) =>
        new Map<string, ChainTx | null | "failed">(signatures.map((s) => [s, txs[s] ?? null])),
    ),
  };
}

describe("holder transfers", () => {
  beforeEach(() => {
    resetLinkedWallets();
    resetHolderTransfers();
  });

  it("reads the holders' signatures, then only the transactions two of them share", async () => {
    const helius = fakeHelius(
      { "acc-a": ["buy-a", "send"], "acc-b": ["send", "buy-b"], "acc-c": ["buy-c"] },
      { send: transfer },
    );
    const group = { mintAddress: MINT, holders: [], creator: null };
    await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
    expect(holderTransfersOf(group, NOW)).toBeNull();

    await resolveHolderTransfers([group], helius, { maxSignatureReads: 10, maxTxReads: 10, nowMs: NOW });
    expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
    expect(helius.getTransactionsBatch.mock.calls[0]![0]).toEqual(["send"]);
    expect(takeHolderTransferStats()).toEqual({ getSignaturesForAddress: 3, getTransaction: 1, credits: 4 });

    const reading = holderTransfersOf(group, NOW)!;
    expect(reading.transfers).toEqual([{ from: A, to: B, pct: 3, count: 1, lastAtMs: NOW - 60_000 }]);
    expect(reading.transferredSupplyPct).toBe(3);
    expect(reading.transferWalletCount).toBe(2);
    expect(reading.holdersChecked).toBe(3);
  });

  it("reads a whole coin's accounts or none within the budget, and re-reads only newer signatures", async () => {
    const helius = fakeHelius({ "acc-a": ["x"], "acc-b": ["y"], "acc-c": ["z"] }, {});
    const group = { mintAddress: MINT, holders: [], creator: null };
    await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });

    await resolveHolderTransfers([group], helius, { maxSignatureReads: 2, maxTxReads: 10, nowMs: NOW });
    expect(helius.getAccountSignaturesBatch).not.toHaveBeenCalled();

    await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: NOW });
    expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
    // No shared signature: nothing to read in full, and no transfers.
    expect(helius.getTransactionsBatch).not.toHaveBeenCalled();
    expect(holderTransfersOf(group, NOW)?.transferredSupplyPct).toBe(0);

    // Within the re-read gap nothing is asked again; past it, only signatures after the newest seen.
    await resolveHolderTransfers([group], helius, {
      maxSignatureReads: 3,
      maxTxReads: 10,
      nowMs: NOW + 1_000,
    });
    expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
    const later = NOW + ACCOUNT_REREAD_MS;
    await readTopHolders([group], helius, { maxReads: 1, nowMs: later });
    await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: later });
    expect(helius.getAccountSignaturesBatch.mock.calls[1]![0]).toEqual([
      { address: "acc-a", until: "x" },
      { address: "acc-b", until: "y" },
      { address: "acc-c", until: "z" },
    ]);
  });

  it("gives no reading while a shared transaction is still unread", async () => {
    const helius = fakeHelius({ "acc-a": ["send"], "acc-b": ["send"], "acc-c": [] }, { send: transfer });
    const group = { mintAddress: MINT, holders: [], creator: null };
    await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
    await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 0, nowMs: NOW });
    expect(holderTransfersOf(group, NOW)).toBeNull();
    await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 5, nowMs: NOW + 1 });
    expect(holderTransfersOf(group, NOW + 1)?.transferredSupplyPct).toBe(3);
  });
});
