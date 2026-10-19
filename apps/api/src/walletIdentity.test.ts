import { describe, expect, it, vi } from "vitest";
import type { HeliusIdentity, IdentityRead } from "@trenchscanner/core";
import { identityLabels, type IdentityStore, WalletIdentityReader } from "./walletIdentity.js";

describe("identityLabels", () => {
  it("turns Helius's name and tags into the modal's labels", () => {
    const labels = identityLabels({
      type: "exchange",
      name: "Binance 1",
      category: "Centralized Exchange",
      tags: ["Centralized Exchange", "Hot Wallet"],
    });
    expect(labels).toEqual([
      { text: "Binance 1", tone: "info", source: "Helius", detail: "Centralized Exchange" },
      { text: "Hot Wallet", tone: "info", source: "Helius", detail: undefined },
    ]);
    expect(identityLabels(null)).toEqual([]);
    expect(
      identityLabels({ type: "wallet", name: "degen", category: null, tags: [], pumpfun: true }),
    ).toEqual([{ text: '"degen"', tone: "pumpfun", source: "Helius", detail: "Pump.fun username" }]);
    expect(identityLabels({ type: "wallet", name: "ape", category: null, tags: [], fomo: true })).toEqual([
      { text: '"ape"', tone: "fomo", source: "Helius", detail: "FOMO username" },
    ]);
  });
});

