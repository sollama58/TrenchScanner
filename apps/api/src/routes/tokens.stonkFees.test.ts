// Must precede the @trenchscanner/core import - constructing PrismaClient reads DATABASE_URL.
import "../bootstrap-env.js";
import { describe, expect, it, vi } from "vitest";
import { STONKS_FEE_WALLET } from "@trenchscanner/core";
import { readStonkFees } from "./tokens.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
let seq = 0;
/** A fresh mint per test: the answers are cached a minute per mint. */
const mint = () => Array.from({ length: 44 }, (_, i) => B58[(i * 7 + ++seq) % B58.length]).join("");

describe("the token modal's Stonk fee card (readStonkFees)", () => {
  it("reads the fee wallet's share of a Stonks coin", async () => {
    const reader = { getWalletShareOfMint: vi.fn().mockResolvedValue({ pct: 2.5 }) };
    const m = mint();
    expect(await readStonkFees(m, reader, "stonks")).toEqual({
      stonks: true,
      wallet: STONKS_FEE_WALLET,
      label: "Stonk_Fees",
      pct: 2.5,
    });
    expect(reader.getWalletShareOfMint).toHaveBeenCalledWith(STONKS_FEE_WALLET, m);
  });

  it("reads nothing for a coin from another launchpad", async () => {
    const reader = { getWalletShareOfMint: vi.fn() };
    expect(await readStonkFees(mint(), reader, "pumpfun")).toMatchObject({ stonks: false, pct: null });
    expect(reader.getWalletShareOfMint).not.toHaveBeenCalled();
  });

  it("decides a coin without a recorded launchpad by its mint's fee authority", async () => {
    const stonks = {
      getWalletShareOfMint: vi.fn().mockResolvedValue({ pct: 1, withheldFeeAuthority: STONKS_FEE_WALLET }),
    };
    expect(await readStonkFees(mint(), stonks, null)).toMatchObject({ stonks: true, pct: 1 });
    const other = { getWalletShareOfMint: vi.fn().mockResolvedValue({ pct: 0 }) };
    expect(await readStonkFees(mint(), other, null)).toMatchObject({ stonks: false, pct: null });
  });

  it("shows a Stonks coin without a share when the chain read has no answer, and tries again next time", async () => {
    const reader = {
      getWalletShareOfMint: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ pct: 3 }),
    };
    const m = mint();
    expect(await readStonkFees(m, reader, "stonks")).toMatchObject({ stonks: true, pct: null });
    expect(await readStonkFees(m, reader, "stonks")).toMatchObject({ stonks: true, pct: 3 });
  });
});
