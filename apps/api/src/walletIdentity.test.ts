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
  });
});

describe("WalletIdentityReader", () => {
  it("caches answers and keeps to the minute's budget", async () => {
    const call = vi.fn(async (): Promise<IdentityRead<HeliusIdentity>> => ({
      status: "found",
      value: { type: "exchange", name: "OKX", category: null, tags: [] },
    }));
    const reader = new WalletIdentityReader(
      { identity: call },
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
    const reader = new WalletIdentityReader({ identity: call });
    await reader.labels("a", 0);
    await reader.labels("b", 60_000);
    expect(call).toHaveBeenCalledTimes(1);
    await reader.labels("b", 3_700_000);
    expect(call).toHaveBeenCalledTimes(2);
  });
});
