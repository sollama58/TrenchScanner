// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type FunderActivityResult, type FunderResult } from "@trenchscanner/core";
import {
  cexReadingOf,
  linkedHoldersOf,
  linkedReadingOf,
  resetLinkedWallets,
  resolveLinkedWallets,
  takeLinkedWalletStats,
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
      linkedWalletPct: 21,
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
    expect(linkedReadingOf(group, cached)).toMatchObject({ linkedWalletPct: 21 });
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
});
