import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { WRAPPED_SOL_MINT } from "../venueAccounts.js";
import {
  decodePoolVaults,
  decodePoolVirtualQuote,
  decodeTokenAmount,
  pumpSwapPoolOf,
} from "./pumpSwapPool.js";

const MINT = "7UyCxRnoUhVGWp3XPekkp5Tv5jVde7JXSuj6xLLFpump";
const BASE_VAULT = "4pijh5a9inzYdJ5uSKsR5YSpeoAgYcNspGfofpnhZYav";
const QUOTE_VAULT = "9D3ACVY16og7A2iKuqfUhtLZmNZk14Gwsi8EiPAa2MKf";

function poolData(baseMint: string, virtualQuote?: bigint): Uint8Array {
  const data = new Uint8Array(virtualQuote === undefined ? 211 : 301);
  if (virtualQuote !== undefined) new DataView(data.buffer).setBigInt64(245, virtualQuote, true);
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
    expect(decodePoolVaults(poolData(MINT), MINT)).toEqual({
      base: BASE_VAULT,
      quote: QUOTE_VAULT,
      virtualQuote: 0,
    });
    expect(decodePoolVaults(poolData(BASE_VAULT), MINT)).toBeNull();
    expect(decodePoolVaults(new Uint8Array(211), MINT)).toBeNull();
  });

  it("reads the pool's virtual quote reserve, which the price counts on top of the quote vault", () => {
    // 6AZCEf's PUMP pool on 2026-10-19: 2.77M PUMP in the vault, 0.49M virtual.
    expect(decodePoolVaults(poolData(MINT, 491_932_002_471n), MINT)?.virtualQuote).toBe(491_932_002_471);
    // Signed: a pool can carry a small negative one.
    expect(decodePoolVirtualQuote(poolData(MINT, -320_990n))).toBe(-320_990);
    expect(decodePoolVirtualQuote(new Uint8Array(301))).toBe(0);
  });

  it("reads a token account's balance", () => {
    const data = new Uint8Array(72);
    new DataView(data.buffer).setBigUint64(64, 176_508_687_166_049n, true);
    expect(decodeTokenAmount(Buffer.from(data).toString("base64"))).toBe(176_508_687_166_049);
    expect(decodeTokenAmount(new Uint8Array(10))).toBeNull();
  });
});
