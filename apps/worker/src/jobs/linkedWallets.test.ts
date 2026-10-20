// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type FunderActivityResult, type FunderResult } from "@trenchscanner/core";
import {
  cachedTopHolders,
  cexReadingOf,
  linkedHoldersOf,
  currentTopHolders,
  readTopHolders,
  TOP_HOLDERS_OLD_REFRESH_MS,
  TOP_HOLDERS_REFRESH_MS,
  type LinkedGroup,
  linkedReadingOf,
  resetLinkedWallets,
  resolveLinkedWallets,
  storeWideMapReadings,
  takeLinkedWalletStats,
  wideMapReadings,
} from "./linkedWallets.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);
const TAG = `linked-test-${Date.now()}`;
const w = (name: string) => `${TAG}-${name}`;

function fakeHelius(
  funders: Record<string, FunderResult>,
  hot: Record<string, boolean> = {},
  gtfaUsable = true,
) {
  return {
    gtfaUsable,
    getFundersBatch: vi.fn(async (wallets: string[]) => {
      return new Map(wallets.map((x) => [x, funders[x] ?? ({ status: "failed" } as FunderResult)]));
    }),
    getFunderActivityBatch: vi.fn(async (addresses: string[]) => {
      return new Map<string, FunderActivityResult>(
        addresses.map((a) => [a, { status: "found", fullPageSpanMs: hot[a] ? 60_000 : null }]),
      );
    }),
  };
}

const found = (funder: string): Extract<FunderResult, { status: "found" }> => ({
  status: "found",
  funder,
  amountSol: 1,
  fundedAt: new Date(),
});

