import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { WRAPPED_SOL_MINT } from "../venueAccounts.js";
import { decodePoolVaults, decodeTokenAmount, pumpSwapPoolOf } from "./pumpSwapPool.js";

const MINT = "7UyCxRnoUhVGWp3XPekkp5Tv5jVde7JXSuj6xLLFpump";
const BASE_VAULT = "4pijh5a9inzYdJ5uSKsR5YSpeoAgYcNspGfofpnhZYav";
const QUOTE_VAULT = "9D3ACVY16og7A2iKuqfUhtLZmNZk14Gwsi8EiPAa2MKf";

function poolData(baseMint: string): Uint8Array {
  const data = new Uint8Array(211);
  data.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  data.set(bs58.decode(baseMint), 43);
  data.set(bs58.decode(WRAPPED_SOL_MINT), 75);
  data.set(bs58.decode(BASE_VAULT), 139);
  data.set(bs58.decode(QUOTE_VAULT), 171);
  return data;
}

describe("PumpSwap pool reads", () => {
  it("derives the canonical SOL pool of a Pump.fun mint", () => {
    // Read off mainnet 2026-10-18.
    expect(pumpSwapPoolOf(MINT)).toBe("eNxnNrL8aSjj1zry9wMzXAQC1VRPaGXKbFTygArcFyv");
    expect(pumpSwapPoolOf("not a mint")).toBeUndefined();
  });

  it("reads a pool's vaults, and nothing from another coin's pool or another account", () => {
    expect(decodePoolVaults(poolData(MINT), MINT)).toEqual({ base: BASE_VAULT, quote: QUOTE_VAULT });
    expect(decodePoolVaults(poolData(BASE_VAULT), MINT)).toBeNull();
    expect(decodePoolVaults(new Uint8Array(211), MINT)).toBeNull();
  });

  it("reads a token account's balance", () => {
    const data = new Uint8Array(72);
    new DataView(data.buffer).setBigUint64(64, 176_508_687_166_049n, true);
    expect(decodeTokenAmount(Buffer.from(data).toString("base64"))).toBe(176_508_687_166_049);
    expect(decodeTokenAmount(new Uint8Array(10))).toBeNull();
  });
});
