import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TRADE_FLOW, type HeliusClient, type LaunchBuyersResult } from "@trenchscanner/core";
import {
  launchSnipersFromCache,
  resetLaunchSnipersCache,
  resolveLaunchSnipers,
  sniperShareUnobtainable,
  sniperWalletsFromCache,
} from "./launchSnipers.js";
import { resetSniperWaits, sniperShareReady, withLaunchSnipers, withWalletSignals } from "./scanJob.js";

const buyers = (mint: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    wallet: `${mint}-w${i}`,
    tokenAccount: `${mint}-a${i}`,
    bought: 1000,
  }));

function fakeHelius(opts: {
  found?: Record<string, number>;
  /** Mints whose read comes back complete whatever the count (a history with no curve launch). */
  complete?: Record<string, boolean>;
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
          : {
              status: "found",
              complete: opts.complete?.[m] ?? n >= 25,
              buyers: buyers(m, n),
              launchAt: null,
            },
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

  it("reads first buyers once, then only refreshes holdings on the TTL", async () => {
    // Even-numbered buyers sold out.
    const f = fakeHelius({
      found: { A: 25 },
      balance: (a) => (Number(a.split("-a")[1]) % 2 === 0 ? 0 : 900),
    });
    const groups = [{ mintAddress: "A", contender: false }];
    expect((await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 0 })).get("A")).toEqual({
      holding: 12,
      seen: 25,
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
    const first = await resolveLaunchSnipers(groups, f.helius, {
      ...opts,
      maxNewLookups: 1,
      maxContenderLookups: 1,
      now: 0,
    });
    expect(f.getLaunchBuyersBatch).toHaveBeenLastCalledWith(["C", "A"], 25);
    expect([...first.keys()].sort()).toEqual(["A", "C"]);
    await resolveLaunchSnipers(groups, f.helius, {
      ...opts,
      maxNewLookups: 1,
      maxContenderLookups: 1,
      now: 61_000,
    });
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
    const snipers = { holding: 7, seen: 25 };
    expect(withLaunchSnipers(undefined, snipers)).toEqual({
      ...EMPTY_TRADE_FLOW,
      firstBuyersHolding: 7,
      firstBuyersSeen: 25,
    });
    const streamed = { ...EMPTY_TRADE_FLOW, firstBuyersHolding: 3, firstBuyersSeen: 25 };
    expect(withLaunchSnipers(streamed, snipers)).toBe(streamed);
    expect(withLaunchSnipers(undefined, undefined)).toBeUndefined();
  });
});