describe.skipIf(!dbAvailable)("linked wallets", () => {
  beforeEach(() => resetLinkedWallets());
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.walletFunder.deleteMany({ where: { wallet: { startsWith: TAG } } });
    await prisma.funderActivity.deleteMany({ where: { address: { startsWith: TAG } } });
  });

  it("reads funders and hot verdicts, caches them, and reads clusters from them", async () => {
    const group = {
      mintAddress: w("mint"),
      holders: [
        { owner: w("a"), pct: 12 },
        { owner: w("b"), pct: 9 },
        { owner: w("c"), pct: 4 },
      ],
      creator: w("dev"),
    };
    const helius = fakeHelius(
      {
        [w("a")]: found(w("F")),
        [w("b")]: found(w("F")),
        [w("c")]: found(w("CEX")),
        // A busy creator wallet: read with the sorted lookup.
        [w("dev")]: { ...found(w("D")), sorted: true },
      },
      { [w("CEX")]: true },
    );
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 10 });
    const reading = linkedReadingOf(group, lookups)!;
    expect(reading).toMatchObject({
      linkedClusterCount: 1,
      // a and b share F; all three were funded the same moment, so c counts as linked too.
      linkedWalletPct: 25,
      linkedWalletCount: 3,
      linkedLargestClusterPct: 21,
    });
    expect(helius.getFundersBatch).toHaveBeenCalledTimes(1);
    // Signatures for four, three first transactions, one sorted lookup, three funder checks.
    expect(takeLinkedWalletStats().credits).toBe(4 + 3 + 10 + 3);

    // A fresh process reads it all from the tables, with no calls.
    resetLinkedWallets();
    const again = fakeHelius({});
    const cached = await resolveLinkedWallets([group], again, { maxNewLookups: 10 });
    expect(again.getFundersBatch).not.toHaveBeenCalled();
    expect(again.getFunderActivityBatch).not.toHaveBeenCalled();
    expect(linkedReadingOf(group, cached)).toMatchObject({ linkedWalletPct: 25 });
  });

  it("stores the cycle's hot verdicts in one write, replacing a stale one", async () => {
    // A verdict past its week: checked again, and the row takes the new answer.
    await prisma.funderActivity.create({
      data: {
        address: w("STALE"),
        hot: false,
        fullPageSpanMs: null,
        checkedAt: new Date(Date.now() - 8 * 86_400_000),
      },
    });
    const group = {
      mintAddress: w("m-hot"),
      holders: [
        { owner: w("h1"), pct: 10 },
        { owner: w("h2"), pct: 6 },
      ],
    };
    const helius = fakeHelius(
      { [w("h1")]: found(w("STALE")), [w("h2")]: found(w("QUIET")) },
      { [w("STALE")]: true },
    );
    await resolveLinkedWallets([group], helius, { maxNewLookups: 10 });
    expect(helius.getFunderActivityBatch).toHaveBeenCalledWith(
      expect.arrayContaining([w("STALE"), w("QUIET")]),
    );
    const stored = await prisma.funderActivity.findMany({
      where: { address: { in: [w("STALE"), w("QUIET")] } },
      orderBy: { address: "asc" },
    });
    expect(stored.map((r) => [r.address, r.hot, r.fullPageSpanMs])).toEqual([
      [w("QUIET"), false, null],
      [w("STALE"), true, 60_000],
    ]);
    expect(Date.now() - stored[1]!.checkedAt.getTime()).toBeLessThan(60_000);
  });

  it("reads the exchange-funded share from the same holders", async () => {
    const group = {
      mintAddress: w("m3"),
      holders: [
        { owner: w("p"), pct: 10 },
        { owner: w("q"), pct: 8 },
        { owner: w("r"), pct: 2 },
        { owner: w("s"), pct: 1 },
      ],
    };
    const helius = fakeHelius(
      {
        [w("p")]: found(w("EX")),
        [w("q")]: found(w("H")),
        [w("r")]: found(w("EX")),
        [w("s")]: { status: "none" },
      },
      { [w("EX")]: true },
    );
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 10 });
    expect(cexReadingOf(group, lookups)).toEqual({
      cexFundedPct: 50,
      cexFundedCount: 2,
      cexFundedHolders: 4,
      cexFunders: [
        { wallet: w("p"), funder: w("EX") },
        { wallet: w("r"), funder: w("EX") },
      ],
    });
  });

  it("leaves a group over the budget unread, and its reading unknown", async () => {
    const group = {
      mintAddress: w("m2"),
      holders: [
        { owner: w("x"), pct: 5 },
        { owner: w("y"), pct: 5 },
      ],
    };
    const helius = fakeHelius({ [w("x")]: found(w("G")), [w("y")]: found(w("G")) });
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 1 });
    expect(helius.getFundersBatch).not.toHaveBeenCalled();
    expect(linkedReadingOf(group, lookups)).toBeNull();
  });

  it("takes up to the top-20 holders with their shares", () => {
    const shares = Array.from({ length: 22 }, (_, i) => ({ owner: `h${i}`, pct: 22 - i }));
    const holders = linkedHoldersOf({ top10HolderAddresses: ["h0"], topHolderShares: shares });
    expect(holders).toHaveLength(20);
    expect(holders[19]).toEqual({ owner: "h19", pct: 3 });
    expect(linkedHoldersOf({ top10HolderAddresses: ["h0"] })).toEqual([]);
  });
  it("reads a wallet stored as busy again once the sorted lookup can reach it", async () => {
    await prisma.walletFunder.create({ data: { wallet: w("old"), status: "busy" } });
    const group = { mintAddress: w("m3"), holders: [{ owner: w("old"), pct: 9 }] };
    const off = fakeHelius({}, {}, false);
    const without = await resolveLinkedWallets([group], off, { maxNewLookups: 10 });
    expect(off.getFundersBatch).not.toHaveBeenCalled();
    expect(without.funderOf.get(w("old"))).toBeNull();

    const on = fakeHelius({ [w("old")]: { ...found(w("H")), sorted: true } });
    const lookups = await resolveLinkedWallets([group], on, { maxNewLookups: 10 });
    expect(on.getFundersBatch).toHaveBeenCalledWith([w("old")], expect.anything());
    expect(lookups.funderOf.get(w("old"))).toBe(w("H"));
    expect(await prisma.walletFunder.findUnique({ where: { wallet: w("old") } })).toMatchObject({
      status: "found",
      funder: w("H"),
    });
  });

  it("hands a wallet's aged answer to the re-read, so an unrevived wallet costs only its page", async () => {
    const stale = new Date(Date.now() - 10 * 86_400_000);
    await prisma.walletFunder.create({
      data: {
        wallet: w("aged"),
        status: "found",
        funder: w("A"),
        amountSol: 1.5,
        fundedAt: stale,
        lastActivityAt: stale,
      },
    });
    const group = { mintAddress: w("m4b"), holders: [{ owner: w("aged"), pct: 7 }] };
    const helius = fakeHelius({ [w("aged")]: { ...found(w("A")), reads: 0 } });
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 10 });
    expect(helius.getFundersBatch).toHaveBeenCalledWith([w("aged")], {
      nowMs: expect.any(Number),
      knownOf: new Map([[w("aged"), { funder: w("A"), amountSol: 1.5, fundedAt: stale }]]),
    });
    expect(lookups.funderOf.get(w("aged"))).toBe(w("A"));
    const stats = takeLinkedWalletStats();
    // One page for the wallet, one activity check for its funder: no walk, no sorted read.
    expect(stats.getSignaturesForAddress).toBe(2);
    expect(stats.getTransaction).toBe(0);
    expect(stats.getTransactionsForAddress).toBe(0);
  });

  it("reads a wallet stored with no funder by the first-transaction-only read again", async () => {
    await prisma.walletFunder.create({
      data: { wallet: w("early"), status: "none", checkedAt: new Date("2026-10-13T12:00:00Z") },
    });
    const group = { mintAddress: w("m4"), holders: [{ owner: w("early"), pct: 7 }] };
    const helius = fakeHelius({ [w("early")]: { ...found(w("K")), reads: 2 } });
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 10 });
    expect(helius.getFundersBatch).toHaveBeenCalledWith([w("early")], expect.anything());
    expect(lookups.funderOf.get(w("early"))).toBe(w("K"));
    expect(takeLinkedWalletStats().getTransaction).toBe(2);
    expect(await prisma.walletFunder.findUnique({ where: { wallet: w("early") } })).toMatchObject({
      status: "found",
      funder: w("K"),
    });
  });

  it("groups holders funded in the same minute, from fetched and stored funding times", async () => {
    const t0 = new Date("2026-10-13T12:00:00Z");
    await prisma.walletFunder.create({
      data: { wallet: w("st1"), status: "found", funder: w("P1"), fundedAt: t0, lastActivityAt: new Date() },
    });
    const group = {
      mintAddress: w("m5"),
      holders: [
        { owner: w("st1"), pct: 6 },
        { owner: w("st2"), pct: 5 },
        { owner: w("st3"), pct: 4 },
      ],
    };
    const helius = fakeHelius({
      [w("st2")]: { ...found(w("P2")), fundedAt: new Date(t0.getTime() + 30_000) },
      [w("st3")]: { ...found(w("P3")), fundedAt: new Date(t0.getTime() + 3_600_000) },
    });
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 10 });
    const reading = linkedReadingOf(group, lookups)!;
    expect(reading.linkedClusterCount).toBe(0);
    expect(reading).toMatchObject({ sameTimeClusterCount: 1, sameTimeFundedPct: 11 });
    expect(reading.sameTimeClusters[0]!.wallets.map((x) => x.wallet)).toEqual([w("st1"), w("st2")]);

    // A fresh process reads the times back from the table.
    resetLinkedWallets();
    const again = await resolveLinkedWallets([group], fakeHelius({}), { maxNewLookups: 10 });
    expect(linkedReadingOf(group, again)).toMatchObject({ sameTimeClusterCount: 1 });
  });

  it("reads a wallet again once it could have sat a week idle, and stores who paid it on waking", async () => {
    // The farm on mdj29p8m...pump: aged wallets left empty for months, paid again a minute apart
    // by different payers before the launch. Their stored first-ever funders say nothing today.
    const DAY = 86_400_000;
    const old = new Date(Date.now() - 200 * DAY);
    await prisma.walletFunder.createMany({
      data: [
        {
          wallet: w("rv1"),
          status: "found",
          funder: w("Q1"),
          fundedAt: old,
          lastActivityAt: new Date(Date.now() - 8 * DAY),
        },
        { wallet: w("rv2"), status: "found", funder: w("Q2"), fundedAt: old },
      ],
    });
    const t0 = new Date(Date.now() - 3_600_000);
    const helius = fakeHelius({
      [w("rv1")]: { ...found(w("R1")), fundedAt: t0, revived: true, lastActivityAt: new Date() },
      [w("rv2")]: {
        ...found(w("R2")),
        fundedAt: new Date(t0.getTime() + 2_000),
        revived: true,
        lastActivityAt: new Date(),
      },
    });
    const group = {
      mintAddress: w("m6"),
      holders: [
        { owner: w("rv1"), pct: 5 },
        { owner: w("rv2"), pct: 5 },
      ],
    };
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 10 });
    expect(helius.getFundersBatch).toHaveBeenCalledWith([w("rv1"), w("rv2")], expect.anything());
    expect(linkedReadingOf(group, lookups)).toMatchObject({
      sameTimeClusterCount: 1,
      sameTimeFundedCount: 2,
    });
    expect(await prisma.walletFunder.findUnique({ where: { wallet: w("rv1") } })).toMatchObject({
      funder: w("R1"),
      fundedAt: t0,
      revived: true,
    });

    // Read now, the rows hold: no read on the next pass.
    resetLinkedWallets();
    const quiet = fakeHelius({});
    await resolveLinkedWallets([group], quiet, { maxNewLookups: 10 });
    expect(quiet.getFundersBatch).not.toHaveBeenCalled();
  });

  it("puts an alerted coin's known top-50 wallets on its bubble map, and nobody new", async () => {
    const mint = w("wide-mint");
    const top = Array.from({ length: 26 }, (_, i) => ({ owner: w(`t${i}`), pct: 40 - i }));
    const extra = (i: number) => ({ owner: w(`x${i}`), pct: 1 - i / 100 });
    const wideList = [...top, extra(0), extra(1), extra(2), extra(3)];
    const funders: Record<string, FunderResult> = Object.fromEntries(
      top.map((h, i) => [h.owner, found(w(`own${i}`))]),
    );
    // t0 and t1 share F1: one cluster on the top 25.
    funders[w("t0")] = found(w("F1"));
    funders[w("t1")] = found(w("F1"));
    const helius = {
      ...fakeHelius(funders),
      getTopHoldersBatch: vi.fn(async (mints: string[], n: number) => {
        expect(n).toBe(51);
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: wideList }]));
      }),
    };
    const group: LinkedGroup = { mintAddress: mint, holders: [] };
    await readTopHolders([group], helius, { maxReads: 4, wideMints: new Set([mint]) });
    expect(group.holders).toHaveLength(26);
    const lookups = await resolveLinkedWallets([group], helius, { maxNewLookups: 100 });

    // Stored already: x0 by F1 (joins the cluster), x1 by an unread funder (left off), x2 a busy
    // row (left off); x3 never read (left off, and not read now).
    await prisma.walletFunder.createMany({
      data: [
        { wallet: w("x0"), status: "found", funder: w("F1"), fundedAt: new Date(), checkedAt: new Date() },
        {
          wallet: w("x1"),
          status: "found",
          funder: w("unread"),
          fundedAt: new Date(),
          checkedAt: new Date(),
        },
        { wallet: w("x2"), status: "busy", checkedAt: new Date() },
      ],
    });
    const calls = helius.getFundersBatch.mock.calls.length;
    const [reading] = await wideMapReadings([group], lookups, new Set([mint]));
    expect(helius.getFundersBatch.mock.calls.length).toBe(calls);
    expect(reading).toMatchObject({ mintAddress: mint, holdersRead: 30, knownExtra: 1 });
    expect(reading!.holders.map((h) => h.wallet)).toContain(w("x0"));
    expect(reading!.holders.find((h) => h.wallet === w("x0"))).toMatchObject({ rank: 27 });
    expect(reading!.holders.some((h) => [w("x1"), w("x2"), w("x3")].includes(h.wallet))).toBe(false);
    expect(reading!.clusters[0]!.wallets.map((x) => x.wallet)).toEqual([w("t0"), w("t1"), w("x0")]);
    // The top-25 reading is as it was.
    expect(linkedReadingOf(group, lookups)!.clusters[0]!.wallets).toHaveLength(2);

    // Not for a coin no model called.
    expect(await wideMapReadings([group], lookups, new Set())).toEqual([]);

    // Called a minute before the read: kept as the map at the alert, once.
    const calledAt = new Map([[mint, reading!.readAt.getTime() - 60_000]]);
    expect(await storeWideMapReadings([reading!], calledAt)).toBe(1);
    expect(await storeWideMapReadings([reading!], calledAt)).toBe(0);
    const row = await prisma.bubbleMapHolders.findUnique({ where: { mintAddress: mint } });
    expect(row).toMatchObject({ holdersRead: 30, knownExtra: 1 });
    const kept = await prisma.bubbleMapAtAlert.findUnique({ where: { mintAddress: mint } });
    expect(kept).toMatchObject({ holdersRead: 30, knownExtra: 1, readAt: reading!.readAt });
    expect(kept!.alertAt.getTime()).toBe(calledAt.get(mint));

    // A later reading moves the live map, never the one kept at the alert.
    const later = { ...reading!, readAt: new Date(reading!.readAt.getTime() + 5 * 60_000), knownExtra: 0 };
    resetLinkedWallets();
    expect(await storeWideMapReadings([later], calledAt)).toBe(1);
    expect(await prisma.bubbleMapHolders.findUnique({ where: { mintAddress: mint } })).toMatchObject({
      knownExtra: 0,
    });
    expect(await prisma.bubbleMapAtAlert.findUnique({ where: { mintAddress: mint } })).toMatchObject({
      knownExtra: 1,
      readAt: reading!.readAt,
    });
    await prisma.bubbleMapHolders.delete({ where: { mintAddress: mint } });
    await prisma.bubbleMapAtAlert.delete({ where: { mintAddress: mint } });

    // A coin first read long after its call (called before maps were kept): nothing kept.
    const old = { ...reading!, mintAddress: w("wide-old") };
    resetLinkedWallets();
    await storeWideMapReadings([old], new Map([[old.mintAddress, old.readAt.getTime() - 3_600_000]]));
    expect(await prisma.bubbleMapAtAlert.findUnique({ where: { mintAddress: old.mintAddress } })).toBeNull();
    await prisma.bubbleMapHolders.delete({ where: { mintAddress: old.mintAddress } });
  });
});

