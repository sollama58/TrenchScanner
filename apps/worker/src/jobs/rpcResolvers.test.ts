// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma, loadEnv, type HeliusClient } from "@trenchscanner/core";
import { resolveEarliestActivity, resetWalletFailureBackoff } from "./walletFreshness.js";
import { resolveMintAuthorities } from "./mintAuthority.js";
import { resolveMayhemMode, resetMayhemFailureBackoff } from "./mayhemMode.js";

const dbAvailable = await prisma.$queryRaw`SELECT 1`.then(() => true).catch(() => false);

const TAG = `rpc-resolver-test-${Date.now()}`;
const HOUR = 3_600_000;

/**
 * A HeliusClient stand-in that records exactly which addresses/mints it was asked about - the
 * whole point of these tests is what we DIDN'T ask for.
 */
function stubHelius(overrides: Partial<Record<string, unknown>> = {}) {
  const asked: { wallets: string[][]; mints: string[][]; authorities: string[][] } = {
    wallets: [],
    mints: [],
    authorities: [],
  };
  const client = {
    earliestActivityMethod: "getTransactionsForAddress" as const,
    getEarliestActivityBatch: async (addresses: string[]) => {
      asked.wallets.push(addresses);
      return new Map(addresses.map((a) => [a, { status: "found" as const, earliestActivityAt: new Date() }]));
    },
    getMayhemModeBatch: async (mints: string[]) => {
      asked.mints.push(mints);
      return new Map(mints.map((m) => [m, { status: "found" as const, isMayhemMode: false }]));
    },
    getMintAuthorityStatusBatch: async (mints: string[]) => {
      asked.authorities.push(mints);
      return new Map(
        mints.map((m) => [
          m,
          { status: "found" as const, mintAuthorityActive: true, freezeAuthorityActive: false },
        ]),
      );
    },
    ...overrides,
  } as unknown as HeliusClient;
  return { client, asked };
}

describe.skipIf(!dbAvailable)("resolveEarliestActivity", () => {
  // Lazy: vitest runs a describe callback during collection even when skipIf will skip every
  // test inside it, so calling loadEnv() here directly threw on a machine with no DATABASE_URL -
  // turning the intended graceful skip into a hard suite failure, which is the opposite of what
  // the guard above and this file's own header promise.
  const env = dbAvailable ? loadEnv() : (undefined as never);

  beforeEach(() => resetWalletFailureBackoff());
  afterEach(async () => {
    if (!dbAvailable) return;
    await prisma.walletActivityCache.deleteMany({ where: { address: { startsWith: TAG } } });
  });

  it("spends the budget on whole groups, never part of one", async () => {
    // Each candidate needs all 3 of its wallets to produce a figure at all, and the budget only
    // covers one group - so the right behaviour is one complete group, not four scattered
    // lookups that leave both candidates unanswerable.
    const groupA = [`${TAG}-a1`, `${TAG}-a2`, `${TAG}-a3`];
    const groupB = [`${TAG}-b1`, `${TAG}-b2`, `${TAG}-b3`];
    const { client, asked } = stubHelius();

    const result = await resolveEarliestActivity([groupA, groupB], client, { maxNewLookups: 4 });

    expect(asked.wallets).toEqual([groupA]);
    for (const address of groupA) expect(result.has(address)).toBe(true);
    for (const address of groupB) expect(result.has(address)).toBe(false);
  });

  it("caches an out-of-window upper bound as a permanent answer", async () => {
    const address = `${TAG}-bounded`;
    const boundAt = new Date(Date.now() - 90 * HOUR); // already far outside the 24h window
    const { client } = stubHelius({
      getEarliestActivityBatch: async () => new Map([[address, { status: "older-than" as const, boundAt }]]),
    });

    const result = await resolveEarliestActivity([[address]], client);

    // The exact first transaction is unknown, but "not funded recently" is settled - and stays
    // settled, because the window only ever slides further away from the bound.
    expect(result.get(address)).toEqual(boundAt);
    const cached = await prisma.walletActivityCache.findUniqueOrThrow({ where: { address } });
    expect(cached.earliestActivityAt).toEqual(boundAt);
  });

  it("treats a bound INSIDE the window as settling nothing", async () => {
    const address = `${TAG}-busy`;
    const { client } = stubHelius({
      getEarliestActivityBatch: async () =>
        new Map([[address, { status: "older-than" as const, boundAt: new Date(Date.now() - HOUR) }]]),
    });

    // A page full of transactions all from the last hour says the wallet is busy, not that it is
    // new - so it records as unknown-but-answered (null), which counts as not fresh.
    const result = await resolveEarliestActivity([[address]], client);
    expect(result.get(address)).toBeNull();
  });

  it("backs a failed wallet off instead of retrying it every cycle", async () => {
    const address = `${TAG}-flaky`;
    const { client, asked } = stubHelius({
      getEarliestActivityBatch: async (addresses: string[]) => {
        asked.wallets.push(addresses);
        return new Map(addresses.map((a) => [a, { status: "failed" as const }]));
      },
    });

    await resolveEarliestActivity([[address]], client);
    await resolveEarliestActivity([[address]], client);

    // One attempt, not two - and nothing cached, so it will be retried once the backoff lapses.
    expect(asked.wallets).toEqual([[address]]);
    expect(await prisma.walletActivityCache.findUnique({ where: { address } })).toBeNull();
  });

  it("never re-fetches a wallet the cache already answers", async () => {
    const address = `${TAG}-cached`;
    await prisma.walletActivityCache.create({
      data: { address, earliestActivityAt: new Date(Date.now() - 100 * HOUR) },
    });
    const { client, asked } = stubHelius();

    const result = await resolveEarliestActivity([[address]], client, {
      maxNewLookups: env.WALLET_FRESHNESS_MAX_LOOKUPS_PER_CYCLE,
    });

    expect(asked.wallets).toEqual([]);
    expect(result.get(address)).toBeInstanceOf(Date);
  });
});

