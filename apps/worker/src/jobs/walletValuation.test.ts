import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateToken } from "@trenchscanner/core";
import {
  MAX_NEW_PRICES_PER_CALL,
  quoteFromToken,
  resetValuationCaches,
  seedQuotes,
  valueWalletsFromBalances,
  type ValuationDeps,
} from "./walletValuation.js";

const LAUNCH = "Launch1111111111111111111111111111111111111";
const MEME = "Meme22222222222222222222222222222222222222";
const DUST = "Dust33333333333333333333333333333333333333";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function token(mint: string, priceUsd: number, extra: Partial<CandidateToken> = {}): CandidateToken {
  return {
    mintAddress: mint,
    priceUsd,
    marketCapUsd: 1_000_000,
    liquidityUsd: 100_000,
    volume24hUsd: 5_000,
    ...extra,
  } as CandidateToken;
}

function deps(
  wallets: Record<string, Record<string, bigint> | "failed">,
  priced: CandidateToken[],
  opts: { failedMints?: string[] } = {},
) {
  const getTokensByAddresses = vi.fn(async (mints: string[], _c?: number, o?: { failed?: Set<string> }) => {
    for (const m of opts.failedMints ?? []) if (mints.includes(m)) o?.failed?.add(m);
    return priced.filter((t) => mints.includes(t.mintAddress) && !opts.failedMints?.includes(t.mintAddress));
  });
  const getMintDecimals = vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, 6])));
  const d: ValuationDeps = {
    helius: {
      getTokenBalancesBatch: async (addresses: string[]) =>
        new Map(
          addresses.map((a) => {
            const w = wallets[a];
            return [
              a,
              !w || w === "failed"
                ? { status: "failed" as const }
                : { status: "found" as const, balances: new Map(Object.entries(w)) },
            ];
          }),
        ),
      getMintDecimals,
    },
    dexScreener: { getTokensByAddresses } as unknown as ValuationDeps["dexScreener"],
  };
  return { d, getTokensByAddresses, getMintDecimals };
}

describe("valueWalletsFromBalances", () => {
  beforeEach(() => resetValuationCaches());

  it("calls a wallet holding only the launch (and cash) empty, the launch valued for perMintUsd", async () => {
    // 1,000 launch tokens at $0.01 (6 decimals) and $500 of USDC.
    const { d } = deps({ shell: { [LAUNCH]: 1_000_000_000n, [USDC]: 500_000_000n } }, [token(LAUNCH, 0.01)]);
    const out = await valueWalletsFromBalances(["shell"], [LAUNCH], d, 25);
    expect(out.get("shell")).toEqual({
      status: "found",
      otherHoldingsUsd: 10,
      perMintUsd: { [LAUNCH]: 10 },
      complete: true,
    });
  });

  it("values other holdings off DexScreener and counts dead coins as nothing", async () => {
    const { d } = deps({ trader: { [LAUNCH]: 1_000_000n, [MEME]: 2_000_000_000n, [DUST]: 5n } }, [
      token(LAUNCH, 1),
      token(MEME, 0.05),
    ]);
    const out = await valueWalletsFromBalances(["trader"], [LAUNCH], d, 25);
    // 2,000 MEME at $0.05 = $100, plus $1 of the launch; DUST has no pair.
    expect(out.get("trader")).toMatchObject({
      status: "found",
      otherHoldingsUsd: 101,
      perMintUsd: { [LAUNCH]: 1 },
    });
  });

  it("caps a holding at half the pool, so an airdropped junk token can't make a shell look rich", async () => {
    const { d } = deps({ shell: { [MEME]: 1_000_000_000_000n } }, [
      token(MEME, 1, { liquidityUsd: 40 }), // a "$1M" balance in a $40 pool
    ]);
    const out = await valueWalletsFromBalances(["shell"], [LAUNCH], d, 25);
    expect(out.get("shell")).toMatchObject({ otherHoldingsUsd: 20 });
    // Nobody traded it today: worth nothing.
    expect(quoteFromToken(token(MEME, 1, { volume24hUsd: 0 })).priceUsd).toBe(0);
    // A Pump.fun curve reports no liquidity: capped at a twentieth of the market cap instead.
    expect(quoteFromToken(token(MEME, 1, { liquidityUsd: undefined, marketCapUsd: 20_000 })).capUsd).toBe(
      1_000,
    );
  });

  it("reuses seeded and cached prices instead of asking DexScreener again", async () => {
    seedQuotes([token(LAUNCH, 0.01)]);
    const { d, getTokensByAddresses } = deps({ w: { [LAUNCH]: 1_000_000n, [MEME]: 1_000_000n } }, [
      token(MEME, 30),
    ]);
    await valueWalletsFromBalances(["w"], [LAUNCH], d, 25);
    expect(getTokensByAddresses).toHaveBeenCalledTimes(1);
    expect(getTokensByAddresses.mock.calls[0]![0]).toEqual([MEME]);
    await valueWalletsFromBalances(["w"], [LAUNCH], d, 25);
    expect(getTokensByAddresses).toHaveBeenCalledTimes(1);
  });

  it("defers a wallet whose prices didn't come back, and fails one whose balances didn't", async () => {
    const { d } = deps(
      { w: { [LAUNCH]: 1_000_000n, [MEME]: 1_000_000n }, gone: "failed" },
      [token(LAUNCH, 1)],
      {
        failedMints: [MEME],
      },
    );
    const out = await valueWalletsFromBalances(["w", "gone"], [LAUNCH], d, 25);
    expect(out.get("w")).toEqual({ status: "deferred" });
    expect(out.get("gone")).toEqual({ status: "failed" });
  });

  it("finishes early once holdings outside the launch already clear the bar", async () => {
    seedQuotes([token(LAUNCH, 1), token(MEME, 100)]);
    const { d, getTokensByAddresses } = deps(
      { rich: { [LAUNCH]: 1_000_000n, [MEME]: 1_000_000n, [DUST]: 1n } },
      [],
    );
    const out = await valueWalletsFromBalances(["rich"], [LAUNCH], d, 25);
    // DUST was never priced: the $100 of MEME already settles it.
    expect(getTokensByAddresses).not.toHaveBeenCalled();
    expect(out.get("rich")).toMatchObject({ status: "found", otherHoldingsUsd: 101, complete: false });
  });

  it("treats an all-empty answer to a large request as DexScreener failing, not as worthless wallets", async () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`m${i}`, 1n]));
    const { d } = deps({ w: many }, []);
    const out = await valueWalletsFromBalances(["w"], [LAUNCH], d, 25);
    expect(out.get("w")).toEqual({ status: "deferred" });
  });

  it("defers wallets past the per-call pricing budget rather than half-pricing them", async () => {
    const big = (p: string) =>
      Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`${p}${i}`, 1n])) as Record<string, bigint>;
    const wallets = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`w${i}`, big(`w${i}-`)]));
    const priced = Object.values(wallets).flatMap((w) => Object.keys(w).map((m) => token(m, 0.000001)));
    const { d, getTokensByAddresses } = deps(wallets, priced);
    const out = await valueWalletsFromBalances(Object.keys(wallets), [LAUNCH], d, 25);
    expect(getTokensByAddresses.mock.calls[0]![0].length).toBeLessThanOrEqual(MAX_NEW_PRICES_PER_CALL);
    const statuses = [...out.values()].map((r) => r.status);
    expect(statuses.filter((s) => s === "found")).toHaveLength(2);
    expect(statuses.filter((s) => s === "deferred")).toHaveLength(4);
  });
});
