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

    // No failure back-off for a deferred wallet: the next call asks again (the shell is cached).
    await resolveWalletHoldings(
      groups,
      helius,
      { ...env, WALLET_HOLDINGS_SOURCE: "balances" },
      {
        valuation: { dexScreener },
      },
    );
    expect(balanceCalls).toBe(2);
  });
});
