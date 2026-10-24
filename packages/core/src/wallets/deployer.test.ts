import { describe, expect, it } from "vitest";
import { deployerFromTransactions } from "./deployer.js";
import type { ChainTx } from "./tradeTape.js";

const tx = (keys: string[], signers: number, extra: Partial<ChainTx> = {}): ChainTx => ({
  blockTime: 1_700_000_000,
  meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
  transaction: {
    signatures: ["sig"],
    message: { accountKeys: keys, header: { numRequiredSignatures: signers } },
  },
  ...extra,
});
const wallets = new Set(["dev", "mint", "cto"]);
const isWallet = (a: string) => wallets.has(a);

describe("deployerFromTransactions", () => {
  it("names the create transaction's signer, never the mint's own keypair", () => {
    expect(deployerFromTransactions("mint", [tx(["dev", "mint", "curve"], 2)], isWallet)).toEqual({
      deployer: "dev",
      at: new Date(1_700_000_000_000),
      signature: "sig",
    });
    expect(deployerFromTransactions("mint", [tx(["mint", "dev", "curve"], 2)], isWallet)?.deployer).toBe(
      "dev",
    );
  });

  it("skips failed attempts, and reads only the first transaction that went through", () => {
    const failed = tx(["cto", "mint"], 2, { meta: { err: { InstructionError: [0, "x"] } } });
    const later = tx(["cto"], 1);
    expect(
      deployerFromTransactions("mint", [failed, tx(["dev", "mint"], 2), later], isWallet)?.deployer,
    ).toBe("dev");
  });

  it("names no deployer when no signer is a wallet", () => {
    expect(deployerFromTransactions("mint", [tx(["pda", "mint"], 2)], isWallet)).toBeNull();
    expect(deployerFromTransactions("mint", [], isWallet)).toBeNull();
  });
});
