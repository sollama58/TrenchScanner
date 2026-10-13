// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type FunderActivityResult, type FunderResult } from "@trenchscanner/core";
import {
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

  it("takes the top-10 holders with their shares", () => {
    expect(
      linkedHoldersOf({
        top10HolderAddresses: ["a", "b"],
        topHolderShares: [
          { owner: "a", pct: 3 },
          { owner: "b", pct: 2 },
          { owner: "z", pct: 1 },
        ],
      }),
    ).toEqual([
      { owner: "a", pct: 3 },
      { owner: "b", pct: 2 },
    ]);
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
    expect(on.getFundersBatch).toHaveBeenCalledWith([w("old")]);
    expect(lookups.funderOf.get(w("old"))).toBe(w("H"));
    expect(await prisma.walletFunder.findUnique({ where: { wallet: w("old") } })).toMatchObject({
      status: "found",
      funder: w("H"),
    });
  });
});
