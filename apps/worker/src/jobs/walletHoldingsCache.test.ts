// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadEnv, prisma, type HeliusClient } from "@trenchscanner/core";
import { resetHoldingsFailureBackoff, resolveWalletHoldings } from "./walletHoldings.js";

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
});
