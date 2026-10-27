// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, prisma, type HeliusClient } from "@trenchscanner/core";
import { resetHoldingsFailureBackoff, resolveWalletHoldings } from "./walletHoldings.js";
import { resetValuationCaches } from "./walletValuation.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `holdingscache-test-${Date.now()}`;
const wallet = (n: string) => `${TAG}-${n}`;
const OLD_LAUNCH = "OldLaunch1111111111111111111111111111111111";
const NEW_LAUNCH = "NewLaunch2222222222222222222222222222222222";

function fakeHelius() {
  const calls: string[][] = [];
  const helius = {
    holdingsLookupAvailable: true,
    async getOtherHoldingsUsdBatch(addresses: string[], mints: Iterable<string>) {
      calls.push([...addresses]);
      const perMintUsd = Object.fromEntries([...mints].map((m) => [m, 0]));
      return new Map(
        addresses.map((a) => [
          a,
          { status: "found" as const, otherHoldingsUsd: 7, perMintUsd, complete: true },
        ]),
      );
    },
  } as unknown as HeliusClient;
  return { helius, calls };
}

describe.skipIf(!dbAvailable)("resolveWalletHoldings cache coverage", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);
  beforeEach(async () => {
    resetHoldingsFailureBackoff();
    await prisma.walletHoldingsCache.deleteMany({ where: { address: { startsWith: TAG } } });
  });
  afterAll(async () => {
    if (!dbAvailable) return;
    await prisma.walletHoldingsCache.deleteMany({ where: { address: { startsWith: TAG } } });
  });

  it("answers a new launch from a complete reading, and re-fetches only a partial one", async () => {
    const [full, partial] = [wallet("full"), wallet("partial")];
    await prisma.walletHoldingsCache.createMany({
      data: [
        { address: full, otherHoldingsUsd: 500, perMintUsd: { [OLD_LAUNCH]: 100 }, breakdownComplete: true },
        {
          address: partial,
          otherHoldingsUsd: 500,
          perMintUsd: { [OLD_LAUNCH]: 100 },
          breakdownComplete: false,
        },
      ],
    });
    const { helius, calls } = fakeHelius();

    const result = await resolveWalletHoldings(
      [{ mintAddress: NEW_LAUNCH, addresses: [full, partial] }],
      helius,
      env,
    );

    // The complete reading held none of the new launch, so it is a known zero - no lookup.
    expect(result.get(full)).toEqual({
      otherHoldingsUsd: 500,
      perMintUsd: { [OLD_LAUNCH]: 100, [NEW_LAUNCH]: 0 },
    });
    expect(calls).toEqual([[partial]]);
    const rewritten = await prisma.walletHoldingsCache.findUnique({ where: { address: partial } });
    expect(rewritten?.breakdownComplete).toBe(true);
  });

  it("prices through balances and DexScreener when given them, caching found wallets and retrying deferred ones", async () => {
    resetValuationCaches();
    const [shell, busy] = [wallet("shell"), wallet("busy")];
    let dasCalls = 0;
    let balanceCalls = 0;
    const helius = {
      holdingsLookupAvailable: false, // a DAS stand-down doesn't stop this route
      async getOtherHoldingsUsdBatch() {
        dasCalls += 1;
        return new Map();
      },
      async getTokenBalancesBatch(addresses: string[]) {
        balanceCalls += 1;
        return new Map(
          addresses.map((a) => [
            a,
            {
              status: "found" as const,
              balances: new Map(
                a === busy
                  ? [
                      [NEW_LAUNCH, 1_000_000n],
                      ["Unanswered", 1n],
                    ]
                  : [[NEW_LAUNCH, 1_000_000n]],
              ),
            },
          ]),
        );
      },
      async getMintDecimals(mints: string[]) {
        return new Map(mints.map((m) => [m, 6]));
      },
      async getLamportsBatch(addresses: string[]) {
        return new Map(addresses.map((a) => [a, 1_000_000_000n]));
      },
    } as unknown as HeliusClient;
    const dexScreener = {
      async getTokensByAddresses(mints: string[], _c: number, o: { failed?: Set<string> }) {
        if (mints.includes("Unanswered")) o.failed?.add("Unanswered");
        return mints.includes(NEW_LAUNCH)
          ? [
              {
                mintAddress: NEW_LAUNCH,
                priceUsd: 2,
                liquidityUsd: 10_000,
                marketCapUsd: 50_000,
                volume24hUsd: 900,
              },
            ]
          : [];
      },
    } as never;
    const groups = [{ mintAddress: NEW_LAUNCH, addresses: [shell, busy] }];

    const result = await resolveWalletHoldings(
      groups,
      helius,
      { ...env, WALLET_HOLDINGS_SOURCE: "balances" },
      {
        valuation: { dexScreener },
      },
    );
    expect(dasCalls).toBe(0);
    expect(result.get(shell)).toEqual({ otherHoldingsUsd: 2, perMintUsd: { [NEW_LAUNCH]: 2 } });
    expect(result.has(busy)).toBe(false);
    expect(await prisma.walletHoldingsCache.findUnique({ where: { address: busy } })).toBeNull();

    // No failure back-off for a deferred wallet: the next call tries it again (the shell is
    // cached), on the balances it already read rather than reading them again.
    await resolveWalletHoldings(
      groups,
      helius,
      { ...env, WALLET_HOLDINGS_SOURCE: "balances" },
      {
        valuation: { dexScreener },
      },
    );
    expect(balanceCalls).toBe(1);
    expect(result.has(busy)).toBe(false);
  });

  it("re-prices a due wallet whose SOL barely moved, and reads one whose SOL moved past the buffer", async () => {
    resetValuationCaches();
    const [quiet, dusted, traded, old] = [wallet("quiet"), wallet("dusted"), wallet("traded"), wallet("old")];
    const sol = new Map<string, bigint>([
      [quiet, 2_000_000_000n],
      [dusted, 2_000_000_000n],
      [traded, 2_000_000_000n],
      [old, 2_000_000_000n],
    ]);
    const read: string[] = [];
    const lamportReads: string[][] = [];
    const helius = {
      holdingsLookupAvailable: true,
      async getTokenBalancesBatch(addresses: string[]) {
        read.push(...addresses);
        return new Map(
          addresses.map((a) => [
            a,
            { status: "found" as const, balances: new Map([[NEW_LAUNCH, 1_000_000n]]) },
          ]),
        );
      },
      async getMintDecimals(mints: string[]) {
        return new Map(mints.map((m) => [m, 6]));
      },
      async getLamportsBatch(addresses: string[]) {
        lamportReads.push([...addresses]);
        return new Map(addresses.map((a) => [a, sol.get(a)!]));
      },
    } as unknown as HeliusClient;
    let price = 2;
    const dexScreener = {
      async getTokensByAddresses(mints: string[]) {
        return mints.includes(NEW_LAUNCH)
          ? [
              {
                mintAddress: NEW_LAUNCH,
                priceUsd: price,
                liquidityUsd: 10_000,
                marketCapUsd: 50_000,
                volume24hUsd: 900,
              },
            ]
          : [];
      },
    } as never;
    const balancesEnv = { ...env, WALLET_HOLDINGS_SOURCE: "balances" as const };
    const groups = [{ mintAddress: NEW_LAUNCH, addresses: [quiet, dusted, traded, old] }];

    // The first read is in full, and keeps each wallet's balances and SOL.
    await resolveWalletHoldings(groups, helius, balancesEnv, { valuation: { dexScreener } });
    expect(read.sort()).toEqual([dusted, old, quiet, traded].sort());
    const kept = await prisma.walletHoldingsCache.findUnique({ where: { address: quiet } });
    expect(kept?.balances).toEqual({ [NEW_LAUNCH]: "1000000" });
    expect(kept?.lamports).toBe(2_000_000_000n);

    // Eleven minutes on: past the TTL. One read an hour and a half ago is due a full read whatever.
    const due = new Date(Date.now() - 11 * 60_000);
    await prisma.walletHoldingsCache.updateMany({
      where: { address: { in: [quiet, dusted, traded] } },
      data: { checkedAt: due, balancesReadAt: due },
    });
    const longAgo = new Date(Date.now() - 90 * 60_000);
    await prisma.walletHoldingsCache.update({
      where: { address: old },
      data: { checkedAt: due, balancesReadAt: longAgo },
    });
    sol.set(dusted, 2_000_000_000n + 5_000n); // dust: under the 0.01 SOL buffer
    sol.set(traded, 1_700_000_000n); // spent 0.3 SOL
    read.length = 0;
    lamportReads.length = 0;
    resetValuationCaches();
    price = 3;

    // A budget of two: the two re-priced wallets cost none of it, so the group still fits.
    const result = await resolveWalletHoldings(groups, helius, balancesEnv, {
      valuation: { dexScreener },
      maxNewLookups: 2,
    });
    expect(read.sort()).toEqual([old, traded].sort());
    // Re-priced at today's price from the stored balances.
    expect(result.get(quiet)).toEqual({ otherHoldingsUsd: 3, perMintUsd: { [NEW_LAUNCH]: 3 } });
    expect(result.get(dusted)?.otherHoldingsUsd).toBe(3);
    // The SOL check covered the three with a recent read; the old one's SOL was read with its read.
    expect(lamportReads[0]!.sort()).toEqual([dusted, quiet, traded].sort());
    expect(lamportReads[1]).toEqual([old]);
    // A re-pricing leaves the read it came from, so SOL is still compared against that.
    const after = await prisma.walletHoldingsCache.findUnique({ where: { address: dusted } });
    expect(after?.lamports).toBe(2_000_000_000n);
    expect(after?.balancesReadAt?.getTime()).toBe(due.getTime());
    expect(after!.checkedAt.getTime()).toBeGreaterThan(due.getTime());
    const reread = await prisma.walletHoldingsCache.findUnique({ where: { address: traded } });
    expect(reread?.lamports).toBe(1_700_000_000n);
  });
});
