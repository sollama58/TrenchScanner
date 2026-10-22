import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_TRADE_FLOW, type HeliusClient, type LaunchBuyersResult } from "@trenchscanner/core";
import {
  blockZeroWalletsFromCache,
  launchBuyersFromCache,
  type LaunchReadStore,
  type StoredLaunchRead,
  launchSnipersFromCache,
  resetLaunchSnipersCache,
  resolveLaunchSnipers,
  sniperShareUnobtainable,
  sniperWalletsFromCache,
} from "./launchSnipers.js";
import {
  decisionInputsReady,
  HOURLY_WALLET_CHECKS_MAX_WAIT_MS,
  linkedListReady,
  resetSniperWaits,
  sniperShareReady,
  withChainDevHolding,
  withLaunchSnipers,
  withWalletSignals,
} from "./scanJob.js";

const buyers = (mint: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    wallet: `${mint}-w${i}`,
    tokenAccount: `${mint}-a${i}`,
    bought: 1000,
    slot: i === 0 ? 100 : null,
  }));
/** Every fixture launch mints 100,000, the dev takes 2,000 in the create, slot 100. */
const LAUNCH = { supply: 100_000, devBought: 2_000, createSlot: 100 };

function fakeHelius(opts: {
  found?: Record<string, number>;
  /** Mints whose read comes back complete whatever the count (a history with no curve launch). */
  complete?: Record<string, boolean>;
  balance?: (account: string) => number | undefined;
  /** Mints whose dev bought in the create, into `${mint}-dev` (2,000, LAUNCH's devBought). */
  dev?: string[];
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
              ...LAUNCH,
              ...(opts.dev?.includes(m)
                ? {
                    devAccounts: [
                      { wallet: `${m}-devw`, tokenAccount: `${m}-dev`, bought: 2_000, slot: 100 },
                    ],
                  }
                : {}),
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
      // 900 of a 100,000 supply is over the 0.1% cut.
      holdingCut: 12,
      seen: 25,
      devHolding: null,
      firstBuyersSupplyPct: 25,
      launchBundledBuyers: 1,
      devBuySupplyPct: 2,
      blockZeroHeldPct: null,
      blockZeroBuyers: null,
      blockZeroBoughtPct: null,
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

  it("reads block zero's held share with the first buyers' balances, re-reading a coin held on it faster", async () => {
    const reading = (mint: string): LaunchBuyersResult => ({
      status: "found",
      complete: true,
      buyers: buyers(mint, 25),
      launchAt: null,
      ...LAUNCH,
      // Two block-zero wallets, one past the 25 first buyers.
      blockZeroBuyers: [
        { wallet: `${mint}-w0`, tokenAccount: `${mint}-a0`, bought: 1000, slot: 100 },
        { wallet: `${mint}-z`, tokenAccount: `${mint}-z0`, bought: 9000, slot: 100 },
      ],
    });
    let zHeld = 9000;
    const getLaunchBuyersBatch = vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, reading(m)])));
    const getTokenAccountBalances = vi.fn(
      async (accounts: string[]) => new Map(accounts.map((a) => [a, a.endsWith("-z0") ? zHeld : 1000])),
    );
    const helius = { getLaunchBuyersBatch, getTokenAccountBalances } as unknown as HeliusClient;
    const groups = [{ mintAddress: "A", contender: false }];
    const first = (await resolveLaunchSnipers(groups, helius, { ...opts, now: 0 })).get("A")!;
    expect(first).toMatchObject({ blockZeroHeldPct: 10, blockZeroBuyers: 2, blockZeroBoughtPct: 10 });
    // The block-zero account outside the first buyers is read once, with them.
    expect(getTokenAccountBalances.mock.calls[0]![0]).toContain("A-z0");
    expect(blockZeroWalletsFromCache("A")).toEqual(new Set(["A-w0", "A-a0", "A-z", "A-z0"]));
    // Held at the 10% cut: re-read on the contender TTL, not the 5-minute one.
    zHeld = 0;
    const later = (await resolveLaunchSnipers(groups, helius, { ...opts, now: 61_000 })).get("A")!;
    expect(getTokenAccountBalances).toHaveBeenCalledTimes(2);
    expect(later.blockZeroHeldPct).toBe(1);
    // Under the cut now: back on the band's TTL.
    await resolveLaunchSnipers(groups, helius, { ...opts, now: 122_000 });
    expect(getTokenAccountBalances).toHaveBeenCalledTimes(2);
  });

  it("loads a saved read instead of paying for it, and saves a new one", async () => {
    const f = fakeHelius({ found: { B: 25 } });
    const saved = new Map<string, StoredLaunchRead>([
      [
        "A",
        {
          reading: { buyers: buyers("A", 25), launchAt: null, ...LAUNCH, blockZeroBuyers: [] },
          complete: true,
          readAt: 0,
        },
      ],
    ]);
    const store: LaunchReadStore = {
      load: vi.fn(async (mints) => new Map([...saved].filter(([m]) => mints.includes(m)))),
      save: vi.fn(async (reads) => {
        for (const [m, r] of reads) saved.set(m, r);
      }),
    };
    const groups = [
      { mintAddress: "A", contender: false },
      { mintAddress: "B", contender: false },
    ];
    const out = await resolveLaunchSnipers(groups, f.helius, { ...opts, store, now: 1_000 });
    // A came from the store; only B was read from the chain, and saved.
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledWith(["B"], 25);
    expect(out.get("A")).toMatchObject({ seen: 25, blockZeroBuyers: 0, blockZeroHeldPct: 0 });
    expect(saved.get("B")?.complete).toBe(true);
    // A store that fails costs nothing but the read.
    resetLaunchSnipersCache();
    const broken: LaunchReadStore = {
      load: async () => {
        throw new Error("db down");
      },
      save: async () => {
        throw new Error("db down");
      },
    };
    expect((await resolveLaunchSnipers(groups, f.helius, { ...opts, store: broken, now: 2_000 })).size).toBe(
      1,
    );
  });

  it("re-reads a launch that had fewer than 25 buyers after a while", async () => {
    const f = fakeHelius({ found: { A: 10 } });
    const groups = [{ mintAddress: "A", contender: false }];
    expect((await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 0 })).get("A")).toEqual({
      holding: 10,
      holdingCut: 10,
      seen: 10,
      devHolding: null,
      firstBuyersSupplyPct: 10,
      launchBundledBuyers: 1,
      devBuySupplyPct: 2,
      blockZeroHeldPct: null,
      blockZeroBuyers: null,
      blockZeroBoughtPct: null,
    });
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 60_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(1);
    await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 301_000 });
    expect(f.getLaunchBuyersBatch).toHaveBeenCalledTimes(2);
  });

  it("reads whether the dev still holds with the buyers' balances, and follows a dev who sells", async () => {
    let devBalance = 1_500;
    const f = fakeHelius({
      found: { A: 25, B: 25 },
      dev: ["A"],
      balance: (a) => (a.endsWith("-dev") ? devBalance : 1000),
    });
    const groups = [
      { mintAddress: "A", contender: true },
      { mintAddress: "B", contender: true },
    ];
    const first = await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 0 });
    expect(first.get("A")?.devHolding).toBe(true);
    // No dev buy at launch: nothing on the chain to follow, so unknown (RugCheck's answer stands).
    expect(first.get("B")?.devHolding).toBeNull();
    expect(f.getTokenAccountBalances.mock.calls[0]![0]).toContain("A-dev");
    // Down to dust (under 1% of the 2,000 bought): sold.
    devBalance = 10;
    const later = await resolveLaunchSnipers(groups, f.helius, { ...opts, now: 61_000 });
    expect(later.get("A")?.devHolding).toBe(false);
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
    const snipers = {
      holding: 7,
      holdingCut: 4,
      seen: 25,
      devHolding: true,
      firstBuyersSupplyPct: 25,
      launchBundledBuyers: 3,
      devBuySupplyPct: 2,
      blockZeroHeldPct: null,
      blockZeroBuyers: null,
      blockZeroBoughtPct: null,
    };
    expect(withLaunchSnipers(undefined, snipers)).toEqual({
      ...EMPTY_TRADE_FLOW,
      firstBuyersHolding: 7,
      firstBuyersHoldingCut: 4,
      firstBuyersSeen: 25,
      firstBuyersSupplyPct: 25,
      launchBundledBuyers: 3,
      devBuySupplyPct: 2,
    });
    // The stream's snipers figure stands; the launch shape, which only the chain read has, is added.
    const streamed = { ...EMPTY_TRADE_FLOW, firstBuyersHolding: 3, firstBuyersSeen: 25 };
    expect(withLaunchSnipers(streamed, snipers)).toEqual({
      ...streamed,
      firstBuyersSupplyPct: 25,
      launchBundledBuyers: 3,
      devBuySupplyPct: 2,
    });
    expect(withLaunchSnipers(undefined, undefined)).toBeUndefined();
  });
});

