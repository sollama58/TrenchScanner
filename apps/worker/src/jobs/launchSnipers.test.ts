import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TRADE_FLOW, type HeliusClient, type LaunchBuyersResult } from "@trenchscanner/core";
import { launchSnipersFromCache, resetLaunchSnipersCache, resolveLaunchSnipers } from "./launchSnipers.js";
import { withLaunchSnipers } from "./scanJob.js";

const buyers = (mint: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    wallet: `${mint}-w${i}`,
    tokenAccount: `${mint}-a${i}`,
    bought: 1000,
  }));

function fakeHelius(opts: {
  found?: Record<string, number>;
  balance?: (account: string) => number | undefined;
}) {
  const getLaunchBuyersBatch = vi.fn(async (mints: string[]) => {
    const out = new Map<string, LaunchBuyersResult>();
    for (const m of mints) {
      const n = opts.found?.[m];
      out.set(
        m,
        n === undefined
          ? { status: "failed" }
          : { status: "found", complete: n >= 25, buyers: buyers(m, n), launchAt: null },
      );
    }
    return out;
  });
  const getTokenAccountBalances = vi.fn(async (accounts: string[]) => {
    const out = new Map<string, number>();
    for (const a of accounts) {
      const b = opts.balance ? opts.balance(a) : 1000;
      if (b !== undefined) out.set(a, b);
    }
    return out;
  });
  return {
    helius: { getLaunchBuyersBatch, getTokenAccountBalances } as unknown as HeliusClient,
    getLaunchBuyersBatch,
    getTokenAccountBalances,
  };
}

const opts = { maxNewLookups: 5, refreshMs: 300_000, contenderRefreshMs: 60_000, maxRefreshAccounts: 500 };

describe("resolveLaunchSnipers", () => {
  beforeEach(() => resetLaunchSnipersCache());

  it("reads the first 25 buyers once, counts the first 15, then only refreshes on the TTL", async () => {
    // Even-numbered buyers sold out: 7 of the first 15 hold, 12 of all 25.
    const f = fakeHelius({
      found: { A: 25 },
      balance: (a) => (Number(a.split("-a")[1]) % 2 === 0 ? 0 : 900),
    });
    const groups = [{ mintAddress: "A", contender: false }];
    expect((await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 0 })).get("A")).toEqual({
      holding: 7,
      seen: 15,
      holding25: 12,
    });
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 60_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(1);
    expect(f.getTokenAccountBalances).toHaveBeenCalledTimes(1);
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 301_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(1);
    expect(f.getTokenAccountBalances).toHaveBeenCalledTimes(2);
  });

  it("keeps contenders fresher and reads them first within the budget", async () => {
    const f = fakeHelius({ found: { A: 25, B: 25, C: 25 } });
    const groups = [
      { mintAddress: "C", contender: true },
      { mintAddress: "A", contender: false },
      { mintAddress: "B", contender: false },
    ];
    const first = await resolveLaunchSnipers(groups, f.helius, { ...opts, maxNewLookups: 2, now: 0 });
    expect(f.getLaunchBuyersBatch).toHaveBeenLastCalledWith(["C", "A"], 25);
    expect([...first.keys()].sort()).toEqual(["A", "C"]);
    await resolveLaunchSnipers(groups, f.helius, { ...opts, maxNewLookups: 2, now: 61_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenLastCalledWith(["B"], 25);
    // C (contender, 61s old) and B (new) refreshed; A (61s, not a contender) not.
    expect(f.getTokenAccountBalances.mock.lastCall![0]).toHaveLength(50);
  });

  it("caps refreshed accounts per call", async () => {
    const f = fakeHelius({ found: { A: 25, B: 25 } });
    const groups = [
      { mintAddress: "A", contender: false },
      { mintAddress: "B", contender: false },
    ];
    const out = await resolveLaunchSnipers(groups, f.helius, { ...opts, maxRefreshAccounts: 30, now: 0 });
    expect([...out.keys()]).toEqual(["A"]);
  });

  it("leaves a failed read or an unknown balance as unknown, and backs off the failure", async () => {
    const f = fakeHelius({ found: { A: 25 }, balance: (a) => (a === "A-a3" ? undefined : 0) });
    const groups = [
      { mintAddress: "A", contender: false },
      { mintAddress: "X", contender: false },
    ];
    expect((await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 0 })).size).toBe(0);
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 1_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(1);
  });

  it("re-reads a launch that had fewer than 25 buyers after a while", async () => {
    const f = fakeHelius({ found: { A: 10 } });
    const groups = [{ mintAddress: "A", contender: false }];
    expect((await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 0 })).get("A")).toEqual({
      holding: 10,
      seen: 10,
      holding25: 10,
    });
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 60_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(1);
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 301_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(2);
  });

  it("drops a reading once it is too old to trust", async () => {
    const f = fakeHelius({ found: { A: 25 } });
    await resolveLaunchSnipers([{ mintAddress: "A", contender: false }], f.helius, { ...opts, now: 0 });
    expect(launchSnipersFromCache(["A"], 1_000).size).toBe(1);
    expect(launchSnipersFromCache(["A"], 31 * 60_000).size).toBe(0);
  });
});

describe("withLaunchSnipers", () => {
  it("fills the figure in when the stream has none, and keeps the stream's when it has one", () => {
    const snipers = { holding: 7, seen: 15, holding25: 12 };
    expect(withLaunchSnipers(undefined, snipers)).toEqual({
      ...EMPTY_TRADE_FLOW,
      firstBuyersHolding: 7,
      firstBuyersSeen: 15,
      firstBuyersHolding25: 12,
    });
    const streamed = { ...EMPTY_TRADE_FLOW, firstBuyersHolding: 3, firstBuyersSeen: 15 };
    expect(withLaunchSnipers(streamed, snipers)).toBe(streamed);
    expect(withLaunchSnipers(undefined, undefined)).toBeUndefined();
  });
});