describe("snipers in the top 10", () => {
  beforeEach(() => resetLaunchSnipersCache());

  it("measures the top-10 list against the first buyers once they are read, unknown before", async () => {
    const profile = {
      mintAddress: "A",
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      lpBurned: true,
      // Two of the first buyers, two later holders (the pool is never in the list).
      top10HolderAddresses: ["A-w0", "A-w7", "late1", "late2"],
    };
    const env = { WALLET_HOLDINGS_MIN_USD: 25 };
    expect(sniperWalletsFromCache("A")).toBeUndefined();
    expect(
      withWalletSignals(profile, new Map(), new Map(), env, undefined)?.sniperTop10WalletPct,
    ).toBeUndefined();
    await resolveLaunchSnipers(
      [{ mintAddress: "A", contender: true }],
      fakeHelius({ found: { A: 25 } }).helius,
      {
        ...opts,
        now: 0,
      },
    );
    const wallets = sniperWalletsFromCache("A");
    // Each buyer's wallet and token account.
    expect(wallets?.size).toBe(50);
    expect(withWalletSignals(profile, new Map(), new Map(), env, wallets)?.sniperTop10WalletPct).toBe(50);
    // A holder listed by token account (no owner from RugCheck) is still recognized.
    const byAccount = { ...profile, top10HolderAddresses: ["A-a0", "late1"] };
    expect(withWalletSignals(byAccount, new Map(), new Map(), env, wallets)?.sniperTop10WalletPct).toBe(50);
  });

  it("gives contenders their own read budget, ahead of the rest", async () => {
    const f = fakeHelius({ found: { A: 25, B: 25, C: 25, D: 25 } });
    const groups = [
      { mintAddress: "A", contender: true },
      { mintAddress: "B", contender: true },
      { mintAddress: "C", contender: false },
      { mintAddress: "D", contender: false },
    ];
    await resolveLaunchSnipers(groups, f.helius, {
      ...opts,
      maxNewLookups: 1,
      maxContenderLookups: 2,
      now: 0,
    });
    expect(f.getLaunchBuyersBatch).toHaveBeenLastCalledWith(["A", "B", "C"], 25);
  });

  it("reads a contender with no list before re-reading one with an incomplete list", async () => {
    const f = fakeHelius({ found: { A: 10, B: 25 } });
    await resolveLaunchSnipers([{ mintAddress: "A", contender: true }], f.helius, { ...opts, now: 0 });
    const groups = [
      { mintAddress: "A", contender: true },
      { mintAddress: "B", contender: true },
    ];
    // A's 10-buyer list is due a re-read, but B has no list at all and its decision waits on one.
    await resolveLaunchSnipers(groups, f.helius, { ...opts, maxContenderLookups: 1, now: 180_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenLastCalledWith(["B"], 25);
  });

  it("retries a contender's failed read after a minute, the rest after five", async () => {
    const f = fakeHelius({});
    const groups = [
      { mintAddress: "A", contender: true },
      { mintAddress: "B", contender: false },
    ];
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 0 });
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 61_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenLastCalledWith(["A"], 25);
  });

  it("re-reads a contender's incomplete list within two minutes", async () => {
    const f = fakeHelius({ found: { A: 10 } });
    await resolveLaunchSnipers([{ mintAddress: "A", contender: true }], f.helius, { ...opts, now: 0 });
    await resolveLaunchSnipers([{ mintAddress: "A", contender: true }], f.helius, { ...opts, now: 121_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(2);
  });

  it("calls the share unobtainable only for a launch read with no buyers", async () => {
    const f = fakeHelius({ found: { A: 0, B: 3 }, complete: { A: true } });
    expect(sniperShareUnobtainable("A")).toBe(false);
    await resolveLaunchSnipers(
      [
        { mintAddress: "A", contender: true },
        { mintAddress: "B", contender: true },
      ],
      f.helius,
      { ...opts, now: 0 },
    );
    expect(sniperShareUnobtainable("A")).toBe(true);
    // Fewer buyers than asked so far is a read to repeat, not a launch without snipers.
    expect(sniperShareUnobtainable("B")).toBe(false);
  });
});

describe("sniperShareReady", () => {
  beforeEach(() => {
    resetLaunchSnipersCache();
    resetSniperWaits();
  });
  const unknown = { mintAddress: "A", sniperTop10WalletPct: undefined, ageMinutes: 30 };
  const W = { maxMs: 90_000, minAgeMinutes: 10 };

  it("holds a decision until the share is in, unless it can't come", () => {
    expect(sniperShareReady(unknown, true, W, 0)).toBe(false);
    expect(sniperShareReady({ ...unknown, sniperTop10WalletPct: 0 }, true, W, 1_000)).toBe(true);
    // The chain read is off or the endpoint is standing down: nothing to wait for.
    expect(sniperShareReady(unknown, false, W, 2_000)).toBe(true);
  });

  it("stops waiting once the token has waited the longest allowed", () => {
    expect(sniperShareReady(unknown, true, W, 0)).toBe(false);
    expect(sniperShareReady(unknown, true, W, 60_000)).toBe(false);
    expect(sniperShareReady(unknown, true, W, 90_000)).toBe(true);
    // Another token's wait is its own.
    expect(sniperShareReady({ ...unknown, mintAddress: "B" }, true, W, 90_000)).toBe(false);
  });

  it("doesn't make a young coin wait; an unknown age waits", () => {
    expect(sniperShareReady({ ...unknown, ageMinutes: 2 }, true, W, 0)).toBe(true);
    expect(sniperShareReady({ ...unknown, ageMinutes: undefined }, true, W, 0)).toBe(false);
  });

  it("doesn't wait at all with the bound at 0", () => {
    expect(sniperShareReady(unknown, true, { ...W, maxMs: 0 }, 0)).toBe(true);
  });
});
