import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { buildBurnTransaction, COMPUTE_BUDGET_PROGRAM, SPL_TOKEN_PROGRAM } from "./burnTx";

const MINT = "9zB5wRarXMj86MymwLumSKA1Dx35zPqqKfcZtK1Spump";
const OWNER = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ACCOUNT = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
const BLOCKHASH = bs58.encode(Uint8Array.from({ length: 32 }, () => 9));

/** Reads the legacy wire format back - the inverse of burnTx.ts, written independently. */
function decode(tx: Uint8Array) {
  let o = 0;
  const compact = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const b = tx[o++]!;
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) return n;
    }
  };
  const sigs = compact();
  o += 64 * sigs;
  const header = [tx[o++], tx[o++], tx[o++]];
  const keys = Array.from({ length: compact() }, () => bs58.encode(tx.slice(o, (o += 32))));
  const blockhash = bs58.encode(tx.slice(o, (o += 32)));
  const ixs = Array.from({ length: compact() }, () => {
    const program = keys[tx[o++]!];
    const accounts = Array.from({ length: compact() }, () => keys[tx[o++]!]);
    const length = compact();
    const data = tx.slice(o, (o += length));
    return { program, accounts, data };
  });
  return { sigs, header, keys, blockhash, ixs, rest: tx.length - o };
}

const u64 = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);

describe("buildBurnTransaction", () => {
  it("burns exactly the amount, from the owner's account, with the owner as authority", () => {
    const raw = 55_200n * 10n ** 6n * 3n;
    const tx = decode(
      buildBurnTransaction({
        owner: OWNER,
        tokenAccount: ACCOUNT,
        mint: MINT,
        decimals: 6,
        rawAmount: raw,
        blockhash: BLOCKHASH,
      }),
    );
    expect(tx.sigs).toBe(1);
    expect(tx.rest).toBe(0);
    // One signer (the owner, also the fee payer); the two programs read-only.
    expect(tx.header).toEqual([1, 0, 2]);
    expect(tx.keys[0]).toBe(OWNER);
    expect(tx.blockhash).toBe(BLOCKHASH);

    const burn = tx.ixs[2]!;
    expect(burn.program).toBe(SPL_TOKEN_PROGRAM);
    expect(burn.accounts).toEqual([ACCOUNT, MINT, OWNER]);
    expect(burn.data[0]).toBe(15);
    expect(u64(burn.data.slice(1, 9))).toBe(raw);
    expect(burn.data[9]).toBe(6);

    expect(tx.ixs[0]!.program).toBe(COMPUTE_BUDGET_PROGRAM);
    expect(tx.ixs[1]!.program).toBe(COMPUTE_BUDGET_PROGRAM);
  });

  it("refuses inputs that can't make a valid burn", () => {
    const base = { owner: OWNER, tokenAccount: ACCOUNT, mint: MINT, decimals: 6, blockhash: BLOCKHASH };
    expect(() => buildBurnTransaction({ ...base, rawAmount: 0n })).toThrow();
    expect(() => buildBurnTransaction({ ...base, rawAmount: 1n << 64n })).toThrow();
    expect(() => buildBurnTransaction({ ...base, tokenAccount: OWNER, rawAmount: 1n })).toThrow();
    expect(() => buildBurnTransaction({ ...base, owner: "not-an-address", rawAmount: 1n })).toThrow();
  });
});
