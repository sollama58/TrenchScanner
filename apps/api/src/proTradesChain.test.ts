import { describe, expect, it } from "vitest";
import { associatedTokenAddress, PROGRAM, type RawTransaction } from "@trenchscanner/core";
import { positionsOf, type TradeRow } from "./proTrades.js";
import { chainBalances, chainDisagrees, missingTrades, readMissingTrades } from "./proTradesChain.js";

const W = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const OTHER = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

/** A token account's data with `amount` at offset 64. */
function account(amount: bigint): Uint8Array {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return new Uint8Array(b);
}

const row = (over: Partial<TradeRow> & Pick<TradeRow, "signature" | "side" | "tokens">): TradeRow => ({
  mint: MINT,
  lamports: over.side === "buy" ? -1_000_000_000n : 500_000_000n,
  decimals: 6,
  at: new Date(1_700_000_000_000),
  entry: false,
  ...over,
});

describe("chainBalances", () => {
  it("sums each coin's classic and Token-2022 accounts, a missing one as 0, one read per 50 coins", async () => {
    const asked: string[][] = [];
    const classic = associatedTokenAddress(W, MINT, PROGRAM.token);
    const t22 = associatedTokenAddress(W, OTHER, PROGRAM.token2022);
    const got = await chainBalances(
      {
        getAccountsData: async (addresses) => {
          asked.push(addresses);
          return addresses.map((a) => (a === classic ? account(700n) : a === t22 ? account(5n) : null));
        },
      },
      W,
      [MINT, OTHER],
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(4);
    expect(got).toEqual(
      new Map([
        [MINT, 700n],
        [OTHER, 5n],
      ]),
    );
  });

  it("is null when the read fails", async () => {
    expect(await chainBalances({ getAccountsData: async () => null }, W, [MINT])).toBeNull();
  });
});

describe("chainDisagrees", () => {
  const [open] = positionsOf([row({ signature: "b", side: "buy", tokens: 1_000_000_000n })]);
  const [closed] = positionsOf([
    row({ signature: "b", side: "buy", tokens: 1_000_000_000n }),
    row({ signature: "s", side: "sell", tokens: -1_000_000_000n, at: new Date(1_700_000_060_000) }),
  ]);

  it("agrees within 1% of what was bought", () => {
    expect(chainDisagrees(open!, 1_000_000_000n)).toBe(false);
    expect(chainDisagrees(open!, 995_000_000n)).toBe(false);
    expect(chainDisagrees(closed!, 0n)).toBe(false);
    expect(chainDisagrees(closed!, 5_000_000n)).toBe(false);
  });

  it("disagrees when an open trade's coins are gone, or a sold-out one still holds", () => {
    // The sale the stream and the catch-up both missed: the panel kept it open at its full size.
    expect(chainDisagrees(open!, 0n)).toBe(true);
    expect(chainDisagrees(open!, 400_000_000n)).toBe(true);
    expect(chainDisagrees(closed!, 600_000_000n)).toBe(true);
  });
});

describe("missingTrades", () => {
  it("keeps the trades not recorded, leaves out coins in with nothing paid, and has no SOL for a coin sent out", () => {
    const out = missingTrades(
      [
        { signature: "known", t: 1, side: "buy", lamports: -1n, tokens: 5n },
        { signature: "sold", t: 2, side: "sell", lamports: 9n, tokens: -5n },
        { signature: "gift", t: 3, side: "in", lamports: 0n, tokens: 2n },
        { signature: "sent", t: 4, side: "out", lamports: 0n, tokens: -2n },
      ],
      new Set(["known"]),
      MINT,
      6,
    );
    expect(out.map((t) => [t.signature, t.side, t.lamports, t.tokens, t.decimals, t.at.getTime()])).toEqual([
      ["sold", "sell", 9n, -5n, 6, 2],
      ["sent", "out", null, -2n, 6, 4],
    ]);
  });
});

describe("readMissingTrades", () => {
  it("reads only the transactions that aren't recorded", async () => {
    const reads: string[] = [];
    const sale: RawTransaction = {
      blockTime: 1_700_000_100,
      meta: {
        err: null,
        preBalances: [1_000_000_000],
        postBalances: [1_500_000_000],
        preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: W, uiTokenAmount: { amount: "1000" } }],
        postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: W, uiTokenAmount: { amount: "0" } }],
      },
      transaction: { message: { accountKeys: [W, "pool111111111111111111111111111111111111111"] } },
    } as RawTransaction;
    const got = await readMissingTrades(
      {
        getSignaturesForAddress: async (address) =>
          address === associatedTokenAddress(W, MINT, PROGRAM.token)
            ? [
                { signature: "sale", blockTime: 1_700_000_100, failed: false },
                { signature: "buy", blockTime: 1_700_000_000, failed: false },
              ]
            : [],
        getTransactionJson: async (s) => {
          reads.push(s);
          return s === "sale" ? sale : null;
        },
      },
      W,
      MINT,
      [{ signature: "buy", decimals: 6 }],
      6,
    );
    expect(reads).toEqual(["sale"]);
    expect(got?.map((t) => [t.signature, t.side, t.lamports, t.tokens])).toEqual([
      ["sale", "sell", 500_000_000n, -1000n],
    ]);
  });
});
