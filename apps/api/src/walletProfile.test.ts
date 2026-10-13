// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "./bootstrap-env.js";
import { describe, expect, it, vi } from "vitest";
import type { WalletOverviewResult } from "@trenchscanner/core";
import { recentTrades, walletLabels, WalletLiveReader } from "./walletProfile.js";

const W = "Wa11et1111111111111111111111111111111111111";
const BINANCE = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";

const risk = (over: Partial<Parameters<typeof walletLabels>[0]["risk"] & object> = {}) => ({
  score: 20,
  appearances: 5,
  dumps: 0,
  fastExits: 0,
  snipes: 0,
  medianSupplyPct: null,
  lastSeenAt: new Date(),
  computedAt: new Date(),
  ...over,
});

const base = {
  wallet: W,
  risk: null,
  funderHot: false,
  funderWallet: null,
  launches: 0,
  snipes: 0,
  live: null,
  fundedCount: 0,
};

describe("walletLabels", () => {
  it("names an exchange hot wallet", () => {
    expect(walletLabels({ ...base, wallet: BINANCE }).map((l) => l.text)).toEqual(["Binance hot wallet"]);
  });

  it("flags risky, dumper, dev and sniper from what was read", () => {
    const texts = walletLabels({
      ...base,
      risk: risk({ score: 82, dumps: 3 }),
      launches: 2,
      snipes: 4,
    }).map((l) => l.text);
    expect(texts).toEqual(["Dev of 2 coins", "Risky", "Known dumper", "Launch sniper"]);
  });

  it("says who funded it when the funder is an exchange", () => {
    const labels = walletLabels({ ...base, funderHot: true, funderWallet: BINANCE });
    expect(labels.map((l) => l.text)).toEqual(["Funded from Binance"]);
    const other = walletLabels({ ...base, funderHot: true, funderWallet: W });
    expect(other.map((l) => l.text)).toEqual(["Funded from an exchange or service"]);
  });

  it("marks a fresh wallet only when its whole history was read", () => {
    const fresh: Extract<WalletOverviewResult, { status: "found" }> = {
      status: "found",
      balanceSol: 1,
      txCount: 4,
      complete: true,
      lastAt: new Date(),
      firstAt: new Date(Date.now() - 3_600_000),
    };
    expect(walletLabels({ ...base, live: fresh }).map((l) => l.text)).toEqual(["Fresh wallet"]);
    const busy = { ...fresh, complete: false, txCount: 1000, firstAt: null };
    expect(walletLabels({ ...base, live: busy }).map((l) => l.text)).toEqual(["Very active"]);
  });
});

describe("recentTrades", () => {
  it("merges every coin's trades newest first and drops malformed ones", () => {
    const out = recentTrades(
      [
        {
          mint: "A",
          symbol: "AAA",
          trades: [
            [1000, 1, 0.5, 10],
            [3000, -1, 0.9, 10],
            ["x", 1],
          ],
        },
        { mint: "B", symbol: null, trades: [[2000, 1, null, 5]] },
        { mint: "C", symbol: "CCC", trades: null },
      ],
      2,
    );
    expect(out).toEqual([
      { at: 3000, side: "sell", sol: 0.9, mint: "A", symbol: "AAA" },
      { at: 2000, side: "buy", sol: null, mint: "B", symbol: null },
    ]);
  });
});

describe("WalletLiveReader", () => {
  const found: WalletOverviewResult = {
    status: "found",
    balanceSol: 2,
    txCount: 10,
    complete: true,
    lastAt: null,
    firstAt: null,
  };

  it("reads each wallet once per TTL", async () => {
    const getWalletOverview = vi.fn(async () => found);
    const reader = new WalletLiveReader(
      { getWalletOverview, getFundersBatch: vi.fn() },
      { ttlMs: 1000, perMinute: 10 },
    );
    await reader.overview(W, 0);
    await reader.overview(W, 500);
    expect(getWalletOverview).toHaveBeenCalledTimes(1);
    await reader.overview(W, 1500);
    expect(getWalletOverview).toHaveBeenCalledTimes(2);
  });

  it("stops reading past the per-minute budget, and doesn't keep failures", async () => {
    const getWalletOverview = vi.fn(async (): Promise<WalletOverviewResult> => ({ status: "failed" }));
    const reader = new WalletLiveReader(
      { getWalletOverview, getFundersBatch: vi.fn() },
      { ttlMs: 60_000, perMinute: 2 },
    );
    expect(await reader.overview(W, 0)).toEqual({ status: "failed" });
    expect(await reader.overview(W, 1)).toEqual({ status: "failed" });
    expect(await reader.overview(W, 2)).toBeNull();
    expect(getWalletOverview).toHaveBeenCalledTimes(2);
    expect(await reader.overview(W, 60_010)).toEqual({ status: "failed" });
  });
});
