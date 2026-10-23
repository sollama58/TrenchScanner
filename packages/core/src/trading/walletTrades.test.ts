import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import type { MintInfo, RawTransaction } from "./rpc.js";
import { associatedTokenAddress, PROGRAM } from "./txGuard.js";
import { CHANGEABLE_MINT_INFO_MS, MintInfoReuse, walletTokenTrades } from "./walletTrades.js";

const key = (n: number) => bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 7)));
const WALLET = key(1);
const MINT = key(2);

/** A buy of 10 tokens for 1 SOL, paid by WALLET. */
const buy = {
  blockTime: 1_700_000_000,
  transaction: { message: { accountKeys: [WALLET, key(3)] } },
  meta: {
    err: null,
    preBalances: [2e9, 1e9],
    postBalances: [1e9, 2e9],
    preTokenBalances: [],
    postTokenBalances: [{ owner: WALLET, mint: MINT, uiTokenAmount: { amount: "10" } }],
  },
} as unknown as RawTransaction;

function chain(sigsOf: (address: string) => { signature: string; blockTime: number; failed: boolean }[]) {
  const asked: string[] = [];
  return {
    asked,
    rpc: {
      getSignaturesForAddress: async (address: string) => {
        asked.push(address);
        return sigsOf(address);
      },
      getTransactionJson: async () => buy,
    },
  };
}

describe("walletTokenTrades with the mint's program", () => {
  it("reads only that program's token account, for the same trades", async () => {
    const classic = associatedTokenAddress(WALLET, MINT, PROGRAM.token);
    const sigsOf = (address: string) =>
      address === classic ? [{ signature: "sig", blockTime: 1_700_000_000, failed: false }] : [];
    const both = chain(sigsOf);
    const one = chain(sigsOf);
    const before = await walletTokenTrades(both.rpc, WALLET, MINT, new Map());
    const after = await walletTokenTrades(one.rpc, WALLET, MINT, new Map(), undefined, {
      program: PROGRAM.token,
    });
    expect(after).toEqual(before);
    expect(after!.trades.map((t) => t.side)).toEqual(["buy"]);
    expect(both.asked).toHaveLength(2);
    expect(one.asked).toEqual([classic]);
  });
});

describe("MintInfoReuse", () => {
  const mintInfo = (over: Partial<MintInfo>): MintInfo => ({
    program: PROGRAM.token2022,
    mintAuthority: null,
    freezeAuthority: null,
    extensions: ["metadataPointer", "tokenMetadata"],
    decimals: 6,
    transferFeeBps: 0,
    ...over,
  });
  const counting = (info: MintInfo | null | "throw") => {
    let reads = 0;
    const reuse = new MintInfoReuse(async () => {
      reads += 1;
      if (info === "throw") throw new Error("rpc down");
      return info;
    });
    return { reuse, reads: () => reads };
  };

  it("reads a mint whose figures can't change once, and names its program for good", async () => {
    const { reuse, reads } = counting(mintInfo({ mintAuthority: "A" }));
    expect(reuse.fixedProgram(MINT)).toBeUndefined();
    const first = await reuse.get(MINT, 0);
    const later = await reuse.get(MINT, 24 * 3_600_000);
    expect(first).toEqual({ program: PROGRAM.token2022, decimals: 6, transferFeeBps: 0 });
    expect(later).toEqual(first);
    expect(reads()).toBe(1);
    expect(reuse.fixedProgram(MINT)).toBe(PROGRAM.token2022);
  });

  it("keeps a classic mint for good", async () => {
    const { reuse, reads } = counting(mintInfo({ program: PROGRAM.token, extensions: [] }));
    await reuse.get(MINT, 0);
    await reuse.get(MINT, 10 * CHANGEABLE_MINT_INFO_MS);
    expect(reads()).toBe(1);
    expect(reuse.fixedProgram(MINT)).toBe(PROGRAM.token);
  });

  it("reads a mint with a transfer fee again after CHANGEABLE_MINT_INFO_MS, and reads both accounts for it", async () => {
    const { reuse, reads } = counting(mintInfo({ extensions: ["transferFeeConfig"], transferFeeBps: 100 }));
    expect(await reuse.get(MINT, 0)).toMatchObject({ transferFeeBps: 100 });
    await reuse.get(MINT, CHANGEABLE_MINT_INFO_MS - 1);
    expect(reads()).toBe(1);
    await reuse.get(MINT, CHANGEABLE_MINT_INFO_MS);
    expect(reads()).toBe(2);
    expect(reuse.fixedProgram(MINT)).toBeUndefined();
  });

  it("doesn't name the program of a mint its authority can close", async () => {
    const { reuse } = counting(mintInfo({ extensions: ["mintCloseAuthority"] }));
    await reuse.get(MINT, 0);
    expect(reuse.fixedProgram(MINT)).toBeUndefined();
  });

  it("answers null for a read that failed, and keeps nothing", async () => {
    for (const info of [null, "throw"] as const) {
      const { reuse, reads } = counting(info);
      expect(await reuse.get(MINT, 0)).toBeNull();
      expect(await reuse.get(MINT, 1)).toBeNull();
      expect(reads()).toBe(2);
      expect(reuse.fixedProgram(MINT)).toBeUndefined();
    }
  });
});