describe.skipIf(!dbAvailable)("resolveMintAuthorities", () => {
  const env = dbAvailable ? loadEnv() : (undefined as never);

  afterEach(async () => {
    if (!dbAvailable) return;
    await prisma.mintAuthorityCache.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("re-checks a still-active mint only once its short TTL lapses", async () => {
    const mint = `${TAG}-active`;
    const { client, asked } = stubHelius();

    await resolveMintAuthorities([mint], client, env);
    await resolveMintAuthorities([mint], client, env);
    // Two cycles in a row used to mean two lookups - this path ran every single scan cycle.
    expect(asked.authorities).toEqual([[mint]]);

    // Age the row past the TTL and it becomes fetchable again, so a renouncement is still seen.
    await prisma.mintAuthorityCache.update({
      where: { mintAddress: mint },
      data: { checkedAt: new Date(Date.now() - (env.MINT_AUTHORITY_ACTIVE_TTL_MINUTES + 5) * 60_000) },
    });
    await resolveMintAuthorities([mint], client, env);
    expect(asked.authorities).toEqual([[mint], [mint]]);
  });

  it("trusts a fully-revoked mint forever - revocation cannot be undone", async () => {
    const mint = `${TAG}-revoked`;
    const { client, asked } = stubHelius({
      getMintAuthorityStatusBatch: async (mints: string[]) => {
        asked.authorities.push(mints);
        return new Map(
          mints.map((m) => [
            m,
            { status: "found" as const, mintAuthorityActive: false, freezeAuthorityActive: false },
          ]),
        );
      },
    });

    await resolveMintAuthorities([mint], client, env);
    await prisma.mintAuthorityCache.update({
      where: { mintAddress: mint },
      data: { checkedAt: new Date(Date.now() - 400 * 24 * HOUR) },
    });
    const result = await resolveMintAuthorities([mint], client, env);

    expect(asked.authorities).toEqual([[mint]]); // still just the one, however old the row is
    expect(result.get(mint)).toMatchObject({ mintAuthorityActive: false });
  });
});

describe.skipIf(!dbAvailable)("resolveMayhemMode", () => {
  beforeEach(() => resetMayhemFailureBackoff());
  afterEach(async () => {
    if (!dbAvailable) return;
    await prisma.mayhemModeCache.deleteMany({ where: { mintAddress: { startsWith: TAG } } });
  });

  it("backs a failed mint off rather than re-checking it every cycle", async () => {
    const mint = `${TAG}-flaky`;
    const { client, asked } = stubHelius({
      getMayhemModeBatch: async (mints: string[]) => {
        asked.mints.push(mints);
        return new Map(mints.map((m) => [m, { status: "failed" as const }]));
      },
    });

    const first = await resolveMayhemMode([mint], client);
    const second = await resolveMayhemMode([mint], client);

    expect(asked.mints).toEqual([[mint]]);
    // Same verdict both times - unverified, which the rug screen rejects - at half the cost.
    expect(first.get(mint)).toEqual({ status: "failed" });
    expect(second.get(mint)).toEqual({ status: "failed" });
  });
});
