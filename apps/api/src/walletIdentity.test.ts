import { describe, expect, it, vi } from "vitest";
import type { HeliusIdentity, IdentityRead } from "@trenchscanner/core";
import { identityLabels, WalletIdentityReader } from "./walletIdentity.js";

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
    const reader = new WalletIdentityReader({ identity: vi.fn(), batchIdentity: batch });
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
});
