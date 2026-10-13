import { beforeEach, describe, expect, it, vi } from "vitest";
import { liveFlagsOf, readLiveTape, resetLiveTape, takeLiveTapeStats } from "./liveTape.js";

const SOL = 1_000_000_000;
const MINT = "Mint1111111111111111111111111111111111111111";
// Real on-curve addresses: program accounts are left out of the tape.
const RISKY = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function buyTx(wallet: string, sol: number, atSec: number) {
  return {
    blockTime: atSec,
    meta: {
      err: null,
      preBalances: [5 * SOL],
      postBalances: [5 * SOL - sol * SOL],
      preTokenBalances: [],
      postTokenBalances: [
        { accountIndex: 1, mint: MINT, owner: wallet, uiTokenAmount: { amount: "1000000000", decimals: 6 } },
      ],
    },
    transaction: { signatures: [`sig-${atSec}`], message: { accountKeys: [wallet, "ata"] } },
  };
}

function fakeHelius() {
  return {
    gtfaUsable: true,
    getMintTransactionsPage: vi.fn(async () => ({
      status: "ok" as const,
      txs: [buyTx(RISKY, 2, 1_700_000_100)],
      paginationToken: null,
    })),
  };
}

describe("live tape", () => {
  beforeEach(() => resetLiveTape());
  const lookup = (w: string) => (w === RISKY ? { score: 90, dumps: 0 } : undefined);

  it("reads the newest page of the first coins due, and reads flagged buys from it", async () => {
    const helius = fakeHelius();
    await readLiveTape([MINT, "other", "third"], helius, { maxPages: 2, refreshMs: 60_000, nowMs: 1000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(2);
    expect(helius.getMintTransactionsPage).toHaveBeenCalledWith(MINT, { newest: true });
    expect(liveFlagsOf(MINT, lookup, 2000)).toMatchObject({ flaggedBuyers: 1, flaggedBuySol: 2 });
    expect(takeLiveTapeStats()).toMatchObject({ pages: 2, credits: 20 });

    // Not due again yet: no call.
    await readLiveTape([MINT], helius, { maxPages: 2, refreshMs: 60_000, nowMs: 30_000 });
    expect(helius.getMintTransactionsPage).toHaveBeenCalledTimes(2);
  });

  it("is unknown without the scores or once the page is stale", async () => {
    await readLiveTape([MINT], fakeHelius(), { maxPages: 1, refreshMs: 60_000, nowMs: 0 });
    expect(liveFlagsOf(MINT, undefined, 1)).toBeNull();
    expect(liveFlagsOf(MINT, lookup, 16 * 60_000)).toBeNull();
  });
});