describe("withChainDevHolding", () => {
  const profile = {
    mintAddress: "A",
    mintAuthorityActive: false,
    freezeAuthorityActive: false,
    lpBurned: true,
  };

  it("fills the dev's holding from the chain, ahead of RugCheck's, and keeps RugCheck's without one", () => {
    expect(withChainDevHolding(profile, { devHolding: false })?.creatorHolding).toBe(false);
    expect(
      withChainDevHolding({ ...profile, creatorHolding: true }, { devHolding: false })?.creatorHolding,
    ).toBe(false);
    expect(
      withChainDevHolding({ ...profile, creatorHolding: true }, { devHolding: null })?.creatorHolding,
    ).toBe(true);
    expect(withChainDevHolding(profile, undefined)).toBe(profile);
    expect(withChainDevHolding(null, { devHolding: true })).toBeNull();
  });
});

describe("sniperWalletsFromCache on a short list", () => {
  beforeEach(() => resetLaunchSnipersCache());

  it("measures against a list of fewer than 25 only while its read is fresh", async () => {
    const groups = [
      { mintAddress: "S", contender: true },
      { mintAddress: "F", contender: true },
    ];
    await resolveLaunchSnipers(groups, fakeHelius({ found: { S: 9, F: 25 } }).helius, { ...opts, now: 0 });
    expect(sniperWalletsFromCache("S", 60_000)?.size).toBe(18);
    // Later buyers are missing from a stale short list: unknown, so the decision waits for the re-read.
    expect(sniperWalletsFromCache("S", 3 * 60_000)).toBeUndefined();
    // A full list never changes.
    expect(sniperWalletsFromCache("F", 24 * 3_600_000)?.size).toBe(50);
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
    // And stays out of the way, rather than starting over on the next ask.
    expect(sniperShareReady(unknown, true, W, 91_000)).toBe(true);
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

  it("keeps the hourly lane's wait apart from the decision's", () => {
    expect(sniperShareReady(unknown, true, { ...W, lane: "hourly" }, 0)).toBe(false);
    // The decision's wait starts only now, however long the hourly sample has waited.
    expect(sniperShareReady(unknown, true, W, 90_000)).toBe(false);
    expect(sniperShareReady(unknown, true, { ...W, lane: "hourly" }, 90_000)).toBe(true);
    expect(sniperShareReady(unknown, true, W, 100_000)).toBe(false);
  });
});

describe("decisionInputsReady", () => {
  beforeEach(() => {
    resetLaunchSnipersCache();
    resetSniperWaits();
  });
  const ENV = {
    CURATED_REQUIRE_WALLET_CHECKS: true,
    SNIPER_SHARE_MAX_WAIT_SECONDS: 90,
    SNIPER_SHARE_WAIT_MIN_AGE_MINUTES: 10,
    LINKED_LIST_MAX_WAIT_SECONDS: 60,
    LINKED_HOLDER_READS_PER_CYCLE: 10,
    LINKED_WALLET_LOOKUPS_PER_CYCLE: 30,
  };
  const reads = (lane: "decision" | "hourly") => ({ lane, listRead: false, sniperChainAvailable: true });
  const unread = { mintAddress: "D1", ageMinutes: 30 };
  const walletsIn = { ...unread, freshTop10WalletPct: 10, emptyTop10WalletPct: 0 };
  const allIn = { ...walletsIn, sniperTop10WalletPct: 20, linkedWalletCount: 2, cexFundedCount: 1 };

  it("goes ahead on either lane once everything a decision reads is in", () => {
    expect(decisionInputsReady(allIn, { ...reads("decision"), listRead: true }, ENV, 0)).toEqual({
      ready: true,
      held: [],
    });
    expect(decisionInputsReady(allIn, { ...reads("hourly"), listRead: true }, ENV, 0)).toEqual({
      ready: true,
      held: [],
    });
  });

  it("holds a decision on the wallet checks alone, then starts the sniper and Linked waits", () => {
    expect(decisionInputsReady(unread, reads("decision"), ENV, 0)).toEqual({
      ready: false,
      held: ["walletChecks"],
    });
    // The checks landed late: the other two waits start now, not at the first call.
    expect(decisionInputsReady(walletsIn, reads("decision"), ENV, 100_000)).toEqual({
      ready: false,
      held: ["sniperWait", "linkedWait"],
    });
    expect(decisionInputsReady(walletsIn, reads("decision"), ENV, 100_000 + 60_000)).toEqual({
      ready: false,
      held: ["sniperWait"],
    });
    expect(decisionInputsReady(walletsIn, reads("decision"), ENV, 100_000 + 90_000)).toEqual({
      ready: true,
      held: [],
    });
  });

  it("runs the hourly sample's three waits side by side, on its own clock", () => {
    expect(decisionInputsReady(unread, reads("hourly"), ENV, 0)).toEqual({
      ready: false,
      held: ["walletChecks", "sniperWait", "linkedWait"],
    });
    // The checks landed at 100 s: the sniper and Linked waits have already run their course.
    expect(decisionInputsReady(walletsIn, reads("hourly"), ENV, 100_000)).toEqual({ ready: true, held: [] });
    // The decision's own waits are untouched by the sample's.
    expect(decisionInputsReady(walletsIn, reads("decision"), ENV, 100_000)).toEqual({
      ready: false,
      held: ["sniperWait", "linkedWait"],
    });
  });

  it("banks the hourly sample with the wallet checks unknown once it has waited its bound; a decision never", () => {
    // Young enough that neither the snipers share nor the Linked reading is waited for.
    const young = { ...unread, mintAddress: "D2", ageMinutes: 3 };
    expect(decisionInputsReady(young, reads("hourly"), ENV, 0)).toEqual({
      ready: false,
      held: ["walletChecks"],
    });
    expect(decisionInputsReady(young, reads("hourly"), ENV, HOURLY_WALLET_CHECKS_MAX_WAIT_MS - 1)).toEqual({
      ready: false,
      held: ["walletChecks"],
    });
    expect(decisionInputsReady(young, reads("hourly"), ENV, HOURLY_WALLET_CHECKS_MAX_WAIT_MS)).toEqual({
      ready: true,
      held: [],
    });
    expect(decisionInputsReady(young, reads("decision"), ENV, HOURLY_WALLET_CHECKS_MAX_WAIT_MS)).toEqual({
      ready: false,
      held: ["walletChecks"],
    });
  });

  it("waits for nothing with the wallet checks not required", () => {
    const off = { ...ENV, CURATED_REQUIRE_WALLET_CHECKS: false };
    expect(decisionInputsReady(unread, reads("decision"), off, 0)).toEqual({ ready: true, held: [] });
    expect(decisionInputsReady(unread, reads("hourly"), off, 0)).toEqual({ ready: true, held: [] });
  });
});

describe("launchBuyersFromCache", () => {
  beforeEach(() => resetLaunchSnipersCache());

  it("gives the first buyers' wallets and the launch time once enough are read", async () => {
    const launchAt = new Date("2026-10-12T17:20:20Z");
    const { helius } = fakeHelius({ found: { A: 12, B: 4, C: 3 }, complete: { C: true } });
    (helius.getLaunchBuyersBatch as ReturnType<typeof vi.fn>).mockImplementation(async (mints: string[]) => {
      const counts: Record<string, number> = { A: 12, B: 4, C: 3 };
      return new Map(
        mints.map((m) => [
          m,
          { status: "found", complete: m === "C", buyers: buyers(m, counts[m]!), launchAt, ...LAUNCH },
        ]),
      );
    });
    await resolveLaunchSnipers(
      ["A", "B", "C"].map((mintAddress) => ({ mintAddress, contender: true })),
      helius,
      { ...opts, now: 0 },
    );
    expect(launchBuyersFromCache("A", 10)).toEqual({
      wallets: Array.from({ length: 10 }, (_, i) => `A-w${i}`),
      launchAt,
    });
    // Four buyers so far, more to come: a share over them would change.
    expect(launchBuyersFromCache("B", 10)).toBeUndefined();
    // A launch that had only three buyers in all.
    expect(launchBuyersFromCache("C", 10)?.wallets).toHaveLength(3);
  });
});

describe("linkedListReady", () => {
  beforeEach(() => resetSniperWaits());
  const W = { maxMs: 60_000, minAgeMinutes: 10, readsOn: true };
  const pending = { mintAddress: "L1", ageMinutes: 20 };

  it("waits for the counts over the chain's top 25, then goes ahead", () => {
    expect(linkedListReady(pending, false, W, 0)).toBe(false);
    // A reading over RugCheck's list is in, but the top 25 isn't: still waiting.
    expect(linkedListReady({ ...pending, linkedWalletCount: 3, cexFundedCount: 1 }, false, W, 1_000)).toBe(
      false,
    );
    expect(linkedListReady({ ...pending, linkedWalletCount: 3, cexFundedCount: 1 }, true, W, 2_000)).toBe(
      true,
    );
  });

  it("stops waiting at the cap, and doesn't wait for young coins or with the reads off", () => {
    expect(linkedListReady(pending, false, W, 0)).toBe(false);
    expect(linkedListReady(pending, false, W, 59_000)).toBe(false);
    expect(linkedListReady(pending, false, W, 60_000)).toBe(true);
    expect(linkedListReady({ ...pending, mintAddress: "L2", ageMinutes: 3 }, false, W, 0)).toBe(true);
    expect(linkedListReady({ ...pending, mintAddress: "L3" }, false, { ...W, readsOn: false }, 0)).toBe(true);
  });
});
