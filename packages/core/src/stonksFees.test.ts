import { describe, expect, it } from "vitest";
import {
  FEE_HOLDERS,
  isStonksCoin,
  PLATFORM_WALLETS,
  STONKS_FEE_WALLET,
  withheldFeeAuthorityOf,
} from "./stonksFees.js";
import { HOT_FUNDER_DENYLIST, isServiceWallet } from "./wallets/linkedWallets.js";

describe("Stonks' fee wallet", () => {
  it("is labeled Stonk_Fees", () => {
    expect(PLATFORM_WALLETS.get("5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD")).toBe("Stonk_Fees");
  });

  it("tells a Stonks coin by its launchpad, in any source's spelling, or by its mint's fee authority", () => {
    expect(isStonksCoin({ launchpad: "stonks" })).toBe(true);
    expect(isStonksCoin({ launchpad: "stonkfun" })).toBe(true);
    expect(isStonksCoin({ withheldFeeAuthority: STONKS_FEE_WALLET })).toBe(true);
    expect(isStonksCoin({ launchpad: "pumpfun" })).toBe(false);
    expect(isStonksCoin({ launchpad: null, withheldFeeAuthority: "someoneElse" })).toBe(false);
    expect(isStonksCoin({})).toBe(false);
  });

  it("is left out of every coin's holders", () => {
    expect([...FEE_HOLDERS]).toEqual([STONKS_FEE_WALLET]);
  });

  it("reads the fee authority from the RPC's extension list and from RugCheck's extension object", () => {
    // As getAccountInfo jsonParsed and RugCheck's report gave them for BOO (48uUy...), 2026-10-16.
    expect(
      withheldFeeAuthorityOf([
        { extension: "transferFeeConfig", state: { withdrawWithheldAuthority: STONKS_FEE_WALLET } },
        { extension: "metadataPointer", state: {} },
      ]),
    ).toBe(STONKS_FEE_WALLET);
    expect(
      withheldFeeAuthorityOf({ transferFeeConfig: { withdrawWithheldAuthority: STONKS_FEE_WALLET } }),
    ).toBe(STONKS_FEE_WALLET);
    expect(withheldFeeAuthorityOf({ transferFeeConfig: null })).toBeUndefined();
    expect(withheldFeeAuthorityOf(undefined)).toBeUndefined();
    expect(withheldFeeAuthorityOf([{ extension: "transferFeeConfig", state: null }])).toBeUndefined();
  });

  it("never links wallets as a funder, a transfer or a side wallet", () => {
    expect(isServiceWallet(STONKS_FEE_WALLET)).toBe(true);
    expect(HOT_FUNDER_DENYLIST.has(STONKS_FEE_WALLET)).toBe(true);
  });
});
