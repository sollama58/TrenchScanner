// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSignaturesResult, ChainTx, TopHoldersResult } from "@trenchscanner/core";
import { cachedTopHolders, readTopHolders, resetLinkedWallets, type LinkedGroup } from "./linkedWallets.js";
import {
  ACCOUNT_REREAD_MS,
  balanceMovesOf,
  holderListStreamed,
  holderTransfersOf,
  onHolderStreamTx,
  resetHolderTransfers,
  resolveHolderTransfers,
  setHolderTransferStream,
  STREAM_READ_WAIT_MS,
  takeHolderTransferStats,
} from "./holderTransfers.js";
import { STREAM_SETTLE_MS } from "../discovery/heliusAccountStream.js";

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

    // Answers what it sent, so the scan's passes share one budget (user decision 2026-10-20).
    expect(
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 10, maxTxReads: 10, nowMs: NOW }),
    ).toEqual({ signatureReads: 3, txReads: 1 });
    expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
    expect(helius.getTransactionsBatch.mock.calls[0]![0]).toEqual(["send"]);
    expect(takeHolderTransferStats()).toEqual({
      getSignaturesForAddress: 3,
      getTransaction: 1,
      streamSkipped: 0,
      streamDeferred: 0,
      credits: 4,
    });

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

    expect(
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 2, maxTxReads: 10, nowMs: NOW }),
    ).toEqual({ signatureReads: 0, txReads: 0 });
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

  describe("with the Helius stream", () => {
    /**
     * A stream that has followed every account since `since` (null: not following), or is waiting
     * for Helius to confirm them (`awaiting`).
     */
    function fakeStream(since: number | null, awaiting = false) {
      const s = {
        since,
        awaiting,
        watch: vi.fn(),
        coveredSince: vi.fn(() => s.since),
        awaitingCover: vi.fn(() => s.since === null && s.awaiting),
        takeStats: vi.fn(() => ({
          connected: 1,
          subscriptions: 1,
          accountSubscriptions: 0,
          txs: 0,
          accountUpdates: 0,
          bytes: 0,
          credits: 0,
        })),
      };
      return s;
    }
    /** The same transfer as the stream delivers it, with the token accounts it touched. */
    const streamed = {
      ...transfer,
      transaction: { signatures: ["live-send"], message: { accountKeys: [{ pubkey: A }, "acc-a", "acc-b"] } },
    } as ChainTx;

    it("follows a contender's holder accounts and stops re-reading them once covered", async () => {
      const stream = fakeStream(NOW - 60_000);
      setHolderTransferStream(stream);
      const helius = fakeHelius({ "acc-a": ["x"], "acc-b": ["y"], "acc-c": ["z"] }, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: NOW });
      expect(stream.watch).toHaveBeenCalledWith(MINT, ["acc-a", "acc-b", "acc-c"], NOW);
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);

      // A transfer between two holders arrives on the stream, transaction and all.
      onHolderStreamTx(MINT, "live-send", streamed, NOW + 5_000);
      const later = NOW + ACCOUNT_REREAD_MS + 1;
      await readTopHolders([group], helius, { maxReads: 1, nowMs: later });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: later });
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
      expect(helius.getTransactionsBatch).not.toHaveBeenCalled();
      expect(holderTransfersOf(group, later)?.transfers).toEqual([
        { from: A, to: B, pct: 3, count: 1, lastAtMs: NOW + 5_000 },
      ]);
    });

    it("reads an account again when the stream started after its last read, or dropped", async () => {
      // Read while the socket was down; the subscription is confirmed just after: a transaction in
      // between could be missed.
      const stream = fakeStream(null);
      setHolderTransferStream(stream);
      const helius = fakeHelius({ "acc-a": ["x"], "acc-b": ["y"], "acc-c": ["z"] }, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: NOW });
      stream.since = NOW + 1_000;
      // The stream's signature goes on the list, but the read point stays put until a read covers the gap.
      onHolderStreamTx(MINT, "live-send", streamed, NOW + 5_000);
      const later = NOW + ACCOUNT_REREAD_MS;
      await readTopHolders([group], helius, { maxReads: 1, nowMs: later });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: later });
      expect(helius.getAccountSignaturesBatch.mock.calls[1]![0]).toEqual([
        { address: "acc-a", until: "x" },
        { address: "acc-b", until: "y" },
        { address: "acc-c", until: "z" },
      ]);

      // Covered from here; then the connection drops and polling takes over again.
      const after = later + ACCOUNT_REREAD_MS;
      stream.since = null;
      await readTopHolders([group], helius, { maxReads: 1, nowMs: after });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: after });
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(3);
    });
    it("holds a new coin's first read until its subscription settles, then never re-reads it", async () => {
      // Subscribed this cycle: Helius has yet to answer.
      const stream = fakeStream(null, true);
      setHolderTransferStream(stream);
      const helius = fakeHelius({ "acc-a": ["x"], "acc-b": ["y"], "acc-c": ["z"] }, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      expect(
        await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: NOW }),
      ).toEqual({ signatureReads: 0, txReads: 0 });
      expect(stream.watch).toHaveBeenCalledWith(MINT, ["acc-a", "acc-b", "acc-c"], NOW);
      expect(helius.getAccountSignaturesBatch).not.toHaveBeenCalled();
      expect(holderTransfersOf(group, NOW)).toBeNull();

      // Confirmed a moment later; still settling on the next cycle.
      stream.since = NOW + 1_000;
      await resolveHolderTransfers([group], helius, {
        maxSignatureReads: 3,
        maxTxReads: 10,
        nowMs: NOW + 15_000,
      });
      expect(helius.getAccountSignaturesBatch).not.toHaveBeenCalled();
      expect(takeHolderTransferStats()).toMatchObject({ getSignaturesForAddress: 0, streamDeferred: 6 });

      // Settled: one read, which starts the cover at once.
      const settled = NOW + 1_000 + STREAM_SETTLE_MS;
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: settled });
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
      expect(holderTransfersOf(group, settled)?.transferredSupplyPct).toBe(0);

      // A transfer arrives on the stream and moves the read point; no re-read at the 10-minute mark.
      onHolderStreamTx(MINT, "live-send", streamed, settled + 5_000);
      const later = settled + ACCOUNT_REREAD_MS;
      await readTopHolders([group], helius, { maxReads: 1, nowMs: later });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: later });
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
      expect(helius.getTransactionsBatch).not.toHaveBeenCalled();
      expect(holderTransfersOf(group, later)?.transfers).toEqual([
        { from: A, to: B, pct: 3, count: 1, lastAtMs: settled + 5_000 },
      ]);
      expect(takeHolderTransferStats()).toMatchObject({
        getSignaturesForAddress: 3,
        streamSkipped: 3,
        streamDeferred: 0,
      });
    });

    it("leaves the budget to the next coin while one waits for the stream", async () => {
      const OTHER = "other-mint";
      const stream = fakeStream(NOW - 60_000);
      // The first coin was subscribed this cycle; the other has been followed for a minute.
      stream.coveredSince.mockImplementation(((key: string) =>
        key === MINT ? null : stream.since) as never);
      stream.awaitingCover.mockImplementation(((key: string) => key === MINT) as never);
      setHolderTransferStream(stream);
      const base = fakeHelius({}, {});
      const helius = {
        ...base,
        getTopHoldersBatch: vi.fn(
          async (mints: string[]): Promise<Map<string, TopHoldersResult>> =>
            new Map(
              mints.map((m) => [
                m,
                {
                  status: "found",
                  supply: SUPPLY.toString(),
                  holders: [{ owner: A, pct: 5, accounts: [`${m}-acc-a`] }],
                },
              ]),
            ),
        ),
      };
      const first = { mintAddress: MINT, holders: [], creator: null };
      const second = { mintAddress: OTHER, holders: [], creator: null };
      await readTopHolders([first, second], helius, { maxReads: 2, nowMs: NOW });
      expect(
        await resolveHolderTransfers([first, second], helius, {
          maxSignatureReads: 1,
          maxTxReads: 10,
          nowMs: NOW,
        }),
      ).toEqual({ signatureReads: 1, txReads: 0 });
      expect(helius.getAccountSignaturesBatch.mock.calls[0]![0]).toEqual([
        { address: `${OTHER}-acc-a`, until: null },
      ]);
    });

    it("reads anyway once Helius has left a subscription unanswered for STREAM_READ_WAIT_MS", async () => {
      const stream = fakeStream(null, true);
      setHolderTransferStream(stream);
      const helius = fakeHelius({ "acc-a": ["x"], "acc-b": ["y"], "acc-c": ["z"] }, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      for (let t = NOW; t < NOW + STREAM_READ_WAIT_MS; t += 30_000) {
        await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: t });
      }
      expect(helius.getAccountSignaturesBatch).not.toHaveBeenCalled();
      await resolveHolderTransfers([group], helius, {
        maxSignatureReads: 3,
        maxTxReads: 10,
        nowMs: NOW + STREAM_READ_WAIT_MS,
      });
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
      // Read before any cover: a transaction streamed now leaves the read point where it is.
      stream.since = NOW + STREAM_READ_WAIT_MS + 1_000;
      onHolderStreamTx(MINT, "live-send", streamed, NOW + STREAM_READ_WAIT_MS + 5_000);
      const later = NOW + STREAM_READ_WAIT_MS + ACCOUNT_REREAD_MS;
      await readTopHolders([group], helius, { maxReads: 1, nowMs: later });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: later });
      expect(helius.getAccountSignaturesBatch.mock.calls[1]![0]).toEqual([
        { address: "acc-a", until: "x" },
        { address: "acc-b", until: "y" },
        { address: "acc-c", until: "z" },
      ]);
    });

    it("still reads when cycles come slower than STREAM_READ_WAIT_MS and Helius never answers", async () => {
      setHolderTransferStream(fakeStream(null, true));
      const helius = fakeHelius({ "acc-a": ["x"], "acc-b": ["y"], "acc-c": ["z"] }, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: NOW });
      expect(helius.getAccountSignaturesBatch).not.toHaveBeenCalled();
      const slow = NOW + 2 * STREAM_READ_WAIT_MS;
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: slow });
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
    });

    it("reads at once while the stream is not on its way to cover the coin (capped, refused, down)", async () => {
      // Not following and not awaiting an answer: polled as without the stream.
      setHolderTransferStream(fakeStream(null, false));
      const helius = fakeHelius({ "acc-a": ["x"], "acc-b": ["y"], "acc-c": ["z"] }, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      await resolveHolderTransfers([group], helius, { maxSignatureReads: 3, maxTxReads: 10, nowMs: NOW });
      expect(helius.getAccountSignaturesBatch).toHaveBeenCalledTimes(1);
      expect(takeHolderTransferStats()).toMatchObject({ streamDeferred: 0, streamSkipped: 0 });
    });

    it("moves the top-holder list by the balances a streamed transaction left", async () => {
      setHolderTransferStream(fakeStream(NOW - 60_000));
      const helius = fakeHelius({}, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      expect(balanceMovesOf(MINT, streamed)).toEqual([
        { account: "acc-a", owner: A, pre: 50_000_000n, post: 20_000_000n },
        { account: "acc-b", owner: B, pre: 0n, post: 30_000_000n },
      ]);

      onHolderStreamTx(MINT, "live-send", streamed, NOW + 5_000);
      // One account each: each takes its new balance outright (B's 3% was already counted).
      expect(cachedTopHolders(MINT, NOW + 5_000)).toEqual([
        { owner: B, pct: 3 },
        { owner: A, pct: 2 },
        { owner: C, pct: 1 },
      ]);
      // The same transaction again changes nothing; a failed one is left out.
      onHolderStreamTx(MINT, "live-send", streamed, NOW + 6_000);
      const failed = {
        ...streamed,
        meta: { ...streamed.meta, err: { InstructionError: [0, "x"] } },
      } as ChainTx;
      onHolderStreamTx(MINT, "failed", failed, NOW + 7_000);
      expect(cachedTopHolders(MINT, NOW + 7_000)?.map((h) => h.pct)).toEqual([3, 2, 1]);
    });

    it("moves a holder with several token accounts by the difference, and only holders on the list", async () => {
      setHolderTransferStream(fakeStream(NOW - 60_000));
      const helius = {
        ...fakeHelius({}, {}),
        getTopHoldersBatch: vi.fn(
          async (mints: string[]): Promise<Map<string, TopHoldersResult>> =>
            new Map(
              mints.map((m) => [
                m,
                {
                  status: "found",
                  supply: SUPPLY.toString(),
                  holders: [
                    { owner: A, pct: 5, accounts: ["acc-a", "acc-a2"] },
                    { owner: B, pct: 3, accounts: ["acc-b"] },
                  ],
                },
              ]),
            ),
        ),
      };
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      // A sells 1% from its second account to a wallet off the list.
      const sell = {
        meta: {
          err: null,
          preTokenBalances: [
            { accountIndex: 1, mint: MINT, owner: A, uiTokenAmount: { amount: "20000000" } },
          ],
          postTokenBalances: [
            { accountIndex: 1, mint: MINT, owner: A, uiTokenAmount: { amount: "10000000" } },
            { accountIndex: 2, mint: MINT, owner: C, uiTokenAmount: { amount: "10000000" } },
          ],
        },
        transaction: { signatures: ["sell"], message: { accountKeys: [A, "acc-a2", "acc-c"] } },
      } as unknown as ChainTx;
      onHolderStreamTx(MINT, "sell", sell, NOW + 5_000);
      expect(cachedTopHolders(MINT, NOW + 5_000)).toEqual([
        { owner: A, pct: 4 },
        { owner: B, pct: 3 },
      ]);
      // The same transaction again must not subtract the difference a second time.
      onHolderStreamTx(MINT, "sell", sell, NOW + 6_000);
      expect(cachedTopHolders(MINT, NOW + 6_000)).toEqual([
        { owner: A, pct: 4 },
        { owner: B, pct: 3 },
      ]);
    });

    it("adds a buyer who outranks the smallest holder and drops the one who falls out", async () => {
      setHolderTransferStream(fakeStream(NOW - 60_000));
      const helius = fakeHelius({}, {});
      const group = { mintAddress: MINT, holders: [], creator: null };
      await readTopHolders([group], helius, { maxReads: 1, nowMs: NOW });
      // D, who was not on the list, buys 4%. The list keeps its length, so C (1%) leaves.
      const D = "2DKZ9HQ2Q42x1mMf4qYqoXyioLU3wTiN9XkRMiUcVy8F";
      const buy = {
        meta: {
          err: null,
          preTokenBalances: [],
          postTokenBalances: [
            { accountIndex: 1, mint: MINT, owner: D, uiTokenAmount: { amount: "40000000" } },
          ],
        },
        transaction: { signatures: ["buy"], message: { accountKeys: [D, "acc-d"] } },
      } as unknown as ChainTx;
      onHolderStreamTx(MINT, "buy", buy, NOW + 5_000);
      expect(cachedTopHolders(MINT, NOW + 5_000)).toEqual([
        { owner: A, pct: 5 },
        { owner: D, pct: 4 },
        { owner: B, pct: 3 },
      ]);
      // The same transaction again changes nothing: D's one account takes its balance outright.
      onHolderStreamTx(MINT, "buy", buy, NOW + 6_000);
      expect(cachedTopHolders(MINT, NOW + 6_000)).toEqual([
        { owner: A, pct: 5 },
        { owner: D, pct: 4 },
        { owner: B, pct: 3 },
      ]);
    });

    it("re-reads a watched coin's list less often while the stream has followed all its holders", async () => {
      const stream = fakeStream(NOW - 60_000);
      setHolderTransferStream(stream);
      const helius = fakeHelius({}, {});
      const group: LinkedGroup = { mintAddress: MINT, holders: [], creator: null };
      const opts = (nowMs: number) => ({
        maxReads: 1,
        nowMs,
        watched: new Set([MINT]),
        maxWatchedReads: 1,
        watchedRefreshMs: 60_000,
        streamedRefreshMs: 300_000,
        streamed: (g: LinkedGroup, listAtMs: number) => holderListStreamed(g, listAtMs, nowMs),
      });
      await readTopHolders([group], helius, opts(NOW));
      expect(holderListStreamed(group, NOW, NOW)).toBe(true);
      expect(await readTopHolders([group], helius, opts(NOW + 61_000))).toEqual({
        reads: 0,
        watchedReads: 0,
      });
      expect(await readTopHolders([group], helius, opts(NOW + 300_000))).toEqual({
        reads: 0,
        watchedReads: 1,
      });

      // Followed only since just before the list was read: back to the watched pace.
      stream.since = NOW + 300_000 - 10_000;
      expect(holderListStreamed(group, NOW + 300_000, NOW + 300_000)).toBe(false);
      expect(await readTopHolders([group], helius, opts(NOW + 360_000))).toEqual({
        reads: 0,
        watchedReads: 1,
      });
    });
  });
});
