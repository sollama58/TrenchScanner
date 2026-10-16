import { describe, expect, it } from "vitest";
import { readPumpLaunch, pumpCurveAddressOf, type ParsedAccount } from "./pumpLaunch.js";

// STARMAN, a Pump.fun coin whose curve is quoted in FTR (another Pump.fun coin), as read from
// mainnet on 2026-10-16. RugCheck listed only its two Meteora side pools, so it failed the screen
// as "LP not locked".
const STARMAN = "DiveEYHTf3LveSNifUzeCrTbrZUQEm9PSapERXM8pump";
const FTR = "DFMt2FyLpB6ekPNAzVErLXgpSnJ9CRf1VnxBAkTLpump";
const STARMAN_CURVE_HEX =
  "17b7f83760d8ac6000000000000000000000000000000000000000000000000000000000000000000080c6a47e8d0300" +
  "01034f69e003416a74e0ca8c669c6dc716b24e1370ac44cd29da0d2518eec3e64d0000b5f9fbb1877abffc27a4a8dbd8" +
  "2d5c0148b82eaf7e64d397eb00c94b91df4c7f6400000000000000000000000000000000000000000000000000" +
  "01e563d53e99000000eb9e04a2f5000000a55bb73902000000";
const PUMP_FUN = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const curve = (hex: string, owner = PUMP_FUN): ParsedAccount => ({
  owner,
  data: [Buffer.from(hex, "hex").toString("base64"), "base64"],
});
const mintAccount = (
  mintAuthority: string | null = null,
  freezeAuthority: string | null = null,
): ParsedAccount => ({
  owner: TOKEN_2022,
  data: {
    parsed: { type: "mint", info: { mintAuthority, freezeAuthority, decimals: 6 } },
    program: "spl-token-2022",
  },
});

describe("readPumpLaunch", () => {
  it("derives the curve the chain holds STARMAN's at", () => {
    expect(pumpCurveAddressOf(STARMAN)).toBe("4xPMGL6BPpB4JTYPzLHyeKqVXJRaevwDjCF2eVdKXGDp");
    expect(pumpCurveAddressOf("not a mint")).toBeUndefined();
  });

  it("proves a curve quoted in another coin, with the PumpSwap pool it graduated into", () => {
    expect(readPumpLaunch(STARMAN, mintAccount(), curve(STARMAN_CURVE_HEX))).toEqual({
      status: "found",
      launch: { quoteMint: FTR, pool: "B5zwVAbm9ETS9akNmcmNH6kYDsRSNCwWXWpGT85UYVJc" },
    });
  });

  it("reads an all-zero quote mint, or none at all on an older curve, as SOL", () => {
    const solQuoted = STARMAN_CURVE_HEX.slice(0, 83 * 2) + "00".repeat(32) + STARMAN_CURVE_HEX.slice(115 * 2);
    const sol = readPumpLaunch(STARMAN, mintAccount(), curve(solQuoted));
    expect(sol.status === "found" && sol.launch?.quoteMint).toBe(
      "So11111111111111111111111111111111111111112",
    );
    const old = readPumpLaunch(STARMAN, mintAccount(), curve(STARMAN_CURVE_HEX.slice(0, 81 * 2)));
    expect(old.status === "found" && old.launch?.quoteMint).toBe(
      "So11111111111111111111111111111111111111112",
    );
  });

  it("proves nothing without the program's own BondingCurve account at the address", () => {
    expect(readPumpLaunch(STARMAN, mintAccount(), null)).toEqual({ status: "found", launch: null });
    const otherOwner = curve(STARMAN_CURVE_HEX, "11111111111111111111111111111111");
    expect(readPumpLaunch(STARMAN, mintAccount(), otherOwner)).toEqual({ status: "found", launch: null });
    const otherAccount = curve("00" + STARMAN_CURVE_HEX.slice(2));
    expect(readPumpLaunch(STARMAN, mintAccount(), otherAccount)).toEqual({ status: "found", launch: null });
    expect(readPumpLaunch(STARMAN, mintAccount(), curve(STARMAN_CURVE_HEX.slice(0, 40)))).toEqual({
      status: "found",
      launch: null,
    });
  });

  it("proves nothing while either authority is still set, or for an account that isn't a mint", () => {
    expect(readPumpLaunch(STARMAN, mintAccount("someone"), curve(STARMAN_CURVE_HEX))).toEqual({
      status: "found",
      launch: null,
    });
    expect(readPumpLaunch(STARMAN, mintAccount(null, "someone"), curve(STARMAN_CURVE_HEX))).toEqual({
      status: "found",
      launch: null,
    });
    expect(readPumpLaunch(STARMAN, { ...mintAccount(), owner: PUMP_FUN }, curve(STARMAN_CURVE_HEX))).toEqual({
      status: "found",
      launch: null,
    });
  });

  it("is no answer while the RPC doesn't see the mint yet", () => {
    expect(readPumpLaunch(STARMAN, null, null)).toEqual({ status: "failed", mintPending: true });
  });
});