describe("WalletIdentityReader", () => {
  it("caches answers and keeps to the minute's budget", async () => {
    const call = vi.fn(async (): Promise<IdentityRead<HeliusIdentity>> => ({
      status: "found",
      value: { type: "exchange", name: "OKX", category: null, tags: [] },
    }));
    const reader = new WalletIdentityReader(
      { identity: call, batchIdentity: vi.fn() },
      { ttlMs: 60_000, perMinute: 2, maxEntries: 10 },
    );
    expect((await reader.labels("a", 0)).map((l) => l.text)).toEqual(["OKX"]);
    expect((await reader.labels("a", 1_000)).map((l) => l.text)).toEqual(["OKX"]);
    expect(call).toHaveBeenCalledTimes(1);
    await reader.labels("b", 2_000);
    expect(await reader.labels("c", 3_000)).toEqual([]);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("leaves a plan that can't read it alone for an hour", async () => {
    const call = vi.fn(async (): Promise<IdentityRead<HeliusIdentity>> => ({ status: "unavailable" }));
    const reader = new WalletIdentityReader({ identity: call, batchIdentity: vi.fn() });
    await reader.labels("a", 0);
    await reader.labels("b", 60_000);
    expect(call).toHaveBeenCalledTimes(1);
    await reader.labels("b", 3_700_000);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("reads a list's misses in one batch and serves the rest from the cache", async () => {
    const batch = vi.fn(async (wallets: readonly string[]) => ({
      status: "found" as const,
      value: new Map<string, HeliusIdentity | null>(
        wallets.map((w) => [
          w,
          w === "a" ? { type: "exchange", name: "OKX", category: null, tags: [] } : null,
        ]),
      ),
    }));
    const reader = new WalletIdentityReader({ identity: vi.fn(), batchIdentity: batch }, { batchWaitMs: 0 });
    const first = await reader.identities(["a", "b", "a"], 0);
    expect([...first.entries()]).toEqual([
      ["a", { type: "exchange", name: "OKX", category: null, tags: [] }],
      ["b", null],
    ]);
    expect(batch).toHaveBeenCalledWith(["a", "b"]);
    await reader.identities(["a", "b", "c"], 1_000);
    expect(batch).toHaveBeenLastCalledWith(["c"]);
    expect(batch).toHaveBeenCalledTimes(2);
    expect((await reader.labels("a", 2_000)).map((l) => l.text)).toEqual(["OKX"]);
  });

  const named = (wallets: readonly string[]) => ({
    status: "found" as const,
    value: new Map<string, HeliusIdentity | null>(wallets.map((w) => [w, null])),
  });

  it("keeps each account to its own share of the minute and its day", async () => {
    const batch = vi.fn(async (wallets: readonly string[]) => named(wallets));
    const reader = new WalletIdentityReader(
      { identity: vi.fn(), batchIdentity: batch },
      { perMinute: 20, perUserPerMinute: 2, perUserPerDay: 3, batchWaitMs: 0 },
    );
    await reader.identities(["a"], 0, "u1");
    await reader.identities(["b"], 1_000, "u1");
    expect((await reader.identities(["c"], 2_000, "u1")).size).toBe(0);
    // Another account still has its share.
    expect((await reader.identities(["c"], 2_000, "u2")).size).toBe(1);
    // A new minute, but u1 has one call left today.
    expect((await reader.identities(["d"], 61_000, "u1")).size).toBe(1);
    expect((await reader.identities(["e"], 122_000, "u1")).size).toBe(0);
    // A day on, the account's budget is back.
    expect((await reader.identities(["e"], 86_400_000 + 2_000, "u1")).size).toBe(1);
  });

  it("drops the least recently used answer when full, not the whole cache", async () => {
    const batch = vi.fn(async (wallets: readonly string[]) => named(wallets));
    const reader = new WalletIdentityReader(
      { identity: vi.fn(), batchIdentity: batch },
      { maxEntries: 2, perMinute: 100, batchWaitMs: 0 },
    );
    await reader.identities(["a", "b"], 0);
    await reader.identities(["a"], 1); // a is now the most recent
    await reader.identities(["c"], 2); // evicts b only
    batch.mockClear();
    await reader.identities(["a", "b", "c"], 3);
    expect(batch).toHaveBeenCalledWith(["b"]);
  });

  it("answers from the database before asking Helius, and keeps what Helius says", async () => {
    const okx: HeliusIdentity = { type: "exchange", name: "OKX", category: null, tags: [] };
    const kept = new Map<string, { at: number; value: HeliusIdentity | null }>([
      ["a", { at: 0, value: okx }],
    ]);
    const store: IdentityStore = {
      read: vi.fn(async (wallets: readonly string[], since: Date) => {
        const out = new Map<string, { at: number; value: HeliusIdentity | null }>();
        for (const w of wallets) {
          const hit = kept.get(w);
          if (hit && hit.at >= since.getTime()) out.set(w, hit);
        }
        return out;
      }),
      write: vi.fn(async (answers: ReadonlyMap<string, HeliusIdentity | null>, at: Date) => {
        for (const [w, value] of answers) kept.set(w, { at: at.getTime(), value });
      }),
    };
    const batch = vi.fn(async (wallets: readonly string[]) => ({
      status: "found" as const,
      value: new Map<string, HeliusIdentity | null>(wallets.map((w) => [w, null])),
    }));
    const single = vi.fn(async (): Promise<IdentityRead<HeliusIdentity>> => ({ status: "none" }));
    const reader = new WalletIdentityReader(
      { identity: single, batchIdentity: batch },
      { batchWaitMs: 0 },
      store,
    );

    expect((await reader.labels("a", 1_000)).map((l) => l.text)).toEqual(["OKX"]);
    expect(single).not.toHaveBeenCalled();

    const names = await reader.identities(["a", "b"], 1_000);
    expect([...names.entries()]).toEqual([
      ["a", okx],
      ["b", null],
    ]);
    expect(batch).toHaveBeenCalledWith(["b"]);
    expect(store.write).toHaveBeenCalledWith(new Map([["b", null]]), new Date(1_000));

    // A new process (a deploy) reads "b" from the database, not from Helius.
    const after = new WalletIdentityReader(
      { identity: single, batchIdentity: batch },
      { batchWaitMs: 0 },
      store,
    );
    expect(await after.labels("b", 2_000)).toEqual([]);
    expect(single).not.toHaveBeenCalled();
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("queues a list's few misses and reads them together once the oldest has waited", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const batch = vi.fn(async (wallets: readonly string[]) => named(wallets));
      const reader = new WalletIdentityReader(
        { identity: vi.fn(), batchIdentity: batch },
        { batchWaitMs: 60_000, askNowAt: 5 },
      );
      expect((await reader.identities(["a"], 0, "u1")).size).toBe(0);
      expect((await reader.identities(["b", "a"], 10_000, "u2")).size).toBe(0);
      expect(batch).not.toHaveBeenCalled();
      // A list asking after the oldest has waited reads the whole queue, its own misses too, in one call.
      expect([...(await reader.identities(["a", "c"], 60_000, "u1")).keys()]).toEqual(["a", "c"]);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch).toHaveBeenLastCalledWith(["a", "b", "c"]);
      // With nobody asking, the timer reads the queue once its oldest has waited.
      vi.setSystemTime(61_000);
      expect((await reader.identities(["d"], 61_000)).size).toBe(0);
      await vi.advanceTimersByTimeAsync(59_000);
      expect(batch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(batch).toHaveBeenLastCalledWith(["d"]);
      expect((await reader.identities(["b", "d"], 121_000)).size).toBe(2);
      // A list bringing askNowAt misses is read straight away, the queue with it.
      await reader.identities(["j"], 122_000);
      await reader.identities(["e", "f", "g", "h", "i"], 123_000);
      expect(batch).toHaveBeenLastCalledWith(["j", "e", "f", "g", "h", "i"]);
      expect(batch).toHaveBeenCalledTimes(3);
      reader.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the modal's one-wallet reads to the account's share too", async () => {
    const call = vi.fn(async (): Promise<IdentityRead<HeliusIdentity>> => ({ status: "none" }));
    const reader = new WalletIdentityReader(
      { identity: call, batchIdentity: vi.fn() },
      { perUserPerMinute: 1, perUserPerDay: 10 },
    );
    await reader.labels("a", 0, "u1");
    await reader.labels("b", 1_000, "u1");
    expect(call).toHaveBeenCalledTimes(1);
    await reader.labels("b", 1_000, "u2");
    expect(call).toHaveBeenCalledTimes(2);
  });
});