describe("readTopHolders", () => {
  beforeEach(() => resetLinkedWallets());

  it("puts the chain's top 25 on each group, contenders first, within the budget, and keeps it a while", async () => {
    const top = Array.from({ length: 26 }, (_, i) => ({ owner: `h${i}`, pct: 30 - i }));
    const helius = {
      getTopHoldersBatch: vi.fn(async (mints: string[], n: number) => {
        expect(n).toBe(26);
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: top }]));
      }),
    };
    const groups: LinkedGroup[] = ["mA", "mB"].map((m) => ({
      mintAddress: m,
      holders: [{ owner: "rugcheck", pct: 1 }],
    }));
    await readTopHolders(groups, helius, { maxReads: 1, nowMs: 0 });
    expect(helius.getTopHoldersBatch).toHaveBeenCalledWith(["mA"], 26);
    expect(groups[0]!.holders).toHaveLength(26);
    expect(groups[1]!.holders).toEqual([{ owner: "rugcheck", pct: 1 }]);
    expect(cachedTopHolders("mA", 1)).toEqual(top);
    expect(cachedTopHolders("mB", 1)).toBeUndefined();

    // Fresh lists aren't read again; the next mint is.
    await readTopHolders(groups, helius, { maxReads: 1, nowMs: 1 });
    expect(helius.getTopHoldersBatch).toHaveBeenLastCalledWith(["mB"], 26);
    await readTopHolders(groups, helius, { maxReads: 2, nowMs: TOP_HOLDERS_REFRESH_MS });
    expect(helius.getTopHoldersBatch).toHaveBeenLastCalledWith(["mA"], 26);
  });

  it("reads an alerted coin's top 50 in the same call, keeping the readings on the top 25", async () => {
    const wide = Array.from({ length: 101 }, (_, i) => ({ owner: `w${i}`, pct: 101 - i }));
    const helius = {
      getTopHoldersBatch: vi.fn(async (mints: string[]) => {
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: wide }]));
      }),
    };
    const groups: LinkedGroup[] = [{ mintAddress: "mW", holders: [] }];
    await readTopHolders(groups, helius, { maxReads: 4, nowMs: 0 });
    expect(helius.getTopHoldersBatch).toHaveBeenLastCalledWith(["mW"], 26);
    // Called a moment later: read again at once for its top 50 (the read at alert time).
    await readTopHolders(groups, helius, { maxReads: 4, nowMs: 1, wideMints: new Set(["mW"]) });
    expect(helius.getTopHoldersBatch).toHaveBeenLastCalledWith(["mW"], 51);
    expect(groups[0]!.holders).toHaveLength(26);
    expect(cachedTopHolders("mW", 2)).toHaveLength(26);
    // Then on the usual cadence only.
    await readTopHolders(groups, helius, { maxReads: 4, nowMs: 2, wideMints: new Set(["mW"]) });
    expect(helius.getTopHoldersBatch).toHaveBeenCalledTimes(2);
  });

  it("re-reads a coin whose bubble map is open at its own pace and budget (user ask 2026-10-19)", async () => {
    const top = Array.from({ length: 26 }, (_, i) => ({ owner: `h${i}`, pct: 30 - i }));
    const helius = {
      getTopHoldersBatch: vi.fn(async (mints: string[]) => {
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: top }]));
      }),
    };
    const groups: LinkedGroup[] = ["mA", "mV"].map((m) => ({ mintAddress: m, holders: [] }));
    const watched = new Set(["mV"]);
    const opts = { maxReads: 4, watched, maxWatchedReads: 1, watchedRefreshMs: 60_000 };
    expect(await readTopHolders(groups, helius, { ...opts, nowMs: 0 })).toEqual({
      reads: 2,
      watchedReads: 0,
    });
    // Within the minute: nothing is due.
    expect(await readTopHolders(groups, helius, { ...opts, nowMs: 59_999 })).toEqual({
      reads: 0,
      watchedReads: 0,
    });
    // A minute on: the watched coin is read again, on its own budget, the other not.
    expect(await readTopHolders(groups, helius, { ...opts, maxReads: 0, nowMs: 60_000 })).toEqual({
      reads: 0,
      watchedReads: 1,
    });
    expect(helius.getTopHoldersBatch).toHaveBeenLastCalledWith(["mV"], 26);
    // With no watched budget left it waits for the usual cadence.
    expect(await readTopHolders(groups, helius, { ...opts, maxWatchedReads: 0, nowMs: 130_000 })).toEqual({
      reads: 0,
      watchedReads: 0,
    });
    expect(helius.getTopHoldersBatch).toHaveBeenCalledTimes(2);
  });

  it("keeps a watched coin's list while the trade stream says it hasn't traded since", async () => {
    const top = [{ owner: "h0", pct: 10 }];
    const helius = {
      getTopHoldersBatch: vi.fn(async (mints: string[]) => {
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: top }]));
      }),
    };
    const groups: LinkedGroup[] = [{ mintAddress: "mQ", holders: [] }];
    const lastTrade = { at: 0 };
    const opts = {
      maxReads: 0,
      watched: new Set(["mQ"]),
      maxWatchedReads: 1,
      watchedRefreshMs: 60_000,
      quietSince: (_mint: string, since: number) => lastTrade.at <= since,
    };
    await readTopHolders(groups, helius, { ...opts, maxReads: 1, nowMs: 0 });
    expect(await readTopHolders(groups, helius, { ...opts, nowMs: 60_000 })).toEqual({
      reads: 0,
      watchedReads: 0,
    });
    lastTrade.at = 30_000;
    expect(await readTopHolders(groups, helius, { ...opts, nowMs: 60_000 })).toEqual({
      reads: 0,
      watchedReads: 1,
    });
  });

  it("re-reads an old coin no decision is near less often, its list standing meanwhile (user decision 2026-10-20)", async () => {
    const top = [{ owner: "h0", pct: 10 }];
    const helius = {
      getTopHoldersBatch: vi.fn(async (mints: string[]) => {
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: top }]));
      }),
    };
    const groups: LinkedGroup[] = [
      { mintAddress: "mOld", holders: [] },
      { mintAddress: "mNew", holders: [] },
    ];
    const opts = { maxReads: 4, oldMints: new Set(["mOld"]) };
    await readTopHolders(groups, helius, { ...opts, nowMs: 0 });
    expect(await readTopHolders(groups, helius, { ...opts, nowMs: TOP_HOLDERS_REFRESH_MS })).toEqual({
      reads: 1,
      watchedReads: 0,
    });
    expect(helius.getTopHoldersBatch).toHaveBeenLastCalledWith(["mNew"], 26);
    // Still the coin's current holders for the screen while it waits for its slower re-read.
    expect(currentTopHolders("mOld", TOP_HOLDERS_OLD_REFRESH_MS)).toEqual(top);
    await readTopHolders(groups, helius, { ...opts, nowMs: TOP_HOLDERS_OLD_REFRESH_MS });
    expect(helius.getTopHoldersBatch).toHaveBeenLastCalledWith(["mOld", "mNew"], 26);
  });

  it("keeps any coin's list, as of now, while the trade stream says it hasn't traded since (user decision 2026-10-20)", async () => {
    const top = [{ owner: "h0", pct: 10 }];
    const helius = {
      getTopHoldersBatch: vi.fn(async (mints: string[]) => {
        return new Map(mints.map((m) => [m, { status: "found" as const, holders: top }]));
      }),
    };
    const groups: LinkedGroup[] = [{ mintAddress: "mQ", holders: [] }];
    const lastTrade = { at: 0 };
    const opts = { maxReads: 1, quietSince: (_mint: string, since: number) => lastTrade.at <= since };
    await readTopHolders(groups, helius, { ...opts, nowMs: 0 });
    const later = 5 * TOP_HOLDERS_REFRESH_MS;
    expect(await readTopHolders(groups, helius, { ...opts, nowMs: TOP_HOLDERS_REFRESH_MS })).toEqual({
      reads: 0,
      watchedReads: 0,
    });
    await readTopHolders(groups, helius, { ...opts, nowMs: later });
    expect(helius.getTopHoldersBatch).toHaveBeenCalledTimes(1);
    // Kept as of the last quiet check, so it hasn't lapsed though first read long ago.
    expect(cachedTopHolders("mQ", later + 1)).toEqual(top);
    lastTrade.at = later + 1;
    await readTopHolders(groups, helius, { ...opts, nowMs: later + TOP_HOLDERS_REFRESH_MS });
    expect(helius.getTopHoldersBatch).toHaveBeenCalledTimes(2);
  });

  it("leaves a group on RugCheck's list when the read fails", async () => {
    const helius = {
      getTopHoldersBatch: vi.fn(
        async (mints: string[]) => new Map(mints.map((m) => [m, { status: "failed" as const }])),
      ),
    };
    const groups: LinkedGroup[] = [{ mintAddress: "mC", holders: [{ owner: "rugcheck", pct: 1 }] }];
    await readTopHolders(groups, helius, { maxReads: 4 });
    expect(groups[0]!.holders).toEqual([{ owner: "rugcheck", pct: 1 }]);
    expect(cachedTopHolders("mC")).toBeUndefined();
  });
});
